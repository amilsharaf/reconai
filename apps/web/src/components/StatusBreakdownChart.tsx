import type { Kpis } from "@/lib/dashboard/queries";

const SEGMENTS: { key: keyof Kpis; label: string; color: string }[] = [
  { key: "reconciled", label: "Reconciled", color: "var(--status-good)" },
  { key: "exception", label: "Exception", color: "var(--status-critical)" },
  { key: "reviewNeeded", label: "Review needed", color: "var(--status-warning)" },
  { key: "pending", label: "Pending", color: "var(--status-muted)" },
];

export function StatusBreakdownChart({ kpis }: { kpis: Kpis }) {
  const total = kpis.totalOrders || 1;

  return (
    <div className="rounded-lg border p-4" style={{ background: "var(--surface-card)", borderColor: "var(--border)" }}>
      <div className="mb-3 text-sm font-medium" style={{ color: "var(--ink-primary)" }}>
        Status breakdown
      </div>

      {/* stacked bar */}
      <div className="flex h-8 w-full overflow-hidden rounded-md" style={{ background: "var(--gridline)" }}>
        {SEGMENTS.map((seg) => {
          const count = kpis[seg.key] as number;
          const pct = (count / total) * 100;
          if (pct <= 0) return null;
          return (
            <div
              key={seg.key}
              title={`${seg.label}: ${count.toLocaleString("en-IN")} (${pct.toFixed(1)}%)`}
              style={{ width: `${pct}%`, background: seg.color }}
              className="h-full first:rounded-l-md last:rounded-r-md"
            />
          );
        })}
      </div>

      {/* legend */}
      <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2">
        {SEGMENTS.map((seg) => {
          const count = kpis[seg.key] as number;
          const pct = (count / total) * 100;
          return (
            <div key={seg.key} className="flex items-center gap-2 text-sm">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: seg.color }} />
              <span style={{ color: "var(--ink-secondary)" }}>{seg.label}</span>
              <span className="font-medium" style={{ color: "var(--ink-primary)", fontVariantNumeric: "tabular-nums" }}>
                {count.toLocaleString("en-IN")}
              </span>
              <span style={{ color: "var(--ink-muted)" }}>({pct.toFixed(1)}%)</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
