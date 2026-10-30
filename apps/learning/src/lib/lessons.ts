import { getDb } from "./db";
import { type Block, normalizeBlocks } from "./blocks";
import { unitInCourse } from "./units";
import { standardsInCourse } from "./standards";

/**
 * Lessons. Every save names the version it started from; a save based on an
 * older version is refused rather than written over (two tabs or two devices
 * fighting is how the desk lost work). Before each save that changes
 * anything, the lesson as it stood is copied into lesson_versions, so any
 * earlier state can be brought back.
 */

export type Lesson = {
  id: string;
  courseId: string;
  unitId: string | null;
  title: string;
  plannedFor: string | null;
  durationMin: number;
  blocks: Block[];
  /** The course standards it addresses (filing, like its unit: not versioned). */
  standards: string[] | null;
  version: number;
  updatedAt: string;
};

export type LessonSummary = Pick<Lesson, "id" | "unitId" | "title" | "plannedFor" | "durationMin" | "version" | "updatedAt"> & {
  blockCount: number;
};

export const KEEP_VERSIONS = 50;
const UUID = /^[0-9a-f-]{36}$/i;

type Ctx = { tenantId: string; userId: string };

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function day(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function toLesson(r: Record<string, unknown>): Lesson {
  return {
    id: String(r.id),
    courseId: String(r.course_id),
    unitId: r.unit_id ? String(r.unit_id) : null,
    title: String(r.title),
    plannedFor: day(r.planned_for),
    durationMin: Number(r.duration_min),
    blocks: (typeof r.blocks === "string" ? JSON.parse(r.blocks) : r.blocks) as Block[],
    standards: Array.isArray(r.standards) ? (r.standards as string[]) : typeof r.standards === "string" ? JSON.parse(r.standards) : null,
    version: Number(r.version),
    updatedAt: iso(r.updated_at),
  };
}

export async function listLessons(ctx: Ctx, courseId: string): Promise<LessonSummary[]> {
  const db = await getDb();
  const rows = await db.query(
    `SELECT id, unit_id, title, planned_for, duration_min, version, updated_at, jsonb_array_length(blocks) AS n
       FROM lessons WHERE tenant_id = $1 AND course_id = $2 AND archived = false
      ORDER BY planned_for NULLS LAST, created_at`,
    [ctx.tenantId, courseId],
  );
  return rows.map((r) => ({
    id: String(r.id),
    unitId: r.unit_id ? String(r.unit_id) : null,
    title: String(r.title),
    plannedFor: day(r.planned_for),
    durationMin: Number(r.duration_min),
    version: Number(r.version),
    updatedAt: iso(r.updated_at),
    blockCount: Number(r.n),
  }));
}

export async function createLesson(
  ctx: Ctx, courseId: string, title: string, blocks: Block[] = [], unitId: unknown = null,
): Promise<Lesson> {
  const db = await getDb();
  const clean = title.replace(/\s+/g, " ").trim().slice(0, 200) || "Untitled lesson";
  const unit = await unitInCourse(ctx, courseId, unitId);
  const rows = await db.query(
    `INSERT INTO lessons (tenant_id, course_id, title, blocks, unit_id, created_by, updated_by)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $6) RETURNING *`,
    [ctx.tenantId, courseId, clean, JSON.stringify(normalizeBlocks(blocks)), unit, ctx.userId],
  );
  return toLesson(rows[0]);
}

export async function getLesson(ctx: Ctx, id: string): Promise<Lesson | null> {
  if (!UUID.test(id)) return null;
  const db = await getDb();
  const rows = await db.query(
    "SELECT * FROM lessons WHERE tenant_id = $1 AND id = $2 AND archived = false",
    [ctx.tenantId, id],
  );
  return rows[0] ? toLesson(rows[0]) : null;
}

/**
 * Which of the course's standards a lesson addresses. Only the course's own
 * live standards are kept, once each. Filing, like the unit: no new
 * version. Returns what was kept, or null if there is no such lesson.
 */
export async function setLessonStandards(ctx: Ctx, id: string, ids: unknown): Promise<string[] | null> {
  const lesson = await getLesson(ctx, id);
  if (!lesson) return null;
  const want = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
  const db = await getDb();
  const ok = await standardsInCourse(ctx, lesson.courseId, want, db);
  const list = [...new Set(want.filter((x) => ok.has(x)))];
  await db.query("UPDATE lessons SET standards = $3::jsonb WHERE tenant_id = $1 AND id = $2",
    [ctx.tenantId, id, list.length ? JSON.stringify(list) : null]);
  return list;
}

export type SaveInput = {
  baseVersion: number;
  title?: unknown;
  blocks?: unknown;
  plannedFor?: unknown;
  durationMin?: unknown;
  /** A unit of the same course, or null for none. Not kept in versions. */
  unitId?: unknown;
};

export type SaveResult =
  | { ok: true; lesson: Lesson; changed: boolean }
  | { ok: false; reason: "conflict"; lesson: Lesson }
  | { ok: false; reason: "missing" };

export async function saveLesson(ctx: Ctx, id: string, input: SaveInput): Promise<SaveResult> {
  if (!UUID.test(id)) return { ok: false, reason: "missing" };
  const db = await getDb();
  return db.tx(async (t) => {
    const rows = await t.query(
      "SELECT * FROM lessons WHERE tenant_id = $1 AND id = $2 AND archived = false FOR UPDATE",
      [ctx.tenantId, id],
    );
    if (!rows[0]) return { ok: false, reason: "missing" } as const;
    const current = toLesson(rows[0]);
    if (Number(input.baseVersion) !== current.version) {
      return { ok: false, reason: "conflict", lesson: current } as const;
    }

    const next = {
      title: input.title === undefined
        ? current.title
        : String(input.title).replace(/\s+/g, " ").trim().slice(0, 200) || "Untitled lesson",
      blocks: input.blocks === undefined ? current.blocks : normalizeBlocks(input.blocks),
      plannedFor: input.plannedFor === undefined
        ? current.plannedFor
        : (typeof input.plannedFor === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.plannedFor) ? input.plannedFor : null),
      durationMin: input.durationMin === undefined
        ? current.durationMin
        : Math.min(600, Math.max(5, Math.round(Number(input.durationMin)) || current.durationMin)),
    };

    const unitId = input.unitId === undefined
      ? current.unitId
      : await unitInCourse(ctx, current.courseId, input.unitId, t);
    if (unitId !== current.unitId) {
      // Which unit a lesson sits in is filing, not content: no new version.
      await t.query("UPDATE lessons SET unit_id = $3 WHERE tenant_id = $1 AND id = $2", [ctx.tenantId, id, unitId]);
      current.unitId = unitId;
    }

    const changed = next.title !== current.title
      || JSON.stringify(next.blocks) !== JSON.stringify(current.blocks)
      || next.plannedFor !== current.plannedFor
      || next.durationMin !== current.durationMin;
    if (!changed) return { ok: true, lesson: current, changed: false } as const;

    // Keep the lesson as it was before this save.
    await t.query(
      `INSERT INTO lesson_versions (tenant_id, lesson_id, version, title, blocks, saved_by, saved_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       ON CONFLICT (lesson_id, version) DO NOTHING`,
      [ctx.tenantId, id, current.version, current.title, JSON.stringify(current.blocks),
        String(rows[0].updated_by), rows[0].updated_at],
    );
    await t.query(
      `DELETE FROM lesson_versions WHERE lesson_id = $1 AND version <= (
         SELECT max(version) - $2 FROM lesson_versions WHERE lesson_id = $1)`,
      [id, KEEP_VERSIONS],
    );
    const saved = await t.query(
      `UPDATE lessons SET title = $3, blocks = $4::jsonb, planned_for = $5, duration_min = $6,
              version = version + 1, updated_by = $7, updated_at = now()
        WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [ctx.tenantId, id, next.title, JSON.stringify(next.blocks), next.plannedFor, next.durationMin, ctx.userId],
    );
    return { ok: true, lesson: toLesson(saved[0]), changed: true } as const;
  });
}

export type VersionSummary = { version: number; title: string; blockCount: number; savedAt: string };

export async function listVersions(ctx: Ctx, id: string): Promise<VersionSummary[]> {
  if (!UUID.test(id)) return [];
  const db = await getDb();
  const rows = await db.query(
    `SELECT version, title, jsonb_array_length(blocks) AS n, saved_at
       FROM lesson_versions WHERE tenant_id = $1 AND lesson_id = $2
      ORDER BY version DESC`,
    [ctx.tenantId, id],
  );
  return rows.map((r) => ({ version: Number(r.version), title: String(r.title), blockCount: Number(r.n), savedAt: iso(r.saved_at) }));
}

/**
 * Brings back an earlier version as a NEW save, so the restore itself can be
 * undone from the same list.
 */
export async function restoreVersion(ctx: Ctx, id: string, version: number, baseVersion: number): Promise<SaveResult> {
  const db = await getDb();
  const rows = await db.query(
    "SELECT title, blocks FROM lesson_versions WHERE tenant_id = $1 AND lesson_id = $2 AND version = $3",
    [ctx.tenantId, id, version],
  );
  if (!rows[0]) return { ok: false, reason: "missing" };
  const blocks = typeof rows[0].blocks === "string" ? JSON.parse(rows[0].blocks as string) : rows[0].blocks;
  return saveLesson(ctx, id, { baseVersion, title: rows[0].title, blocks });
}
