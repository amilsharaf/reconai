import type { TransactionDetail } from "@/lib/dashboard/queries";
import { formatDateTime, formatRupees } from "@/lib/dashboard/format";

function Step({
  title,
  state,
  detail,
}: {
  title: string;
  state: "done" | "missing" | "ambiguous";
  detail: string;
}) {
  const dot =
    state === "done" ? "var(--status-good)" : state === "ambiguous" ? "var(--status-warning)" : "var(--status-critical)";
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <span className="mt-1 h-3 w-3 shrink-0 rounded-full" style={{ background: dot }} />
        <span className="w-px flex-1" style={{ background: "var(--gridline)" }} />
      </div>
      <div className="pb-6">
        <div className="text-sm font-medium" style={{ color: "var(--ink-primary)" }}>
          {title}
        </div>
        <div className="text-sm" style={{ color: "var(--ink-secondary)" }}>
          {detail}
        </div>
      </div>
    </div>
  );
}

export function Timeline({ detail }: { detail: TransactionDetail }) {
  const { order, payment, settlement, bankTransactions, reconciliation } = detail;

  const bankState: "done" | "missing" | "ambiguous" =
    reconciliation.status === "REVIEW_NEEDED" && reconciliation.issueType === null
      ? "ambiguous"
      : bankTransactions.length > 0
        ? "done"
        : "missing";

  const bankDetail =
    bankState === "ambiguous"
      ? "No bank credit could be confidently matched — see reason below."
      : bankState === "missing"
        ? "No bank credit has arrived yet."
        : bankTransactions
            .map((b) => `${formatRupees(b.amountPaise)} on ${b.transactionDate} (${b.bankReference})`)
            .join("  •  ");

  return (
    <div className="rounded-lg border p-4" style={{ background: "var(--surface-card)", borderColor: "var(--border)" }}>
      <div className="mb-3 text-sm font-medium" style={{ color: "var(--ink-primary)" }}>
        Timeline
      </div>
      <Step title="Order created" state="done" detail={`${formatDateTime(order.createdAt)} — ${formatRupees(order.amountPaise)}`} />
      <Step
        title="Payment captured"
        state={payment ? "done" : "missing"}
        detail={payment ? `${formatDateTime(payment.capturedAt)} — ${payment.method}, ${payment.status}` : "No payment record found."}
      />
      <Step
        title="Settlement generated"
        state={settlement ? "done" : "missing"}
        detail={settlement ? `${settlement.settlementDate} — net ${formatRupees(settlement.netAmountPaise)}` : "No settlement has been created yet."}
      />
      <div className="flex gap-3">
        <div className="flex flex-col items-center">
          <span
            className="mt-1 h-3 w-3 shrink-0 rounded-full"
            style={{ background: bankState === "done" ? "var(--status-good)" : bankState === "ambiguous" ? "var(--status-warning)" : "var(--status-critical)" }}
          />
        </div>
        <div>
          <div className="text-sm font-medium" style={{ color: "var(--ink-primary)" }}>
            Bank transaction {bankState === "done" ? `(${bankTransactions.length} credit${bankTransactions.length > 1 ? "s" : ""})` : bankState === "ambiguous" ? "(ambiguous)" : "(missing)"}
          </div>
          <div className="text-sm" style={{ color: "var(--ink-secondary)" }}>
            {bankDetail}
          </div>
        </div>
      </div>
    </div>
  );
}
