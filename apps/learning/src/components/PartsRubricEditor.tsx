"use client";

import { newId } from "@/lib/blocks";
import type { Dict } from "@/lib/i18n";
import { changedParts, newSection, quarter, rubricMax, RUBRIC_LIMITS, sectionPoints, type Rubric, type RubricPart, type RubricSection } from "@/lib/rubric";

/**
 * Writing a sections-and-parts rubric (story 01, grade assistant): sections
 * down, each with 2–5 parts; each part keeps the worksheet's exact question
 * and is worth quarter points. A section's points are its parts added up,
 * and the rubric's total is the assignment's points. The point values are
 * always the teacher's: nothing is assumed from another assignment.
 */
export default function PartsRubricEditor({ rubric, onChange, saved = null, graded = false, d }: {
  rubric: Rubric; onChange: (r: Rubric | null) => void;
  /** The rubric as last saved, and whether students are graded with it: removing or changing a part then warns. */
  saved?: Rubric | null; graded?: boolean; d: Dict;
}) {
  const sections = rubric.sections ?? [];
  // Part ids stay the same across edits (new parts get new ids), so marks follow their part.
  const changed = graded ? changedParts(saved, rubric) : [];
  const put = (next: RubricSection[]) => onChange(next.length ? { kind: "parts", criteria: [], sections: next } : null);
  const setSection = (i: number, patch: Partial<RubricSection>) => put(sections.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const setPart = (i: number, k: number, patch: Partial<RubricPart>) =>
    setSection(i, { parts: sections[i].parts.map((p, m) => (m === k ? { ...p, ...patch } : p)) });
  const nextLabel = (i: number, s: RubricSection) => `${i + 1}${String.fromCharCode(97 + s.parts.length)}`;

  return (
    <div className="card stack" style={{ gap: 12 }}>
      <div className="row">
        <p className="label grow">{d.prTitle}</p>
        <span className="muted" style={{ fontSize: 13 }}>{d.rubricTotal}: <b>{rubricMax(rubric)}</b> {d.pts}</span>
        <button type="button" className="btn btn-sm" onClick={() => { if (confirm(d.rubricRemoveConfirm)) onChange(null); }}>{d.rubricRemove}</button>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>{d.prEditHint}</p>
      {changed.length > 0 && (
        <p className="notice" role="status" style={{ margin: 0, fontSize: 14 }}>
          {d.prGradedChanged.replace("{parts}", changed.map((p) => p.label || d.prPart).join(", "))}
        </p>
      )}
      {sections.map((s, i) => (
        <fieldset key={s.id} className="rubric-edit">
          <legend className="sr-only">{d.prSection} {i + 1}</legend>
          <div className="row" style={{ alignItems: "flex-end" }}>
            <div className="fieldset grow" style={{ flex: "1 1 220px", marginTop: 0 }}>
              <label htmlFor={`ps-${s.id}`}>{d.prSection} {i + 1}</label>
              <input id={`ps-${s.id}`} className="field" value={s.title} maxLength={RUBRIC_LIMITS.title} placeholder={d.prSectionPlaceholder}
                onChange={(e) => setSection(i, { title: e.target.value })} />
            </div>
            <span className="muted" style={{ fontSize: 13, paddingBottom: 12 }}><b>{sectionPoints(s)}</b> {d.pts}</span>
            <button type="button" className="btn btn-sm" onClick={() => put(sections.filter((_, j) => j !== i))}
              aria-label={`${d.delete}: ${d.prSection} ${i + 1}`}>{d.delete}</button>
          </div>
          {s.parts.length < RUBRIC_LIMITS.minParts && <p className="notice" style={{ margin: "6px 0 0", fontSize: 14 }}>{d.prTooFew}</p>}
          <div className="stack" style={{ gap: 8, marginTop: 8 }}>
            {s.parts.map((p, k) => (
              <div key={p.id} className="part-edit">
                <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                  <label className="sr-only" htmlFor={`pl-${p.id}`}>{d.prLabel}</label>
                  <input id={`pl-${p.id}`} className="field part-label" value={p.label} maxLength={RUBRIC_LIMITS.partLabel}
                    onChange={(e) => setPart(i, k, { label: e.target.value })} />
                  <label className="sr-only" htmlFor={`pp-${p.id}`}>{d.prPoints} {p.label}</label>
                  <input id={`pp-${p.id}`} type="number" min={0} max={RUBRIC_LIMITS.partPoints} step={0.25} className="field part-points" value={p.points}
                    onChange={(e) => setPart(i, k, { points: Number(e.target.value) })}
                    onBlur={(e) => setPart(i, k, { points: quarter(e.target.value) })} />
                  <span className="muted" style={{ fontSize: 13 }}>{d.pts}</span>
                  <span className="grow" />
                  <button type="button" className="btn btn-sm" onClick={() => setSection(i, { parts: s.parts.filter((_, m) => m !== k) })}
                    aria-label={`${d.delete}: ${p.label || d.prPart}`}>×</button>
                </div>
                <label className="sr-only" htmlFor={`pq-${p.id}`}>{d.prQuestion} {p.label}</label>
                <textarea id={`pq-${p.id}`} className="field" rows={2} value={p.question} maxLength={RUBRIC_LIMITS.question} placeholder={d.prQuestionPlaceholder}
                  onChange={(e) => setPart(i, k, { question: e.target.value })} />
              </div>
            ))}
            {s.parts.length < RUBRIC_LIMITS.maxParts && (
              <button type="button" className="btn btn-sm" style={{ alignSelf: "flex-start" }}
                onClick={() => setSection(i, { parts: [...s.parts, { id: newId(), label: nextLabel(i, s), question: "", points: 1 }] })}>{d.prAddPart}</button>
            )}
          </div>
        </fieldset>
      ))}
      {sections.length < RUBRIC_LIMITS.sections && (
        <button type="button" className="btn" style={{ alignSelf: "flex-start" }} onClick={() => put([...sections, newSection(sections.length + 1)])}>{d.prAddSection}</button>
      )}
    </div>
  );
}
