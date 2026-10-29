"use client";

import { newId } from "@/lib/blocks";
import type { Dict } from "@/lib/i18n";
import { newCriterion, rubricMax, RUBRIC_LIMITS, type Rubric, type RubricCriterion, type RubricLevel } from "@/lib/rubric";

/** Writing an assignment's rubric: criteria down, levels across, each level worth points. */
export default function RubricEditor({ rubric, onChange, standards, d }: {
  rubric: Rubric | null; onChange: (r: Rubric | null) => void;
  /** In a standards course, each row may measure one of these. */
  standards?: { id: string; name: string }[]; d: Dict;
}) {
  if (!rubric) {
    return (
      <div className="card stack" style={{ gap: 8 }}>
        <p className="label">{d.rubric}</p>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>{d.rubricHint}</p>
        <button type="button" className="btn" style={{ alignSelf: "flex-start" }} onClick={() => onChange({ criteria: [newCriterion()] })}>{d.rubricAdd}</button>
      </div>
    );
  }

  const setCriterion = (i: number, patch: Partial<RubricCriterion>) =>
    onChange({ criteria: rubric.criteria.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const setLevel = (i: number, k: number, patch: Partial<RubricLevel>) =>
    setCriterion(i, { levels: rubric.criteria[i].levels.map((l, m) => (m === k ? { ...l, ...patch } : l)) });
  const removeCriterion = (i: number) => {
    const rest = rubric.criteria.filter((_, j) => j !== i);
    onChange(rest.length ? { criteria: rest } : null);
  };

  return (
    <div className="card stack" style={{ gap: 12 }}>
      <div className="row">
        <p className="label grow">{d.rubric}</p>
        <span className="muted" style={{ fontSize: 13 }}>{d.rubricTotal}: <b>{rubricMax(rubric)}</b> {d.pts}</span>
        <button type="button" className="btn btn-sm" onClick={() => { if (confirm(d.rubricRemoveConfirm)) onChange(null); }}>{d.rubricRemove}</button>
      </div>
      {rubric.criteria.map((c, i) => (
        <fieldset key={c.id} className="rubric-edit">
          <legend className="sr-only">{d.criterion} {i + 1}</legend>
          <div className="row" style={{ alignItems: "flex-end" }}>
            <div className="fieldset grow" style={{ flex: "1 1 220px", marginTop: 0 }}>
              <label htmlFor={`rc-${c.id}`}>{d.criterion} {i + 1}</label>
              <input id={`rc-${c.id}`} className="field" value={c.title} maxLength={RUBRIC_LIMITS.title} placeholder={d.criterionPlaceholder}
                onChange={(e) => setCriterion(i, { title: e.target.value })} />
            </div>
            {standards && standards.length > 0 && (
              <div className="fieldset" style={{ flex: "0 1 180px", marginTop: 0 }}>
                <label htmlFor={`rs-${c.id}`}>{d.rubricStandard}</label>
                <select id={`rs-${c.id}`} className="field" value={c.standardId || ""}
                  onChange={(e) => setCriterion(i, { standardId: e.target.value || undefined })}>
                  <option value="">{d.noStandard}</option>
                  {standards.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            )}
            <button type="button" className="btn btn-sm" onClick={() => removeCriterion(i)} aria-label={`${d.delete}: ${d.criterion} ${i + 1}`}>{d.delete}</button>
          </div>
          <div className="rubric-levels">
            {c.levels.map((l, k) => (
              <div key={l.id} className="rubric-level">
                <label className="sr-only" htmlFor={`rl-${l.id}-p`}>{d.points}</label>
                <input id={`rl-${l.id}-p`} type="number" min={0} max={RUBRIC_LIMITS.maxLevelPoints} step="any" className="field" value={l.points}
                  onChange={(e) => setLevel(i, k, { points: Number(e.target.value) })} />
                <label className="sr-only" htmlFor={`rl-${l.id}-t`}>{d.levelName}</label>
                <input id={`rl-${l.id}-t`} className="field" value={l.title} maxLength={RUBRIC_LIMITS.levelTitle} placeholder={d.levelName}
                  onChange={(e) => setLevel(i, k, { title: e.target.value })} />
                <label className="sr-only" htmlFor={`rl-${l.id}-d`}>{d.levelDescription}</label>
                <textarea id={`rl-${l.id}-d`} className="field" rows={2} value={l.description} maxLength={RUBRIC_LIMITS.description} placeholder={d.levelDescription}
                  onChange={(e) => setLevel(i, k, { description: e.target.value })} />
                {c.levels.length > 1 && (
                  <button type="button" className="btn btn-sm" onClick={() => setCriterion(i, { levels: c.levels.filter((_, m) => m !== k) })}
                    aria-label={`${d.delete}: ${l.title || l.points}`}>×</button>
                )}
              </div>
            ))}
            {c.levels.length < RUBRIC_LIMITS.levels && (
              <button type="button" className="btn btn-sm" style={{ alignSelf: "flex-start" }}
                onClick={() => setCriterion(i, { levels: [...c.levels, { id: newId(), title: "", points: 0, description: "" }] })}>{d.levelAdd}</button>
            )}
          </div>
        </fieldset>
      ))}
      {rubric.criteria.length < RUBRIC_LIMITS.criteria && (
        <button type="button" className="btn" style={{ alignSelf: "flex-start" }} onClick={() => onChange({ criteria: [...rubric.criteria, newCriterion()] })}>{d.criterionAdd}</button>
      )}
    </div>
  );
}
