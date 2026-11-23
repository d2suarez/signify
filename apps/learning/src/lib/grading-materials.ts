import { getDb } from "./db";
import { webLink } from "./blocks";

/**
 * Answer keys and grading materials (migration 035, story 01 A11): the
 * teacher's own sources of truth for grading an assignment. Only teacher
 * pages and routes call this file; nothing here is ever part of an
 * Assignment, so no student, parent, preview, Updates post or copy can
 * carry it. A file attached here opens for the class's teachers only.
 */

export type MaterialRole = "key" | "reading" | "guide" | "other";
export const MATERIAL_ROLES: MaterialRole[] = ["key", "reading", "guide", "other"];

export type GradingMaterial = {
  id: string; role: MaterialRole; title: string;
  /** An uploaded file (opened at /files/<id>) or a link: exactly one. */
  fileId: string | null; fileName: string | null; url: string | null;
};

type Ctx = { tenantId: string; userId: string };
const UUID = /^[0-9a-f-]{36}$/i;
export const MAX_MATERIALS = 20;

export class MaterialError extends Error {}

const cleanRole = (v: unknown): MaterialRole => (MATERIAL_ROLES.includes(v as MaterialRole) ? v as MaterialRole : "key");
const cleanTitle = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 200) : "");

export async function listMaterials(ctx: Ctx, assignmentId: string): Promise<GradingMaterial[]> {
  if (!UUID.test(assignmentId)) return [];
  const db = await getDb();
  const rows = await db.query(
    `SELECT m.*, f.name AS file_name FROM grading_materials m LEFT JOIN course_files f ON f.id = m.file_id AND f.tenant_id = m.tenant_id
      WHERE m.tenant_id = $1 AND m.assignment_id = $2 ORDER BY m.position, m.created_at`,
    [ctx.tenantId, assignmentId]);
  return rows.map((r) => ({
    id: String(r.id), role: cleanRole(r.role), title: String(r.title ?? ""),
    fileId: r.file_id ? String(r.file_id) : null, fileName: r.file_name ? String(r.file_name) : null, url: r.url ? String(r.url) : null,
  }));
}

/**
 * Attach a file (one of THIS class's uploads) or an http(s) link. Teachers
 * only: the caller checks the role.
 */
export async function addMaterial(
  ctx: Ctx, a: { id: string; courseId: string }, input: { role?: unknown; title?: unknown; fileId?: unknown; url?: unknown },
): Promise<GradingMaterial> {
  const db = await getDb();
  const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM grading_materials WHERE tenant_id = $1 AND assignment_id = $2", [ctx.tenantId, a.id]);
  if (n >= MAX_MATERIALS) throw new MaterialError("too-many");
  let fileId: string | null = null, url: string | null = null;
  if (typeof input.fileId === "string" && input.fileId) {
    if (!UUID.test(input.fileId)) throw new MaterialError("bad-file");
    const f = await db.query("SELECT id FROM course_files WHERE tenant_id = $1 AND course_id = $2 AND id = $3", [ctx.tenantId, a.courseId, input.fileId]);
    if (!f[0]) throw new MaterialError("bad-file");
    fileId = input.fileId;
  } else {
    url = webLink(input.url) || null;
    if (!url) throw new MaterialError("bad-link");
  }
  const rows = await db.query(
    `INSERT INTO grading_materials (tenant_id, assignment_id, role, title, file_id, url, position, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [ctx.tenantId, a.id, cleanRole(input.role), cleanTitle(input.title), fileId, url, n, ctx.userId]);
  return (await listMaterials(ctx, a.id)).find((m) => m.id === String(rows[0].id))!;
}

export async function removeMaterial(ctx: Ctx, assignmentId: string, id: string): Promise<boolean> {
  if (!UUID.test(id) || !UUID.test(assignmentId)) return false;
  const db = await getDb();
  const rows = await db.query("DELETE FROM grading_materials WHERE tenant_id = $1 AND assignment_id = $2 AND id = $3 RETURNING id", [ctx.tenantId, assignmentId, id]);
  return rows.length > 0;
}

/** Whether a file is any assignment's grading material: then only teachers ever open it. */
export async function isGradingFile(tenantId: string, fileId: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db.query("SELECT 1 FROM grading_materials WHERE tenant_id = $1 AND file_id = $2 LIMIT 1", [tenantId, fileId]);
  return rows.length > 0;
}
