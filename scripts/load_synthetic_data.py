"""
ReconAI — Synthetic Dataset Loader

Loads the CSVs produced by generate_synthetic_data.py into Supabase Postgres.

Connects directly via DATABASE_URL (a trusted, service-level connection),
the same way WinsFresh's own scripts/migrate.js does — this bypasses RLS
entirely, which is correct here: this script IS the trusted backend context
that RLS is designed to let through (see database/migrations/00003_rls_policies.sql).

Load order matters (foreign keys): orders -> payments -> settlements ->
bank_transactions -> ground_truth_labels.

- orders, payments, settlements, ground_truth_labels are bulk-inserted
  directly, since they represent upstream systems of record with no replay
  risk in this loader's context (each row's primary key is generated fresh
  by the generator's own UUID scheme, not by anything a user could resubmit).
- bank_transactions are loaded one at a time through
  ingest_bank_transaction_atomic(), the same idempotent RPC production code
  will call — running this script twice must not create duplicate bank
  transactions, and only the RPC path guarantees that.

This script deliberately does NOT call compute_reconciliation_atomic() —
computing reconciliation_results is the Phase 2 engine's job, not the data
loader's.

Usage:
    python load_synthetic_data.py
"""

from __future__ import annotations

import csv
import os
from pathlib import Path

import psycopg2
from psycopg2.extras import execute_values
from dotenv import load_dotenv

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "synthetic"
ENV_PATH = Path(__file__).resolve().parent.parent / ".env"


def read_csv(name: str) -> list[dict]:
    path = DATA_DIR / f"{name}.csv"
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def to_null(value):
    return None if value == "" else value


def bulk_insert(cur, table: str, rows: list[dict], columns: list[str]) -> None:
    if not rows:
        return
    values = [tuple(to_null(row[col]) for col in columns) for row in rows]
    query = f"INSERT INTO public.{table} ({', '.join(columns)}) VALUES %s ON CONFLICT DO NOTHING"
    execute_values(cur, query, values)


def load_orders(cur) -> int:
    rows = read_csv("orders")
    columns = ["id", "order_number", "customer_ref", "amount_paise", "currency", "status", "created_at"]
    bulk_insert(cur, "orders", rows, columns)
    return len(rows)


def load_payments(cur) -> int:
    rows = read_csv("payments")
    columns = ["id", "order_id", "payment_ref", "amount_paise", "fee_paise", "tax_paise",
               "refund_amount_paise", "method", "status", "captured_at"]
    bulk_insert(cur, "payments", rows, columns)
    return len(rows)


def load_settlements(cur) -> int:
    rows = read_csv("settlements")
    columns = ["id", "payment_id", "settlement_ref", "gross_amount_paise", "fee_paise",
               "tax_paise", "refund_paise", "net_amount_paise", "settlement_date"]
    bulk_insert(cur, "settlements", rows, columns)
    return len(rows)


def load_bank_transactions(cur) -> int:
    rows = read_csv("bank_transactions")
    for row in rows:
        cur.execute(
            "SELECT public.ingest_bank_transaction_atomic(%s, %s, %s, %s, %s, %s, %s)",
            (
                row["bank_reference"],
                row["utr"],
                int(row["amount_paise"]),
                row["transaction_date"],
                to_null(row["narration"]),
                to_null(row["matched_settlement_id"]),
                None,  # p_actor_id — auth.uid() is NULL over a direct DB connection,
                       # so this stays NULL; audit_logs.actor_id records the load as system-initiated.
            ),
        )
    return len(rows)


def load_ground_truth_labels(cur) -> int:
    rows = read_csv("ground_truth_labels")
    columns = ["order_id", "is_anomaly", "true_issue_type", "split", "notes"]
    bulk_insert(cur, "ground_truth_labels", rows, columns)
    return len(rows)


def main() -> None:
    load_dotenv(ENV_PATH)
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise SystemExit(
            "DATABASE_URL is not set. Copy .env.example to .env and fill in your "
            "Supabase connection string before running this script."
        )

    for name in ("orders", "payments", "settlements", "bank_transactions", "ground_truth_labels"):
        if not (DATA_DIR / f"{name}.csv").exists():
            raise SystemExit(
                f"{name}.csv not found in {DATA_DIR}. Run generate_synthetic_data.py first."
            )

    conn = psycopg2.connect(database_url)
    try:
        with conn:
            with conn.cursor() as cur:
                n_orders = load_orders(cur)
                n_payments = load_payments(cur)
                n_settlements = load_settlements(cur)
                n_bank_txns = load_bank_transactions(cur)
                n_labels = load_ground_truth_labels(cur)

        print("Loaded synthetic dataset into Supabase:")
        print(f"  orders:              {n_orders}")
        print(f"  payments:            {n_payments}")
        print(f"  settlements:         {n_settlements}")
        print(f"  bank_transactions:   {n_bank_txns} (via ingest_bank_transaction_atomic)")
        print(f"  ground_truth_labels: {n_labels}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
