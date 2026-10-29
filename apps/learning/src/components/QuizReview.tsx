"use client";

import { useEffect, useState } from "react";
import type { Dict } from "@/lib/i18n";
import type { Grade } from "@/lib/grades";
import WritingReplay from "./WritingReplay";

type ReviewItem = {
  identifier: string; kind: string; prompt: string; points: number; yours: string; answer: string; hand: boolean;
  score: number | null; by: string; answered: boolean;
};
type ReviewAttempt = {
  id: string; number: number; startedAt: string; deadlineAt: string | null; submittedAt: string | null; autoSubmitted: boolean;
  score: number | null; pending: number; counts: boolean; items: ReviewItem[];
  away: { from: string; to: string | null; seconds: number | null }[];
  pastes: { at: string; item: string | null; chars: number; body: string }[];
};
type SaveOut = { attempt: { score: number | null; pending: number; scores: Record<string, { score: number | null; by: string }> }; grade: Grade | null };

/**
 * One student's quiz attempts on the grading desk: every answer next to the
 * key, a score box per question (essays and short answers with no key wait
 * here for the teacher), and the facts of how the attempt went (time away
 * from the page, pastes into essays), shown like the writing evidence:
 * facts only, never a score or a verdict.
 */
export default function QuizReview({ assignmentId, studentId, points, onGrade, d }: {
  assignmentId: string; studentId: string; points: number; onGrade: (g: Grade | null) => void; d: Dict;
}) {
  const [list, setList] = useState<ReviewAttempt[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [pick, setPick] = useState(0);

  useEffect(() => {
    let gone = false;
    setList(null); setFailed(false);
    fetch(`/api/assignments/${assignmentId}/quiz/score?student=${encodeURIComponent(studentId)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((body) => {
        if (gone) return;
        const all: ReviewAttempt[] = body.attempts;
        setList(all);
        const k = all.findIndex((x) => x.counts);
        setPick(k >= 0 ? k : Math.max(0, all.length - 1));
      })
      .catch(() => { if (!gone) setFailed(true); });
    return () => { gone = true; };
  }, [assignmentId, studentId]);

  if (failed) return <p className="notice" role="alert">{d.quizReviewFailed}</p>;
  if (!list) return <p className="muted">{d.loading}</p>;
  if (!list.length) return <p className="empty">{d.quizNotTaken}</p>;
  const at = list[Math.min(pick, list.length - 1)];
  const time = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
  const secs = (n: number | null) => (n === null ? "—" : n < 60 ? `${n} s` : `${Math.floor(n / 60)} min ${n % 60} s`);

  const saved = (attemptId: string, out: SaveOut) => {
    setList((all) => all && all.map((x) => x.id !== attemptId ? x : {
      ...x, score: out.attempt.score, pending: out.attempt.pending,
      items: x.items.map((i) => ({ ...i, score: out.attempt.scores[i.identifier]?.score ?? null, by: out.attempt.scores[i.identifier]?.by ?? "auto" })),
    }));
    onGrade(out.grade);
  };

  return (
    <div className="stack" style={{ gap: 12 }}>
      {list.length > 1 && (
        <div className="seg seg-wrap" role="group" aria-label={d.quizAttempts}>
          {list.map((x, k) => (
            <button key={x.id} type="button" aria-pressed={k === pick} onClick={() => setPick(k)}>
              {d.quizAttempt} {x.number}{x.counts ? ` · ${d.quizCounts}` : ""}
            </button>
          ))}
        </div>
      )}
      <dl className="facts-grid">
        <div><dt>{d.quizScore}</dt><dd>{at.score ?? "—"} / {points}{at.pending ? ` · ${at.pending} ${d.quizToScore}` : ""}</dd></div>
        <div><dt>{d.quizStarted}</dt><dd>{time(at.startedAt)}</dd></div>
        <div><dt>{d.handedIn}</dt><dd>{at.submittedAt ? time(at.submittedAt) : d.quizStillOpen}{at.autoSubmitted ? ` · ${d.quizAutoHandedIn}` : ""}</dd></div>
        <div><dt>{d.quizAway}</dt><dd>{at.away.length}{at.away.length ? ` · ${secs(at.away.reduce((n, x) => n + (x.seconds ?? 0), 0))}` : ""}</dd></div>
      </dl>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.quizFactsTeacherNote}</p>
      {at.away.length > 0 && (
        <details>
          <summary style={{ cursor: "pointer", minHeight: 32 }}>{d.quizAwayList}</summary>
          <ul className="list" style={{ fontSize: 13 }}>
            {at.away.map((x, k) => (
              <li key={k} style={{ padding: "6px 0" }}><time>{time(x.from)}</time> → {x.to ? <time>{time(x.to)}</time> : d.quizNotBack} · {secs(x.seconds)}</li>
            ))}
          </ul>
        </details>
      )}

      <ol className="stack" style={{ gap: 12, paddingLeft: 20, margin: 0 }}>
        {at.items.map((i) => (
          <li key={`${at.id}-${i.identifier}`}>
            <ReviewRow assignmentId={assignmentId} attempt={at} item={i} pastes={at.pastes.filter((p) => p.item === i.identifier)} onSaved={saved} d={d} />
          </li>
        ))}
      </ol>
    </div>
  );
}

function ReviewRow({ assignmentId, attempt, item: i, pastes, onSaved, d }: {
  assignmentId: string; attempt: ReviewAttempt; item: ReviewItem; pastes: ReviewAttempt["pastes"]; d: Dict;
  onSaved: (attemptId: string, out: SaveOut) => void;
}) {
  const [value, setValue] = useState(i.score === null ? "" : String(i.score));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [replay, setReplay] = useState(false);
  useEffect(() => { setValue(i.score === null ? "" : String(i.score)); }, [i.score]);
  const mine = i.by !== "auto";
  const waiting = i.score === null;

  const save = async (score: string | null) => {
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/assignments/${assignmentId}/quiz/score`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ attemptId: attempt.id, itemId: i.identifier, score: score === null || score.trim() === "" ? null : score }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) { setError(out.error === "roster" ? d.rosterFailed : d.badScore); return; }
      onSaved(attempt.id, out as SaveOut);
    } catch {
      setError(d.saveError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`quiz-review${waiting ? " is-waiting" : ""}`}>
      <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{i.prompt}</p>
      <div className={i.kind === "essay" ? "work-text" : ""} style={{ margin: "4px 0", fontSize: 15 }}>
        {i.kind !== "essay" && <span className="muted">{d.quizTheirAnswer}: </span>}
        {i.yours || <i className="muted">{d.quizNoAnswer}</i>}
      </div>
      {i.answer && <p style={{ margin: 0, fontSize: 14 }}><span className="muted">{d.quizRightAnswer}:</span> {i.answer}</p>}
      {attempt.submittedAt && (
        <form className="row" style={{ marginTop: 6, gap: 8 }} onSubmit={(e) => { e.preventDefault(); save(value); }}>
          <label htmlFor={`qs-${attempt.id}-${i.identifier}`} style={{ fontSize: 14 }}>{d.score}</label>
          <input id={`qs-${attempt.id}-${i.identifier}`} className="field score-input" style={{ width: 90 }} inputMode="decimal" value={value}
            onChange={(e) => setValue(e.target.value)} aria-invalid={!!error} autoComplete="off" />
          <span className="muted" style={{ fontSize: 14 }}>/ {i.points}</span>
          <button type="submit" className="btn btn-sm" disabled={busy}>{d.save}</button>
          {mine && !i.hand && <button type="button" className="btn btn-sm" disabled={busy} onClick={() => save(null)}>{d.quizUseAuto}</button>}
          {waiting
            ? <span className="chip chip-late">{d.quizNeedsScore}</span>
            : <span className="chip">{mine ? d.quizScoredByTeacher : d.quizScoredAuto}</span>}
        </form>
      )}
      {error && <p className="notice notice-bad" role="alert" style={{ marginTop: 6 }}>{error}</p>}
      {i.kind === "essay" && i.answered && (
        <details className="writing-process" onToggle={(e) => setReplay(e.currentTarget.open)} style={{ marginTop: 6 }}>
          <summary>{d.writingProcess}{pastes.length ? ` · ${d.quizPastes}: ${pastes.length}` : ""}</summary>
          {replay && <WritingReplay assignmentId={assignmentId} studentId={attempt.id} d={d}
            src={`/api/assignments/${assignmentId}/quiz/writing?attempt=${attempt.id}&item=${encodeURIComponent(i.identifier)}`} />}
        </details>
      )}
    </div>
  );
}
