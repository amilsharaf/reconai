import type { TransactionDetail } from "@/lib/dashboard/queries";

export function AiExplanationPanel({ detail }: { detail: TransactionDetail }) {
  const r = detail.reconciliation;

  if (r.status === "RECONCILED") {
    return (
      <div className="rounded-lg border p-4" style={{ background: "var(--surface-card)", borderColor: "var(--border)" }}>
        <div className="mb-1 text-sm font-medium" style={{ color: "var(--ink-primary)" }}>
          AI explanation
        </div>
        <p className="text-sm" style={{ color: "var(--ink-muted)" }}>
          Not applicable — this order reconciled cleanly, there is no exception to explain.
        </p>
      </div>
    );
  }

  return (
    <div
      className="rounded-lg border p-4"
      style={{ background: "var(--accent-bg)", borderColor: "var(--border)" }}
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="text-sm font-medium" style={{ color: "var(--ink-primary)" }}>
          AI explanation
        </span>
        <span
          className="rounded-full px-2 py-0.5 text-[11px] font-medium"
          style={{ background: "var(--surface-card)", color: "var(--accent)" }}
        >
          Gemini-generated — not part of the reconciliation verdict above
        </span>
      </div>

      {r.aiExplanationStatus === "COMPLETED" && r.aiExplanation ? (
        <p className="mt-2 text-sm leading-relaxed" style={{ color: "var(--ink-primary)" }}>
          {r.aiExplanation}
        </p>
      ) : r.aiExplanationStatus === "FAILED" ? (
        <div className="mt-2 flex items-start gap-2 text-sm">
          <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full" style={{ background: "var(--status-critical)" }} />
          <span style={{ color: "var(--ink-primary)" }}>
            Explanation generation failed for this row. See the audit trail below for the recorded failure reason —
            no explanation is shown here rather than guessing.
          </span>
        </div>
      ) : (
        <div className="mt-2 flex items-start gap-2 text-sm">
          <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full" style={{ background: "var(--status-muted)" }} />
          <span style={{ color: "var(--ink-secondary)" }}>
            Explanation not yet generated for this row.
          </span>
        </div>
      )}
    </div>
  );
}
