import { getDb } from "./db";
import { normalizeBlocks, forStudent, type Block } from "./blocks";
import { normalizeDoc, type PostDoc } from "./post-doc";
import { normalizeRubric, type Rubric } from "./rubric";
import { weekPlan, type PlanDay } from "./week-plan";
import type { Day } from "./calendar";

/**
 * The principal's weekly plans (teacher story 01, B4; Desmond: "a page in
 * Learning and a PDF"). A school admin (`isSchoolAdmin`, checked by the
 * pages) sees every teacher's week as it is planned: per class, per day,
 * the lessons and materials and the standards they measure. Nobody sends
 * anything (design rule 7: the teacher's week is what the principal sees).
 *
 * Read-only, one school only. Teachers are the ones Learning has seen
 * teaching a class lately (`section_teachers`), named by the display name
 * they last had (migration 031).
 */

/** A teacher counts as teaching a class when seen teaching it within this many days. */
export const RECENT_DAYS = 60;

export type ClassWeek = { courseId: string; name: string; schoolYear: string; days: PlanDay[]; empty: boolean };
export type TeacherWeek = { userId: string; name: string; classes: ClassWeek[]; empty: boolean };

/** Keeps a teacher's own display name beside the sections they teach (for B4). */
export async function noteTeacherName(tenantId: string, userId: string, name: string): Promise<void> {
  const clean = String(name ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!clean || !userId) return;
  const db = await getDb();
  await db.query("UPDATE section_teachers SET name = $3 WHERE tenant_id = $1 AND user_id = $2 AND name <> $3", [tenantId, userId, clean]);
}

/** The school's teachers and the classes they teach now (not clubs), by name. */
export async function schoolTeachers(tenantId: string, now = new Date()): Promise<{ userId: string; name: string; classes: { courseId: string; name: string; schoolYear: string }[] }[]> {
  const db = await getDb();
  const since = new Date(now.getTime() - RECENT_DAYS * 86_400_000).toISOString();
  const rows = await db.query(
    `SELECT t.user_id, t.name AS teacher, c.id, c.name, c.school_year
       FROM section_teachers t JOIN courses c ON c.id = t.course_id AND c.tenant_id = t.tenant_id
      WHERE t.tenant_id = $1 AND t.last_seen >= $2 AND COALESCE(c.kind, 'class') <> 'club'
      ORDER BY c.name`,
    [tenantId, since],
  );
  const by = new Map<string, { userId: string; name: string; classes: { courseId: string; name: string; schoolYear: string }[] }>();
  for (const r of rows) {
    const id = String(r.user_id);
    const t = by.get(id) ?? { userId: id, name: "", classes: [] };
    if (!t.name && r.teacher) t.name = String(r.teacher);
    t.classes.push({ courseId: String(r.id), name: String(r.name), schoolYear: String(r.school_year ?? "") });
    by.set(id, t);
  }
  // Named teachers by name, then any not seen since names were kept.
  return [...by.values()].sort((a, b) => (a.name ? 0 : 1) - (b.name ? 0 : 1) || a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));
}

/** Every teacher's week (or one teacher's), for the principal. */
export async function schoolWeekPlans(tenantId: string, days: Day[], opts: { teacher?: string; now?: Date } = {}): Promise<TeacherWeek[]> {
  const teachers = (await schoolTeachers(tenantId, opts.now)).filter((t) => !opts.teacher || t.userId === opts.teacher);
  const ctx = { tenantId, userId: "" };
  // A class taught by two teachers is planned once; it shows under each of them.
  const cache = new Map<string, PlanDay[]>();
  const out: TeacherWeek[] = [];
  for (const t of teachers) {
    const classes: ClassWeek[] = [];
    for (const c of t.classes) {
      if (!cache.has(c.courseId)) cache.set(c.courseId, await weekPlan(ctx, c.courseId, days));
      const plan = cache.get(c.courseId)!;
      classes.push({ ...c, days: plan, empty: plan.every((p) => !p.lessons.length && !p.materials.length && !p.due.length && !p.standards.length) });
    }
    out.push({ userId: t.userId, name: t.name, classes, empty: classes.every((c) => c.empty) });
  }
  return out;
}

export type PrincipalView =
  | { kind: "lesson"; title: string; className: string; blocks: Block[] }
  | { kind: "assignment"; title: string; className: string; instructions: string; doc: PostDoc | null; points: number; dueAt: string | null; rubric: Rubric | null; quiz: boolean; published: boolean }
  | { kind: "resource"; title: string; className: string; blocks: Block[]; visible: boolean };

/**
 * One planned material as the principal reads it: a lesson's slides as
 * students see them (no poll keys), an assignment's instructions and rubric
 * (never a quiz's questions or key), a material's content. Only this school's.
 */
export async function principalView(tenantId: string, kind: string, id: string): Promise<PrincipalView | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const db = await getDb();
  const json = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);
  if (kind === "lesson") {
    const [r] = await db.query(
      "SELECT l.title, l.blocks, c.name FROM lessons l JOIN courses c ON c.id = l.course_id WHERE l.tenant_id = $1 AND l.id = $2 AND l.archived = false",
      [tenantId, id],
    );
    if (!r) return null;
    let blocks: Block[] = [];
    try { blocks = normalizeBlocks(json(r.blocks)).map(forStudent); } catch { blocks = []; }
    return { kind, title: String(r.title), className: String(r.name), blocks };
  }
  if (kind === "assignment") {
    const [r] = await db.query(
      `SELECT a.title, a.instructions, a.instructions_doc, a.points, a.due_at, a.rubric, a.kind, a.published, c.name
         FROM assignments a JOIN courses c ON c.id = a.course_id WHERE a.tenant_id = $1 AND a.id = $2 AND a.archived = false`,
      [tenantId, id],
    );
    if (!r) return null;
    return {
      kind, title: String(r.title), className: String(r.name), instructions: String(r.instructions ?? ""),
      doc: r.instructions_doc ? normalizeDoc(json(r.instructions_doc)) : null, points: Number(r.points),
      dueAt: r.due_at ? new Date(String(r.due_at)).toISOString() : null,
      rubric: r.rubric ? normalizeRubric(json(r.rubric)) : null, quiz: r.kind === "quiz", published: !!r.published,
    };
  }
  if (kind === "resource") {
    const [r] = await db.query(
      `SELECT r.title, r.kind, r.block, r.visible, l.title AS l_title, l.blocks AS l_blocks, c.name
         FROM class_resources r JOIN courses c ON c.id = r.course_id
         LEFT JOIN lessons l ON l.id = r.lesson_id AND l.archived = false
        WHERE r.tenant_id = $1 AND r.id = $2 AND r.archived = false`,
      [tenantId, id],
    );
    if (!r) return null;
    let blocks: Block[] = [];
    try { blocks = normalizeBlocks(r.kind === "lesson" ? json(r.l_blocks) ?? [] : [json(r.block)]).map(forStudent); } catch { blocks = []; }
    return { kind, title: String(r.title || r.l_title || ""), className: String(r.name), blocks, visible: !!r.visible };
  }
  return null;
}
