"use client";

import { useState } from "react";
import type { Dict } from "@/lib/i18n";
import { letterFor } from "@/lib/grade-math";
import type { ScaleRow } from "@/lib/grade-scale";
import {
  defaultConversion, levelWords, SCALE_LIMITS, SUMMARY_METHODS, type ConversionRow, type StandardsSettings, type SummaryMethod,
} from "@/lib/standards-math";

/**
 * A standards course's proficiency scale, how a standard's period level is
 * worked out, and the conversion to a percent for FACTS. Sent whole as JSON;
 * the server cleans it (normalizeSettings).
 */
export default function StandardsSettingsForm({ courseId, initial, scale, action, d }: {
  courseId: string; initial: StandardsSettings; scale: ScaleRow[]; action: (f: FormData) => Promise<void>; d: Dict;
}) {
  const [labels, setLabels] = useState(initial.labels);
  const [summary, setSummary] = useState<SummaryMethod>(initial.summary);
  const [rows, setRows] = useState<ConversionRow[]>(initial.conversion);
  const top = labels.length;
  const words = levelWords(d);
  const summaryText: Record<SummaryMethod, string> = { recent: d.summaryRecent, mean: d.summaryMean, highest: d.summaryHighest };

  const setCount = (n: number) => {
    const next = Array.from({ length: n }, (_, i) => labels[i] ?? "");
    setLabels(next);
    // A new scale size gets the default table in proportion.
    setRows(defaultConversion(n));
  };
  const setRow = (i: number, patch: Partial<ConversionRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <form action={action} className="card stack" style={{ gap: 14 }}>
      <input type="hidden" name="courseId" value={courseId} />
      <input type="hidden" name="op" value="sbg-settings" />
      <input type="hidden" name="settings" value={JSON.stringify({ labels, summary, conversion: rows })} />

      <fieldset className="stack" style={{ gap: 8, border: 0, padding: 0, margin: 0 }}>
        <legend className="label" style={{ marginBottom: 6 }}>{d.proficiencyScale}</legend>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.proficiencyScaleHint}</p>
        <label className="row" style={{ gap: 8, fontSize: 14 }}>{d.levelCount}
          <select className="field" style={{ width: 90 }} value={top} onChange={(e) => setCount(Number(e.target.value))}>
            {Array.from({ length: SCALE_LIMITS.maxLevels - SCALE_LIMITS.minLevels + 1 }, (_, i) => i + SCALE_LIMITS.minLevels)
              .map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <div className="row" style={{ gap: 8 }}>
          {labels.map((l, i) => (
            <label key={i} className="stack" style={{ gap: 2, fontSize: 13, flex: "1 1 130px" }}>
              {d.level} {top - i}
              <input className="field" value={l} maxLength={SCALE_LIMITS.label}
                placeholder={top === words.length ? words[i] : String(top - i)}
                onChange={(e) => setLabels(labels.map((x, j) => (j === i ? e.target.value : x)))} />
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="label" style={{ marginBottom: 6 }}>{d.summaryMethod}</legend>
        {SUMMARY_METHODS.map((m) => (
          <label key={m} className="check" style={{ fontSize: 15, display: "flex", marginTop: 4 }}>
            <input type="radio" name="summary-choice" checked={summary === m} onChange={() => setSummary(m)} /> {summaryText[m]}
          </label>
        ))}
      </fieldset>

      <fieldset className="stack" style={{ gap: 8, border: 0, padding: 0, margin: 0 }}>
        <legend className="label" style={{ marginBottom: 6 }}>{d.conversion}</legend>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.conversionHint}</p>
        <table className="conv-table">
          <thead>
            <tr><th scope="col">{d.averageAtLeast}</th><th scope="col">{d.percentWord}</th><th scope="col">{d.grade}</th><th scope="col"><span className="sr-only">{d.removeRow}</span></th></tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const last = i === rows.length - 1;
              return (
                <tr key={i}>
                  <td>
                    <input type="number" className="field" style={{ width: 100 }} min={0} max={top} step={0.01} value={last ? 0 : r.min} disabled={last}
                      aria-label={`${d.averageAtLeast}, ${i + 1}`} onChange={(e) => setRow(i, { min: Number(e.target.value) })} />
                  </td>
                  <td>
                    <input type="number" className="field" style={{ width: 100 }} min={0} max={100} step="any" value={r.percent}
                      aria-label={`${d.percentWord}, ${i + 1}`} onChange={(e) => setRow(i, { percent: Number(e.target.value) })} />
                  </td>
                  <td><b>{letterFor(r.percent, scale)}</b></td>
                  <td>
                    {!last && <button type="button" className="btn btn-sm" aria-label={`${d.removeRow} ${i + 1}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}>×</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="row">
          {rows.length < SCALE_LIMITS.rows && (
            <button type="button" className="btn btn-sm" onClick={() => setRows([{ min: Math.min(top, (rows[0]?.min ?? 0) + 0.25), percent: 100 }, ...rows])}>{d.addRow}</button>
          )}
          <button type="button" className="btn btn-sm" onClick={() => setRows(defaultConversion(top))}>{d.resetDefault}</button>
        </div>
      </fieldset>
      <button className="btn btn-primary" style={{ alignSelf: "flex-start" }}>{d.save}</button>
    </form>
  );
}
