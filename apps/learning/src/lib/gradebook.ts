import type { IdMember } from "./roster";
import { type Assignment, type Submission, courseSubmissions, isLate, listAssignments, listSubmissions } from "./assignments";
import {
  type Category, type CourseGrade, type Grade, type Period,
  computeGrade, courseGrades, gradeFor, inPeriod, isWeighted, listCategories, wholePercent,
} from "./grades";
import { courseSetup, SCHOOL_TZ, type CourseSetup } from "./school-grading";
import { finalScore, lateDays, penaltyFor, type Applied, type LateOverride, type Penalty } from "./late-policy";
import type { ScaleRow } from "./grade-scale";
import { courseGrading, listStandards, type Standard } from "./standards";
import {
  alignedStandards, averageLevel, convert, summarize, type Evidence, type StandardsSettings,
} from "./standards-math";

/**
 * Everything the gradebook shows for one course and one grading period,
 * worked out in one place so the grid, the FACTS list, the file download
 * and a student's own view can never disagree.
 */

type Ctx = { tenantId: string; userId: string };

/** `official`: the FACTS name came from the school's official name in Signify ID, not a guess. */
export type Student = { id: string; name: string; sortKey: string; factsName: string; official?: boolean };

const SUFFIXES = new Set(["jr", "jr.", "sr", "sr.", "ii", "iii", "iv"]);

/**
 * The fallback for someone with no official name in Signify ID: the last
 * word of the display name (before a suffix like "Jr.") is taken as the last
 * name. Two-word last names may sort a little differently than in FACTS, so
 * the list marks every name worked out this way.
 */
export function splitName(display: string): { first: string; last: string } {
  const words = display.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length <= 1) return { first: "", last: words[0] || "" };
  let lastIdx = words.length - 1;
  if (SUFFIXES.has(words[lastIdx].toLowerCase()) && lastIdx > 1) lastIdx--;
  return {
    first: words.slice(0, lastIdx).join(" "),
    last: words.slice(lastIdx).join(" "),
  };
}

export function toStudents(members: IdMember[]): Student[] {
  return members
    .filter((m) => m.role === "student")
    .map((m) => {
      // FACTS lists a class by last name, then first: the school's official
      // name where Signify ID has one, else a guess from the display name.
      const o = m.official_name;
      const official = !!(o && o.family);
      const { first, last } = official
        ? { first: o!.given || "", last: [o!.family, o!.suffix].filter(Boolean).join(" ") }
        : splitName(m.display_name || "");
      const middle = official ? o!.middle || "" : "";
      return {
        id: m.id,
        name: m.display_name || "",
        sortKey: `${official ? o!.family : last}\u0000${first}\u0000${middle}`.toLocaleLowerCase("en"),
        factsName: first ? `${last}, ${first}` : last,
        official,
      };
    })
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey, "en", { sensitivity: "base" }));
}

export type Cell = {
  /** The raw score, as given. */
  score: number | null; flag: Grade["flag"]; comment: string; late: boolean; handedIn: boolean;
  /** Days late by the hand-in time (null = not late by the clock; paper work never is). */
  autoDays: number | null;
  lateOverride: LateOverride | null;
  /** The late policy's penalty (points courses only); the score that counts is finalScore(score, penalty). */
  penalty: Penalty | null;
  /** Standards courses only: a level was given on at least one standard. */
  leveled?: boolean;
};

export type Row = {
  student: Student;
  cells: Record<string, Cell>;
  /** In a standards course: percent = the converted percent; counted = standards with evidence. */
  grade: CourseGrade;
  whole: number | null;
  letter: string;
  /** GPA points for the letter, from the school's scale. */
  gpa: number | null;
  /** Standards courses only: each standard's period summary, and their average. */
  standards?: { summaries: Record<string, StandardSummary>; average: number | null };
};

export type StandardSummary = { level: number | null; scores: number };

/** What a standards course adds to the gradebook. */
export type StandardsBook = {
  settings: StandardsSettings;
  standards: Standard[];
  /** Assignment id → the standards it measures (current ones only). */
  aligned: Record<string, string[]>;
  checks: {
    /** Assignments in the period that measure no standard: their scores don't count. */
    unaligned: number;
    /** Students with no level on any standard yet (no course grade). */
    noEvidence: number;
    /** Student × aligned assignment with no level yet (not missing or exempt). */
    noLevels: number;
  };
};

export type Gradebook = {
  /** null for a points course, which is worked out exactly as it always was. */
  standards: StandardsBook | null;
  /** The school's scale for this course's grade band. */
  scale: ScaleRow[];
  band: { id: string; name: string; from: CourseSetup["bandFrom"] };
  /** Assignment id → the late policy that applies (points courses; null = late is a mark only). */
  lateRules: Record<string, Applied | null>;
  weighted: boolean;
  categories: Category[];
  period: Period | null;
  assignments: Assignment[];
  rows: Row[];
  classAverage: number | null;
  checks: {
    missing: { student: string; assignment: string }[];
    ungraded: number;
    below70: number;
    noDueDate: number;
    uncategorized: number;
  };
};

function cellsFor(
  studentId: string, assignments: Assignment[], grades: Map<string, Grade>, subs: Map<string, Submission>,
  rules: Record<string, Applied | null> = {},
): Record<string, Cell> {
  const out: Record<string, Cell> = {};
  for (const a of assignments) {
    const g = grades.get(`${a.id}:${studentId}`);
    const s = subs.get(`${a.id}:${studentId}`) || null;
    // Paper work has no hand-in time: only the teacher's Late mark makes it late.
    const autoDays = a.kind !== "offline" && isLate(a, s) ? lateDays(a.dueAt!, s!.submittedAt!, SCHOOL_TZ) : null;
    const score = g?.score ?? null, flag = g?.flag ?? null, lateOverride = g?.lateOverride ?? null;
    out[a.id] = {
      score, flag,
      comment: g?.comment ?? "",
      late: g?.flag === "late" || isLate(a, s),
      handedIn: !!s?.submittedAt,
      autoDays, lateOverride,
      penalty: penaltyFor(rules[a.id] ?? null, a.points, { score, flag, autoDays, override: lateOverride }),
    };
  }
  return out;
}

/**
 * One assignment's late penalties, by student id, for screens that show one
 * assignment (grading desk, the student's page) and for grade passback, so
 * they agree with the gradebook. Empty in a standards course or when no
 * policy applies.
 */
export async function assignmentPenalties(ctx: Ctx, a: Assignment, grades: Grade[]): Promise<{ rule: Applied | null; byStudent: Map<string, { autoDays: number | null; penalty: Penalty | null }> }> {
  const byStudent = new Map<string, { autoDays: number | null; penalty: Penalty | null }>();
  const [grading, setup, categories] = await Promise.all([courseGrading(ctx, a.courseId), courseSetup(ctx, a.courseId), listCategories(ctx, a.courseId)]);
  if (grading.mode === "standards") return { rule: null, byStudent };
  const rule = lateRulesFor(setup, [a], categories)[a.id];
  if (!rule) return { rule, byStudent };
  const subs = new Map((await listSubmissions(ctx, a.id)).map((s) => [s.studentId, s]));
  const ids = new Set([...grades.map((g) => g.studentId), ...subs.keys()]);
  const gradeBy = new Map(grades.map((g) => [g.studentId, g]));
  for (const id of ids) {
    const c = cellsFor(id, [a], new Map(gradeBy.has(id) ? [[`${a.id}:${id}`, gradeBy.get(id)!]] : []), new Map(subs.has(id) ? [[`${a.id}:${id}`, subs.get(id)!]] : []), { [a.id]: rule })[a.id];
    byStudent.set(id, { autoDays: c.autoDays, penalty: c.penalty });
  }
  return { rule, byStudent };
}

/** Each assignment's late policy in this course. */
export function lateRulesFor(setup: CourseSetup, assignments: Assignment[], categories: Category[]): Record<string, Applied | null> {
  const catName = new Map(categories.map((c) => [c.id, c.name]));
  return Object.fromEntries(assignments.map((a) => [a.id, setup.ruleFor({ category: a.categoryId ? catName.get(a.categoryId) ?? null : null, kind: a.kind })]));
}

/**
 * The gradebook for a period (null = the whole year). With releasedOnly, only
 * assignments whose grades the teacher has released count: that is the
 * student's own view.
 */
export async function buildGradebook(
  ctx: Ctx, courseId: string, students: Student[], period: Period | null,
  opts: { releasedOnly?: boolean } = {},
): Promise<Gradebook> {
  const [all, gradeList, subList, categories, weighted, grading, setup] = await Promise.all([
    listAssignments(ctx, courseId),
    courseGrades(ctx, courseId),
    courseSubmissions(ctx, courseId, students.length === 1 ? students[0].id : undefined),
    listCategories(ctx, courseId),
    isWeighted(ctx, courseId),
    courseGrading(ctx, courseId),
    courseSetup(ctx, courseId),
  ]);
  const scale = setup.band.rows;
  const band = { id: setup.band.id, name: setup.band.name, from: setup.bandFrom };
  const assignments = all.filter((a) => inPeriod(a, period) && (!opts.releasedOnly || (a.published && a.gradesReleased)));
  const grades = new Map(gradeList.map((g) => [`${g.assignmentId}:${g.studentId}`, g]));
  const subs = new Map(subList.map((s) => [`${s.assignmentId}:${s.studentId}`, s]));

  if (grading.mode === "standards") {
    const standards = await listStandards(ctx, courseId);
    return { ...standardsGradebook(assignments, grades, subs, students, period, categories, weighted, grading.settings, standards, scale), band };
  }

  const lateRules = lateRulesFor(setup, assignments, categories);
  const rows: Row[] = students.map((student) => {
    const cells = cellsFor(student.id, assignments, grades, subs, lateRules);
    // The score that counts is after any late penalty; with no policy it is the score as given.
    const mine = new Map<string, Grade>();
    for (const a of assignments) {
      const g = grades.get(`${a.id}:${student.id}`);
      const p = cells[a.id].penalty;
      if (g) mine.set(a.id, p && g.score !== null ? { ...g, score: finalScore(g.score, p) } : g);
    }
    const grade = computeGrade(assignments, mine, { weighted, categories });
    const { letter, gpa } = gradeFor(grade.percent, scale);
    return {
      student,
      cells,
      grade,
      whole: grade.percent === null ? null : wholePercent(grade.percent),
      letter,
      gpa,
    };
  });

  const graded = rows.filter((r) => r.grade.percent !== null);
  const classAverage = graded.length ? graded.reduce((n, r) => n + (r.grade.percent as number), 0) / graded.length : null;

  const missing: { student: string; assignment: string }[] = [];
  let ungraded = 0;
  for (const r of rows) {
    for (const a of assignments) {
      const c = r.cells[a.id];
      if (c.flag === "missing" && c.score === null) missing.push({ student: r.student.name, assignment: a.title });
      if (c.score === null && c.flag !== "exempt" && c.flag !== "missing") ungraded++;
    }
  }
  return {
    standards: null, scale, band, lateRules, weighted, categories, period, assignments, rows, classAverage,
    checks: {
      missing,
      ungraded,
      below70: rows.filter((r) => r.whole !== null && r.whole < 70).length,
      noDueDate: period ? assignments.filter((a) => !a.dueOn).length : 0,
      uncategorized: weighted ? assignments.filter((a) => !a.categoryId).length : 0,
    },
  };
}

/** When a score was "made", for "most recent": the due moment, else the due day, else when graded. */
function evidenceAt(a: Assignment, g: Grade): string {
  return a.dueAt ?? (a.dueOn ? `${a.dueOn}T23:59:59.999Z` : g.gradedAt);
}

/**
 * A standards course: each standard's summary per student over the period's
 * levels, their average, and that average converted to a percent (and so a
 * letter) for FACTS. Exempt work is left out; missing work is no evidence.
 */
function standardsGradebook(
  assignments: Assignment[], grades: Map<string, Grade>, subs: Map<string, Submission>, students: Student[],
  period: Period | null, categories: Category[], weighted: boolean, settings: StandardsSettings, standards: Standard[],
  scale: ScaleRow[],
): Omit<Gradebook, "band"> {
  const live = new Set(standards.map((s) => s.id));
  const aligned: Record<string, string[]> = {};
  for (const a of assignments) aligned[a.id] = alignedStandards(a).filter((id) => live.has(id));

  let noLevels = 0;
  const rows: Row[] = students.map((student) => {
    const evidence = new Map<string, Evidence[]>();
    for (const a of assignments) {
      const g = grades.get(`${a.id}:${student.id}`);
      if (!aligned[a.id].length) continue;
      if (g?.flag === "exempt") continue;
      const got = aligned[a.id].filter((id) => g?.levels?.[id] !== undefined);
      if (!got.length && g?.flag !== "missing") noLevels++;
      for (const id of got) {
        if (!evidence.has(id)) evidence.set(id, []);
        evidence.get(id)!.push({ level: g!.levels![id], at: evidenceAt(a, g!), gradedAt: g!.gradedAt });
      }
    }
    const summaries: Record<string, StandardSummary> = {};
    for (const s of standards) {
      const list = evidence.get(s.id) ?? [];
      summaries[s.id] = { level: summarize(list, settings.summary), scores: list.length };
    }
    const average = averageLevel(standards.map((s) => summaries[s.id].level));
    const percent = convert(average, settings);
    const counted = standards.filter((s) => summaries[s.id].level !== null).length;
    const cells = cellsFor(student.id, assignments, grades, subs);
    for (const a of assignments) {
      const lv = grades.get(`${a.id}:${student.id}`)?.levels;
      cells[a.id].leveled = !!lv && aligned[a.id].some((id) => lv[id] !== undefined);
    }
    const { letter, gpa } = gradeFor(percent, scale);
    return {
      student,
      cells,
      grade: { percent, byCategory: {}, counted, dropped: [] },
      whole: percent === null ? null : wholePercent(percent),
      letter,
      gpa,
      standards: { summaries, average },
    };
  });

  const graded = rows.filter((r) => r.grade.percent !== null);
  const classAverage = graded.length ? graded.reduce((n, r) => n + (r.grade.percent as number), 0) / graded.length : null;
  const missing: { student: string; assignment: string }[] = [];
  for (const r of rows) for (const a of assignments) {
    const c = r.cells[a.id];
    if (c.flag === "missing" && c.score === null) missing.push({ student: r.student.name, assignment: a.title });
  }
  return {
    standards: {
      settings, standards, aligned,
      checks: {
        unaligned: assignments.filter((a) => !aligned[a.id].length).length,
        noEvidence: rows.filter((r) => r.standards!.average === null).length,
        noLevels,
      },
    },
    scale, lateRules: {}, weighted, categories, period, assignments, rows, classAverage,
    checks: {
      missing,
      ungraded: noLevels,
      below70: rows.filter((r) => r.whole !== null && r.whole < 70).length,
      noDueDate: period ? assignments.filter((a) => !a.dueOn).length : 0,
      uncategorized: 0,
    },
  };
}

/** What a student or parent sees of a standards course: each standard and its level. Null for a points course. */
export type StandardsView = { settings: StandardsSettings; list: { id: string; code: string; description: string; level: number | null }[] };

export function standardsView(gb: Gradebook, row: Row | undefined): StandardsView | null {
  if (!gb.standards || !row?.standards) return null;
  return {
    settings: gb.standards.settings,
    list: gb.standards.standards.map((s) => ({ id: s.id, code: s.code, description: s.description, level: row.standards!.summaries[s.id]?.level ?? null })),
  };
}

/** The period a date falls in, or null. */
export function periodOn(periods: Period[], isoDay: string): Period | null {
  return periods.find((p) => isoDay >= p.startsOn && isoDay <= p.endsOn) ?? null;
}

// ---------- the FACTS file ----------

/** A spreadsheet must never run a name as a formula. */
function csvCell(v: string): string {
  let s = v;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** FACTS-order CSV: Student, Percent, Letter. ASCII letters (A-, not A−). */
export function factsCsv(gb: Gradebook): string {
  const lines = [["Student", "Percent", "Letter"].join(",")];
  for (const r of gb.rows) {
    lines.push([
      csvCell(r.student.factsName),
      r.whole === null ? "" : String(r.whole),
      r.letter.replace("−", "-"),
    ].join(","));
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}
