import { getDb } from "./db";
import { isSchoolDay, parseDay } from "./planner";
import { schoolTeachers } from "./school-plans";
import type { Day } from "./calendar";
import type { Dict } from "./i18n";

/**
 * Attendance (teacher story 01, D6; migration 039): Learning's own record,
 * per class meeting (one class, one school day), which the school exports
 * for its SIS. A teacher marks each student Present, Absent, Tardy or
 * Excused; only students Signify ID says are in the class now can be marked
 * (the caller passes that roster, as for grades). School days only, never
 * in the future. School admins read every class's day (`schoolDay`) and
 * export a date range (`schoolExport`).
 */

export const STATUSES = ["present", "absent", "tardy", "excused"] as const;
export type Status = (typeof STATUSES)[number];
export type Mark = { studentId: string; status: Status; note: string };
export type SavedMark = Mark & { name: string; markedAt: string };

export const ATTENDANCE_LIMITS = { note: 300, students: 200 };

export class AttendanceError extends Error {
  constructor(public code: "day" | "future") { super(code); }
}

type Ctx = { tenantId: string; userId: string };

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
const dayOf = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/** A status in words (always shown as words, never colour alone). */
export function statusWord(s: Status, d: Pick<Dict, "attPresent" | "attAbsent" | "attTardy" | "attExcused">): string {
  return s === "present" ? d.attPresent : s === "absent" ? d.attAbsent : s === "tardy" ? d.attTardy : d.attExcused;
}

export function asStatus(v: unknown): Status | null {
  return STATUSES.find((s) => s === v) ?? null;
}

/** A day attendance can be taken for: a school day, not after `today`. */
export function checkAttendanceDay(day: unknown, today: Day): Day {
  const s = parseDay(day);
  if (!s || !isSchoolDay(s)) throw new AttendanceError("day");
  if (s > today) throw new AttendanceError("future");
  return s;
}

/** The class's marks for a day, by student id (empty when not taken). */
export async function classDay(ctx: Ctx, courseId: string, day: Day): Promise<Map<string, SavedMark>> {
  const db = await getDb();
  const rows = await db.query(
    "SELECT student_id, student_name, status, note, marked_at FROM attendance WHERE tenant_id = $1 AND course_id = $2 AND day = $3",
    [ctx.tenantId, courseId, day]);
  return new Map(rows.map((r) => [String(r.student_id), {
    studentId: String(r.student_id), name: String(r.student_name), status: r.status as Status, note: String(r.note), markedAt: iso(r.marked_at),
  }]));
}

/**
 * Saves a class meeting's attendance. Marks for anyone not on `roster`
 * (id -> name, from Signify ID now) are ignored; students not in `marks`
 * keep what they had. Returns how many marks were saved.
 */
export async function takeAttendance(ctx: Ctx, courseId: string, day: unknown, today: Day, marks: unknown[], roster: Map<string, string>): Promise<number> {
  const d = checkAttendanceDay(day, today);
  const clean: Mark[] = [];
  const seen = new Set<string>();
  for (const raw of marks.slice(0, ATTENDANCE_LIMITS.students)) {
    const m = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const id = String(m.studentId ?? "");
    const status = asStatus(m.status);
    if (!status || !roster.has(id) || seen.has(id)) continue;
    seen.add(id);
    clean.push({ studentId: id, status, note: String(m.note ?? "").replace(/\s+/g, " ").trim().slice(0, ATTENDANCE_LIMITS.note) });
  }
  if (!clean.length) return 0;
  const db = await getDb();
  await db.tx(async (t) => {
    for (const m of clean) {
      await t.query(
        `INSERT INTO attendance (tenant_id, course_id, day, student_id, student_name, status, note, marked_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (course_id, day, student_id) DO UPDATE
           SET student_name = EXCLUDED.student_name, status = EXCLUDED.status, note = EXCLUDED.note,
               marked_by = EXCLUDED.marked_by, marked_at = now()
         WHERE attendance.tenant_id = EXCLUDED.tenant_id`,
        [ctx.tenantId, courseId, d, m.studentId, String(roster.get(m.studentId) ?? "").slice(0, 200), m.status, m.note, ctx.userId]);
    }
  });
  return clean.length;
}

/**
 * Takes back one student's mark for a class meeting (the seating slide's
 * second tap: "not marked yet"). Same day rules as taking it.
 */
export async function clearMark(ctx: Ctx, courseId: string, day: unknown, today: Day, studentId: string): Promise<void> {
  const d = checkAttendanceDay(day, today);
  const db = await getDb();
  await db.query("DELETE FROM attendance WHERE tenant_id = $1 AND course_id = $2 AND day = $3 AND student_id = $4",
    [ctx.tenantId, courseId, d, String(studentId).slice(0, 80)]);
}

export type ClassAttendance = {
  courseId: string; name: string; teacher: string; taken: boolean;
  counts: Record<Status, number>;
  /** Everyone not marked present, by name. */
  notPresent: { name: string; status: Status; note: string }[];
};

/** The school's classes seen teaching lately (as the principal's weekly plans), with their teachers' names. */
export async function schoolClasses(tenantId: string, now = new Date()): Promise<Map<string, { name: string; teacher: string }>> {
  const teachers = await schoolTeachers(tenantId, now);
  const classes = new Map<string, { name: string; teacher: string }>();
  for (const t of teachers) for (const c of t.classes) {
    const had = classes.get(c.courseId);
    classes.set(c.courseId, { name: c.name, teacher: [had?.teacher, t.name].filter(Boolean).join(", ") });
  }
  return classes;
}

/** Every class's attendance for one day, for school admins. */
export async function schoolDay(tenantId: string, day: Day, now = new Date()): Promise<ClassAttendance[]> {
  const classes = await schoolClasses(tenantId, now);
  if (!classes.size) return [];
  const db = await getDb();
  const rows = await db.query(
    "SELECT course_id, student_name, status, note FROM attendance WHERE tenant_id = $1 AND day = $2 AND course_id = ANY($3::uuid[]) ORDER BY student_name",
    [tenantId, day, [...classes.keys()]]);
  return [...classes.entries()].map(([courseId, c]) => {
    const mine = rows.filter((r) => String(r.course_id) === courseId);
    const counts = { present: 0, absent: 0, tardy: 0, excused: 0 } as Record<Status, number>;
    for (const r of mine) counts[r.status as Status]++;
    return {
      courseId, name: c.name, teacher: c.teacher, taken: mine.length > 0, counts,
      notPresent: mine.filter((r) => r.status !== "present").map((r) => ({ name: String(r.student_name), status: r.status as Status, note: String(r.note) })),
    };
  }).sort((a, b) => Number(a.taken) - Number(b.taken) || a.name.localeCompare(b.name));
}

export type ExportRow = { day: Day; className: string; courseId: string; studentId: string; studentName: string; status: Status; note: string; markedAt: string };

/** The school's attendance from `from` to `to` (inclusive, at most a year), for its SIS; or one class's (its teachers' export). */
export async function schoolExport(tenantId: string, from: Day, to: Day, courseId?: string): Promise<ExportRow[]> {
  const db = await getDb();
  const rows = await db.query(
    `SELECT a.day, c.name AS class_name, a.course_id, a.student_id, a.student_name, a.status, a.note, a.marked_at
       FROM attendance a JOIN courses c ON c.id = a.course_id
      WHERE a.tenant_id = $1 AND a.day BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR a.course_id = $4::uuid)
      ORDER BY a.day, c.name, a.student_name LIMIT 200000`,
    [tenantId, from, to, courseId ?? null]);
  return rows.map((r) => ({
    day: dayOf(r.day), className: String(r.class_name), courseId: String(r.course_id), studentId: String(r.student_id),
    studentName: String(r.student_name), status: r.status as Status, note: String(r.note), markedAt: iso(r.marked_at),
  }));
}
