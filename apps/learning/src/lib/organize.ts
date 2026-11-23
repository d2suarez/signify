import { getDb, type Queryable } from "./db";
import type { Block } from "./blocks";
import { videoFromUrl, type DocNode, type PostDoc, DOC_LIMITS } from "./post-doc";
import { createPosts, moderatePost, type Viewer } from "./updates";

/**
 * Organizing a course's material (migration 025).
 *
 * - Order: lessons and assignments share one order inside each unit
 *   (`position`). Items never placed by hand have no position and sort after
 *   the placed ones by date, as the course page always did. Moving one item
 *   numbers the whole unit, so the order on screen is the order kept.
 * - Units: items move to another unit (or out of any unit) together, in the
 *   order chosen, at the end of their new unit.
 * - What students see of a lesson (`student_view`): 'hidden' (only teachers;
 *   every lesson before this), 'list' (in their unit list, opened with a
 *   click at /lessons/<id>), 'thread' (that, and an update in the class's
 *   Updates showing the lesson: its words, pictures, videos and files, with
 *   a link to open it). Published assignments can be shown in Updates too.
 *   The update is the teacher's own post (`thread_post_id`); taking the item
 *   out of the thread deletes that post.
 */

export type StudentView = "hidden" | "list" | "thread";
export const STUDENT_VIEWS: StudentView[] = ["hidden", "list", "thread"];
export type ItemKind = "lesson" | "assignment";
export type ItemKey = `${ItemKind}:${string}`;
export type Place = { position: number | null; studentView: StudentView; threadPostId: string | null };

type Ctx = { tenantId: string; userId: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TABLE = { lesson: "lessons", assignment: "assignments" } as const;

export function parseKey(raw: unknown): { kind: ItemKind; id: string } | null {
  const m = /^(lesson|assignment):([0-9a-f-]{36})$/i.exec(String(raw ?? ""));
  return m && UUID.test(m[2]) ? { kind: m[1].toLowerCase() as ItemKind, id: m[2].toLowerCase() } : null;
}

export const asView = (v: unknown): StudentView | null => (STUDENT_VIEWS.includes(v as StudentView) ? (v as StudentView) : null);

/** Every live lesson's and assignment's place in this course, by "kind:id". */
export async function itemPlaces(ctx: Ctx, courseId: string): Promise<Map<string, Place>> {
  const db = await getDb();
  const rows = await db.query(
    `SELECT 'lesson' AS kind, id, position, student_view, thread_post_id FROM lessons WHERE tenant_id = $1 AND course_id = $2 AND archived = false
     UNION ALL
     SELECT 'assignment', id, position, 'list', thread_post_id FROM assignments WHERE tenant_id = $1 AND course_id = $2 AND archived = false`,
    [ctx.tenantId, courseId],
  );
  return new Map(rows.map((r) => [`${r.kind}:${r.id}`, {
    position: r.position == null ? null : Number(r.position),
    studentView: (asView(r.student_view) ?? "hidden"),
    threadPostId: r.thread_post_id ? String(r.thread_post_id) : null,
  }]));
}

/** A unit's items in the order the course page shows them. */
async function unitItems(q: Queryable, ctx: Ctx, courseId: string, unitId: string | null): Promise<string[]> {
  const rows = await q.query(
    `SELECT kind, id FROM (
       SELECT 'lesson' AS kind, id, unit_id, position, planned_for AS day, created_at FROM lessons WHERE tenant_id = $1 AND course_id = $2 AND archived = false
       UNION ALL
       SELECT 'assignment', id, unit_id, position, due_on, created_at FROM assignments WHERE tenant_id = $1 AND course_id = $2 AND archived = false
     ) x WHERE unit_id IS NOT DISTINCT FROM $3::uuid
     ORDER BY position NULLS LAST, coalesce(day::text, '9999'), created_at, kind DESC, id`,
    [ctx.tenantId, courseId, unitId],
  );
  return rows.map((r) => `${r.kind}:${r.id}`);
}

async function numberUnit(q: Queryable, ctx: Ctx, courseId: string, order: string[]) {
  for (const [i, key] of order.entries()) {
    const k = parseKey(key)!;
    await q.query(`UPDATE ${TABLE[k.kind]} SET position = $4 WHERE tenant_id = $1 AND course_id = $2 AND id = $3`, [ctx.tenantId, courseId, k.id, i]);
  }
}

async function unitOf(q: Queryable, ctx: Ctx, courseId: string, kind: ItemKind, id: string): Promise<{ unitId: string | null } | null> {
  const [r] = await q.query(`SELECT unit_id FROM ${TABLE[kind]} WHERE tenant_id = $1 AND course_id = $2 AND id = $3 AND archived = false`, [ctx.tenantId, courseId, id]);
  return r ? { unitId: r.unit_id ? String(r.unit_id) : null } : null;
}

/** Moves one item up or down inside its unit. */
export async function moveItem(ctx: Ctx, courseId: string, key: unknown, by: -1 | 1): Promise<boolean> {
  const k = parseKey(key);
  if (!k) return false;
  const db = await getDb();
  return db.tx(async (q) => {
    const at = await unitOf(q, ctx, courseId, k.kind, k.id);
    if (!at) return false;
    const order = await unitItems(q, ctx, courseId, at.unitId);
    const i = order.indexOf(`${k.kind}:${k.id}`);
    const j = i + by;
    if (i < 0 || j < 0 || j >= order.length) return false;
    [order[i], order[j]] = [order[j], order[i]];
    await numberUnit(q, ctx, courseId, order);
    return true;
  });
}

/** Moves items (in the order given) to the end of a unit of this course, or out of any unit (null). */
export async function moveItemsToUnit(ctx: Ctx, courseId: string, keys: unknown[], unitId: string | null): Promise<number> {
  const items = keys.map(parseKey).filter((k): k is NonNullable<typeof k> => !!k);
  if (!items.length) return 0;
  const db = await getDb();
  return db.tx(async (q) => {
    if (unitId) {
      const [u] = await q.query("SELECT id FROM units WHERE tenant_id = $1 AND course_id = $2 AND id = $3", [ctx.tenantId, courseId, unitId]);
      if (!u) return 0;
    }
    const moving = new Set(items.map((k) => `${k.kind}:${k.id}`));
    const order = (await unitItems(q, ctx, courseId, unitId)).filter((k) => !moving.has(k));
    let n = 0;
    for (const k of items) {
      const rows = await q.query(
        `UPDATE ${TABLE[k.kind]} SET unit_id = $4 WHERE tenant_id = $1 AND course_id = $2 AND id = $3 AND archived = false RETURNING id`,
        [ctx.tenantId, courseId, k.id, unitId],
      );
      if (rows.length) { order.push(`${k.kind}:${k.id}`); n++; }
    }
    await numberUnit(q, ctx, courseId, order);
    return n;
  });
}

// ---------- what students see, and the class's Updates ----------

/** A lesson as an update's document: its words, pictures, videos and files, then the link to open it. */
export function lessonDoc(lesson: { id: string; title: string; blocks: Block[] }): PostDoc {
  const nodes: DocNode[] = [];
  let embeds = 0;
  const room = () => nodes.length < DOC_LIMITS.nodes - 1;
  const embed = () => embeds < DOC_LIMITS.embeds - 1;
  const para = (text: string, type: "p" | "h" = "p") => { if (text.trim() && room()) nodes.push({ type, content: [{ text }] }); };
  for (const b of lesson.blocks) {
    if (b.type === "text") {
      if (b.title && b.title !== lesson.title) para(b.title, "h");
      for (const chunk of b.body.split(/\n{2,}/)) para(chunk);
    } else if (b.type === "file" && b.fileId) {
      if (b.title && b.title !== b.name && b.title !== lesson.title && b.kind !== "image") para(b.title, "h");
      if (embed() && room()) { nodes.push({ type: "file", fileId: b.fileId, name: b.name, kind: b.kind || "doc", alt: b.alt || b.title }); embeds++; }
    } else if (b.type === "link" && b.url) {
      const v = videoFromUrl(b.url);
      if (v && embed() && room()) {
        if (b.title) para(b.title, "h");
        nodes.push({ type: "video", ...v }); embeds++;
      } else if (room()) nodes.push({ type: "p", content: [{ text: b.title || b.url, href: b.url }] });
    }
  }
  nodes.push({ type: "material", kind: "lesson", id: lesson.id, title: lesson.title });
  return { v: 1, nodes };
}

export function assignmentDoc(a: { id: string; title: string; instructions: string }): PostDoc {
  const nodes: DocNode[] = [];
  for (const chunk of a.instructions.split(/\n{2,}/).slice(0, DOC_LIMITS.nodes - 1)) if (chunk.trim()) nodes.push({ type: "p", content: [{ text: chunk }] });
  nodes.push({ type: "material", kind: "assignment", id: a.id, title: a.title });
  return { v: 1, nodes };
}

async function dropPost(v: Viewer, postId: string | null) {
  if (postId) await moderatePost(v, postId, "delete").catch(() => false);
}

/**
 * Sets what students see of these lessons (ids of this course). 'thread'
 * posts each one to the class's Updates if it isn't there yet; anything
 * else removes its post. Returns how many changed. The viewer must teach the
 * course (the caller checks; posting checks again).
 */
export async function setStudentView(v: Viewer, courseId: string, ids: unknown[], view: StudentView): Promise<number> {
  const want = [...new Set(ids.map(String).filter((x) => UUID.test(x)))];
  if (!want.length) return 0;
  const db = await getDb();
  const rows = await db.query(
    "SELECT id, title, blocks, student_view, thread_post_id FROM lessons WHERE tenant_id = $1 AND course_id = $2 AND id = ANY($3::uuid[]) AND archived = false",
    [v.tenantId, courseId, want],
  );
  let n = 0;
  // In the order asked for (posts made later sit higher in Updates).
  const at = new Map(want.map((id, i) => [id.toLowerCase(), i]));
  rows.sort((x, y) => (at.get(String(x.id)) ?? 0) - (at.get(String(y.id)) ?? 0));
  for (const r of rows) {
    const id = String(r.id);
    let post: string | null = r.thread_post_id ? String(r.thread_post_id) : null;
    if (view === "thread" && !post) {
      const blocks = (typeof r.blocks === "string" ? JSON.parse(r.blocks) : r.blocks) as Block[];
      const [p] = await createPosts(v, { to: [courseId], title: String(r.title), doc: lessonDoc({ id, title: String(r.title), blocks }) });
      post = p.id;
    } else if (view !== "thread" && post) {
      await dropPost(v, post);
      post = null;
    }
    if (r.student_view !== view || String(r.thread_post_id ?? "") !== String(post ?? "")) n++;
    await db.query("UPDATE lessons SET student_view = $3, thread_post_id = $4 WHERE tenant_id = $1 AND id = $2", [v.tenantId, id, view, post]);
  }
  return n;
}

/** Shows published assignments in the class's Updates (on) or takes them out. Drafts are never posted. */
export async function setAssignmentThread(v: Viewer, courseId: string, ids: unknown[], on: boolean): Promise<number> {
  const want = [...new Set(ids.map(String).filter((x) => UUID.test(x)))];
  if (!want.length) return 0;
  const db = await getDb();
  const rows = await db.query(
    "SELECT id, title, instructions, published, thread_post_id FROM assignments WHERE tenant_id = $1 AND course_id = $2 AND id = ANY($3::uuid[]) AND archived = false",
    [v.tenantId, courseId, want],
  );
  let n = 0;
  for (const r of rows) {
    const id = String(r.id);
    let post: string | null = r.thread_post_id ? String(r.thread_post_id) : null;
    if (on && !post && r.published) {
      const [p] = await createPosts(v, { to: [courseId], title: String(r.title), doc: assignmentDoc({ id, title: String(r.title), instructions: String(r.instructions ?? "") }) });
      post = p.id;
      n++;
    } else if (!on && post) {
      await dropPost(v, post);
      post = null;
      n++;
    }
    await db.query("UPDATE assignments SET thread_post_id = $3 WHERE tenant_id = $1 AND id = $2", [v.tenantId, id, post]);
  }
  return n;
}

/** Lessons students may open in this course (shown in their list), in the course's order. */
export async function shownLessons(ctx: Ctx, courseId: string): Promise<{ id: string; title: string; unitId: string | null; position: number | null }[]> {
  const db = await getDb();
  const rows = await db.query(
    `SELECT id, title, unit_id, position FROM lessons
      WHERE tenant_id = $1 AND course_id = $2 AND archived = false AND student_view IN ('list', 'thread')
      ORDER BY position NULLS LAST, planned_for NULLS LAST, created_at`,
    [ctx.tenantId, courseId],
  );
  return rows.map((r) => ({ id: String(r.id), title: String(r.title), unitId: r.unit_id ? String(r.unit_id) : null, position: r.position == null ? null : Number(r.position) }));
}

// ---------- undoing an import ----------

export type ImportRecord = { id: string; fileName: string; createdAt: string; undoneAt: string | null; lessons: number; assignments: number; units: number };

export async function listImports(ctx: Ctx, courseId: string): Promise<ImportRecord[]> {
  const db = await getDb();
  const rows = await db.query(
    `SELECT i.id, i.file_name, i.created_at, i.undone_at,
            (SELECT count(*) FROM lessons l WHERE l.tenant_id = i.tenant_id AND l.import_id = i.id AND l.archived = false) AS lessons,
            (SELECT count(*) FROM assignments a WHERE a.tenant_id = i.tenant_id AND a.import_id = i.id AND a.archived = false) AS assignments,
            (SELECT count(*) FROM units u WHERE u.tenant_id = i.tenant_id AND u.import_id = i.id) AS units
       FROM course_imports i WHERE i.tenant_id = $1 AND i.course_id = $2 ORDER BY i.created_at DESC LIMIT 20`,
    [ctx.tenantId, courseId],
  );
  const iso = (x: unknown) => (x instanceof Date ? x.toISOString() : String(x));
  return rows.map((r) => ({
    id: String(r.id), fileName: String(r.file_name), createdAt: iso(r.created_at), undoneAt: r.undone_at ? iso(r.undone_at) : null,
    lessons: Number(r.lessons), assignments: Number(r.assignments), units: Number(r.units),
  }));
}

/**
 * Takes an import back out: its lessons and assignments are archived (kept,
 * never deleted; their posts in Updates deleted), except assignments that
 * already have students' work or grades, which stay. Its units go when
 * nothing is left in them. Returns what was removed and what was kept.
 */
export async function undoImport(v: Viewer, courseId: string, importId: string): Promise<{ lessons: number; assignments: number; units: number; kept: number } | null> {
  if (!UUID.test(importId)) return null;
  const db = await getDb();
  const [rec] = await db.query("SELECT id FROM course_imports WHERE tenant_id = $1 AND course_id = $2 AND id = $3", [v.tenantId, courseId, importId]);
  if (!rec) return null;
  const posts: string[] = [];
  const out = await db.tx(async (q) => {
    const ls = await q.query(
      "UPDATE lessons SET archived = true, updated_by = $4, updated_at = now() WHERE tenant_id = $1 AND course_id = $2 AND import_id = $3 AND archived = false RETURNING thread_post_id",
      [v.tenantId, courseId, importId, v.userId],
    );
    const busy = await q.query(
      `SELECT a.id FROM assignments a WHERE a.tenant_id = $1 AND a.course_id = $2 AND a.import_id = $3 AND a.archived = false
         AND (EXISTS (SELECT 1 FROM submissions s WHERE s.tenant_id = a.tenant_id AND s.assignment_id = a.id)
           OR EXISTS (SELECT 1 FROM grades g WHERE g.tenant_id = a.tenant_id AND g.assignment_id = a.id))`,
      [v.tenantId, courseId, importId],
    );
    const keep = busy.map((r) => String(r.id));
    const as = await q.query(
      `UPDATE assignments SET archived = true, updated_by = $4, updated_at = now()
        WHERE tenant_id = $1 AND course_id = $2 AND import_id = $3 AND archived = false AND NOT (id = ANY($5::uuid[])) RETURNING thread_post_id`,
      [v.tenantId, courseId, importId, v.userId, keep],
    );
    for (const r of [...ls, ...as]) if (r.thread_post_id) posts.push(String(r.thread_post_id));
    const us = await q.query(
      `DELETE FROM units u WHERE u.tenant_id = $1 AND u.course_id = $2 AND u.import_id = $3
         AND NOT EXISTS (SELECT 1 FROM lessons l WHERE l.unit_id = u.id AND l.archived = false)
         AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.unit_id = u.id AND a.archived = false)
       RETURNING id`,
      [v.tenantId, courseId, importId],
    );
    await q.query("UPDATE course_imports SET undone_at = now() WHERE tenant_id = $1 AND id = $2", [v.tenantId, importId]);
    return { lessons: ls.length, assignments: as.length, units: us.length, kept: keep.length };
  });
  for (const p of posts) await dropPost(v, p);
  return out;
}
