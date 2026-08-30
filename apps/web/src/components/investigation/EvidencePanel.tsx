import type { TransactionDetail } from "@/lib/dashboard/queries";
import { formatRupees } from "@/lib/dashboard/format";
import { StatusBadge } from "@/components/StatusBadge";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide" style={{ color: "var(--ink-muted)" }}>
        {label}
      </div>
      <div className="text-sm font-medium" style={{ color: "var(--ink-primary)", fontVariantNumeric: "tabular-nums" }}>
        {value}
      </div>
    </div>
  );
}

export function EvidencePanel({ detail }: { detail: TransactionDetail }) {
  const r = detail.reconciliation;
  return (
    <div className="rounded-lg border p-4" style={{ background: "var(--surface-card)", borderColor: "var(--border)" }}>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-medium" style={{ color: "var(--ink-primary)" }}>
          Evidence
        </div>
        <StatusBadge status={r.status} />
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Field
          label="Issue type"
          value={r.issueType ? r.issueType.replaceAll("_", " ") : r.status === "RECONCILED" ? "None" : "Unresolved"}
        />
        <Field label="Expected amount" value={formatRupees(r.expectedAmountPaise)} />
        <Field label="Actual amount" value={formatRupees(r.actualAmountPaise)} />
        <Field label="Difference" value={formatRupees(r.differencePaise)} />
        <Field label="Confidence score" value={r.confidenceScore !== null ? `${r.confidenceScore.toFixed(0)}%` : "—"} />
        <Field label="Recommendation" value={r.recommendation ?? "—"} />
      </div>

      <div className="mt-4 border-t pt-4" style={{ borderColor: "var(--gridline)" }}>
        <div className="text-xs uppercase tracking-wide" style={{ color: "var(--ink-muted)" }}>
          Deterministic reason (engine-generated, not AI)
        </div>
        <p className="mt-1 text-sm" style={{ color: "var(--ink-primary)" }}>
          {r.reason ?? "—"}
        </p>
      </div>
    </div>
  );
}
