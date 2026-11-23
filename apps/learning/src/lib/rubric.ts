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
/** One part of a section (sections-and-parts rubric): the worksheet's exact question, worth quarter points. */
export type RubricPart = { id: string; label: string; question: string; points: number };
export type RubricSection = { id: string; title: string; parts: RubricPart[] };
/**
 * Either criteria × levels (the first kind), or, with `kind: "parts"`, a
 * points rubric of sections with 2–5 parts each (story 01, grade
 * assistant). A parts rubric keeps `criteria` empty, so everything that
 * reads criteria (standards rows, levels) simply finds none.
 */
export type Rubric = { kind?: "parts"; criteria: RubricCriterion[]; sections?: RubricSection[] };
/** A part's score and the message to the student about it: part id → mark. */
export type PartMark = { score: number | null; message: string };
export type PartMarks = Record<string, PartMark>;
/** The teacher's own note per part: never shown to students. */
export type PartNotes = Record<string, string>;
/** Which level was chosen for each criterion: criterion id → level id. */
export type RubricSelection = Record<string, string>;

export const RUBRIC_LIMITS = {
  criteria: 20, levels: 6, title: 120, levelTitle: 60, description: 600, maxLevelPoints: 1_000,
  sections: 30, minParts: 2, maxParts: 5, partLabel: 12, question: 2_000, partPoints: 100, message: 2_000,
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

/** Points on quarter steps, 0 to max. */
export function quarter(v: unknown, max: number = RUBRIC_LIMITS.partPoints): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(0, Math.round(n * 4) / 4)) : 0;
}

/** A starting section: two parts of one point each, labelled 1a, 1b (n = the section's number). */
export function newSection(n: number): RubricSection {
  return { id: newId(), title: "", parts: ["a", "b"].map((x) => ({ id: newId(), label: `${n}${x}`, question: "", points: 1 })) };
}

export const isParts = (r: Rubric | null | undefined): r is Rubric & { kind: "parts"; sections: RubricSection[] } => r?.kind === "parts" && Array.isArray(r.sections);
export const sectionPoints = (s: RubricSection) => Math.round(s.parts.reduce((n, p) => n + p.points, 0) * 100) / 100;

function normalizeParts(raw: unknown[]): Rubric | null {
  const used = new Set<string>();
  const sections: RubricSection[] = [];
  for (const x of raw.slice(0, RUBRIC_LIMITS.sections)) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const parts = (Array.isArray(o.parts) ? o.parts : [])
      .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
      .slice(0, RUBRIC_LIMITS.maxParts)
      .map((p) => ({ id: uniqueId(p.id, used), label: line(p.label, RUBRIC_LIMITS.partLabel), question: text(p.question, RUBRIC_LIMITS.question), points: quarter(p.points) }));
    if (!parts.length) continue;
    sections.push({ id: uniqueId(o.id, used), title: line(o.title, RUBRIC_LIMITS.title), parts });
  }
  return sections.length ? { kind: "parts", criteria: [], sections } : null;
}

/** Sections with fewer than 2 parts (the editor warns; saving still keeps them so work isn't lost). */
export function shortSections(r: Rubric): RubricSection[] {
  return isParts(r) ? r.sections.filter((s) => s.parts.length < RUBRIC_LIMITS.minParts) : [];
}

/**
 * A rubric as it may be stored, or null for "no rubric" (null, or nothing
 * left after cleaning). Levels are kept highest points first.
 */
export function normalizeRubric(input: unknown): Rubric | null {
  if (!input || typeof input !== "object") return null;
  if ((input as { kind?: unknown }).kind === "parts") {
    const secs = (input as { sections?: unknown }).sections;
    return Array.isArray(secs) ? normalizeParts(secs) : null;
  }
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
  if (isParts(r)) return Math.round(r.sections.reduce((n, s) => n + sectionPoints(s), 0) * 100) / 100;
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

/** Only marks for this rubric's own parts: a score on quarter points up to the part's points, and a message. */
export function cleanParts(r: Rubric | null, input: unknown): PartMarks | null {
  if (!isParts(r) || !input || typeof input !== "object") return null;
  const out: PartMarks = {};
  for (const s of r.sections) for (const p of s.parts) {
    const m = (input as Record<string, unknown>)[p.id];
    if (!m || typeof m !== "object") continue;
    const o = m as Record<string, unknown>;
    const score = o.score === null || o.score === undefined || o.score === "" ? null : quarter(o.score, p.points);
    const message = text(o.message, RUBRIC_LIMITS.message);
    if (score !== null || message) out[p.id] = { score, message };
  }
  return Object.keys(out).length ? out : null;
}

/** Only notes for this rubric's own parts. */
export function cleanNotes(r: Rubric | null, input: unknown): PartNotes | null {
  if (!isParts(r) || !input || typeof input !== "object") return null;
  const out: PartNotes = {};
  for (const s of r.sections) for (const p of s.parts) {
    const n = text((input as Record<string, unknown>)[p.id], RUBRIC_LIMITS.message);
    if (n) out[p.id] = n;
  }
  return Object.keys(out).length ? out : null;
}

/** The parts' scores added up, and whether every part has one. */
export function partsScore(r: Rubric, marks: PartMarks | null): { score: number | null; complete: boolean } {
  if (!isParts(r)) return { score: null, complete: false };
  let total = 0, scored = 0, all = 0;
  for (const s of r.sections) for (const p of s.parts) {
    all++;
    const v = marks?.[p.id]?.score;
    if (typeof v === "number") { total += v; scored++; }
  }
  return { score: scored ? Math.round(total * 100) / 100 : null, complete: scored === all };
}

/**
 * The student's feedback put together from the part messages, in order:
 * "3a: message". The teacher edits it before it is saved as the comment.
 */
export function feedbackFromParts(r: Rubric, marks: PartMarks | null): string {
  if (!isParts(r)) return "";
  const lines: string[] = [];
  for (const s of r.sections) for (const p of s.parts) {
    const m = marks?.[p.id]?.message.trim();
    if (m) lines.push(`${p.label ? `${p.label}: ` : ""}${m}`);
  }
  return lines.join("\n\n");
}
