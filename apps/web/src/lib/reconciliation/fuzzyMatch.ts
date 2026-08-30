/**
 * ReconAI — Fuzzy Candidate Matching Pass (additive to the deterministic engine)
 *
 * Handles bank credits that arrive without a clean matched_settlement_id —
 * i.e. the bank's own reference didn't survive whatever fed it into
 * bank_transactions, so there's no foreign key to walk. engine.ts only
 * calls into this module when Pass 1/2 (exact + aggregation match) find a
 * settlement with zero linked bank transactions; this never runs for a
 * settlement that already has one.
 *
 * Scoring is amount similarity + date proximity + a weak reference/
 * narration signal, combined into a single 0-1 score per candidate. A
 * candidate is only auto-accepted if it clears an absolute confidence
 * threshold AND beats the runner-up by a minimum margin — a lone decent
 * match and a genuine two-way tie are treated differently on purpose: an
 * engine that can't tell two candidates apart should say so, not guess.
 */

import type { BankTransaction, Order, Settlement } from "@/types/reconciliation";
import { daysBetween } from "./dateUtils";

/** Beyond this ₹ gap, amount similarity contributes ~nothing. */
const FUZZY_AMOUNT_WINDOW_PAISE = 2000; // ₹20

/** Beyond this many days apart, date similarity contributes ~nothing. */
const FUZZY_DATE_WINDOW_DAYS = 10;

/** Best candidate must clear this score to auto-resolve at all. */
export const FUZZY_CONFIDENCE_THRESHOLD = 0.75;

/**
 * Best candidate must beat the runner-up by at least this much — a close
 * second place means genuine ambiguity, not a confident match.
 */
export const FUZZY_MARGIN_THRESHOLD = 0.05;

const AMOUNT_WEIGHT = 0.6;
const DATE_WEIGHT = 0.3;
const REFERENCE_WEIGHT = 0.1;

function amountSimilarity(a: number, b: number): number {
  return Math.max(0, 1 - Math.abs(a - b) / FUZZY_AMOUNT_WINDOW_PAISE);
}

function dateSimilarity(dateA: string, dateB: string): number {
  return Math.max(0, 1 - Math.abs(daysBetween(dateA, dateB)) / FUZZY_DATE_WINDOW_DAYS);
}

/** Weak signal: does the bank narration happen to mention this order's own order_number? */
function referenceSimilarity(narration: string | null, orderNumber: string): number {
  if (!narration) return 0;
  return narration.includes(orderNumber) ? 1 : 0;
}

function scoreCandidate(settlement: Settlement, orderNumber: string, bankTxn: BankTransaction): number {
  const amount = amountSimilarity(settlement.net_amount_paise, bankTxn.amount_paise);
  const date = dateSimilarity(settlement.settlement_date, bankTxn.transaction_date);
  const reference = referenceSimilarity(bankTxn.narration, orderNumber);
  return AMOUNT_WEIGHT * amount + DATE_WEIGHT * date + REFERENCE_WEIGHT * reference;
}

export type FuzzyMatchResult =
  | { kind: "resolved"; bankTxn: BankTransaction; score: number }
  | { kind: "no_candidates" }
  | { kind: "ambiguous"; bestScore: number; secondBestScore: number | null };

/**
 * Scores every orphan bank transaction (matched_settlement_id IS NULL,
 * anywhere in the dataset — the caller is responsible for passing the
 * global pool, not just this order's own rows) against one settlement
 * that has no cleanly linked bank credit, and either picks a confident
 * winner or declines to guess.
 */
export function fuzzyMatchSettlement(
  order: Order,
  settlement: Settlement,
  orphanBankTransactions: BankTransaction[],
): FuzzyMatchResult {
  const scored = orphanBankTransactions
    .map((bankTxn) => ({ bankTxn, score: scoreCandidate(settlement, order.order_number, bankTxn) }))
    .sort((a, b) => b.score - a.score);

  const [top, second] = scored;
  if (!top) return { kind: "no_candidates" };

  const margin = second ? top.score - second.score : top.score;
  if (top.score >= FUZZY_CONFIDENCE_THRESHOLD && margin >= FUZZY_MARGIN_THRESHOLD) {
    return { kind: "resolved", bankTxn: top.bankTxn, score: top.score };
  }
  return { kind: "ambiguous", bestScore: top.score, secondBestScore: second?.score ?? null };
}
