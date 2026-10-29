/**
 * How a grade is worked out. No database here: this runs on the server and,
 * as grades are typed, in the gradebook grid in the browser.
 */

export type Flag = "missing" | "late" | "exempt";
export const FLAGS: Flag[] = ["missing", "late", "exempt"];

type HasPoints = { id: string; points: number; categoryId: string | null };
type HasDue = { dueOn: string | null };
type PeriodRange = { startsOn: string; endsOn: string };

/**
 * Which assignments count in a period: those due on a day inside it. One
 * with no due date counts in every period (and in the whole year), and the
 * gradebook warns about it.
 */
export function inPeriod(a: HasDue, p: PeriodRange | null): boolean {
  if (!p || !a.dueOn) return true;
  return a.dueOn >= p.startsOn && a.dueOn <= p.endsOn;
}

export type CalcAssignment = HasPoints;
export type CalcGrade = { score: number | null; flag: Flag | null };

export type CourseGrade = {
  /** 0–100 (or more, with extra credit), unrounded; null when nothing counts yet. */
  percent: number | null;
  /** Category id → that category's percent, for the weighted method. */
  byCategory: Record<string, number | null>;
  counted: number;
  /** Assignments left out by a category's "drop lowest". */
  dropped: string[];
};

export type CalcCategory = { id: string; weight: number; dropLowest?: number };

/** Most a category may drop; the setting is refused past this. */
export const MAX_DROP = 10;

type Counted = { id: string; earned: number; possible: number };

/**
 * Which of a category's counted grades its "drop lowest n" leaves out: the
 * n lowest by percent (a missing zero first; on a tie, the one worth more
 * points, which helps the student most). At least one grade always stays,
 * and extra-credit-only work (worth 0) is never dropped.
 */
export function droppedIds(list: Counted[], n: number): Set<string> {
  const can = list.filter((c) => c.possible > 0);
  const k = Math.min(Math.max(0, Math.floor(n)), can.length - 1, list.length - 1);
  if (k <= 0) return new Set();
  const order = [...can].sort((a, b) => a.earned / a.possible - b.earned / b.possible || b.possible - a.possible || a.id.localeCompare(b.id));
  return new Set(order.slice(0, k).map((c) => c.id));
}

/** What one grade adds: [earned, possible], or null when it doesn't count. */
function contribution(a: CalcAssignment, g: CalcGrade | undefined): [number, number] | null {
  if (!g || g.flag === "exempt") return null;
  if (g.score !== null) return [g.score, a.points];
  if (g.flag === "missing") return [0, a.points];
  return null; // not graded yet
}

/**
 * One student's grade over these assignments.
 * Points: everything earned over everything possible.
 * Weighted: each category's earned/possible, averaged by weight over the
 * categories that have anything graded yet (so an empty category doesn't
 * count as zero). Uncategorized assignments are left out of a weighted
 * grade; the gradebook warns about them.
 */
export function computeGrade(
  assignments: CalcAssignment[],
  grades: Map<string, CalcGrade>,
  opts: { weighted: boolean; categories: CalcCategory[] },
): CourseGrade {
  // What counts, per category ("" = uncategorized), with each category's drops taken out.
  const byCat = new Map<string, Counted[]>();
  for (const a of assignments) {
    const c = contribution(a, grades.get(a.id));
    if (!c) continue;
    const key = a.categoryId ?? "";
    if (!byCat.has(key)) byCat.set(key, []);
    byCat.get(key)!.push({ id: a.id, earned: c[0], possible: c[1] });
  }
  const dropped: string[] = [];
  for (const cat of opts.categories) {
    const list = byCat.get(cat.id);
    if (!list || !cat.dropLowest) continue;
    const out = droppedIds(list, cat.dropLowest);
    if (!out.size) continue;
    dropped.push(...out);
    byCat.set(cat.id, list.filter((c) => !out.has(c.id)));
  }
  const sum = (list: Counted[] = []) => list.reduce((t, c) => [t[0] + c.earned, t[1] + c.possible], [0, 0]);

  if (!opts.weighted) {
    let earned = 0, possible = 0, counted = 0;
    for (const list of byCat.values()) {
      const [e, p] = sum(list);
      earned += e; possible += p; counted += list.length;
    }
    return { percent: possible > 0 ? (earned / possible) * 100 : null, byCategory: {}, counted, dropped };
  }

  const byCategory: Record<string, number | null> = {};
  let total = 0, weights = 0, counted = 0;
  for (const cat of opts.categories) {
    const list = byCat.get(cat.id) ?? [];
    const [earned, possible] = sum(list);
    counted += list.length;
    const pct = possible > 0 ? (earned / possible) * 100 : null;
    byCategory[cat.id] = pct;
    if (pct !== null && cat.weight > 0) { total += pct * cat.weight; weights += cat.weight; }
  }
  return { percent: weights > 0 ? total / weights : null, byCategory, counted, dropped };
}

/** The whole-number percent that is shown and exported (half rounds up). */
export function wholePercent(p: number): number {
  return Math.floor(p + 0.5 + 1e-9);
}

/** A common US high school scale; the letter follows the rounded percent. */
export const LETTER_SCALE: [number, string][] = [
  [93, "A"], [90, "A−"], [87, "B+"], [83, "B"], [80, "B−"], [77, "C+"],
  [73, "C"], [70, "C−"], [67, "D+"], [63, "D"], [60, "D−"], [0, "F"],
];

export function letterFor(p: number | null): string {
  if (p === null) return "";
  const w = wholePercent(p);
  for (const [min, letter] of LETTER_SCALE) if (w >= min) return letter;
  return "F";
}

// ---------- typing grades into the grid ----------

/** How a grade reads in a gradebook cell: "18", "M", "EX", "18 L", "L". */
export function cellText(g: CalcGrade): string {
  if (g.flag === "missing" && g.score === null) return "M";
  if (g.flag === "exempt") return "EX";
  const score = g.score === null ? "" : String(g.score);
  if (g.flag === "late") return score ? `${score} L` : "L";
  return score;
}

/**
 * What a teacher typed in a cell. A number is a score; M is missing, EX (or
 * X) exempt; a trailing L marks it late ("18 L"). Empty clears it. Anything
 * else is null (refused).
 */
export function parseCell(text: string): { score: string; flag: Flag | null } | null {
  const t = text.trim().toLowerCase().replace(",", ".");
  if (t === "") return { score: "", flag: null };
  if (t === "m" || t === "missing") return { score: "", flag: "missing" };
  if (t === "ex" || t === "x" || t === "e" || t === "exempt") return { score: "", flag: "exempt" };
  if (t === "l" || t === "late") return { score: "", flag: "late" };
  const m = /^(\d+(?:\.\d+)?)\s*(l|late)?$/.exec(t);
  if (!m) return null;
  return { score: m[1], flag: m[2] ? "late" : null };
}
