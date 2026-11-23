import { getDb } from "./db";
import { type Block, type BlockType, forStudent, newId, normalizeBlocks, LIMITS } from "./blocks";
import { getLesson } from "./lessons";
import type { CourseRole } from "./courses";
import { fileInSchool } from "./files";
import { unitInCourse } from "./units";
import { moveItemsToUnit } from "./organize";

/**
 * Class resources: a teacher's library for one course (= one Signify ID
 * class, a section; clubs are courses too). A resource is ONE lesson block,
 * stored exactly as lessons store it (so it goes into a lesson with no
 * conversion), or a pointer to one of the course's own lessons (a slide set
 * that's already made).
 *
 * Adding a resource to a lesson copies its block(s) in with new ids
 * (`resourceBlocks`); the resource never changes and the lesson never points
 * back. Students see only resources a teacher marked visible, and only the
 * kinds a student can use on their own (text, link, board, file). Every write needs
 * the course's teacher role, re-derived from Signify ID by the caller.
 */

export type Resource = {
  id: string;
  courseId: string;
  kind: "block" | "lesson";
  title: string;
  note: string;
  block: Block | null;
  lessonId: string | null;
  /** The pointed-at lesson's title and size, when it still exists (teachers only). */
  lesson: { title: string; blockCount: number } | null;
  visible: boolean;
  position: number;
  /** The unit or folder it sits in (migration 027), null = only in the Resources list. */
  unitId: string | null;
  archived: boolean;
  updatedAt: string;
};

type Ctx = { tenantId: string; userId: string };
/** Who is asking, with their role in this course now (from courseAccess). */
export type Who = Ctx & { role: CourseRole };

export class ResourceError extends Error {}

export const RESOURCE_LIMITS = { title: 200, note: 1_000, perCourse: 300 };
/** What a student may be shown. Polls carry answer keys; Desk tools and outside tools only make sense live. */
export const STUDENT_KINDS: BlockType[] = ["text", "link", "board", "file"];
/** What a teacher can make on the resources page (tools come from a lesson's block, "Save to class resources"). */
export const RESOURCE_BLOCK_TYPES: BlockType[] = ["link", "board", "file", "text", "timer", "picker", "noise", "poll"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function line(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}
function para(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\r\n/g, "\n").trim().slice(0, max) : "";
}

function teacherOnly(who: Who) {
  if (who.role !== "teacher") throw new ResourceError("Only the course's teachers can change its resources.");
}

/** A resource's one block, through the same door as every lesson block. Null if it isn't one. */
export function normalizeResourceBlock(input: unknown): Block | null {
  const [b] = normalizeBlocks(Array.isArray(input) ? input.slice(0, 1) : [input]);
  // An assignment is a material of its own, and groups belong to one lesson's class: never a resource's block.
  return b && b.type !== "assignment" && b.type !== "groups" ? b : null;
}

/** Whether students may ever see this resource. */
export function studentCanSee(r: Pick<Resource, "kind" | "block">): boolean {
  return r.kind === "block" && !!r.block && STUDENT_KINDS.includes(r.block.type);
}

/** The title shown in lists: the teacher's, else the block's own words. */
export function defaultTitle(b: Block): string {
  switch (b.type) {
    case "text": return b.title || b.body.split("\n")[0].slice(0, 80);
    case "poll": return b.question.split("\n")[0].slice(0, 80);
    case "timer": case "picker": case "noise": return b.label;
    case "board": case "link": case "tool": case "assignment": case "groups": case "seating": return b.title;
    case "file": return b.title || b.name;
  }
}

/**
 * The blocks a resource becomes in a lesson: a copy with fresh ids, so the
 * same resource can be added twice and live answers never mix. A lesson
 * resource gives that lesson's blocks as they are now.
 */
export function resourceBlocks(r: Pick<Resource, "kind" | "block">, lessonBlocks?: Block[] | null): Block[] {
  const src = r.kind === "block" ? (r.block ? [r.block] : []) : lessonBlocks ?? [];
  return normalizeBlocks(src.slice(0, LIMITS.blocks).map((b) => ({ ...b, id: newId() })));
}

function toResource(r: Record<string, unknown>): Resource {
  const block = r.block ? (typeof r.block === "string" ? JSON.parse(r.block) : r.block) as Block : null;
  return {
    id: String(r.id),
    courseId: String(r.course_id),
    kind: r.kind === "lesson" ? "lesson" : "block",
    title: String(r.title),
    note: String(r.note),
    block,
    lessonId: r.lesson_id ? String(r.lesson_id) : null,
    lesson: r.lesson_title != null ? { title: String(r.lesson_title), blockCount: Number(r.lesson_n) } : null,
    visible: r.visible === true,
    position: Number(r.position),
    unitId: r.unit_id ? String(r.unit_id) : null,
    archived: r.archived === true,
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

const SELECT = `SELECT r.*, l.title AS lesson_title, jsonb_array_length(l.blocks) AS lesson_n
  FROM class_resources r
  LEFT JOIN lessons l ON l.id = r.lesson_id AND l.tenant_id = r.tenant_id AND l.archived = false`;

/**
 * A course's resources in the teacher's order. A teacher gets everything
 * (archived too when asked); anyone else only visible text/link/board/file
 * resources, with nothing a student shouldn't receive.
 */
export async function listResources(who: Who, courseId: string, opts: { archived?: boolean } = {}): Promise<Resource[]> {
  if (!UUID.test(courseId)) return [];
  const db = await getDb();
  const teacher = who.role === "teacher";
  const rows = await db.query(
    `${SELECT} WHERE r.tenant_id = $1 AND r.course_id = $2 AND r.archived = $3
       ${teacher ? "" : "AND r.visible = true AND r.kind = 'block'"}
     ORDER BY r.position, r.created_at`,
    [who.tenantId, courseId, teacher && opts.archived === true],
  );
  const list = rows.map(toResource);
  if (teacher) return list;
  return list.filter(studentCanSee).map((r) => ({ ...r, block: r.block && forStudent(r.block), lesson: null, lessonId: null }));
}

/** One resource of this course; null if it is another course's or school's, archived, or hidden from this person. */
export async function getResource(who: Who, courseId: string, id: string): Promise<Resource | null> {
  if (!UUID.test(id) || !UUID.test(courseId)) return null;
  const db = await getDb();
  const rows = await db.query(`${SELECT} WHERE r.tenant_id = $1 AND r.course_id = $2 AND r.id = $3`, [who.tenantId, courseId, id]);
  const r = rows[0] ? toResource(rows[0]) : null;
  if (!r) return null;
  if (who.role === "teacher") return r;
  return !r.archived && r.visible && studentCanSee(r) ? { ...r, block: r.block && forStudent(r.block), lesson: null, lessonId: null } : null;
}

export type ResourceInput = {
  /** One block (any lesson block type), or a lesson of this course. */
  block?: unknown;
  lessonId?: unknown;
  title?: unknown;
  note?: unknown;
  visible?: unknown;
  /** A unit or folder of this course to put it in, at the end (creating only). */
  unitId?: unknown;
};

/**
 * Checks a block against this course: an outside-tool block keeps its
 * placement only if that placement is in this course of this school.
 */
async function courseBlock(who: Who, courseId: string, raw: unknown): Promise<Block> {
  const b = normalizeResourceBlock(raw);
  if (!b) throw new ResourceError("That isn't something a lesson can hold.");
  if (b.type === "tool" && b.linkId) {
    const db = await getDb();
    const ok = await db.query("SELECT 1 FROM lti_tool_links WHERE tenant_id = $1 AND course_id = $2 AND id = $3", [who.tenantId, courseId, b.linkId]);
    if (!ok.length) b.linkId = "";
  }
  if (b.type === "file" && b.fileId && !(await fileInSchool(who.tenantId, b.fileId))) {
    Object.assign(b, { fileId: "", name: "", kind: "" });
  }
  return b;
}

export async function createResource(who: Who, courseId: string, input: ResourceInput): Promise<Resource> {
  teacherOnly(who);
  const db = await getDb();
  const count = await db.query("SELECT count(*)::int AS n FROM class_resources WHERE tenant_id = $1 AND course_id = $2 AND archived = false", [who.tenantId, courseId]);
  if (Number(count[0].n) >= RESOURCE_LIMITS.perCourse) throw new ResourceError(`A class can keep at most ${RESOURCE_LIMITS.perCourse} resources.`);

  let block: Block | null = null;
  let lessonId: string | null = null;
  let title = line(input.title, RESOURCE_LIMITS.title);
  if (input.lessonId != null && input.lessonId !== "") {
    const lesson = typeof input.lessonId === "string" ? await getLesson(who, input.lessonId) : null;
    if (!lesson || lesson.courseId !== courseId) throw new ResourceError("That lesson isn't in this class.");
    lessonId = lesson.id;
    title ||= lesson.title;
  } else {
    block = await courseBlock(who, courseId, input.block);
    title ||= defaultTitle(block);
  }
  const visible = input.visible === true && block !== null && STUDENT_KINDS.includes(block.type);
  const unitId = input.unitId ? await unitInCourse(who, courseId, input.unitId) : null;
  if (input.unitId && !unitId) throw new ResourceError("That folder isn't in this class.");
  const rows = await db.query(
    `INSERT INTO class_resources (tenant_id, course_id, kind, title, note, block, lesson_id, visible, position, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8,
       (SELECT coalesce(max(position), -1) + 1 FROM class_resources WHERE tenant_id = $1 AND course_id = $2), $9, $9)
     RETURNING id`,
    [who.tenantId, courseId, lessonId ? "lesson" : "block", title || "Untitled", para(input.note, RESOURCE_LIMITS.note),
      block ? JSON.stringify(block) : null, lessonId, visible, who.userId],
  );
  // Into its folder at the end of what's shown there: the folder is numbered as a whole (organize.ts), so items never placed by hand keep their places.
  if (unitId) await moveItemsToUnit(who, courseId, [`resource:${rows[0].id}`], unitId);
  return (await getResource(who, courseId, String(rows[0].id)))!;
}

/** Changes title, note, visibility and (for a block resource) the block. A lesson pointer stays the same lesson. */
export async function updateResource(who: Who, courseId: string, id: string, input: ResourceInput): Promise<Resource | null> {
  teacherOnly(who);
  const current = await getResource(who, courseId, id);
  if (!current) return null;
  const block = current.kind === "block" && input.block !== undefined ? await courseBlock(who, courseId, input.block) : current.block;
  const title = input.title === undefined ? current.title : line(input.title, RESOURCE_LIMITS.title) || (block ? defaultTitle(block) : current.lesson?.title ?? "") || "Untitled";
  const note = input.note === undefined ? current.note : para(input.note, RESOURCE_LIMITS.note);
  const wantVisible = input.visible === undefined ? current.visible : input.visible === true;
  const visible = wantVisible && studentCanSee({ kind: current.kind, block });
  const db = await getDb();
  await db.query(
    `UPDATE class_resources SET title = $4, note = $5, block = $6::jsonb, visible = $7, updated_by = $8, updated_at = now()
      WHERE tenant_id = $1 AND course_id = $2 AND id = $3`,
    [who.tenantId, courseId, id, title, note, block ? JSON.stringify(block) : null, visible, who.userId],
  );
  return getResource(who, courseId, id);
}

/** Archive or bring back. Archived resources keep their place and can be brought back. */
export async function archiveResource(who: Who, courseId: string, id: string, archived = true): Promise<boolean> {
  teacherOnly(who);
  if (!UUID.test(id)) return false;
  const db = await getDb();
  const rows = await db.query(
    "UPDATE class_resources SET archived = $4, updated_by = $5, updated_at = now() WHERE tenant_id = $1 AND course_id = $2 AND id = $3 RETURNING id",
    [who.tenantId, courseId, id, archived, who.userId],
  );
  return rows.length > 0;
}

/** Moves a resource one place up (-1) or down (+1) among the course's live resources. */
export async function moveResource(who: Who, courseId: string, id: string, by: -1 | 1): Promise<boolean> {
  teacherOnly(who);
  const db = await getDb();
  return db.tx(async (t) => {
    const rows = await t.query(
      "SELECT id FROM class_resources WHERE tenant_id = $1 AND course_id = $2 AND archived = false ORDER BY position, created_at FOR UPDATE",
      [who.tenantId, courseId],
    );
    const ids = rows.map((r) => String(r.id));
    const i = ids.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= ids.length) return false;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    for (let k = 0; k < ids.length; k++) {
      await t.query("UPDATE class_resources SET position = $3 WHERE tenant_id = $1 AND id = $2", [who.tenantId, ids[k], k]);
    }
    return true;
  });
}

/**
 * The blocks for a list of this course's resources, in the order given
 * (unknown, archived and other courses' ids are skipped). Teachers only:
 * this is what goes into a lesson.
 */
export async function blocksFromResources(who: Who, courseId: string, ids: unknown): Promise<Block[]> {
  teacherOnly(who);
  const want = (Array.isArray(ids) ? ids : []).filter((x): x is string => typeof x === "string" && UUID.test(x)).slice(0, 100);
  const out: Block[] = [];
  for (const id of want) {
    const r = await getResource(who, courseId, id);
    if (!r || r.archived) continue;
    const lesson = r.kind === "lesson" && r.lessonId ? await getLesson(who, r.lessonId) : null;
    out.push(...resourceBlocks(r, lesson && lesson.courseId === courseId ? lesson.blocks : []));
    if (out.length >= LIMITS.blocks) break;
  }
  return out.slice(0, LIMITS.blocks);
}

/** For the lesson editor's picker: each live resource with the blocks it would add. */
export async function resourceChoices(who: Who, courseId: string): Promise<{ id: string; title: string; kind: BlockType | "lesson"; blocks: Block[] }[]> {
  if (who.role !== "teacher") return [];
  const list = await listResources(who, courseId);
  const out = [];
  for (const r of list) {
    const lesson = r.kind === "lesson" && r.lessonId ? await getLesson(who, r.lessonId) : null;
    if (r.kind === "lesson" && !lesson) continue;
    out.push({ id: r.id, title: r.title, kind: r.kind === "lesson" ? "lesson" as const : r.block!.type, blocks: resourceBlocks(r, lesson?.blocks) });
  }
  return out;
}
