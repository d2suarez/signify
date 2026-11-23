import { getDb } from "./db";
import type { Status } from "./attendance";

/**
 * A student's own attendance (teacher story 01, D6, read side): what the
 * student sees in each class and what their parents see for each child.
 * Counts over the days attendance was taken, and the days they weren't
 * marked present. The teacher's notes are NOT included: they may be meant
 * for the school, not the family. Callers decide who may ask (the student
 * themself, or a parent Signify ID links to that child).
 */
export type AttendanceDay = { day: string; status: Exclude<Status, "present"> };
export type MyAttendance = {
  courseId: string;
  counts: Record<Status, number>;
  /** Days taken (any status). */
  days: number;
  /** Absent, tardy or excused days, newest first (at most 60). */
  notPresent: AttendanceDay[];
};

const dayOf = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const empty = (courseId: string): MyAttendance => ({ courseId, counts: { present: 0, absent: 0, tardy: 0, excused: 0 }, days: 0, notPresent: [] });

export async function studentAttendance(tenantId: string, courseIds: string[], studentId: string): Promise<Map<string, MyAttendance>> {
  const out = new Map(courseIds.map((c) => [c, empty(c)]));
  if (!courseIds.length || !studentId) return out;
  const db = await getDb();
  const rows = await db.query(
    `SELECT course_id, day, status FROM attendance
      WHERE tenant_id = $1 AND student_id = $2 AND course_id = ANY($3::uuid[]) ORDER BY day DESC`,
    [tenantId, studentId, courseIds]);
  for (const r of rows) {
    const a = out.get(String(r.course_id));
    const s = String(r.status) as Status;
    if (!a || !(s in a.counts)) continue;
    a.counts[s]++;
    a.days++;
    if (s !== "present" && a.notPresent.length < 60) a.notPresent.push({ day: dayOf(r.day), status: s });
  }
  return out;
}
