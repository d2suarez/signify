"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Dict } from "@/lib/i18n";
import { When } from "./When";

/**
 * The teacher's "Stop accepting work" card (migration 044): now, at a
 * chosen day and time on the school's clock, or open again. The server
 * enforces it on every student write; this only sets it.
 */
export default function AssignmentLock({ assignmentId, closesAt, quiz, d, lang, schoolZone }: {
  assignmentId: string; closesAt: string | null; quiz: boolean; d: Dict; lang: string; schoolZone: string;
}) {
  const router = useRouter();
  const [at, setAt] = useState(closesAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [on, setOn] = useState("");
  const [time, setTime] = useState("15:00");
  const closed = !!at && new Date(at).getTime() <= Date.now();

  const send = async (body: Record<string, unknown>) => {
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/assignments/${assignmentId}/lock`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) { setError(out.error === "date" ? d.lockBadDate : d.lockFailed); return; }
      setAt(out.closesAt ?? null);
      router.refresh();
    } catch {
      setError(d.lockFailed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card stack" style={{ marginTop: 24, gap: 10 }} aria-labelledby="lock-title">
      <h2 id="lock-title" className="label">{d.lockTitle}</h2>
      <p style={{ margin: 0 }} role="status">
        {!at ? d.lockOpen : closed
          ? <><b>{d.lockClosedAt}</b> <When iso={at} lang={lang} /></>
          : <><b>{d.lockClosesAt}</b> <When iso={at} lang={lang} /></>}
      </p>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>{quiz ? d.lockHintQuiz : d.lockHint}</p>
      {error && <p className="notice notice-bad" role="alert" style={{ margin: 0 }}>{error}</p>}
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        {!closed && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => send({ at: "now" })}>{d.lockNow}</button>}
        {at && <button type="button" className="btn" disabled={busy} onClick={() => send({ at: null })}>{d.lockReopen}</button>}
      </div>
      {!closed && (
        <form className="row" style={{ alignItems: "flex-end", flexWrap: "wrap", gap: 8 }}
          onSubmit={(e) => { e.preventDefault(); if (on) send({ on, time }); }}>
          <div className="fieldset" style={{ margin: 0, flex: "1 1 150px" }}>
            <label htmlFor="lock-on">{d.lockOnDay}</label>
            <input id="lock-on" type="date" className="field" required value={on} onChange={(e) => setOn(e.target.value)} />
          </div>
          <div className="fieldset" style={{ margin: 0, flex: "1 1 120px" }}>
            <label htmlFor="lock-time">{d.lockAtTime}</label>
            <input id="lock-time" type="time" className="field" required value={time} onChange={(e) => setTime(e.target.value)} aria-describedby="lock-zone" />
          </div>
          <button className="btn" disabled={busy || !on}>{at ? d.lockChangeTime : d.lockLater}</button>
          <p id="lock-zone" className="muted" style={{ margin: 0, fontSize: 13, flex: "1 1 100%" }}>{d.lockZone.replace("{zone}", schoolZone)}</p>
        </form>
      )}
    </section>
  );
}
