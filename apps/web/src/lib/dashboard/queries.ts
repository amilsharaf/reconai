/**
 * ReconAI — Dashboard Data Layer
 *
 * Server-only. Uses the service-role Supabase client (bypasses RLS) — the
 * same trust boundary the reconciliation/AI runners already use, since
 * there's no end-user auth flow built yet (see PROJECT_SUMMARY.md; Phase 5
 * doesn't add one). These functions must only ever be called from Server
 * Components / server code, never shipped to the client bundle.
 */

import { createServiceClient } from "@/lib/supabase/serviceClient";
import type {
  IssueType,
  Recommendation,
  ReconciliationStatus,
} from "@/types/reconciliation";

const PAGE_SIZE = 1000; // PostgREST's own default cap — must paginate past it explicitly, it never truncates silently on its own but a plain .select() does stop here

/**
 * Supabase/PostgREST caps an unbounded `.select()` at 1000 rows by default —
 * it does NOT error or warn, it just silently returns a partial result. Any
 * query that could return more than 1000 rows as this dataset grows must go
 * through this helper (or an exact-count `head: true` query, which isn't
 * subject to the cap at all) instead of a bare `.select()`.
 */
async function fetchAllRows<T>(
  queryBuilder: (from: number, to: number) => Promise<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await queryBuilder(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}

export interface Kpis {
  totalOrders: number;
  reconciled: number;
  exception: number;
  reviewNeeded: number;
  pending: number; // orders with no reconciliation_results row yet
  matchRatePct: number;
  valueReconciledPaise: number;
  valueAtRiskPaise: number;
  aiExplanationCompleted: number;
  aiExplanationCandidates: number; // EXCEPTION + REVIEW_NEEDED rows
}

export async function getKpis(): Promise<Kpis> {
  const supabase = createServiceClient();

  // Exact counts via head:true — these read PostgREST's Content-Range count
  // metadata, never the row cap, so they're accurate at any table size.
  const [
    { count: totalOrders },
    { count: reconciledCount },
    { count: exceptionCount },
    { count: reviewNeededCount },
    { count: aiExplanationCompletedCount },
  ] = await Promise.all([
    supabase.from("orders").select("*", { count: "exact", head: true }),
    supabase.from("reconciliation_results").select("*", { count: "exact", head: true }).eq("status", "RECONCILED"),
    supabase.from("reconciliation_results").select("*", { count: "exact", head: true }).eq("status", "EXCEPTION"),
    supabase.from("reconciliation_results").select("*", { count: "exact", head: true }).eq("status", "REVIEW_NEEDED"),
    supabase.from("reconciliation_results").select("*", { count: "exact", head: true }).eq("ai_explanation_status", "COMPLETED"),
  ]);

  const total = totalOrders ?? 0;
  const reconciled = reconciledCount ?? 0;
  const exception = exceptionCount ?? 0;
  const reviewNeeded = reviewNeededCount ?? 0;
  const pending = total - (reconciled + exception + reviewNeeded); // orders with no computed result row yet

  // Summing ₹ value has no exact-count shortcut — paginate past the 1000-row
  // cap explicitly rather than risk a silent partial sum.
  const orderValues = await fetchAllRows<{ status: ReconciliationStatus; orders: { amount_paise: number } | null }>(
    (from, to) =>
      supabase
        .from("reconciliation_results")
        .select("status, orders(amount_paise)")
        .range(from, to) as unknown as Promise<{ data: { status: ReconciliationStatus; orders: { amount_paise: number } | null }[] | null; error: { message: string } | null }>,
  );

  let valueReconciledPaise = 0;
  let valueAtRiskPaise = 0;
  for (const row of orderValues) {
    const amount = row.orders?.amount_paise ?? 0;
    if (row.status === "RECONCILED") valueReconciledPaise += amount;
    else valueAtRiskPaise += amount;
  }

  const aiExplanationCandidates = exception + reviewNeeded;
  const aiExplanationCompleted = aiExplanationCompletedCount ?? 0;

  return {
    totalOrders: total,
    reconciled,
    exception,
    reviewNeeded,
    pending,
    matchRatePct: total > 0 ? (reconciled / total) * 100 : 0,
    valueReconciledPaise,
    valueAtRiskPaise,
    aiExplanationCompleted: aiExplanationCompleted ?? 0,
    aiExplanationCandidates,
  };
}

export interface ExceptionRow {
  id: string;
  orderNumber: string;
  status: ReconciliationStatus;
  issueType: IssueType | null;
  amountPaise: number;
  confidenceScore: number | null;
  recommendation: Recommendation | null;
  aiExplanationStatus: "PENDING" | "COMPLETED" | "FAILED";
}

export async function getExceptionRows(): Promise<ExceptionRow[]> {
  // Not paginated past PAGE_SIZE — currently 286 rows, well under the 1000
  // cap. If this table's row count could exceed 1000, use fetchAllRows()
  // (see getKpis) or add real server-side pagination to the UI itself.
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("reconciliation_results")
    .select(
      "id, status, issue_type, confidence_score, recommendation, ai_explanation_status, orders(order_number, amount_paise)",
    )
    .in("status", ["EXCEPTION", "REVIEW_NEEDED"])
    .order("confidence_score", { ascending: true });

  if (error) throw new Error(`Fetching exception rows failed: ${error.message}`);

  return (
    data as unknown as {
      id: string;
      status: ReconciliationStatus;
      issue_type: IssueType | null;
      confidence_score: number | null;
      recommendation: Recommendation | null;
      ai_explanation_status: "PENDING" | "COMPLETED" | "FAILED";
      orders: { order_number: string; amount_paise: number } | null;
    }[]
  ).map((r) => ({
    id: r.id,
    orderNumber: r.orders?.order_number ?? "(unknown)",
    status: r.status,
    issueType: r.issue_type,
    amountPaise: r.orders?.amount_paise ?? 0,
    confidenceScore: r.confidence_score,
    recommendation: r.recommendation,
    aiExplanationStatus: r.ai_explanation_status,
  }));
}

export interface AuditLogEntry {
  id: string;
  action: string;
  createdAt: string;
  actorId: string | null;
  metadata: Record<string, unknown>;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
}

export interface TransactionDetail {
  id: string;
  order: {
    id: string;
    orderNumber: string;
    customerRef: string;
    amountPaise: number;
    status: string;
    createdAt: string;
  };
  payment: {
    paymentRef: string;
    amountPaise: number;
    feePaise: number;
    taxPaise: number;
    refundAmountPaise: number;
    method: string;
    status: string;
    capturedAt: string;
  } | null;
  settlement: {
    settlementRef: string;
    grossAmountPaise: number;
    feePaise: number;
    taxPaise: number;
    netAmountPaise: number;
    settlementDate: string;
  } | null;
  bankTransactions: {
    id: string;
    bankReference: string;
    amountPaise: number;
    transactionDate: string;
    narration: string | null;
  }[];
  reconciliation: {
    status: ReconciliationStatus;
    issueType: IssueType | null;
    expectedAmountPaise: number | null;
    actualAmountPaise: number | null;
    differencePaise: number | null;
    confidenceScore: number | null;
    recommendation: Recommendation | null;
    reason: string | null;
    aiExplanation: string | null;
    aiExplanationStatus: "PENDING" | "COMPLETED" | "FAILED";
  };
  auditLog: AuditLogEntry[];
}

export async function getTransactionDetail(reconciliationResultId: string): Promise<TransactionDetail | null> {
  const supabase = createServiceClient();

  const { data: rr, error: rrError } = await supabase
    .from("reconciliation_results")
    .select(
      "id, order_id, payment_id, settlement_id, bank_transaction_id, status, issue_type, expected_amount_paise, actual_amount_paise, difference_paise, confidence_score, recommendation, reason, ai_explanation, ai_explanation_status",
    )
    .eq("id", reconciliationResultId)
    .maybeSingle();

  if (rrError) throw new Error(`Fetching reconciliation_results failed: ${rrError.message}`);
  if (!rr) return null;

  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select("id, order_number, customer_ref, amount_paise, status, created_at")
    .eq("id", rr.order_id)
    .single();
  if (orderError) throw new Error(`Fetching order failed: ${orderError.message}`);

  const payment = rr.payment_id
    ? (
        await supabase
          .from("payments")
          .select("payment_ref, amount_paise, fee_paise, tax_paise, refund_amount_paise, method, status, captured_at")
          .eq("id", rr.payment_id)
          .maybeSingle()
      ).data
    : null;

  const settlement = rr.settlement_id
    ? (
        await supabase
          .from("settlements")
          .select("id, settlement_ref, gross_amount_paise, fee_paise, tax_paise, net_amount_paise, settlement_date")
          .eq("id", rr.settlement_id)
          .maybeSingle()
      ).data
    : null;

  // Every bank transaction linked to this settlement — not just the anchor
  // reconciliation_results.bank_transaction_id — so a DUPLICATE case shows
  // both credits, not just one.
  const bankTransactions = settlement
    ? (
        await supabase
          .from("bank_transactions")
          .select("id, bank_reference, amount_paise, transaction_date, narration")
          .eq("matched_settlement_id", settlement.id)
      ).data ?? []
    : [];

  const { data: auditRows, error: auditError } = await supabase
    .from("audit_logs")
    .select("id, action, created_at, actor_id, metadata, old_values, new_values")
    .eq("entity_type", "reconciliation_result")
    .eq("entity_id", rr.id)
    .order("created_at", { ascending: true });
  if (auditError) throw new Error(`Fetching audit_logs failed: ${auditError.message}`);

  return {
    id: rr.id,
    order: {
      id: order.id,
      orderNumber: order.order_number,
      customerRef: order.customer_ref,
      amountPaise: order.amount_paise,
      status: order.status,
      createdAt: order.created_at,
    },
    payment: payment
      ? {
          paymentRef: payment.payment_ref,
          amountPaise: payment.amount_paise,
          feePaise: payment.fee_paise,
          taxPaise: payment.tax_paise,
          refundAmountPaise: payment.refund_amount_paise,
          method: payment.method,
          status: payment.status,
          capturedAt: payment.captured_at,
        }
      : null,
    settlement: settlement
      ? {
          settlementRef: settlement.settlement_ref,
          grossAmountPaise: settlement.gross_amount_paise,
          feePaise: settlement.fee_paise,
          taxPaise: settlement.tax_paise,
          netAmountPaise: settlement.net_amount_paise,
          settlementDate: settlement.settlement_date,
        }
      : null,
    bankTransactions: bankTransactions.map((b) => ({
      id: b.id,
      bankReference: b.bank_reference,
      amountPaise: b.amount_paise,
      transactionDate: b.transaction_date,
      narration: b.narration,
    })),
    reconciliation: {
      status: rr.status,
      issueType: rr.issue_type,
      expectedAmountPaise: rr.expected_amount_paise,
      actualAmountPaise: rr.actual_amount_paise,
      differencePaise: rr.difference_paise,
      confidenceScore: rr.confidence_score,
      recommendation: rr.recommendation,
      reason: rr.reason,
      aiExplanation: rr.ai_explanation,
      aiExplanationStatus: rr.ai_explanation_status,
    },
    auditLog: (auditRows ?? []).map((a) => ({
      id: a.id,
      action: a.action,
      createdAt: a.created_at,
      actorId: a.actor_id,
      metadata: (a.metadata as Record<string, unknown>) ?? {},
      oldValues: a.old_values as Record<string, unknown> | null,
      newValues: a.new_values as Record<string, unknown> | null,
    })),
  };
}
