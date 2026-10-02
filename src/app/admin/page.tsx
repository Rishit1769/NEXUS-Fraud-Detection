"use client";

import { useEffect, useState } from "react";
import { Activity, AlertTriangle, ClipboardList, Users } from "lucide-react";

interface OverviewStats {
  officers: number;
  users: number;
  conversations: number;
  incidentsByStatus: { status: string; _count: { _all: number } }[];
  pendingHighRisk: number;
  unreadNotifications: number;
  auditEntries: number;
  failedJobs: number;
}

interface AuditRow {
  id: string;
  actorType: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: unknown;
  createdAt: string;
}

interface OfficerRow {
  id: string;
  name: string;
  email: string;
  role: string;
}

interface AiSettings {
  provider: string;
  baseUrl: string;
  model: string;
  apiKeyConfigured: boolean;
}

export default function AdminPage() {
  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [logs, setLogs] = useState<AuditRow[]>([]);
  const [officers, setOfficers] = useState<OfficerRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ai, setAi] = useState<AiSettings | null>(null);
  const [aiForm, setAiForm] = useState({ provider: "opencode", baseUrl: "", model: "", apiKey: "" });
  const [aiMessage, setAiMessage] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch("/api/admin/overview").then((response) => response.json()),
      fetch("/api/officer/audit-log?pageSize=40").then((response) => response.json()),
      fetch("/api/officer/officers").then((response) => response.json()),
      fetch("/api/admin/ai-settings").then((response) => response.json()),
    ])
      .then(([overview, audit, directory, aiSettings]) => {
        if (overview.error) throw new Error(overview.error);
        setStats(overview.stats);
        setLogs(audit.logs ?? []);
        setOfficers(directory.officers ?? []);
        if (!aiSettings.error) {
          setAi(aiSettings.settings);
          setAiForm({
            provider: aiSettings.settings.provider,
            baseUrl: aiSettings.settings.baseUrl,
            model: aiSettings.settings.model,
            apiKey: "",
          });
        }
      })
      .catch((requestError) =>
        setError(requestError instanceof Error ? requestError.message : "Could not load admin data")
      );
  }, []);

  async function saveAiSettings(event: React.FormEvent) {
    event.preventDefault();
    setAiBusy(true);
    setAiMessage(null);
    try {
      const response = await fetch("/api/admin/ai-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: aiForm.provider,
          baseUrl: aiForm.baseUrl || undefined,
          model: aiForm.model || undefined,
          apiKey: aiForm.apiKey || undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not save AI settings");
      setAi(data.settings);
      setAiForm((form) => ({ ...form, apiKey: "" }));
      setAiMessage("AI provider updated. New analyses will use it.");
    } catch (requestError) {
      setAiMessage(requestError instanceof Error ? requestError.message : "Could not save AI settings");
    } finally {
      setAiBusy(false);
    }
  }

  if (error) {
    return (
      <main className="page">
        <p className="error" role="alert">{error}</p>
      </main>
    );
  }

  return (
    <main className="page">
      <section className="page-head">
        <div>
          <h1>System overview</h1>
          <p className="muted">Operational health, officers, and the security audit trail.</p>
        </div>
      </section>

      <section className="grid" style={{ marginBottom: 24 }}>
        <div className="panel stat">
          <strong>{stats?.conversations ?? "—"}</strong>
          <span className="muted"><ClipboardList size={13} style={{ verticalAlign: -2 }} /> Conversations</span>
        </div>
        <div className="panel stat">
          <strong>{stats?.pendingHighRisk ?? "—"}</strong>
          <span className="muted"><AlertTriangle size={13} style={{ verticalAlign: -2 }} /> Open high/critical cases</span>
        </div>
        <div className="panel stat">
          <strong>{stats?.officers ?? "—"}</strong>
          <span className="muted"><Users size={13} style={{ verticalAlign: -2 }} /> Officers</span>
        </div>
        <div className="panel stat">
          <strong>{stats?.failedJobs ?? "—"}</strong>
          <span className="muted"><Activity size={13} style={{ verticalAlign: -2 }} /> Failed analysis jobs</span>
        </div>
      </section>

      <section className="split" style={{ marginBottom: 24 }}>
        <div className="card">
          <h3>Officers</h3>
          <ul className="url-list">
            {officers.map((officer) => (
              <li key={officer.id}>
                <strong>{officer.name}</strong>{" "}
                <span className="muted">{officer.email}</span>{" "}
                <span className="chip">{officer.role}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="card">
          <h3>Incidents by status</h3>
          <ul className="url-list">
            {(stats?.incidentsByStatus ?? []).map((row) => (
              <li key={row.status}>
                <strong>{row.status}</strong>{" "}
                <span className="muted">{row._count._all} case{row._count._all === 1 ? "" : "s"}</span>
              </li>
            ))}
            {(stats?.incidentsByStatus ?? []).length === 0 && (
              <li className="muted">No incidents recorded yet.</li>
            )}
          </ul>
        </div>
      </section>

      <section className="card" style={{ marginBottom: 24 }}>
        <h3>AI explanation provider</h3>
        <p className="muted" style={{ fontSize: 13 }}>
          Swaps the model that explains analyses (OpenAI-compatible chat API).
          {ai ? ` Currently ${ai.provider}:${ai.model} — key ${ai.apiKeyConfigured ? "set" : "missing"}.` : ""}
          {" "}Deterministic scores are never affected.
        </p>
        <form onSubmit={saveAiSettings} className="form">
          <div className="field-row" style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div className="field" style={{ flex: "1 1 140px" }}>
              <label htmlFor="ai-provider">Provider</label>
              <select
                id="ai-provider"
                value={aiForm.provider}
                onChange={(e) => setAiForm((f) => ({ ...f, provider: e.target.value }))}
              >
                <option value="opencode">OpenCode</option>
                <option value="openai">OpenAI</option>
                <option value="openrouter">OpenRouter</option>
                <option value="custom">Custom endpoint</option>
              </select>
            </div>
            <div className="field" style={{ flex: "2 1 220px" }}>
              <label htmlFor="ai-base">Base URL</label>
              <input
                id="ai-base"
                value={aiForm.baseUrl}
                onChange={(e) => setAiForm((f) => ({ ...f, baseUrl: e.target.value }))}
                placeholder="https://opencode.ai/zen/go/v1"
              />
            </div>
            <div className="field" style={{ flex: "1 1 160px" }}>
              <label htmlFor="ai-model">Model</label>
              <input
                id="ai-model"
                value={aiForm.model}
                onChange={(e) => setAiForm((f) => ({ ...f, model: e.target.value }))}
                placeholder="deepseek-v4.1-flash"
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor="ai-key">API key (leave blank to keep current)</label>
            <input
              id="ai-key"
              type="password"
              value={aiForm.apiKey}
              onChange={(e) => setAiForm((f) => ({ ...f, apiKey: e.target.value }))}
              placeholder={ai?.apiKeyConfigured ? "•••••• (set)" : "sk-..."}
              autoComplete="off"
            />
          </div>
          {aiMessage ? <p className="muted" style={{ fontSize: 13 }}>{aiMessage}</p> : null}
          <button className="button" type="submit" disabled={aiBusy}>
            {aiBusy ? "Saving…" : "Save AI provider"}
          </button>
        </form>
      </section>

      <section className="card">
        <h3>Recent audit log</h3>
        <div className="table-wrap">
          <table className="queue">
            <thead>
              <tr>
                <th>Time</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Target</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id}>
                  <td className="muted">{new Date(log.createdAt).toLocaleString()}</td>
                  <td><span className="chip">{log.actorType}</span></td>
                  <td><code>{log.action}</code></td>
                  <td className="muted">
                    {log.targetType ? `${log.targetType}:${log.targetId ?? ""}`.slice(0, 40) : "—"}
                  </td>
                </tr>
              ))}
              {logs.length === 0 && (
                <tr><td colSpan={4} className="muted">No audit entries yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
