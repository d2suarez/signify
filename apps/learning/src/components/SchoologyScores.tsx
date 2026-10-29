"use client";

import { useCallback, useEffect, useState } from "react";
import type { Dict, Key } from "@/lib/i18n";

type Row = {
  studentId: string; name: string; contextId: string; status: "pending" | "sent" | "failed" | "skipped";
  score: number | null; attempts: number; error: string; sentAt: string | null;
};
type Placement = { contextId: string; title: string; lineitem: boolean };

/** One row's state in words (never colour alone). */
export function statusText(r: Pick<Row, "status" | "attempts" | "error">, d: Dict): string {
  if (r.status === "sent") return d.ltiScoreSent;
  if (r.status === "skipped") return d[`ltiScoreSkip_${r.error}` as Key] ?? d.ltiScoreSkip_ungraded;
  const why = r.error ? ` · ${d[`ltiErr_${r.error.split(" ")[0]}` as Key] ?? d.ltiErr_other}` : "";
  if (r.status === "failed") return `${d.ltiScoreFailed}${why}`;
  return r.attempts > 0 ? `${d.ltiScoreRetrying}${why}` : d.ltiScorePending;
}

/**
 * How grades of a Schoology-placed assignment are getting there: the whole
 * class on the assignment page, or one student on the grading screen
 * (`studentId`, refreshed after each save through `refresh`).
 */
export default function SchoologyScores({ assignmentId, studentId, refresh = 0, d }: {
  assignmentId: string; studentId?: string; refresh?: number; d: Dict;
}) {
  const [data, setData] = useState<{ placements: Placement[]; scores: Row[] } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const q = new URLSearchParams({ assignmentId, ...(studentId ? { studentId } : {}) });
    const res = await fetch(`/api/lti/scores?${q}`, { cache: "no-store" }).catch(() => null);
    if (res?.ok) setData(await res.json());
  }, [assignmentId, studentId]);

  useEffect(() => {
    load();
    // A save sends in the background: look again shortly after.
    const t = setTimeout(load, 4000);
    return () => clearTimeout(t);
  }, [load, refresh]);

  const retry = async () => {
    setBusy(true);
    await fetch("/api/lti/scores", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ assignmentId, ...(studentId ? { studentId } : {}) }),
    }).catch(() => null);
    setTimeout(() => { load(); setBusy(false); }, 2500);
  };

  if (!data || data.placements.length === 0) return null;
  const notSent = data.scores.some((r) => r.status === "failed" || (r.status === "pending" && r.attempts > 0));

  if (studentId) {
    const r = data.scores[0];
    return (
      <p className="muted" role="status" style={{ fontSize: 13, margin: "8px 0 0" }}>
        {d.ltiScoreState}: {r ? statusText(r, d) : d.ltiScoreNone}
        {notSent && <> <button type="button" className="btn btn-sm" disabled={busy} onClick={retry}>{d.ltiScoreRetry}</button></>}
      </p>
    );
  }
  return (
    <section className="card stack" aria-labelledby="sgy-title">
      <h2 id="sgy-title" style={{ fontSize: 20, margin: 0 }}>{d.ltiScoresTitle}</h2>
      <p className="muted" style={{ margin: 0 }}>
        {d.ltiPlacedIn}: {data.placements.map((p) => p.title || p.contextId).join(", ")}. {d.ltiScoresHint}
      </p>
      {data.scores.length === 0 ? <p className="empty">{d.ltiScoreNone}</p> : (
        <ul className="list" style={{ fontSize: 14 }}>
          {data.scores.map((r) => (
            <li key={`${r.studentId} ${r.contextId}`} style={{ padding: "8px 0" }}>
              <span className="grow">{r.name || r.studentId}</span>
              <span>{statusText(r, d)}{r.sentAt && r.status === "sent" ? <> · <time suppressHydrationWarning>{new Date(r.sentAt).toLocaleString()}</time></> : null}</span>
            </li>
          ))}
        </ul>
      )}
      {notSent && <div><button type="button" className="btn" disabled={busy} onClick={retry}>{d.ltiScoreRetryAll}</button></div>}
    </section>
  );
}
