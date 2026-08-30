import type {
  BankTransaction,
  IssueType,
  Order,
  Payment,
  Recommendation,
  ReconciliationStatus,
  Settlement,
} from "@/types/reconciliation";

/**
 * Everything the engine needs for one order. Deliberately excludes
 * ground_truth_labels — that table must never be read by engine code
 * (see PROJECT_SUMMARY.md §3 and database/migrations/00003_rls_policies.sql).
 */
export interface OrderReconciliationInput {
  order: Order;
  payments: Payment[];
  settlements: Settlement[];
  bankTransactions: BankTransaction[];
  /**
   * Every bank_transactions row in the whole dataset with
   * matched_settlement_id IS NULL — not just this order's own rows. Used
   * only by the fuzzy candidate-matching pass (fuzzyMatch.ts), and only
   * when this order's settlement has no cleanly linked bank transaction.
   */
  orphanBankTransactions: BankTransaction[];
}

/**
 * The engine's verdict for one order — maps 1:1 onto the parameters of
 * compute_reconciliation_atomic(). The engine never writes to the database
 * itself; a caller (scripts/run-reconciliation.ts) passes this to the RPC.
 */
export interface EngineVerdict {
  order_id: string;
  status: ReconciliationStatus;
  issue_type: IssueType | null;
  expected_amount_paise: number | null;
  actual_amount_paise: number | null;
  confidence_score: number | null;
  recommendation: Recommendation | null;
  reason: string;
  payment_id: string | null;
  settlement_id: string | null;
  bank_transaction_id: string | null;
}
