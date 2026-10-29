/**
 * The lesson planner's date arithmetic, on plain "YYYY-MM-DD" days. A school
 * day is Monday to Friday: nothing is ever placed on Saturday (the Sabbath
 * rule in PLAN.md) or Sunday. Pure, so it is tested directly.
 */

import { weekday, type Day } from "./calendar";

export function addDays(day: Day, by: number): Day {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
}

export const isSchoolDay = (day: Day) => { const w = weekday(day); return w >= 1 && w <= 5; };

/** The day itself if it's a school day, else the next Monday. */
export function nextSchoolDay(day: Day): Day {
  let d = day;
  while (!isSchoolDay(d)) d = addDays(d, 1);
  return d;
}

/** School days after `day`, skipping weekends: addSchoolDays(Fri, 1) = Mon. */
export function addSchoolDays(day: Day, by: number): Day {
  let d = nextSchoolDay(day);
  const step = by < 0 ? -1 : 1;
  for (let n = Math.abs(by); n > 0;) {
    d = addDays(d, step);
    if (isSchoolDay(d)) n--;
  }
  return d;
}

/** Monday to Friday of the week holding `day` (a weekend gives the next week). */
export function schoolWeek(day: Day): Day[] {
  const w = weekday(day);
  const monday = w === 0 ? addDays(day, 1) : w === 6 ? addDays(day, 2) : addDays(day, 1 - w);
  return Array.from({ length: 5 }, (_, i) => addDays(monday, i));
}

/** "Plan the unit": one lesson per school day from `start`, in order. */
export function spreadLessons<T extends { id: string }>(lessons: T[], start: Day): { id: string; plannedFor: Day }[] {
  let d = nextSchoolDay(start);
  return lessons.map((l, i) => {
    if (i > 0) d = addSchoolDays(d, 1);
    return { id: l.id, plannedFor: d };
  });
}

/**
 * A class day was lost (assembly, snow day): every lesson planned on or after
 * `from` moves back one school day. Returns only the lessons that move.
 */
export function pushBack<T extends { id: string; plannedFor: Day | null }>(lessons: T[], from: Day, by = 1): { id: string; plannedFor: Day }[] {
  return lessons
    .filter((l) => l.plannedFor && l.plannedFor >= from)
    .map((l) => ({ id: l.id, plannedFor: addSchoolDays(l.plannedFor!, by) }));
}

/** Today in the school's time zone (the server runs in UTC). */
export function todayIn(timeZone: string, now = new Date()): Day {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** A ?week= value if it's a real day, else null. */
export function parseDay(v: unknown): Day | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T12:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : null;
}
