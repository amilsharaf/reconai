"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { ExceptionRow } from "@/lib/dashboard/queries";
import { formatRupees } from "@/lib/dashboard/format";
import { StatusBadge } from "@/components/StatusBadge";

type SortKey = "amount" | "confidence";
type SortDir = "asc" | "desc";

const ISSUE_TYPES = ["FEE_MISMATCH", "MISSING_SETTLEMENT", "AMOUNT_MISMATCH", "DUPLICATE", "REFUND", "TIMING"] as const;

export function ExceptionsTable({ rows }: { rows: ExceptionRow[] }) {
  const [issueFilter, setIssueFilter] = useState<string>("ALL");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [sortKey, setSortKey] = useState<SortKey>("confidence");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      const issueKey = r.issueType ?? "UNRESOLVED";
      if (issueFilter !== "ALL" && issueKey !== issueFilter) return false;
      if (statusFilter !== "ALL" && r.status !== statusFilter) return false;
      return true;
    });
  }, [rows, issueFilter, statusFilter]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => {
      const av = sortKey === "amount" ? a.amountPaise : (a.confidenceScore ?? -1);
      const bv = sortKey === "amount" ? b.amountPaise : (b.confidenceScore ?? -1);
      return sortDir === "asc" ? av - bv : bv - av;
    });
    return copy;
  }, [filtered, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const sortArrow = (key: SortKey) => (sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "");

  return (
    <div className="rounded-lg border" style={{ background: "var(--surface-card)", borderColor: "var(--border)" }}>
      <div className="flex flex-wrap items-center gap-3 border-b p-4" style={{ borderColor: "var(--border)" }}>
        <div className="text-sm font-medium" style={{ color: "var(--ink-primary)" }}>
          Exceptions &amp; reviews ({sorted.length})
        </div>
        <div className="ml-auto flex gap-2">
          <select
            value={issueFilter}
            onChange={(e) => setIssueFilter(e.target.value)}
            className="rounded-md border px-2 py-1.5 text-sm"
            style={{ borderColor: "var(--border)", color: "var(--ink-primary)" }}
          >
            <option value="ALL">All issue types</option>
            {ISSUE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replaceAll("_", " ")}
              </option>
            ))}
            <option value="UNRESOLVED">Unresolved</option>
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-md border px-2 py-1.5 text-sm"
            style={{ borderColor: "var(--border)", color: "var(--ink-primary)" }}
          >
            <option value="ALL">All statuses</option>
            <option value="EXCEPTION">Exception</option>
            <option value="REVIEW_NEEDED">Review needed</option>
          </select>
        </div>
      </div>

      <div className="max-h-[600px] overflow-y-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0" style={{ background: "var(--surface-card)" }}>
          <tr style={{ color: "var(--ink-muted)" }} className="text-left text-xs uppercase tracking-wide">
            <th className="px-4 py-2 font-medium">Order</th>
            <th className="px-4 py-2 font-medium">Issue type</th>
            <th className="px-4 py-2 font-medium cursor-pointer select-none" onClick={() => toggleSort("amount")}>
              Amount{sortArrow("amount")}
            </th>
            <th className="px-4 py-2 font-medium cursor-pointer select-none" onClick={() => toggleSort("confidence")}>
              Confidence{sortArrow("confidence")}
            </th>
            <th className="px-4 py-2 font-medium">Recommendation</th>
            <th className="px-4 py-2 font-medium">AI explanation</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr
              key={row.id}
              className="border-t"
              style={{ borderColor: "var(--gridline)" }}
            >
              <td className="px-4 py-2.5">
                <Link href={`/transactions/${row.id}`} className="font-medium hover:underline" style={{ color: "var(--accent)" }}>
                  {row.orderNumber}
                </Link>
              </td>
              <td className="px-4 py-2.5" style={{ color: "var(--ink-secondary)" }}>
                {row.issueType ? row.issueType.replaceAll("_", " ") : "Unresolved"}
              </td>
              <td className="px-4 py-2.5" style={{ fontVariantNumeric: "tabular-nums", color: "var(--ink-primary)" }}>
                {formatRupees(row.amountPaise)}
              </td>
              <td className="px-4 py-2.5" style={{ fontVariantNumeric: "tabular-nums", color: "var(--ink-primary)" }}>
                {row.confidenceScore !== null ? `${row.confidenceScore.toFixed(0)}%` : "—"}
              </td>
              <td className="px-4 py-2.5" style={{ color: "var(--ink-secondary)" }}>
                {row.recommendation ?? "—"}
              </td>
              <td className="px-4 py-2.5">
                <StatusBadge status={row.aiExplanationStatus} />
              </td>
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={6} className="px-4 py-8 text-center" style={{ color: "var(--ink-muted)" }}>
                No rows match the current filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      </div>
    </div>
  );
}
