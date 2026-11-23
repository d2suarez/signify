"use client";

import type { Dict } from "@/lib/i18n";
import { RUBRIC_LIMITS, type PartMarks, type PartNotes, type Rubric } from "@/lib/rubric";

const STEP = 0.25;
const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Scoring a sections-and-parts rubric on the grading desk (story 01, grade
 * assistant, no AI): per part, − / + in quarter points, green when full and
 * red when points are lost (said in words too), the teacher's own note and
 * the message to the student. Section totals update as scores change.
 */
export default function PartsGrader({ rubric, marks, notes, onMarks, onNotes, d }: {
  rubric: Rubric; marks: PartMarks | null; notes: PartNotes | null;
  onMarks: (m: PartMarks | null) => void; onNotes: (n: PartNotes | null) => void; d: Dict;
}) {
  const setMark = (id: string, patch: Partial<{ score: number | null; message: string }>) => {
    const cur = marks?.[id] ?? { score: null, message: "" };
    const next = { ...(marks ?? {}), [id]: { ...cur, ...patch } };
    if (next[id].score === null && !next[id].message) delete next[id];
    onMarks(Object.keys(next).length ? next : null);
  };
  const setNote = (id: string, v: string) => {
    const next = { ...(notes ?? {}), [id]: v };
    if (!v) delete next[id];
    onNotes(Object.keys(next).length ? next : null);
  };

  return (
    <div className="parts-grade stack" style={{ gap: 12 }}>
      {rubric.sections!.map((s, i) => {
        const got = round(s.parts.reduce((n, p) => n + (marks?.[p.id]?.score ?? 0), 0));
        const max = round(s.parts.reduce((n, p) => n + p.points, 0));
        return (
          <fieldset key={s.id} className="parts-section">
            <legend className="row" style={{ width: "100%" }}>
              <b className="grow">{s.title || `${d.prSection} ${i + 1}`}</b>
              <span className="muted" style={{ fontSize: 13 }}>{got} / {max}</span>
            </legend>
            {s.parts.map((p) => {
              const m = marks?.[p.id];
              const v = m?.score ?? null;
              const state = v === null ? "" : v >= p.points ? "is-full" : "is-lost";
              const name = p.label || d.prPart;
              return (
                <div key={p.id} className={`part-grade ${state}`}>
                  <div className="row" style={{ gap: 6, alignItems: "center" }}>
                    <span className="part-tag">{name}</span>
                    <button type="button" className="btn btn-sm part-step" aria-label={`${d.prLess} ${name}`} disabled={v === 0}
                      onClick={() => setMark(p.id, { score: round(Math.max(0, (v ?? p.points) - STEP)) })}>−</button>
                    <output className="part-score" aria-live="polite" aria-label={`${name}: ${v === null ? d.notScored : `${v} / ${p.points}`}`}>
                      {v === null ? "—" : v} / {p.points}
                    </output>
                    <button type="button" className="btn btn-sm part-step" aria-label={`${d.prMore} ${name}`} disabled={v !== null && v >= p.points}
                      onClick={() => setMark(p.id, { score: round(Math.min(p.points, v === null ? p.points : v + STEP)) })}>+</button>
                    <span className="part-state">
                      {v === null ? d.notScored : v >= p.points ? `✓ ${d.prFull}` : `${d.prLost} ${round(p.points - v)}`}
                    </span>
                    {v !== null && (
                      <button type="button" className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => setMark(p.id, { score: null })}
                        aria-label={`${d.prClear} ${name}`}>{d.prClear}</button>
                    )}
                  </div>
                  {p.question && <p className="part-question">{p.question}</p>}
                  <label className="part-field">
                    <span>{d.prMessage}</span>
                    <textarea className="field" rows={2} maxLength={RUBRIC_LIMITS.message} value={m?.message ?? ""}
                      onChange={(e) => setMark(p.id, { message: e.target.value })} />
                  </label>
                  <label className="part-field">
                    <span>{d.prNote}</span>
                    <textarea className="field" rows={1} maxLength={RUBRIC_LIMITS.message} value={notes?.[p.id] ?? ""}
                      onChange={(e) => setNote(p.id, e.target.value)} />
                  </label>
                </div>
              );
            })}
          </fieldset>
        );
      })}
    </div>
  );
}
