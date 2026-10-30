/**
 * Late work: the school's late policies, a course's own policy (when the
 * school allows one), how late a piece of work is, and what that costs.
 * Pure, so the gradebook grid can redo it in the browser as grades are typed.
 *
 * - Late = handed in after `due_at` (online work and quizzes), or the
 *   teacher's Late mark (any work; paper work has no hand-in time).
 * - Days late = school days (Monday to Friday, the planner's maths) after
 *   the due day up to the hand-in day, at least 1. Work that was late only
 *   during Sabbath hours (Friday 6 pm through Saturday) costs nothing. Paper
 *   work marked Late counts as 1 day unless the teacher says how many.
 * - The penalty is a share of the assignment's points; a score never goes
 *   below 0. Missing (0) and exempt (left out) are untouched.
 * - No policy that applies = late is a mark only, exactly as before.
 */

import { onSabbath, weekday, type Day } from "./calendar";
import { addDays, isSchoolDay } from "./planner";
import type { Flag } from "./grade-math";

export type LateKind = "perDay" | "flat" | "none";
export type WorkKind = "online" | "offline" | "quiz";
export const WORK_KINDS: WorkKind[] = ["online", "offline", "quiz"];
export const LATE_KINDS: LateKind[] = ["perDay", "flat", "none"];

/** One school policy and what it applies to (an empty list = all). */
export type LateRule = {
  id: string;
  name: string;
  kind: LateKind;
  /** Per school day (perDay) or once (flat), as a percent of the points. */
  percent: number;
  /** perDay only: the most it can take, as a percent of the points (100 = no cap). */
  max: number;
  /** Grade band ids (grade-scale.ts). */
  bands: string[];
  /** Category names, lower case (categories are per course; the name is what a school can know). */
  categories: string[];
  kinds: WorkKind[];
};

/** May teachers set their own policy for a course: no, yes, or only within the limits. */
export type TeacherChoice = "no" | "yes" | "within";
export type LateLimits = { minPercent: number; maxPercent: number; maxCap: number };
export type LatePolicies = { rules: LateRule[]; teachers: TeacherChoice; limits: LateLimits };
export type CoursePolicy = { kind: LateKind; percent: number; max: number };

export const DEFAULT_LATE: LatePolicies = { rules: [], teachers: "no", limits: { minPercent: 0, maxPercent: 100, maxCap: 100 } };
export const LATE_LIMITS = { rules: 20, name: 60, days: 60 };

/** The policy that applies to one assignment, and where it came from. */
export type Applied = CoursePolicy & { name: string; from: "school" | "course" };

/** A teacher's change to one grade's penalty. */
export type LateOverride = { waive: true } | { percent: number } | { days: number };

export type Penalty = {
  days: number;
  /** Percent of the points taken off. */
  percent: number;
  /** Points taken off (before the floor at 0). */
  points: number;
  rule: string;
  override: LateOverride | null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const pct = (v: unknown, dflt: number) => {
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) && String(v ?? "").trim() !== "" ? Math.min(100, Math.max(0, round2(n))) : dflt;
};
const line = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const strings = (v: unknown, max: number) =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string").map((x) => line(x, max)).filter(Boolean))] : [];

function cleanPolicy(r: Record<string, unknown>): CoursePolicy {
  const kind = LATE_KINDS.includes(r?.kind as LateKind) ? (r.kind as LateKind) : "none";
  return {
    kind,
    percent: kind === "none" ? 0 : pct(r?.percent, 10),
    max: kind === "perDay" ? pct(r?.max, 100) || 100 : 0,
  };
}

/** The only way a school's late policies come in. */
export function normalizePolicies(input: unknown): LatePolicies {
  const v = (input ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(v.rules) ? (v.rules as Record<string, unknown>[]).slice(0, LATE_LIMITS.rules) : [];
  const ids = new Set<string>();
  const rules: LateRule[] = raw.map((r, i) => {
    let id = line(r?.id, 40).replace(/[^\w-]/g, "");
    if (!id || ids.has(id)) id = `r${i}-${Math.random().toString(36).slice(2, 8)}`;
    ids.add(id);
    return {
      id,
      name: line(r?.name, LATE_LIMITS.name),
      ...cleanPolicy(r),
      bands: strings(r?.bands, 40),
      categories: strings(r?.categories, 60).map((c) => c.toLowerCase()),
      kinds: WORK_KINDS.filter((k) => Array.isArray(r?.kinds) && (r.kinds as unknown[]).includes(k)),
    };
  });
  const teachers: TeacherChoice = v.teachers === "yes" || v.teachers === "within" ? v.teachers : "no";
  const l = (v.limits ?? {}) as Record<string, unknown>;
  const minPercent = pct(l.minPercent, 0), maxPercent = Math.max(minPercent, pct(l.maxPercent, 100));
  return { rules, teachers, limits: { minPercent, maxPercent, maxCap: pct(l.maxCap, 100) } };
}

export function readPolicies(value: unknown): LatePolicies {
  if (!value) return DEFAULT_LATE;
  return normalizePolicies(typeof value === "string" ? JSON.parse(value) : value);
}

/**
 * A teacher's own policy for a course: null (use the school's), the policy,
 * or refused when the school doesn't allow it or it is outside the limits.
 */
export function normalizeCoursePolicy(input: unknown, school: LatePolicies): { ok: true; policy: CoursePolicy | null } | { ok: false; reason: "notAllowed" | "outsideLimits" } {
  if (input === null || input === undefined || input === "" || (input as { kind?: unknown }).kind === "school") return { ok: true, policy: null };
  if (school.teachers === "no") return { ok: false, reason: "notAllowed" };
  const p = cleanPolicy(input as Record<string, unknown>);
  if (school.teachers === "within" && !withinLimits(p, school.limits)) return { ok: false, reason: "outsideLimits" };
  return { ok: true, policy: p };
}

export function withinLimits(p: CoursePolicy, l: LateLimits): boolean {
  if (p.kind === "none") return l.minPercent === 0;
  if (p.percent < l.minPercent || p.percent > l.maxPercent) return false;
  return p.kind !== "perDay" || p.max <= l.maxCap;
}

/**
 * Which policy applies to an assignment: the course's own (if the school
 * allows it and it is still within the limits), else the school's first
 * rule that matches the course's band, the assignment's category and kind.
 * Null = no penalty, late is a mark only.
 */
export function ruleFor(
  school: LatePolicies, course: CoursePolicy | null,
  work: { band: string; category: string | null; kind: WorkKind },
): Applied | null {
  if (course && school.teachers !== "no" && (school.teachers === "yes" || withinLimits(course, school.limits))) {
    return { ...course, name: "", from: "course" };
  }
  const cat = work.category?.trim().toLowerCase() ?? null;
  for (const r of school.rules) {
    if (r.bands.length && !r.bands.includes(work.band)) continue;
    if (r.categories.length && (!cat || !r.categories.includes(cat))) continue;
    if (r.kinds.length && !r.kinds.includes(work.kind)) continue;
    return { kind: r.kind, percent: r.percent, max: r.max, name: r.name, from: "school" };
  }
  return null;
}

// ---------- how late ----------

/** A moment's day and "HH:MM" on the school's wall clock. */
export function localAt(iso: string, timeZone: string): { day: Day; time: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/**
 * School days late for work due at `dueAt` and handed in at `handedInAt`:
 * 0 when on time, or when it was late only during the Sabbath (due in the
 * Sabbath hours and handed in before that Sabbath ended); otherwise the
 * school days after the due day up to the hand-in day, at least 1.
 */
export function lateDays(dueAt: string, handedInAt: string, timeZone: string): number {
  const due = new Date(dueAt).getTime(), at = new Date(handedInAt).getTime();
  if (!(at > due)) return 0;
  const d = localAt(dueAt, timeZone), h = localAt(handedInAt, timeZone);
  if (onSabbath(d.day, d.time) && onSabbath(h.day, h.time)) {
    const saturday = weekday(d.day) === 6 ? d.day : addDays(d.day, 1);
    if (h.day <= saturday) return 0;
  }
  let n = 0;
  for (let x = addDays(d.day, 1), i = 0; x <= h.day && i < 800; x = addDays(x, 1), i++) if (isSchoolDay(x)) n++;
  return Math.max(1, n);
}

// ---------- what it costs ----------

export function normalizeOverride(v: unknown): LateOverride | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.waive === true) return { waive: true };
  if (o.percent !== undefined && o.percent !== null && String(o.percent).trim() !== "") {
    const n = Number(String(o.percent).replace(",", "."));
    return Number.isFinite(n) ? { percent: Math.min(100, Math.max(0, round2(n))) } : null;
  }
  if (o.days !== undefined && o.days !== null && String(o.days).trim() !== "") {
    const n = Math.floor(Number(o.days));
    return Number.isFinite(n) ? { days: Math.min(LATE_LIMITS.days, Math.max(0, n)) } : null;
  }
  return null;
}

export type LateCell = {
  score: number | null;
  flag: Flag | null;
  /** Days late from the hand-in time (online work and quizzes handed in after due_at); null = not late by the clock. */
  autoDays: number | null;
  override: LateOverride | null;
};

/**
 * The penalty on one grade, or null when there is none to show: no policy,
 * no score (missing stays 0 by its own rule), exempt, or not late.
 */
export function penaltyFor(rule: Applied | null, points: number, c: LateCell): Penalty | null {
  if (!rule || c.score === null || c.flag === "exempt") return null;
  if (c.flag !== "late" && c.autoDays === null) return null;
  const o = c.override;
  const days = o && "days" in o ? o.days : c.autoDays ?? 1;
  let percent = days === 0 || rule.kind === "none" ? 0
    : rule.kind === "flat" ? rule.percent
    : Math.min(rule.percent * days, rule.max || 100);
  if (o && "waive" in o) percent = 0;
  if (o && "percent" in o) percent = o.percent;
  percent = Math.min(100, Math.max(0, round2(percent)));
  return { days, percent, points: round2((points * percent) / 100), rule: rule.name, override: o };
}

/** The score that counts: the raw score less the penalty, never below 0. */
export function finalScore(score: number, p: Penalty | null): number {
  return p ? Math.max(0, round2(score - p.points)) : score;
}

/** A policy in words ("10% off per school day, at most 50%"). */
export function ruleText(r: Pick<CoursePolicy, "kind" | "percent" | "max">, d: { latePerDayText: string; lateFlatText: string; lateNoneText: string }): string {
  if (r.kind === "perDay") return d.latePerDayText.replace("{p}", String(r.percent)).replace("{max}", String(r.max || 100));
  if (r.kind === "flat") return d.lateFlatText.replace("{p}", String(r.percent));
  return d.lateNoneText;
}
