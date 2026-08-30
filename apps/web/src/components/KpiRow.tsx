import type { Kpis } from "@/lib/dashboard/queries";
import { formatRupees } from "@/lib/dashboard/format";

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div
      className="flex-1 min-w-[150px] rounded-lg border p-4"
      style={{ background: "var(--surface-card)", borderColor: "var(--border)" }}
    >
      <div className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--ink-muted)" }}>
        {label}
      </div>
      <div className="mt-1.5 text-2xl font-semibold" style={{ color: "var(--ink-primary)", fontVariantNumeric: "tabular-nums" }}>
        {value}
      </div>
      {sub && (
        <div className="mt-0.5 text-xs" style={{ color: "var(--ink-secondary)" }}>
          {sub}
        </div>
      )}
    </div>
  );
}

export function KpiRow({ kpis }: { kpis: Kpis }) {
  return (
    <div className="flex flex-wrap gap-3">
      <Tile label="Total transactions" value={kpis.totalOrders.toLocaleString("en-IN")} />
      <Tile label="Reconciled" value={kpis.reconciled.toLocaleString("en-IN")} sub={`${kpis.matchRatePct.toFixed(1)}% match rate`} />
      <Tile label="Exceptions" value={kpis.exception.toLocaleString("en-IN")} />
      <Tile label="Review needed" value={kpis.reviewNeeded.toLocaleString("en-IN")} />
      <Tile label="Value reconciled" value={formatRupees(kpis.valueReconciledPaise)} />
      <Tile label="Value at risk" value={formatRupees(kpis.valueAtRiskPaise)} />
      <Tile
        label="AI explanations"
        value={`${kpis.aiExplanationCompleted}/${kpis.aiExplanationCandidates}`}
        sub="generated so far"
      />
    </div>
  );
}
