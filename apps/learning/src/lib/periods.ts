/**
 * The school's grading periods as a tree (pure; no database). Periods nest:
 * a year can hold semesters, a semester quarters, up to MAX_PERIOD_DEPTH
 * levels. A period is only a date range: a parent's grade is worked out from
 * its own whole range (every assignment due inside it), so a semester counts
 * the work of the quarters it holds without adding their grades up. A child
 * lies inside its parent's dates, and periods side by side under the same
 * parent never partly overlap; "the period today is in" is the deepest one.
 */

export const MAX_PERIOD_DEPTH = 4;

export type Period = {
  id: string; name: string; startsOn: string; endsOn: string;
  /** The period this one sits inside (null = top level). */
  parentId: string | null;
  /** 0 = top level, 1 = inside one, … */
  depth: number;
};

export type PeriodRow = { id: string; name: string; startsOn: string; endsOn: string; parentId: string | null };

export type PeriodProblem = "dates" | "parent" | "outside" | "overlap" | "depth" | "children";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Depth first, each level by start date; a period whose parent is gone sits at the top. */
export function treeOrder(rows: PeriodRow[]): Period[] {
  const ids = new Set(rows.map((r) => r.id));
  const kids = new Map<string | null, PeriodRow[]>();
  for (const r of rows) {
    const p = r.parentId && ids.has(r.parentId) && r.parentId !== r.id ? r.parentId : null;
    kids.set(p, [...(kids.get(p) ?? []), { ...r, parentId: p }]);
  }
  const out: Period[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    const list = (kids.get(parent) ?? []).slice().sort((a, b) => a.startsOn.localeCompare(b.startsOn) || a.name.localeCompare(b.name));
    for (const r of list) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({ ...r, depth });
      walk(r.id, depth + 1);
    }
  };
  walk(null, 0);
  // A loop in stored data (never written by savePeriod) still shows, at the top.
  for (const r of rows) if (!seen.has(r.id)) { seen.add(r.id); out.push({ ...r, parentId: null, depth: 0 }); }
  return out;
}

export function childrenOf(periods: Period[], id: string): Period[] {
  return periods.filter((p) => p.parentId === id);
}

/** The deepest period a day falls in (a quarter before its semester), or null. */
export function periodOn(periods: Period[], isoDay: string): Period | null {
  let best: Period | null = null;
  for (const p of periods) if (isoDay >= p.startsOn && isoDay <= p.endsOn && (!best || p.depth > best.depth)) best = p;
  return best;
}

/**
 * Whether a new or changed period fits the tree. `id` is null for a new one.
 * Overlap with a sibling is only checked when the dates or the parent change,
 * so renaming an old period never fails over data saved before nesting.
 */
export function checkPeriod(
  all: Period[], p: { id: string | null; startsOn: string; endsOn: string; parentId: string | null },
): PeriodProblem | null {
  if (!DAY.test(p.startsOn) || !DAY.test(p.endsOn) || p.endsOn < p.startsOn) return "dates";
  const byId = new Map(all.map((x) => [x.id, x]));
  const before = p.id ? byId.get(p.id) : undefined;
  let depth = 0;
  if (p.parentId) {
    const parent = byId.get(p.parentId);
    if (!parent) return "parent";
    // Never inside itself or anything inside it.
    for (let a: Period | undefined = parent; a; a = a.parentId ? byId.get(a.parentId) : undefined) {
      if (a.id === p.id) return "parent";
    }
    if (p.startsOn < parent.startsOn || p.endsOn > parent.endsOn) return "outside";
    depth = parent.depth + 1;
  }
  if (p.id) {
    // The deepest level under it moves along with it.
    const below = (id: string): number => Math.max(0, ...childrenOf(all, id).map((c) => 1 + below(c.id)));
    if (depth + below(p.id) >= MAX_PERIOD_DEPTH) return "depth";
    if (childrenOf(all, p.id).some((c) => c.startsOn < p.startsOn || c.endsOn > p.endsOn)) return "children";
  } else if (depth >= MAX_PERIOD_DEPTH) return "depth";
  const moved = !before || before.startsOn !== p.startsOn || before.endsOn !== p.endsOn || before.parentId !== p.parentId;
  // Side by side means no partial overlap; one holding another whole is fine
  // (a new semester next to the quarters it will hold, before they move in).
  const partly = (s: Period) => s.startsOn <= p.endsOn && p.startsOn <= s.endsOn
    && !(s.startsOn <= p.startsOn && p.endsOn <= s.endsOn) && !(p.startsOn <= s.startsOn && s.endsOn <= p.endsOn);
  if (moved && all.some((s) => s.id !== p.id && s.parentId === p.parentId && partly(s))) return "overlap";
  return null;
}
