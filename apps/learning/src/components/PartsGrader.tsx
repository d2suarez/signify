"use client";

import type React from "react";

import type { Dict } from "@/lib/i18n";
import { RUBRIC_LIMITS, type PartMarks, type PartNotes, type Rubric } from "@/lib/rubric";

import { tagClass } from "./ReviewWork";

export const STEP = 0.25;
export const round = (n: number) => Math.round(n * 100) / 100;

/** A part's mark changed: an empty mark (no score, no message) is dropped. */
export function withMark(marks: PartMarks | null, id: string, patch: Partial<{ score: number | null; message: string }>): PartMarks | null {
  const cur = marks?.[id] ?? { score: null, message: "" };
  const next = { ...(marks ?? {}), [id]: { ...cur, ...patch } };
  if (next[id].score === null && !next[id].message) delete next[id];
  return Object.keys(next).length ? next : null;
}
export function withNote(notes: PartNotes | null, id: string, v: string): PartNotes | null {
  const next = { ...(notes ?? {}), [id]: v };
  if (!v) delete next[id];
  return Object.keys(next).length ? next : null;
}

/** − / + for one part (quarter points), its score and what it means in words; green when full, red when points are lost. */
export function PartStepper({ name, points, value, onChange, d }: {
  name: string; points: number; value: number | null; onChange: (v: number | null) => void; d: Dict;
}) {
  const v = value;
  return (
    <>
      <button type="button" className="btn btn-sm part-step" aria-label={`${d.prLess} ${name}`} disabled={v === 0}
        onClick={() => onChange(round(Math.max(0, (v ?? points) - STEP)))}>−</button>
      <output className="part-score" aria-live="polite" aria-label={`${name}: ${v === null ? d.notScored : `${v} / ${points}`}`}>
        {v === null ? "—" : v} / {points}
      </output>
      <button type="button" className="btn btn-sm part-step" aria-label={`${d.prMore} ${name}`} disabled={v !== null && v >= points}
        onClick={() => onChange(round(Math.min(points, v === null ? points : v + STEP)))}>+</button>
      <span className="part-state">
        {v === null ? d.notScored : v >= points ? `✓ ${d.prFull}` : `${d.prLost} ${round(points - v)}`}
      </span>
    </>
  );
}

/**
 * Scoring a sections-and-parts rubric on the grading desk (story 01, grade
 * assistant, no AI): per part, − / + in quarter points, green when full and
 * red when points are lost (said in words too), the teacher's own note and
 * the message to the student. Section totals update as scores change.
 */
export default function PartsGrader({ rubric, marks, notes, onMarks, onNotes, onOpen, extra, d }: {
  rubric: Rubric; marks: PartMarks | null; notes: PartNotes | null;
  onMarks: (m: PartMarks | null) => void; onNotes: (n: PartNotes | null) => void;
  /** The review screen: opening a part shows its answer enlarged. */
  onOpen?: (partId: string) => void;
  /** The review screen: anything to show under a part's question (a suggestion). */
  extra?: (partId: string) => React.ReactNode;
  d: Dict;
}) {
  const setMark = (id: string, patch: Partial<{ score: number | null; message: string }>) => onMarks(withMark(marks, id, patch));
  const setNote = (id: string, v: string) => onNotes(withNote(notes, id, v));

  return (
    <div className="parts-grade stack" style={{ gap: 12 }}>
      {rubric.sections!.map((s, i) => {
        const got = round(s.parts.reduce((n, p) => n + (marks?.[p.id]?.score ?? 0), 0));
        const max = round(s.parts.reduce((n, p) => n + p.points, 0));
        return (
          <fieldset key={s.id} className="parts-section" id={`grade-sec-${s.id}`}>
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
                    {onOpen
                      ? <button type="button" className={`part-tag ${tagClass(i)} tag-open`} onClick={() => onOpen(p.id)} aria-label={`${d.rvOpen} ${name}`}>{name}</button>
                      : <span className={`part-tag ${tagClass(i)}`}>{name}</span>}
                    <PartStepper name={name} points={p.points} value={v} onChange={(x) => setMark(p.id, { score: x })} d={d} />
                    {v !== null && (
                      <button type="button" className="btn btn-sm" style={{ marginLeft: "auto" }} onClick={() => setMark(p.id, { score: null })}
                        aria-label={`${d.prClear} ${name}`}>{d.prClear}</button>
                    )}
                  </div>
                  {p.question && (onOpen
                    ? <button type="button" className="part-question part-question-btn" onClick={() => onOpen(p.id)}>{p.question}</button>
                    : <p className="part-question">{p.question}</p>)}
                  {extra?.(p.id)}
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
