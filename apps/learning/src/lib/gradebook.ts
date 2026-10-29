import type { IdMember } from "./roster";
import { type Assignment, type Submission, courseSubmissions, isLate, listAssignments } from "./assignments";
import {
  type Category, type CourseGrade, type Grade, type Period,
  computeGrade, courseGrades, inPeriod, isWeighted, letterFor, listCategories, wholePercent,
} from "./grades";

/**
 * Everything the gradebook shows for one course and one grading period,
 * worked out in one place so the grid, the FACTS list, the file download
 * and a student's own view can never disagree.
 */

type Ctx = { tenantId: string; userId: string };

export type Student = { id: string; name: string; sortKey: string; factsName: string };

const SUFFIXES = new Set(["jr", "jr.", "sr", "sr.", "ii", "iii", "iv"]);

/**
 * FACTS lists a class by last name, then first. Signify ID holds one display
 * name, so the last word (before a suffix like "Jr.") is taken as the last
 * name. Two-word last names may sort a little differently than in FACTS;
 * the list says so.
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
      const { first, last } = splitName(m.display_name || "");
      return {
        id: m.id,
        name: m.display_name || "",
        sortKey: `${last}\u0000${first}`.toLocaleLowerCase("en"),
        factsName: first ? `${last}, ${first}` : last,
      };
    })
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey, "en", { sensitivity: "base" }));
}

export type Cell = { score: number | null; flag: Grade["flag"]; comment: string; late: boolean; handedIn: boolean };

export type Row = {
  student: Student;
  cells: Record<string, Cell>;
  grade: CourseGrade;
  whole: number | null;
  letter: string;
};

export type Gradebook = {
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

function cellsFor(studentId: string, assignments: Assignment[], grades: Map<string, Grade>, subs: Map<string, Submission>): Record<string, Cell> {
  const out: Record<string, Cell> = {};
  for (const a of assignments) {
    const g = grades.get(`${a.id}:${studentId}`);
    const s = subs.get(`${a.id}:${studentId}`) || null;
    out[a.id] = {
      score: g?.score ?? null,
      flag: g?.flag ?? null,
      comment: g?.comment ?? "",
      late: g?.flag === "late" || isLate(a, s),
      handedIn: !!s?.submittedAt,
    };
  }
  return out;
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
  const [all, gradeList, subList, categories, weighted] = await Promise.all([
    listAssignments(ctx, courseId),
    courseGrades(ctx, courseId),
    courseSubmissions(ctx, courseId, students.length === 1 ? students[0].id : undefined),
    listCategories(ctx, courseId),
    isWeighted(ctx, courseId),
  ]);
  const assignments = all.filter((a) => inPeriod(a, period) && (!opts.releasedOnly || (a.published && a.gradesReleased)));
  const grades = new Map(gradeList.map((g) => [`${g.assignmentId}:${g.studentId}`, g]));
  const subs = new Map(subList.map((s) => [`${s.assignmentId}:${s.studentId}`, s]));

  const rows: Row[] = students.map((student) => {
    const mine = new Map<string, Grade>();
    for (const a of assignments) {
      const g = grades.get(`${a.id}:${student.id}`);
      if (g) mine.set(a.id, g);
    }
    const grade = computeGrade(assignments, mine, { weighted, categories });
    return {
      student,
      cells: cellsFor(student.id, assignments, grades, subs),
      grade,
      whole: grade.percent === null ? null : wholePercent(grade.percent),
      letter: letterFor(grade.percent),
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
    weighted, categories, period, assignments, rows, classAverage,
    checks: {
      missing,
      ungraded,
      below70: rows.filter((r) => r.whole !== null && r.whole < 70).length,
      noDueDate: period ? assignments.filter((a) => !a.dueOn).length : 0,
      uncategorized: weighted ? assignments.filter((a) => !a.categoryId).length : 0,
    },
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
