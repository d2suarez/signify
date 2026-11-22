/**
 * Teacher's Desk tools in the left rail (under To do; the tools themselves
 * are Desk's own, framed: src/lib/desk.ts). Pure: the kinds, the school's policy,
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

/**
 * Every Teacher's Desk tool the rail can show, each in its Desk family (the
 * drawers of Desk's catalogue: the family is the shape and colour people
 * already know from their desk). The order is the order "Add a tool" lists
 * them in. "picker" is Desk's student randomiser (src/lib/desk.ts).
 */
export const KIND_FAMILY = {
  clock: "time", timer: "time", stopwatch: "time", alarms: "time", countdown: "time",
  picker: "class", groups: "class", seating: "class", behaviour: "class", jobs: "class",
  scoreboard: "class", flashcards: "class", passage: "class", wordcount: "class",
  message: "board", notes: "board", links: "board", qr: "board", picture: "board",
  slides: "board", video: "board", bible: "board", econgraphs: "board",
  noise: "calm", breathing: "calm", music: "calm", soundboard: "calm",
  calculator: "other", calendar: "other", random: "other", emoji: "other", weather: "other",
  whiteboard: "other", atlas: "other", convert: "other", colours: "other", helpdesk: "other",
} as const;
export type WidgetKind = keyof typeof KIND_FAMILY;
export type Family = (typeof KIND_FAMILY)[WidgetKind];
export const WIDGET_KINDS = Object.keys(KIND_FAMILY) as readonly WidgetKind[];
export const FAMILIES: readonly Family[] = ["time", "class", "board", "calm", "other"];
/** The family's shape, as Learning's .shape classes draw it. */
export const FAMILY_SHAPE: Record<Family, string> = { time: "s-circle", class: "s-square", board: "s-tri", calm: "s-arch", other: "s-ring" };

/** Desk shows at most this many tools in one frame (js/embed.js). */
export const MAX_TOOLS = 12;

/** Tools that show a class's names or notes about pupils: staff only, ever. */
export const ROSTER_KINDS: ReadonlySet<WidgetKind> = new Set(["picker", "groups", "seating", "behaviour", "jobs"]);
/**
 * What a student may ever be given (the school chooses within this): only
 * the tools Teacher's Desk itself already gives students (`students: true`
 * in apps/desk/public/js/widgets/). A tool Desk keeps from students stays
 * out of here until Desmond says otherwise; Desk would refuse it anyway.
 * The school's own defaults for students are unchanged (clock, timer).
 */
export const STUDENT_SAFE: readonly WidgetKind[] = ([
  "clock", "timer", "stopwatch", "alarms", "countdown",
  "scoreboard", "flashcards", "wordcount",
  "message", "notes", "links", "qr", "picture", "slides", "video", "bible", "econgraphs",
  "noise", "breathing", "music", "soundboard",
  "calculator", "calendar", "random", "emoji", "weather", "whiteboard", "atlas", "convert", "colours", "helpdesk",
] as WidgetKind[]).filter((k) => !ROSTER_KINDS.has(k));

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
  for (const v of input.slice(0, 80)) if (isKind(v) && !out.includes(v)) out.push(v);
  return out;
}

const studentOnly = (kinds: WidgetKind[], allowed: WidgetKind[]) => kinds.filter((k) => STUDENT_SAFE.includes(k) && allowed.includes(k));

/** The only way a school's choice is read or saved: unknown kinds dropped, students' lists kept inside what students may have. */
export function normalizeSchoolWidgets(input: unknown): SchoolWidgets {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const has = (k: string) => Array.isArray(o[k]);
  const pick = (k: keyof SchoolWidgets) => (has(k) ? cleanKinds(o[k]) : (DEFAULT_SCHOOL_WIDGETS[k] as WidgetKind[]).slice());
  const studentAllowed = pick("studentAllowed").filter((k) => STUDENT_SAFE.includes(k));
  const list = (k: keyof SchoolWidgets) => pick(k).slice(0, MAX_TOOLS);
  return {
    staffHome: list("staffHome"),
    staffClass: list("staffClass"),
    studentHome: studentOnly(list("studentHome"), studentAllowed),
    studentClass: studentOnly(list("studentClass"), studentAllowed),
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
  return cleanKinds(kinds).filter((k) => ok.includes(k) && (audience === "staff" || !ROSTER_KINDS.has(k))).slice(0, MAX_TOOLS);
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
