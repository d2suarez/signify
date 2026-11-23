import { getDb, type Queryable } from "./db";
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
  const [lessons, items, due, hand, standards] = await Promise.all([
    db.query(
      `SELECT id, title, planned_for, standards FROM lessons
        WHERE tenant_id = $1 AND course_id = $2 AND archived = false AND planned_for = ANY($3::date[]) ORDER BY planned_for, created_at`,
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
          href: `/courses/${courseId}/resources/${r.ref_id}`,
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
