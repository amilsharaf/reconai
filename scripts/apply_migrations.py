"""
ReconAI — Migration Runner

Applies every .sql file in database/migrations/, in filename order, against
DATABASE_URL. Each migration runs in its own transaction; on failure the
script stops immediately and does not attempt the remaining files (migrations
are not written to be partially-applied).

This is a plain sequential runner, not a migration-state tracker (no
schema_migrations table) — the migrations themselves are written with
IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS so re-running the
whole set is safe and idempotent.

Usage:
    python apply_migrations.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import psycopg2
from dotenv import load_dotenv

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "database" / "migrations"
ENV_PATH = Path(__file__).resolve().parent.parent / ".env"


def main() -> None:
    load_dotenv(ENV_PATH)
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise SystemExit("DATABASE_URL is not set. Copy .env.example to .env and fill it in.")

    migration_files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    if not migration_files:
        raise SystemExit(f"No .sql files found in {MIGRATIONS_DIR}")

    conn = psycopg2.connect(database_url, connect_timeout=15)
    try:
        for path in migration_files:
            sql = path.read_text(encoding="utf-8")
            print(f"Applying {path.name} ...")
            try:
                with conn:
                    with conn.cursor() as cur:
                        cur.execute(sql)
            except Exception as exc:
                print(f"FAILED on {path.name}: {exc}", file=sys.stderr)
                raise SystemExit(1)
            print(f"  OK — {path.name}")
        print(f"\nAll {len(migration_files)} migrations applied successfully.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
