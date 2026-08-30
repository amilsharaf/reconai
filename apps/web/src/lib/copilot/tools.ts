/**
 * ReconAI — Finance Copilot Tools
 *
 * Five tools, each a real parameterized Supabase query — nothing here is
 * an open-ended SQL executor, and the LLM never writes SQL itself. Every
 * function returns plain JSON with amounts pre-formatted in rupees (the
 * LLM never divides paise by 100 or does any other arithmetic — same rule
 * as the AI explanation layer in Phase 4). Server-only: uses the
 * service-role client, same trust boundary as the rest of the app (no
 * end-user auth flow exists yet).
 */

import { createServiceClient } from "@/lib/supabase/serviceClient";
import { formatRupees } from "@/lib/dashboard/format";
import type { IssueType, ReconciliationStatus } from "@/types/reconciliation";

const ISSUE_TYPES = ["FEE_MISMATCH", "MISSING_SETTLEMENT", "AMOUNT_MISMATCH", "DUPLICATE", "REFUND", "TIMING"] as const;

/** JSON-Schema tool declarations, sent to Gemini's Interactions API `tools` field. */
export const TOOL_DECLARATIONS = [
  {
    type: "function",
    name: "get_summary_stats",
    description:
      "Overview KPIs for the whole reconciliation dataset: total transactions, reconciled/exception/review-needed counts (plus unreconciled_count, already summed for you), match rate and unreconciled rate (both already computed as percentages), and total order value reconciled vs. at risk (in rupees). Use the pre-computed fields as-is — do not add or subtract counts/percentages yourself. This is the SAME data shown on the dashboard's Overview page — it does not include raw settlement-table totals separately.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "get_largest_exceptions",
    description: "The largest flagged exceptions/reviews by order amount, optionally filtered to one issue type.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "How many to return, default 5, max 50." },
        issue_type: {
          type: "string",
          enum: [...ISSUE_TYPES, "UNRESOLVED"],
          description: "Optional. Filter to one issue type; UNRESOLVED means the unresolved fuzzy-match / REVIEW_NEEDED cases with no issue type.",
        },
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "get_exception_by_order",
    description: "Full reconciliation detail for one specific order, by order number (e.g. ORD-2026-000452).",
    parameters: {
      type: "object",
      properties: {
        order_number: { type: "string", description: "The order number, e.g. ORD-2026-000452." },
      },
      required: ["order_number"],
    },
  },
  {
    type: "function",
    name: "get_exceptions_by_type",
    description: "Count and total ₹ value of flagged exceptions/reviews, broken down by issue type (including unresolved fuzzy-match cases).",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function",
    name: "get_ai_explanation_progress",
    description: "How many exception/review rows have a completed AI-generated explanation vs. the total that need one.",
    parameters: { type: "object", properties: {}, required: [] },
  },
] as const;

export type ToolName = (typeof TOOL_DECLARATIONS)[number]["name"];

// ============================================================================
// Tool implementations
// ============================================================================

async function get_summary_stats() {
  const supabase = createServiceClient();
  const [{ count: total }, { count: reconciled }, { count: exception }, { count: reviewNeeded }] = await Promise.all([
    supabase.from("orders").select("*", { count: "exact", head: true }),
    supabase.from("reconciliation_results").select("*", { count: "exact", head: true }).eq("status", "RECONCILED"),
    supabase.from("reconciliation_results").select("*", { count: "exact", head: true }).eq("status", "EXCEPTION"),
    supabase.from("reconciliation_results").select("*", { count: "exact", head: true }).eq("status", "REVIEW_NEEDED"),
  ]);

  // Paginate past PostgREST's 1000-row cap (see lib/dashboard/queries.ts) —
  // this exact bug was found and fixed while building the Phase 5
  // dashboard; the same fix is required here.
  let valueReconciledPaise = 0;
  let valueAtRiskPaise = 0;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("reconciliation_results")
      .select("status, orders(amount_paise)")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (const row of data as unknown as { status: ReconciliationStatus; orders: { amount_paise: number } | null }[]) {
      const amt = row.orders?.amount_paise ?? 0;
      if (row.status === "RECONCILED") valueReconciledPaise += amt;
      else valueAtRiskPaise += amt;
    }
    if (data.length < 1000) break;
    from += 1000;
  }

  const totalN = total ?? 0;
  const reconciledN = reconciled ?? 0;
  const exceptionN = exception ?? 0;
  const reviewNeededN = reviewNeeded ?? 0;
  // Pre-computed on purpose: exception_count + review_needed_count, and
  // 100 - match_rate_pct, are both correct but are still arithmetic — the
  // model must never be left to add or subtract two of these fields
  // itself, even trivially, so every number it could plausibly want is
  // already computed here.
  return {
    total_transactions: totalN,
    reconciled_count: reconciledN,
    exception_count: exceptionN,
    review_needed_count: reviewNeededN,
    unreconciled_count: exceptionN + reviewNeededN,
    match_rate_pct: totalN > 0 ? Number(((reconciledN / totalN) * 100).toFixed(1)) : 0,
    unreconciled_rate_pct: totalN > 0 ? Number((((exceptionN + reviewNeededN) / totalN) * 100).toFixed(1)) : 0,
    value_reconciled: formatRupees(valueReconciledPaise),
    value_at_risk: formatRupees(valueAtRiskPaise),
  };
}

async function get_largest_exceptions(args: { limit?: number; issue_type?: string }) {
  const supabase = createServiceClient();
  const limit = Math.min(Math.max(args.limit ?? 5, 1), 50);

  let query = supabase
    .from("reconciliation_results")
    .select("issue_type, status, confidence_score, recommendation, orders(order_number, amount_paise)")
    .in("status", ["EXCEPTION", "REVIEW_NEEDED"]);

  if (args.issue_type === "UNRESOLVED") {
    query = query.is("issue_type", null);
  } else if (args.issue_type) {
    query = query.eq("issue_type", args.issue_type);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const rows = (
    data as unknown as {
      issue_type: IssueType | null;
      status: ReconciliationStatus;
      confidence_score: number | null;
      recommendation: string | null;
      orders: { order_number: string; amount_paise: number } | null;
    }[]
  )
    .filter((r) => r.orders !== null)
    .sort((a, b) => (b.orders?.amount_paise ?? 0) - (a.orders?.amount_paise ?? 0))
    .slice(0, limit);

  return {
    count_returned: rows.length,
    exceptions: rows.map((r) => ({
      order_number: r.orders?.order_number,
      issue_type: r.issue_type ?? "UNRESOLVED",
      status: r.status,
      amount: formatRupees(r.orders?.amount_paise ?? 0),
      confidence_score: r.confidence_score,
      recommendation: r.recommendation,
    })),
  };
}

async function get_exception_by_order(args: { order_number: string }) {
  const supabase = createServiceClient();
  const { data: order, error: orderError } = await supabase
    .from("orders")
    .select("id, order_number, amount_paise, status")
    .eq("order_number", args.order_number)
    .maybeSingle();
  if (orderError) throw new Error(orderError.message);
  if (!order) return { found: false, message: `No order found with order_number ${args.order_number}` };

  const { data: rr, error: rrError } = await supabase
    .from("reconciliation_results")
    .select("status, issue_type, expected_amount_paise, actual_amount_paise, difference_paise, confidence_score, recommendation, reason, ai_explanation, ai_explanation_status")
    .eq("order_id", order.id)
    .maybeSingle();
  if (rrError) throw new Error(rrError.message);
  if (!rr) return { found: true, order_number: order.order_number, message: "Order exists but has not been reconciled yet." };

  return {
    found: true,
    order_number: order.order_number,
    order_amount: formatRupees(order.amount_paise),
    reconciliation_status: rr.status,
    issue_type: rr.issue_type ?? "UNRESOLVED (no clean auto-match candidate)",
    expected_amount: formatRupees(rr.expected_amount_paise),
    actual_amount: formatRupees(rr.actual_amount_paise),
    difference: formatRupees(rr.difference_paise),
    confidence_score: rr.confidence_score,
    recommendation: rr.recommendation,
    deterministic_reason: rr.reason,
    ai_explanation_status: rr.ai_explanation_status,
    ai_explanation: rr.ai_explanation,
  };
}

async function get_exceptions_by_type() {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("reconciliation_results")
    .select("issue_type, orders(amount_paise)")
    .in("status", ["EXCEPTION", "REVIEW_NEEDED"]);
  if (error) throw new Error(error.message);

  const groups = new Map<string, { count: number; valuePaise: number }>();
  for (const row of data as unknown as { issue_type: IssueType | null; orders: { amount_paise: number } | null }[]) {
    const key = row.issue_type ?? "UNRESOLVED";
    const g = groups.get(key) ?? { count: 0, valuePaise: 0 };
    g.count += 1;
    g.valuePaise += row.orders?.amount_paise ?? 0;
    groups.set(key, g);
  }

  return {
    breakdown: Array.from(groups.entries())
      .map(([issue_type, g]) => ({ issue_type, count: g.count, total_value: formatRupees(g.valuePaise) }))
      .sort((a, b) => b.count - a.count),
  };
}

async function get_ai_explanation_progress() {
  const supabase = createServiceClient();
  const [{ count: completed }, { count: exception }, { count: reviewNeeded }] = await Promise.all([
    supabase.from("reconciliation_results").select("*", { count: "exact", head: true }).eq("ai_explanation_status", "COMPLETED"),
    supabase.from("reconciliation_results").select("*", { count: "exact", head: true }).eq("status", "EXCEPTION"),
    supabase.from("reconciliation_results").select("*", { count: "exact", head: true }).eq("status", "REVIEW_NEEDED"),
  ]);
  const candidates = (exception ?? 0) + (reviewNeeded ?? 0);
  const completedN = completed ?? 0;
  return {
    completed: completedN,
    candidates,
    percent_complete: candidates > 0 ? Number(((completedN / candidates) * 100).toFixed(1)) : 0,
  };
}

const IMPLEMENTATIONS: Record<ToolName, (args: never) => Promise<unknown>> = {
  get_summary_stats: get_summary_stats as (args: never) => Promise<unknown>,
  get_largest_exceptions: get_largest_exceptions as unknown as (args: never) => Promise<unknown>,
  get_exception_by_order: get_exception_by_order as unknown as (args: never) => Promise<unknown>,
  get_exceptions_by_type: get_exceptions_by_type as (args: never) => Promise<unknown>,
  get_ai_explanation_progress: get_ai_explanation_progress as (args: never) => Promise<unknown>,
};

export async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const impl = IMPLEMENTATIONS[name as ToolName];
  if (!impl) throw new Error(`Unknown tool: ${name}`);
  return impl(args as never);
}
