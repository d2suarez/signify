"use client";

import { useActionState } from "react";
import type { Dict } from "@/lib/i18n";
import type { SourceContents } from "@/lib/sections";
import type { CopyState } from "@/app/courses/[id]/section-actions";

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""));

/** Ticks of a source class's units, lessons and assignments, copied in one go. */
export function CopyForm({ courseId, from, contents, action, d }: {
  courseId: string; from: string; contents: SourceContents;
  action: (prev: CopyState, f: FormData) => Promise<CopyState>;
  d: Dict;
}) {
  const [state, run, pending] = useActionState(action, null);
  const groups = [...contents.units.map((u) => ({ unit: u as { id: string; title: string } | null })), { unit: null }];
  return (
    <form action={run} className="stack" style={{ gap: 12 }}>
      <input type="hidden" name="courseId" value={courseId} />
      <input type="hidden" name="from" value={from} />
      {groups.map(({ unit }) => {
        const lessons = contents.lessons.filter((l) => (l.unitId || null) === (unit?.id ?? null) || (!unit && l.unitId && !contents.units.some((u) => u.id === l.unitId)));
        const assignments = contents.assignments.filter((a) => (a.unitId || null) === (unit?.id ?? null) || (!unit && a.unitId && !contents.units.some((u) => u.id === a.unitId)));
        if (!unit && lessons.length === 0 && assignments.length === 0) return null;
        return (
          <fieldset key={unit?.id || "loose"} className="card stack" style={{ gap: 6, margin: 0 }}>
            <legend className="label" style={{ padding: "0 4px" }}>
              <span className="shape s-square" style={{ marginRight: 8 }} />{unit ? unit.title : d.noUnit}
            </legend>
            {unit && (
              <label className="check-row">
                <input type="checkbox" name="unit" value={unit.id} /> <strong>{d.secWholeUnit}</strong>
              </label>
            )}
            {lessons.map((l) => (
              <label key={l.id} className="check-row">
                <input type="checkbox" name="lesson" value={l.id} /> <span className="shape s-arch" aria-hidden="true" /> {l.title}
                <span className="sr-only"> ({d.lesson})</span>
              </label>
            ))}
            {assignments.map((a) => (
              <label key={a.id} className="check-row">
                <input type="checkbox" name="assignment" value={a.id} /> <span className="shape s-tri" aria-hidden="true" /> {a.title}
                <span className="muted" style={{ fontSize: 13 }}> · {a.kind === "quiz" ? d.kindQuiz : a.kind === "offline" ? d.kindOffline : d.kindOnline}</span>
              </label>
            ))}
          </fieldset>
        );
      })}
      <button className="btn btn-primary" type="submit" disabled={pending} style={{ alignSelf: "flex-start" }}>{d.secCopyGo}</button>
      <div aria-live="polite">
        {state?.ok && (
          <div className="notice" role="status">
            <p style={{ margin: 0 }}>{fill(d.secCopied, state.result)}</p>
            {(state.result.standards + state.result.categories + state.result.tools) > 0 && <p style={{ margin: 0 }}>{fill(d.secCopiedExtra, state.result)}</p>}
            <p style={{ margin: 0 }}><a href={`/courses/${courseId}`}>{d.plan} →</a></p>
          </div>
        )}
        {state && !state.ok && (
          <div className="notice notice-bad" role="alert">{state.error === "nothing" ? d.secCopyNothing : d.secCopyRefused}</div>
        )}
      </div>
    </form>
  );
}
