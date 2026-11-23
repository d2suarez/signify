import { getDb } from "./db";

/**
 * Reviewed marks for the grading review screen (migration 037, story 01
 * grade assistant). Teacher routes and pages only: never part of a Grade,
 * so no student, parent or preview path carries it.
 */

type Ctx = { tenantId: string; userId: string };
const UUID = /^[0-9a-f-]{36}$/i;

/** Student id → when the teacher marked it reviewed. */
export async function reviewedFor(ctx: Ctx, assignmentId: string): Promise<Map<string, string>> {
  if (!UUID.test(assignmentId)) return new Map();
  const db = await getDb();
  const rows = await db.query("SELECT student_id, reviewed_at FROM grade_reviews WHERE tenant_id = $1 AND assignment_id = $2", [ctx.tenantId, assignmentId]);
  return new Map(rows.map((r) => [String(r.student_id), new Date(r.reviewed_at as string).toISOString()]));
}

/**
 * Mark (or unmark) students reviewed. Only students on the live roster
 * (the caller passes it); answers student id → reviewed time (or null).
 */
export async function setReviewed(
  ctx: Ctx, assignmentId: string, studentIds: string[], reviewed: boolean, roster: Set<string>,
): Promise<Record<string, string | null>> {
  const db = await getDb();
  const out: Record<string, string | null> = {};
  for (const id of [...new Set(studentIds)].filter((x) => roster.has(x)).slice(0, 500)) {
    if (reviewed) {
      const [r] = await db.query(
        `INSERT INTO grade_reviews (tenant_id, assignment_id, student_id, reviewed_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (assignment_id, student_id) DO UPDATE SET reviewed_by = EXCLUDED.reviewed_by, reviewed_at = now()
         WHERE grade_reviews.tenant_id = EXCLUDED.tenant_id
         RETURNING reviewed_at`, [ctx.tenantId, assignmentId, id, ctx.userId]);
      out[id] = r ? new Date(r.reviewed_at as string).toISOString() : null;
    } else {
      await db.query("DELETE FROM grade_reviews WHERE tenant_id = $1 AND assignment_id = $2 AND student_id = $3", [ctx.tenantId, assignmentId, id]);
      out[id] = null;
    }
  }
  return out;
}
