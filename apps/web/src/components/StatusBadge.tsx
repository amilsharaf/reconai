interface StatusStyle {
  bg: string;
  fg: string;
  label: string;
  dot: string;
}

const DEFAULT_STYLE: StatusStyle = { bg: "var(--status-muted-bg)", fg: "var(--status-muted)", label: "Pending", dot: "var(--status-muted)" };

const STATUS_STYLE: Record<string, StatusStyle> = {
  RECONCILED: { bg: "var(--status-good-bg)", fg: "var(--status-good)", label: "Reconciled", dot: "var(--status-good)" },
  EXCEPTION: { bg: "var(--status-critical-bg)", fg: "var(--status-critical)", label: "Exception", dot: "var(--status-critical)" },
  REVIEW_NEEDED: { bg: "var(--status-warning-bg)", fg: "#8a5a00", label: "Review Needed", dot: "var(--status-warning)" },
  PENDING: DEFAULT_STYLE,
  COMPLETED: { bg: "var(--status-good-bg)", fg: "var(--status-good)", label: "Completed", dot: "var(--status-good)" },
  FAILED: { bg: "var(--status-critical-bg)", fg: "var(--status-critical)", label: "Failed", dot: "var(--status-critical)" },
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const style = STATUS_STYLE[status] ?? DEFAULT_STYLE;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
      style={{ background: style.bg, color: style.fg }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: style.dot }} />
      {label ?? style.label}
    </span>
  );
}
