import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ReportConversationForm } from "@/components/ReportConversationForm";
import { AnalysisCard } from "@/components/AnalysisCard";
import { RiskChip } from "@/components/RiskChip";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type Props = {
  params: Promise<{ id: string }>;
};

export default async function ConversationPage({ params }: Props) {
  const session = await getSession();

  if (!session) {
    redirect("/login");
  }

  const { id } = await params;
  const conversation = await prisma.conversation.findFirst({
    where: { id, userId: session.userId },
    include: {
      messages: { orderBy: { createdAt: "asc" } },
      extractedUrls: true,
      analysisResults: {
        orderBy: { createdAt: "desc" },
        take: 1,
        include: { indicators: true },
      },
      incidentReports: { orderBy: { createdAt: "desc" } },
    },
  });

  if (!conversation) {
    notFound();
  }

  const latestAnalysis = conversation.analysisResults[0];
  const openReport = conversation.incidentReports.find(
    (report) => report.status === "PENDING" || report.status === "INVESTIGATING"
  );

  const analysisSummary = latestAnalysis
    ? {
        id: latestAnalysis.id,
        status: latestAnalysis.status,
        riskLevel: latestAnalysis.riskLevel,
        score: latestAnalysis.score,
        confidence: latestAnalysis.confidence,
        summary: latestAnalysis.summary,
        evidence: (latestAnalysis.indicators.length > 0
          ? latestAnalysis.indicators.map((indicator) => ({
              type: indicator.type,
              severity: indicator.severity,
              description: indicator.description,
            }))
          : (latestAnalysis.evidence as
              | { type: string; severity: string; description: string }[]
              | null)) ?? null,
        safeNextSteps: latestAnalysis.safeNextSteps as string[] | null,
        limitations: latestAnalysis.limitations as string[] | null,
        modelVersion: latestAnalysis.modelVersion,
        ruleVersion: latestAnalysis.ruleVersion,
        completedAt: latestAnalysis.completedAt?.toISOString() ?? null,
      }
    : null;

  return (
    <main className="page">
      <section className="page-head">
        <div>
          <h1>{conversation.title}</h1>
          <div className="meta">
            <span className="chip">{conversation.source}</span>
            <span className={`chip ${conversation.incidentReports.length ? "reported" : ""}`}>
              {conversation.incidentReports.length ? "REPORTED" : conversation.status}
            </span>
            <span className="chip">{conversation.extractedUrls.length} URLs</span>
            {latestAnalysis && (
              <RiskChip level={latestAnalysis.riskLevel} />
            )}
          </div>
        </div>
        <Link className="button secondary" href="/dashboard">
          Back
        </Link>
      </section>

      <section className="split">
        <div className="panel panel-pad">
          <h2>Conversation</h2>
          <div className="chat">
            {conversation.messages.map((message) => (
              <div
                className={`bubble ${message.sender === "USER" ? "user" : ""}`}
                key={message.id}
              >
                <div className="meta" style={{ marginBottom: 6 }}>
                  <span className="chip">{message.sender}</span>
                  <span className="muted">{message.createdAt.toLocaleString()}</span>
                </div>
                {message.content}
              </div>
            ))}
          </div>
        </div>

        <aside className="side-stack">
          {analysisSummary ? (
            <AnalysisCard analysis={analysisSummary} />
          ) : (
            <div className="panel panel-pad">
              <h2>Risk Summary</h2>
              <p className="muted">Analysis is queued for this conversation.</p>
            </div>
          )}

          <div className="panel panel-pad">
            <h2>Extracted URLs</h2>
            {conversation.extractedUrls.length ? (
              <ul className="url-list">
                {conversation.extractedUrls.map((url) => (
                  <li key={url.id}>
                    <span className="muted">{url.host ?? "unknown host"}</span>
                    <br />
                    {url.normalizedUrl}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">No URLs found in this conversation.</p>
            )}
          </div>

          <div className="panel panel-pad">
            <h2>Authority Escalation</h2>
            {openReport ? (
              <p className="muted">
                This conversation has an open report (status {openReport.status}). An
                officer is reviewing it — no further action is needed from you.
              </p>
            ) : (
              <>
                <p className="muted">Your report will be assigned to the NEXUS Authority team.</p>
                <ReportConversationForm
                  conversationId={conversation.id}
                  alreadyReported={conversation.incidentReports.length > 0}
                />
              </>
            )}
          </div>
        </aside>
      </section>
    </main>
  );
}
