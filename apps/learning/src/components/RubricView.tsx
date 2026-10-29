"use client";

import type { Dict } from "@/lib/i18n";
import { rubricMax, rubricScore, type Rubric, type RubricSelection } from "@/lib/rubric";

/**
 * A rubric. For a student, a table: one row per criterion, its levels across,
 * the chosen level marked with a tick and a word, never colour alone. With
 * `onPick` (grading), each criterion stacked with its levels as toggle buttons.
 */
export default function RubricView({ rubric, selection, onPick, d }: {
  rubric: Rubric; selection: RubricSelection | null; onPick?: (criterionId: string, levelId: string | null) => void; d: Dict;
}) {
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
