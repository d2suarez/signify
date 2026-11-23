import { getDb } from "./db";
import { isParts, type Rubric } from "./rubric";

/**
 * Integrity concerns on an assignment (migration 038, story 01 grade
 * assistant): the teacher's own record of possible shared work or an
 * outside source, High / Medium / Note, with the evidence written out.
 * A concern is NEVER a deduction: nothing here touches a grade, and no
 * grade, gradebook, student, parent or preview path reads this table.
 * Teacher routes and pages only.
 */

export type ConcernLevel = "high" | "medium" | "note";
export const CONCERN_LEVELS: ConcernLevel[] = ["high", "medium", "note"];
export type Concern = {
  id: string; level: ConcernLevel; studentIds: string[]; sectionId: string | null; evidence: string;
  createdAt: string; updatedAt: string;
};

type Ctx = { tenantId: string; userId: string };
const UUID = /^[0-9a-f-]{36}$/i;
export const CONCERN_LIMITS = { evidence: 4_000, students: 40, perAssignment: 200 };

export class ConcernError extends Error {}

const toConcern = (r: Record<string, unknown>): Concern => ({
  id: String(r.id), level: CONCERN_LEVELS.includes(r.level as ConcernLevel) ? r.level as ConcernLevel : "note",
  studentIds: (typeof r.student_ids === "string" ? JSON.parse(r.student_ids) : r.student_ids) as string[],
  sectionId: r.section_id ? String(r.section_id) : null, evidence: String(r.evidence ?? ""),
  createdAt: new Date(r.created_at as string).toISOString(), updatedAt: new Date(r.updated_at as string).toISOString(),
});

/**
 * A concern as it may be stored: a known level, 1–40 students who are on
 * the class list now, a section of this rubric (or none), and evidence.
 */
export function cleanConcern(
  input: { level?: unknown; studentIds?: unknown; sectionId?: unknown; evidence?: unknown }, roster: Set<string>, rubric: Rubric | null,
): { level: ConcernLevel; studentIds: string[]; sectionId: string | null; evidence: string } {
  const level = CONCERN_LEVELS.includes(input.level as ConcernLevel) ? input.level as ConcernLevel : null;
  if (!level) throw new ConcernError("level");
  const ids = Array.isArray(input.studentIds) ? [...new Set(input.studentIds.filter((x): x is string => typeof x === "string" && roster.has(x)))] : [];
  if (!ids.length || ids.length > CONCERN_LIMITS.students) throw new ConcernError("students");
  const sectionId = typeof input.sectionId === "string" && isParts(rubric) && rubric.sections.some((s) => s.id === input.sectionId) ? input.sectionId : null;
  const evidence = typeof input.evidence === "string" ? input.evidence.replace(/\r\n/g, "\n").trim().slice(0, CONCERN_LIMITS.evidence) : "";
  if (!evidence) throw new ConcernError("evidence");
  return { level, studentIds: ids, sectionId, evidence };
}

export async function listConcerns(ctx: Ctx, assignmentId: string): Promise<Concern[]> {
  if (!UUID.test(assignmentId)) return [];
  const db = await getDb();
  const rows = await db.query(
    `SELECT * FROM integrity_concerns WHERE tenant_id = $1 AND assignment_id = $2
      ORDER BY CASE level WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at`, [ctx.tenantId, assignmentId]);
  return rows.map(toConcern);
}

export async function addConcern(
  ctx: Ctx, a: { id: string; rubric: Rubric | null }, input: Record<string, unknown>, roster: Set<string>,
): Promise<Concern> {
  const c = cleanConcern(input, roster, a.rubric);
  const db = await getDb();
  const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM integrity_concerns WHERE tenant_id = $1 AND assignment_id = $2", [ctx.tenantId, a.id]);
  if (n >= CONCERN_LIMITS.perAssignment) throw new ConcernError("too-many");
  const [r] = await db.query(
    `INSERT INTO integrity_concerns (tenant_id, assignment_id, level, student_ids, section_id, evidence, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [ctx.tenantId, a.id, c.level, JSON.stringify(c.studentIds), c.sectionId, c.evidence, ctx.userId]);
  return toConcern(r);
}

export async function updateConcern(
  ctx: Ctx, a: { id: string; rubric: Rubric | null }, id: string, input: Record<string, unknown>, roster: Set<string>,
): Promise<Concern | null> {
  if (!UUID.test(id)) return null;
  const c = cleanConcern(input, roster, a.rubric);
  const db = await getDb();
  const [r] = await db.query(
    `UPDATE integrity_concerns SET level = $4, student_ids = $5, section_id = $6, evidence = $7, updated_at = now()
      WHERE tenant_id = $1 AND assignment_id = $2 AND id = $3 RETURNING *`,
    [ctx.tenantId, a.id, id, c.level, JSON.stringify(c.studentIds), c.sectionId, c.evidence]);
  return r ? toConcern(r) : null;
}

export async function removeConcern(ctx: Ctx, assignmentId: string, id: string): Promise<boolean> {
  if (!UUID.test(id) || !UUID.test(assignmentId)) return false;
  const db = await getDb();
  const rows = await db.query("DELETE FROM integrity_concerns WHERE tenant_id = $1 AND assignment_id = $2 AND id = $3 RETURNING id", [ctx.tenantId, assignmentId, id]);
  return rows.length > 0;
}
