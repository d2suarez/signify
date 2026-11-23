"use client";

import type React from "react";
import { useEffect, useMemo, useRef } from "react";
import type { Dict } from "@/lib/i18n";
import { RUBRIC_LIMITS, type PartMarks, type PartNotes, type Rubric } from "@/lib/rubric";
import { locate } from "@/lib/review";
import { PartStepper, withMark, withNote } from "./PartsGrader";
import { partIndex, tagClass } from "./ReviewWork";

/**
 * One part enlarged, in front of everything (story 01, grade assistant):
 * the student's answer big on one side; the worksheet question, the score
 * with − / +, the message to the student and the teacher's note on the
 * other, so the answer and the feedback are read together. Previous/next
 * part; Esc, Close or a click outside closes it.
 */
export default function PartZoom({ rubric, partId, body, marks, notes, onMarks, onNotes, onPart, onClose, extra, d }: {
  rubric: Rubric; partId: string | null; body: string | null;
  marks: PartMarks | null; notes: PartNotes | null;
  onMarks: (m: PartMarks | null) => void; onNotes: (n: PartNotes | null) => void;
  onPart: (partId: string) => void; onClose: () => void;
  extra?: (partId: string) => React.ReactNode; d: Dict;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const parts = useMemo(() => partIndex(rubric), [rubric]);
  const order = useMemo(() => [...parts.keys()], [parts]);
  const loc = useMemo(() => locate(rubric, body), [rubric, body]);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (partId && !el.open) el.showModal();
    if (!partId && el.open) el.close();
  }, [partId]);

  const p = partId ? parts.get(partId) : null;
  const k = partId ? order.indexOf(partId) : -1;
  const span = partId ? loc.parts[partId] : undefined;
  const sec = p ? loc.sections[p.section.id] : undefined;
  const answer = body ? (span ? body.slice(span.start, span.end) : sec ? body.slice(sec.start, sec.end) : body) : null;
  const v = partId ? marks?.[partId]?.score ?? null : null;
  const state = !p || v === null ? "" : v >= p.points ? "is-full" : "is-lost";
  const name = p ? p.label || d.prPart : "";

  return (
    <dialog ref={dialog} className="dialog part-zoom" aria-labelledby="zoom-title" onClose={onClose}
      onClick={(e) => { if (e.target === dialog.current) dialog.current?.close(); }}>
      {p && partId && (
        <div className="part-zoom-in">
          <div className="row" style={{ gap: 8 }}>
            <h2 id="zoom-title" className="grow" style={{ fontSize: 20 }}>
              <span className={`part-tag ${tagClass(p.si)}`}>{name}</span> {p.section.title}
            </h2>
            <button type="button" className="btn btn-sm" disabled={k <= 0} onClick={() => onPart(order[k - 1])}>← {d.rvPrevPart}</button>
            <button type="button" className="btn btn-sm" disabled={k >= order.length - 1} onClick={() => onPart(order[k + 1])}>{d.rvNextPart} →</button>
            <button type="button" className="btn btn-sm" onClick={() => dialog.current?.close()}>{d.close}</button>
          </div>
          <div className="part-zoom-body">
            <section className={`part-zoom-answer answer-box ${tagClass(p.si)} ${state}`} aria-label={d.rvTheirAnswer}>
              {answer === null ? <p className="muted">{d.rvNoWritingHere}</p>
                : <>
                  {!span && <p className="muted" style={{ fontSize: 13, margin: "0 0 8px" }}>{sec ? d.rvShowingSection : d.rvShowingAll}</p>}
                  <div className="part-zoom-text">{answer || "—"}</div>
                </>}
            </section>
            <div className={`part-grade ${state}`}>
              {p.question && <p className="part-question" style={{ fontSize: 16 }}>{p.question}</p>}
              <div className="row" style={{ gap: 6, alignItems: "center" }}>
                <PartStepper name={name} points={p.points} value={v} onChange={(x) => onMarks(withMark(marks, partId, { score: x }))} d={d} />
              </div>
              {extra?.(partId)}
              <label className="part-field">
                <span>{d.prMessage}</span>
                <textarea className="field" rows={3} maxLength={RUBRIC_LIMITS.message} value={marks?.[partId]?.message ?? ""}
                  onChange={(e) => onMarks(withMark(marks, partId, { message: e.target.value }))} />
              </label>
              <label className="part-field">
                <span>{d.prNote}</span>
                <textarea className="field" rows={2} maxLength={RUBRIC_LIMITS.message} value={notes?.[partId] ?? ""}
                  onChange={(e) => onNotes(withNote(notes, partId, e.target.value))} />
              </label>
            </div>
          </div>
        </div>
      )}
    </dialog>
  );
}
