/**
 * What a student, or their parent, sees of the student's work: published
 * assignments with due dates and status, and grades only once the teacher
 * has released them. The parent view and the "This week" page both read it,
 * so they can't disagree with each other or with the student's own course
 * page.
 *
 * Who a parent's children are is never stored here: it comes from Signify ID
 * on every request (roster.childrenFor), which counts only links the school
 * has verified.
 */

import { myCourses, type MyCourse } from "./courses";
import { listAssignments, courseSubmissions, isLate, isOverdue, type Assignment, type Submission } from "./assignments";
import { courseGrades, type Grade } from "./grades";
import { buildGradebook } from "./gradebook";
import { listAnnouncements } from "./announcements";
import { addDays } from "./planner";
import { weekday, type Day } from "./calendar";
import type { IdClass } from "./roster";

type Ctx = { tenantId: string; userId: string };

export type WorkStatus = "graded" | "exempt" | "missing" | "handedIn" | "overdue" | "working" | "notStarted" | "inClass";

export type WorkItem = {
  id: string;
  title: string;
  courseId: string;
  courseName: string;
  kind: Assignment["kind"];
  points: number;
  dueOn: string | null;
  dueAt: string | null;
  status: WorkStatus;
  late: boolean;
  /** Released grades only; null otherwise. */
  score: number | null;
  gradedAt: string | null;
};

export type CourseWork = {
  course: MyCourse;
  whole: number | null;
  letter: string | null;
  items: WorkItem[];
};

/**
 * One assignment's status for one student. `grade` must be undefined unless
 * the teacher has released grades for it: that is the caller's rule, and the
 * only way a score reaches a student or parent.
 */
export function workStatus(
  a: Pick<Assignment, "kind" | "dueAt">, sub: Pick<Submission, "submittedAt"> | null,
  grade: Pick<Grade, "score" | "flag"> | undefined, now = new Date(),
): WorkStatus {
  if (grade?.flag === "exempt") return "exempt";
  if (grade && grade.score !== null) return "graded";
  if (grade?.flag === "missing") return "missing";
  if (a.kind === "offline") return "inClass";
  if (sub?.submittedAt) return "handedIn";
  if (isOverdue(a, sub, now)) return "overdue";
  return sub ? "working" : "notStarted";
}

/** The courses behind a student's Signify ID classes that a teacher has opened. */
export async function studentCourses(tenantId: string, classes: IdClass[]): Promise<MyCourse[]> {
  const asStudent = classes.map((c) => ({ ...c, role: "student" }));
  return (await myCourses(tenantId, asStudent)).filter((c) => c.role === "student");
}

/** One course's published work for one student, with released grades only. */
export async function courseWork(ctx: Ctx, course: MyCourse, studentId: string, now = new Date()): Promise<CourseWork> {
  const [assignments, subs, grades] = await Promise.all([
    listAssignments(ctx, course.id, { publishedOnly: true }),
    courseSubmissions(ctx, course.id, studentId),
    courseGrades(ctx, course.id),
  ]);
  const self = { id: studentId, name: "", sortKey: "", factsName: "" };
  const gb = await buildGradebook(ctx, course.id, [self], null, { releasedOnly: true });
  const subBy = new Map(subs.map((s) => [s.assignmentId, s]));
  const gradeBy = new Map(grades.filter((g) => g.studentId === studentId).map((g) => [g.assignmentId, g]));

  const items = assignments.map((a): WorkItem => {
    const s = subBy.get(a.id) || null;
    const g = a.gradesReleased ? gradeBy.get(a.id) : undefined;
    return {
      id: a.id, title: a.title, courseId: course.id, courseName: course.name,
      kind: a.kind, points: a.points, dueOn: a.dueOn, dueAt: a.dueAt,
      status: workStatus(a, s, g, now),
      late: isLate(a, s) || g?.flag === "late",
      score: g ? g.score : null,
      gradedAt: g ? g.gradedAt : null,
    };
  });
  const row = gb.rows[0];
  return { course, whole: row?.whole ?? null, letter: row?.whole == null ? null : row.letter, items };
}

/** Every course's work for one student. */
export async function studentWork(ctx: Ctx, classes: IdClass[], studentId: string, now = new Date()): Promise<CourseWork[]> {
  const courses = await studentCourses(ctx.tenantId, classes);
  return Promise.all(courses.map((c) => courseWork(ctx, c, studentId, now)));
}

export type WeekNews = { courseId: string; courseName: string; title: string; createdAt: string };

export type WeekSummary = {
  /** Monday and Sunday of this week. */
  from: Day;
  to: Day;
  dueThisWeek: WorkItem[];
  needsAttention: WorkItem[];
  newGrades: WorkItem[];
  nextWeek: WorkItem[];
  news: WeekNews[];
};

const byDue = (a: WorkItem, b: WorkItem) =>
  (a.dueAt || a.dueOn || "9999").localeCompare(b.dueAt || b.dueOn || "9999");

/**
 * The week at a glance, from the work above. `today` is the school's day; the
 * week runs Monday to Sunday, so the weekend still shows the week's grades.
 * "Next week" is the seven days after it.
 */
export function weekSummary(work: CourseWork[], today: Day, now = new Date(), news: WeekNews[] = []): WeekSummary {
  const from = addDays(today, -((weekday(today) + 6) % 7));
  const to = addDays(from, 6);
  const items = work.flatMap((w) => w.items);
  const weekAgo = now.getTime() - 7 * 86_400_000;
  const inRange = (d: string | null, a: Day, b: Day) => !!d && d >= a && d <= b;
  return {
    from, to,
    dueThisWeek: items.filter((i) => inRange(i.dueOn, from, to)).sort(byDue),
    needsAttention: items.filter((i) => i.status === "overdue" || i.status === "missing").sort(byDue),
    newGrades: items.filter((i) => i.gradedAt && new Date(i.gradedAt).getTime() >= weekAgo && i.status !== "exempt")
      .sort((a, b) => String(b.gradedAt).localeCompare(String(a.gradedAt))),
    nextWeek: items.filter((i) => inRange(i.dueOn, addDays(to, 1), addDays(to, 7))).sort(byDue),
    news: news.filter((n) => new Date(n.createdAt).getTime() >= weekAgo)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  };
}

/** Announcements from the last week in these courses. */
export async function recentNews(ctx: Ctx, courses: MyCourse[]): Promise<WeekNews[]> {
  const lists = await Promise.all(courses.map(async (c) =>
    (await listAnnouncements(ctx, c.id, 5)).map((a) => ({
      courseId: c.id, courseName: c.name, title: a.title || a.body.slice(0, 120), createdAt: a.createdAt,
    }))));
  return lists.flat();
}
