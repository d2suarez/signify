/**
 * Standards-based grading, the arithmetic. No database: runs on the server
 * and in the browser (grading screen, settings).
 *
 * A standards course scores each standard on a proficiency scale (levels 1
 * up to `top`, 4 by default: Exceeds, Meets, Approaching, Beginning). Each
 * standard gets a summary per grading period from its scores (the most
 * recent by default; mean or highest as options). FACTS still wants a
 * percent and a letter, so the average of a student's standard summaries is
 * turned into a percent by the course's conversion table, and the letter
 * follows that percent on the usual scale (letterFor).
 *
 * Exempt work is left out. Missing work is no evidence: it changes no
 * standard (it is listed in the gradebook's checks instead).
 */

import type { Rubric } from "./rubric";

export type SummaryMethod = "recent" | "mean" | "highest";
export const SUMMARY_METHODS: SummaryMethod[] = ["recent", "mean", "highest"];

/** "Average level at least `min` → `percent`." */
export type ConversionRow = { min: number; percent: number };

export type StandardsSettings = {
  /** One label per level, top level first; "" = the default word for it. Its length is the scale's top level. */
  labels: string[];
  summary: SummaryMethod;
  /** Highest `min` first; the last row's `min` is always 0. */
  conversion: ConversionRow[];
};

export const SCALE_LIMITS = { minLevels: 2, maxLevels: 6, label: 40, rows: 12 };

/**
 * A common conversion for a 4-level scale: 3.5 and up is an A, 3.0 a B, 2.5
 * a C, 2.0 a D, below that an F. Each percent sits inside its letter's band
 * on the school's letter scale (A 93+, B 83+, C 73+, D 63+). Other scales get
 * the same cut-offs in proportion.
 */
export function defaultConversion(top: number): ConversionRow[] {
  const f = top / 4;
  return [[3.5, 95], [3, 85], [2.5, 75], [2, 65], [0, 55]].map(([min, percent]) => ({ min: round2(min * f), percent }));
}

export function defaultSettings(): StandardsSettings {
  return { labels: ["", "", "", ""], summary: "recent", conversion: defaultConversion(4) };
}

export function round2(n: number): number {
  return Math.round(n * 100 + 1e-9) / 100;
}

/** The scale's top level (4 on the default scale). */
export function topLevel(s: StandardsSettings): number {
  return s.labels.length;
}

/** Settings as they may be stored. Anything odd falls back to the default. */
export function normalizeSettings(input: unknown): StandardsSettings {
  const def = defaultSettings();
  if (!input || typeof input !== "object") return def;
  const o = input as Record<string, unknown>;
  let labels = Array.isArray(o.labels)
    ? o.labels.slice(0, SCALE_LIMITS.maxLevels).map((l) => (typeof l === "string" ? l.replace(/\s+/g, " ").trim().slice(0, SCALE_LIMITS.label) : ""))
    : def.labels;
  if (labels.length < SCALE_LIMITS.minLevels) labels = def.labels;
  const top = labels.length;
  const summary = SUMMARY_METHODS.includes(o.summary as SummaryMethod) ? (o.summary as SummaryMethod) : "recent";
  const seen = new Set<number>();
  const rows: ConversionRow[] = [];
  for (const r of Array.isArray(o.conversion) ? o.conversion.slice(0, SCALE_LIMITS.rows * 2) : []) {
    if (!r || typeof r !== "object") continue;
    const min = Number((r as ConversionRow).min), percent = Number((r as ConversionRow).percent);
    if (!Number.isFinite(min) || !Number.isFinite(percent)) continue;
    const m = round2(Math.min(top, Math.max(0, min)));
    if (seen.has(m)) continue;
    seen.add(m);
    rows.push({ min: m, percent: round2(Math.min(100, Math.max(0, percent))) });
  }
  rows.sort((a, b) => b.min - a.min);
  let conversion = rows.slice(0, SCALE_LIMITS.rows);
  if (!conversion.length) conversion = defaultConversion(top);
  // Every average must land on a row.
  conversion[conversion.length - 1] = { ...conversion[conversion.length - 1], min: 0 };
  return { labels, summary, conversion };
}

/** A level's words: the course's own label, else the default word, else the number. */
export function levelLabel(s: StandardsSettings, level: number, defaults: string[]): string {
  const top = topLevel(s);
  const own = s.labels[top - level];
  if (own) return own;
  // The default words belong to the default 4-level scale.
  return top === defaults.length ? defaults[top - level] ?? String(level) : String(level);
}

/** The usual words for the default 4-level scale, top first. */
export function levelWords(d: { levelExceeds: string; levelMeets: string; levelApproaching: string; levelBeginning: string }): string[] {
  return [d.levelExceeds, d.levelMeets, d.levelApproaching, d.levelBeginning];
}

/** Which level a summary like 2.67 reads as (half rounds up). */
export function roundLevel(n: number): number {
  return Math.floor(n + 0.5 + 1e-9);
}

// ---------- alignment ----------

type Aligned = { standards: string[] | null; rubric: Rubric | null; quiz?: { items: { standardId: string | null }[] } | null };

/** The standards an assignment measures: its own list, its rubric rows' and its quiz questions', once each. */
export function alignedStandards(a: Aligned): string[] {
  const out: string[] = [];
  for (const id of a.standards ?? []) if (!out.includes(id)) out.push(id);
  for (const c of a.rubric?.criteria ?? []) if (c.standardId && !out.includes(c.standardId)) out.push(c.standardId);
  for (const i of a.quiz?.items ?? []) if (i.standardId && !out.includes(i.standardId)) out.push(i.standardId);
  return out;
}

/** Only levels for standards this assignment measures, each a whole number 1..top. */
export function cleanLevels(aligned: string[], top: number, input: unknown): Record<string, number> | null {
  if (!input || typeof input !== "object") return null;
  const out: Record<string, number> = {};
  for (const id of aligned) {
    const v = (input as Record<string, unknown>)[id];
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
    if (Number.isInteger(n) && n >= 1 && n <= top) out[id] = n;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The level a rubric row's chosen level stands for, in proportion to the
 * row's best level (a 4-3-2-1 row maps straight onto the 4-level scale).
 * Never below 1.
 */
export function criterionLevel(levels: { id: string; points: number }[], levelId: string, top: number): number | null {
  const pick = levels.find((l) => l.id === levelId);
  if (!pick) return null;
  const best = Math.max(0, ...levels.map((l) => l.points));
  if (best <= 0) return 1;
  return Math.min(top, Math.max(1, roundLevel((pick.points / best) * top)));
}

/** Levels the chosen rubric rows give, for rows aligned to a standard (the last row wins a shared one). */
export function levelsFromRubric(r: Rubric | null, sel: Record<string, string> | null, top: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of r?.criteria ?? []) {
    if (!c.standardId || !sel?.[c.id]) continue;
    const l = criterionLevel(c.levels, sel[c.id], top);
    if (l !== null) out[c.standardId] = l;
  }
  return out;
}

// ---------- summaries ----------

/** One score on one standard. `at` orders them: when the work was due, else when it was graded. */
export type Evidence = { level: number; at: string; gradedAt: string };

/** A standard's summary over a period's evidence, or null with none. */
export function summarize(list: Evidence[], method: SummaryMethod): number | null {
  if (!list.length) return null;
  if (method === "highest") return Math.max(...list.map((e) => e.level));
  if (method === "mean") return round2(list.reduce((n, e) => n + e.level, 0) / list.length);
  const latest = [...list].sort((a, b) => a.at.localeCompare(b.at) || a.gradedAt.localeCompare(b.gradedAt)).at(-1)!;
  return latest.level;
}

/** The average of the standard summaries that have evidence (2 decimals), or null. */
export function averageLevel(summaries: (number | null)[]): number | null {
  const got = summaries.filter((s): s is number => s !== null);
  return got.length ? round2(got.reduce((n, s) => n + s, 0) / got.length) : null;
}

/** The percent the conversion table gives an average level. */
export function convert(average: number | null, s: StandardsSettings): number | null {
  if (average === null) return null;
  for (const r of s.conversion) if (average >= r.min - 1e-9) return r.percent;
  return s.conversion.at(-1)?.percent ?? null;
}
