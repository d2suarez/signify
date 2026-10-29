"use client";

import { useEffect, useState } from "react";
import type { Dict } from "@/lib/i18n";
import type { WritingEvent, WritingSummary } from "@/lib/writing";

/**
 * How a student's work was written, for the teacher: plain facts, a replay of
 * the snapshots and every paste. Evidence to talk about with the student,
 * never a verdict — there is deliberately no score here.
 */
export default function WritingReplay({ assignmentId, studentId, d }: { assignmentId: string; studentId: string; d: Dict }) {
  const [data, setData] = useState<{ events: WritingEvent[]; summary: WritingSummary } | null>(null);
  const [failed, setFailed] = useState(false);
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    let gone = false;
    setData(null); setFailed(false); setAt(0); setPlaying(false);
    fetch(`/api/assignments/${assignmentId}/writing?student=${encodeURIComponent(studentId)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((body) => { if (!gone) { setData(body); setAt(Math.max(0, body.events.filter((e: WritingEvent) => e.kind === "snapshot").length - 1)); } })
      .catch(() => { if (!gone) setFailed(true); });
    return () => { gone = true; };
  }, [assignmentId, studentId]);

  const snaps = data?.events.filter((e) => e.kind === "snapshot") ?? [];
  const pastes = data?.events.filter((e) => e.kind === "paste") ?? [];

  useEffect(() => {
    if (!playing) return;
    if (at >= snaps.length - 1) { setPlaying(false); return; }
    const id = setTimeout(() => setAt((n) => n + 1), 700);
    return () => clearTimeout(id);
  }, [playing, at, snaps.length]);

  if (failed) return <p className="notice" role="alert">{d.writingFailed}</p>;
  if (!data) return <p className="muted">{d.loading}</p>;
  if (!data.events.length) return <p className="empty">{d.writingNone}</p>;

  const s = data.summary;
  const snap = snaps[at];
  const time = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
  // Pastes that happened up to the snapshot on screen.
  const pastesSoFar = snap ? pastes.filter((p) => p.at <= snap.at).length : 0;

  return (
    <div className="stack" style={{ gap: 12 }}>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.writingEvidenceNote}</p>
      <dl className="facts-grid">
        <div><dt>{d.writingSpan}</dt><dd>{s.firstAt && s.lastAt ? `${time(s.firstAt)} – ${time(s.lastAt)}` : "—"}</dd></div>
        <div><dt>{d.writingSessions}</dt><dd>{s.sessions}</dd></div>
        <div><dt>{d.writingActive}</dt><dd>{s.activeMinutes} min</dd></div>
        <div><dt>{d.writingPastes}</dt><dd>{s.pastes}{s.pastes ? ` · ${s.pastedChars} ${d.chars}` : ""}</dd></div>
      </dl>

      {snaps.length > 0 && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row">
            <button type="button" className="btn btn-sm" onClick={() => { if (at >= snaps.length - 1) setAt(0); setPlaying((p) => !p); }}>
              {playing ? d.pause : d.writingPlay}
            </button>
            <label htmlFor="replay-at" className="grow" style={{ fontSize: 13 }}>
              {d.writingSnapshot} {at + 1} {d.of} {snaps.length} · <time>{snap ? time(snap.at) : ""}</time> · {snap?.chars ?? 0} {d.chars}
              {pastesSoFar > 0 ? ` · ${d.writingPastesSoFar}: ${pastesSoFar}` : ""}
            </label>
          </div>
          <input id="replay-at" type="range" min={0} max={Math.max(0, snaps.length - 1)} value={at} style={{ width: "100%", minHeight: 44 }}
            onChange={(e) => { setPlaying(false); setAt(Number(e.target.value)); }} />
          <div className="work-text replay-text" aria-live="off">{snap?.body || <span className="empty">{d.noWork}</span>}</div>
        </div>
      )}

      {pastes.length > 0 && (
        <div>
          <p className="label">{d.writingPasteList}</p>
          <ul className="list">
            {pastes.map((p, k) => (
              <li key={k} style={{ padding: "8px 0", display: "block" }}>
                <details>
                  <summary style={{ cursor: "pointer", minHeight: 32 }}><time>{time(p.at)}</time> · {p.chars} {d.chars}</summary>
                  <div className="work-text" style={{ marginTop: 6, maxHeight: 240 }}>{p.body}{p.body.length < p.chars ? " …" : ""}</div>
                </details>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
