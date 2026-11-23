import { getDb, type Queryable } from "./db";
import { type Block, LIMITS as BLOCK_LIMITS, newId, normalizeBlocks } from "./blocks";
import { createLesson, getLesson } from "./lessons";
import { blocksFromResources } from "./resources";
import { isSchoolDay } from "./planner";
import type { Day } from "./calendar";

/**
 * What a class does each day (teacher story 01, B1/B2; migration 029): the
 * lessons planned for it (lessons.planned_for, as always), any other
 * material picked onto it (assignments and quizzes, folder materials: a
 * pointer in plan_items, never a copy), the work due, and the standards all
 * of that measures plus any the teacher adds to the day by hand.
 *
 * `weekPlan` is the one reader: the planner shows it to the teacher and the
 * principal's weekly plans (B4) print it. Writes need the course's teacher
 * role; the caller checks it (courseAccess) and every write is also scoped
 * to the course and school here.
 */

type Ctx = { tenantId: string; userId: string };
export type PlanKind = "assignment" | "resource";

export type PlanStandard = {
  id: string; code: string; description: string;
  /** Added to the day by hand (it can be taken off again). */
  byHand: boolean;
  /** Which of the day's things measure it (titles), for "why is this here". */
  from: string[];
};

export type PlanMaterial = {
  /** The plan_items row (to take it off the day). */
  itemId: string;
  kind: PlanKind;
  id: string;
  title: string;
  /** assignment: online | offline | quiz; resource: its block type (link, file, text…) or "lesson". */
  sub: string;
  /** A draft assignment, or a resource students can't see. */
  hidden: boolean;
  href: string;
};

export type PlanDay = {
  day: Day;
  lessons: { id: string; title: string; href: string }[];
  materials: PlanMaterial[];
  due: { id: string; title: string; dueAt: string | null; draft: boolean; href: string }[];
  standards: PlanStandard[];
  /** The day's presentation (B3), if one was made and still exists. */
  presentation: { id: string; title: string } | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PLAN_LIMITS = { itemsPerDay: 30, standardsPerDay: 40 };

const dayOf = (v: unknown): Day => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const json = <T>(v: unknown): T | null => (v == null ? null : typeof v === "string" ? JSON.parse(v) : (v as T));
const idList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The standards an assignment measures: its own, its rubric rows' and its quiz questions'. */
function assignmentStandards(r: Record<string, unknown>): string[] {
  const rubric = json<{ criteria?: { standardId?: string }[] }>(r.rubric);
  const quiz = json<{ items?: { standardId?: string }[] }>(r.quiz);
  return [
    ...idList(json(r.standards)),
    ...(rubric?.criteria ?? []).map((c) => c.standardId).filter((x): x is string => !!x),
    ...(quiz?.items ?? []).map((i) => i.standardId).filter((x): x is string => !!x),
  ];
}

/** Every day in `days` for one class, in the order given. */
export async function weekPlan(ctx: Ctx, courseId: string, days: Day[], q?: Queryable): Promise<PlanDay[]> {
  const db = q ?? await getDb();
  const T = ctx.tenantId;
  if (!days.length) return [];
  const [lessons, items, due, hand, standards, shows] = await Promise.all([
    db.query(
      `SELECT id, title, planned_for, standards FROM lessons
        WHERE tenant_id = $1 AND course_id = $2 AND archived = false AND planned_for = ANY($3::date[])
          AND id NOT IN (SELECT lesson_id FROM plan_days WHERE course_id = $2 AND lesson_id IS NOT NULL) ORDER BY planned_for, created_at`,
      [T, courseId, days],
    ),
    db.query(
      `SELECT p.id AS item_id, p.day, p.kind, p.ref_id,
              a.title AS a_title, a.kind AS a_kind, a.published, a.standards AS a_standards, a.rubric, a.quiz,
              r.title AS r_title, r.kind AS r_kind, r.block->>'type' AS r_type, r.visible, r.lesson_id, l.title AS l_title, l.standards AS l_standards
         FROM plan_items p
         LEFT JOIN assignments a ON p.kind = 'assignment' AND a.id = p.ref_id AND a.tenant_id = p.tenant_id AND a.course_id = p.course_id AND a.archived = false
         LEFT JOIN class_resources r ON p.kind = 'resource' AND r.id = p.ref_id AND r.tenant_id = p.tenant_id AND r.course_id = p.course_id AND r.archived = false
         LEFT JOIN lessons l ON l.id = r.lesson_id AND l.archived = false
        WHERE p.tenant_id = $1 AND p.course_id = $2 AND p.day = ANY($3::date[])
        ORDER BY p.day, p.position, p.created_at`,
      [T, courseId, days],
    ),
    db.query(
      `SELECT id, title, due_on, due_at, published FROM assignments
        WHERE tenant_id = $1 AND course_id = $2 AND archived = false AND due_on = ANY($3::date[]) ORDER BY due_at NULLS LAST, title`,
      [T, courseId, days],
    ),
    db.query("SELECT day, standard_id FROM plan_day_standards WHERE tenant_id = $1 AND course_id = $2 AND day = ANY($3::date[]) ORDER BY created_at", [T, courseId, days]),
    db.query("SELECT id, code, description FROM standards WHERE tenant_id = $1 AND course_id = $2 AND archived = false", [T, courseId]),
    db.query(
      `SELECT p.day, l.id, l.title FROM plan_days p JOIN lessons l ON l.id = p.lesson_id AND l.archived = false AND l.tenant_id = p.tenant_id
        WHERE p.tenant_id = $1 AND p.course_id = $2 AND p.day = ANY($3::date[])`,
      [T, courseId, days],
    ),
  ]);
  const std = new Map(standards.map((s) => [String(s.id), { code: String(s.code), description: String(s.description ?? "") }]));

  return days.map((day) => {
    const found = new Map<string, PlanStandard>();
    const measure = (ids: string[], title: string) => {
      for (const id of ids) {
        const s = std.get(id);
        if (!s) continue;
        const cur = found.get(id) ?? { id, ...s, byHand: false, from: [] };
        if (!cur.from.includes(title)) cur.from.push(title);
        found.set(id, cur);
      }
    };
    const dayLessons = lessons.filter((l) => dayOf(l.planned_for) === day).map((l) => {
      measure(idList(json(l.standards)), String(l.title));
      return { id: String(l.id), title: String(l.title), href: `/lessons/${l.id}/edit` };
    });
    const materials: PlanMaterial[] = [];
    for (const r of items.filter((x) => dayOf(x.day) === day)) {
      if (r.kind === "assignment" && r.a_title != null) {
        measure(assignmentStandards({ standards: r.a_standards, rubric: r.rubric, quiz: r.quiz }), String(r.a_title));
        materials.push({ itemId: String(r.item_id), kind: "assignment", id: String(r.ref_id), title: String(r.a_title), sub: String(r.a_kind), hidden: !r.published, href: `/assignments/${r.ref_id}` });
      } else if (r.kind === "resource" && r.r_title != null) {
        if (r.l_standards) measure(idList(json(r.l_standards)), String(r.r_title));
        materials.push({
          itemId: String(r.item_id), kind: "resource", id: String(r.ref_id), title: String(r.r_title || r.l_title || ""),
          sub: r.r_kind === "lesson" ? "lesson" : String(r.r_type ?? "text"), hidden: !r.visible,
          href: `/courses/${courseId}/materials/${r.ref_id}`,
        });
      }
      // A plan item whose material was archived is simply not shown.
    }
    for (const h of hand.filter((x) => dayOf(x.day) === day)) {
      const id = String(h.standard_id);
      const s = std.get(id);
      if (!s) continue;
      const cur = found.get(id) ?? { id, ...s, byHand: false, from: [] };
      cur.byHand = true;
      found.set(id, cur);
    }
    return {
      day,
      lessons: dayLessons,
      materials,
      due: due.filter((a) => dayOf(a.due_on) === day).map((a) => ({
        id: String(a.id), title: String(a.title), dueAt: a.due_at ? new Date(String(a.due_at)).toISOString() : null, draft: !a.published, href: `/assignments/${a.id}`,
      })),
      standards: [...found.values()].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })),
      presentation: (() => { const p = shows.find((x) => dayOf(x.day) === day); return p ? { id: String(p.id), title: String(p.title) } : null; })(),
    };
  });
}

export class PlanError extends Error {
  constructor(public code: "day" | "missing" | "full") { super(code); }
}

function checkDay(day: unknown): Day {
  const s = String(day ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new PlanError("day");
  const d = new Date(`${s}T12:00:00Z`);
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s || !isSchoolDay(s)) throw new PlanError("day");
  return s;
}

/** Puts an assignment/quiz or a class resource of this course on a school day. Once per day; returns the plan item id. */
export async function planMaterial(ctx: Ctx, courseId: string, day: unknown, kind: unknown, refId: unknown): Promise<string> {
  const d = checkDay(day);
  const k: PlanKind = kind === "assignment" ? "assignment" : kind === "resource" ? "resource" : (() => { throw new PlanError("missing"); })();
  const ref = String(refId ?? "");
  if (!UUID.test(ref)) throw new PlanError("missing");
  const db = await getDb();
  return db.tx(async (t) => {
    const table = k === "assignment" ? "assignments" : "class_resources";
    const [own] = await t.query(`SELECT 1 FROM ${table} WHERE tenant_id = $1 AND course_id = $2 AND id = $3 AND archived = false`, [ctx.tenantId, courseId, ref]);
    if (!own) throw new PlanError("missing");
    const [{ n, pos }] = await t.query(
      "SELECT count(*)::int AS n, COALESCE(max(position) + 1, 0)::int AS pos FROM plan_items WHERE tenant_id = $1 AND course_id = $2 AND day = $3",
      [ctx.tenantId, courseId, d],
    );
    const [had] = await t.query("SELECT id FROM plan_items WHERE course_id = $1 AND day = $2 AND kind = $3 AND ref_id = $4", [courseId, d, k, ref]);
    if (had) return String(had.id);
    if (Number(n) >= PLAN_LIMITS.itemsPerDay) throw new PlanError("full");
    const [row] = await t.query(
      "INSERT INTO plan_items (tenant_id, course_id, day, kind, ref_id, position, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
      [ctx.tenantId, courseId, d, k, ref, pos, ctx.userId],
    );
    return String(row.id);
  });
}

/** Takes a material off a day (the material itself is untouched). */
export async function unplanMaterial(ctx: Ctx, courseId: string, itemId: unknown): Promise<boolean> {
  const id = String(itemId ?? "");
  if (!UUID.test(id)) return false;
  const db = await getDb();
  const rows = await db.query("DELETE FROM plan_items WHERE tenant_id = $1 AND course_id = $2 AND id = $3 RETURNING id", [ctx.tenantId, courseId, id]);
  return rows.length > 0;
}

/** Moves a picked material to another school day (or keeps it if it's already there). */
export async function movePlanItem(ctx: Ctx, courseId: string, itemId: unknown, day: unknown): Promise<boolean> {
  const id = String(itemId ?? "");
  if (!UUID.test(id)) return false;
  const d = checkDay(day);
  const db = await getDb();
  return db.tx(async (t) => {
    const [cur] = await t.query("SELECT kind, ref_id FROM plan_items WHERE tenant_id = $1 AND course_id = $2 AND id = $3", [ctx.tenantId, courseId, id]);
    if (!cur) return false;
    const [there] = await t.query("SELECT id FROM plan_items WHERE course_id = $1 AND day = $2 AND kind = $3 AND ref_id = $4", [courseId, d, cur.kind, cur.ref_id]);
    if (there) { if (String(there.id) !== id) await t.query("DELETE FROM plan_items WHERE id = $1", [id]); return true; }
    await t.query("UPDATE plan_items SET day = $3 WHERE tenant_id = $1 AND id = $2", [ctx.tenantId, id, d]);
    return true;
  });
}

/** Adds one of the course's standards to a day by hand. */
export async function addDayStandard(ctx: Ctx, courseId: string, day: unknown, standardId: unknown): Promise<void> {
  const d = checkDay(day);
  const s = String(standardId ?? "");
  if (!UUID.test(s)) throw new PlanError("missing");
  const db = await getDb();
  await db.tx(async (t) => {
    const [own] = await t.query("SELECT 1 FROM standards WHERE tenant_id = $1 AND course_id = $2 AND id = $3 AND archived = false", [ctx.tenantId, courseId, s]);
    if (!own) throw new PlanError("missing");
    const [{ n }] = await t.query("SELECT count(*)::int AS n FROM plan_day_standards WHERE tenant_id = $1 AND course_id = $2 AND day = $3", [ctx.tenantId, courseId, d]);
    if (Number(n) >= PLAN_LIMITS.standardsPerDay) throw new PlanError("full");
    await t.query(
      "INSERT INTO plan_day_standards (tenant_id, course_id, day, standard_id, created_by) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
      [ctx.tenantId, courseId, d, s, ctx.userId],
    );
  });
}

/** Takes a hand-added standard off a day (ones the day's materials measure stay). */
export async function removeDayStandard(ctx: Ctx, courseId: string, day: unknown, standardId: unknown): Promise<boolean> {
  const d = checkDay(day);
  const s = String(standardId ?? "");
  if (!UUID.test(s)) return false;
  const db = await getDb();
  const rows = await db.query(
    "DELETE FROM plan_day_standards WHERE tenant_id = $1 AND course_id = $2 AND day = $3 AND standard_id = $4 RETURNING day",
    [ctx.tenantId, courseId, d, s],
  );
  return rows.length > 0;
}

/** What can be picked onto a day: the course's assignments/quizzes and class resources, with their folder. */
export async function plannable(ctx: Ctx, courseId: string): Promise<{ kind: PlanKind; id: string; title: string; sub: string; unitId: string | null }[]> {
  const db = await getDb();
  const [a, r] = await Promise.all([
    db.query("SELECT id, title, kind, unit_id FROM assignments WHERE tenant_id = $1 AND course_id = $2 AND archived = false ORDER BY title", [ctx.tenantId, courseId]),
    db.query(
      `SELECT r.id, COALESCE(NULLIF(r.title, ''), l.title, '') AS title, r.kind, r.block->>'type' AS type, r.unit_id
         FROM class_resources r LEFT JOIN lessons l ON l.id = r.lesson_id
        WHERE r.tenant_id = $1 AND r.course_id = $2 AND r.archived = false ORDER BY r.position`,
      [ctx.tenantId, courseId],
    ),
  ]);
  return [
    ...a.map((x) => ({ kind: "assignment" as const, id: String(x.id), title: String(x.title), sub: String(x.kind), unitId: x.unit_id ? String(x.unit_id) : null })),
    ...r.map((x) => ({ kind: "resource" as const, id: String(x.id), title: String(x.title), sub: x.kind === "lesson" ? "lesson" : String(x.type ?? "text"), unitId: x.unit_id ? String(x.unit_id) : null })),
  ];
}

/** Lessons that are some day's presentation (the planner leaves them out of "Not scheduled"). */
export async function presentationLessonIds(ctx: Ctx, courseId: string): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db.query("SELECT lesson_id FROM plan_days WHERE tenant_id = $1 AND course_id = $2 AND lesson_id IS NOT NULL", [ctx.tenantId, courseId]);
  return new Set(rows.map((r) => String(r.lesson_id)));
}

/**
 * The slides for a day, in order: each lesson planned for it (its blocks),
 * then each picked material (a class resource's block(s), as "Present
 * ticked" makes them; an assignment or quiz as its own assignment slide),
 * with a seating chart slide moved to the front. Copies with fresh ids, so the day's lessons never change.
 */
export async function dayBlocks(ctx: Ctx, courseId: string, day: Day): Promise<{ blocks: Block[]; sources: number; onlyLesson: string | null }> {
  const [plan] = await weekPlan(ctx, courseId, [day]);
  const blocks: Block[] = [];
  for (const l of plan.lessons) {
    const lesson = await getLesson(ctx, l.id);
    if (lesson && lesson.courseId === courseId) blocks.push(...lesson.blocks.map((b) => ({ ...b, id: newId() })));
  }
  const db = await getDb();
  for (const m of plan.materials) {
    if (m.kind === "resource") blocks.push(...await blocksFromResources({ ...ctx, role: "teacher" }, courseId, [m.id]));
    else {
      const [a] = await db.query("SELECT title FROM assignments WHERE tenant_id = $1 AND course_id = $2 AND id = $3 AND archived = false", [ctx.tenantId, courseId, m.id]);
      if (a) blocks.push(assignmentSlide(m.id, String(a.title)));
    }
    if (blocks.length >= BLOCK_LIMITS.blocks) break;
  }
  const sources = plan.lessons.length + plan.materials.length;
  // A seating chart starts the class (story 01: "always start with the seating
  // assignments"), so it comes first, and once.
  const seating = blocks.find((b) => b.type === "seating");
  const ordered = seating ? [seating, ...blocks.filter((b) => b.type !== "seating")] : blocks;
  return {
    blocks: normalizeBlocks(ordered.slice(0, BLOCK_LIMITS.blocks)),
    sources,
    onlyLesson: plan.lessons.length === 1 && plan.materials.length === 0 ? plan.lessons[0].id : null,
  };
}

/** An assignment or quiz on a slide: the assignment itself, published from the presenter (story 01, D3/D10). */
export function assignmentSlide(id: string, title: string): Block {
  return { id: newId(), type: "assignment", title: title.slice(0, 200), assignmentId: id };
}

/**
 * "Present this day": the day's presentation lesson, made now if there is
 * none (or `again`). A day with just one lesson presents that lesson itself.
 * Null when nothing is on the day. The caller checks the teacher role.
 */
export async function presentDay(ctx: Ctx, courseId: string, day: unknown, title: string, again = false): Promise<string | null> {
  const d = checkDay(day);
  const db = await getDb();
  if (!again) {
    const [had] = await db.query(
      `SELECT l.id FROM plan_days p JOIN lessons l ON l.id = p.lesson_id AND l.archived = false
        WHERE p.tenant_id = $1 AND p.course_id = $2 AND p.day = $3`,
      [ctx.tenantId, courseId, d],
    );
    if (had) return String(had.id);
  }
  const { blocks, onlyLesson } = await dayBlocks(ctx, courseId, d);
  if (onlyLesson) return onlyLesson;
  if (!blocks.length) return null;
  const lesson = await createLesson(ctx, courseId, title, blocks);
  await db.query(
    `INSERT INTO plan_days (tenant_id, course_id, day, lesson_id, made_by) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (course_id, day) DO UPDATE SET lesson_id = EXCLUDED.lesson_id, made_by = EXCLUDED.made_by, made_at = now()`,
    [ctx.tenantId, courseId, d, lesson.id, ctx.userId],
  );
  return lesson.id;
}
