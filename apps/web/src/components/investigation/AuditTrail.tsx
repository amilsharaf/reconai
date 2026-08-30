import type { AuditLogEntry } from "@/lib/dashboard/queries";
import { formatDateTime } from "@/lib/dashboard/format";

function summarize(entry: AuditLogEntry): string | null {
  const meta = entry.metadata;
  const parts: string[] = [];
  if (typeof meta.model === "string") parts.push(`model: ${meta.model}`);
  if (typeof meta.failure_reason === "string" && meta.failure_reason) parts.push(`reason: ${meta.failure_reason}`);
  if (typeof meta.source === "string") parts.push(`source: ${meta.source}`);
  return parts.length > 0 ? parts.join("  •  ") : null;
}

export function AuditTrail({ entries }: { entries: AuditLogEntry[] }) {
  return (
    <div className="rounded-lg border p-4" style={{ background: "var(--surface-card)", borderColor: "var(--border)" }}>
      <div className="mb-3 text-sm font-medium" style={{ color: "var(--ink-primary)" }}>
        Audit trail ({entries.length} event{entries.length === 1 ? "" : "s"})
      </div>
      {entries.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--ink-muted)" }}>
          No audit_logs entries for this row yet.
        </p>
      ) : (
        <ol className="space-y-3">
          {entries.map((entry) => {
            const summary = summarize(entry);
            const isFailure = entry.action.includes("FAILED");
            return (
              <li key={entry.id} className="border-l-2 pl-3" style={{ borderColor: isFailure ? "var(--status-critical)" : "var(--status-good)" }}>
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono text-xs font-medium" style={{ color: "var(--ink-primary)" }}>
                    {entry.action}
                  </span>
                  <span className="text-xs" style={{ color: "var(--ink-muted)" }}>
                    {formatDateTime(entry.createdAt)}
                  </span>
                  <span className="text-xs" style={{ color: "var(--ink-muted)" }}>
                    actor: {entry.actorId ?? "system"}
                  </span>
                </div>
                {summary && (
                  <div className="mt-0.5 text-xs" style={{ color: "var(--ink-secondary)" }}>
                    {summary}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
