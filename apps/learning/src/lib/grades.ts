import { getDb } from "./db";
import type { Assignment } from "./assignments";

/**
 * Grades, grade categories, the school's grading periods, and how a course
 * grade is worked out.
 *
 * A grade is a score, a flag, or both:
 *   - no score, no flag: not graded yet; left out of the course grade.
 *   - missing: counts as zero until a score replaces it.
 *   - exempt: left out, whatever the score.
 *   - late: a mark only (no penalty yet); the score counts as normal.
 * Every change is appended to grade_history first.
 */

type Ctx = { tenantId: string; userId: string };
const UUID = /^[0-9a-f-]{36}$/i;

import { FLAGS, type Flag } from "./grade-math";
export const MAX_COMMENT = 5000;
/** A score may go above the points (extra credit), up to this many times them. */
export const MAX_SCORE_FACTOR = 10;

export type Grade = {
  assignmentId: string;
  studentId: string;
  score: number | null;
  flag: Flag | null;
  comment: string;
  gradedAt: string;
};

function toGrade(r: Record<string, unknown>): Grade {
  return {
    assignmentId: String(r.assignment_id),
    studentId: String(r.student_id),
    score: r.score == null ? null : Number(r.score),
    flag: FLAGS.includes(r.flag as Flag) ? (r.flag as Flag) : null,
    comment: String(r.comment ?? ""),
    gradedAt: r.graded_at instanceof Date ? r.graded_at.toISOString() : String(r.graded_at),
  };
}

export async function courseGrades(ctx: Ctx, courseId: string): Promise<Grade[]> {
  const db = await getDb();
  const rows = await db.query(
    `SELECT g.* FROM grades g JOIN assignments a ON a.id = g.assignment_id
      WHERE g.tenant_id = $1 AND a.tenant_id = $1 AND a.course_id = $2 AND a.archived = false`,
    [ctx.tenantId, courseId],
  );
  return rows.map(toGrade);
}

export async function gradesFor(ctx: Ctx, assignmentId: string): Promise<Grade[]> {
  if (!UUID.test(assignmentId)) return [];
  const db = await getDb();
  const rows = await db.query("SELECT * FROM grades WHERE tenant_id = $1 AND assignment_id = $2", [ctx.tenantId, assignmentId]);
  return rows.map(toGrade);
}

export type GradeInput = { score?: unknown; flag?: unknown; comment?: unknown };

export type GradeSave =
  | { ok: true; grade: Grade | null; changed: boolean }
  | { ok: false; reason: "not-a-student" | "bad-score" };

/** "" / null / undefined = no score; anything else must be a number in range. */
export function parseScore(v: unknown, points: number): number | null | "bad" {
  if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return null;
  const n = typeof v === "number" ? v : Number(String(v).trim().replace(",", "."));
  if (!Number.isFinite(n) || n < 0) return "bad";
  if (n > Math.max(points, 1) * MAX_SCORE_FACTOR) return "bad";
  return Math.round(n * 100) / 100;
}

/**
 * Sets one student's grade on one assignment. `students` is the class's
 * students as Signify ID says right now: a grade is never written for
 * anyone else. Clearing score, flag and comment removes the grade.
 */
export async function setGrade(
  ctx: Ctx, a: Assignment, studentId: string, students: Set<string>, input: GradeInput,
): Promise<GradeSave> {
  if (!students.has(studentId)) return { ok: false, reason: "not-a-student" };
  const score = parseScore(input.score, a.points);
  if (score === "bad") return { ok: false, reason: "bad-score" };
  const flag = FLAGS.includes(input.flag as Flag) ? (input.flag as Flag) : null;
  const comment = String(input.comment ?? "").slice(0, MAX_COMMENT).trim();
  const db = await getDb();
  return db.tx(async (t) => {
    const rows = await t.query(
      "SELECT * FROM grades WHERE tenant_id = $1 AND assignment_id = $2 AND student_id = $3 FOR UPDATE",
      [ctx.tenantId, a.id, studentId],
    );
    const cur = rows[0] ? toGrade(rows[0]) : null;
    const same = cur
      ? cur.score === score && cur.flag === flag && cur.comment === comment
      : score === null && flag === null && comment === "";
    if (same) return { ok: true, grade: cur, changed: false } as const;

    await t.query(
      `INSERT INTO grade_history (tenant_id, assignment_id, student_id, score, flag, comment, changed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [ctx.tenantId, a.id, studentId, score, flag, comment, ctx.userId],
    );
    if (score === null && flag === null && comment === "") {
      await t.query("DELETE FROM grades WHERE tenant_id = $1 AND assignment_id = $2 AND student_id = $3", [ctx.tenantId, a.id, studentId]);
      return { ok: true, grade: null, changed: true } as const;
    }
    const saved = await t.query(
      `INSERT INTO grades (tenant_id, assignment_id, student_id, score, flag, comment, graded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (assignment_id, student_id)
       DO UPDATE SET score = EXCLUDED.score, flag = EXCLUDED.flag, comment = EXCLUDED.comment,
                     graded_by = EXCLUDED.graded_by, graded_at = now()
       RETURNING *`,
      [ctx.tenantId, a.id, studentId, score, flag, comment, ctx.userId],
    );
    return { ok: true, grade: toGrade(saved[0]), changed: true } as const;
  });
}

export type HistoryEntry = { score: number | null; flag: Flag | null; comment: string; changedBy: string; changedAt: string };

export async function gradeHistory(ctx: Ctx, assignmentId: string, studentId: string): Promise<HistoryEntry[]> {
  if (!UUID.test(assignmentId)) return [];
  const db = await getDb();
  const rows = await db.query(
    `SELECT * FROM grade_history WHERE tenant_id = $1 AND assignment_id = $2 AND student_id = $3 ORDER BY id DESC`,
    [ctx.tenantId, assignmentId, studentId],
  );
  return rows.map((r) => ({
    score: r.score == null ? null : Number(r.score),
    flag: (r.flag as Flag) ?? null,
    comment: String(r.comment ?? ""),
    changedBy: String(r.changed_by),
    changedAt: r.changed_at instanceof Date ? r.changed_at.toISOString() : String(r.changed_at),
  }));
}

// ---------- categories ----------

export type Category = { id: string; name: string; weight: number };

export async function listCategories(ctx: Ctx, courseId: string): Promise<Category[]> {
  const db = await getDb();
  const rows = await db.query(
    "SELECT * FROM grade_categories WHERE tenant_id = $1 AND course_id = $2 ORDER BY position, name",
    [ctx.tenantId, courseId],
  );
  return rows.map((r) => ({ id: String(r.id), name: String(r.name), weight: Number(r.weight) }));
}

function cleanWeight(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1000, Math.max(0, Math.round(n * 100) / 100)) : 0;
}

export async function addCategory(ctx: Ctx, courseId: string, name: unknown, weight: unknown): Promise<Category> {
  const db = await getDb();
  const rows = await db.query(
    `INSERT INTO grade_categories (tenant_id, course_id, name, weight, position)
     VALUES ($1, $2, $3, $4, (SELECT coalesce(max(position), -1) + 1 FROM grade_categories WHERE tenant_id = $1 AND course_id = $2))
     RETURNING *`,
    [ctx.tenantId, courseId, String(name ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || "Category", cleanWeight(weight)],
  );
  return { id: String(rows[0].id), name: String(rows[0].name), weight: Number(rows[0].weight) };
}

export async function updateCategory(ctx: Ctx, courseId: string, id: string, name: unknown, weight: unknown): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const db = await getDb();
  const rows = await db.query(
    "UPDATE grade_categories SET name = $4, weight = $5 WHERE tenant_id = $1 AND course_id = $2 AND id = $3 RETURNING id",
    [ctx.tenantId, courseId, id, String(name ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || "Category", cleanWeight(weight)],
  );
  return rows.length > 0;
}

/** Its assignments are kept and become uncategorized. */
export async function deleteCategory(ctx: Ctx, courseId: string, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const db = await getDb();
  const rows = await db.query(
    "DELETE FROM grade_categories WHERE tenant_id = $1 AND course_id = $2 AND id = $3 RETURNING id",
    [ctx.tenantId, courseId, id],
  );
  return rows.length > 0;
}

export async function setWeighted(ctx: Ctx, courseId: string, weighted: boolean): Promise<void> {
  const db = await getDb();
  await db.query("UPDATE courses SET weighted = $3 WHERE tenant_id = $1 AND id = $2", [ctx.tenantId, courseId, weighted]);
}

export async function isWeighted(ctx: Ctx, courseId: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db.query("SELECT weighted FROM courses WHERE tenant_id = $1 AND id = $2", [ctx.tenantId, courseId]);
  return !!rows[0]?.weighted;
}

// ---------- grading periods ----------

export type Period = { id: string; name: string; startsOn: string; endsOn: string };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function dayText(v: unknown): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

export async function listPeriods(tenantId: string): Promise<Period[]> {
  const db = await getDb();
  const rows = await db.query("SELECT * FROM grading_periods WHERE tenant_id = $1 ORDER BY starts_on", [tenantId]);
  return rows.map((r) => ({ id: String(r.id), name: String(r.name), startsOn: dayText(r.starts_on), endsOn: dayText(r.ends_on) }));
}

export async function addPeriod(tenantId: string, name: unknown, startsOn: unknown, endsOn: unknown): Promise<Period | null> {
  const s = String(startsOn ?? ""), e = String(endsOn ?? "");
  if (!DAY.test(s) || !DAY.test(e) || e < s) return null;
  const db = await getDb();
  const rows = await db.query(
    "INSERT INTO grading_periods (tenant_id, name, starts_on, ends_on) VALUES ($1, $2, $3, $4) RETURNING *",
    [tenantId, String(name ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || "Quarter", s, e],
  );
  const r = rows[0];
  return { id: String(r.id), name: String(r.name), startsOn: dayText(r.starts_on), endsOn: dayText(r.ends_on) };
}

export async function deletePeriod(tenantId: string, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const db = await getDb();
  return (await db.query("DELETE FROM grading_periods WHERE tenant_id = $1 AND id = $2 RETURNING id", [tenantId, id])).length > 0;
}

// The arithmetic lives in grade-math.ts so the gradebook grid can redo it
// in the browser as grades are typed.
export * from "./grade-math";
