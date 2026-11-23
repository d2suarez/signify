import { getDb, type Queryable } from "./db";

/**
 * Units and the folders inside them (migration 026): a course's chapters, in
 * the teacher's order. A top-level folder is a unit ("Unit 3"); a folder can
 * hold folders ("Chapter 7"), up to MAX_DEPTH levels. A folder only groups:
 * deleting one moves its folders, lessons and assignments up into its parent
 * (or out of any unit), so nothing is ever lost.
 *
 * `position` orders a folder among its siblings. Lists come back in tree
 * order (depth first), each with its depth and its path ("Unit 3 › Chapter 7").
 */

export type Unit = {
  id: string; courseId: string; title: string; position: number;
  parentId: string | null;
  /** 0 = a top-level unit. */
  depth: number;
  /** Titles from the top unit down to this one, joined with " › ". */
  path: string;
};

/** Levels of folders allowed: a unit, and four levels of folders inside it. */
export const MAX_DEPTH = 5;
export const PATH_SEP = " › ";

type Ctx = { tenantId: string; userId: string };

export class FolderError extends Error {
  constructor() { super("That folder can't hold another folder."); }
}
const UUID = /^[0-9a-f-]{36}$/i;

export function cleanTitle(v: unknown, fallback: string): string {
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || fallback;
}

type Row = { id: string; courseId: string; title: string; position: number; parentId: string | null };

function toRow(r: Record<string, unknown>): Row {
  return {
    id: String(r.id), courseId: String(r.course_id), title: String(r.title), position: Number(r.position),
    parentId: r.parent_id ? String(r.parent_id) : null,
  };
}

/**
 * Rows (already sorted by position) in tree order with depth and path. A
 * folder whose parent is missing counts as top level; a loop (never written
 * by this file) is broken the same way, so every folder appears once.
 */
export function orderTree(rows: Row[]): Unit[] {
  const ids = new Set(rows.map((r) => r.id));
  const kids = new Map<string | null, Row[]>();
  for (const r of rows) {
    const p = r.parentId && ids.has(r.parentId) && r.parentId !== r.id ? r.parentId : null;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p)!.push(r);
  }
  const out: Unit[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number, path: string) => {
    for (const r of kids.get(parent) ?? []) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      const p = path ? `${path}${PATH_SEP}${r.title}` : r.title;
      out.push({ ...r, parentId: parent, depth, path: p });
      walk(r.id, depth + 1, p);
    }
  };
  walk(null, 0, "");
  // Anything left is in a loop: put it at the top level.
  for (const r of rows) if (!seen.has(r.id)) { seen.add(r.id); out.push({ ...r, parentId: null, depth: 0, path: r.title }); walk(r.id, 1, r.title); }
  return out;
}

/** This folder's id and every folder inside it, at any depth. */
export function subtreeIds(units: Pick<Unit, "id" | "parentId">[], id: string): Set<string> {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const u of units) if (u.parentId && out.has(u.parentId) && !out.has(u.id)) { out.add(u.id); grew = true; }
  }
  return out;
}

/** How many levels a folder's subtree spans (1 = no folders inside). */
function height(units: Unit[], id: string): number {
  const at = units.find((u) => u.id === id);
  if (!at) return 0;
  let max = at.depth;
  for (const x of subtreeIds(units, id)) max = Math.max(max, units.find((u) => u.id === x)!.depth);
  return max - at.depth + 1;
}

async function loadTree(q: Queryable, ctx: Ctx, courseId: string, lock = false): Promise<Unit[]> {
  const rows = await q.query(
    `SELECT * FROM units WHERE tenant_id = $1 AND course_id = $2 ORDER BY position, created_at${lock ? " FOR UPDATE" : ""}`,
    [ctx.tenantId, courseId],
  );
  return orderTree(rows.map(toRow));
}

export async function listUnits(ctx: Ctx, courseId: string): Promise<Unit[]> {
  return loadTree(await getDb(), ctx, courseId);
}

async function nextPosition(q: Queryable, ctx: Ctx, courseId: string, parentId: string | null): Promise<number> {
  const [r] = await q.query(
    "SELECT coalesce(max(position), -1) + 1 AS next FROM units WHERE tenant_id = $1 AND course_id = $2 AND parent_id IS NOT DISTINCT FROM $3::uuid",
    [ctx.tenantId, courseId, parentId],
  );
  return Number(r.next);
}

/**
 * Makes a folder at the end of its parent's folders (or of the top-level
 * units). Throws FolderError when the parent isn't this course's, or the
 * new folder would be deeper than MAX_DEPTH.
 */
export async function createUnit(ctx: Ctx, courseId: string, title: string, parentId: unknown = null): Promise<Unit> {
  const db = await getDb();
  return db.tx(async (q) => {
    const tree = await loadTree(q, ctx, courseId);
    let parent: Unit | null = null;
    if (parentId) {
      parent = tree.find((u) => u.id === String(parentId)) ?? null;
      if (!parent || parent.depth + 1 >= MAX_DEPTH) throw new FolderError();
    }
    const [r] = await q.query(
      `INSERT INTO units (tenant_id, course_id, title, position, parent_id) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [ctx.tenantId, courseId, cleanTitle(title, parent ? "Untitled folder" : "Untitled unit"), await nextPosition(q, ctx, courseId, parent?.id ?? null), parent?.id ?? null],
    );
    const row = toRow(r);
    return { ...row, depth: parent ? parent.depth + 1 : 0, path: parent ? `${parent.path}${PATH_SEP}${row.title}` : row.title };
  });
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

/** Swaps a folder with its neighbour among its siblings; their positions are renumbered 0..n-1. */
export async function moveUnit(ctx: Ctx, courseId: string, id: string, by: -1 | 1): Promise<boolean> {
  const db = await getDb();
  return db.tx(async (t) => {
    const tree = await loadTree(t, ctx, courseId, true);
    const me = tree.find((u) => u.id === id);
    if (!me) return false;
    const ids = tree.filter((u) => u.parentId === me.parentId).map((u) => u.id);
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

/**
 * Puts a folder (with everything in it) inside another folder of this
 * course, or at the top level (null), at the end. Refused when the new
 * parent is the folder itself or inside it, or the result would be deeper
 * than MAX_DEPTH.
 */
export async function setUnitParent(ctx: Ctx, courseId: string, id: string, parentId: string | null): Promise<boolean> {
  if (!UUID.test(id) || (parentId !== null && !UUID.test(parentId))) return false;
  const db = await getDb();
  return db.tx(async (t) => {
    const tree = await loadTree(t, ctx, courseId, true);
    const me = tree.find((u) => u.id === id);
    if (!me) return false;
    if (me.parentId === parentId) return true;
    let depth = 0;
    if (parentId) {
      const parent = tree.find((u) => u.id === parentId);
      if (!parent || subtreeIds(tree, id).has(parentId)) return false;
      depth = parent.depth + 1;
    }
    if (depth + height(tree, id) > MAX_DEPTH) return false;
    await t.query("UPDATE units SET parent_id = $3, position = $4 WHERE tenant_id = $1 AND id = $2",
      [ctx.tenantId, id, parentId, await nextPosition(t, ctx, courseId, parentId)]);
    return true;
  });
}

/**
 * Deletes a folder. Its folders join its parent's (after the parent's own),
 * and its lessons and assignments go to the end of the parent's items (or
 * out of any unit), in the order they had.
 */
export async function deleteUnit(ctx: Ctx, courseId: string, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const db = await getDb();
  return db.tx(async (t) => {
    const tree = await loadTree(t, ctx, courseId, true);
    const me = tree.find((u) => u.id === id);
    if (!me) return false;
    const up = me.parentId;
    let pos = await nextPosition(t, ctx, courseId, up);
    for (const child of tree.filter((u) => u.parentId === id)) {
      await t.query("UPDATE units SET parent_id = $3, position = $4 WHERE tenant_id = $1 AND id = $2", [ctx.tenantId, child.id, up, pos++]);
    }
    const [{ next }] = await t.query(
      `SELECT coalesce(max(p), -1) + 1 AS next FROM (
         SELECT max(position) AS p FROM lessons WHERE tenant_id = $1 AND course_id = $2 AND unit_id IS NOT DISTINCT FROM $3::uuid AND archived = false
         UNION ALL SELECT max(position) FROM assignments WHERE tenant_id = $1 AND course_id = $2 AND unit_id IS NOT DISTINCT FROM $3::uuid AND archived = false) x`,
      [ctx.tenantId, courseId, up],
    );
    const items = await t.query(
      `SELECT kind, id FROM (
         SELECT 'lessons' AS kind, id, position, planned_for AS day, created_at FROM lessons WHERE tenant_id = $1 AND course_id = $2 AND unit_id = $3
         UNION ALL
         SELECT 'assignments', id, position, due_on, created_at FROM assignments WHERE tenant_id = $1 AND course_id = $2 AND unit_id = $3
       ) x ORDER BY position NULLS LAST, coalesce(day::text, '9999'), created_at, kind, id`,
      [ctx.tenantId, courseId, id],
    );
    let n = Number(next);
    for (const it of items) {
      const table = it.kind === "lessons" ? "lessons" : "assignments";
      await t.query(`UPDATE ${table} SET unit_id = $3, position = $4 WHERE tenant_id = $1 AND id = $2`, [ctx.tenantId, String(it.id), up, n++]);
    }
    const rows = await t.query("DELETE FROM units WHERE tenant_id = $1 AND course_id = $2 AND id = $3 RETURNING id", [ctx.tenantId, courseId, id]);
    return rows.length > 0;
  });
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

/** A folder choice for a <select>: indented by depth, the path read out for screen readers. */
export function unitChoices(units: Unit[]): { id: string; title: string; label: string }[] {
  return units.map((u) => ({ id: u.id, title: u.path, label: `${"   ".repeat(u.depth)}${u.depth ? "↳ " : ""}${u.title}` }));
}
