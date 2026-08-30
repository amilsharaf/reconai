/**
 * ReconAI — Deterministic Reconciliation Engine
 *
 * Decides, for one order, whether its money trail (order -> payment ->
 * settlement -> bank credit) is clean. This module is pure and
 * side-effect-free: no database calls, no I/O, no randomness — the same
 * input always produces the same verdict.
 *
 * CRITICAL INVARIANT: this file must never import or reference
 * ground_truth_labels in any form. The evaluation script (scripts/evaluate.py)
 * is the only thing allowed to read that table. See PROJECT_SUMMARY.md §3.
 *
 * Three matching passes, run in order for each order:
 *   1. Exact match      — link payment -> settlement by foreign key (ID).
 *   2. Aggregation match — sum every bank transaction linked to that
 *                          settlement, since a payout may be (incorrectly)
 *                          split across more than one bank credit.
 *   3. Tolerant match    — once there is exactly one confirmed bank credit,
 *                          check settlement math, refund awareness, amount,
 *                          and timing against fixed tolerances.
 */

import type { BankTransaction, Order, Payment, Settlement } from "@/types/reconciliation";
import {
  AMOUNT_TOLERANCE_PAISE,
  FEE_TOLERANCE_PAISE,
  GST_RATE_ON_FEE,
  MATERIALITY_PAISE,
  RAZORPAY_FEE_RATE,
  TIMING_TOLERANCE_DAYS,
} from "./constants";
import { daysBetween } from "./dateUtils";
import { fuzzyMatchSettlement } from "./fuzzyMatch";
import type { EngineVerdict, OrderReconciliationInput } from "./types";

/** gross - fee - tax - refund, using the payment's own recorded figures. */
function expectedNetFromPayment(payment: Payment): number {
  return payment.amount_paise - payment.fee_paise - payment.tax_paise - payment.refund_amount_paise;
}

/**
 * Confidence scales from 60 (just past tolerance) toward 99 (many
 * multiples of tolerance past it) — a discrepancy barely outside the
 * noise band is reported as less certain than an obvious one.
 */
function confidenceFromRatio(ratio: number): number {
  const clamped = Math.min(Math.max(ratio, 0), 8);
  return Math.min(99, Math.round(60 + clamped * 5));
}

function recommend(
  status: EngineVerdict["status"],
  issueType: EngineVerdict["issue_type"],
  differencePaise: number | null,
): EngineVerdict["recommendation"] {
  if (status === "RECONCILED") return "AUTO_RECONCILE";
  // Money structurally absent or structurally double-credited always needs
  // a human to look, regardless of ₹ amount.
  if (issueType === "MISSING_SETTLEMENT" || issueType === "DUPLICATE") return "INVESTIGATE";
  const materialAbs = differencePaise === null ? 0 : Math.abs(differencePaise);
  return materialAbs >= MATERIALITY_PAISE ? "INVESTIGATE" : "REVIEW";
}

/** No payment record exists for this order at all — defensive branch, not exercised by the current synthetic dataset (every order has exactly one payment). */
function noPaymentVerdict(order: Order): EngineVerdict {
  return {
    order_id: order.id,
    status: "REVIEW_NEEDED",
    issue_type: null,
    expected_amount_paise: order.amount_paise,
    actual_amount_paise: null,
    confidence_score: null,
    recommendation: "INVESTIGATE",
    reason: "No captured payment found for this order.",
    payment_id: null,
    settlement_id: null,
    bank_transaction_id: null,
  };
}

function missingSettlementVerdict(order: Order, payment: Payment, settlement?: Settlement): EngineVerdict {
  const expected = expectedNetFromPayment(payment);
  return {
    order_id: order.id,
    status: "EXCEPTION",
    issue_type: "MISSING_SETTLEMENT",
    expected_amount_paise: expected,
    actual_amount_paise: null,
    confidence_score: 95,
    recommendation: "INVESTIGATE",
    reason: settlement
      ? `Settlement ${settlement.settlement_ref} exists but no bank credit has arrived yet.`
      : `Payment ${payment.payment_ref} was captured but no settlement has been created yet.`,
    payment_id: payment.id,
    settlement_id: settlement?.id ?? null,
    bank_transaction_id: null,
  };
}

/**
 * Fuzzy pass found candidates but none confident enough to auto-match
 * (either below the absolute threshold, or tied closely enough with the
 * runner-up that picking one would be a guess). Routed to REVIEW_NEEDED
 * rather than classified as any of the six issue types — a human needs to
 * pick the right settlement, the engine isn't claiming to know which one.
 */
function unresolvedFuzzyVerdict(
  order: Order,
  payment: Payment,
  settlement: Settlement,
  bestScore: number,
  secondBestScore: number | null,
): EngineVerdict {
  const reason =
    secondBestScore !== null
      ? `Best candidate bank credit for settlement ${settlement.settlement_ref} scores ${(bestScore * 100).toFixed(0)}% confidence, only ${((bestScore - secondBestScore) * 100).toFixed(0)} points ahead of the next candidate — too ambiguous to auto-match.`
      : `Best candidate bank credit for settlement ${settlement.settlement_ref} scores only ${(bestScore * 100).toFixed(0)}% confidence — below the auto-match threshold, declining to guess.`;
  return {
    order_id: order.id,
    status: "REVIEW_NEEDED",
    issue_type: null,
    expected_amount_paise: settlement.net_amount_paise,
    actual_amount_paise: null,
    confidence_score: Math.round(bestScore * 100),
    recommendation: "REVIEW",
    reason,
    payment_id: payment.id,
    settlement_id: settlement.id,
    bank_transaction_id: null,
  };
}

/** Pass 2: aggregation match found more than one bank credit against a single settlement. */
function duplicateVerdict(
  order: Order,
  payment: Payment,
  settlement: Settlement,
  bankTxns: BankTransaction[],
): EngineVerdict {
  const [anchor] = bankTxns;
  if (!anchor) throw new Error("duplicateVerdict requires at least one bank transaction");
  const expected = settlement.net_amount_paise;
  const actual = bankTxns.reduce((sum, b) => sum + b.amount_paise, 0);
  return {
    order_id: order.id,
    status: "EXCEPTION",
    issue_type: "DUPLICATE",
    expected_amount_paise: expected,
    actual_amount_paise: actual,
    confidence_score: 98,
    recommendation: "INVESTIGATE",
    reason: `${bankTxns.length} bank credits (₹${(actual / 100).toFixed(2)} total) matched to settlement ${settlement.settlement_ref}, which expects one credit of ₹${(expected / 100).toFixed(2)}.`,
    payment_id: payment.id,
    settlement_id: settlement.id,
    // Schema allows only one bank_transaction_id per result row; record the first as the anchor.
    bank_transaction_id: anchor.id,
  };
}

/** Pass 3: tolerant match — settlement math, refund awareness, amount, timing, in priority order. */
function toleranceChecks(
  order: Order,
  payment: Payment,
  settlement: Settlement,
  bankTxn: BankTransaction,
): EngineVerdict {
  const base = {
    order_id: order.id,
    payment_id: payment.id,
    settlement_id: settlement.id,
    bank_transaction_id: bankTxn.id,
  };

  // Check 1 — did the settlement apply a different fee than the payment recorded?
  const feeDiff = settlement.fee_paise - payment.fee_paise;
  if (Math.abs(feeDiff) > FEE_TOLERANCE_PAISE) {
    const expected = expectedNetFromPayment(payment);
    const actual = bankTxn.amount_paise;
    return {
      ...base,
      status: "EXCEPTION",
      issue_type: "FEE_MISMATCH",
      expected_amount_paise: expected,
      actual_amount_paise: actual,
      confidence_score: confidenceFromRatio(Math.abs(feeDiff) / FEE_TOLERANCE_PAISE),
      recommendation: recommend("EXCEPTION", "FEE_MISMATCH", actual - expected),
      reason: `Settlement fee ₹${(settlement.fee_paise / 100).toFixed(2)} differs from payment fee ₹${(payment.fee_paise / 100).toFixed(2)} by ₹${(feeDiff / 100).toFixed(2)} (expected rate ${(RAZORPAY_FEE_RATE * 100).toFixed(1)}%, GST ${(GST_RATE_ON_FEE * 100).toFixed(0)}% on fee).`,
    };
  }

  // Check 2 — was a refund recorded on the payment but never reflected in the settlement?
  if (payment.refund_amount_paise > 0 && settlement.refund_paise < payment.refund_amount_paise) {
    const expected = expectedNetFromPayment(payment);
    const actual = bankTxn.amount_paise;
    return {
      ...base,
      status: "EXCEPTION",
      issue_type: "REFUND",
      expected_amount_paise: expected,
      actual_amount_paise: actual,
      confidence_score: 92,
      recommendation: recommend("EXCEPTION", "REFUND", actual - expected),
      reason: `Payment shows a ₹${(payment.refund_amount_paise / 100).toFixed(2)} refund that the settlement (and the bank credit that mirrors it) does not account for.`,
      payment_id: payment.id,
      settlement_id: settlement.id,
      bank_transaction_id: bankTxn.id,
    };
  }

  // Check 3 — does the bank-confirmed amount match the settlement's own expected net?
  const expected = settlement.net_amount_paise;
  const actual = bankTxn.amount_paise;
  const amountDiff = actual - expected;
  if (Math.abs(amountDiff) > AMOUNT_TOLERANCE_PAISE) {
    return {
      ...base,
      status: "EXCEPTION",
      issue_type: "AMOUNT_MISMATCH",
      expected_amount_paise: expected,
      actual_amount_paise: actual,
      confidence_score: confidenceFromRatio(Math.abs(amountDiff) / AMOUNT_TOLERANCE_PAISE),
      recommendation: recommend("EXCEPTION", "AMOUNT_MISMATCH", amountDiff),
      reason: `Bank credit ₹${(actual / 100).toFixed(2)} differs from settlement net ₹${(expected / 100).toFixed(2)} by ₹${(amountDiff / 100).toFixed(2)}.`,
    };
  }

  // Check 4 — did the bank credit arrive far later than the settlement's stated date?
  const lagDays = daysBetween(settlement.settlement_date, bankTxn.transaction_date);
  if (lagDays > TIMING_TOLERANCE_DAYS) {
    return {
      ...base,
      status: "EXCEPTION",
      issue_type: "TIMING",
      expected_amount_paise: expected,
      actual_amount_paise: actual,
      confidence_score: confidenceFromRatio(lagDays / TIMING_TOLERANCE_DAYS),
      recommendation: recommend("EXCEPTION", "TIMING", 0),
      reason: `Bank credit arrived ${lagDays} days after the settlement date (expected within ${TIMING_TOLERANCE_DAYS} days).`,
    };
  }

  // Clean.
  return {
    ...base,
    status: "RECONCILED",
    issue_type: null,
    expected_amount_paise: expected,
    actual_amount_paise: actual,
    confidence_score: 100,
    recommendation: "AUTO_RECONCILE",
    reason: "Amounts and timing match within tolerance across order, payment, settlement, and bank credit.",
  };
}

/** Runs all passes for a single order. Never touches ground_truth_labels. */
export function reconcileOrder(input: OrderReconciliationInput): EngineVerdict {
  const { order, payments, settlements, bankTransactions, orphanBankTransactions } = input;

  // Pass 1: exact match — locate this order's payment by foreign key.
  const payment = payments.find((p) => p.order_id === order.id);
  if (!payment) return noPaymentVerdict(order);

  const paymentSettlements = settlements.filter((s) => s.payment_id === payment.id);
  // Dataset/schema invariant: at most one settlement per payment today.
  const [settlement] = paymentSettlements;
  if (!settlement) return missingSettlementVerdict(order, payment);

  // Pass 2: aggregation match — every bank transaction linked to this settlement.
  const linkedBankTxns = bankTransactions.filter((b) => b.matched_settlement_id === settlement.id);
  const [onlyBankTxn] = linkedBankTxns;

  if (!onlyBankTxn) {
    // Pass 2.5: fuzzy candidate match — the clean FK link is missing, so
    // search every orphan bank credit in the dataset for the best
    // amount+date(+reference) match before giving up on this settlement.
    const fuzzy = fuzzyMatchSettlement(order, settlement, orphanBankTransactions);
    if (fuzzy.kind === "no_candidates") return missingSettlementVerdict(order, payment, settlement);
    if (fuzzy.kind === "ambiguous") {
      return unresolvedFuzzyVerdict(order, payment, settlement, fuzzy.bestScore, fuzzy.secondBestScore);
    }
    // Resolved — run the same Pass 3 tolerance checks as a clean FK match
    // would, then cap the resulting confidence by how sure the fuzzy match
    // itself was (a fuzzy-resolved RECONCILED is never as certain as an
    // exact-match one), and note the fuzzy resolution in the reason text.
    const verdict = toleranceChecks(order, payment, settlement, fuzzy.bankTxn);
    return {
      ...verdict,
      confidence_score:
        verdict.confidence_score === null ? null : Math.round(Math.min(verdict.confidence_score, fuzzy.score * 100)),
      reason: `[Fuzzy-matched at ${(fuzzy.score * 100).toFixed(0)}% confidence — no clean bank reference] ${verdict.reason}`,
    };
  }
  if (linkedBankTxns.length > 1) return duplicateVerdict(order, payment, settlement, linkedBankTxns);

  // Pass 3: tolerant match against the single confirmed bank credit.
  return toleranceChecks(order, payment, settlement, onlyBankTxn);
}
