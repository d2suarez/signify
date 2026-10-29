"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Dict } from "@/lib/i18n";
import { cellText, computeGrade, letterFor, parseCell, wholePercent, type CalcGrade, type Flag } from "@/lib/grade-math";

type Cell = { score: number | null; flag: Flag | null; comment: string; late: boolean; handedIn: boolean };
type A = { id: string; title: string; points: number; categoryId: string | null; dueOn: string | null; published: boolean };
type R = { id: string; name: string; factsName: string; cells: Record<string, Cell> };
type Cat = { id: string; name: string; weight: number; dropLowest?: number };

const key = (r: string, a: string) => `${r}:${a}`;

/**
 * The gradebook: students down, assignments across, typed into like a
 * spreadsheet. Each cell saves when you leave it; Enter moves down. Totals
 * and the FACTS list are worked out again in the browser as you type, with
 * the same arithmetic the server uses.
 */
export default function GradebookGrid(props: {
  courseId: string; periodKey: string; periodLabel: string; weighted: boolean; categories: Cat[];
  assignments: A[]; rows: R[]; noDueDate: number; uncategorized: number; d: Dict;
}) {
  const { courseId, periodKey, periodLabel, weighted, categories, assignments, d } = props;
  const [rows, setRows] = useState(props.rows);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [state, setState] = useState<Record<string, "saving" | "error">>({});
  const [copied, setCopied] = useState(false);
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const grid = useRef<HTMLTableElement>(null);
  const tickKey = `sl_facts_${courseId}_${periodKey}`;
  const catName = new Map(categories.map((c) => [c.id, c.name]));

  // Ticks for hand entry into FACTS are this browser's own convenience.
  useEffect(() => {
    try { setTicked(JSON.parse(localStorage.getItem(tickKey) || "{}")); } catch { /* none */ }
  }, [tickKey]);
  const tick = (id: string, on: boolean) => {
    const next = { ...ticked, [id]: on };
    setTicked(next);
    try { localStorage.setItem(tickKey, JSON.stringify(next)); } catch { /* private window */ }
  };

  const totals = useMemo(() => rows.map((r) => {
    const g = new Map<string, CalcGrade>(Object.entries(r.cells).map(([id, c]) => [id, { score: c.score, flag: c.flag }]));
    const res = computeGrade(assignments, g, { weighted, categories });
    return { id: r.id, percent: res.percent, whole: res.percent === null ? null : wholePercent(res.percent), letter: letterFor(res.percent), dropped: new Set(res.dropped) };
  }), [rows, assignments, weighted, categories]);
  const totalBy = new Map(totals.map((t) => [t.id, t]));
  const graded = totals.filter((t) => t.percent !== null);
  const average = graded.length ? graded.reduce((n, t) => n + (t.percent as number), 0) / graded.length : null;

  const missing: string[] = [];
  let ungraded = 0;
  for (const r of rows) for (const a of assignments) {
    const c = r.cells[a.id];
    if (c.flag === "missing" && c.score === null) missing.push(`${r.name}, ${a.title}`);
    if (c.score === null && c.flag !== "exempt" && c.flag !== "missing") ungraded++;
  }
  const below70 = totals.filter((t) => t.whole !== null && t.whole < 70).length;

  const focusCell = (ri: number, ai: number) => {
    const el = grid.current?.querySelector<HTMLInputElement>(`input[data-r="${ri}"][data-a="${ai}"]`);
    el?.focus();
  };

  const commit = async (ri: number, ai: number) => {
    const r = rows[ri], a = assignments[ai], k = key(r.id, a.id);
    const text = draft[k];
    if (text === undefined) return;
    const parsed = parseCell(text);
    const cur = r.cells[a.id];
    if (!parsed) { setState((s) => ({ ...s, [k]: "error" })); return; }
    const score = parsed.score === "" ? null : Number(parsed.score);
    if (score === cur.score && parsed.flag === cur.flag) {
      setDraft((x) => { const n = { ...x }; delete n[k]; return n; });
      setState((s) => { const n = { ...s }; delete n[k]; return n; });
      return;
    }
    setState((s) => ({ ...s, [k]: "saving" }));
    try {
      const res = await fetch("/api/grades", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ assignmentId: a.id, studentId: r.id, score: parsed.score, flag: parsed.flag, comment: cur.comment }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const { grade } = await res.json();
      setRows((all) => all.map((x) => x.id !== r.id ? x : {
        ...x, cells: { ...x.cells, [a.id]: { ...cur, score: grade ? grade.score : null, flag: grade ? grade.flag : null, comment: grade ? grade.comment : "" } },
      }));
      setDraft((x) => { const n = { ...x }; delete n[k]; return n; });
      setState((s) => { const n = { ...s }; delete n[k]; return n; });
    } catch {
      setState((s) => ({ ...s, [k]: "error" }));
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>, ri: number, ai: number) => {
    if (e.key === "Enter" || e.key === "ArrowDown") {
      e.preventDefault();
      const to = Math.max(0, Math.min(rows.length - 1, ri + (e.key === "Enter" && e.shiftKey ? -1 : 1)));
      // Moving saves through blur; on the last row there is nowhere to move.
      if (to === ri) commit(ri, ai); else focusCell(to, ai);
    }
    else if (e.key === "ArrowUp") { e.preventDefault(); focusCell(Math.max(0, ri - 1), ai); }
    else if (e.key === "Escape") {
      const k = key(rows[ri].id, assignments[ai].id);
      setDraft((x) => { const n = { ...x }; delete n[k]; return n; });
      setState((s) => { const n = { ...s }; delete n[k]; return n; });
    }
  };

  const copy = async () => {
    const text = rows.map((r) => {
      const t = totalBy.get(r.id)!;
      return [r.factsName, t.whole ?? "", t.letter].join("\t");
    }).join("\n");
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* not allowed */ }
  };

  const weightsTotal = categories.reduce((n, c) => n + c.weight, 0);

  return (
    <div className="gb">
      <section className="card gb-main" aria-label={d.gradebook}>
        <div className="row" style={{ padding: "4px 4px 10px" }}>
          <p className="label">{rows.length} {d.students}</p>
          <span className="muted" style={{ fontSize: 13 }}>{d.classAverage} {average === null ? "—" : `${wholePercent(average)}%`}</span>
          {weighted && (
            <span className="row" style={{ gap: 6 }}>
              {categories.map((c) => <span key={c.id} className="chip">{c.name} {c.weight}%{c.dropLowest ? ` · ${d.dropLowestShort} ${c.dropLowest}` : ""}</span>)}
              {weightsTotal !== 100 && <span className="muted" style={{ fontSize: 12 }}>{d.weightsScaled}</span>}
            </span>
          )}
          <span className="spacer" style={{ flex: 1 }} />
          <span className="muted" style={{ fontSize: 12 }}>M = {d.missing} · EX = {d.exempt} · 18 L = {d.late}{categories.some((c) => c.dropLowest) ? <> · <s>18</s> = {d.droppedGrade}</> : null}</span>
        </div>
        <div className="gb-scroll">
          <table ref={grid} className="gb-table">
            <thead>
              <tr>
                <th scope="col" className="gb-name">{d.student}</th>
                {assignments.map((a) => (
                  <th scope="col" key={a.id}>
                    {a.categoryId && <span className="cat">{catName.get(a.categoryId)}</span>}
                    <Link href={`/assignments/${a.id}/grade`} title={a.title}>{a.title}</Link>
                    <span className="gb-pts">/{a.points}{!a.published ? ` · ${d.draft}` : ""}</span>
                  </th>
                ))}
                <th scope="col" className="gb-total">{periodLabel}</th>
                <th scope="col" className="gb-total">{d.grade}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => {
                const t = totalBy.get(r.id)!;
                const low = t.whole !== null && t.whole < 70;
                return (
                  <tr key={r.id} className={low ? "gb-low" : undefined}>
                    <th scope="row" className="gb-name">{r.name}</th>
                    {assignments.map((a, ai) => {
                      const c = r.cells[a.id];
                      const k = key(r.id, a.id);
                      const shown = draft[k] ?? cellText({ score: c.score, flag: c.flag });
                      const dropped = t.dropped.has(a.id);
                      const cls = ["gb-cell",
                        c.flag === "missing" && c.score === null ? "is-missing" : "",
                        c.flag === "exempt" ? "is-exempt" : "",
                        (c.flag === "late" || c.late) ? "is-late" : "",
                        dropped ? "is-dropped" : "",
                        state[k] === "error" ? "is-error" : "", state[k] === "saving" ? "is-saving" : ""].join(" ");
                      return (
                        <td key={a.id}>
                          <input className={cls} value={shown} data-r={ri} data-a={ai} inputMode="decimal" autoComplete="off"
                            aria-label={`${r.name}, ${a.title}${dropped ? `, ${d.droppedGrade}` : ""}`} aria-invalid={state[k] === "error" || undefined}
                            title={state[k] === "error" ? d.badScore : [dropped ? d.droppedGrade : "", c.comment].filter(Boolean).join(" · ") || undefined}
                            onFocus={(e) => e.currentTarget.select()}
                            onChange={(e) => setDraft((x) => ({ ...x, [k]: e.target.value }))}
                            onBlur={() => commit(ri, ai)}
                            onKeyDown={(e) => onKey(e, ri, ai)} />
                        </td>
                      );
                    })}
                    <td className="gb-total">{t.whole === null ? "—" : `${t.whole}%`}</td>
                    <td className="gb-total">{t.letter || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {assignments.length === 0 && <p className="empty" style={{ padding: "0 8px" }}>{d.noAssignmentsStudent}</p>}
      </section>

      <aside className="gb-side">
        <div className="card">
          <p className="label">{d.factsTitle}</p>
          <p className="muted" style={{ fontSize: 13, margin: "6px 0 0" }}>{d.factsHint}</p>
          <ol className="facts">
            {rows.map((r) => {
              const t = totalBy.get(r.id)!;
              return (
                <li key={r.id}>
                  <label>
                    <input type="checkbox" checked={!!ticked[r.id]} onChange={(e) => tick(r.id, e.target.checked)} />
                    <span className={ticked[r.id] ? "facts-done" : undefined}>{r.factsName}</span>
                  </label>
                  <b>{t.whole === null ? "—" : `${t.whole} · ${t.letter}`}</b>
                </li>
              );
            })}
          </ol>
          <div className="row" style={{ marginTop: 12 }}>
            <button type="button" className="btn btn-primary" onClick={copy}>{copied ? d.copied : d.copyGrades}</button>
            <a className="btn" href={`/api/courses/${courseId}/facts?period=${periodKey}`} download>{d.downloadFile}</a>
          </div>
          <p className="muted" style={{ fontSize: 12, margin: "10px 0 0" }}>{d.scaleNote}</p>
        </div>

        <div className="card">
          <p className="label">{d.beforePost}</p>
          <ul className="checks">
            {missing.length > 0 && <li className="check-bad"><b>{missing.length} {d.missingCount}.</b> {missing.slice(0, 3).join("; ")}{missing.length > 3 ? "…" : ""}</li>}
            {ungraded > 0 && <li className="check-warn">{ungraded} {d.ungradedCount}</li>}
            {below70 > 0 && <li className="check-warn">{below70} {d.below70}</li>}
            {props.noDueDate > 0 && <li className="check-warn">{props.noDueDate} {d.noDueCount}</li>}
            {props.uncategorized > 0 && <li className="check-warn">{props.uncategorized} {d.uncategorizedCount}</li>}
            {missing.length === 0 && ungraded === 0 && <li className="check-good">{d.allGraded}</li>}
          </ul>
        </div>
      </aside>
    </div>
  );
}
