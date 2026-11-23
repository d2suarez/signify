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
  /** The lasting course this class is a section of (catalog_courses; migration 017). */
  catalogId: string;
  /** The school year Signify ID gives the class ('' = not said). */
  schoolYear: string;
  /** 'class' (academic) or 'club' (a group with no academics; migration 020). */
  kind: CourseKind;
  /** The class picture (migration 043): one of the class's own picture files, or null. */
  pictureFileId: string | null;
};

export type CourseKind = "class" | "club";

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
    catalogId: r.catalog_id ? String(r.catalog_id) : "",
    schoolYear: String(r.school_year ?? ""),
    kind: r.kind === "club" ? "club" : "class",
    pictureFileId: r.picture_file_id ? String(r.picture_file_id) : null,
  };
}

/**
 * The courses this person can open, made from their Signify ID classes.
 * Teachers' classes become courses on sight (and get the latest name and
 * grade levels); a student only sees a course its teacher has already
 * opened.
 */
export async function myCourses(tenantId: string, classes: IdClass[], userId = ""): Promise<MyCourse[]> {
  const db = await getDb();
  const out: MyCourse[] = [];
  for (const c of classes) {
    const role = roleInClass(c);
    if (!role) continue;
    let rows;
    if (role === "teacher") {
      rows = await db.query(
        `INSERT INTO courses (tenant_id, id_class_id, name, subject, grade_levels, school_year)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (tenant_id, id_class_id)
         DO UPDATE SET name = EXCLUDED.name, subject = EXCLUDED.subject, grade_levels = EXCLUDED.grade_levels,
                       school_year = EXCLUDED.school_year
         RETURNING *`,
        [tenantId, c.id, c.name, c.subject || "", Array.isArray(c.grade_levels) ? JSON.stringify(c.grade_levels.map(String).slice(0, 20)) : null,
          String(c.school_year ?? "").slice(0, 20)],
      );
      if (rows[0] && !rows[0].catalog_id) rows = [await giveCatalog(tenantId, rows[0], userId)];
      if (rows[0] && userId) {
        await db.query(
          `INSERT INTO section_teachers (tenant_id, course_id, user_id) VALUES ($1, $2, $3)
           ON CONFLICT (course_id, user_id) DO UPDATE SET last_seen = now()`,
          [tenantId, rows[0].id, userId],
        );
      }
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
 * A new section gets a lasting course of its own, named like the class. The
 * teacher can later put it in another course (sections.ts); nothing is
 * copied either way.
 */
async function giveCatalog(tenantId: string, row: Record<string, unknown>, userId: string): Promise<Record<string, unknown>> {
  const db = await getDb();
  return db.tx(async (q) => {
    const [cat] = await q.query(
      "INSERT INTO catalog_courses (tenant_id, name, subject, created_by) VALUES ($1, $2, $3, $4) RETURNING id",
      [tenantId, String(row.name), String(row.subject ?? ""), userId || "learning"],
    );
    const [r] = await q.query(
      "UPDATE courses SET catalog_id = COALESCE(catalog_id, $3) WHERE tenant_id = $1 AND id = $2 RETURNING *",
      [tenantId, row.id, cat.id],
    );
    if (r.catalog_id !== cat.id) await q.query("DELETE FROM catalog_courses WHERE id = $1", [cat.id]);
    return r;
  });
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

/**
 * Sets or clears a class's picture (migration 043). Only a picture file
 * (by its bytes, files.ts) uploaded to this same class in this school is
 * kept; anything else answers false and changes nothing. The caller checks
 * the person teaches the class.
 */
export async function setCoursePicture(tenantId: string, courseId: string, fileId: string | null): Promise<boolean> {
  const db = await getDb();
  if (fileId !== null) {
    if (!/^[0-9a-f-]{36}$/i.test(fileId)) return false;
    const f = await db.query("SELECT 1 FROM course_files WHERE tenant_id = $1 AND id = $2 AND course_id = $3 AND kind = 'image'", [tenantId, fileId, courseId]);
    if (!f.length) return false;
  }
  const rows = await db.query("UPDATE courses SET picture_file_id = $3 WHERE tenant_id = $1 AND id = $2 RETURNING id", [tenantId, courseId, fileId]);
  return rows.length > 0;
}
