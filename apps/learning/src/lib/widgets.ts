/**
 * Desk tools in the left rail (under To do), rebuilt from Teacher's Desk's
 * widgets like the lesson blocks were. Pure: the kinds, the school's policy,
 * and how one person's list is worked out, in layers:
 *
 *   the school's defaults (school admins, /school/widgets, versioned)
 *     → in a class, the students' defaults the class's teacher chose, when
 *       the school lets teachers choose (only kinds the school allows students)
 *     → the person's own list (add, remove, reorder), per context
 *       ("home" or one class).
 *
 * Students (and parents: anyone not on staff) never get a tool that shows
 * other students' names (name picker, groups, seating chart), whatever is
 * stored; `forViewer` is the last filter on every read and every save.
 */

export const WIDGET_KINDS = ["clock", "timer", "noise", "picker", "groups", "seating"] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];

/** Tools that show a class's names: staff only, ever. */
export const ROSTER_KINDS: ReadonlySet<WidgetKind> = new Set(["picker", "groups", "seating"]);
/** What a student may ever be given (the school chooses within this). */
export const STUDENT_SAFE: readonly WidgetKind[] = WIDGET_KINDS.filter((k) => !ROSTER_KINDS.has(k));

export type Audience = "staff" | "student";
export type Place = "home" | "class";

export type SchoolWidgets = {
  /** Staff on the home page (and pages that aren't one class). */
  staffHome: WidgetKind[];
  /** Staff in a class they teach. */
  staffClass: WidgetKind[];
  /** Students and parents outside a class. */
  studentHome: WidgetKind[];
  /** Students in a class, unless the class's teacher chose otherwise. */
  studentClass: WidgetKind[];
  /** The tools students may have at all (never a roster tool). */
  studentAllowed: WidgetKind[];
  /** May a class's teachers choose their students' defaults (within studentAllowed)? */
  teachersChoose: boolean;
};

// Desmond, 2026-11-22: teachers in a class get the student randomizer, group
// randomizer, timer and seating chart; teachers on home the clock, timer and
// noise meter; students the clock everywhere.
export const DEFAULT_SCHOOL_WIDGETS: SchoolWidgets = {
  staffHome: ["clock", "timer", "noise"],
  staffClass: ["picker", "groups", "timer", "seating"],
  studentHome: ["clock"],
  studentClass: ["clock"],
  studentAllowed: ["clock", "timer"],
  teachersChoose: true,
};

const isKind = (v: unknown): v is WidgetKind => typeof v === "string" && (WIDGET_KINDS as readonly string[]).includes(v);

/** Known kinds only, each once, in the order given. */
export function cleanKinds(input: unknown): WidgetKind[] {
  if (!Array.isArray(input)) return [];
  const out: WidgetKind[] = [];
  for (const v of input.slice(0, 40)) if (isKind(v) && !out.includes(v)) out.push(v);
  return out;
}

const studentOnly = (kinds: WidgetKind[], allowed: WidgetKind[]) => kinds.filter((k) => !ROSTER_KINDS.has(k) && allowed.includes(k));

/** The only way a school's choice is read or saved: unknown kinds dropped, students' lists kept inside what students may have. */
export function normalizeSchoolWidgets(input: unknown): SchoolWidgets {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const has = (k: string) => Array.isArray(o[k]);
  const pick = (k: keyof SchoolWidgets) => (has(k) ? cleanKinds(o[k]) : (DEFAULT_SCHOOL_WIDGETS[k] as WidgetKind[]).slice());
  const studentAllowed = pick("studentAllowed").filter((k) => !ROSTER_KINDS.has(k));
  return {
    staffHome: pick("staffHome"),
    staffClass: pick("staffClass"),
    studentHome: studentOnly(pick("studentHome"), studentAllowed),
    studentClass: studentOnly(pick("studentClass"), studentAllowed),
    studentAllowed,
    teachersChoose: typeof o.teachersChoose === "boolean" ? o.teachersChoose : DEFAULT_SCHOOL_WIDGETS.teachersChoose,
  };
}

/** What this person may have here at all. */
export function allowedFor(school: SchoolWidgets, audience: Audience): WidgetKind[] {
  return audience === "staff" ? [...WIDGET_KINDS] : school.studentAllowed.slice();
}

/** The last filter on everything a person is shown or saves. */
export function forViewer(kinds: WidgetKind[], school: SchoolWidgets, audience: Audience): WidgetKind[] {
  const ok = allowedFor(school, audience);
  return cleanKinds(kinds).filter((k) => ok.includes(k) && (audience === "staff" || !ROSTER_KINDS.has(k)));
}

/** A teacher's choice of students' defaults for one class, checked against the school's policy (null = not allowed / not set). */
export function classStudentDefaults(school: SchoolWidgets, chosen: unknown): WidgetKind[] | null {
  if (!school.teachersChoose || chosen == null) return null;
  return studentOnly(cleanKinds(chosen), school.studentAllowed);
}

export type Layers = {
  school: SchoolWidgets;
  audience: Audience;
  place: Place;
  /** courses.student_widgets for this class (raw; checked here). */
  classStudents?: unknown;
  /** The person's own saved list for this context (raw), or null when they haven't changed it. */
  own?: unknown;
};

export type Resolved = {
  widgets: WidgetKind[];
  /** Where the list came from. */
  from: "own" | "class" | "school";
  /** The defaults this person would go back to on "Back to the defaults". */
  defaults: WidgetKind[];
  /** Kinds they could still add. */
  addable: WidgetKind[];
};

/** One person's tools in one place: school → class (students) → their own. */
export function resolveWidgets(l: Layers): Resolved {
  const { school, audience, place } = l;
  let defaults: WidgetKind[];
  let from: Resolved["from"] = "school";
  if (audience === "staff") defaults = place === "class" ? school.staffClass : school.staffHome;
  else if (place === "class") {
    const chosen = classStudentDefaults(school, l.classStudents);
    if (chosen) from = "class";
    defaults = chosen ?? school.studentClass;
  } else defaults = school.studentHome;
  defaults = forViewer(defaults, school, audience);
  const own = l.own == null ? null : forViewer(cleanKinds(l.own), school, audience);
  const widgets = own ?? defaults;
  return {
    widgets, from: own ? "own" : from, defaults,
    addable: allowedFor(school, audience).filter((k) => !widgets.includes(k) && (audience === "staff" || !ROSTER_KINDS.has(k))),
  };
}

/** A context key: "home" or a class's course id. */
export function contextKey(courseId: string | null): string {
  return courseId && /^[0-9a-f-]{36}$/i.test(courseId) ? courseId : "home";
}

// ---------- seating chart ----------

/** Seats in a grid of desks, by Signify id only (names come from ID, live). */
export type Seating = { rows: number; cols: number; seats: Record<string, string> };
export const EMPTY_SEATING: Seating = { rows: 5, cols: 6, seats: {} };

/** Keeps the grid within 1-10 × 1-10 and seats inside it, one seat per person; `known` (live roster ids) drops anyone else. */
export function normalizeSeating(input: unknown, known?: ReadonlySet<string>): Seating {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const n = (v: unknown, d: number) => (Number.isInteger(v) ? Math.min(10, Math.max(1, Number(v))) : d);
  const rows = n(o.rows, EMPTY_SEATING.rows);
  const cols = n(o.cols, EMPTY_SEATING.cols);
  const seats: Record<string, string> = {};
  const used = new Set<string>();
  const raw = o.seats && typeof o.seats === "object" ? (o.seats as Record<string, unknown>) : {};
  for (const [key, who] of Object.entries(raw).slice(0, 200)) {
    const m = /^(\d+)-(\d+)$/.exec(key);
    if (!m || typeof who !== "string" || !who || who.length > 80) continue;
    const r = Number(m[1]), c = Number(m[2]);
    if (r >= rows || c >= cols || used.has(who)) continue;
    if (known && !known.has(who)) continue;
    used.add(who);
    seats[`${r}-${c}`] = who;
  }
  return { rows, cols, seats };
}

/** Everyone in a seat, at random; people already seated stay unless `all`. `rand` gives [0, 1). */
export function fillSeats(s: Seating, ids: string[], rand: () => number, all = false): Seating {
  const seats: Record<string, string> = all ? {} : { ...s.seats };
  const seated = new Set(Object.values(seats));
  const left = shuffle(ids.filter((id) => !seated.has(id)), rand);
  for (let r = 0; r < s.rows && left.length; r++) {
    for (let c = 0; c < s.cols && left.length; c++) {
      const k = `${r}-${c}`;
      if (!seats[k]) seats[k] = left.shift()!;
    }
  }
  return { ...s, seats };
}

// ---------- groups ----------

export function shuffle<T>(list: T[], rand: () => number): T[] {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Deals people into groups: `count` groups, or groups of `size` (the last ones a person smaller), sizes balanced. */
export function makeGroups<T>(people: T[], how: { count?: number; size?: number }, rand: () => number): T[][] {
  if (!people.length) return [];
  const n = how.size
    ? Math.max(1, Math.ceil(people.length / Math.max(1, Math.floor(how.size))))
    : Math.max(1, Math.min(people.length, Math.floor(how.count ?? 2)));
  const groups: T[][] = Array.from({ length: n }, () => []);
  shuffle(people, rand).forEach((p, i) => groups[i % n].push(p));
  return groups;
}
