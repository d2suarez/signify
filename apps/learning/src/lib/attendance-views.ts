import { getDb } from "./db";
import { addDays, addSchoolDays, isSchoolDay, parseDay, schoolWeek } from "./planner";
import type { Day } from "./calendar";
import type { Status } from "./attendance";

/**
 * More ways to look at attendance (Desmond 2026-11-23: "week, month, term,
 * trends"). The record is `attendance.ts`'s; this only reads it. Pure
 * range and summary maths first (tested directly), then the two reads:
 * one class's records (its teachers) and the school's (its admins).
 * Students and parents never come here: they have `my-attendance.ts`.
 */

export const VIEWS = ["day", "week", "month", "term", "trends"] as const;
export type View = (typeof VIEWS)[number];
export const asView = (v: unknown): View => VIEWS.find((x) => x === v) ?? "day";

export type Period = { id: string; name: string; startsOn: string; endsOn: string };

export type Range = {
  from: Day; to: Day;
  /** The school days in the range up to today, in order. */
  days: Day[];
  /** A day in the range before / after (for ← →); null when there is none to show. */
  prev: Day | null; next: Day | null;
};

/** School days from `from` to `to` (inclusive), never after `today`. At most 400. */
export function schoolDaysBetween(from: Day, to: Day, today: Day): Day[] {
  const out: Day[] = [];
  const end = to < today ? to : today;
  for (let d = from; d <= end && out.length < 400; d = addDays(d, 1)) if (isSchoolDay(d)) out.push(d);
  return out;
}

/** Monday to Friday of the week holding `day`. */
export function weekRange(day: Day, today: Day): Range {
  const w = schoolWeek(day);
  const from = w[0], to = w[4];
  const next = addDays(from, 7);
  return { from, to, days: schoolDaysBetween(from, to, today), prev: addDays(from, -7), next: next <= today ? next : null };
}

/** The calendar month holding `day`. */
export function monthRange(day: Day, today: Day): Range {
  const from = `${day.slice(0, 7)}-01`;
  const nextMonth = addDays(from, 32).slice(0, 7) + "-01";
  const to = addDays(nextMonth, -1);
  const prev = addDays(from, -1).slice(0, 7) + "-01";
  return { from, to, days: schoolDaysBetween(from, to, today), prev, next: nextMonth <= today ? nextMonth : null };
}

/** The grading period to show: the one asked for, else the one today is in, else the last one started, else the first. */
export function pickPeriod(periods: Period[], today: Day, asked?: string | null): Period | null {
  if (!periods.length) return null;
  const byId = asked ? periods.find((p) => p.id === asked) : undefined;
  if (byId) return byId;
  // Nested periods (a semester holding quarters): the shortest one today is in.
  const now = periods.filter((p) => p.startsOn <= today && today <= p.endsOn)
    .sort((a, b) => spanDays(a) - spanDays(b));
  if (now.length) return now[0];
  const started = periods.filter((p) => p.startsOn <= today).sort((a, b) => b.startsOn.localeCompare(a.startsOn));
  return started[0] ?? [...periods].sort((a, b) => a.startsOn.localeCompare(b.startsOn))[0];
}
const spanDays = (p: Period) => (Date.parse(p.endsOn) - Date.parse(p.startsOn)) / 86_400_000;

export function periodRange(p: Period, today: Day): Range {
  return { from: p.startsOn, to: p.endsOn, days: schoolDaysBetween(p.startsOn, p.endsOn, today), prev: null, next: null };
}

/** Trends with no grading periods set up: the last eight school weeks. */
export function recentWeeksRange(today: Day, weeks = 8): Range {
  const from = schoolWeek(addDays(today, -7 * (weeks - 1)))[0];
  return { from, to: today, days: schoolDaysBetween(from, today, today), prev: null, next: null };
}

// ---------- summaries ----------

export type Rec = { courseId: string; day: Day; studentId: string; name: string; status: Status };
export type Counts = Record<Status, number>;
export const zero = (): Counts => ({ present: 0, absent: 0, tardy: 0, excused: 0 });

/**
 * The share of class meetings a student was there for: present or tardy,
 * out of the meetings marked. Excused meetings aren't counted either way.
 * Null when nothing counts.
 */
export function rateOf(c: Counts): number | null {
  const n = c.present + c.tardy + c.absent;
  return n ? (c.present + c.tardy) / n : null;
}

export const pct = (r: number | null) => (r == null ? "–" : `${Math.round(r * 100)}%`);

export type StudentSummary = {
  studentId: string; name: string; counts: Counts; marked: number; rate: number | null;
  /** The last two school weeks, and the time before them in the range. */
  recent: Counts; recentRate: number | null; earlierRate: number | null;
  slipping: boolean;
};

/**
 * Per student (records may span classes: the school's view counts each
 * class meeting), with whether they are slipping: in the last ten school
 * days at least three meetings missed or late, or a rate at least 15
 * points under their own earlier rate (with enough days on both sides).
 */
export function summarize(recs: Rec[], today: Day, names: Map<string, string> = new Map()): StudentSummary[] {
  const recentFrom = addSchoolDays(today, -9);
  const by = new Map<string, { name: string; all: Counts; recent: Counts; earlier: Counts; lastDay: Day }>();
  for (const id of names.keys()) by.set(id, { name: names.get(id)!, all: zero(), recent: zero(), earlier: zero(), lastDay: "" });
  for (const r of recs) {
    const s = by.get(r.studentId) ?? { name: r.name, all: zero(), recent: zero(), earlier: zero(), lastDay: "" };
    if (!names.has(r.studentId) && r.day >= s.lastDay && r.name) { s.name = r.name; s.lastDay = r.day; }
    s.all[r.status]++;
    (r.day >= recentFrom ? s.recent : s.earlier)[r.status]++;
    by.set(r.studentId, s);
  }
  return [...by.entries()].map(([studentId, s]) => {
    const recentRate = rateOf(s.recent), earlierRate = rateOf(s.earlier);
    const recentN = s.recent.present + s.recent.tardy + s.recent.absent;
    const earlierN = s.earlier.present + s.earlier.tardy + s.earlier.absent;
    const slipping = s.recent.absent + s.recent.tardy >= 3
      || (recentN >= 3 && earlierN >= 5 && recentRate != null && earlierRate != null && recentRate <= earlierRate - 0.15);
    return {
      studentId, name: s.name, counts: s.all, marked: STATUS_SUM(s.all), rate: rateOf(s.all),
      recent: s.recent, recentRate, earlierRate, slipping,
    };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.studentId.localeCompare(b.studentId));
}
const STATUS_SUM = (c: Counts) => c.present + c.absent + c.tardy + c.excused;

/** Slipping students first by how far under they are. */
export function slippingFirst(list: StudentSummary[]): StudentSummary[] {
  return list.filter((s) => s.slipping).sort((a, b) => (a.recentRate ?? 1) - (b.recentRate ?? 1) || a.name.localeCompare(b.name));
}

export type WeekRate = { monday: Day; counts: Counts; rate: number | null; meetings: number };

/** The rate by school week (Monday), oldest first, every week of the range shown (empty ones too). */
export function weeklyRates(recs: Rec[], range: Range): WeekRate[] {
  const weeks = new Map<Day, WeekRate>();
  for (const d of range.days) {
    const m = schoolWeek(d)[0];
    if (!weeks.has(m)) weeks.set(m, { monday: m, counts: zero(), rate: null, meetings: 0 });
  }
  const meetings = new Map<Day, Set<string>>();
  for (const r of recs) {
    const m = schoolWeek(r.day)[0];
    const w = weeks.get(m);
    if (!w) continue;
    w.counts[r.status]++;
    const set = meetings.get(m) ?? new Set();
    set.add(`${r.courseId}|${r.day}`);
    meetings.set(m, set);
  }
  return [...weeks.values()].map((w) => ({ ...w, rate: rateOf(w.counts), meetings: meetings.get(w.monday)?.size ?? 0 }));
}

/** A student's mark for each day (null = not marked), for the week and month grids. */
export function gridOf(recs: Rec[], days: Day[]): Map<string, (Status | null)[]> {
  const at = new Map(days.map((d, i) => [d, i]));
  const out = new Map<string, (Status | null)[]>();
  for (const r of recs) {
    const i = at.get(r.day);
    if (i == null) continue;
    const row = out.get(r.studentId) ?? days.map(() => null);
    row[i] = r.status;
    out.set(r.studentId, row);
  }
  return out;
}

export type ClassRangeRow = {
  courseId: string; name: string; teacher: string;
  /** Per day of the range: null = not taken, else the counts. */
  cells: (Counts | null)[];
  counts: Counts; daysTaken: number; rate: number | null;
};

/** The school's classes over a range: each day taken or not, and its counts. */
export function classRows(classes: { courseId: string; name: string; teacher: string }[], recs: Rec[], days: Day[]): ClassRangeRow[] {
  const at = new Map(days.map((d, i) => [d, i]));
  const rows = new Map(classes.map((c) => [c.courseId, { ...c, cells: days.map(() => null as Counts | null), counts: zero(), daysTaken: 0, rate: null as number | null }]));
  for (const r of recs) {
    const row = rows.get(r.courseId);
    const i = at.get(r.day);
    if (!row || i == null) continue;
    const cell = row.cells[i] ?? (row.cells[i] = zero());
    cell[r.status]++;
    row.counts[r.status]++;
  }
  return [...rows.values()].map((r) => ({ ...r, daysTaken: r.cells.filter(Boolean).length, rate: rateOf(r.counts) }));
}

/** The CSV link for a range: the school's export or one class's. */
export function exportHref(base: string, r: Pick<Range, "from" | "to">, today: Day): string {
  const to = r.to < today ? r.to : today;
  return `${base}?from=${r.from}&to=${to}`;
}

/** A sane "?day=" for the range views: a real day, never after today. */
export function anchorDay(asked: unknown, today: Day): Day {
  const d = parseDay(asked) ?? today;
  return d > today ? today : d;
}

// ---------- reads ----------

const dayOf = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/** Attendance records from `from` to `to` for some classes of one school. */
export async function rangeRecords(tenantId: string, courseIds: string[], from: Day, to: Day): Promise<Rec[]> {
  if (!courseIds.length) return [];
  const db = await getDb();
  const rows = await db.query(
    `SELECT course_id, day, student_id, student_name, status FROM attendance
      WHERE tenant_id = $1 AND course_id = ANY($2::uuid[]) AND day BETWEEN $3 AND $4
      ORDER BY day LIMIT 200000`,
    [tenantId, courseIds, from, to]);
  return rows.map((r) => ({
    courseId: String(r.course_id), day: dayOf(r.day), studentId: String(r.student_id), name: String(r.student_name), status: r.status as Status,
  }));
}

/** Today's counts for some classes (the home page's "Take attendance" list). Absent from the map = not taken. */
export async function takenOn(tenantId: string, courseIds: string[], day: Day): Promise<Map<string, Counts>> {
  const out = new Map<string, Counts>();
  if (!courseIds.length) return out;
  const db = await getDb();
  const rows = await db.query(
    `SELECT course_id, status, count(*)::int AS n FROM attendance
      WHERE tenant_id = $1 AND course_id = ANY($2::uuid[]) AND day = $3 GROUP BY course_id, status`,
    [tenantId, courseIds, day]);
  for (const r of rows) {
    const c = out.get(String(r.course_id)) ?? zero();
    c[r.status as Status] = Number(r.n);
    out.set(String(r.course_id), c);
  }
  return out;
}
