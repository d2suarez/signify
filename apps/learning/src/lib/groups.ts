/**
 * Groups (teacher story 01, A8/D8): pure, so the editor in the browser and
 * the server share it, and it is tested directly. A group set is a class's
 * named list of groups; a student is in at most one group of a set.
 * Storing and reading sets is group-sets.ts.
 */

export type GroupMember = { id: string; name: string };
export type Group = { id: string; name: string; members: GroupMember[] };

export const GROUP_LIMITS = { groups: 40, name: 60, setName: 80, members: 60 } as const;

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

function line(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

export function newGroupId(): string {
  return "g" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
}

/** "Group 1", "Group 2"… (the word comes from the page's language). */
export function groupName(word: string, i: number): string {
  return `${word} ${i + 1}`;
}

/**
 * Groups as a browser sent them, made safe: known shapes only, names
 * trimmed, each student once (their first group wins), and, given the class
 * (id -> name from Signify ID), only the class's students, named as ID names
 * them. Without a class the names are kept as sent (used for stored sets).
 * Empty groups are kept: a teacher making groups by hand starts with them.
 */
export function normalizeGroups(input: unknown, roster?: Map<string, string>, word = "Group"): Group[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const ids = new Set<string>();
  const out: Group[] = [];
  for (const raw of input.slice(0, GROUP_LIMITS.groups)) {
    if (!raw || typeof raw !== "object") continue;
    const g = raw as Record<string, unknown>;
    let id = typeof g.id === "string" && ID_RE.test(g.id) ? g.id : newGroupId();
    while (ids.has(id)) id = newGroupId();
    ids.add(id);
    const members: GroupMember[] = [];
    for (const m of Array.isArray(g.members) ? g.members : []) {
      const mid = typeof m === "string" ? m : m && typeof m === "object" ? (m as Record<string, unknown>).id : null;
      if (typeof mid !== "string" || !mid || mid.length > 200 || seen.has(mid)) continue;
      if (roster && !roster.has(mid)) continue;
      const name = roster ? roster.get(mid)! : line((m as Record<string, unknown>)?.name, 120);
      seen.add(mid);
      members.push({ id: mid, name });
      if (members.length >= GROUP_LIMITS.members) break;
    }
    out.push({ id, name: line(g.name, GROUP_LIMITS.name) || groupName(word, out.length), members });
  }
  return out;
}

/** Fisher-Yates with a given random source (tests pass their own). */
export function shuffled<T>(list: T[], rand: () => number = Math.random): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * The class dealt out at random, either into `count` groups or into groups
 * of `size` (the last groups one smaller where it doesn't divide). Sizes
 * never differ by more than one.
 */
export function randomGroups(
  people: GroupMember[], how: { count: number } | { size: number }, word = "Group", rand: () => number = Math.random,
): Group[] {
  const n = people.length;
  const count = "count" in how
    ? Math.max(1, Math.min(GROUP_LIMITS.groups, Math.floor(how.count) || 1))
    : Math.max(1, Math.min(GROUP_LIMITS.groups, Math.ceil(n / Math.max(1, Math.floor(how.size) || 1))));
  const groups: Group[] = Array.from({ length: count }, (_, i) => ({ id: newGroupId(), name: groupName(word, i), members: [] }));
  shuffled(people, rand).forEach((p, i) => groups[i % count].members.push(p));
  return groups;
}

/** Which group of a set a student is in (its index), or null. */
export function groupIndexOf(groups: Group[], studentId: string): number | null {
  const i = groups.findIndex((g) => g.members.some((m) => m.id === studentId));
  return i < 0 ? null : i;
}

/** The class's students who are in no group of the set. */
export function ungrouped(groups: Group[], people: GroupMember[]): GroupMember[] {
  const inOne = new Set(groups.flatMap((g) => g.members.map((m) => m.id)));
  return people.filter((p) => !inOne.has(p.id));
}

/**
 * What a group slide shows. The teacher and a live class see every group;
 * a student outside the live slide sees only their own (or nothing when
 * they are in none). Only names: never ids.
 */
export type GroupsShown = { name: string; groups: { name: string; members: string[] }[]; mine: number | null; onlyMine: boolean };

export function showGroups(name: string, groups: Group[], viewer: { studentId: string | null; live: boolean }): GroupsShown {
  const mine = viewer.studentId ? groupIndexOf(groups, viewer.studentId) : null;
  const all = groups.map((g) => ({ name: g.name, members: g.members.map((m) => m.name) }));
  if (!viewer.studentId || viewer.live) return { name, groups: all, mine, onlyMine: false };
  return { name, groups: mine == null ? [] : [all[mine]], mine: mine == null ? null : 0, onlyMine: true };
}
