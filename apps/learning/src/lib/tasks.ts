import { getDb } from "./db";
import type { CourseWork } from "./family";

/**
 * The home page's "To do" panel. Teachers: handed-in work waiting for a
 * grade, published work due soon, drafts due soon but not published, and
 * today's planned lessons, across the classes they teach (Signify ID says
 * which, live). Students and parents: overdue and upcoming work, from the
 * same `studentWork` the This week page uses (published work only).
 */

type Ctx = { tenantId: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const DAY = 86_400_000;

export type TeacherTask =
  | { kind: "grade"; id: string; title: string; courseId: string; courseName: string; count: number; dueAt: string | null }
  | { kind: "due"; id: string; title: string; courseId: string; courseName: string; dueAt: string; handedIn: number }
  | { kind: "draft"; id: string; title: string; courseId: string; courseName: string; dueAt: string }
  | { kind: "lesson"; id: string; title: string; courseId: string; courseName: string };

export type TeacherTasks = { grade: TeacherTask[]; due: TeacherTask[]; drafts: TeacherTask[]; lessons: TeacherTask[] };

/** `today` is the school's day (YYYY-MM-DD), for today's lessons. */
export async function teacherTasks(ctx: Ctx, courseIds: string[], today: string, now = new Date(), days = 7): Promise<TeacherTasks> {
  const ids = courseIds.filter((c) => UUID.test(c));
  const empty: TeacherTasks = { grade: [], due: [], drafts: [], lessons: [] };
  if (!ids.length) return empty;
  const db = await getDb();
  const until = new Date(now.getTime() + days * DAY);
  const [grade, due, drafts, lessons] = await Promise.all([
    // Handed in (online work, quizzes) with no score, no levels and not exempt.
    db.query(
      `SELECT a.id, a.title, a.course_id, c.name AS course_name, a.due_at, count(*)::int AS n
         FROM assignments a JOIN courses c ON c.id = a.course_id
         JOIN submissions s ON s.assignment_id = a.id AND s.submitted_at IS NOT NULL
         LEFT JOIN grades g ON g.assignment_id = a.id AND g.student_id = s.student_id
        WHERE a.tenant_id = $1 AND a.course_id = ANY($2::uuid[]) AND a.archived = false AND a.published = true
          AND (g.assignment_id IS NULL OR (g.score IS NULL AND g.flag IS DISTINCT FROM 'exempt'
               AND (g.levels IS NULL OR g.levels = '{}'::jsonb)))
        GROUP BY a.id, a.title, a.course_id, c.name, a.due_at
        ORDER BY a.due_at NULLS LAST, a.title LIMIT 30`,
      [ctx.tenantId, ids],
    ),
    db.query(
      `SELECT a.id, a.title, a.course_id, c.name AS course_name, a.due_at,
              (SELECT count(*)::int FROM submissions s WHERE s.assignment_id = a.id AND s.submitted_at IS NOT NULL) AS handed
         FROM assignments a JOIN courses c ON c.id = a.course_id
        WHERE a.tenant_id = $1 AND a.course_id = ANY($2::uuid[]) AND a.archived = false AND a.published = true
          AND a.due_at >= $3 AND a.due_at < $4
        ORDER BY a.due_at LIMIT 30`,
      [ctx.tenantId, ids, now.toISOString(), until.toISOString()],
    ),
    db.query(
      `SELECT a.id, a.title, a.course_id, c.name AS course_name, a.due_at
         FROM assignments a JOIN courses c ON c.id = a.course_id
        WHERE a.tenant_id = $1 AND a.course_id = ANY($2::uuid[]) AND a.archived = false AND a.published = false
          AND a.due_at IS NOT NULL AND a.due_at < $3 AND a.due_at >= $4
        ORDER BY a.due_at LIMIT 30`,
      [ctx.tenantId, ids, until.toISOString(), new Date(now.getTime() - 30 * DAY).toISOString()],
    ),
    db.query(
      `SELECT l.id, l.title, l.course_id, c.name AS course_name
         FROM lessons l JOIN courses c ON c.id = l.course_id
        WHERE l.tenant_id = $1 AND l.course_id = ANY($2::uuid[]) AND l.archived = false AND l.planned_for = $3::date
        ORDER BY c.name, l.created_at LIMIT 30`,
      [ctx.tenantId, ids, today],
    ),
  ]);
  const base = (r: Record<string, unknown>) => ({ id: String(r.id), title: String(r.title), courseId: String(r.course_id), courseName: String(r.course_name) });
  return {
    grade: grade.map((r) => ({ kind: "grade" as const, ...base(r), count: Number(r.n), dueAt: iso(r.due_at) })),
    due: due.map((r) => ({ kind: "due" as const, ...base(r), dueAt: iso(r.due_at)!, handedIn: Number(r.handed ?? 0) })),
    drafts: drafts.map((r) => ({ kind: "draft" as const, ...base(r), dueAt: iso(r.due_at)! })),
    lessons: lessons.map((r) => ({ kind: "lesson" as const, ...base(r) })),
  };
}

export type StudentTask = { id: string; title: string; courseId: string; courseName: string; dueAt: string | null; status: string; who?: { id: string; name: string } };
export type StudentTasks = { overdue: StudentTask[]; upcoming: StudentTask[] };

/** Overdue (or marked missing) and due in the next `days` days, not yet handed in. Pure. */
export function studentTasks(work: CourseWork[], now = new Date(), days = 14, who?: { id: string; name: string }): StudentTasks {
  const until = now.getTime() + days * DAY;
  const items = work.flatMap((w) => w.items);
  const task = (i: CourseWork["items"][number]): StudentTask => ({
    id: i.id, title: i.title, courseId: i.courseId, courseName: i.courseName, dueAt: i.dueAt, status: i.status, ...(who ? { who } : {}),
  });
  const byDue = (a: StudentTask, b: StudentTask) => (a.dueAt ?? "9").localeCompare(b.dueAt ?? "9");
  return {
    overdue: items.filter((i) => i.status === "overdue" || i.status === "missing").map(task).sort(byDue),
    upcoming: items
      .filter((i) => (i.status === "notStarted" || i.status === "working" || i.status === "inClass") && i.dueAt
        && new Date(i.dueAt).getTime() >= now.getTime() && new Date(i.dueAt).getTime() < until)
      .map(task).sort(byDue),
  };
}
