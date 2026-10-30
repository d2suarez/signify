"use client";

import Link from "next/link";
import { useId, useState } from "react";
import type { Dict } from "@/lib/i18n";

/** A course standard as the pickers show it; `source` is the framework it came from. */
export type StandardOption = { id: string; name: string; description: string; source?: string };

/**
 * Choose which of the course's standards something addresses (a lesson, an
 * assignment). Ticked ones are listed first; a filter box appears once the
 * list is long. New standards come from the library, through `addHref`.
 */
export default function StandardsPicker({ options, value, onChange, addHref, legend, hint, d }: {
  options: StandardOption[]; value: string[]; onChange: (ids: string[]) => void;
  addHref: string; legend: string; hint?: string;
  d: Pick<Dict, "filterStandards" | "noStandardsInCourse" | "findInLibrary" | "chosenCount">;
}) {
  const [q, setQ] = useState("");
  const id = useId();
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const match = (o: StandardOption) => words.every((w) => `${o.name} ${o.description} ${o.source ?? ""}`.toLowerCase().includes(w));
  const chosen = options.filter((o) => value.includes(o.id));
  const rest = options.filter((o) => !value.includes(o.id) && match(o));
  const toggle = (sid: string, on: boolean) => onChange(on ? [...value, sid] : value.filter((x) => x !== sid));

  const row = (o: StandardOption) => (
    <label key={o.id} className="check std-pick" style={{ whiteSpace: "normal", alignItems: "flex-start" }}>
      <input type="checkbox" checked={value.includes(o.id)} onChange={(e) => toggle(o.id, e.target.checked)} />
      <span>
        <b>{o.name}</b>{o.description && o.description !== o.name ? ` · ${o.description}` : ""}
        {o.source && <span className="muted" style={{ fontSize: 12, display: "block" }}>{o.source}</span>}
      </span>
    </label>
  );

  return (
    <fieldset className="card stack" style={{ gap: 6 }} aria-describedby={hint ? `${id}-hint` : undefined}>
      <legend className="label" style={{ float: "left", padding: 0 }}>{legend}</legend>
      {hint && <p id={`${id}-hint`} className="muted" style={{ margin: 0, fontSize: 13, clear: "both" }}>{hint}</p>}
      {options.length === 0 ? (
        <p className="empty" style={{ margin: 0, clear: "both" }}>{d.noStandardsInCourse} <Link href={addHref}>{d.findInLibrary}</Link></p>
      ) : (
        <>
          {chosen.length > 0 && (
            <div className="stack" style={{ gap: 4, clear: "both" }}>
              <span className="muted" style={{ fontSize: 13 }} aria-live="polite">{d.chosenCount.replace("{n}", String(chosen.length))}</span>
              {chosen.map(row)}
            </div>
          )}
          {options.length > 8 && (
            <input type="search" className="field" value={q} onChange={(e) => setQ(e.target.value)} placeholder={d.filterStandards} aria-label={d.filterStandards} style={{ clear: "both" }} />
          )}
          <div className="stack std-pick-list" style={{ gap: 4, maxHeight: 320, overflowY: "auto", clear: "both" }}>
            {rest.map(row)}
          </div>
          <Link href={addHref} style={{ fontSize: 14 }}>{d.findInLibrary}</Link>
        </>
      )}
    </fieldset>
  );
}

/** <option>s for a one-standard <select> (a rubric row, a quiz question), grouped by where each came from. */
export function StandardOptionList({ options }: { options: StandardOption[] }) {
  const groups = new Map<string, StandardOption[]>();
  for (const o of options) {
    const k = o.source ?? "";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(o);
  }
  const opt = (o: StandardOption) => {
    const text = o.description && o.description !== o.name ? `${o.name} · ${o.description}` : o.name;
    return <option key={o.id} value={o.id}>{text.length > 110 ? text.slice(0, 109) + "…" : text}</option>;
  };
  if (groups.size <= 1) return <>{options.map(opt)}</>;
  return <>{[...groups].map(([k, list]) => <optgroup key={k} label={k || "—"}>{list.map(opt)}</optgroup>)}</>;
}
