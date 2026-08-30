import Link from "next/link";
import { notFound } from "next/navigation";
import { getTransactionDetail } from "@/lib/dashboard/queries";
import { Timeline } from "@/components/investigation/Timeline";
import { EvidencePanel } from "@/components/investigation/EvidencePanel";
import { AiExplanationPanel } from "@/components/investigation/AiExplanationPanel";
import { AuditTrail } from "@/components/investigation/AuditTrail";

export const dynamic = "force-dynamic";

export default async function TransactionInvestigationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const detail = await getTransactionDetail(id);
  if (!detail) notFound();

  return (
    <main className="mx-auto max-w-4xl px-6 py-8">
      <Link href="/" className="text-sm hover:underline" style={{ color: "var(--accent)" }}>
        ← Back to overview
      </Link>

      <header className="mb-6 mt-2">
        <h1 className="text-xl font-semibold" style={{ color: "var(--ink-primary)" }}>
          {detail.order.orderNumber}
        </h1>
        <p className="text-sm" style={{ color: "var(--ink-secondary)" }}>
          {detail.order.customerRef} — {detail.order.status}
        </p>
      </header>

      <div className="space-y-4">
        <Timeline detail={detail} />
        <EvidencePanel detail={detail} />
        <AiExplanationPanel detail={detail} />
        <AuditTrail entries={detail.auditLog} />
      </div>
    </main>
  );
}
