"use client";

import { ShieldAlert } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";

export function ReportConversationForm({
  conversationId,
  alreadyReported,
}: {
  conversationId: string;
  alreadyReported: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(formData: FormData) {
    setError("");
    setLoading(true);

    const response = await fetch(`/api/conversations/${conversationId}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reason: String(formData.get("reason") ?? ""),
      }),
    });

    const data = await response.json();
    setLoading(false);

    if (!response.ok) {
      setError(data.error ?? "Could not report conversation");
      return;
    }

    router.refresh();
  }

  if (alreadyReported) {
    return <p className="chip reported">Reported to officer</p>;
  }

  return (
    <form action={submit} className="form">
      <div className="field">
        <label htmlFor="reason">Report reason</label>
        <textarea
          id="reason"
          name="reason"
          required
          minLength={10}
          placeholder="Explain why this conversation should be investigated."
        />
      </div>
      {error ? <p className="error">{error}</p> : null}
      <button className="button danger" type="submit" disabled={loading}>
        <ShieldAlert size={16} aria-hidden="true" />
        {loading ? "Escalating..." : "Escalate to NEXUS Authority"}
      </button>
    </form>
  );
}
