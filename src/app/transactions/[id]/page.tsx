import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { AnalysisCard } from "@/components/AnalysisCard";
import { ReportTransactionForm } from "@/components/ReportTransactionForm";
import { RiskChip } from "@/components/RiskChip";

type Params = {
  params: Promise<{ id: string }>;
};

export default async function TransactionDetailPage({ params }: Params) {
  const user = await requireUser();
  if (!user) {
    redirect("/login");
  }

  const { id } = await params;
  const check = await prisma.transactionCheck.findFirst({
    where: { id, userId: user.id },
    include: { incidentReports: { orderBy: { createdAt: "desc" }, take: 1 } },
  });

  if (!check) {
    redirect("/dashboard");
  }

  const evidence = (check.evidence as { type: string; severity: string; description: string }[] | null) ?? null;
  const reported = check.incidentReports.length > 0;

  return (
    <main className="page">
      <section className="page-head">
        <div>
          <p className="muted">
            <Link href="/dashboard">Dashboard</Link> / Transaction check
          </p>
          <h1>
            {check.currency} {check.amount.toLocaleString("en-IN")} · {check.txnType}
          </h1>
          <div className="meta" style={{ marginTop: 8 }}>
            <RiskChip level={check.riskLevel} />
            <span className="chip">{check.status}</span>
            {reported ? <span className="chip reported">REPORTED</span> : null}
          </div>
        </div>
      </section>

      <section className="split">
        <div className="card">
          <h3>Transaction details</h3>
          <ul className="url-list">
            <li><strong>Amount</strong> <span className="muted">{check.currency} {check.amount.toLocaleString("en-IN")}</span></li>
            <li><strong>Type</strong> <span className="muted">{check.txnType}</span></li>
            {check.receiverName ? (<li><strong>Paid to</strong> <span className="muted">{check.receiverName}</span></li>) : null}
            {check.receiverRef ? (<li><strong>Payee ref</strong> <span className="muted">{check.receiverRef}</span></li>) : null}
            {check.merchant ? (<li><strong>Merchant</strong> <span className="muted">{check.merchant}</span></li>) : null}
            {check.occurredAt ? (<li><strong>When</strong> <span className="muted">{new Date(check.occurredAt).toLocaleString()}</span></li>) : null}
            {check.description ? (<li><strong>Your note</strong> <span className="muted">{check.description}</span></li>) : null}
          </ul>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <AnalysisCard
            analysis={{
              id: check.id,
              status: check.status,
              riskLevel: check.riskLevel,
              score: check.score,
              confidence: check.confidence,
              summary: check.summary,
              evidence,
              safeNextSteps: (check.safeNextSteps as string[] | null) ?? null,
              limitations: (check.limitations as string[] | null) ?? null,
              modelVersion: check.modelVersion,
              ruleVersion: check.ruleVersion,
              completedAt: check.completedAt?.toISOString() ?? null,
            }}
            retryUrl={`/api/transactions/${check.id}/retry`}
          />
          <div className="panel panel-pad">
            <h2>Escalate to NEXUS Authority</h2>
            <p className="muted">Your report will be assigned to the authority investigation queue.</p>
            <ReportTransactionForm transactionId={check.id} alreadyReported={reported} />
          </div>
        </div>
      </section>
    </main>
  );
}
