"""
ReconAI — Synthetic Dataset Generator

Produces 1,000 orders (and their payments, settlements, and bank
transactions) with six injected reconciliation-exception categories, plus a
hidden ground_truth_labels table split 800 dev / 200 held-out test.

This script is intentionally a one-off, standalone tool (pandas, not the
app's TypeScript stack) per the frozen decision in PROJECT_SUMMARY.md §4 —
it never imports from or touches apps/web.

Design notes:
  - Money is generated as integer paise throughout, matching the database
    schema's convention (never floating point).
  - A fixed random seed makes the dataset byte-identical across runs, so
    re-generating it never invalidates a previously-reported metric.
  - The reconciliation engine (Phase 2) must never read the `is_anomaly` /
    `true_issue_type` columns produced here — they exist only for the
    evaluation script (Phase 3) to score engine output against.

Usage:
    python generate_synthetic_data.py
"""

from __future__ import annotations

import random
import string
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path

import pandas as pd

# ============================================================================
# Configuration
# ============================================================================

SEED = 42
N_ORDERS = 1000
TEST_FRACTION = 0.20

REFERENCE_DATE = date(2026, 8, 29)  # "today" for the generated dataset
ORDER_LOOKBACK_DAYS = 90

RAZORPAY_FEE_RATE = 0.02  # 2%
GST_RATE_ON_FEE = 0.18  # 18% GST on the platform fee
STANDARD_SETTLEMENT_LAG_DAYS = 2  # T+2

MIN_ORDER_AMOUNT_PAISE = 19_900  # ₹199
MAX_ORDER_AMOUNT_PAISE = 1_500_000  # ₹15,000

OUTPUT_DIR = Path(__file__).resolve().parent.parent / "data" / "synthetic"

ISSUE_TYPES = [
    "FEE_MISMATCH",
    "MISSING_SETTLEMENT",
    "AMOUNT_MISMATCH",
    "DUPLICATE",
    "REFUND",
    "TIMING",
]

# 42/42/42/42/41/41 = 250 anomalous orders out of 1,000 (25%)
ISSUE_TYPE_COUNTS = {
    "FEE_MISMATCH": 42,
    "MISSING_SETTLEMENT": 42,
    "AMOUNT_MISMATCH": 42,
    "DUPLICATE": 42,
    "REFUND": 41,
    "TIMING": 41,
}
N_NORMAL = N_ORDERS - sum(ISSUE_TYPE_COUNTS.values())  # 750

rng = random.Random(SEED)


# ============================================================================
# Helpers
# ============================================================================


def random_alnum(n: int) -> str:
    return "".join(rng.choices(string.ascii_uppercase + string.digits, k=n))


def random_utr() -> str:
    return "".join(rng.choices(string.digits, k=12))


def round_paise(value: float) -> int:
    return int(round(value))


def random_datetime_in_lookback() -> datetime:
    days_ago = rng.randint(0, ORDER_LOOKBACK_DAYS)
    seconds_in_day = rng.randint(0, 86_399)
    return datetime.combine(REFERENCE_DATE, datetime.min.time()) - timedelta(
        days=days_ago
    ) + timedelta(seconds=seconds_in_day)


@dataclass
class GeneratedOrder:
    order: dict
    payment: dict
    settlements: list[dict] = field(default_factory=list)
    bank_transactions: list[dict] = field(default_factory=list)
    ground_truth: dict = None


# ============================================================================
# Core generation
# ============================================================================


def build_order(index: int) -> tuple[dict, dict, datetime]:
    order_id = f"00000000-0000-4000-8000-{index:012d}"
    payment_id = f"10000000-0000-4000-8000-{index:012d}"

    created_at = random_datetime_in_lookback()
    amount_paise = rng.randrange(MIN_ORDER_AMOUNT_PAISE, MAX_ORDER_AMOUNT_PAISE, 100)

    fee_paise = round_paise(amount_paise * RAZORPAY_FEE_RATE)
    tax_paise = round_paise(fee_paise * GST_RATE_ON_FEE)

    order = {
        "id": order_id,
        "order_number": f"ORD-2026-{index:06d}",
        "customer_ref": f"CUST-{rng.randint(1, 400):05d}",
        "amount_paise": amount_paise,
        "currency": "INR",
        "status": "PAID",
        "created_at": created_at.isoformat(),
    }

    payment = {
        "id": payment_id,
        "order_id": order_id,
        "payment_ref": f"pay_{random_alnum(14)}",
        "amount_paise": amount_paise,
        "fee_paise": fee_paise,
        "tax_paise": tax_paise,
        "refund_amount_paise": 0,
        "method": rng.choice(["UPI", "CARD", "NETBANKING", "WALLET"]),
        "status": "CAPTURED",
        "captured_at": (created_at + timedelta(seconds=rng.randint(1, 30))).isoformat(),
    }

    return order, payment, created_at


def build_settlement(index: int, payment: dict, captured_at: datetime,
                      fee_override_paise: int | None = None,
                      gross_override_paise: int | None = None) -> dict:
    settlement_id = f"20000000-0000-4000-8000-{index:012d}"
    gross = gross_override_paise if gross_override_paise is not None else payment["amount_paise"]
    fee = fee_override_paise if fee_override_paise is not None else payment["fee_paise"]
    tax = round_paise(fee * GST_RATE_ON_FEE)
    net = gross - fee - tax

    settlement_date = (captured_at.date() + timedelta(days=STANDARD_SETTLEMENT_LAG_DAYS))

    return {
        "id": settlement_id,
        "payment_id": payment["id"],
        "settlement_ref": f"setl_{random_alnum(14)}",
        "gross_amount_paise": gross,
        "fee_paise": fee,
        "tax_paise": tax,
        "refund_paise": 0,
        "net_amount_paise": net,
        "settlement_date": settlement_date.isoformat(),
    }


def build_bank_transaction(index: int, settlement: dict, order_number: str,
                            amount_override_paise: int | None = None,
                            date_offset_days: int = 0,
                            suffix: str = "") -> dict:
    bank_txn_id = f"30000000-0000-4000-8000-{index:012d}{suffix}"
    amount = amount_override_paise if amount_override_paise is not None else settlement["net_amount_paise"]
    txn_date = date.fromisoformat(settlement["settlement_date"]) + timedelta(
        days=date_offset_days + rng.randint(0, 1)
    )

    return {
        "id": bank_txn_id,
        "bank_reference": f"BANKREF-{random_alnum(10)}{suffix}",
        "utr": random_utr(),
        "amount_paise": amount,
        "transaction_date": txn_date.isoformat(),
        "narration": f"NEFT CR-{order_number}",
        "matched_settlement_id": settlement["id"],
    }


# ============================================================================
# Anomaly injectors — each returns (settlements, bank_transactions) for the
# given order/payment, plus mutates payment in place where the anomaly is a
# payment-side property (e.g. REFUND).
# ============================================================================


def scenario_normal(index, order, payment, captured_at):
    settlement = build_settlement(index, payment, captured_at)
    bank_txn = build_bank_transaction(index, settlement, order["order_number"])
    return [settlement], [bank_txn]


def scenario_fee_mismatch(index, order, payment, captured_at):
    # Settlement applies a materially different fee rate than the payment
    # record states, so the bank-confirmed net will not match what the
    # payment's own fee/tax imply the net should be.
    wrong_rate = rng.choice([0.025, 0.03, 0.035])
    wrong_fee = round_paise(payment["amount_paise"] * wrong_rate)
    settlement = build_settlement(index, payment, captured_at, fee_override_paise=wrong_fee)
    bank_txn = build_bank_transaction(index, settlement, order["order_number"])
    return [settlement], [bank_txn]


def scenario_missing_settlement(index, order, payment, captured_at):
    # Payment captured, but the settlement never arrived (yet) — no
    # settlement row, no bank transaction row.
    return [], []


def scenario_amount_mismatch(index, order, payment, captured_at):
    settlement = build_settlement(index, payment, captured_at)
    delta = rng.randint(500, 50_000) * rng.choice([-1, 1])  # ₹5 to ₹500
    bank_txn = build_bank_transaction(
        index, settlement, order["order_number"],
        amount_override_paise=max(1, settlement["net_amount_paise"] + delta),
    )
    return [settlement], [bank_txn]


def scenario_duplicate(index, order, payment, captured_at):
    settlement = build_settlement(index, payment, captured_at)
    original = build_bank_transaction(index, settlement, order["order_number"])
    duplicate = build_bank_transaction(
        index, settlement, order["order_number"],
        date_offset_days=1, suffix="D",
    )
    return [settlement], [original, duplicate]


def scenario_refund(index, order, payment, captured_at):
    # Refund happens after the settlement was already computed, so the
    # settlement (and the bank credit that mirrors it) doesn't reflect it.
    refund_amount = round_paise(payment["amount_paise"] * rng.choice([0.5, 1.0]))
    payment["refund_amount_paise"] = refund_amount
    payment["status"] = "REFUNDED" if refund_amount == payment["amount_paise"] else "CAPTURED"

    settlement = build_settlement(index, payment, captured_at)  # unaware of the refund
    bank_txn = build_bank_transaction(index, settlement, order["order_number"])
    return [settlement], [bank_txn]


def scenario_timing(index, order, payment, captured_at):
    settlement = build_settlement(index, payment, captured_at)
    bank_txn = build_bank_transaction(
        index, settlement, order["order_number"],
        date_offset_days=rng.randint(10, 20),
    )
    return [settlement], [bank_txn]


SCENARIO_BUILDERS = {
    "FEE_MISMATCH": scenario_fee_mismatch,
    "MISSING_SETTLEMENT": scenario_missing_settlement,
    "AMOUNT_MISMATCH": scenario_amount_mismatch,
    "DUPLICATE": scenario_duplicate,
    "REFUND": scenario_refund,
    "TIMING": scenario_timing,
}


# ============================================================================
# Assemble the full dataset
# ============================================================================


def assign_labels() -> list[str | None]:
    """Returns a shuffled list of length N_ORDERS: None for normal orders,
    or an issue type string for anomalous ones."""
    labels: list[str | None] = [None] * N_NORMAL
    for issue_type, count in ISSUE_TYPE_COUNTS.items():
        labels.extend([issue_type] * count)
    rng.shuffle(labels)
    assert len(labels) == N_ORDERS
    return labels


def assign_splits(labels: list[str | None]) -> list[str]:
    """Stratified 80/20 dev/test split, computed per label group so every
    exception type (and the normal group) is represented in both splits,
    and the totals land on exactly 800/200."""
    group_indices: dict[str, list[int]] = {}
    for i, label in enumerate(labels):
        key = label or "NORMAL"
        group_indices.setdefault(key, []).append(i)

    splits = [None] * N_ORDERS
    test_counts = {}
    for key, indices in group_indices.items():
        test_counts[key] = round(len(indices) * TEST_FRACTION)

    remainder = round(N_ORDERS * TEST_FRACTION) - sum(test_counts.values())
    test_counts["NORMAL"] += remainder  # absorb rounding drift in the largest group

    for key, indices in group_indices.items():
        shuffled = indices[:]
        rng.shuffle(shuffled)
        test_n = test_counts[key]
        test_set = set(shuffled[:test_n])
        for i in indices:
            splits[i] = "test" if i in test_set else "dev"

    assert splits.count("test") == round(N_ORDERS * TEST_FRACTION)
    return splits


def generate() -> dict[str, pd.DataFrame]:
    labels = assign_labels()
    splits = assign_splits(labels)

    orders, payments, settlements, bank_transactions, ground_truth = [], [], [], [], []

    for i in range(N_ORDERS):
        order, payment, captured_at = build_order(i)
        issue_type = labels[i]

        builder = SCENARIO_BUILDERS.get(issue_type, scenario_normal)
        order_settlements, order_bank_txns = builder(i, order, payment, captured_at)

        orders.append(order)
        payments.append(payment)
        settlements.extend(order_settlements)
        bank_transactions.extend(order_bank_txns)
        ground_truth.append({
            "order_id": order["id"],
            "is_anomaly": issue_type is not None,
            "true_issue_type": issue_type,
            "split": splits[i],
        })

    return {
        "orders": pd.DataFrame(orders),
        "payments": pd.DataFrame(payments),
        "settlements": pd.DataFrame(settlements),
        "bank_transactions": pd.DataFrame(bank_transactions),
        "ground_truth_labels": pd.DataFrame(ground_truth),
    }


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    tables = generate()

    for name, df in tables.items():
        out_path = OUTPUT_DIR / f"{name}.csv"
        df.to_csv(out_path, index=False)

    gt = tables["ground_truth_labels"]
    print(f"Generated {len(tables['orders'])} orders -> {OUTPUT_DIR}")
    print(f"  payments:           {len(tables['payments'])}")
    print(f"  settlements:        {len(tables['settlements'])}")
    print(f"  bank_transactions:  {len(tables['bank_transactions'])}")
    print()
    print("Split sizes:")
    print(gt["split"].value_counts().to_string())
    print()
    print("Ground truth distribution:")
    print(gt["true_issue_type"].fillna("NORMAL").value_counts().to_string())
    print()
    print("Split x issue type (should show every category in both splits):")
    print(pd.crosstab(gt["true_issue_type"].fillna("NORMAL"), gt["split"]).to_string())


if __name__ == "__main__":
    main()
