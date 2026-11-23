"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Assignment } from "@/lib/assignments";
import type { Dict } from "@/lib/i18n";
import { onSabbath } from "@/lib/calendar";
import { rubricMax } from "@/lib/rubric";
import RubricEditor from "./RubricEditor";
import QuizEditor from "./QuizEditor";
import StandardsPicker, { type StandardOption } from "./StandardsPicker";
import GroupSetMaker from "./GroupSetMaker";
import { DEFAULT_SETTINGS, quizPoints } from "@/lib/quiz";
import { docFromText, type DocNode } from "@/lib/post-doc";
import DocEditor from "./DocEditor";

type Option = { id: string; name: string };
type Status = "saved" | "dirty" | "saving" | "error" | "conflict";

/** HH:MM of a moment, in this browser's time zone. */
function localTime(iso: string | null): string {
  if (!iso) return "23:59";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * The teacher's form for one assignment. Saved with an explicit Save (it is
 * a form, not a document), version-checked like lessons.
 */
export default function AssignmentEditor({ initial, units, categories, standards, attempted = 0, canUpload = false, groupSets = [], graded = false, d }: {
  initial: Assignment; units: Option[]; categories: Option[];
  /** Whether pictures and files can be uploaded into the instructions (the file store is on). */
  canUpload?: boolean;
  /** The course's standards (any course may align work; only a standards course grades by them). */
  standards?: StandardOption[];
  /** A quiz: how many students have handed in an attempt. */
  attempted?: number;
  /** The class's saved group sets (group work, story 01 A10). */
  groupSets?: Option[];
  /** Whether any student already has a grade here (a parts rubric's editor warns before parts change). */
  graded?: boolean; d: Dict;
}) {
  const [a, setA] = useState(initial);
  const [sets, setSets] = useState(groupSets);
  // The rubric as last saved: the parts editor compares against it.
  const [savedRubric, setSavedRubric] = useState(initial.rubric);
  const [saveNote, setSaveNote] = useState("");
  const [time, setTime] = useState("23:59");
  const [status, setStatus] = useState<Status>("saved");
  const [regraded, setRegraded] = useState("");
  // Rich instructions (A12): sent only once the teacher has changed them, so an
  // old plain-text assignment stays plain text until its instructions are edited.
  const [doc, setDoc] = useState<DocNode[] | null>(null);
  const [docStart] = useState<DocNode[]>(() => initial.instructionsDoc?.nodes ?? docFromText(initial.instructions).nodes);

  useEffect(() => { setTime(localTime(initial.dueAt)); }, [initial.dueAt]);

  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => { if (status === "dirty" || status === "saving") e.preventDefault(); };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [status]);

  const set = (patch: Partial<Assignment>) => { setA((x) => ({ ...x, ...patch })); if (status !== "conflict") setStatus("dirty"); };

  const save = async (extra: Partial<Assignment> = {}) => {
    if (status === "conflict") return;
    const next = { ...a, ...extra };
    setStatus("saving");
    const dueAt = next.dueOn ? new Date(`${next.dueOn}T${time || "23:59"}`).toISOString() : null;
    try {
      const res = await fetch(`/api/assignments/${a.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseVersion: a.version, title: next.title,
          ...(doc ? { instructionsDoc: { v: 1, nodes: doc } } : { instructions: next.instructions }), kind: next.kind,
          points: next.points, dueOn: next.dueOn, dueAt, unitId: next.unitId || null, categoryId: next.categoryId || null,
          published: next.published, gradesReleased: next.gradesReleased, rubric: next.kind === "quiz" ? null : next.rubric,
          ...(next.kind === "quiz" ? { quiz: next.quiz ?? { settings: DEFAULT_SETTINGS, items: [] } } : {}),
          ...(standards ? { standards: next.standards ?? [] } : {}),
          groupSetId: next.kind === "quiz" ? null : next.groupSetId, groupHandIn: next.groupHandIn, groupSubmitter: next.groupSubmitter,
          handIn: next.handIn,
        }),
      });
      if (res.status === 409) { setStatus("conflict"); return; }
      if (res.status === 400) {
        const bad = await res.json().catch(() => ({}));
        if (bad.error === "short-sections") { setSaveNote(d.prTooFewSave); setStatus("error"); return; }
      }
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      setA(body.assignment);
      setSavedRubric(body.assignment.rubric);
      setSaveNote("");
      setDoc(null);
      setStatus("saved");
      const r = body.regraded;
      setRegraded(r ? (r.roster ? d.quizRegraded : d.quizRegradedNoRoster).replace("{a}", String(r.attempts)).replace("{g}", String(r.grades)) : "");
    } catch {
      setStatus("error");
    }
  };

  const archive = async () => {
    if (!confirm(d.archiveConfirm)) return;
    const res = await fetch(`/api/assignments/${a.id}`, { method: "DELETE" });
    if (res.ok) location.href = `/courses/${a.courseId}`;
  };

  const stateText = { saved: `${d.saved} · ${d.version} ${a.version}`, dirty: d.unsaved, saving: d.saving, error: d.saveFailed, conflict: "" }[status];

  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <div className="row">
        <Link href={`/courses/${a.courseId}`} className="muted" style={{ fontSize: 14 }}>← {d.backToCourse}</Link>
        <span className="spacer" style={{ flex: 1 }} />
        <span className="save-state" role="status" aria-live="polite">{stateText}</span>
        <button className="btn btn-primary" type="submit" disabled={status === "saving" || status === "conflict"}>{d.save}</button>
        {a.kind === "quiz" && <Link className="btn" href={`/assignments/${a.id}/results`}>{d.quizResults}</Link>}
        <Link className="btn" href={`/assignments/${a.id}/grade`}>{d.openGrading}</Link>
      </div>
      {regraded && <p className="notice" role="status">{regraded}</p>}
      {saveNote && <p className="notice notice-bad" role="alert">{saveNote}</p>}

      {status === "conflict" && (
        <div className="notice notice-bad" role="alert">
          {d.conflict} <button className="btn btn-sm" type="button" onClick={() => location.reload()}>{d.reload}</button>
        </div>
      )}

      <div className="editor">
        <div className="editor-main">
          <label htmlFor="a-title" className="label">{d.assignmentTitle}</label>
          <input id="a-title" className="title-input" value={a.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} />
          <div className="card">
            <div className="fieldset" style={{ marginTop: 0 }}>
              <span className="label" id="a-instr-label">{d.instructions}</span>
              <DocEditor initial={docStart} canUpload={canUpload} uploadUrl={`/api/courses/${a.courseId}/files`} label={d.instructionsPlaceholder} d={d}
                onChange={(nodes) => { setDoc(nodes); if (status !== "conflict") setStatus("dirty"); }} />
            </div>
            <div className="fieldset">
              <label htmlFor="a-kind">{d.kind}</label>
              <select id="a-kind" className="field" value={a.kind} disabled={initial.kind === "quiz" && attempted > 0}
                onChange={(e) => {
                  const kind = e.target.value as Assignment["kind"];
                  const quiz = kind === "quiz" ? a.quiz ?? { settings: DEFAULT_SETTINGS, items: [] } : a.quiz;
                  set({ kind, quiz, ...(kind === "quiz" ? { points: quizPoints(quiz), rubric: null } : {}) });
                }}>
                <option value="online">{d.kindOnline}</option>
                <option value="offline">{d.kindOffline}</option>
                <option value="quiz">{d.kindQuiz}</option>
              </select>
            </div>
            {a.kind === "online" && (
              <div className="fieldset">
                <label htmlFor="a-handin">{d.wfHandInLabel}</label>
                <select id="a-handin" className="field" value={a.handIn} onChange={(e) => set({ handIn: e.target.value as Assignment["handIn"] })}>
                  <option value="text">{d.wfText}</option>
                  <option value="files">{d.wfFiles}</option>
                  <option value="both">{d.wfBoth}</option>
                </select>
              </div>
            )}
          </div>
          {standards && (
            <StandardsPicker options={standards} value={a.standards ?? []} onChange={(ids) => set({ standards: ids.length ? ids : null })}
              addHref={`/standards?course=${a.courseId}`} legend={d.alignStandards} hint={d.alignHint} d={d} />
          )}
          {a.kind === "quiz"
            ? <QuizEditor quiz={a.quiz ?? { settings: DEFAULT_SETTINGS, items: [] }} attempted={attempted} standards={standards} d={d}
                onChange={(quiz) => set({ quiz, points: quizPoints(quiz) })} />
            : <RubricEditor rubric={a.rubric} onChange={(rubric) => set({ rubric, ...(rubric ? { points: rubricMax(rubric) } : {}) })} standards={standards}
                saved={savedRubric} graded={graded} d={d} />}
        </div>

        <aside className="editor-side">
          <div className="card">
            <div className="row" style={{ gap: 8 }}>
              <span className={`pill ${a.published ? "" : "pill-draft"}`}>{a.published ? d.published : d.draft}</span>
              <span className="spacer" style={{ flex: 1 }} />
              <button type="button" className={`btn btn-sm ${a.published ? "" : "btn-primary"}`} disabled={status === "saving" || status === "conflict"}
                onClick={() => save({ published: !a.published })}>{a.published ? d.unpublish : d.publish}</button>
            </div>
            {!a.published && <p className="muted" style={{ fontSize: 13, margin: "8px 0 0" }}>{d.publishHint}</p>}
            <label className="check" style={{ marginTop: 14, whiteSpace: "normal" }}>
              <input type="checkbox" checked={a.gradesReleased} onChange={(e) => set({ gradesReleased: e.target.checked })} />
              {d.releaseGrades}
            </label>
            <p className="muted" style={{ fontSize: 13, margin: "4px 0 0" }}>{a.gradesReleased ? d.gradesReleasedNote : d.gradesHiddenNote}</p>
          </div>

          <div className="card">
            <div className="row" style={{ alignItems: "flex-end" }}>
              <div className="fieldset" style={{ flex: "1 1 120px", marginTop: 0 }}>
                <label htmlFor="a-due">{d.dueDate}</label>
                <input id="a-due" type="date" className="field" value={a.dueOn || ""} onChange={(e) => set({ dueOn: e.target.value || null })} />
              </div>
              <div className="fieldset" style={{ flex: "1 1 100px", marginTop: 0 }}>
                <label htmlFor="a-time">{d.dueTime}</label>
                <input id="a-time" type="time" className="field" value={time} disabled={!a.dueOn}
                  onChange={(e) => { setTime(e.target.value); if (status !== "conflict") setStatus("dirty"); }} />
              </div>
            </div>
            {a.dueOn && onSabbath(a.dueOn, time) && <p className="notice" style={{ marginTop: 10 }}>{d.sabbathWarning}</p>}
            <div className="fieldset">
              <label htmlFor="a-points">{d.points}</label>
              <input id="a-points" type="number" min={0} max={10000} step="any" className="field" value={a.points}
                disabled={!!a.rubric || a.kind === "quiz"} aria-describedby={a.rubric ? "a-points-rubric" : a.kind === "quiz" ? "a-points-quiz" : undefined}
                onChange={(e) => set({ points: Number(e.target.value) })} />
              {a.rubric && <p id="a-points-rubric" className="muted" style={{ margin: 0, fontSize: 13 }}>{d.pointsFromRubric}</p>}
              {a.kind === "quiz" && <p id="a-points-quiz" className="muted" style={{ margin: 0, fontSize: 13 }}>{d.quizPointsFromQuestions}</p>}
            </div>
            <div className="fieldset">
              <label htmlFor="a-cat">{d.category}</label>
              <select id="a-cat" className="field" value={a.categoryId || ""} onChange={(e) => set({ categoryId: e.target.value || null })}>
                <option value="">{d.noCategory}</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="fieldset">
              <label htmlFor="a-unit">{d.unit}</label>
              <select id="a-unit" className="field" value={a.unitId || ""} onChange={(e) => set({ unitId: e.target.value || null })}>
                <option value="">{d.noUnit}</option>
                {units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
          </div>

          {a.kind !== "quiz" && (
            <div className="card">
              <div className="fieldset" style={{ marginTop: 0 }}>
                <label htmlFor="a-groups">{d.gaGroupWork}</label>
                <select id="a-groups" className="field" value={a.groupSetId || ""} onChange={(e) => set({ groupSetId: e.target.value || null })}>
                  <option value="">{d.gaAlone}</option>
                  {a.groupSetId && !sets.some((g) => g.id === a.groupSetId) && <option value={a.groupSetId}>{d.gaArchivedSet}</option>}
                  {sets.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
                <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
                  {sets.length ? d.gaHint : d.gsNoneYet}
                  {a.groupSetId && sets.some((g) => g.id === a.groupSetId) && <> <Link href={`/courses/${a.courseId}/groups/${a.groupSetId}`}>{d.gsChangeWho}</Link></>}
                  {sets.length > 0 && <> · <Link href={`/courses/${a.courseId}/groups`}>{d.gsAllSaved}</Link></>}
                </p>
                <GroupSetMaker courseId={a.courseId} d={d} onMade={(g) => { setSets((s) => [g, ...s]); set({ groupSetId: g.id }); }} />
              </div>
              {a.groupSetId && a.kind === "online" && (
                <>
                  <fieldset className="fieldset" style={{ border: 0, padding: 0 }}>
                    <legend className="flabel" style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{d.gaHandIn}</legend>
                    <label className="check" style={{ whiteSpace: "normal" }}><input type="radio" name="ga-mode" checked={a.groupHandIn === "each"} onChange={() => set({ groupHandIn: "each" })} /> {d.gaEach}</label>
                    <label className="check" style={{ whiteSpace: "normal" }}><input type="radio" name="ga-mode" checked={a.groupHandIn === "one"} onChange={() => set({ groupHandIn: "one" })} /> {d.gaOne}</label>
                  </fieldset>
                  {a.groupHandIn === "one" && (
                    <fieldset className="fieldset" style={{ border: 0, padding: 0 }}>
                      <legend className="flabel" style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{d.gaWho}</legend>
                      <label className="check" style={{ whiteSpace: "normal" }}><input type="radio" name="ga-who" checked={a.groupSubmitter === "group"} onChange={() => set({ groupSubmitter: "group" })} /> {d.gaWhoGroup}</label>
                      <label className="check" style={{ whiteSpace: "normal" }}><input type="radio" name="ga-who" checked={a.groupSubmitter === "teacher"} onChange={() => set({ groupSubmitter: "teacher" })} /> {d.gaWhoTeacher}</label>
                    </fieldset>
                  )}
                  <p className="muted" style={{ margin: "6px 0 0", fontSize: 13 }}>{d.gaSharedText}</p>
                </>
              )}
              {a.groupSetId && <p className="muted" style={{ margin: "6px 0 0", fontSize: 13 }}>{d.gaGradeHint}</p>}
            </div>
          )}

          <button type="button" className="btn" style={{ alignSelf: "flex-start" }} onClick={archive}>{d.archive}</button>
        </aside>
      </div>
    </form>
  );
}
