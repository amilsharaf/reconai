import type { IssueType, Recommendation, ReconciliationStatus } from "@/types/reconciliation";

/**
 * Everything the AI explanation call is allowed to see for one row. Every
 * field here was already computed deterministically by the reconciliation
 * engine (src/lib/reconciliation/) or the fuzzy-matching pass — the AI
 * receives this fixed structured object, never a database connection, and
 * never recomputes any of it. Amounts are pre-formatted in rupees here
 * (not left for the model to divide paise by 100 itself) — even a trivial
 * unit conversion is arithmetic the model should never be asked to do.
 */
export interface ExceptionEvidence {
  reconciliation_result_id: string;
  order_number: string;
  status: Extract<ReconciliationStatus, "EXCEPTION" | "REVIEW_NEEDED">;
  issue_type: IssueType | null;
  expected_amount_rupees: string | null;
  actual_amount_rupees: string | null;
  difference_rupees: string | null;
  confidence_score: number | null;
  recommendation: Recommendation | null;
  /**
   * The engine/fuzzy-matcher's own deterministic reason string, verbatim —
   * for fuzzy-match cases (issue_type=null, status=REVIEW_NEEDED) this is
   * where the candidate scoring breakdown (best score, margin to runner-up)
   * already lives; there's no separate structured field for it because the
   * reason text already carries it deterministically.
   */
  deterministic_reason: string;
}

export type ExplanationResult =
  | { status: "COMPLETED"; explanation: string; model: string }
  | { status: "FAILED"; reason: string; model: string };
