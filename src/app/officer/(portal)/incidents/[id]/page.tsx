"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2, ClipboardList, Send, UserCheck, XCircle } from "lucide-react";
import { RiskChip } from "@/components/RiskChip";

interface AnalysisView {
  id: string;
  riskLevel: string;
  score: number | null;
  deterministicScore: number | null;
  confidence: number | null;
  summary: string | null;
  modelVersion: string | null;
  ruleVersion: string | null;
  completedAt: string | null;
  evidence: { type: string; severity: string; description: string }[] | null;
  safeNextSteps: string[] | null;
  limitations: string[] | null;
  providerResults: Record<string, unknown> | null;
  indicators: { id: string; type: string; severity: string; description: string }[];
}

interface IncidentView {
  id: string;
  status: string;
  origin: string;
  reason: string;
  autoReason: string | null;
  createdAt: string;
  updatedAt: string;
  user: { id: string; name: string; email: string; phone: string | null } | null;
  conversation: {
    id: string;
    source: string;
    externalSenderId: string | null;
    title: string;
    status: string;
    messages: { id: string; sender: string; content: string; createdAt: string }[];
    extractedUrls: { id: string; rawUrl: string; host: string | null }[];
    analysisResults: AnalysisView[];
  } | null;
  transactionCheck: {
    id: string;
    amount: number;
    currency: string;
    txnType: string;
    receiverName: string | null;
    receiverRef: string | null;
    merchant: string | null;
    description: string | null;
    occurredAt: string | null;
    status: string;
    riskLevel: string;
    score: number | null;
    deterministicScore: number | null;
    confidence: number | null;
    summary: string | null;
    modelVersion: string | null;
    ruleVersion: string | null;
    completedAt: string | null;
    evidence: { type: string; severity: string; description: string }[] | null;
    safeNextSteps: string[] | null;
    limitations: string[] | null;
    providerResults: Record<string, unknown> | null;
  } | null;
  notes: { id: string; note: string; createdAt: string; officer: { name: string } }[];
  assignments: { officer: { id: string; name: string; email: string } }[];
}

interface OfficerLite {
  id: string;
  name: string;
  email: string;
}

export default function IncidentWorkspacePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [incident, setIncident] = useState<IncidentView | null>(null);
  const [officers, setOfficers] = useState<OfficerLite[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [note, setNote] = useState("");
  const [assignTo, setAssignTo] = useState("");
  const [statusReason, setStatusReason] = useState("");
  const [busy, setBusy] = useState(false);

  const fetchAll = useCallback(async () => {
    const [incidentResponse, officerResponse] = await Promise.all([
      fetch(`/api/officer/incidents/${params.id}`),
      fetch("/api/officer/officers"),
    ]);
    const incidentData = await incidentResponse.json();
    if (incidentData.error) {
      throw new Error(incidentData.error);
    }
    const officerData = await officerResponse.json();
    return {
      incident: incidentData.incident as IncidentView,
      officers: officerData.error ? [] : (officerData.officers as OfficerLite[]),
    };
  }, [params.id]);

  useEffect(() => {
    let cancelled = false;
    fetchAll()
      .then((result) => {
        if (cancelled) return;
        setIncident(result.incident);
        setOfficers(result.officers);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load the case");
      });
    return () => {
      cancelled = true;
    };
  }, [fetchAll]);

  async function reload() {
    setError(null);
    try {
      const result = await fetchAll();
      setIncident(result.incident);
      setOfficers(result.officers);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load the case");
    }
  }

  async function post(path: string, body: Record<string, unknown>) {
    setBusy(true);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Request failed");
      }
      await reload();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  function addNote() {
    if (!note.trim()) return;
    post(`/api/officer/incidents/${params.id}/notes`, { note }).then(() => setNote(""));
  }

  function assign() {
    if (!assignTo) return;
    post(`/api/officer/incidents/${params.id}/assign`, { officerId: assignTo }).then(() => setAssignTo(""));
  }

  function setStatus(status: string) {
    const body: Record<string, unknown> = { status };
    if (status === "RESOLVED" || status === "FALSE_POSITIVE") {
      if (!statusReason.trim()) {
        setError(`A reason is required to mark this case ${status.replace("_", " ").toLowerCase()}.`);
        return;
      }
      body.reason = statusReason.trim();
    }
    post(`/api/officer/incidents/${params.id}/status`, body).then(() => setStatusReason(""));
  }

  if (error && !incident) {
    return (
      <main className="page">
        <p className="error" role="alert">{error}</p>
        <button className="button secondary" onClick={() => router.push("/officer")} type="button">
          <ArrowLeft size={16} aria-hidden="true" /> Back to queue
        </button>
      </main>
    );
  }

  if (!incident) {
    return <main className="page muted">Loading case…</main>;
  }

  const txn = incident.transactionCheck;
  const analysis: AnalysisView | null = incident.conversation?.analysisResults[0] ?? (
    txn
      ? {
          id: txn.id,
          riskLevel: txn.riskLevel,
          score: txn.score,
          deterministicScore: txn.deterministicScore,
          confidence: txn.confidence,
          summary: txn.summary,
          modelVersion: txn.modelVersion,
          ruleVersion: txn.ruleVersion,
          completedAt: txn.completedAt,
          evidence: txn.evidence,
          safeNextSteps: txn.safeNextSteps,
          limitations: txn.limitations,
          providerResults: txn.providerResults,
          indicators: [],
        }
      : null
  );
  const assignee = incident.assignments[0]?.officer;
  const evidence = analysis?.evidence ?? analysis?.indicators ?? [];
  const title = txn
    ? `${txn.currency} ${txn.amount.toLocaleString("en-IN")} · ${txn.txnType}`
    : (incident.conversation?.title ?? incident.id);

  return (
    <main className="page">
      <button className="button secondary" style={{ marginBottom: 16 }} onClick={() => router.push("/officer")} type="button">
        <ArrowLeft size={16} aria-hidden="true" /> Back to queue
      </button>

      <section className="panel panel-pad" style={{ marginBottom: 20 }}>
        <div className="status-line">
          <h1 style={{ margin: 0, fontSize: 22 }}>{title}</h1>
          <RiskChip level={analysis?.riskLevel ?? "UNKNOWN"} />
          <span className="chip">{incident.status}</span>
          <span className="chip">{txn ? "Transaction" : (incident.conversation?.source ?? "—")}</span>
          {assignee && <span className="chip">Assigned: {assignee.name}</span>}
        </div>
        <p className="muted" style={{ marginTop: 10 }}>
          Case {incident.id} · reported {new Date(incident.createdAt).toLocaleString()} · origin {incident.origin}
        </p>
        {incident.autoReason && (
          <p className="muted" style={{ marginTop: 6, fontStyle: "italic" }}>{incident.autoReason}</p>
        )}
      </section>

      <div className="workspace">
        <div className="side-stack">
          {txn ? (
            <section className="card">
              <h3><ClipboardList size={15} style={{ verticalAlign: -2, marginRight: 6 }} aria-hidden="true" /> Transaction</h3>
              <ul className="url-list">
                <li><strong>Amount</strong> <span className="muted">{txn.currency} {txn.amount.toLocaleString("en-IN")}</span></li>
                <li><strong>Type</strong> <span className="muted">{txn.txnType}</span></li>
                {txn.receiverName && <li><strong>Paid to</strong> <span className="muted">{txn.receiverName}</span></li>}
                {txn.receiverRef && <li><strong>Payee ref</strong> <span className="muted">{txn.receiverRef}</span></li>}
                {txn.merchant && <li><strong>Merchant</strong> <span className="muted">{txn.merchant}</span></li>}
                {txn.occurredAt && <li><strong>When</strong> <span className="muted">{new Date(txn.occurredAt).toLocaleString()}</span></li>}
                {txn.description && <li><strong>Note</strong> <span className="muted">{txn.description}</span></li>}
              </ul>
            </section>
          ) : null}
          {incident.conversation ? (
          <section className="card">
            <h3><ClipboardList size={15} style={{ verticalAlign: -2, marginRight: 6 }} aria-hidden="true" /> Conversation</h3>
            <div className="chat">
              {incident.conversation.messages.map((message) => (
                <div className={`bubble ${message.sender === "USER" ? "user" : ""}`} key={message.id}>
                  <div className="meta" style={{ marginBottom: 6 }}>
                    <span className="chip">{message.sender}</span>
                    <span className="muted">{new Date(message.createdAt).toLocaleString()}</span>
                  </div>
                  {message.content}
                </div>
              ))}
            </div>
          </section>
          ) : null}

          {incident.conversation && incident.conversation.extractedUrls.length > 0 && (
            <section className="card">
              <h3>Extracted URLs</h3>
              <ul className="url-list">
                {incident.conversation.extractedUrls.map((url) => (
                  <li key={url.id}>
                    <span className="muted">{url.host ?? "unknown host"}</span>
                    <br />
                    {url.rawUrl}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="card">
            <h3>Internal notes</h3>
            <div className="side-stack" style={{ marginBottom: 12 }}>
              {incident.notes.length === 0 && <p className="muted">No notes yet.</p>}
              {incident.notes.map((item) => (
                <div className="note-item" key={item.id}>
                  <div className="who">
                    <strong>{item.officer.name}</strong>
                    <span>{new Date(item.createdAt).toLocaleString()}</span>
                  </div>
                  {item.note}
                </div>
              ))}
            </div>
            <div className="inline-form">
              <textarea
                className="note-input"
                aria-label="Add an internal note"
                placeholder="Add an internal note (visible to officers only)…"
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
              <button className="button secondary" onClick={addNote} disabled={busy || !note.trim()} type="button">
                <Send size={15} aria-hidden="true" /> Add note
              </button>
            </div>
          </section>
        </div>

        <div className="side-stack">
          {analysis && (
            <section className="card">
              <h3>Analysis</h3>
              <p style={{ fontSize: 15, lineHeight: 1.5, margin: "0 0 12px" }}>{analysis.summary}</p>
              <div className="meta" style={{ marginBottom: 12 }}>
                <span className="chip">Score {analysis.deterministicScore ?? analysis.score ?? "—"}/100</span>
                {analysis.confidence != null && <span className="chip">Confidence {Math.round(analysis.confidence * 100)}%</span>}
              </div>
              <p className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
                {analysis.modelVersion ?? "deterministic"} · rules {analysis.ruleVersion ?? "—"} ·{" "}
                {analysis.completedAt ? `completed ${new Date(analysis.completedAt).toLocaleString()}` : "pending"}
              </p>

              <h3 style={{ marginTop: 16 }}>Evidence</h3>
              {evidence.length === 0 ? (
                <p className="muted">No signals detected.</p>
              ) : (
                <ul className="evidence-list">
                  {evidence.map((item, index) => (
                    <li key={`${item.type}-${index}`}>
                      <span className={`sev sev-${item.severity}`}>{item.severity}</span>
                      {item.description}
                    </li>
                  ))}
                </ul>
              )}

              {analysis.safeNextSteps && analysis.safeNextSteps.length > 0 && (
                <>
                  <h3 style={{ marginTop: 16 }}>Recommended next steps</h3>
                  <ol className="step-list">
                    {analysis.safeNextSteps.map((step, index) => (
                      <li key={index}>{step}</li>
                    ))}
                  </ol>
                </>
              )}

              {analysis.limitations && analysis.limitations.length > 0 && (
                <>
                  <h3 style={{ marginTop: 16 }}>Limitations</h3>
                  <ul className="step-list">
                    {analysis.limitations.map((limitation, index) => (
                      <li key={index}>{limitation}</li>
                    ))}
                  </ul>
                </>
              )}

              {(() => {
                const ai = (analysis.providerResults?.ai ??
                  analysis.providerResults?.deepseek) as
                  | { model?: string; status?: string }
                  | undefined;
                if (!ai) return null;
                return (
                  <p className="muted" style={{ marginTop: 12, fontSize: 12 }}>
                    AI explanation: {ai.model ?? "ai"}
                    {ai.status === "unavailable" &&
                      " (unavailable — deterministic result used)"}
                  </p>
                );
              })()}
            </section>
          )}

          <section className="card">
            <h3><UserCheck size={15} style={{ verticalAlign: -2, marginRight: 6 }} aria-hidden="true" /> Assignment</h3>
            <div className="inline-form">
              <select aria-label="Assign to officer" value={assignTo} onChange={(event) => setAssignTo(event.target.value)}>
                <option value="">{assignee ? `Reassign (currently ${assignee.name})` : "Assign to…"}</option>
                {officers.map((officer) => (
                  <option key={officer.id} value={officer.id}>{officer.name} ({officer.email})</option>
                ))}
              </select>
              <button className="button secondary" onClick={assign} disabled={busy || !assignTo} type="button">
                Assign
              </button>
            </div>
          </section>

          <section className="card">
            <h3>Status</h3>
            <div className="inline-form">
              <div className="status-line">
                <button className="button" onClick={() => setStatus("INVESTIGATING")} disabled={busy} type="button">
                  Investigate
                </button>
                <button className="button secondary" onClick={() => setStatus("RESOLVED")} disabled={busy} type="button">
                  <CheckCircle2 size={15} aria-hidden="true" /> Resolve
                </button>
                <button className="button secondary" onClick={() => setStatus("FALSE_POSITIVE")} disabled={busy} type="button">
                  <XCircle size={15} aria-hidden="true" /> False positive
                </button>
              </div>
              <input
                aria-label="Reason for resolving or marking false positive"
                placeholder="Reason (required to resolve / false positive)…"
                value={statusReason}
                onChange={(event) => setStatusReason(event.target.value)}
              />
            </div>
          </section>

          <section className="card">
            <h3>Reporter</h3>
            {incident.user ? (
              <p className="muted">
                {incident.user.name} · {incident.user.email}
                {incident.user.phone ? ` · ${incident.user.phone}` : ""}
              </p>
            ) : (
              <p className="muted">
                {incident.conversation?.externalSenderId ?? "Anonymous"}
              </p>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
