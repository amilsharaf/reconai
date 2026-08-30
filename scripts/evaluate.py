"""
ReconAI — Evaluation Script

Scores the reconciliation engine's output (public.reconciliation_results,
written by apps/web/scripts/run-reconciliation.ts) against hidden
ground_truth_labels. This script is the ONLY thing allowed to read
ground_truth_labels — the engine itself must never query it (see
PROJECT_SUMMARY.md §3, database/migrations/00003_rls_policies.sql).

Reports, for dev and test splits separately:
  - Binary anomaly detection: precision / recall / F1, TP/FP/FN/TN counts.
  - Per-issue-type classification: precision / recall / F1 for each of the
    six exception categories, treating NORMAL as a seventh class, plus an
    eighth UNRESOLVED_UNLINKED class for the hard tier's unmatched-bank-
    credit cases, which don't fit any of the six fixed categories (i.e. a
    full multiclass confusion breakdown, not just "did it flag *something*").
    See the UNRESOLVED_UNLINKED note below load_data() for why this eighth
    bucket exists and how it's derived without touching the DB schema.
  - Rupee-value impact: value reconciled vs. value at risk, split into
    correctly-caught risk (TP) vs. incorrectly-flagged value (FP) vs.
    missed risk (FN).

Connects via DATABASE_URL directly (service-level, bypasses RLS) — the same
trust boundary scripts/load_synthetic_data.py already uses. This is
correct here: this script IS the evaluation context ground_truth_labels'
RLS lockdown is designed to allow through.

Usage:
    python evaluate.py
"""

from __future__ import annotations

import os
import sys
import warnings
from pathlib import Path

import pandas as pd
import psycopg2
from dotenv import load_dotenv

# Windows terminals default to cp1252, which can't encode ₹ — force UTF-8 output.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# psycopg2 connections work fine with pd.read_sql; pandas only warns because
# it's not a SQLAlchemy engine. Not a real problem, just noise.
warnings.filterwarnings("ignore", message="pandas only supports SQLAlchemy")

ENV_PATH = Path(__file__).resolve().parent.parent / ".env"
ISSUE_TYPES = [
    "FEE_MISMATCH",
    "MISSING_SETTLEMENT",
    "AMOUNT_MISMATCH",
    "DUPLICATE",
    "REFUND",
    "TIMING",
]
# A ground_truth_labels row can have true_issue_type=NULL for two different
# reasons: the order is genuinely normal (is_anomaly=False), or it's one of
# the hard tier's unmatched-bank-credit cases that the fixed six-category
# taxonomy was never meant to cover (is_anomaly=True) — see
# generate_synthetic_data.py's build_ambiguous_pair / build_unmatched_resolvable.
# Naively filling NULL -> "NORMAL" would silently misclassify the second
# group as the first. UNRESOLVED_UNLINKED is a reporting-only label (never
# written to the database — true_issue_type's CHECK constraint doesn't
# allow it) that keeps the two apart.
UNRESOLVED_CLASS = "UNRESOLVED_UNLINKED"
ALL_CLASSES = ["NORMAL"] + ISSUE_TYPES + [UNRESOLVED_CLASS]


def load_data(conn) -> pd.DataFrame:
    results = pd.read_sql(
        """
        SELECT order_id, status, issue_type, expected_amount_paise,
               actual_amount_paise, difference_paise, confidence_score,
               recommendation
        FROM public.reconciliation_results
        """,
        conn,
    )
    labels = pd.read_sql(
        """
        SELECT order_id, is_anomaly, true_issue_type, split
        FROM public.ground_truth_labels
        """,
        conn,
    )
    orders = pd.read_sql("SELECT id AS order_id, amount_paise FROM public.orders", conn)

    df = labels.merge(results, on="order_id", how="left").merge(orders, on="order_id", how="left")
    if df["status"].isna().any():
        missing = int(df["status"].isna().sum())
        raise SystemExit(
            f"{missing} order(s) in ground_truth_labels have no reconciliation_results row — "
            "run `npm run reconcile` (apps/web) before evaluating."
        )

    def true_class(row) -> str:
        if not row["is_anomaly"]:
            return "NORMAL"
        # bool(nan) is True in Python — `if row[...]` would silently treat a
        # NULL true_issue_type as truthy and return the NaN itself instead
        # of falling through, so this must be an explicit null check.
        return UNRESOLVED_CLASS if pd.isna(row["true_issue_type"]) else row["true_issue_type"]

    def predicted_class(row) -> str:
        if row["status"] == "RECONCILED":
            return "NORMAL"
        return UNRESOLVED_CLASS if pd.isna(row["issue_type"]) else row["issue_type"]

    df["true_class"] = df.apply(true_class, axis=1)
    df["predicted_class"] = df.apply(predicted_class, axis=1)
    df["predicted_anomaly"] = df["status"] != "RECONCILED"
    return df


def binary_metrics(df: pd.DataFrame) -> dict:
    tp = int(((df["predicted_anomaly"]) & (df["is_anomaly"])).sum())
    fp = int(((df["predicted_anomaly"]) & (~df["is_anomaly"])).sum())
    fn = int(((~df["predicted_anomaly"]) & (df["is_anomaly"])).sum())
    tn = int(((~df["predicted_anomaly"]) & (~df["is_anomaly"])).sum())
    precision = tp / (tp + fp) if (tp + fp) else float("nan")
    recall = tp / (tp + fn) if (tp + fn) else float("nan")
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) and precision == precision and recall == recall and (precision + recall) > 0 else float("nan")
    return {"tp": tp, "fp": fp, "fn": fn, "tn": tn, "precision": precision, "recall": recall, "f1": f1}


def per_class_metrics(df: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for cls in ALL_CLASSES:
        tp = int(((df["predicted_class"] == cls) & (df["true_class"] == cls)).sum())
        fp = int(((df["predicted_class"] == cls) & (df["true_class"] != cls)).sum())
        fn = int(((df["predicted_class"] != cls) & (df["true_class"] == cls)).sum())
        support = int((df["true_class"] == cls).sum())
        precision = tp / (tp + fp) if (tp + fp) else float("nan")
        recall = tp / (tp + fn) if (tp + fn) else float("nan")
        f1 = (
            2 * precision * recall / (precision + recall)
            if precision == precision and recall == recall and (precision + recall) > 0
            else float("nan")
        )
        rows.append(
            {"class": cls, "support": support, "tp": tp, "fp": fp, "fn": fn,
             "precision": precision, "recall": recall, "f1": f1}
        )
    return pd.DataFrame(rows)


def rupee_impact(df: pd.DataFrame) -> dict:
    total_value = int(df["amount_paise"].sum())
    reconciled_value = int(df.loc[~df["predicted_anomaly"], "amount_paise"].sum())
    at_risk_value = int(df.loc[df["predicted_anomaly"], "amount_paise"].sum())

    tp_value = int(df.loc[(df["predicted_anomaly"]) & (df["is_anomaly"]), "amount_paise"].sum())
    fp_value = int(df.loc[(df["predicted_anomaly"]) & (~df["is_anomaly"]), "amount_paise"].sum())
    fn_value = int(df.loc[(~df["predicted_anomaly"]) & (df["is_anomaly"]), "amount_paise"].sum())

    return {
        "total_order_value_paise": total_value,
        "reconciled_value_paise": reconciled_value,
        "at_risk_value_paise": at_risk_value,
        "correctly_caught_risk_paise": tp_value,
        "incorrectly_flagged_value_paise": fp_value,
        "missed_risk_value_paise": fn_value,
    }


def fmt_rupees(paise: int) -> str:
    return f"₹{paise / 100:,.2f}"


def print_report(split: str, df: pd.DataFrame) -> None:
    print(f"\n{'=' * 70}\nSPLIT: {split}  (n={len(df)})\n{'=' * 70}")

    b = binary_metrics(df)
    print("\n-- Binary anomaly detection (any exception vs. RECONCILED) --")
    print(f"  TP={b['tp']}  FP={b['fp']}  FN={b['fn']}  TN={b['tn']}")
    print(f"  Precision: {b['precision']:.4f}")
    print(f"  Recall:    {b['recall']:.4f}")
    print(f"  F1:        {b['f1']:.4f}")

    print("\n-- Per-class classification (8-way: NORMAL + six issue types + UNRESOLVED_UNLINKED) --")
    per_class = per_class_metrics(df)
    with pd.option_context("display.float_format", "{:.4f}".format):
        print(per_class.to_string(index=False))

    r = rupee_impact(df)
    print("\n-- ₹-value impact --")
    print(f"  Total order value:          {fmt_rupees(r['total_order_value_paise'])}")
    print(f"  Reconciled (clean):         {fmt_rupees(r['reconciled_value_paise'])}")
    print(f"  Flagged at risk:            {fmt_rupees(r['at_risk_value_paise'])}")
    print(f"    of which correctly caught (TP): {fmt_rupees(r['correctly_caught_risk_paise'])}")
    print(f"    of which false alarms (FP):     {fmt_rupees(r['incorrectly_flagged_value_paise'])}")
    print(f"  Missed risk (FN, not flagged but actually anomalous): {fmt_rupees(r['missed_risk_value_paise'])}")


def main() -> None:
    load_dotenv(ENV_PATH)
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise SystemExit("DATABASE_URL is not set. Copy .env.example to .env and fill it in.")

    conn = psycopg2.connect(database_url)
    try:
        df = load_data(conn)
    finally:
        conn.close()

    dev = df[df["split"] == "dev"]
    test = df[df["split"] == "test"]

    print_report("dev", dev)
    # Held-out test — reported as-is, run once, not used to tune anything above.
    print_report("test — HELD-OUT, reported as-is", test)
    print_report("overall (dev + test)", df)


if __name__ == "__main__":
    main()
