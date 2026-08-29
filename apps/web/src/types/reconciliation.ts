/**
 * Core reconciliation domain types.
 *
 * These mirror database/migrations/00002_core_schema.sql exactly. Money is
 * always integer paise (never a float) — see PROJECT_SUMMARY.md §4.
 *
 * No packages/types workspace exists for this — apps/web is currently the
 * only consumer. See PROJECT_SUMMARY.md §7.2 for why that split is deferred
 * until a second consumer actually needs these types.
 */

export type IssueType =
  | "FEE_MISMATCH"
  | "MISSING_SETTLEMENT"
  | "AMOUNT_MISMATCH"
  | "DUPLICATE"
  | "REFUND"
  | "TIMING";

export type ReconciliationStatus = "RECONCILED" | "EXCEPTION" | "REVIEW_NEEDED";

export type Recommendation = "AUTO_RECONCILE" | "REVIEW" | "INVESTIGATE";

export interface Order {
  id: string;
  order_number: string;
  customer_ref: string;
  amount_paise: number;
  currency: string;
  status: "CREATED" | "PAID" | "REFUNDED" | "CANCELLED";
  created_at: string;
}

export interface Payment {
  id: string;
  order_id: string;
  payment_ref: string;
  amount_paise: number;
  fee_paise: number;
  tax_paise: number;
  refund_amount_paise: number;
  method: "UPI" | "CARD" | "NETBANKING" | "WALLET";
  status: "CAPTURED" | "FAILED" | "REFUNDED";
  captured_at: string;
}

export interface Settlement {
  id: string;
  payment_id: string;
  settlement_ref: string;
  gross_amount_paise: number;
  fee_paise: number;
  tax_paise: number;
  refund_paise: number;
  net_amount_paise: number;
  settlement_date: string;
}

export interface BankTransaction {
  id: string;
  bank_reference: string;
  utr: string;
  amount_paise: number;
  transaction_date: string;
  narration: string | null;
  matched_settlement_id: string | null;
}

export interface ReconciliationResult {
  id: string;
  order_id: string;
  payment_id: string | null;
  settlement_id: string | null;
  bank_transaction_id: string | null;
  status: ReconciliationStatus;
  issue_type: IssueType | null;
  expected_amount_paise: number | null;
  actual_amount_paise: number | null;
  difference_paise: number | null;
  confidence_score: number | null;
  recommendation: Recommendation | null;
  ai_explanation: string | null;
  reason: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}
