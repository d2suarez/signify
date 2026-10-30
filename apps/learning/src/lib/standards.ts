import crypto from "node:crypto";
import { getDb, type Queryable } from "./db";
import { normalizeSettings, type StandardsSettings } from "./standards-math";

/**
 * A course's standards and its grading mode. A course is graded by points
 * (the default; by total or category weights) or by standards. The maths is
 * in standards-math.ts; the gradebook (gradebook.ts) picks one or the other.
 *
 * Standards are archived, never deleted: scores may name them.
 *
 * Each course standard points at a standards library item (item_id; see
 * standards-library.ts) and keeps its own copy of the code and statement.
 * One typed straight into the course becomes an item of the course's own
 * framework.
 */

type Ctx = { tenantId: string; userId: string };
const UUID = /^[0-9a-f-]{36}$/i;

export type GradingMode = "points" | "standards";

export type Standard = {
  id: string;
  code: string;
  description: string;
  /** The CASE identifier of the item it came from. */
  externalId: string | null;
  /** The standards library item it points at. */
  itemId: string | null;
  /** Only in the course's own framework (typed into the course): edited here. Library and school items are edited at their source. */
  editable: boolean;
  archived: boolean;
};

export const STANDARD_LIMITS = { code: 60, description: 2000, externalId: 200, perCourse: 200 };

function toStandard(r: Record<string, unknown>): Standard {
  return {
    id: String(r.id),
    code: String(r.code),
    description: String(r.description ?? ""),
    externalId: r.external_id ? String(r.external_id) : null,
    itemId: r.item_id ? String(r.item_id) : null,
    editable: !r.item_id || r.course_framework === true,
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
    `SELECT s.*, (f.course_id = s.course_id) AS course_framework
       FROM standards s LEFT JOIN standard_items i ON i.id = s.item_id LEFT JOIN standard_frameworks f ON f.id = i.framework_id
      WHERE s.tenant_id = $1 AND s.course_id = $2 ${opts.withArchived ? "" : "AND s.archived = false"}
      ORDER BY s.archived, s.position, s.code`,
    [ctx.tenantId, courseId],
  );
  return rows.map(toStandard);
}

/** May teachers type their own standards into a course? (The school's choice; yes unless it said no.) */
export async function teachersMayAdd(tenantId: string, q?: Queryable): Promise<boolean> {
  const db = q ?? await getDb();
  const rows = await db.query("SELECT teacher_frameworks FROM school_standards_settings WHERE tenant_id = $1", [tenantId]);
  return rows[0] ? !!rows[0].teacher_frameworks : true;
}

/**
 * A standard typed straight into the course: a new item in the course's own
 * framework (made on first use), and the course standard pointing at it.
 * Refused when the school doesn't let teachers make their own.
 */
export async function addStandard(ctx: Ctx, courseId: string, code: unknown, description: unknown): Promise<Standard | null> {
  const c = line(code, STANDARD_LIMITS.code);
  if (!c) return null;
  const db = await getDb();
  if (!(await teachersMayAdd(ctx.tenantId, db))) return null;
  return db.tx(async (t) => {
    const [{ n }] = await t.query<{ n: number }>("SELECT count(*)::int AS n FROM standards WHERE tenant_id = $1 AND course_id = $2", [ctx.tenantId, courseId]);
    if (n >= STANDARD_LIMITS.perCourse) return null;
    const course = await t.query<{ name: string }>("SELECT name FROM courses WHERE tenant_id = $1 AND id = $2", [ctx.tenantId, courseId]);
    if (!course[0]) return null;
    const desc = line(description, STANDARD_LIMITS.description);
    let fw = (await t.query<{ id: string }>(
      "SELECT id FROM standard_frameworks WHERE tenant_id = $1 AND owner_kind = 'teacher' AND course_id = $2 ORDER BY created_at LIMIT 1", [ctx.tenantId, courseId],
    ))[0]?.id;
    fw ??= (await t.query<{ id: string }>(
      `INSERT INTO standard_frameworks (tenant_id, owner_kind, course_id, identifier, title, created_by) VALUES ($1, 'teacher', $2, $3, $4, $5) RETURNING id`,
      [ctx.tenantId, courseId, crypto.randomUUID(), course[0].name, ctx.userId],
    ))[0].id;
    const identifier = crypto.randomUUID();
    const [item] = await t.query<{ id: string }>(
      `INSERT INTO standard_items (tenant_id, framework_id, identifier, code, statement, position)
       VALUES ($1, $2, $3, $4, $5, (SELECT coalesce(max(position), -1) + 1 FROM standard_items WHERE framework_id = $2)) RETURNING id`,
      [ctx.tenantId, fw, identifier, c, desc || c],
    );
    const rows = await t.query(
      `INSERT INTO standards (tenant_id, course_id, code, description, external_id, item_id, position)
       VALUES ($1, $2, $3, $4, $5, $6, (SELECT coalesce(max(position), -1) + 1 FROM standards WHERE tenant_id = $1 AND course_id = $2))
       RETURNING *, true AS course_framework`,
      [ctx.tenantId, courseId, c, desc, identifier, item.id],
    );
    return toStandard(rows[0]);
  });
}

/**
 * Changes a standard typed into this course (and its item). One added from
 * the library or a school framework is changed at its source, not here.
 */
export async function updateStandard(ctx: Ctx, courseId: string, id: string, code: unknown, description: unknown): Promise<boolean> {
  const c = line(code, STANDARD_LIMITS.code);
  if (!UUID.test(id) || !c) return false;
  const db = await getDb();
  const s = (await listStandards(ctx, courseId, { withArchived: true }, db)).find((x) => x.id === id);
  if (!s?.editable) return false;
  const desc = line(description, STANDARD_LIMITS.description);
  return db.tx(async (t) => {
    await t.query("UPDATE standards SET code = $4, description = $5 WHERE tenant_id = $1 AND course_id = $2 AND id = $3", [ctx.tenantId, courseId, id, c, desc]);
    if (s.itemId) await t.query("UPDATE standard_items SET code = $3, statement = $4 WHERE tenant_id = $1 AND id = $2", [ctx.tenantId, s.itemId, c, desc || c]);
    return true;
  });
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

/**
 * Where a standards course's scale and conversion come from: its own
 * (when the school lets courses have their own), else the school's
 * default, else the built-in default.
 */
export type SettingsSource = "course" | "school" | "default";
export type CourseGrading = { mode: GradingMode; settings: StandardsSettings; source: SettingsSource; courseSettingsAllowed: boolean };

export async function courseGrading(ctx: Ctx, courseId: string, q?: Queryable): Promise<CourseGrading> {
  const db = q ?? await getDb();
  const rows = await db.query(
    `SELECT c.grading, c.standards_settings, s.settings AS school_settings, coalesce(s.course_settings, true) AS course_settings
       FROM courses c LEFT JOIN school_standards_settings s ON s.tenant_id = c.tenant_id
      WHERE c.tenant_id = $1 AND c.id = $2`,
    [ctx.tenantId, courseId],
  );
  const r = rows[0];
  const json = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);
  const allowed = r ? !!r.course_settings : true;
  const source: SettingsSource = r?.standards_settings && allowed ? "course" : r?.school_settings ? "school" : "default";
  return {
    mode: r?.grading === "standards" ? "standards" : "points",
    settings: normalizeSettings(source === "course" ? json(r!.standards_settings) : source === "school" ? json(r!.school_settings) : null),
    source,
    courseSettingsAllowed: allowed,
  };
}

export async function setGradingMode(ctx: Ctx, courseId: string, mode: GradingMode): Promise<void> {
  const db = await getDb();
  await db.query("UPDATE courses SET grading = $3 WHERE tenant_id = $1 AND id = $2", [ctx.tenantId, courseId, mode === "standards" ? "standards" : "points"]);
}

/** The course's own settings; null = follow the school's. Refused (null) when the school doesn't allow course settings. */
export async function saveStandardsSettings(ctx: Ctx, courseId: string, input: unknown): Promise<StandardsSettings | null> {
  const db = await getDb();
  if (input !== null && !(await courseGrading(ctx, courseId, db)).courseSettingsAllowed) return null;
  const s = input === null ? null : normalizeSettings(input);
  await db.query("UPDATE courses SET standards_settings = $3::jsonb WHERE tenant_id = $1 AND id = $2", [ctx.tenantId, courseId, s ? JSON.stringify(s) : null]);
  return s;
}
