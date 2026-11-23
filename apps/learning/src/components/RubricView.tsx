"use client";

import type { Dict } from "@/lib/i18n";
import { isParts, partsScore, rubricMax, rubricScore, sectionPoints, type PartMarks, type Rubric, type RubricSelection } from "@/lib/rubric";

/**
 * A rubric. For a student, a table: one row per criterion, its levels across,
 * the chosen level marked with a tick and a word, never colour alone. With
 * `onPick` (grading), each criterion stacked with its levels as toggle buttons.
 */
export default function RubricView({ rubric, selection, onPick, marks, d }: {
  rubric: Rubric; selection: RubricSelection | null; onPick?: (criterionId: string, levelId: string | null) => void;
  /** A sections-and-parts rubric: the student's part scores and messages, once released. */
  marks?: PartMarks | null; d: Dict;
}) {
  if (isParts(rubric)) return <PartsView rubric={rubric} marks={marks ?? null} d={d} />;
  const { score, complete } = rubricScore(rubric, selection);
  const total = (
    <p className="muted" style={{ margin: "6px 0 0", fontSize: 13 }}>
      {d.rubricTotal}: <b>{score ?? "—"}</b> / {rubricMax(rubric)}{score !== null && !complete ? ` · ${d.rubricIncomplete}` : ""}
    </p>
  );
  if (onPick) {
    // Grading sits in a narrow column: each criterion stacked, its levels as toggle buttons.
    return (
      <div className="rubric-pick">
        {rubric.criteria.map((c) => (
          <fieldset key={c.id}>
            <legend><b>{c.title || d.criterion}</b></legend>
            <div className="rubric-pick-levels">
              {c.levels.map((l) => {
                const on = selection?.[c.id] === l.id;
                return (
                  <button key={l.id} type="button" aria-pressed={on} title={l.description || undefined}
                    onClick={() => onPick(c.id, on ? null : l.id)}>
                    <span className="rubric-pts">{on ? "✓ " : ""}{l.points}</span>
                    {l.title && <span>{l.title}</span>}
                  </button>
                );
              })}
            </div>
          </fieldset>
        ))}
        {total}
      </div>
    );
  }
  return (
    <div className="rubric">
      <table>
        <caption className="sr-only">{d.rubric}</caption>
        <tbody>
          {rubric.criteria.map((c) => (
            <tr key={c.id}>
              <th scope="row">
                <b>{c.title || d.criterion}</b>
                {c.description && <span className="rubric-desc">{c.description}</span>}
              </th>
              {c.levels.map((l) => {
                const on = selection?.[c.id] === l.id;
                const body = (
                  <>
                    <span className="rubric-pts">{l.points}</span>
                    {l.title && <b>{l.title}</b>}
                    {l.description && <span className="rubric-desc">{l.description}</span>}
                    {on && <span className="rubric-chosen">✓ {d.rubricChosen}</span>}
                  </>
                );
                return (
                  <td key={l.id} className={on ? "is-on" : undefined}>{body}</td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {total}
    </div>
  );
}

/**
 * A sections-and-parts rubric, read-only: each section with its parts'
 * questions and points; with marks, the part's score (in words as well as
 * colour) and the teacher's message about it.
 */
function PartsView({ rubric, marks, d }: { rubric: Rubric; marks: PartMarks | null; d: Dict }) {
  const { score, complete } = partsScore(rubric, marks);
  return (
    <div className="parts-view stack" style={{ gap: 12 }}>
      {rubric.sections!.map((s, i) => {
        const got = s.parts.reduce((n, p) => n + (marks?.[p.id]?.score ?? 0), 0);
        return (
          <section key={s.id} className="parts-section" aria-label={s.title || `${d.prSection} ${i + 1}`}>
            <p className="row" style={{ margin: 0 }}>
              <b className="grow">{s.title || `${d.prSection} ${i + 1}`}</b>
              <span className="muted" style={{ fontSize: 13 }}>{marks ? `${Math.round(got * 100) / 100} / ` : ""}{sectionPoints(s)} {d.pts}</span>
            </p>
            <ul className="parts-list">
              {s.parts.map((p) => {
                const m = marks?.[p.id];
                const full = m && m.score !== null && m.score >= p.points;
                const lost = m && m.score !== null && m.score < p.points;
                return (
                  <li key={p.id} className={full ? "is-full" : lost ? "is-lost" : undefined}>
                    <div className="row" style={{ alignItems: "baseline", gap: 8 }}>
                      {p.label && <span className="part-tag">{p.label}</span>}
                      <span className="grow" style={{ whiteSpace: "pre-wrap" }}>{p.question}</span>
                      <span className="part-score">
                        {m && m.score !== null ? `${m.score} / ${p.points}` : `${p.points} ${d.pts}`}
                        {full && <span className="sr-only"> {d.prFull}</span>}
                        {lost && <span className="sr-only"> {d.prLost}</span>}
                      </span>
                    </div>
                    {m?.message && <p className="part-message">{m.message}</p>}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        {d.rubricTotal}: <b>{marks ? score ?? "—" : "—"}</b> / {rubricMax(rubric)}{marks && score !== null && !complete ? ` · ${d.rubricIncomplete}` : ""}
      </p>
    </div>
  );
}
