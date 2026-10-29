"use client";

import { useEffect, useRef, useState } from "react";
import type { Dict } from "@/lib/i18n";
import type { Flag } from "@/lib/grades";
import WritingReplay from "./WritingReplay";
import RubricView from "./RubricView";
import { rubricScore, type Rubric, type RubricSelection } from "@/lib/rubric";

export type DeskStudent = {
  id: string; name: string;
  body: string | null; submittedAt: string | null; late: boolean;
  score: number | null; flag: Flag | null; comment: string; rubric: RubricSelection | null;
};

type History = { score: number | null; flag: Flag | null; comment: string; changedAt: string }[];

/**
 * Grading one assignment, a student at a time: their work on the left,
 * score, mark and comment on the right. Save moves to the next student.
 */
export default function GradeDesk({ assignment, students: initial, startWith, d }: {
  assignment: { id: string; points: number; kind: "online" | "offline"; gradesReleased: boolean; rubric: Rubric | null };
  students: DeskStudent[]; startWith?: string; d: Dict;
}) {
  const [students, setStudents] = useState(initial);
  const [i, setI] = useState(Math.max(0, initial.findIndex((s) => s.id === startWith)));
  const s = students[i];
  const [score, setScore] = useState(s.score === null ? "" : String(s.score));
  const [flag, setFlag] = useState<Flag | "">(s.flag || "");
  const [comment, setComment] = useState(s.comment);
  const [sel, setSel] = useState<RubricSelection | null>(s.rubric);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<History | null>(null);
  const [showWriting, setShowWriting] = useState(false);
  const scoreRef = useRef<HTMLInputElement>(null);

  // Load the chosen student's grade into the form.
  useEffect(() => {
    const cur = students[i];
    setScore(cur.score === null ? "" : String(cur.score));
    setFlag(cur.flag || "");
    setComment(cur.comment);
    setSel(cur.rubric);
    setError("");
    setHistory(null);
    setShowWriting(false);
    scoreRef.current?.focus();
    // Only when moving to another student, not after each save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i]);

  const dirty = (score === "" ? null : Number(score)) !== s.score || (flag || null) !== s.flag || comment.trim() !== s.comment
    || JSON.stringify(sel ?? null) !== JSON.stringify(s.rubric ?? null);

  // Choosing a level fills in the score from the rubric (the teacher can still change it).
  const pick = (criterionId: string, levelId: string | null) => {
    if (!assignment.rubric) return;
    const next = { ...(sel ?? {}) };
    if (levelId) next[criterionId] = levelId; else delete next[criterionId];
    const clean = Object.keys(next).length ? next : null;
    setSel(clean);
    const { score: total } = rubricScore(assignment.rubric, clean);
    setScore(total === null ? "" : String(total));
  };

  const save = async (thenNext: boolean) => {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/grades", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ assignmentId: assignment.id, studentId: s.id, score, flag: flag || null, comment, ...(assignment.rubric ? { rubric: sel } : {}) }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(out.error === "bad-score" ? d.badScore : out.error === "roster" ? d.rosterFailed : d.saveError);
        return;
      }
      const g = out.grade;
      setStudents((all) => all.map((x, j) => j === i
        ? { ...x, score: g ? g.score : null, flag: g ? g.flag : null, comment: g ? g.comment : "", rubric: g ? g.rubric : null }
        : x));
      if (thenNext && i < students.length - 1) setI(i + 1);
    } catch {
      setError(d.saveError);
    } finally {
      setSaving(false);
    }
  };

  const loadHistory = async () => {
    const res = await fetch(`/api/grades?assignmentId=${assignment.id}&studentId=${encodeURIComponent(s.id)}`, { cache: "no-store" });
    if (res.ok) setHistory((await res.json()).history);
  };

  const flagLabel = (f: Flag | null) => (f === "missing" ? d.missing : f === "late" ? d.late : f === "exempt" ? d.exempt : "");

  return (
    <div className="desk">
      <nav className="card desk-list" aria-label={d.students}>
        <ul>
          {students.map((x, j) => (
            <li key={x.id}>
              <button type="button" aria-current={j === i ? "true" : undefined} onClick={() => setI(j)}>
                <span className="grow">{x.name}</span>
                {x.score !== null
                  ? <b>{x.score}</b>
                  : x.flag ? <span className={`chip chip-${x.flag}`}>{flagLabel(x.flag)}</span>
                  : assignment.kind === "online" && x.submittedAt ? <span className="chip chip-done">{d.handedIn}</span>
                  : null}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <section className="card desk-work" aria-labelledby="desk-name">
        <div className="row">
          <h2 id="desk-name" className="grow" style={{ fontSize: 22 }}>{s.name}</h2>
          {assignment.kind === "online" && (s.submittedAt
            ? <span className={`chip ${s.late ? "chip-late" : "chip-done"}`}>{d.handedIn} · <time suppressHydrationWarning>{new Date(s.submittedAt).toLocaleString()}</time>{s.late ? ` · ${d.late}` : ""}</span>
            : <span className="chip">{s.body ? d.workingOn : d.notHandedIn}</span>)}
        </div>
        {assignment.kind === "online"
          ? (s.body ? <div className="work-text">{s.body}</div> : <p className="empty">{d.noWork}</p>)
          : <p className="muted">{d.kindOffline}</p>}
        {assignment.kind === "online" && s.body !== null && (
          // Loaded on request, for one student at a time.
          <details className="writing-process" key={s.id} onToggle={(e) => setShowWriting(e.currentTarget.open)}>
            <summary>{d.writingProcess}</summary>
            {showWriting && <WritingReplay assignmentId={assignment.id} studentId={s.id} d={d} />}
          </details>
        )}
      </section>

      <form className="card desk-form" onSubmit={(e) => { e.preventDefault(); save(true); }}>
        {assignment.rubric && (
          <div className="fieldset" style={{ marginTop: 0 }}>
            <p className="flabel" style={{ fontWeight: 700, fontSize: 14, margin: "0 0 6px" }}>{d.rubric}</p>
            <RubricView rubric={assignment.rubric} selection={sel} onPick={pick} d={d} />
          </div>
        )}
        <div className="fieldset" style={assignment.rubric ? undefined : { marginTop: 0 }}>
          <label htmlFor="g-score">{d.score} <span className="muted" style={{ fontWeight: 400 }}>{d.outOf} {assignment.points}</span></label>
          <input id="g-score" ref={scoreRef} className="field score-input" inputMode="decimal" value={score}
            onChange={(e) => setScore(e.target.value)} aria-invalid={error === d.badScore} autoComplete="off" />
        </div>
        <fieldset className="fieldset" style={{ border: 0, padding: 0 }}>
          <legend className="flabel" style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>{d.flag}</legend>
          <div className="seg">
            {(["", "missing", "late", "exempt"] as const).map((f) => (
              <button key={f || "none"} type="button" aria-pressed={flag === f} onClick={() => setFlag(f)}>
                {f ? flagLabel(f) : d.none}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="fieldset">
          <label htmlFor="g-comment">{d.comment}</label>
          <textarea id="g-comment" className="field" rows={5} maxLength={5000} value={comment} onChange={(e) => setComment(e.target.value)} />
        </div>
        <p className="muted" style={{ fontSize: 13, margin: "8px 0 0" }}>{assignment.gradesReleased ? d.gradesReleasedNote : d.gradesHiddenNote}</p>
        {error && <p className="notice notice-bad" role="alert" style={{ marginTop: 10 }}>{error}</p>}
        <div className="row" style={{ marginTop: 12 }}>
          <button type="button" className="btn" disabled={i === 0} onClick={() => setI(i - 1)}>← {d.previous}</button>
          <span className="spacer" style={{ flex: 1 }} />
          <button type="button" className="btn" disabled={saving || !dirty} onClick={() => save(false)}>{d.save}</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{i < students.length - 1 ? `${d.save} · ${d.nextStudent} →` : d.save}</button>
        </div>
        <div style={{ marginTop: 14 }}>
          {history === null
            ? <button type="button" className="btn btn-sm" onClick={loadHistory}>{d.history}</button>
            : (
              <>
                <p className="label">{d.history}</p>
                {history.length === 0 ? <p className="empty" style={{ fontSize: 13 }}>—</p> : (
                  <ul className="list" style={{ fontSize: 13 }}>
                    {history.map((h, k) => (
                      <li key={k} style={{ padding: "6px 0" }}>
                        <span className="grow">{h.score ?? "—"}{h.flag ? ` · ${flagLabel(h.flag)}` : ""}{h.comment ? ` · “${h.comment.slice(0, 60)}”` : ""}</span>
                        <time className="muted" suppressHydrationWarning>{new Date(h.changedAt).toLocaleString()}</time>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
        </div>
      </form>
    </div>
  );
}
