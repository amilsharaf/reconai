import { getExceptionRows, getKpis } from "@/lib/dashboard/queries";
import { KpiRow } from "@/components/KpiRow";
import { StatusBreakdownChart } from "@/components/StatusBreakdownChart";
import { ExceptionsTable } from "@/components/ExceptionsTable";

export const dynamic = "force-dynamic"; // always read live data, never cache a stale snapshot

export default async function OverviewPage() {
  const [kpis, rows] = await Promise.all([getKpis(), getExceptionRows()]);

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-xl font-semibold" style={{ color: "var(--ink-primary)" }}>
          ReconAI
        </h1>
        <p className="text-sm" style={{ color: "var(--ink-secondary)" }}>
          Multi-source payment reconciliation — overview &amp; exceptions
        </p>
      </header>

      <section className="mb-6">
        <KpiRow kpis={kpis} />
      </section>

      <section className="mb-6">
        <StatusBreakdownChart kpis={kpis} />
      </section>

      <section>
        <ExceptionsTable rows={rows} />
      </section>
    </main>
  );
}
