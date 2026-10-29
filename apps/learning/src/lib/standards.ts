import { getDb, type Queryable } from "./db";
import { normalizeSettings, type StandardsSettings } from "./standards-math";

/**
 * A course's standards and its grading mode. A course is graded by points
 * (the default; by total or category weights) or by standards. The maths is
 * in standards-math.ts; the gradebook (gradebook.ts) picks one or the other.
 *
 * Standards are archived, never deleted: scores may name them.
 */

type Ctx = { tenantId: string; userId: string };
const UUID = /^[0-9a-f-]{36}$/i;

export type GradingMode = "points" | "standards";

export type Standard = {
  id: string;
  code: string;
  description: string;
  /** A CASE item identifier, for tagging later; null for now. */
  externalId: string | null;
  archived: boolean;
};

export const STANDARD_LIMITS = { code: 40, description: 600, externalId: 200, perCourse: 200 };

function toStandard(r: Record<string, unknown>): Standard {
  return {
    id: String(r.id),
    code: String(r.code),
    description: String(r.description ?? ""),
    externalId: r.external_id ? String(r.external_id) : null,
    archived: !!r.archived,
  };
}

function line(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** The course's standards in the teacher's order; archived ones only when asked. */
export async function listStandards(ctx: Ctx, courseId: string, opts: { withArchived?: boolean } = {}, q?: Queryable): Promise<Standard[]> {
  const db = q ?? await getDb();
  const rows = await db.query(
    `SELECT * FROM standards WHERE tenant_id = $1 AND course_id = $2 ${opts.withArchived ? "" : "AND archived = false"}
      ORDER BY archived, position, code`,
    [ctx.tenantId, courseId],
  );
  return rows.map(toStandard);
}

export async function addStandard(ctx: Ctx, courseId: string, code: unknown, description: unknown, externalId: unknown = null): Promise<Standard | null> {
  const c = line(code, STANDARD_LIMITS.code);
  if (!c) return null;
  const db = await getDb();
  const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM standards WHERE tenant_id = $1 AND course_id = $2", [ctx.tenantId, courseId]);
  if (n >= STANDARD_LIMITS.perCourse) return null;
  const rows = await db.query(
    `INSERT INTO standards (tenant_id, course_id, code, description, external_id, position)
     VALUES ($1, $2, $3, $4, $5, (SELECT coalesce(max(position), -1) + 1 FROM standards WHERE tenant_id = $1 AND course_id = $2))
     RETURNING *`,
    [ctx.tenantId, courseId, c, line(description, STANDARD_LIMITS.description), line(externalId, STANDARD_LIMITS.externalId) || null],
  );
  return toStandard(rows[0]);
}

export async function updateStandard(ctx: Ctx, courseId: string, id: string, code: unknown, description: unknown, externalId: unknown = null): Promise<boolean> {
  const c = line(code, STANDARD_LIMITS.code);
  if (!UUID.test(id) || !c) return false;
  const db = await getDb();
  const rows = await db.query(
    "UPDATE standards SET code = $4, description = $5, external_id = $6 WHERE tenant_id = $1 AND course_id = $2 AND id = $3 RETURNING id",
    [ctx.tenantId, courseId, id, c, line(description, STANDARD_LIMITS.description), line(externalId, STANDARD_LIMITS.externalId) || null],
  );
  return rows.length > 0;
}

/** Archive (hidden from new alignments and summaries) or bring back. Scores are kept. */
export async function archiveStandard(ctx: Ctx, courseId: string, id: string, archived = true): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const db = await getDb();
  const rows = await db.query(
    "UPDATE standards SET archived = $4 WHERE tenant_id = $1 AND course_id = $2 AND id = $3 RETURNING id",
    [ctx.tenantId, courseId, id, archived],
  );
  return rows.length > 0;
}

/** Move one place up (-1) or down (+1). */
export async function moveStandard(ctx: Ctx, courseId: string, id: string, dir: -1 | 1): Promise<boolean> {
  const db = await getDb();
  return db.tx(async (t) => {
    const list = (await listStandards(ctx, courseId, {}, t)).map((s) => s.id);
    const i = list.indexOf(id), j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return false;
    [list[i], list[j]] = [list[j], list[i]];
    for (let k = 0; k < list.length; k++) {
      await t.query("UPDATE standards SET position = $4 WHERE tenant_id = $1 AND course_id = $2 AND id = $3", [ctx.tenantId, courseId, list[k], k]);
    }
    return true;
  });
}

/** Only ids of this course's standards that aren't archived, once each. */
export async function standardsInCourse(ctx: Ctx, courseId: string, ids: string[], q: Queryable): Promise<Set<string>> {
  const want = [...new Set(ids.filter((id) => UUID.test(id)))];
  if (!want.length) return new Set();
  const rows = await q.query(
    "SELECT id FROM standards WHERE tenant_id = $1 AND course_id = $2 AND archived = false AND id = ANY($3::uuid[])",
    [ctx.tenantId, courseId, want],
  );
  return new Set(rows.map((r) => String(r.id)));
}

// ---------- the course's mode and settings ----------

export type CourseGrading = { mode: GradingMode; settings: StandardsSettings };

export async function courseGrading(ctx: Ctx, courseId: string, q?: Queryable): Promise<CourseGrading> {
  const db = q ?? await getDb();
  const rows = await db.query("SELECT grading, standards_settings FROM courses WHERE tenant_id = $1 AND id = $2", [ctx.tenantId, courseId]);
  const r = rows[0];
  const raw = r?.standards_settings;
  return {
    mode: r?.grading === "standards" ? "standards" : "points",
    settings: normalizeSettings(typeof raw === "string" ? JSON.parse(raw) : raw),
  };
}

export async function setGradingMode(ctx: Ctx, courseId: string, mode: GradingMode): Promise<void> {
  const db = await getDb();
  await db.query("UPDATE courses SET grading = $3 WHERE tenant_id = $1 AND id = $2", [ctx.tenantId, courseId, mode === "standards" ? "standards" : "points"]);
}

export async function saveStandardsSettings(ctx: Ctx, courseId: string, input: unknown): Promise<StandardsSettings> {
  const s = normalizeSettings(input);
  const db = await getDb();
  await db.query("UPDATE courses SET standards_settings = $3::jsonb WHERE tenant_id = $1 AND id = $2", [ctx.tenantId, courseId, JSON.stringify(s)]);
  return s;
}
