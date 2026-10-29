"use client";

import { useState } from "react";
import type { Dict } from "@/lib/i18n";

export type ByQuestionItem = {
  identifier: string; prompt: string; points: number; kind: string;
  rows: { attemptId: string; student: string; number: number; counts: boolean; yours: string; score: number | null }[];
};

/** Grading one essay (or keyless short answer) for the whole class, answer after answer. */
export default function QuizByQuestion({ assignmentId, items, d }: { assignmentId: string; items: ByQuestionItem[]; d: Dict }) {
  const [k, setK] = useState(0);
  const item = items[Math.min(k, items.length - 1)];
  return (
    <div className="stack" style={{ gap: 10 }}>
      {items.length > 1 && (
        <div className="fieldset" style={{ marginTop: 0 }}>
          <label htmlFor="qbq-pick">{d.quizQuestion}</label>
          <select id="qbq-pick" className="field" value={k} onChange={(e) => setK(Number(e.target.value))}>
            {items.map((i, j) => <option key={i.identifier} value={j}>{j + 1}. {i.prompt.slice(0, 80) || "—"} · {i.rows.filter((r) => r.score === null).length} {d.quizToScore}</option>)}
          </select>
        </div>
      )}
      <p style={{ margin: 0, whiteSpace: "pre-wrap", fontWeight: 600 }}>{item.prompt}</p>
      {item.rows.length === 0 ? <p className="empty">{d.quizNobodyYet}</p> : (
        <ul className="list">
          {item.rows.map((r) => <Row key={`${item.identifier}-${r.attemptId}`} assignmentId={assignmentId} item={item} row={r} d={d} />)}
        </ul>
      )}
    </div>
  );
}

function Row({ assignmentId, item, row, d }: { assignmentId: string; item: ByQuestionItem; row: ByQuestionItem["rows"][number]; d: Dict }) {
  const [value, setValue] = useState(row.score === null ? "" : String(row.score));
  const [saved, setSaved] = useState(row.score);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const id = `bq-${row.attemptId}-${item.identifier}`;
  const save = async () => {
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/assignments/${assignmentId}/quiz/score`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ attemptId: row.attemptId, itemId: item.identifier, score: value.trim() === "" ? null : value }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) { setError(out.error === "roster" ? d.rosterFailed : d.badScore); return; }
      setSaved(out.attempt.scores[item.identifier]?.score ?? null);
    } catch {
      setError(d.saveError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li style={{ display: "block" }}>
      <div className="row">
        <b className="grow">{row.student}</b>
        <span className="muted" style={{ fontSize: 13 }}>{d.quizAttempt} {row.number}{row.counts ? ` · ${d.quizCounts}` : ""}</span>
        {saved === null ? <span className="chip chip-late">{d.quizNeedsScore}</span> : <span className="chip chip-done">{saved} / {item.points}</span>}
      </div>
      <div className={item.kind === "essay" ? "work-text" : ""} style={{ margin: "6px 0" }}>{row.yours}</div>
      <form className="row" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); save(); }}>
        <label htmlFor={id} style={{ fontSize: 14 }}>{d.score}</label>
        <input id={id} className="field score-input" style={{ width: 90 }} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} aria-invalid={!!error} autoComplete="off" />
        <span className="muted" style={{ fontSize: 14 }}>/ {item.points}</span>
        <button type="submit" className="btn btn-sm" disabled={busy}>{d.save}</button>
      </form>
      {error && <p className="notice notice-bad" role="alert" style={{ marginTop: 6 }}>{error}</p>}
    </li>
  );
}
