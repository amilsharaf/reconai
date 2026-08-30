"""
ReconAI — Synthetic Dataset Generator

Produces 1,000 "easy" orders (six injected reconciliation-exception
categories, all linked by clean foreign keys, all anomalies sized well
outside their tolerance bands) plus an 80-order "hard tier" designed
specifically to stress two things the easy tier can't test at all:

  - the fuzzy candidate-matching pass (bank credits that arrive without a
    matched_settlement_id, some uniquely resolvable by amount+date, some
    genuinely ambiguous between two near-identical candidates)
  - near-boundary numeric/date anomalies straddling the engine's own
    tolerance on both sides: 1.05x-1.5x (must be caught) and, deliberately,
    0.5x-0.95x (a genuine but sub-tolerance discrepancy a correct engine
    will NOT flag — an honest false negative, not a defect; see
    build_amount_mismatch_hard / build_timing_hard). The original dataset
    only ever tested 5x+ past tolerance, which any working threshold check
    gets right by a wide margin and proves nothing about the boundary.

Total: 1,080 orders, hidden ground_truth_labels split ~80/20 dev/test.

This script is intentionally a one-off, standalone tool (pandas, not the
app's TypeScript stack) per the frozen decision in PROJECT_SUMMARY.md §4 —
it never imports from or touches apps/web.

Design notes:
  - Money is generated as integer paise throughout, matching the database
    schema's convention (never floating point).
  - A fixed random seed makes the dataset reproducible across runs of this
    script version (same seed -> same output).
  - The reconciliation engine (Phase 2) must never read the `is_anomaly` /
    `true_issue_type` columns produced here — they exist only for the
    evaluation script (Phase 3) to score engine output against.
  - The six-category issue taxonomy from PROJECT_SUMMARY.md §0 is not
    extended by the hard tier. Hard cases that don't fit one of the six
    (an unresolved or ambiguous bank credit) are represented as
    is_anomaly=True/False with true_issue_type=NULL — both columns already
    permit NULL under the existing schema — with the specific reason
    recorded in ground_truth_labels.notes for transparency. No migration
    was needed or made for this.

Usage:
    python generate_synthetic_data.py
"""

from __future__ import annotations

import random
import string
from datetime import date, datetime, timedelta
from pathlib import Path

import pandas as pd

# ============================================================================
# Configuration — easy tier (unchanged from the original generator)
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

# ============================================================================
# Configuration — hard tier (new)
#
# Tolerances these are sized against (must match
# apps/web/src/lib/reconciliation/constants.ts exactly, or "near-boundary"
# stops meaning anything):
#   AMOUNT_TOLERANCE_PAISE = 100  (₹1)
#   TIMING_TOLERANCE_DAYS  = 3
#   FUZZY_CONFIDENCE_THRESHOLD = 0.75, FUZZY_MARGIN_THRESHOLD = 0.05
# ============================================================================

N_HARD_UNMATCHED_RESOLVABLE = 30  # orphan bank credit, but uniquely identifiable
N_HARD_UNMATCHED_AMBIGUOUS_PAIRS = 10  # -> 20 orders, two near-identical candidates each

# Split above/below the engine's own tolerance on purpose — see
# build_amount_mismatch_hard / build_timing_hard for why the "below" half
# is a deliberate, honest source of false negatives, not a bug.
N_HARD_AMOUNT_MISMATCH = 15
N_HARD_AMOUNT_MISMATCH_ABOVE = 8  # 1.05x-1.5x tolerance -> must be caught
N_HARD_AMOUNT_MISMATCH_BELOW = N_HARD_AMOUNT_MISMATCH - N_HARD_AMOUNT_MISMATCH_ABOVE  # 0.5x-0.95x -> correctly not caught

N_HARD_TIMING = 15
N_HARD_TIMING_ABOVE = 8  # 4-5 days late -> must be caught
N_HARD_TIMING_BELOW = N_HARD_TIMING - N_HARD_TIMING_ABOVE  # 1-2 days late -> correctly not caught

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


# ============================================================================
# Core generation (unchanged)
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
# Anomaly injectors — easy tier (unchanged). Each returns (settlements,
# bank_transactions) for the given order/payment, plus mutates payment in
# place where the anomaly is a payment-side property (e.g. REFUND).
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
    delta = rng.randint(500, 50_000) * rng.choice([-1, 1])  # ₹5 to ₹500 (5x-500x tolerance)
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
        date_offset_days=rng.randint(10, 20),  # far past TIMING_TOLERANCE_DAYS=3
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
# Anomaly injectors — hard tier (new)
# ============================================================================


def narration_without_reference() -> str:
    """A bank credit that arrived without anything tying it back to an
    order number — the reason it has no matched_settlement_id in the first
    place. Real narration on an unmatched credit is exactly this kind of
    unhelpful ("batch settlement", a truncated reference), not a clean
    order number that a simple string search would have already caught."""
    return f"NEFT CR-BATCH{random_alnum(6)}"


def build_unmatched_resolvable(index: int) -> tuple[dict, dict, dict, dict]:
    """A bank credit that lost its matched_settlement_id, but whose amount
    and date are otherwise completely normal — nothing else in the dataset
    is close enough in both amount and date to compete with it, so a
    correct fuzzy-matching pass should resolve it with high confidence."""
    order, payment, captured_at = build_order(index)
    settlement = build_settlement(index, payment, captured_at)
    bank_txn = build_bank_transaction(index, settlement, order["order_number"])
    bank_txn["matched_settlement_id"] = ""  # orphaned; "" -> NULL via to_null() in the loader
    bank_txn["narration"] = narration_without_reference()
    return order, payment, settlement, bank_txn


def build_ambiguous_pair(index_a: int, index_b: int):
    """Two orders whose settlements are, deliberately, hard to tell apart:
    net amounts within ~₹1 of each other and bank credits landing on the
    exact same date. Both bank credits are orphaned. A correct
    fuzzy-matching pass should score both of order A's candidates (its own
    credit and B's) similarly and decline to guess — same for B — landing
    both orders in REVIEW_NEEDED rather than a confident (and possibly
    wrong) auto-match."""
    order_a, payment_a, captured_at_a = build_order(index_a)
    order_b, payment_b, captured_at_b = build_order(index_b)

    nudge = rng.randint(-100, 100)  # up to ~₹1 — small enough to keep the fuzzy-match margin below threshold
    twin_amount = max(MIN_ORDER_AMOUNT_PAISE, order_a["amount_paise"] + nudge)
    order_b["amount_paise"] = twin_amount
    payment_b["amount_paise"] = twin_amount
    fee_b = round_paise(twin_amount * RAZORPAY_FEE_RATE)
    tax_b = round_paise(fee_b * GST_RATE_ON_FEE)
    payment_b["fee_paise"] = fee_b
    payment_b["tax_paise"] = tax_b

    settlement_a = build_settlement(index_a, payment_a, captured_at_a)
    settlement_b = build_settlement(index_b, payment_b, captured_at_a)  # forces the same settlement_date as A

    bank_a = build_bank_transaction(index_a, settlement_a, order_a["order_number"])
    bank_a["matched_settlement_id"] = ""
    bank_a["narration"] = narration_without_reference()
    bank_a["transaction_date"] = settlement_a["settlement_date"]  # force identical timing, not just close

    bank_b = build_bank_transaction(index_b, settlement_b, order_b["order_number"])
    bank_b["matched_settlement_id"] = ""
    bank_b["narration"] = narration_without_reference()
    bank_b["transaction_date"] = settlement_a["settlement_date"]

    return (order_a, payment_a, settlement_a, bank_a), (order_b, payment_b, settlement_b, bank_b)


def build_amount_mismatch_hard(index: int, above_tolerance: bool) -> tuple[dict, dict, dict, dict]:
    """Same shape as scenario_amount_mismatch, sized right against the
    engine's own AMOUNT_TOLERANCE_PAISE=100 (₹1) instead of 5x-500x past it:

    - above_tolerance=True:  delta 105-150 paise (1.05x-1.5x) — a real
      discrepancy just past the line; a correctly-implemented tolerance
      check must catch it.
    - above_tolerance=False: delta 50-95 paise (0.5x-0.95x) — smaller than
      the tolerance on purpose. There IS a genuine discrepancy (so ground
      truth still marks this an anomaly), but it's exactly the kind of
      sub-materiality noise a fixed tolerance is *designed* to absorb —
      a correct engine will (correctly) not flag it, which shows up as a
      false negative in evaluate.py. That's the tolerance doing its job,
      not an engine defect; see STATUS_REPORT.md for the full argument.
    """
    order, payment, captured_at = build_order(index)
    settlement = build_settlement(index, payment, captured_at)
    delta_paise = rng.randint(105, 150) if above_tolerance else rng.randint(50, 95)
    delta = delta_paise * rng.choice([-1, 1])
    bank_txn = build_bank_transaction(
        index, settlement, order["order_number"],
        amount_override_paise=max(1, settlement["net_amount_paise"] + delta),
    )
    return order, payment, settlement, bank_txn


def build_timing_hard(index: int, above_tolerance: bool) -> tuple[dict, dict, dict, dict]:
    """Same shape as scenario_timing, sized right against the engine's own
    TIMING_TOLERANCE_DAYS=3 instead of 10-21 days past it:

    - above_tolerance=True:  date_offset_days=4 -> 4-5 days late, just past
      the line; a correctly-implemented tolerance check must catch it.
    - above_tolerance=False: date_offset_days=1 -> 1-2 days late, which
      overlaps the normal 0-1 day settlement lag almost entirely. Ground
      truth still marks it an anomaly (a real, if immaterial, delay
      happened), but it's statistically indistinguishable from ordinary
      jitter — a correct engine won't (and, generously, arguably
      shouldn't) flag it. False negative by design, not a defect.
    """
    order, payment, captured_at = build_order(index)
    settlement = build_settlement(index, payment, captured_at)
    bank_txn = build_bank_transaction(
        index, settlement, order["order_number"],
        date_offset_days=4 if above_tolerance else 1,
    )
    return order, payment, settlement, bank_txn


def generate_hard_tier(start_index: int, splits: list[str]):
    """Builds all 80 hard-tier orders. `splits` must already be assigned
    (see assign_splits), one entry per hard-tier order in generation order:
    30 unmatched-resolvable, then 20 unmatched-ambiguous (10 pairs), then
    15 amount-mismatch-hard, then 15 timing-hard."""
    orders, payments, settlements, bank_transactions, ground_truth = [], [], [], [], []
    index = start_index
    split_i = 0

    def next_split() -> str:
        nonlocal split_i
        s = splits[split_i]
        split_i += 1
        return s

    for _ in range(N_HARD_UNMATCHED_RESOLVABLE):
        order, payment, settlement, bank_txn = build_unmatched_resolvable(index)
        orders.append(order)
        payments.append(payment)
        settlements.append(settlement)
        bank_transactions.append(bank_txn)
        ground_truth.append({
            "order_id": order["id"], "is_anomaly": False, "true_issue_type": None,
            "split": next_split(), "notes": "hard_tier: unmatched_bank_credit_resolvable",
        })
        index += 1

    for _ in range(N_HARD_UNMATCHED_AMBIGUOUS_PAIRS):
        pair_a, pair_b = build_ambiguous_pair(index, index + 1)
        for order, payment, settlement, bank_txn in (pair_a, pair_b):
            orders.append(order)
            payments.append(payment)
            settlements.append(settlement)
            bank_transactions.append(bank_txn)
            ground_truth.append({
                "order_id": order["id"], "is_anomaly": True, "true_issue_type": None,
                "split": next_split(), "notes": "hard_tier: unmatched_bank_credit_ambiguous_pair",
            })
        index += 2

    for i in range(N_HARD_AMOUNT_MISMATCH):
        above = i < N_HARD_AMOUNT_MISMATCH_ABOVE
        order, payment, settlement, bank_txn = build_amount_mismatch_hard(index, above_tolerance=above)
        orders.append(order)
        payments.append(payment)
        settlements.append(settlement)
        bank_transactions.append(bank_txn)
        ground_truth.append({
            "order_id": order["id"], "is_anomaly": True, "true_issue_type": "AMOUNT_MISMATCH",
            "split": next_split(),
            "notes": "hard_tier: amount_mismatch_above_tolerance" if above
                     else "hard_tier: amount_mismatch_below_tolerance_immaterial",
        })
        index += 1

    for i in range(N_HARD_TIMING):
        above = i < N_HARD_TIMING_ABOVE
        order, payment, settlement, bank_txn = build_timing_hard(index, above_tolerance=above)
        orders.append(order)
        payments.append(payment)
        settlements.append(settlement)
        bank_transactions.append(bank_txn)
        ground_truth.append({
            "order_id": order["id"], "is_anomaly": True, "true_issue_type": "TIMING",
            "split": next_split(),
            "notes": "hard_tier: timing_above_tolerance" if above
                     else "hard_tier: timing_below_tolerance_immaterial",
        })
        index += 1

    return orders, payments, settlements, bank_transactions, ground_truth


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
    group is represented in both splits. Any rounding remainder is absorbed
    by the largest group (the original generator hardcoded this to
    "NORMAL", which was always the largest group; generalizing it here lets
    the same function serve the much smaller, differently-shaped hard-tier
    label set too, with identical behavior for the original 1,000)."""
    group_indices: dict[str, list[int]] = {}
    for i, label in enumerate(labels):
        key = label or "NORMAL"
        group_indices.setdefault(key, []).append(i)

    n = len(labels)
    splits: list[str | None] = [None] * n
    test_counts = {key: round(len(indices) * TEST_FRACTION) for key, indices in group_indices.items()}

    remainder = round(n * TEST_FRACTION) - sum(test_counts.values())
    largest_key = max(group_indices, key=lambda k: len(group_indices[k]))
    test_counts[largest_key] += remainder

    for key, indices in group_indices.items():
        shuffled = indices[:]
        rng.shuffle(shuffled)
        test_n = test_counts[key]
        test_set = set(shuffled[:test_n])
        for i in indices:
            splits[i] = "test" if i in test_set else "dev"

    assert splits.count("test") == round(n * TEST_FRACTION)
    return splits  # type: ignore[return-value]


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
            "notes": None,
        })

    # Hard tier: generated after (and stratified independently from) the
    # easy tier, starting at index N_ORDERS so IDs never collide with it.
    hard_labels = (
        ["UNMATCHED_RESOLVABLE"] * N_HARD_UNMATCHED_RESOLVABLE
        + ["UNMATCHED_AMBIGUOUS"] * (N_HARD_UNMATCHED_AMBIGUOUS_PAIRS * 2)
        + ["AMOUNT_MISMATCH_HARD"] * N_HARD_AMOUNT_MISMATCH
        + ["TIMING_HARD"] * N_HARD_TIMING
    )
    hard_splits = assign_splits(hard_labels)
    (hard_orders, hard_payments, hard_settlements,
     hard_bank_transactions, hard_ground_truth) = generate_hard_tier(N_ORDERS, hard_splits)

    orders.extend(hard_orders)
    payments.extend(hard_payments)
    settlements.extend(hard_settlements)
    bank_transactions.extend(hard_bank_transactions)
    ground_truth.extend(hard_ground_truth)

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
    print("Ground truth distribution (true_issue_type, NORMAL = no issue):")
    print(gt["true_issue_type"].fillna("NORMAL").value_counts().to_string())
    print()
    print("Hard-tier distribution (by notes, easy-tier rows have no notes):")
    print(gt["notes"].fillna("(easy tier)").value_counts().to_string())
    print()
    print("Split x issue type (should show every easy-tier category in both splits):")
    print(pd.crosstab(gt["true_issue_type"].fillna("NORMAL"), gt["split"]).to_string())
    print()
    print("Orphaned bank transactions (matched_settlement_id is empty — hard tier only):")
    orphan_count = (tables["bank_transactions"]["matched_settlement_id"].fillna("") == "").sum()
    print(f"  {orphan_count} of {len(tables['bank_transactions'])}")


if __name__ == "__main__":
    main()
