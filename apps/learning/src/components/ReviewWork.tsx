"use client";

import { useMemo, useRef, useState } from "react";
import type { Dict } from "@/lib/i18n";
import type { PartMarks, Rubric, RubricSection } from "@/lib/rubric";
import { locate, segments } from "@/lib/review";

/** A tag's colour by its section's place, the same on the student's work, the grading panel and the enlarged view. */
export const tagClass = (sectionIndex: number) => `tag-c${sectionIndex % 6}`;

/** Part id → its section's index and the part itself. */
export function partIndex(rubric: Rubric): Map<string, { si: number; section: RubricSection; label: string; question: string; points: number }> {
  const m = new Map<string, { si: number; section: RubricSection; label: string; question: string; points: number }>();
  (rubric.sections ?? []).forEach((s, si) => s.parts.forEach((p) => m.set(p.id, { si, section: s, label: p.label, question: p.question, points: p.points })));
  return m;
}

/**
 * The student's online writing on the review screen (story 01, grade
 * assistant): "Jump to" a section, and each part found in their writing
 * drawn in a box with its coloured tag and points (green when full, red
 * when points are lost). Clicking a box opens that part enlarged.
 */
export default function ReviewWork({ rubric, body, marks, current, onOpen, d }: {
  rubric: Rubric; body: string; marks: PartMarks | null; current: string | null;
  onOpen: (partId: string) => void; d: Dict;
}) {
  const loc = useMemo(() => locate(rubric, body), [rubric, body]);
  const segs = useMemo(() => segments(body, loc), [body, loc]);
  const parts = useMemo(() => partIndex(rubric), [rubric]);
  const box = useRef<HTMLDivElement>(null);
  const [missing, setMissing] = useState("");
  const [boxes, setBoxes] = useState(true);
  const found = Object.keys(loc.parts).length;

  const jump = (s: RubricSection, si: number) => {
    const span = loc.sections[s.id];
    const name = s.title || `${d.prSection} ${si + 1}`;
    if (!span) { setMissing(d.rvNotFound.replace("{name}", name)); return; }
    setMissing("");
    const el = box.current?.querySelector<HTMLElement>(`[data-at="${span.start}"]`) ?? box.current?.querySelector<HTMLElement>(`[data-section="${s.id}"]`);
    el?.scrollIntoView({ block: "start", behavior: "smooth" });
    el?.focus({ preventScroll: true });
  };

  // Where each section starts, so the jump lands on it even between boxes.
  const sectionAt = new Map(Object.entries(loc.sections).map(([id, sp]) => [sp.start, id]));
  let at = 0;

  return (
    <div className="review-work">
      <div className="row review-jump" role="group" aria-label={d.rvJumpTo}>
        <span className="muted" style={{ fontSize: 13 }}>{d.rvJumpTo}</span>
        {(rubric.sections ?? []).map((s, si) => (
          <button key={s.id} type="button" className={`btn btn-sm ${tagClass(si)} tag-btn`} onClick={() => jump(s, si)}>{s.title || `${d.prSection} ${si + 1}`}</button>
        ))}
        {found > 0 && (
          <button type="button" className="btn btn-sm" aria-pressed={!boxes} style={{ marginLeft: "auto" }} onClick={() => setBoxes(!boxes)}>
            {boxes ? d.rvHideBoxes : d.rvShowBoxes}
          </button>
        )}
      </div>
      {missing && <p className="muted" role="status" style={{ fontSize: 13, margin: "6px 0 0" }}>{missing}</p>}
      {found === 0 && <p className="muted" style={{ fontSize: 13, margin: "6px 0 0" }}>{d.rvNoneFound}</p>}
      <div ref={box} className={`work-text review-text${boxes ? "" : " no-boxes"}`}>
        {segs.map((sg, k) => {
          const start = at;
          at += sg.text.length;
          const sec = sectionAt.get(start);
          if (!sg.partId) {
            return <span key={k} data-at={start} data-section={sec} tabIndex={sec ? -1 : undefined}>{sg.text}</span>;
          }
          const p = parts.get(sg.partId)!;
          const v = marks?.[sg.partId]?.score ?? null;
          const state = v === null ? "" : v >= p.points ? "is-full" : "is-lost";
          const name = p.label || d.prPart;
          return (
            <span key={k} data-at={start} data-section={sec} tabIndex={sec ? -1 : undefined}
              className={`answer-box ${tagClass(p.si)} ${state}${current === sg.partId ? " is-current" : ""}`}>
              <button type="button" className="answer-label" onClick={() => onOpen(sg.partId!)}
                aria-label={`${d.rvOpen} ${name}: ${v === null ? d.notScored : `${v} / ${p.points}`}`}>
                {name} · {v === null ? "—" : v}/{p.points}
              </button>
              {sg.text}
            </span>
          );
        })}
      </div>
    </div>
  );
}
