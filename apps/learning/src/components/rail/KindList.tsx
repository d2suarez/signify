"use client";

import { useId, useState } from "react";
import type { Dict } from "@/lib/i18n";
import { ROSTER_KINDS, type WidgetKind } from "@/lib/widgets";

/**
 * An ordered list of tools with Move up / Move down / Remove on each and an
 * "Add a tool" choice below: the rail's Change tools, a class's students'
 * defaults and the school's page all use it. Every control is a real
 * button or select with its own words (44px targets).
 */
export function KindList({ kinds, candidates, onChange, d, label, markStaffOnly = false, disabled = false }: {
  kinds: WidgetKind[];
  /** Everything that could be in the list (what's not in it can be added). */
  candidates: readonly WidgetKind[];
  onChange: (next: WidgetKind[]) => void;
  d: Dict;
  label: string;
  markStaffOnly?: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  const addable = candidates.filter((k) => !kinds.includes(k));
  const [toAdd, setToAdd] = useState<WidgetKind | "">("");
  const pick = toAdd && addable.includes(toAdd) ? toAdd : addable[0] ?? "";
  const move = (i: number, by: number) => {
    const next = kinds.slice();
    const [k] = next.splice(i, 1);
    next.splice(i + by, 0, k);
    onChange(next);
  };
  const name = (k: WidgetKind) => d[`wg_${k}`];
  return (
    <div className="kind-list stack" style={{ gap: 8 }}>
      <h3 className="todo-head" id={`${id}-l`}>{label}</h3>
      {kinds.length === 0 ? <p className="muted" style={{ margin: 0, fontSize: 14 }}>{d.wgEmptyList}</p> : (
        <ol className="kind-rows" aria-labelledby={`${id}-l`}>
          {kinds.map((k, i) => (
            <li key={k} className="kind-row">
              <span className={`shape ${k === "clock" || k === "timer" ? "s-circle" : "s-square"}`} aria-hidden="true" />
              <span className="grow">{name(k)}{markStaffOnly && ROSTER_KINDS.has(k) && <span className="muted"> · {d.wgStaffOnly}</span>}</span>
              <button type="button" className="btn btn-sm icon-btn" disabled={disabled || i === 0} onClick={() => move(i, -1)}
                aria-label={`${d.wgUp}: ${name(k)}`} title={d.wgUp}>↑</button>
              <button type="button" className="btn btn-sm icon-btn" disabled={disabled || i === kinds.length - 1} onClick={() => move(i, 1)}
                aria-label={`${d.wgDown}: ${name(k)}`} title={d.wgDown}>↓</button>
              <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => onChange(kinds.filter((x) => x !== k))}
                aria-label={`${d.wgRemove}: ${name(k)}`}>{d.wgRemove}</button>
            </li>
          ))}
        </ol>
      )}
      {addable.length > 0 && (
        <div className="row" style={{ gap: 6 }}>
          <label className="sr-only" htmlFor={`${id}-add`}>{d.wgAdd}</label>
          <select id={`${id}-add`} className="field grow" value={pick} disabled={disabled} onChange={(e) => setToAdd(e.target.value as WidgetKind)}>
            {addable.map((k) => <option key={k} value={k}>{name(k)}{markStaffOnly && ROSTER_KINDS.has(k) ? ` · ${d.wgStaffOnly}` : ""}</option>)}
          </select>
          <button type="button" className="btn btn-sm" disabled={disabled || !pick} onClick={() => { if (pick) { onChange([...kinds, pick]); setToAdd(""); } }}>
            {d.wgAddBtn}
          </button>
        </div>
      )}
    </div>
  );
}
