/**
 * ReconAI — AI Explanation Runner
 *
 * For every reconciliation_results row with status IN ('EXCEPTION',
 * 'REVIEW_NEEDED') and ai_explanation_status = 'PENDING', builds a
 * structured evidence object from already-computed fields (never raw table
 * access for the AI itself — this script does the fetching, the model only
 * ever sees the fixed JSON evidence object), calls the Anthropic API
 * (src/lib/ai/explainException.ts), and persists the result through
 * set_ai_explanation_atomic() — the only sanctioned write path, which logs
 * the call (model, outcome, which row) to audit_logs in the same
 * transaction as the write.
 *
 * Re-running is safe: only PENDING rows are picked up, so a completed or
 * explicitly-failed row is never silently overwritten by accident. Pass
 * --retry-failed to also re-attempt rows currently marked FAILED.
 *
 * Usage (from apps/web):
 *   npm run explain
 *   npm run explain -- --retry-failed
 */

import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../../../.env") });

import { createServiceClient } from "../src/lib/supabase/serviceClient";
import { explainException } from "../src/lib/ai/explainException";
import type { ExceptionEvidence } from "../src/lib/ai/types";
import type { IssueType, Recommendation, ReconciliationStatus } from "../src/types/reconciliation";

const CONCURRENCY = 5;

interface CandidateRow {
  id: string;
  order_id: string;
  status: ReconciliationStatus;
  issue_type: IssueType | null;
  expected_amount_paise: number | null;
  actual_amount_paise: number | null;
  confidence_score: number | null;
  recommendation: Recommendation | null;
  reason: string | null;
  orders: { order_number: string } | null;
}

function formatRupees(paise: number | null): string | null {
  if (paise === null) return null;
  return `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function toEvidence(row: CandidateRow): ExceptionEvidence {
  const difference = row.expected_amount_paise !== null && row.actual_amount_paise !== null
    ? row.actual_amount_paise - row.expected_amount_paise
    : null;
  return {
    reconciliation_result_id: row.id,
    order_number: row.orders?.order_number ?? "(unknown)",
    status: row.status as "EXCEPTION" | "REVIEW_NEEDED",
    issue_type: row.issue_type,
    expected_amount_rupees: formatRupees(row.expected_amount_paise),
    actual_amount_rupees: formatRupees(row.actual_amount_paise),
    difference_rupees: formatRupees(difference),
    confidence_score: row.confidence_score,
    recommendation: row.recommendation,
    deterministic_reason: row.reason ?? "(no reason recorded)",
  };
}

async function runWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
}

async function main() {
  const retryFailed = process.argv.includes("--retry-failed");
  const supabase = createServiceClient();

  const statuses = retryFailed ? ["PENDING", "FAILED"] : ["PENDING"];
  console.log(`Fetching EXCEPTION/REVIEW_NEEDED rows with ai_explanation_status IN (${statuses.join(", ")}) ...`);

  const { data, error } = await supabase
    .from("reconciliation_results")
    .select(
      "id, order_id, status, issue_type, expected_amount_paise, actual_amount_paise, confidence_score, recommendation, reason, orders(order_number)",
    )
    .in("status", ["EXCEPTION", "REVIEW_NEEDED"])
    .in("ai_explanation_status", statuses);

  if (error) throw new Error(`Fetching candidate rows failed: ${error.message}`);
  const rows = (data ?? []) as unknown as CandidateRow[];
  console.log(`  ${rows.length} rows to explain.`);

  let completed = 0;
  let failed = 0;

  await runWithConcurrency(rows, CONCURRENCY, async (row) => {
    const evidence = toEvidence(row);
    const result = await explainException(evidence);

    const { error: rpcError } = await supabase.rpc("set_ai_explanation_atomic", {
      p_reconciliation_result_id: row.id,
      p_status: result.status,
      p_ai_explanation: result.status === "COMPLETED" ? result.explanation : null,
      p_model: result.model,
      p_failure_reason: result.status === "FAILED" ? result.reason : null,
      p_actor_id: null,
    });

    if (rpcError) {
      console.error(`  RPC failed for reconciliation_result ${row.id}: ${rpcError.message}`);
      failed++;
      return;
    }

    if (result.status === "COMPLETED") {
      completed++;
    } else {
      failed++;
      console.warn(`  FAILED (${row.issue_type ?? "unresolved"}, order ${evidence.order_number}): ${result.reason}`);
    }
  });

  console.log(`\nCompleted: ${completed}  Failed: ${failed}  Total: ${rows.length}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
