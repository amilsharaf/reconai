/**
 * ReconAI — Reconciliation Engine Runner
 *
 * Fetches orders, payments, settlements, and bank_transactions (never
 * ground_truth_labels), runs the deterministic engine
 * (src/lib/reconciliation/engine.ts) over every order, and persists each
 * verdict through compute_reconciliation_atomic() — the only sanctioned
 * write path for reconciliation_results (see
 * database/migrations/00003_rls_policies.sql).
 *
 * Usage (from apps/web):
 *   npm run reconcile
 */

import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../../../.env") });

import { createServiceClient } from "../src/lib/supabase/serviceClient";
import { reconcileOrder } from "../src/lib/reconciliation/engine";
import type { BankTransaction, Order, Payment, Settlement } from "../src/types/reconciliation";

const PAGE_SIZE = 1000;
const RPC_CONCURRENCY = 20;

async function fetchAll<T>(
  supabase: ReturnType<typeof createServiceClient>,
  table: string,
  columns: string,
): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Fetching ${table} failed: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...(data as T[]));
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
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
  const supabase = createServiceClient();

  console.log("Fetching orders, payments, settlements, bank_transactions ...");
  const [orders, payments, settlements, bankTransactions] = await Promise.all([
    fetchAll<Order>(supabase, "orders", "*"),
    fetchAll<Payment>(supabase, "payments", "*"),
    fetchAll<Settlement>(supabase, "settlements", "*"),
    fetchAll<BankTransaction>(supabase, "bank_transactions", "*"),
  ]);
  console.log(
    `  orders: ${orders.length}, payments: ${payments.length}, settlements: ${settlements.length}, bank_transactions: ${bankTransactions.length}`,
  );

  const paymentsByOrder = new Map<string, Payment[]>();
  for (const p of payments) {
    if (!paymentsByOrder.has(p.order_id)) paymentsByOrder.set(p.order_id, []);
    paymentsByOrder.get(p.order_id)!.push(p);
  }
  const settlementsByPayment = new Map<string, Settlement[]>();
  for (const s of settlements) {
    if (!settlementsByPayment.has(s.payment_id)) settlementsByPayment.set(s.payment_id, []);
    settlementsByPayment.get(s.payment_id)!.push(s);
  }
  const bankTxnsBySettlement = new Map<string, BankTransaction[]>();
  for (const b of bankTransactions) {
    if (!b.matched_settlement_id) continue;
    if (!bankTxnsBySettlement.has(b.matched_settlement_id)) bankTxnsBySettlement.set(b.matched_settlement_id, []);
    bankTxnsBySettlement.get(b.matched_settlement_id)!.push(b);
  }
  // Global pool for the fuzzy-matching pass: every bank credit with no
  // matched_settlement_id at all, anywhere in the dataset.
  const orphanBankTransactions = bankTransactions.filter((b) => !b.matched_settlement_id);
  console.log(`  orphan bank transactions (no matched_settlement_id): ${orphanBankTransactions.length}`);

  console.log(`Running reconciliation engine over ${orders.length} orders ...`);
  const statusCounts: Record<string, number> = {};
  const issueCounts: Record<string, number> = {};
  let failures = 0;

  await runWithConcurrency(orders, RPC_CONCURRENCY, async (order) => {
    const orderPayments = paymentsByOrder.get(order.id) ?? [];
    const relevantSettlements = orderPayments.flatMap((p) => settlementsByPayment.get(p.id) ?? []);
    const relevantBankTxns = relevantSettlements.flatMap((s) => bankTxnsBySettlement.get(s.id) ?? []);

    const verdict = reconcileOrder({
      order,
      payments: orderPayments,
      settlements: relevantSettlements,
      bankTransactions: relevantBankTxns,
      orphanBankTransactions,
    });

    statusCounts[verdict.status] = (statusCounts[verdict.status] ?? 0) + 1;
    if (verdict.issue_type) issueCounts[verdict.issue_type] = (issueCounts[verdict.issue_type] ?? 0) + 1;

    const { error } = await supabase.rpc("compute_reconciliation_atomic", {
      p_order_id: verdict.order_id,
      p_status: verdict.status,
      p_issue_type: verdict.issue_type,
      p_expected_amount_paise: verdict.expected_amount_paise,
      p_actual_amount_paise: verdict.actual_amount_paise,
      p_confidence_score: verdict.confidence_score,
      p_recommendation: verdict.recommendation,
      p_reason: verdict.reason,
      p_payment_id: verdict.payment_id,
      p_settlement_id: verdict.settlement_id,
      p_bank_transaction_id: verdict.bank_transaction_id,
      p_actor_id: null,
    });

    if (error) {
      failures++;
      console.error(`  RPC failed for order ${order.id}: ${error.message}`);
    }
  });

  console.log("\nStatus breakdown:", statusCounts);
  console.log("Issue type breakdown:", issueCounts);
  if (failures > 0) {
    console.error(`\n${failures} order(s) failed to write. See errors above.`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${orders.length} orders written via compute_reconciliation_atomic.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
