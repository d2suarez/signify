"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Dict } from "@/lib/i18n";
import { letterFor } from "@/lib/grade-math";
import { gpaText, type ScaleRow } from "@/lib/grade-scale";
import type { ConversionRow } from "@/lib/standards-math";

type Std = { id: string; code: string; description: string };
type R = {
  id: string; name: string; factsName: string; guessed?: boolean;
  summaries: Record<string, { level: number | null; scores: number }>;
  average: number | null; whole: number | null; letter: string; gpa: number | null;
};
type A = { id: string; title: string; aligned: number; published: boolean };

/**
 * A standards course's gradebook: students down, standards across, each cell
 * the standard's level for the period (worked out on the server). Levels are
 * given on each assignment's grading screen. The FACTS list and "Before you
 * post" work like the points gradebook's, and show the conversion used.
 */
export default function StandardsGradebook(props: {
  courseId: string; periodKey: string; summaryText: string; labels: string[];
  standards: Std[]; rows: R[]; assignments: A[]; conversion: ConversionRow[]; scale: ScaleRow[]; bandName: string;
  checks: { missing: string[]; noLevels: number; unaligned: number; noEvidence: number; below70: number; noDueDate: number };
  d: Dict;
}) {
  const { courseId, periodKey, labels, standards, rows, assignments, conversion, scale, checks, d } = props;
  const top = labels.length;
  const [copied, setCopied] = useState(false);
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const tickKey = `sl_facts_${courseId}_${periodKey}`;

  useEffect(() => {
    try { setTicked(JSON.parse(localStorage.getItem(tickKey) || "{}")); } catch { /* none */ }
  }, [tickKey]);
  const tick = (id: string, on: boolean) => {
    const next = { ...ticked, [id]: on };
    setTicked(next);
    try { localStorage.setItem(tickKey, JSON.stringify(next)); } catch { /* private window */ }
  };
  const copy = async () => {
    const text = rows.map((r) => [r.factsName, r.whole ?? "", r.letter].join("\t")).join("\n");
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* not allowed */ }
  };
  const label = (level: number) => labels[top - Math.min(top, Math.max(1, Math.floor(level + 0.5 + 1e-9)))] ?? "";

  return (
    <div className="gb">
      <section className="card gb-main" aria-label={d.gradebook}>
        <div className="row" style={{ padding: "4px 4px 10px" }}>
          <p className="label">{rows.length} {d.students}</p>
          <span className="muted" style={{ fontSize: 13 }}>{d.standardsLegend} {props.summaryText}</span>
        </div>
        {standards.length === 0
          ? <p className="empty" style={{ padding: "0 8px" }}><Link href={`/courses/${courseId}/settings`}>{d.noStandardsYet}</Link></p>
          : (
            <div className="gb-scroll">
              <table className="gb-table sbg-table">
                <thead>
                  <tr>
                    <th scope="col" className="gb-name">{d.student}</th>
                    {standards.map((s) => (
                      <th scope="col" key={s.id} title={s.description}><span>{s.code}</span></th>
                    ))}
                    <th scope="col" className="gb-total">{d.avgLevel}</th>
                    <th scope="col" className="gb-total">%</th>
                    <th scope="col" className="gb-total">{d.grade}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className={r.whole !== null && r.whole < 70 ? "gb-low" : undefined}>
                      <th scope="row" className="gb-name">{r.name}</th>
                      {standards.map((s) => {
                        const c = r.summaries[s.id];
                        return (
                          <td key={s.id} className={`sbg-cell${c?.level != null ? ` sbg-l${Math.min(4, Math.floor(c.level + 0.5 + 1e-9))}` : ""}`}>
                            {c?.level == null
                              ? <span className="muted" aria-label={`${r.name}, ${s.code}: ${d.noLevelYet}`}>—</span>
                              : <span aria-label={`${r.name}, ${s.code}: ${c.level} ${label(c.level)}`}><b>{c.level}</b> <small>{label(c.level)}</small></span>}
                          </td>
                        );
                      })}
                      <td className="gb-total">{r.average ?? "—"}</td>
                      <td className="gb-total">{r.whole === null ? "—" : `${r.whole}%`}</td>
                      <td className="gb-total">{r.letter || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        <div style={{ padding: "14px 8px 4px" }}>
          <p className="label">{d.assignmentsThisPeriod}</p>
          {assignments.length === 0 ? <p className="empty">{d.noAssignmentsStudent}</p> : (
            <ul className="list" style={{ marginTop: 6 }}>
              {assignments.map((a) => (
                <li key={a.id}>
                  <Link className="grow" href={`/assignments/${a.id}/grade`}>{a.title}</Link>
                  {!a.published && <span className="pill pill-draft">{d.draft}</span>}
                  <span className={`chip${a.aligned ? "" : " chip-missing"}`}>{a.aligned} {d.standardsAligned}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <aside className="gb-side">
        <div className="card">
          <p className="label">{d.factsTitle}</p>
          <p className="muted" style={{ fontSize: 13, margin: "6px 0 0" }}>{d.factsHint}</p>
          {rows.some((r) => r.guessed) && (
            <p className="muted" style={{ fontSize: 13, margin: "6px 0 0" }}>
              {d.factsGuessed.replace("{n}", String(rows.filter((r) => r.guessed).length))}
            </p>
          )}
          <ol className="facts">
            {rows.map((r) => (
              <li key={r.id}>
                <label>
                  <input type="checkbox" checked={!!ticked[r.id]} onChange={(e) => tick(r.id, e.target.checked)} />
                  <span className={ticked[r.id] ? "facts-done" : undefined}>{r.factsName}</span>
                    {r.guessed && <span className="chip" title={d.factsGuessMarkLong} aria-label={d.factsGuessMarkLong} style={{ marginLeft: 6 }}>{d.factsGuessMark}</span>}
                </label>
                <b>{r.whole === null ? "—" : `${r.whole} · ${r.letter}${r.gpa === null ? "" : ` · ${d.gpaShort.replace("{n}", gpaText(r.gpa))}`}`}</b>
              </li>
            ))}
          </ol>
          <div className="row" style={{ marginTop: 12 }}>
            <button type="button" className="btn btn-primary" onClick={copy}>{copied ? d.copied : d.copyGrades}</button>
            <a className="btn" href={`/api/courses/${courseId}/facts?period=${periodKey}`} download>{d.downloadFile}</a>
          </div>
          <p className="muted" style={{ fontSize: 12, margin: "10px 0 0" }}>{d.scaleNote.replace("{band}", props.bandName)}</p>
        </div>

        <div className="card">
          <p className="label">{d.beforePost}</p>
          <ul className="checks">
            <li className="check-info">
              {d.standardsConversionCheck}{" "}
              {conversion.map((c, i) => (
                <span key={i} style={{ whiteSpace: "nowrap" }}>{i ? " · " : ""}{c.min > 0 ? `${c.min}+` : `< ${conversion[i - 1]?.min ?? ""}`} → {c.percent}% ({letterFor(c.percent, scale)})</span>
              ))}{" "}
              <Link href={`/courses/${courseId}/settings`}>{d.changeConversion}</Link>
            </li>
            {checks.missing.length > 0 && <li className="check-warn"><b>{checks.missing.length} {d.missingNoEvidence}.</b> {checks.missing.slice(0, 3).join("; ")}{checks.missing.length > 3 ? "…" : ""}</li>}
            {checks.noEvidence > 0 && <li className="check-bad">{checks.noEvidence} {d.noEvidenceCount}</li>}
            {checks.noLevels > 0 && <li className="check-warn">{checks.noLevels} {d.noLevelsCount}</li>}
            {checks.unaligned > 0 && <li className="check-warn">{checks.unaligned} {d.unalignedCount}</li>}
            {checks.below70 > 0 && <li className="check-warn">{checks.below70} {d.below70}</li>}
            {checks.noDueDate > 0 && <li className="check-warn">{checks.noDueDate} {d.noDueCount}</li>}
            {checks.missing.length === 0 && checks.noLevels === 0 && checks.noEvidence === 0 && <li className="check-good">{d.allGraded}</li>}
          </ul>
        </div>
      </aside>
    </div>
  );
}
