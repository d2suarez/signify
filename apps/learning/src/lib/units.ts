import { getDb, type Queryable } from "./db";

/**
 * Units: the chapters of a course, in the teacher's order. A unit only
 * groups; deleting one moves its lessons and assignments to "no unit".
 */

export type Unit = { id: string; courseId: string; title: string; position: number };

type Ctx = { tenantId: string; userId: string };
const UUID = /^[0-9a-f-]{36}$/i;

export function cleanTitle(v: unknown, fallback: string): string {
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || fallback;
}

function toUnit(r: Record<string, unknown>): Unit {
  return { id: String(r.id), courseId: String(r.course_id), title: String(r.title), position: Number(r.position) };
}

export async function listUnits(ctx: Ctx, courseId: string): Promise<Unit[]> {
  const db = await getDb();
  const rows = await db.query(
    "SELECT * FROM units WHERE tenant_id = $1 AND course_id = $2 ORDER BY position, created_at",
    [ctx.tenantId, courseId],
  );
  return rows.map(toUnit);
}

export async function createUnit(ctx: Ctx, courseId: string, title: string): Promise<Unit> {
  const db = await getDb();
  const rows = await db.query(
    `INSERT INTO units (tenant_id, course_id, title, position)
     VALUES ($1, $2, $3, (SELECT coalesce(max(position), -1) + 1 FROM units WHERE tenant_id = $1 AND course_id = $2))
     RETURNING *`,
    [ctx.tenantId, courseId, cleanTitle(title, "Untitled unit")],
  );
  return toUnit(rows[0]);
}

export async function renameUnit(ctx: Ctx, courseId: string, id: string, title: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const db = await getDb();
  const rows = await db.query(
    "UPDATE units SET title = $4 WHERE tenant_id = $1 AND course_id = $2 AND id = $3 RETURNING id",
    [ctx.tenantId, courseId, id, cleanTitle(title, "Untitled unit")],
  );
  return rows.length > 0;
}

/** Swaps a unit with its neighbour; positions are renumbered 0..n-1 as it goes. */
export async function moveUnit(ctx: Ctx, courseId: string, id: string, by: -1 | 1): Promise<boolean> {
  const db = await getDb();
  return db.tx(async (t) => {
    const rows = await t.query<{ id: string }>(
      "SELECT id FROM units WHERE tenant_id = $1 AND course_id = $2 ORDER BY position, created_at FOR UPDATE",
      [ctx.tenantId, courseId],
    );
    const ids = rows.map((r) => String(r.id));
    const i = ids.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= ids.length) return false;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    for (let k = 0; k < ids.length; k++) {
      await t.query("UPDATE units SET position = $3 WHERE tenant_id = $1 AND id = $2", [ctx.tenantId, ids[k], k]);
    }
    return true;
  });
}

export async function deleteUnit(ctx: Ctx, courseId: string, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const db = await getDb();
  const rows = await db.query(
    "DELETE FROM units WHERE tenant_id = $1 AND course_id = $2 AND id = $3 RETURNING id",
    [ctx.tenantId, courseId, id],
  );
  return rows.length > 0;
}

/** A unit id from a form or request, only if it is one of this course's units. */
export async function unitInCourse(ctx: Ctx, courseId: string, v: unknown, q?: Queryable): Promise<string | null> {
  const id = typeof v === "string" ? v : "";
  if (!UUID.test(id)) return null;
  const db = q ?? await getDb();
  const rows = await db.query(
    "SELECT id FROM units WHERE tenant_id = $1 AND course_id = $2 AND id = $3",
    [ctx.tenantId, courseId, id],
  );
  return rows[0] ? id : null;
}
