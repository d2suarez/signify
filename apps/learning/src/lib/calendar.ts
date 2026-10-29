/**
 * The class calendar's date arithmetic, on plain "YYYY-MM-DD" days (the
 * teacher's calendar day, as lessons and due dates are stored), and the
 * Sabbath rule from PLAN.md. Pure, so it is tested directly.
 */

export type Day = string; // YYYY-MM-DD

const pad = (n: number) => String(n).padStart(2, "0");
export const dayOf = (y: number, m0: number, d: number): Day => `${y}-${pad(m0 + 1)}-${pad(d)}`;

/** The weeks (Sunday first) covering a month; days outside it are null. */
export function monthGrid(year: number, month0: number): (Day | null)[][] {
  const first = new Date(Date.UTC(year, month0, 1)).getUTCDay();
  const days = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  const cells: (Day | null)[] = [...Array(first).fill(null), ...Array.from({ length: days }, (_, i) => dayOf(year, month0, i + 1))];
  while (cells.length % 7) cells.push(null);
  const weeks: (Day | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

export function addMonths(year: number, month0: number, by: number): { year: number; month0: number } {
  const n = year * 12 + month0 + by;
  return { year: Math.floor(n / 12), month0: ((n % 12) + 12) % 12 };
}

export function weekday(day: Day): number {
  return new Date(`${day}T12:00:00Z`).getUTCDay();
}

/**
 * Friday from 6 pm through Saturday: roughly sunset to sunset. `time` is the
 * local "HH:MM" it's due (a day with no time counts as the end of the day).
 */
export function onSabbath(day: Day | null | undefined, time = "23:59"): boolean {
  if (!day) return false;
  const dow = weekday(day);
  return dow === 6 || (dow === 5 && time >= "18:00");
}
