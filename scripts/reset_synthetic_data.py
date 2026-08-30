"""
ReconAI — Synthetic Dataset Reset

load_synthetic_data.py is deliberately idempotent (ON CONFLICT DO NOTHING /
an idempotent RPC) so re-running it after nothing has changed is always
safe. That's the wrong tool the moment generate_synthetic_data.py's output
for an *existing* row's primary key actually changes content (e.g. tuning
the hard tier's anomaly sizing) — idempotent-append would silently leave
the old row in place instead of replacing it, and non-deterministic fields
like bank_reference mean a second run can even add a stale duplicate
alongside the new row rather than being recognized as "the same" row.

This script truncates exactly the tables generate_synthetic_data.py/
load_synthetic_data.py own (orders, cascading to payments, settlements,
bank_transactions, reconciliation_results, ground_truth_labels via FK) and
then re-runs the loader against a clean slate.

audit_logs is deliberately NOT touched — it has no foreign-key reference to
any of the truncated tables (entity_id is a plain text column, not a real
FK), and it's designed to be an immutable historical record; past runs'
entries are left as history, and the reload will simply append new ones.

Usage:
    python reset_synthetic_data.py
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import psycopg2
from dotenv import load_dotenv

ENV_PATH = Path(__file__).resolve().parent.parent / ".env"


def main() -> None:
    load_dotenv(ENV_PATH)
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise SystemExit("DATABASE_URL is not set. Copy .env.example to .env and fill it in.")

    conn = psycopg2.connect(database_url, connect_timeout=15)
    try:
        with conn:
            with conn.cursor() as cur:
                print("Truncating orders (cascades to payments, settlements, "
                      "bank_transactions, reconciliation_results, ground_truth_labels) ...")
                cur.execute("TRUNCATE public.orders CASCADE;")
        print("Truncated. audit_logs left untouched (no FK tie, immutable by design).")
    finally:
        conn.close()

    print("\nRe-running load_synthetic_data.py ...")
    result = subprocess.run([sys.executable, str(Path(__file__).with_name("load_synthetic_data.py"))])
    if result.returncode != 0:
        raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
