import { getDb, type Queryable, type Row } from "./db";
import { orderTree, subtreeIds } from "./units";
import { type Block, assignmentIdsIn, normalizeBlocks, remapAssignments } from "./blocks";

/**
 * Courses that last and their yearly sections (migration 017).
 *
 * A `courses` row is one Signify ID class, and so one SECTION: its own
 * roster, lessons, assignments, gradebook and updates. A `catalog_courses`
 * row ("Course" on screen) is what lasts from year to year and groups its
 * sections. Nothing is ever copied automatically (Desmond, 2026-11-17):
 *
 * - A teacher copies from any class they teach or taught (`section_teachers`
 *   remembers staff ID listed as teaching it, so a class ID has archived
 *   can still be copied from) into a class they teach now.
 * - From another teacher's class they ASK (`share_requests`); one of that
 *   class's teachers or a school admin answers. A yes lets them copy its
 *   content until it is taken back.
 *
 * Copying takes content only (units, lessons, assignments, quizzes,
 * class resources (hidden from students until the teacher shows them), rubrics, the standards and grade categories they use, outside-tool
 * placements). Never students, submissions, grades or dates: copies are
 * drafts, lessons unscheduled, assignments unpublished with no due date.
 */

export type Ctx = { tenantId: string; userId: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (x: unknown): x is string => typeof x === "string" && UUID.test(x);
export const SECTION_LIMITS = { name: 200, message: 1_000, picks: 500 };

export type SectionSummary = {
  id: string; name: string; subject: string; schoolYear: string; catalogId: string;
  /** Learning has seen this person teach it. */
  mine: boolean;
};

export type CatalogCourse = { id: string; name: string; subject: string; sections: SectionSummary[] };

function toSection(r: Row, mine: boolean): SectionSummary {
  return {
    id: String(r.id), name: String(r.name), subject: String(r.subject ?? ""),
    schoolYear: String(r.school_year ?? ""), catalogId: String(r.catalog_id ?? ""), mine,
  };
}

/** Newest year first, then name. '' (no year said) last. */
export function byYear(a: SectionSummary, b: SectionSummary): number {
  if (a.schoolYear !== b.schoolYear) {
    if (!a.schoolYear) return 1;
    if (!b.schoolYear) return -1;
    return b.schoolYear.localeCompare(a.schoolYear);
  }
  return a.name.localeCompare(b.name);
}

/** Records that this person teaches this section now (Signify ID said so this request). */
export async function noteTeacher(ctx: Ctx, courseId: string): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO section_teachers (tenant_id, course_id, user_id) VALUES ($1, $2, $3)
     ON CONFLICT (course_id, user_id) DO UPDATE SET last_seen = now()`,
    [ctx.tenantId, courseId, ctx.userId],
  );
}

async function taught(q: Queryable, ctx: Ctx, courseId: string): Promise<boolean> {
  const [r] = await q.query("SELECT 1 FROM section_teachers WHERE tenant_id = $1 AND course_id = $2 AND user_id = $3",
    [ctx.tenantId, courseId, ctx.userId]);
  return !!r;
}

/** May this person copy content out of this section: they taught it, or its teachers shared it with them. */
export async function canCopyFrom(ctx: Ctx, sourceId: string, q?: Queryable): Promise<boolean> {
  if (!isId(sourceId)) return false;
  const db = q ?? await getDb();
  if (await taught(db, ctx, sourceId)) return true;
  const [r] = await db.query(
    "SELECT 1 FROM share_requests WHERE tenant_id = $1 AND source_id = $2 AND requested_by = $3 AND status = 'approved'",
    [ctx.tenantId, sourceId, ctx.userId],
  );
  return !!r;
}

/** The section's lasting course and all its sections this person may know about. */
export async function catalogOf(ctx: Ctx, courseId: string): Promise<CatalogCourse | null> {
  if (!isId(courseId)) return null;
  const db = await getDb();
  const [s] = await db.query("SELECT catalog_id FROM courses WHERE tenant_id = $1 AND id = $2", [ctx.tenantId, courseId]);
  if (!s?.catalog_id) return null;
  return getCatalog(ctx, String(s.catalog_id));
}

/**
 * A course with every section in it. Section names and years are not
 * private (they are the school's class list); what is in them is, and that
 * needs canCopyFrom.
 */
export async function getCatalog(ctx: Ctx, catalogId: string): Promise<CatalogCourse | null> {
  if (!isId(catalogId)) return null;
  const db = await getDb();
  const [cat] = await db.query("SELECT * FROM catalog_courses WHERE tenant_id = $1 AND id = $2", [ctx.tenantId, catalogId]);
  if (!cat) return null;
  const rows = await db.query(
    `SELECT c.*, EXISTS (SELECT 1 FROM section_teachers t WHERE t.course_id = c.id AND t.user_id = $3) AS mine
       FROM courses c WHERE c.tenant_id = $1 AND c.catalog_id = $2`,
    [ctx.tenantId, catalogId, ctx.userId],
  );
  return {
    id: String(cat.id), name: String(cat.name), subject: String(cat.subject ?? ""),
    sections: rows.map((r) => toSection(r, !!r.mine)).sort(byYear),
  };
}

/** Courses this person has taught a section of, newest section first inside each. */
export async function myCatalog(ctx: Ctx): Promise<CatalogCourse[]> {
  const db = await getDb();
  const ids = await db.query(
    `SELECT DISTINCT c.catalog_id FROM section_teachers t JOIN courses c ON c.id = t.course_id
      WHERE t.tenant_id = $1 AND t.user_id = $2 AND c.catalog_id IS NOT NULL`,
    [ctx.tenantId, ctx.userId],
  );
  const out: CatalogCourse[] = [];
  for (const r of ids) {
    const c = await getCatalog(ctx, String(r.catalog_id));
    if (c) out.push(c);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Every course at the school, for "put this class in a course". */
export async function schoolCatalog(ctx: Ctx): Promise<{ id: string; name: string; subject: string; sections: number }[]> {
  const db = await getDb();
  const rows = await db.query(
    `SELECT k.id, k.name, k.subject, count(c.id)::int AS n FROM catalog_courses k
       LEFT JOIN courses c ON c.catalog_id = k.id
      WHERE k.tenant_id = $1 GROUP BY k.id ORDER BY k.name, k.id`,
    [ctx.tenantId],
  );
  return rows.map((r) => ({ id: String(r.id), name: String(r.name), subject: String(r.subject ?? ""), sections: Number(r.n) }));
}

/** Renames a course. Anyone who teaches or taught one of its sections, or a school admin. */
export async function renameCatalog(ctx: Ctx & { admin?: boolean }, catalogId: string, name: unknown): Promise<boolean> {
  const clean = String(name ?? "").replace(/\s+/g, " ").trim().slice(0, SECTION_LIMITS.name);
  if (!clean || !isId(catalogId)) return false;
  const db = await getDb();
  if (!ctx.admin) {
    const [r] = await db.query(
      `SELECT 1 FROM section_teachers t JOIN courses c ON c.id = t.course_id
        WHERE t.tenant_id = $1 AND t.user_id = $2 AND c.catalog_id = $3`,
      [ctx.tenantId, ctx.userId, catalogId],
    );
    if (!r) return false;
  }
  const rows = await db.query("UPDATE catalog_courses SET name = $3 WHERE tenant_id = $1 AND id = $2 RETURNING id", [ctx.tenantId, catalogId, clean]);
  return rows.length > 0;
}

/**
 * Puts a section the person teaches NOW (the caller checked with Signify ID)
 * into another course of the school, or a new one of its own ('new'). A
 * course left with no sections is removed. Nothing is copied.
 */
export async function moveSection(ctx: Ctx, sectionId: string, target: string | "new"): Promise<string | null> {
  if (!isId(sectionId)) return null;
  const db = await getDb();
  return db.tx(async (q) => {
    const [s] = await q.query("SELECT * FROM courses WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [ctx.tenantId, sectionId]);
    if (!s) return null;
    let to: string;
    if (target === "new") {
      const [k] = await q.query("INSERT INTO catalog_courses (tenant_id, name, subject, created_by) VALUES ($1, $2, $3, $4) RETURNING id",
        [ctx.tenantId, String(s.name), String(s.subject ?? ""), ctx.userId]);
      to = String(k.id);
    } else {
      if (!isId(target)) return null;
      const [k] = await q.query("SELECT id FROM catalog_courses WHERE tenant_id = $1 AND id = $2", [ctx.tenantId, target]);
      if (!k) return null;
      to = String(k.id);
    }
    const from = s.catalog_id ? String(s.catalog_id) : null;
    await q.query("UPDATE courses SET catalog_id = $3 WHERE tenant_id = $1 AND id = $2", [ctx.tenantId, sectionId, to]);
    if (from && from !== to) {
      await q.query(
        "DELETE FROM catalog_courses k WHERE k.tenant_id = $1 AND k.id = $2 AND NOT EXISTS (SELECT 1 FROM courses c WHERE c.catalog_id = k.id)",
        [ctx.tenantId, from],
      );
    }
    return to;
  });
}

/**
 * A course at the school whose name matches this section's and which holds
 * a section this teacher taught: the likely "same course, new year".
 */
export async function suggestedCatalog(ctx: Ctx, sectionId: string): Promise<{ id: string; name: string } | null> {
  if (!isId(sectionId)) return null;
  const db = await getDb();
  const [r] = await db.query(
    `SELECT k.id, k.name FROM courses me
       JOIN catalog_courses k ON k.tenant_id = me.tenant_id AND k.id <> me.catalog_id AND lower(k.name) = lower(me.name)
      WHERE me.tenant_id = $1 AND me.id = $2
        AND EXISTS (SELECT 1 FROM courses c JOIN section_teachers t ON t.course_id = c.id
                     WHERE c.catalog_id = k.id AND t.user_id = $3)
      LIMIT 1`,
    [ctx.tenantId, sectionId, ctx.userId],
  );
  return r ? { id: String(r.id), name: String(r.name) } : null;
}

// ---------- copying ----------

export type CopySource = SectionSummary & { courseName: string; shared: boolean };

/** Classes this person may copy from into `targetId`: the ones they taught, then the ones shared with them. */
export async function copySources(ctx: Ctx, targetId: string): Promise<CopySource[]> {
  const db = await getDb();
  const rows = await db.query(
    `SELECT c.*, k.name AS course_name,
            NOT EXISTS (SELECT 1 FROM section_teachers t WHERE t.course_id = c.id AND t.user_id = $2) AS shared
       FROM courses c LEFT JOIN catalog_courses k ON k.id = c.catalog_id
      WHERE c.tenant_id = $1 AND c.id <> $3 AND (
        EXISTS (SELECT 1 FROM section_teachers t WHERE t.course_id = c.id AND t.user_id = $2)
        OR EXISTS (SELECT 1 FROM share_requests r WHERE r.source_id = c.id AND r.requested_by = $2 AND r.status = 'approved'))`,
    [ctx.tenantId, ctx.userId, isId(targetId) ? targetId : "00000000-0000-0000-0000-000000000000"],
  );
  return rows
    .map((r) => ({ ...toSection(r, !r.shared), courseName: String(r.course_name ?? r.name), shared: !!r.shared }))
    .sort((a, b) => Number(a.shared) - Number(b.shared) || byYear(a, b));
}

export type SourceContents = {
  units: { id: string; title: string }[];
  lessons: { id: string; title: string; unitId: string | null }[];
  assignments: { id: string; title: string; kind: string; unitId: string | null }[];
  /** Class resources (migration 019). */
  resources: { id: string; title: string; kind: string }[];
};

/** What a class holds, for ticking what to copy. Null when the person may not copy from it. */
export async function sourceContents(ctx: Ctx, sourceId: string): Promise<SourceContents | null> {
  if (!(await canCopyFrom(ctx, sourceId))) return null;
  const db = await getDb();
  const [units, lessons, assignments, resources] = await Promise.all([
    db.query("SELECT id, course_id, title, position, parent_id FROM units WHERE tenant_id = $1 AND course_id = $2 ORDER BY position, created_at", [ctx.tenantId, sourceId]),
    db.query(`SELECT id, title, unit_id FROM lessons WHERE tenant_id = $1 AND course_id = $2 AND archived = false
               ORDER BY planned_for NULLS LAST, created_at`, [ctx.tenantId, sourceId]),
    db.query(`SELECT id, title, kind, unit_id FROM assignments WHERE tenant_id = $1 AND course_id = $2 AND archived = false
               ORDER BY due_on NULLS LAST, created_at`, [ctx.tenantId, sourceId]),
    db.query(`SELECT r.id, r.kind, COALESCE(NULLIF(r.title, ''), l.title, '') AS title FROM class_resources r
               LEFT JOIN lessons l ON l.id = r.lesson_id
               WHERE r.tenant_id = $1 AND r.course_id = $2 AND r.archived = false ORDER BY r.position, r.created_at`, [ctx.tenantId, sourceId]),
  ]);
  return {
    // Folders in tree order, each named by its path ("Unit 3 › Chapter 7").
    units: orderTree(units.map(unitRow)).map((u) => ({ id: u.id, title: u.path })),
    lessons: lessons.map((l) => ({ id: String(l.id), title: String(l.title), unitId: l.unit_id ? String(l.unit_id) : null })),
    assignments: assignments.map((a) => ({ id: String(a.id), title: String(a.title), kind: String(a.kind), unitId: a.unit_id ? String(a.unit_id) : null })),
    resources: resources.map((r) => ({ id: String(r.id), title: String(r.title), kind: String(r.kind) })),
  };
}

export type CopyPicks = { units?: unknown; lessons?: unknown; assignments?: unknown; resources?: unknown };
export type CopyResult = { units: number; lessons: number; assignments: number; resources: number; standards: number; categories: number; tools: number };
export class CopyError extends Error {}

const ids = (x: unknown): string[] => (Array.isArray(x) ? [...new Set(x.filter(isId).map((s) => s.toLowerCase()))].slice(0, SECTION_LIMITS.picks) : []);

/** Every uuid in a JSON value that is a key of `map`, swapped (uuids are unique, so text replacement is exact). */
function remap<T>(value: T, map: Map<string, string>): T {
  if (value == null || map.size === 0) return value;
  let s = JSON.stringify(value);
  for (const [from, to] of map) s = s.split(from).join(to);
  return JSON.parse(s) as T;
}

function blocksOf(v: unknown): Block[] {
  try { return normalizeBlocks(typeof v === "string" ? JSON.parse(v) : v ?? []); } catch { return []; }
}

function uuidsIn(value: unknown): string[] {
  if (value == null) return [];
  return [...new Set((JSON.stringify(value).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || []).map((s) => s.toLowerCase()))];
}

/**
 * Copies the picked units (each with all its lessons and assignments) and
 * single lessons and assignments from `sourceId` into `targetId`, in ONE
 * transaction. The caller has checked with Signify ID that the person
 * teaches `targetId` now; this checks they may copy from `sourceId`.
 */
export async function copyContent(ctx: Ctx, sourceId: string, targetId: string, picks: CopyPicks): Promise<CopyResult> {
  if (!isId(sourceId) || !isId(targetId) || sourceId === targetId) throw new CopyError("bad");
  const pickUnits = ids(picks.units), pickAssignments = ids(picks.assignments), pickResources = ids(picks.resources);
  let pickLessons = ids(picks.lessons);
  if (!pickUnits.length && !pickLessons.length && !pickAssignments.length && !pickResources.length) throw new CopyError("nothing");
  const db = await getDb();
  return db.tx(async (q) => {
    const T = ctx.tenantId;
    if (!(await canCopyFrom(ctx, sourceId, q))) throw new CopyError("forbidden");
    const [target] = await q.query("SELECT id, kind FROM courses WHERE tenant_id = $1 AND id = $2", [T, targetId]);
    if (!target) throw new CopyError("forbidden");
    // A club has no academics: assignments stay behind.
    const club = target.kind === "club";

    // A resource that points at a lesson brings the lesson with it.
    const resources = pickResources.length
      ? await q.query("SELECT * FROM class_resources WHERE tenant_id = $1 AND course_id = $2 AND archived = false AND id = ANY($3::uuid[]) ORDER BY position, created_at",
        [T, sourceId, pickResources])
      : [];
    pickLessons = [...new Set([...pickLessons, ...resources.filter((r) => r.lesson_id).map((r) => String(r.lesson_id))])];

    // A picked folder brings every folder inside it; parents come before their folders (tree order).
    const tree = pickUnits.length
      ? orderTree((await q.query("SELECT * FROM units WHERE tenant_id = $1 AND course_id = $2 ORDER BY position, created_at", [T, sourceId])).map(unitRow))
      : [];
    const picked = new Set<string>();
    for (const id of pickUnits) if (tree.some((u) => u.id === id)) for (const x of subtreeIds(tree, id)) picked.add(x);
    const units = tree.filter((u) => picked.has(u.id));
    const unitIds = units.map((u) => u.id);
    // A copied folder brings the materials in it (migration 027), and the lessons they point at.
    if (unitIds.length) {
      const have = new Set(resources.map((r) => String(r.id)));
      const inFolders = await q.query(
        "SELECT * FROM class_resources WHERE tenant_id = $1 AND course_id = $2 AND archived = false AND unit_id = ANY($3::uuid[]) ORDER BY position, created_at",
        [T, sourceId, unitIds]);
      for (const r of inFolders) if (!have.has(String(r.id))) resources.push(r);
      pickLessons = [...new Set([...pickLessons, ...inFolders.filter((r) => r.lesson_id).map((r) => String(r.lesson_id))])];
    }
    const lessons = await q.query(
      `SELECT * FROM lessons WHERE tenant_id = $1 AND course_id = $2 AND archived = false
         AND (id = ANY($3::uuid[]) OR unit_id = ANY($4::uuid[])) ORDER BY planned_for NULLS LAST, created_at`,
      [T, sourceId, pickLessons, unitIds],
    );
    const assignments = club ? [] : await q.query(
      `SELECT * FROM assignments WHERE tenant_id = $1 AND course_id = $2 AND archived = false
         AND (id = ANY($3::uuid[]) OR unit_id = ANY($4::uuid[])) ORDER BY due_on NULLS LAST, created_at`,
      // A lesson's assignment slides bring their assignments with it.
      [T, sourceId, [...new Set([...pickAssignments, ...lessons.flatMap((l) => assignmentIdsIn(blocksOf(l.blocks)))])], unitIds],
    );

    // Units: picked ones are copied after the target's own. A single item
    // from a unit that isn't copied goes into the target's unit of the same
    // title, else "no unit".
    const unitMap = new Map<string, string>();
    const [{ next }] = await q.query("SELECT COALESCE(max(position) + 1, 0)::int AS next FROM units WHERE tenant_id = $1 AND course_id = $2", [T, targetId]);
    let top = Number(next);
    for (const u of units) {
      // Inside a folder that is copied too: same place in it. Otherwise a new unit after the target's own.
      const parent = u.parentId ? unitMap.get(u.parentId) ?? null : null;
      const [n] = await q.query("INSERT INTO units (tenant_id, course_id, title, position, parent_id) VALUES ($1, $2, $3, $4, $5) RETURNING id",
        [T, targetId, u.title, parent ? u.position : top++, parent]);
      unitMap.set(u.id, String(n.id));
    }
    const strays = [...new Set([...lessons, ...assignments].map((r) => r.unit_id).filter((u) => u && !unitMap.has(String(u))).map(String))];
    if (strays.length) {
      const rows = await q.query(
        `SELECT s.id AS from_id, t.id AS to_id FROM units s
           JOIN LATERAL (SELECT id FROM units t WHERE t.tenant_id = $1 AND t.course_id = $2 AND lower(t.title) = lower(s.title)
                          ORDER BY position LIMIT 1) t ON true
          WHERE s.tenant_id = $1 AND s.id = ANY($3::uuid[])`,
        [T, targetId, strays],
      );
      for (const r of rows) unitMap.set(String(r.from_id), String(r.to_id));
    }
    const unitFor = (u: unknown) => (u ? unitMap.get(String(u)) ?? null : null);

    // Standards the copied work names, matched to the target's by library
    // item, else by code; a missing one is added to the target.
    const sourceStandards = await q.query("SELECT * FROM standards WHERE tenant_id = $1 AND course_id = $2", [T, sourceId]);
    const named = new Set([
      ...lessons.flatMap((l) => uuidsIn(l.standards)),
      ...resources.flatMap((r) => uuidsIn(r.block)),
      ...assignments.flatMap((a) => [...uuidsIn(a.standards), ...uuidsIn(a.rubric), ...uuidsIn(a.quiz)]),
    ]);
    const stdMap = new Map<string, string>();
    let standardsAdded = 0;
    if (named.size) {
      const targetStandards = await q.query("SELECT * FROM standards WHERE tenant_id = $1 AND course_id = $2 AND archived = false", [T, targetId]);
      const [{ pos }] = await q.query("SELECT COALESCE(max(position) + 1, 0)::int AS pos FROM standards WHERE tenant_id = $1 AND course_id = $2", [T, targetId]);
      let p = Number(pos);
      for (const s of sourceStandards) {
        const sid = String(s.id);
        if (!named.has(sid)) continue;
        const same = targetStandards.find((t) => (s.item_id && t.item_id === s.item_id))
          ?? targetStandards.find((t) => String(t.code).toLowerCase() === String(s.code).toLowerCase());
        if (same) { stdMap.set(sid, String(same.id)); continue; }
        const [n] = await q.query(
          `INSERT INTO standards (tenant_id, course_id, code, description, external_id, item_id, position)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [T, targetId, s.code, s.description, s.external_id ?? null, s.item_id ?? null, p++],
        );
        stdMap.set(sid, String(n.id));
        standardsAdded++;
      }
    }

    // Grade categories by name; a missing one is added with its weight.
    const catMap = new Map<string, string>();
    let categoriesAdded = 0;
    const usedCats = [...new Set(assignments.map((a) => a.category_id).filter(Boolean).map(String))];
    if (usedCats.length) {
      const src = await q.query("SELECT * FROM grade_categories WHERE tenant_id = $1 AND course_id = $2 AND id = ANY($3::uuid[])", [T, sourceId, usedCats]);
      const tgt = await q.query("SELECT * FROM grade_categories WHERE tenant_id = $1 AND course_id = $2", [T, targetId]);
      let p = tgt.reduce((m, r) => Math.max(m, Number(r.position) + 1), 0);
      for (const c of src) {
        const same = tgt.find((t) => String(t.name).toLowerCase() === String(c.name).toLowerCase());
        if (same) { catMap.set(String(c.id), String(same.id)); continue; }
        const [n] = await q.query(
          "INSERT INTO grade_categories (tenant_id, course_id, name, weight, position, drop_lowest) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
          [T, targetId, c.name, c.weight, p++, c.drop_lowest ?? 0],
        );
        catMap.set(String(c.id), String(n.id));
        categoriesAdded++;
      }
    }

    // Outside-tool placements belong to a course: each copied lesson or
    // assignment gets its own copy of the placements it uses.
    const links = await q.query("SELECT * FROM lti_tool_links WHERE tenant_id = $1 AND course_id = $2", [T, sourceId]);
    let tools = 0;
    const copyLink = async (link: Row, lessonId: string | null, assignmentId: string | null): Promise<string> => {
      const [n] = await q.query(
        `INSERT INTO lti_tool_links (tenant_id, tool_id, course_id, lesson_id, assignment_id, title, url, custom, line_item, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10) RETURNING id`,
        [T, link.tool_id, targetId, lessonId, assignmentId, link.title, link.url, JSON.stringify(link.custom ?? {}),
          link.line_item == null ? null : JSON.stringify(link.line_item), ctx.userId],
      );
      tools++;
      return String(n.id);
    };

    // Assignments before lessons, so a lesson's assignment slides can point at the copies.
    const assignmentMap = new Map<string, string>();
    for (const a of assignments) {
      const [n] = await q.query(
        `INSERT INTO assignments (tenant_id, course_id, unit_id, category_id, title, instructions, kind, points,
                                  rubric, quiz, standards, published, grades_released, created_by, updated_by, instructions_doc, hand_in)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, false, false, $12, $12, $13::jsonb, $14) RETURNING id`,
        [T, targetId, unitFor(a.unit_id), a.category_id ? catMap.get(String(a.category_id)) ?? null : null,
          a.title, a.instructions, a.kind, a.points,
          a.rubric == null ? null : JSON.stringify(remap(a.rubric, stdMap)),
          a.quiz == null ? null : JSON.stringify(remap(a.quiz, stdMap)),
          a.standards == null ? null : JSON.stringify(remap(a.standards, stdMap)), ctx.userId,
          a.instructions_doc == null ? null : typeof a.instructions_doc === "string" ? a.instructions_doc : JSON.stringify(a.instructions_doc), a.hand_in ?? "text"],
      );
      assignmentMap.set(String(a.id), String(n.id));
      // Answer keys and grading materials (migration 035) come along, still teacher-only.
      await q.query(
        `INSERT INTO grading_materials (tenant_id, assignment_id, role, title, file_id, url, position, created_by)
         SELECT tenant_id, $3, role, title, file_id, url, position, $4 FROM grading_materials WHERE tenant_id = $1 AND assignment_id = $2`,
        [T, String(a.id), String(n.id), ctx.userId]);
      for (const link of links.filter((k) => String(k.assignment_id) === String(a.id))) await copyLink(link, null, String(n.id));
    }

    const lessonMap = new Map<string, string>();
    for (const l of lessons) {
      const [n] = await q.query(
        `INSERT INTO lessons (tenant_id, course_id, title, duration_min, blocks, unit_id, standards, created_by, updated_by)
         VALUES ($1, $2, $3, $4, '[]'::jsonb, $5, $6::jsonb, $7, $7) RETURNING id`,
        [T, targetId, l.title, l.duration_min, unitFor(l.unit_id),
          l.standards == null ? null : JSON.stringify(remap(l.standards, stdMap)), ctx.userId],
      );
      const newId = String(n.id);
      lessonMap.set(String(l.id), newId);
      const linkMap = new Map<string, string>();
      for (const linkId of uuidsIn(l.blocks)) {
        const link = links.find((k) => String(k.id) === linkId);
        if (link) linkMap.set(linkId, await copyLink(link, newId, null));
      }
      await q.query("UPDATE lessons SET blocks = $3::jsonb WHERE tenant_id = $1 AND id = $2",
        [T, newId, JSON.stringify(remapAssignments(remap(blocksOf(l.blocks), linkMap), assignmentMap))]);
    }

    const [{ rpos }] = await q.query("SELECT COALESCE(max(position) + 1, 0)::int AS rpos FROM class_resources WHERE tenant_id = $1 AND course_id = $2", [T, targetId]);
    for (const [i, r] of resources.entries()) {
      let block = r.block;
      if (block != null) {
        const linkMap = new Map<string, string>();
        for (const linkId of uuidsIn(block)) {
          const link = links.find((k) => String(k.id) === linkId);
          if (link) linkMap.set(linkId, await copyLink(link, null, null));
        }
        block = remap(remap(block, linkMap), stdMap);
      }
      await q.query(
        `INSERT INTO class_resources (tenant_id, course_id, kind, title, note, block, lesson_id, visible, position, created_by, updated_by, unit_id, unit_position)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, false, $8, $9, $9, $10, $11)`,
        [T, targetId, r.kind, r.title, r.note, block == null ? null : JSON.stringify(block),
          r.lesson_id ? lessonMap.get(String(r.lesson_id)) ?? null : null, Number(rpos) + i, ctx.userId,
          unitFor(r.unit_id), unitFor(r.unit_id) ? r.unit_position ?? null : null],
      );
    }

    const result: CopyResult = {
      units: units.length, lessons: lessons.length, assignments: assignments.length, resources: resources.length,
      standards: standardsAdded, categories: categoriesAdded, tools,
    };
    await q.query("INSERT INTO content_copies (tenant_id, from_course, to_course, copied_by, counts) VALUES ($1, $2, $3, $4, $5::jsonb)",
      [T, sourceId, targetId, ctx.userId, JSON.stringify(result)]);
    return result;
  });
}

// ---------- asking another teacher to share ----------

export type ShareStatus = "pending" | "approved" | "declined" | "withdrawn" | "revoked";
export type ShareRequest = {
  id: string; sourceId: string; sourceName: string; sourceYear: string;
  requestedBy: string; requestedName: string; forCourseId: string | null; forCourseName: string;
  message: string; status: ShareStatus; createdAt: string; decidedAt: string | null;
};

function toRequest(r: Row): ShareRequest {
  return {
    id: String(r.id), sourceId: String(r.source_id), sourceName: String(r.source_name ?? ""), sourceYear: String(r.source_year ?? ""),
    requestedBy: String(r.requested_by), requestedName: String(r.requested_name ?? ""), forCourseId: r.for_course_id ? String(r.for_course_id) : null,
    forCourseName: String(r.for_name ?? ""), message: String(r.message ?? ""), status: r.status as ShareStatus,
    createdAt: new Date(r.created_at as string).toISOString(),
    decidedAt: r.decided_at ? new Date(r.decided_at as string).toISOString() : null,
  };
}

const REQUEST_SELECT = `SELECT r.*, s.name AS source_name, s.school_year AS source_year, f.name AS for_name
  FROM share_requests r JOIN courses s ON s.id = r.source_id LEFT JOIN courses f ON f.id = r.for_course_id`;

/** Other teachers' classes at the school this person could ask for (not ones they taught or already may copy). */
export async function askableSections(ctx: Ctx): Promise<(SectionSummary & { courseName: string; asked: boolean })[]> {
  const db = await getDb();
  const rows = await db.query(
    `SELECT c.*, k.name AS course_name,
            EXISTS (SELECT 1 FROM share_requests r WHERE r.source_id = c.id AND r.requested_by = $2 AND r.status = 'pending') AS asked
       FROM courses c LEFT JOIN catalog_courses k ON k.id = c.catalog_id
      WHERE c.tenant_id = $1
        AND NOT EXISTS (SELECT 1 FROM section_teachers t WHERE t.course_id = c.id AND t.user_id = $2)
        AND NOT EXISTS (SELECT 1 FROM share_requests r WHERE r.source_id = c.id AND r.requested_by = $2 AND r.status = 'approved')
        AND EXISTS (SELECT 1 FROM section_teachers t WHERE t.course_id = c.id)`,
    [ctx.tenantId, ctx.userId],
  );
  return rows.map((r) => ({ ...toSection(r, false), courseName: String(r.course_name ?? r.name), asked: !!r.asked }))
    .sort((a, b) => a.courseName.localeCompare(b.courseName) || byYear(a, b));
}

export async function requestShare(ctx: Ctx & { name?: string }, sourceId: string, input: { forCourseId?: unknown; message?: unknown }): Promise<ShareRequest | null> {
  if (!isId(sourceId)) return null;
  const db = await getDb();
  const [src] = await db.query("SELECT id FROM courses WHERE tenant_id = $1 AND id = $2", [ctx.tenantId, sourceId]);
  if (!src || (await canCopyFrom(ctx, sourceId))) return null;
  const forId = isId(input.forCourseId) && (await taught(db, ctx, input.forCourseId)) ? input.forCourseId : null;
  const message = String(input.message ?? "").replace(/\r\n/g, "\n").trim().slice(0, SECTION_LIMITS.message);
  const rows = await db.query(
    `INSERT INTO share_requests (tenant_id, source_id, requested_by, requested_name, for_course_id, message)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING id`,
    [ctx.tenantId, sourceId, ctx.userId, String(ctx.name ?? "").slice(0, 200), forId, message],
  );
  if (!rows[0]) return null;
  const [r] = await db.query(`${REQUEST_SELECT} WHERE r.id = $1`, [rows[0].id]);
  return toRequest(r);
}

/** Requests waiting on this person: for classes they teach or taught, or every one at the school for an admin. */
export async function requestsToAnswer(ctx: Ctx & { admin?: boolean }): Promise<ShareRequest[]> {
  const db = await getDb();
  const rows = await db.query(
    `${REQUEST_SELECT} WHERE r.tenant_id = $1 AND r.status = 'pending' AND r.requested_by <> $2
       AND ($3 OR EXISTS (SELECT 1 FROM section_teachers t WHERE t.course_id = r.source_id AND t.user_id = $2))
     ORDER BY r.created_at`,
    [ctx.tenantId, ctx.userId, !!ctx.admin],
  );
  return rows.map(toRequest);
}

/** Shares this person said yes to or still holds open on their classes (to take back), and an admin's for the school. */
export async function grantedShares(ctx: Ctx & { admin?: boolean }): Promise<ShareRequest[]> {
  const db = await getDb();
  const rows = await db.query(
    `${REQUEST_SELECT} WHERE r.tenant_id = $1 AND r.status = 'approved'
       AND ($3 OR EXISTS (SELECT 1 FROM section_teachers t WHERE t.course_id = r.source_id AND t.user_id = $2))
     ORDER BY r.decided_at DESC`,
    [ctx.tenantId, ctx.userId, !!ctx.admin],
  );
  return rows.map(toRequest);
}

export async function myRequests(ctx: Ctx): Promise<ShareRequest[]> {
  const db = await getDb();
  const rows = await db.query(`${REQUEST_SELECT} WHERE r.tenant_id = $1 AND r.requested_by = $2 ORDER BY r.created_at DESC LIMIT 50`,
    [ctx.tenantId, ctx.userId]);
  return rows.map(toRequest);
}

/**
 * Answers a request: 'approve' / 'decline' (pending only) or 'revoke' (an
 * approved one), by a teacher of the source class or a school admin; the
 * asker may 'withdraw' their own pending one. Nobody answers their own.
 */
export async function answerShare(ctx: Ctx & { admin?: boolean }, requestId: string, op: "approve" | "decline" | "revoke" | "withdraw"): Promise<boolean> {
  if (!isId(requestId)) return false;
  const db = await getDb();
  return db.tx(async (q) => {
    const [r] = await q.query("SELECT * FROM share_requests WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [ctx.tenantId, requestId]);
    if (!r) return false;
    const own = r.requested_by === ctx.userId;
    let status: ShareStatus;
    if (op === "withdraw") {
      if (!own || r.status !== "pending") return false;
      status = "withdrawn";
    } else {
      if (own) return false;
      if (!ctx.admin && !(await taught(q, ctx, String(r.source_id)))) return false;
      if (op === "revoke") { if (r.status !== "approved") return false; status = "revoked"; }
      else { if (r.status !== "pending") return false; status = op === "approve" ? "approved" : "declined"; }
    }
    await q.query("UPDATE share_requests SET status = $3, decided_by = $4, decided_at = now() WHERE tenant_id = $1 AND id = $2",
      [ctx.tenantId, requestId, status, ctx.userId]);
    return true;
  });
}

function unitRow(r: Record<string, unknown>) {
  return { id: String(r.id), courseId: String(r.course_id), title: String(r.title), position: Number(r.position), parentId: r.parent_id ? String(r.parent_id) : null };
}
