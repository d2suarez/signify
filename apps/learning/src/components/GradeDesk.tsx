"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Dict } from "@/lib/i18n";
import type { Flag } from "@/lib/grades";
import WritingReplay from "./WritingReplay";
import RubricView from "./RubricView";
import SchoologyScores from "./SchoologyScores";
import QuizReview from "./QuizReview";
import type { Grade } from "@/lib/grades";
import { feedbackFromParts, isParts, partsScore, rubricScore, type PartMarks, type PartNotes, type Rubric, type RubricSelection } from "@/lib/rubric";
import PartsGrader from "./PartsGrader";
import ReviewWork from "./ReviewWork";
import PartZoom from "./PartZoom";
import IntegrityDrawer from "./IntegrityDrawer";
import type { Concern } from "@/lib/integrity";
import type { Suggestion } from "@/lib/suggestions";
import { levelsFromRubric } from "@/lib/standards-math";
import { finalScore, normalizeOverride, penaltyFor, ruleText, type Applied, type LateOverride } from "@/lib/late-policy";

type Levels = Record<string, number>;
/** A standards course: the standards this assignment measures and the scale's labels (top level first). */
export type DeskStandards = { list: { id: string; code: string; description: string }[]; labels: string[] };

export type DeskStudent = {
  id: string; name: string;
  body: string | null; submittedAt: string | null; late: boolean;
  score: number | null; flag: Flag | null; comment: string; rubric: RubricSelection | null; levels: Levels | null;
  /** Days late by the hand-in time (null = not late by the clock), and the teacher's change to the penalty. */
  autoDays: number | null; lateOverride: LateOverride | null;
  /** Group work (story 01, F4): the student's group and its members' ids, or null. */
  group?: { name: string; ids: string[] } | null;
  /** A sections-and-parts rubric: part scores and messages, and the teacher's own notes. */
  parts?: PartMarks | null; notes?: PartNotes | null;
  /** The review screen: when the teacher marked this grade reviewed (null = not yet). */
  reviewedAt?: string | null;
};
type Sort = "name" | "low" | "todo";

type History = { score: number | null; flag: Flag | null; comment: string; lateOverride: LateOverride | null; changedAt: string }[];
type LateMode = "policy" | "waive" | "percent" | "days";
const modeOf = (o: LateOverride | null): LateMode => (!o ? "policy" : "waive" in o ? "waive" : "percent" in o ? "percent" : "days");
const amountOf = (o: LateOverride | null) => (o && "percent" in o ? String(o.percent) : o && "days" in o ? String(o.days) : "");

/**
 * Grading one assignment, a student at a time: their work on the left,
 * score, mark and comment on the right. Save moves to the next student.
 */
export default function GradeDesk({ assignment, students: initial, startWith, schoology = false, standards, lateRule = null, concerns: initialConcerns = [], suggestions: initialSuggestions = [], d }: {
  assignment: { id: string; points: number; kind: "online" | "offline" | "quiz"; gradesReleased: boolean; rubric: Rubric | null };
  students: DeskStudent[]; startWith?: string; schoology?: boolean; standards?: DeskStandards;
  /** The late policy for this assignment (null = late is a mark only). */
  lateRule?: Applied | null;
  /** The review screen: the teacher's integrity concerns and the open suggestions (never grades). */
  concerns?: Concern[]; suggestions?: Suggestion[];
  d: Dict;
}) {
  const [saves, setSaves] = useState(0);
  const [students, setStudents] = useState(initial);
  const [i, setI] = useState(Math.max(0, initial.findIndex((s) => s.id === startWith)));
  const s = students[i];
  const [score, setScore] = useState(s.score === null ? "" : String(s.score));
  const [flag, setFlag] = useState<Flag | "">(s.flag || "");
  const [comment, setComment] = useState(s.comment);
  const [sel, setSel] = useState<RubricSelection | null>(s.rubric);
  const parts = isParts(assignment.rubric);
  const [marks, setMarks] = useState<PartMarks | null>(s.parts ?? null);
  const [notes, setNotes] = useState<PartNotes | null>(s.notes ?? null);
  const [levels, setLevels] = useState<Levels | null>(s.levels);
  const [lateMode, setLateMode] = useState<LateMode>(modeOf(s.lateOverride));
  const [lateAmount, setLateAmount] = useState(amountOf(s.lateOverride));
  const top = standards?.labels.length ?? 0;
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<History | null>(null);
  const [showWriting, setShowWriting] = useState(false);
  // A group assignment: one grade for the whole group, unless the teacher changes just this member.
  const [whole, setWhole] = useState(true);
  const scoreRef = useRef<HTMLInputElement>(null);
  // The review screen (a sections-and-parts rubric): sort, the enlarged part, the Grade / Student feedback tabs.
  const [sort, setSort] = useState<Sort>("name");
  const [zoom, setZoom] = useState<string | null>(null);
  const [tab, setTab] = useState<"grade" | "feedback">("grade");
  const review = parts;
  const view = useMemo(() => {
    const at = new Map(students.map((x, k) => [x.id, k]));
    const base = students.map((x) => x);
    if (sort === "low") return base.sort((a, b) => (a.score ?? Infinity) - (b.score ?? Infinity) || at.get(a.id)! - at.get(b.id)!);
    if (sort === "todo") {
      const done = (x: DeskStudent) => (review ? !!x.reviewedAt : x.score !== null || !!x.flag);
      return base.sort((a, b) => Number(done(a)) - Number(done(b)) || at.get(a.id)! - at.get(b.id)!);
    }
    return base;
  }, [students, sort, review]);
  const pos = view.findIndex((x) => x.id === s.id);
  const go = (id: string | undefined) => { const k = students.findIndex((x) => x.id === id); if (k >= 0) setI(k); };
  const reviewedCount = students.filter((x) => x.reviewedAt).length;
  const [concerns, setConcerns] = useState(initialConcerns);
  const flagged = useMemo(() => new Set(concerns.flatMap((c) => c.studentIds)), [concerns]);
  // Suggestions: open ones for everyone; `used` = this student's ones copied into the form (settled by the save).
  const [sugg, setSugg] = useState(initialSuggestions);
  const [used, setUsed] = useState<string[]>([]);
  const [copyFrom, setCopyFrom] = useState("");
  const mySugg = sugg.filter((x) => x.studentId === s.id && x.partId !== null);
  const nameOf = (id: unknown) => students.find((x) => x.id === id)?.name ?? "?";

  // Load the chosen student's grade into the form.
  useEffect(() => {
    const cur = students[i];
    setScore(cur.score === null ? "" : String(cur.score));
    setFlag(cur.flag || "");
    setComment(cur.comment);
    setSel(cur.rubric);
    setMarks(cur.parts ?? null);
    setNotes(cur.notes ?? null);
    setLevels(cur.levels);
    setLateMode(modeOf(cur.lateOverride));
    setLateAmount(amountOf(cur.lateOverride));
    setError("");
    setHistory(null);
    setShowWriting(false);
    setWhole(true);
    setZoom(null);
    setTab("grade");
    setUsed([]);
    scoreRef.current?.focus({ preventScroll: true });
    // Only when moving to another student, not after each save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i]);

  // The penalty as the form stands now, worked out like the gradebook does.
  const override: LateOverride | null = lateMode === "policy" ? null
    : lateMode === "waive" ? { waive: true }
    : normalizeOverride(lateMode === "percent" ? { percent: lateAmount } : { days: lateAmount });
  const typed = score.trim() === "" ? null : Number(score.replace(",", "."));
  const penalty = lateRule && typed !== null && Number.isFinite(typed)
    ? penaltyFor(lateRule, assignment.points, { score: typed, flag: flag || null, autoDays: s.autoDays, override })
    : null;
  const dirty = (score === "" ? null : Number(score)) !== s.score || (flag || null) !== s.flag || comment.trim() !== s.comment
    || JSON.stringify(override) !== JSON.stringify(s.lateOverride ?? null)
    || JSON.stringify(sel ?? null) !== JSON.stringify(s.rubric ?? null)
    || JSON.stringify(marks ?? null) !== JSON.stringify(s.parts ?? null) || JSON.stringify(notes ?? null) !== JSON.stringify(s.notes ?? null)
    || JSON.stringify(levels ?? null) !== JSON.stringify(s.levels ?? null);

  const setLevel = (standardId: string, level: number | null) => {
    setLevels((cur) => {
      const next = { ...(cur ?? {}) };
      if (level === null) delete next[standardId]; else next[standardId] = level;
      return Object.keys(next).length ? next : null;
    });
  };

  // Choosing a level fills in the score from the rubric (the teacher can still change it).
  const pick = (criterionId: string, levelId: string | null) => {
    if (!assignment.rubric) return;
    const next = { ...(sel ?? {}) };
    if (levelId) next[criterionId] = levelId; else delete next[criterionId];
    const clean = Object.keys(next).length ? next : null;
    setSel(clean);
    const { score: total } = rubricScore(assignment.rubric, clean);
    setScore(total === null ? "" : String(total));
    // A row aligned to a standard fills in that standard's level too.
    if (standards) {
      const c = assignment.rubric.criteria.find((x) => x.id === criterionId);
      if (c?.standardId && standards.list.some((x) => x.id === c.standardId)) {
        setLevel(c.standardId, levelsFromRubric(assignment.rubric, clean, top)[c.standardId] ?? null);
      }
    }
  };

  // Scoring a part fills in the total (the teacher can still change it).
  const mark = (next: PartMarks | null) => {
    setMarks(next);
    if (!assignment.rubric) return;
    const { score: total } = partsScore(assignment.rubric, next);
    setScore(total === null ? "" : String(total));
  };
  const built = parts ? feedbackFromParts(assignment.rubric!, marks) : "";
  const buildFeedback = () => {
    if (comment.trim() && comment.trim() !== built && !confirm(d.prReplaceFeedback)) return;
    setComment(built);
  };

  /** Save (when anything changed), optionally mark reviewed, then optionally move on. */
  const save = async (thenNext: boolean, markReviewed = false) => {
    setSaving(true);
    setError("");
    // Where "next" goes, worked out before this save re-sorts the list.
    const skip = new Set(s.group && whole ? s.group.ids : [s.id]);
    const nextId = view.slice(pos + 1).find((x) => !skip.has(x.id))?.id;
    try {
      if (!dirty && markReviewed) {
        if (await setReviewed([...skip].filter((id) => !s.group || whole || id === s.id), true) && thenNext && nextId) go(nextId);
        return;
      }
      const res = await fetch("/api/grades", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ assignmentId: assignment.id, studentId: s.id, group: !!s.group && whole, score, flag: flag || null, comment, ...(used.length ? { suggestions: used } : {}), ...(assignment.rubric && !parts ? { rubric: sel } : {}), ...(parts ? { parts: marks ?? {}, notes: notes ?? {} } : {}), ...(standards ? { levels: levels ?? {} } : {}), ...(lateRule ? { late: override } : {}) }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(out.error === "bad-score" ? d.badScore : out.error === "roster" ? d.rosterFailed : d.saveError);
        return;
      }
      // Every member a group grade reached (just this student otherwise).
      const reached: Record<string, Grade | null> = out.grades ?? { [s.id]: out.grade };
      setSaves((n) => n + 1);
      setStudents((all) => all.map((x) => {
        if (!(x.id in reached)) return x;
        const g = reached[x.id];
        return { ...x, score: g ? g.score : null, flag: g ? g.flag : null, comment: g ? g.comment : "", rubric: g ? g.rubric : null, levels: g ? g.levels : null, lateOverride: g ? g.lateOverride : null,
          parts: g ? g.parts : null, notes: g && parts ? notes : null };
      }));
      if (used.length) { setSugg((all) => all.filter((x) => !used.includes(x.id))); setUsed([]); }
      if (markReviewed && !(await setReviewed(Object.keys(reached), true))) return;
      // Save · Next on a group grade moves past the group's other members.
      if (thenNext && nextId) go(nextId);
    } catch {
      setError(d.saveError);
    } finally {
      setSaving(false);
    }
  };

  /** Mark (or unmark) students reviewed; false when it didn't work (the error is shown). */
  const setReviewed = async (ids: string[], on: boolean): Promise<boolean> => {
    const res = await fetch(`/api/assignments/${assignment.id}/review`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ studentIds: ids, reviewed: on }),
    }).catch(() => null);
    const out = res ? await res.json().catch(() => ({})) : {};
    if (!res?.ok) { setError(out.error === "roster" ? d.rosterFailed : d.saveError); return false; }
    const got: Record<string, string | null> = out.reviewed ?? {};
    setStudents((all) => all.map((x) => (x.id in got ? { ...x, reviewedAt: got[x.id] } : x)));
    return true;
  };

  /** "Use it": the suggestion goes into the form (not the grade); Save makes it the grade. */
  const applySuggestion = (list: Suggestion[]) => {
    let m = marks, n = notes;
    for (const x of list) {
      if (!x.partId) continue;
      m = { ...(m ?? {}), [x.partId]: { score: x.score ?? m?.[x.partId]?.score ?? null, message: x.message || m?.[x.partId]?.message || "" } };
      if (x.note) n = { ...(n ?? {}), [x.partId]: x.note };
    }
    mark(m);
    setNotes(n);
    setUsed((u) => [...new Set([...u, ...list.map((x) => x.id)])]);
  };
  const skipSuggestion = async (x: Suggestion) => {
    const res = await fetch(`/api/assignments/${assignment.id}/suggestions`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: x.id, action: "skip" }) }).catch(() => null);
    if (res?.ok) { setSugg((all) => all.filter((y) => y.id !== x.id)); setUsed((u) => u.filter((id) => id !== x.id)); }
  };
  const suggestFrom = async () => {
    if (!copyFrom) return;
    setError("");
    const res = await fetch(`/api/assignments/${assignment.id}/suggestions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ studentId: s.id, from: copyFrom }) }).catch(() => null);
    const out = res ? await res.json().catch(() => ({})) : {};
    if (!res?.ok) { setError(out.error === "roster" ? d.rosterFailed : d.saveError); return; }
    const got: Suggestion[] = out.suggestions ?? [];
    if (!got.length) { setError(d.sgNothing.replace("{name}", nameOf(copyFrom))); return; }
    const parts = new Set(got.map((x) => x.partId));
    setSugg((all) => [...all.filter((x) => !(x.studentId === s.id && parts.has(x.partId))), ...got]);
  };
  /** A part's open suggestion, under its question: what made it, the values, Use it / Skip. */
  const suggestionFor = (partId: string) => {
    const x = mySugg.find((y) => y.partId === partId);
    if (!x) return null;
    const inUse = used.includes(x.id);
    const from = x.source === "copy" ? d.sgFromStudent.replace("{name}", nameOf(x.detail?.from)) : d.sgFromOther.replace("{source}", x.source);
    return (
      <div className={`suggestion${inUse ? " is-used" : ""}`} role="group" aria-label={d.sgOne}>
        <p className="suggestion-head">💡 {d.sgOne} · <span className="muted">{from}</span></p>
        <p style={{ margin: 0, fontSize: 14 }}>
          {x.score !== null && <b>{x.score} </b>}{x.message && <span>“{x.message}”</span>}
          {x.note && <span className="muted" style={{ display: "block", fontSize: 13 }}>{d.prNote}: {x.note}</span>}
        </p>
        {inUse
          ? <p className="muted" style={{ fontSize: 12, margin: "4px 0 0" }}>{d.sgUsed}</p>
          : (
            <div className="row" style={{ gap: 6, marginTop: 4 }}>
              <button type="button" className="btn btn-sm" onClick={() => applySuggestion([x])}>{d.sgUse}</button>
              <button type="button" className="btn btn-sm" onClick={() => skipSuggestion(x)}>{d.sgSkip}</button>
            </div>
          )}
      </div>
    );
  };

  const loadHistory = async () => {
    const res = await fetch(`/api/grades?assignmentId=${assignment.id}&studentId=${encodeURIComponent(s.id)}`, { cache: "no-store" });
    if (res.ok) setHistory((await res.json()).history);
  };

  // A quiz question scored on the left: the grade the quiz wrote comes back here.
  const quizGrade = (g: Grade | null) => {
    if (!g) return;
    setStudents((all) => all.map((x, j) => j === i ? { ...x, score: g.score, flag: g.flag, comment: g.comment, levels: g.levels } : x));
    setScore(g.score === null ? "" : String(g.score));
    setFlag(g.flag || "");
    setLevels(g.levels);
    setSaves((n) => n + 1);
  };

  const lateWords = (o: LateOverride) => ("waive" in o ? d.lateWaived : "percent" in o ? `${o.percent}%` : `${d.schoolDaysLate}: ${o.days}`);
  const flagLabel = (f: Flag | null) => (f === "missing" ? d.missing : f === "late" ? d.late : f === "exempt" ? d.exempt : "");

  return (
    <div className="desk">
      <nav className="card desk-list" aria-label={d.students}>
        <div className="seg desk-sort" role="group" aria-label={d.rvSort}>
          {(["name", "low", "todo"] as const).map((k) => (
            <button key={k} type="button" aria-pressed={sort === k} onClick={() => setSort(k)}>
              {k === "name" ? d.rvSortName : k === "low" ? d.rvSortLow : d.rvSortTodo}
            </button>
          ))}
        </div>
        {review && (
          <p className="desk-progress" aria-live="polite">
            <span>{d.rvProgress.replace("{n}", String(reviewedCount)).replace("{total}", String(students.length))}</span>
            <span className="bar" aria-hidden="true"><i style={{ width: `${students.length ? (100 * reviewedCount) / students.length : 0}%` }} /></span>
          </p>
        )}
        <ul>
          {view.map((x) => (
            <li key={x.id}>
              <button type="button" aria-current={x.id === s.id ? "true" : undefined} onClick={() => go(x.id)}>
                <span className="grow">{x.name}{x.group && <span className="muted" style={{ display: "block", fontSize: 12 }}>{x.group.name}</span>}</span>
                {review && x.late && <span className="chip chip-late desk-mark">{d.late}</span>}
                {review && flagged.has(x.id) && <span className="desk-flagged" title={d.icFlagged} aria-label={d.icFlagged}>⚑</span>}
                {review && x.reviewedAt && <span className="desk-reviewed" title={d.rvReviewed} aria-label={d.rvReviewed}>✓</span>}
                {x.score !== null
                  ? <b>{x.score}{review ? <span className="muted" style={{ fontWeight: 400 }}>/{assignment.points}</span> : null}</b>
                  : x.flag ? <span className={`chip chip-${x.flag}`}>{flagLabel(x.flag)}</span>
                  : assignment.kind !== "offline" && x.submittedAt ? <span className="chip chip-done">{d.handedIn}</span>
                  : null}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <section className="card desk-work" aria-labelledby="desk-name">
        <div className="row">
          <h2 id="desk-name" className="grow" style={{ fontSize: 22 }}>{s.name}{s.group && <span className="muted" style={{ display: "block", fontSize: 14, fontWeight: 400 }}>{s.group.name} · {students.filter((x) => s.group!.ids.includes(x.id)).map((x) => x.name).join(", ")}</span>}</h2>
          {assignment.kind !== "offline" && (s.submittedAt
            ? <span className={`chip ${s.late ? "chip-late" : "chip-done"}`}>{d.handedIn} · <time suppressHydrationWarning>{new Date(s.submittedAt).toLocaleString()}</time>{s.late ? ` · ${d.late}` : ""}</span>
            : <span className="chip">{s.body ? d.workingOn : d.notHandedIn}</span>)}
        </div>
        {assignment.kind === "quiz"
          ? <QuizReview key={s.id} assignmentId={assignment.id} studentId={s.id} points={assignment.points} onGrade={quizGrade} d={d} />
          : assignment.kind === "online"
          ? (s.body
            ? (review ? <ReviewWork key={s.id} rubric={assignment.rubric!} body={s.body} marks={marks} current={zoom} onOpen={setZoom} d={d} />
              : <div className="work-text">{s.body}</div>)
            : <p className="empty">{d.noWork}</p>)
          : <p className="muted">{d.kindOffline}</p>}
        {assignment.kind === "online" && s.body && (
          <p style={{ margin: "8px 0 0" }}><a href={`/api/assignments/${assignment.id}/download?student=${encodeURIComponent(s.id)}`} download className="btn btn-sm">⬇ {d.zipOne}</a></p>
        )}
        {assignment.kind === "online" && s.body !== null && (
          // Loaded on request, for one student at a time.
          <details className="writing-process" key={s.id} onToggle={(e) => setShowWriting(e.currentTarget.open)}>
            <summary>{d.writingProcess}</summary>
            {showWriting && <WritingReplay assignmentId={assignment.id} studentId={s.id} d={d} />}
          </details>
        )}
      </section>

      <form className="card desk-form" onSubmit={(e) => { e.preventDefault(); save(true, review); }}>
        {review && (
          <div className="seg desk-tabs" role="tablist" aria-label={d.rvTabs}>
            <button type="button" role="tab" id="tab-grade" aria-controls="panel-grade" aria-selected={tab === "grade"} onClick={() => setTab("grade")}>{d.rvTabGrade}</button>
            <button type="button" role="tab" id="tab-feedback" aria-controls="panel-feedback" aria-selected={tab === "feedback"}
              onClick={() => { setTab("feedback"); if (!comment.trim() && built) setComment(built); }}>{d.prFeedback}</button>
          </div>
        )}
        <div id="panel-grade" role={review ? "tabpanel" : undefined} aria-labelledby={review ? "tab-grade" : undefined} hidden={review && tab !== "grade"}>
        {review && (
          <div className="review-tools stack" style={{ gap: 8, marginBottom: 12 }}>
            <IntegrityDrawer assignmentId={assignment.id} rubric={assignment.rubric} currentId={s.id} concerns={concerns} onConcerns={setConcerns}
              students={students.map((x) => ({ id: x.id, name: x.name, body: x.body }))} d={d} />
            {concerns.filter((c) => c.studentIds.includes(s.id)).map((c) => (
              <p key={c.id} className={`ic-box ic-${c.level}`}>
                <b>{c.level === "high" ? d.icHigh : c.level === "medium" ? d.icMedium : d.icNote}:</b> {c.evidence}
                <span className="muted" style={{ display: "block", fontSize: 12 }}>{d.icNoDeduction}</span>
              </p>
            ))}
            <details className="sg-tools">
              <summary>💡 {d.sgTitle}{mySugg.length ? ` (${mySugg.length})` : ""}</summary>
              <p className="muted" style={{ fontSize: 12, margin: "4px 0 6px" }}>{d.sgHint}</p>
              <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                <label htmlFor="sg-from" className="sr-only">{d.sgFromLabel}</label>
                <select id="sg-from" className="field" style={{ flex: 1, minWidth: 140 }} value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
                  <option value="">{d.sgFromLabel}</option>
                  {students.filter((x) => x.id !== s.id && (x.parts || x.notes)).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
                <button type="button" className="btn btn-sm" disabled={!copyFrom} onClick={suggestFrom}>{d.sgSuggest}</button>
              </div>
              {mySugg.filter((x) => !used.includes(x.id)).length > 1 && (
                <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => applySuggestion(mySugg.filter((x) => !used.includes(x.id)))}>
                  {d.sgUseAll.replace("{n}", String(mySugg.filter((x) => !used.includes(x.id)).length))}
                </button>
              )}
            </details>
          </div>
        )}
        {assignment.rubric && (
          <div className="fieldset" style={{ marginTop: 0 }}>
            <p className="flabel" style={{ fontWeight: 700, fontSize: 14, margin: "0 0 6px" }}>{d.rubric}</p>
            {parts
              ? <PartsGrader key={s.id} rubric={assignment.rubric} marks={marks} notes={notes} onMarks={mark} onNotes={setNotes} onOpen={setZoom} extra={suggestionFor} d={d} />
              : <RubricView rubric={assignment.rubric} selection={sel} onPick={pick} d={d} />}
          </div>
        )}
        {standards && standards.list.length > 0 && (
          <div className="fieldset" style={assignment.rubric ? undefined : { marginTop: 0 }}>
            <p className="flabel" style={{ fontWeight: 700, fontSize: 14, margin: "0 0 2px" }}>{d.proficiency}</p>
            <p className="muted" style={{ fontSize: 12, margin: "0 0 6px" }}>{d.levelsHint}</p>
            {standards.list.map((st) => (
              <fieldset key={st.id} style={{ border: 0, padding: 0, margin: "0 0 8px" }}>
                <legend style={{ fontSize: 14, marginBottom: 4 }}><b>{st.code}</b>{st.description ? <span className="muted"> · {st.description}</span> : null}</legend>
                <div className="seg seg-wrap">
                  <button type="button" aria-pressed={levels?.[st.id] === undefined} onClick={() => setLevel(st.id, null)}>{d.notScored}</button>
                  {standards.labels.map((label, k) => {
                    const lv = top - k;
                    return (
                      <button key={lv} type="button" aria-pressed={levels?.[st.id] === lv} onClick={() => setLevel(st.id, lv)}>
                        {lv} · {label}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            ))}
          </div>
        )}
        <div className="fieldset" style={assignment.rubric || standards?.list.length ? undefined : { marginTop: 0 }}>
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
        {penalty && typed !== null && (
          <fieldset className="fieldset late-box" style={{ border: 0, padding: 0 }}>
            <legend className="flabel" style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{d.latePenalty}</legend>
            <p className="muted" style={{ fontSize: 13, margin: "0 0 6px" }}>
              {lateRule!.name ? `${lateRule!.name}: ` : ""}{ruleText(lateRule!, d)}
              {s.autoDays === 0 && lateMode === "policy" ? <> · {d.sabbathOnlyLate}</> : null}
            </p>
            <p style={{ margin: "0 0 6px", fontSize: 15 }}>
              {d.rawScore} <b>{typed}</b> · −{penalty.percent}% ({d.schoolDaysLate}: {penalty.days}) · {d.countsAs} <b>{finalScore(typed, penalty)}</b>
            </p>
            <div className="seg seg-wrap">
              {(["policy", "waive", "percent", "days"] as const).map((m) => (
                <button key={m} type="button" aria-pressed={lateMode === m} onClick={() => {
                  setLateMode(m);
                  if (m === "percent") setLateAmount(String(penalty.percent));
                  if (m === "days") setLateAmount(String(penalty.days));
                }}>
                  {m === "policy" ? d.useThePolicy : m === "waive" ? d.waivePenalty : m === "percent" ? d.setPenaltyPct : d.setDaysLate}
                </button>
              ))}
            </div>
            {(lateMode === "percent" || lateMode === "days") && (
              <div style={{ marginTop: 6 }}>
                <label htmlFor="g-late" className="sr-only">{lateMode === "percent" ? d.setPenaltyPct : d.setDaysLate}</label>
                <input id="g-late" className="field" style={{ width: 110 }} inputMode="decimal" value={lateAmount}
                  onChange={(e) => setLateAmount(e.target.value)} autoComplete="off" />
              </div>
            )}
          </fieldset>
        )}
        </div>
        <div className="fieldset" id="panel-feedback" role={review ? "tabpanel" : undefined} aria-labelledby={review ? "tab-feedback" : undefined}
          hidden={review && tab !== "feedback"} style={review ? { marginTop: 12 } : undefined}>
          <div className="row" style={{ gap: 8 }}>
            <label htmlFor="g-comment" className="grow">{parts ? d.prFeedback : d.comment}</label>
            {parts && <button type="button" className="btn btn-sm" disabled={!built || built === comment} onClick={buildFeedback}>{d.prBuild}</button>}
          </div>
          {parts && <p className="muted" style={{ fontSize: 12, margin: "2px 0 4px" }}>{d.prFeedbackHint}</p>}
          <textarea id="g-comment" className="field" rows={review ? 12 : 5} maxLength={5000} value={comment} onChange={(e) => setComment(e.target.value)} />
        </div>
        {s.group && (
          <label className="check" style={{ marginTop: 10, whiteSpace: "normal" }}>
            <input type="checkbox" checked={whole} onChange={(e) => setWhole(e.target.checked)} />
            {d.gaWholeGroup.replace("{group}", s.group.name)}
          </label>
        )}
        <p className="muted" style={{ fontSize: 13, margin: "8px 0 0" }}>{assignment.gradesReleased ? d.gradesReleasedNote : d.gradesHiddenNote}</p>
        {schoology && <SchoologyScores assignmentId={assignment.id} studentId={s.id} refresh={saves} d={d} />}
        {error && <p className="notice notice-bad" role="alert" style={{ marginTop: 10 }}>{error}</p>}
        {review && (
          <p className="muted" style={{ fontSize: 13, margin: "8px 0 0" }}>
            {s.reviewedAt
              ? <>✓ {d.rvReviewedAt} <time suppressHydrationWarning>{new Date(s.reviewedAt).toLocaleString()}</time> · <button type="button" className="link-btn" onClick={() => setReviewed(s.group && whole ? s.group.ids : [s.id], false)}>{d.rvUnmark}</button></>
              : d.rvNotReviewed}
          </p>
        )}
        <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
          <button type="button" className="btn" disabled={pos <= 0} onClick={() => go(view[pos - 1]?.id)}>← {d.previous}</button>
          <span className="spacer" style={{ flex: 1 }} />
          <button type="button" className="btn" disabled={saving || !dirty} onClick={() => save(false)}>{d.save}</button>
          {review
            ? <button type="submit" className="btn btn-primary" disabled={saving}>{pos < view.length - 1 ? `${d.rvMarkNext} →` : d.rvMark}</button>
            : <button type="submit" className="btn btn-primary" disabled={saving}>{pos < view.length - 1 ? `${d.save} · ${d.nextStudent} →` : d.save}</button>}
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
                        <span className="grow">{h.score ?? "—"}{h.flag ? ` · ${flagLabel(h.flag)}` : ""}{h.lateOverride ? ` · ${d.latePenalty}: ${lateWords(h.lateOverride)}` : ""}{h.comment ? ` · “${h.comment.slice(0, 60)}”` : ""}</span>
                        <time className="muted" suppressHydrationWarning>{new Date(h.changedAt).toLocaleString()}</time>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
        </div>
      </form>
      {review && (
        <PartZoom rubric={assignment.rubric!} partId={zoom} body={assignment.kind === "online" ? s.body : null}
          marks={marks} notes={notes} onMarks={mark} onNotes={setNotes} onPart={setZoom} onClose={() => setZoom(null)} extra={suggestionFor} d={d} />
      )}
    </div>
  );
}
