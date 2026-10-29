/**
 * Rubrics: an assignment's criteria, each with levels worth points ("Thesis:
 * Excellent 4 · Good 3 · Developing 2 · Beginning 1"). The teacher picks a
 * level per criterion when grading and the score is their sum; the rubric's
 * total is the assignment's points. Pure: no database, no network, so it is
 * tested directly and runs in the editor and grading screen as well.
 *
 * Everything from a browser goes through normalizeRubric (or cleanSelection)
 * before it is stored.
 */

import { newId } from "./blocks";

export type RubricLevel = { id: string; title: string; points: number; description: string };
export type RubricCriterion = {
  id: string; title: string; description: string; levels: RubricLevel[];
  /** The standard this row measures, in a standards course (checked against the course's standards on save). */
  standardId?: string;
};
export type Rubric = { criteria: RubricCriterion[] };
/** Which level was chosen for each criterion: criterion id → level id. */
export type RubricSelection = Record<string, string>;

export const RUBRIC_LIMITS = {
  criteria: 20, levels: 6, title: 120, levelTitle: 60, description: 600, maxLevelPoints: 1_000,
};

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const UUID = /^[0-9a-f-]{36}$/i;

function line(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}
function text(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\r\n/g, "\n").trim().slice(0, max) : "";
}
function uniqueId(raw: unknown, used: Set<string>): string {
  let id = typeof raw === "string" && ID_RE.test(raw) ? raw : newId();
  while (used.has(id)) id = newId();
  used.add(id);
  return id;
}
function points(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(RUBRIC_LIMITS.maxLevelPoints, Math.max(0, Math.round(n * 100) / 100)) : 0;
}

/** A starting rubric: one criterion with four levels, 4 down to 1. */
export function newCriterion(): RubricCriterion {
  return {
    id: newId(), title: "", description: "",
    levels: [4, 3, 2, 1].map((p) => ({ id: newId(), title: "", points: p, description: "" })),
  };
}

/**
 * A rubric as it may be stored, or null for "no rubric" (null, or nothing
 * left after cleaning). Levels are kept highest points first.
 */
export function normalizeRubric(input: unknown): Rubric | null {
  if (!input || typeof input !== "object") return null;
  const raw = (input as { criteria?: unknown }).criteria;
  if (!Array.isArray(raw)) return null;
  const used = new Set<string>();
  const criteria: RubricCriterion[] = [];
  for (const c of raw.slice(0, RUBRIC_LIMITS.criteria)) {
    if (!c || typeof c !== "object") continue;
    const o = c as Record<string, unknown>;
    const levels = (Array.isArray(o.levels) ? o.levels : [])
      .slice(0, RUBRIC_LIMITS.levels)
      .filter((l): l is Record<string, unknown> => !!l && typeof l === "object")
      .map((l) => ({ id: uniqueId(l.id, used), title: line(l.title, RUBRIC_LIMITS.levelTitle), points: points(l.points), description: text(l.description, RUBRIC_LIMITS.description) }))
      .sort((a, b) => b.points - a.points);
    if (!levels.length) continue;
    const crit: RubricCriterion = { id: uniqueId(o.id, used), title: line(o.title, RUBRIC_LIMITS.title), description: text(o.description, RUBRIC_LIMITS.description), levels };
    if (typeof o.standardId === "string" && UUID.test(o.standardId)) crit.standardId = o.standardId;
    criteria.push(crit);
  }
  return criteria.length ? { criteria } : null;
}

/** The most a rubric can give: each criterion's best level, added up. */
export function rubricMax(r: Rubric): number {
  return Math.round(r.criteria.reduce((n, c) => n + Math.max(0, ...c.levels.map((l) => l.points)), 0) * 100) / 100;
}

/** Only choices that name a real criterion and one of its levels. */
export function cleanSelection(r: Rubric | null, input: unknown): RubricSelection | null {
  if (!r || !input || typeof input !== "object") return null;
  const out: RubricSelection = {};
  for (const c of r.criteria) {
    const pick = (input as Record<string, unknown>)[c.id];
    if (typeof pick === "string" && c.levels.some((l) => l.id === pick)) out[c.id] = pick;
  }
  return Object.keys(out).length ? out : null;
}

/** The score the chosen levels add up to, and whether every criterion has one. */
export function rubricScore(r: Rubric, sel: RubricSelection | null): { score: number | null; complete: boolean } {
  let total = 0, chosen = 0;
  for (const c of r.criteria) {
    const l = c.levels.find((x) => x.id === sel?.[c.id]);
    if (l) { total += l.points; chosen++; }
  }
  return { score: chosen ? Math.round(total * 100) / 100 : null, complete: chosen === r.criteria.length };
}
