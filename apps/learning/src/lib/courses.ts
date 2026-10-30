import { getDb } from "./db";
import type { IdClass } from "./roster";

/**
 * Courses: one per Signify ID class. A course is created the first time its
 * teacher opens Signify Learning, and is never the authority on who is in it —
 * Signify ID is, asked live (see roster.ts).
 */

export type Course = {
  id: string;
  tenantId: string;
  idClassId: string;
  name: string;
  subject: string;
};

/** How this person relates to a course, from their live Signify ID classes. */
export type CourseRole = "teacher" | "student";

export type MyCourse = Course & { role: CourseRole; covering: boolean; lessonCount: number };

const STAFF_ROLES = new Set(["teacher", "aide", "admin"]);

export function roleInClass(c: Pick<IdClass, "role">): CourseRole | null {
  if (!c.role) return null;
  if (STAFF_ROLES.has(c.role)) return "teacher";
  if (c.role === "student") return "student";
  return null; // a parent's view of a child's class is not this person's course
}

function toCourse(r: Record<string, unknown>): Course {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    idClassId: String(r.id_class_id),
    name: String(r.name),
    subject: String(r.subject ?? ""),
  };
}

/**
 * The courses this person can open, made from their Signify ID classes.
 * Teachers' classes become courses on sight (and get the latest name and
 * grade levels); a student only sees a course its teacher has already
 * opened.
 */
export async function myCourses(tenantId: string, classes: IdClass[]): Promise<MyCourse[]> {
  const db = await getDb();
  const out: MyCourse[] = [];
  for (const c of classes) {
    const role = roleInClass(c);
    if (!role) continue;
    let rows;
    if (role === "teacher") {
      rows = await db.query(
        `INSERT INTO courses (tenant_id, id_class_id, name, subject, grade_levels)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (tenant_id, id_class_id)
         DO UPDATE SET name = EXCLUDED.name, subject = EXCLUDED.subject, grade_levels = EXCLUDED.grade_levels
         RETURNING *`,
        [tenantId, c.id, c.name, c.subject || "", Array.isArray(c.grade_levels) ? JSON.stringify(c.grade_levels.map(String).slice(0, 20)) : null],
      );
    } else {
      rows = await db.query("SELECT * FROM courses WHERE tenant_id = $1 AND id_class_id = $2", [tenantId, c.id]);
    }
    if (!rows[0]) continue;
    const course = toCourse(rows[0]);
    const [{ n }] = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM lessons WHERE tenant_id = $1 AND course_id = $2 AND archived = false",
      [tenantId, course.id],
    );
    out.push({ ...course, role, covering: !!c.covering, lessonCount: n });
  }
  out.sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === "teacher" ? -1 : 1));
  return out;
}

/**
 * One course and this person's role in it, or null when they have none.
 * The role is re-derived from their live classes every time, so a teacher
 * taken off a class in Signify ID loses it here at once.
 */
export async function courseFor(
  tenantId: string, courseId: string, classes: IdClass[],
): Promise<(Course & { role: CourseRole }) | null> {
  if (!/^[0-9a-f-]{36}$/i.test(courseId)) return null;
  const db = await getDb();
  const rows = await db.query("SELECT * FROM courses WHERE tenant_id = $1 AND id = $2", [tenantId, courseId]);
  if (!rows[0]) return null;
  const course = toCourse(rows[0]);
  const cls = classes.find((c) => c.id === course.idClassId);
  const role = cls ? roleInClass(cls) : null;
  return role ? { ...course, role } : null;
}
