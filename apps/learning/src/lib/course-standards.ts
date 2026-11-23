import { getDb, type Queryable } from "./db";
import { gradeList } from "./standards-csv";
import { getFramework, type Viewer } from "./standards-library";
import type { Day } from "./calendar";

/**
 * Standards on the course, inherited by its classes (Desmond, 2026-11-23;
 * migration 042).
 *
 * A course (catalog_courses: "Algebra I", lasting year to year) holds sets
 * of standards: a whole set, one part of it (a heading and everything under
 * it) and/or only some grades. Every class (section: a `courses` row) of the
 * course then has those standards, as `standards` rows marked `from_course`.
 * They are kept in step here (`syncSection`) whenever the course's sets
 * change, a class is put in the course, or the class's Standards page is
 * opened (so a new item in a school set reaches it). Nobody copies anything
 * by hand.
 *
 * Why rows and not a live join: every alignment (assignments, rubric rows,
 * quiz questions, lessons, planner days) and every grades.levels key points
 * at a `standards.id`. Keeping one row per class per standard keeps all of
 * that, and every existing id, exactly as it was.
 *
 * - An inherited standard the course drops is archived in its classes
 *   (never deleted: scores may name it), and comes back if the course takes
 *   the set again.
 * - A teacher can still add a standard to one class (from_course = false:
 *   from the library, or typed). If the course later brings the same item,
 *   the class keeps its own row (one row per item).
 * - Who chooses a course's sets: a school admin, or a teacher who teaches a
 *   section of it now when the school allows (school_standards_settings.
 *   teacher_course_sets, on unless the school turns it off).
 *
 * Coverage (`coverage`): for one class, how often each standard was taught
 * (lessons planned for a day, materials picked onto a day, standards added
 * to a day by hand, lessons presented live) and assessed (aligned
 * assignments and quizzes by due date, or picked onto a day), when last, and
 * what is planned next.
 */

type Ctx = { tenantId: string; userId: string; audiences?: string[] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (x: unknown): x is string => typeof x === "string" && UUID.test(x);

/** Inherited standards sit before a class's own (negative positions), in the course's set order. */
const INHERITED_BASE = -100_000;
export const COURSE_SET_LIMITS = { sets: 30, standards: 2_000 };

export type CourseSet = {
  id: string;
  frameworkId: string;
  title: string;
  version: string;
  ownerKind: string;
  notice: string | null;
  /** The part of the set (a heading), or null = all of it. */
  part: { id: string; title: string } | null;
  /** CASE levels; empty = every grade. */
  grades: string[];
  /** How many standards it brings. */
  count: number;
};

function arr(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v.startsWith("{")) return v.slice(1, -1).split(",").filter(Boolean).map((s) => s.replace(/^"|"$/g, ""));
  return [];
}

/** SQL selecting the coded, live items a set brings, in tree order. $1 framework, $2 root (or null), $3 grades. */
const SET_ITEMS = `
  WITH RECURSIVE sub AS (
    SELECT id FROM standard_items WHERE id = $2::uuid AND framework_id = $1
    UNION ALL SELECT c.id FROM standard_items c JOIN sub ON c.parent_id = sub.id
  )
  SELECT i.id, i.position FROM standard_items i
   WHERE i.framework_id = $1 AND NOT i.archived AND i.code <> ''
     AND ($2::uuid IS NULL OR i.id IN (SELECT id FROM sub))
     AND (cardinality($3::text[]) = 0 OR i.grades && $3::text[] OR cardinality(i.grades) = 0)
   ORDER BY i.position`;

async function setItemIds(q: Queryable, frameworkId: string, rootId: string | null, grades: string[]): Promise<string[]> {
  const rows = await q.query(SET_ITEMS, [frameworkId, rootId, grades]);
  return rows.map((r) => String(r.id));
}

/** The course's sets, in order, with what each brings. */
export async function listCourseSets(ctx: Pick<Ctx, "tenantId">, catalogId: string, q?: Queryable): Promise<CourseSet[]> {
  if (!isId(catalogId)) return [];
  const db = q ?? await getDb();
  const rows = await db.query(
    `SELECT s.*, f.title, f.version, f.owner_kind, f.notice, r.statement AS part_title, r.code AS part_code
       FROM course_standard_sets s JOIN standard_frameworks f ON f.id = s.framework_id
       LEFT JOIN standard_items r ON r.id = s.root_item_id
      WHERE s.tenant_id = $1 AND s.catalog_id = $2 ORDER BY s.position, s.added_at`,
    [ctx.tenantId, catalogId],
  );
  const out: CourseSet[] = [];
  for (const r of rows) {
    const grades = arr(r.grades);
    const root = r.root_item_id ? String(r.root_item_id) : null;
    out.push({
      id: String(r.id), frameworkId: String(r.framework_id), title: String(r.title), version: String(r.version ?? ""),
      ownerKind: String(r.owner_kind), notice: (r.notice as string) ?? null,
      part: root ? { id: root, title: [r.part_code, r.part_title].filter(Boolean).join(" ") } : null,
      grades, count: (await setItemIds(db, String(r.framework_id), root, grades)).length,
    });
  }
  return out;
}

/** The items every set of the course brings, once each, in set then tree order. */
async function courseItemIds(q: Queryable, tenantId: string, catalogId: string): Promise<string[]> {
  const sets = await q.query(
    "SELECT framework_id, root_item_id, grades FROM course_standard_sets WHERE tenant_id = $1 AND catalog_id = $2 ORDER BY position, added_at",
    [tenantId, catalogId],
  );
  const seen = new Set<string>();
  for (const s of sets) {
    for (const id of await setItemIds(q, String(s.framework_id), s.root_item_id ? String(s.root_item_id) : null, arr(s.grades))) seen.add(id);
  }
  return [...seen];
}

/**
 * Brings one class in step with its course's sets: adds what's missing,
 * brings back what was archived, archives inherited standards the course no
 * longer has. A class's own standards are never touched.
 */
export async function syncSection(q: Queryable, tenantId: string, sectionId: string): Promise<{ added: number; archived: number }> {
  if (!isId(sectionId)) return { added: 0, archived: 0 };
  const [c] = await q.query("SELECT catalog_id FROM courses WHERE tenant_id = $1 AND id = $2", [tenantId, sectionId]);
  const want = c?.catalog_id ? await courseItemIds(q, tenantId, String(c.catalog_id)) : [];
  const pos = want.map((_, k) => INHERITED_BASE + k);
  const added = want.length ? await q.query(
    `INSERT INTO standards (tenant_id, course_id, code, description, external_id, item_id, position, from_course)
     SELECT $1, $2, left(i.code, 60), left(i.statement, 2000), left(i.identifier, 200), i.id, w.pos, true
       FROM unnest($3::uuid[], $4::int[]) AS w(id, pos) JOIN standard_items i ON i.id = w.id
      WHERE NOT EXISTS (SELECT 1 FROM standards s WHERE s.tenant_id = $1 AND s.course_id = $2 AND s.item_id = i.id)
     RETURNING id`,
    [tenantId, sectionId, want, pos],
  ) : [];
  if (want.length) {
    await q.query(
      `UPDATE standards s SET archived = false, position = w.pos
         FROM unnest($3::uuid[], $4::int[]) AS w(id, pos)
        WHERE s.tenant_id = $1 AND s.course_id = $2 AND s.from_course AND s.item_id = w.id AND (s.archived OR s.position <> w.pos)`,
      [tenantId, sectionId, want, pos],
    );
  }
  const archived = await q.query(
    `UPDATE standards SET archived = true
      WHERE tenant_id = $1 AND course_id = $2 AND from_course AND NOT archived AND (item_id IS NULL OR NOT (item_id = ANY($3::uuid[])))
     RETURNING id`,
    [tenantId, sectionId, want],
  );
  return { added: added.length, archived: archived.length };
}

/** Every class of the course, in step. */
export async function syncCatalog(q: Queryable, tenantId: string, catalogId: string): Promise<void> {
  const sections = await q.query("SELECT id FROM courses WHERE tenant_id = $1 AND catalog_id = $2", [tenantId, catalogId]);
  for (const s of sections) await syncSection(q, tenantId, String(s.id));
}

/** May teachers choose their courses' sets? (The school's choice; yes unless it said no.) */
export async function teachersChooseCourseSets(tenantId: string, q?: Queryable): Promise<boolean> {
  const db = q ?? await getDb();
  const [r] = await db.query("SELECT teacher_course_sets FROM school_standards_settings WHERE tenant_id = $1", [tenantId]);
  return r ? !!r.teacher_course_sets : true;
}

/** A school admin, or (when the school allows) someone teaching a section of the course now. */
export async function mayChooseCourseSets(v: Viewer, catalogId: string, q?: Queryable): Promise<boolean> {
  if (!isId(catalogId)) return false;
  const db = q ?? await getDb();
  const [k] = await db.query("SELECT 1 FROM catalog_courses WHERE tenant_id = $1 AND id = $2", [v.tenantId, catalogId]);
  if (!k) return false;
  if (v.admin) return true;
  const mine = v.teaches.filter(isId);
  if (!mine.length || !(await teachersChooseCourseSets(v.tenantId, db))) return false;
  const [r] = await db.query("SELECT 1 FROM courses WHERE tenant_id = $1 AND catalog_id = $2 AND id = ANY($3::uuid[])", [v.tenantId, catalogId, mine]);
  return !!r;
}

export type SetChoice = { frameworkId?: unknown; partId?: unknown; grades?: unknown };
export type SetResult = "ok" | "forbidden" | "unknown" | "empty" | "too-many" | "exists";

/**
 * Gives the course a set (all of it, a part, some grades) and brings every
 * class of the course in step. The set must be one the person may see.
 */
export async function addCourseSet(v: Viewer, catalogId: string, input: SetChoice): Promise<SetResult> {
  const db = await getDb();
  if (!(await mayChooseCourseSets(v, catalogId, db))) return "forbidden";
  const f = await getFramework(v, String(input.frameworkId ?? ""), db);
  if (!f || f.archived) return "unknown";
  let root: string | null = null;
  if (input.partId && String(input.partId)) {
    const [r] = await db.query("SELECT id FROM standard_items WHERE id = $1::uuid AND framework_id = $2", [isId(input.partId) ? input.partId : null, f.id]);
    if (!r) return "unknown";
    root = String(r.id);
  }
  const grades = gradeList(input.grades);
  return db.tx(async (t) => {
    const sets = await t.query(
      "SELECT framework_id, root_item_id, grades FROM course_standard_sets WHERE tenant_id = $1 AND catalog_id = $2",
      [v.tenantId, catalogId],
    );
    if (sets.length >= COURSE_SET_LIMITS.sets) return "too-many";
    if (sets.some((s) => String(s.framework_id) === f.id && String(s.root_item_id ?? "") === (root ?? "") && arr(s.grades).join() === grades.join())) return "exists";
    const ids = await setItemIds(t, f.id, root, grades);
    if (!ids.length) return "empty";
    const all = new Set([...(await courseItemIds(t, v.tenantId, catalogId)), ...ids]);
    if (all.size > COURSE_SET_LIMITS.standards) return "too-many";
    await t.query(
      `INSERT INTO course_standard_sets (tenant_id, catalog_id, framework_id, root_item_id, grades, position, added_by)
       VALUES ($1, $2, $3, $4, $5, (SELECT coalesce(max(position), -1) + 1 FROM course_standard_sets WHERE tenant_id = $1 AND catalog_id = $2), $6)`,
      [v.tenantId, catalogId, f.id, root, grades, v.userId],
    );
    await syncCatalog(t, v.tenantId, catalogId);
    return "ok";
  });
}

/** Takes a set off the course; its standards are archived in the classes (alignments and levels stay). */
export async function removeCourseSet(v: Viewer, catalogId: string, setId: unknown): Promise<boolean> {
  if (!isId(setId)) return false;
  const db = await getDb();
  if (!(await mayChooseCourseSets(v, catalogId, db))) return false;
  return db.tx(async (t) => {
    const rows = await t.query("DELETE FROM course_standard_sets WHERE tenant_id = $1 AND catalog_id = $2 AND id = $3 RETURNING id", [v.tenantId, catalogId, setId]);
    if (!rows.length) return false;
    await syncCatalog(t, v.tenantId, catalogId);
    return true;
  });
}

/** For choosing a part: a set's headings (no code), top levels only, in tree order, and the grades it covers. */
export async function setParts(v: Viewer, frameworkId: string): Promise<{ parts: { id: string; title: string; depth: number }[]; grades: string[] } | null> {
  const db = await getDb();
  const f = await getFramework(v, frameworkId, db);
  if (!f) return null;
  const rows = await db.query(
    "SELECT id, statement, depth FROM standard_items WHERE framework_id = $1 AND NOT archived AND code = '' AND depth <= 2 ORDER BY position LIMIT 400",
    [f.id],
  );
  const g = await db.query("SELECT DISTINCT unnest(grades) AS g FROM standard_items WHERE framework_id = $1 AND NOT archived AND code <> ''", [f.id]);
  const order = ["PK", "KG", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12", "13", "AS", "BA", "PB", "MD", "FS", "DO", "PD", "AE", "PR", "OT"];
  return {
    parts: rows.map((r) => ({ id: String(r.id), title: String(r.statement).slice(0, 120), depth: Number(r.depth ?? 0) })),
    grades: g.map((r) => String(r.g)).sort((a, b) => order.indexOf(a) - order.indexOf(b)),
  };
}

/** Courses of the school with their sets' titles (for the school's Standards page). */
export async function schoolCourseSets(tenantId: string): Promise<{ id: string; name: string; sections: number; sets: string[] }[]> {
  const db = await getDb();
  const rows = await db.query(
    `SELECT k.id, k.name, (SELECT count(*)::int FROM courses c WHERE c.catalog_id = k.id) AS n,
            coalesce((SELECT array_agg(f.title || CASE WHEN f.version <> '' THEN ' (' || f.version || ')' ELSE '' END ORDER BY s.position)
                        FROM course_standard_sets s JOIN standard_frameworks f ON f.id = s.framework_id WHERE s.catalog_id = k.id), '{}') AS sets
       FROM catalog_courses k WHERE k.tenant_id = $1 ORDER BY k.name, k.id`,
    [tenantId],
  );
  return rows.map((r) => ({ id: String(r.id), name: String(r.name), sections: Number(r.n), sets: arr(r.sets) }));
}

// ---------- one class: its standards and their coverage ----------

export type ClassStandard = {
  id: string;
  code: string;
  description: string;
  /** From the course's sets (true) or added to this class only. */
  fromCourse: boolean;
  /** The set it comes from ("Virginia SOL Mathematics (2023)"); "" for one typed into the class. */
  set: string;
  /** The nearest heading above it ("Number and Number Sense"); "" when none. */
  strand: string;
  grades: string[];
  /** May be edited here (typed into the class). */
  editable: boolean;
  archived: boolean;
};

/** A class's standards with where each came from, inherited first (course order), then its own. */
export async function classStandards(ctx: Ctx, courseId: string, opts: { withArchived?: boolean } = {}, q?: Queryable): Promise<ClassStandard[]> {
  if (!isId(courseId)) return [];
  const db = q ?? await getDb();
  const rows = await db.query(
    `WITH RECURSIVE up AS (
       SELECT s.id AS sid, i.parent_id AS pid, 1 AS lvl FROM standards s JOIN standard_items i ON i.id = s.item_id
        WHERE s.tenant_id = $1 AND s.course_id = $2
       UNION ALL
       SELECT up.sid, p.parent_id, up.lvl + 1 FROM up JOIN standard_items p ON p.id = up.pid WHERE p.code <> '' AND up.lvl < 12
     ), strand AS (
       SELECT DISTINCT ON (up.sid) up.sid, h.statement FROM up JOIN standard_items h ON h.id = up.pid WHERE h.code = '' ORDER BY up.sid, up.lvl
     )
     SELECT s.id, s.code, s.description, s.from_course, s.archived, s.item_id, i.grades,
            f.title AS f_title, f.version AS f_version, f.course_id AS f_course, f.audience, st.statement AS strand
       FROM standards s LEFT JOIN standard_items i ON i.id = s.item_id LEFT JOIN standard_frameworks f ON f.id = i.framework_id
       LEFT JOIN strand st ON st.sid = s.id
      WHERE s.tenant_id = $1 AND s.course_id = $2 ${opts.withArchived ? "" : "AND NOT s.archived"}
      ORDER BY s.archived, s.from_course DESC, s.position, s.code`,
    [ctx.tenantId, courseId],
  );
  const audiences = new Set(ctx.audiences ?? []);
  return rows
    // A standard from a set the school may not have (NAD, for a school that isn't) stays but isn't shown.
    .filter((r) => !r.audience || audiences.has(String(r.audience)))
    .map((r) => {
      const own = !r.item_id || (r.f_course != null && String(r.f_course) === courseId);
      return {
        id: String(r.id), code: String(r.code), description: String(r.description ?? ""), fromCourse: !!r.from_course,
        set: own || !r.f_title ? "" : r.f_version ? `${r.f_title} (${r.f_version})` : String(r.f_title),
        strand: r.strand ? String(r.strand).slice(0, 120) : "", grades: arr(r.grades), editable: own, archived: !!r.archived,
      };
    });
}

export type CoverageStatus = "covered" | "planned" | "none";
export type CoverageEvent = { day: Day; kind: "taught" | "assessed"; title: string; href: string };
export type CoverageRow = ClassStandard & {
  taught: number;
  assessed: number;
  /** Last day taught or assessed (today or before). */
  last: Day | null;
  /** Next day it is planned for (after today). */
  next: Day | null;
  status: CoverageStatus;
  events: CoverageEvent[];
};
export type Coverage = {
  rows: CoverageRow[];
  /** Every day with standards on it (past and planned): standard ids, for the calendar. */
  byDay: Record<Day, string[]>;
  counts: { total: number; covered: number; planned: number; none: number };
};

const dayStr = (v: unknown): Day => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const json = <T>(v: unknown): T | null => (v == null ? null : typeof v === "string" ? JSON.parse(v) : (v as T));
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The standards an assignment measures: its own, its rubric rows' and its quiz questions'. */
export function measuredBy(a: { standards?: unknown; rubric?: unknown; quiz?: unknown }): string[] {
  const rubric = json<{ criteria?: { standardId?: string }[] }>(a.rubric);
  const quiz = json<{ items?: { standardId?: string }[] }>(a.quiz);
  return [...new Set([
    ...ids(json(a.standards)),
    ...(rubric?.criteria ?? []).map((c) => c.standardId).filter((x): x is string => !!x),
    ...(quiz?.items ?? []).map((i) => i.standardId).filter((x): x is string => !!x),
  ])];
}

/**
 * How each of a class's standards has been covered. Taught: a lesson planned
 * for a day, a lesson presented live, a material picked onto a day, a
 * standard added to a day by hand. Assessed: an aligned assignment or quiz
 * by its due day (drafts only count while still ahead), or picked onto a
 * day. Days after `today` are planned, not covered.
 */
export async function coverage(ctx: Ctx, courseId: string, today: Day, q?: Queryable): Promise<Coverage> {
  const db = q ?? await getDb();
  const T = ctx.tenantId;
  const [list, lessons, shown, items, hand, work] = await Promise.all([
    classStandards(ctx, courseId, {}, db),
    db.query("SELECT id, title, planned_for, standards FROM lessons WHERE tenant_id = $1 AND course_id = $2 AND NOT archived AND standards IS NOT NULL", [T, courseId]),
    db.query(
      `SELECT p.day, l.id, l.title, l.standards FROM lesson_presentations p JOIN lessons l ON l.id = p.lesson_id
        WHERE p.tenant_id = $1 AND p.course_id = $2 AND l.standards IS NOT NULL`,
      [T, courseId],
    ),
    db.query(
      `SELECT p.day, p.kind, a.id AS a_id, a.title AS a_title, a.standards AS a_std, a.rubric, a.quiz,
              r.id AS r_id, COALESCE(NULLIF(r.title, ''), l.title) AS r_title, l.standards AS l_std
         FROM plan_items p
         LEFT JOIN assignments a ON p.kind = 'assignment' AND a.id = p.ref_id AND a.course_id = p.course_id AND NOT a.archived
         LEFT JOIN class_resources r ON p.kind = 'resource' AND r.id = p.ref_id AND r.course_id = p.course_id AND NOT r.archived
         LEFT JOIN lessons l ON l.id = r.lesson_id AND NOT l.archived
        WHERE p.tenant_id = $1 AND p.course_id = $2`,
      [T, courseId],
    ),
    db.query("SELECT day, standard_id FROM plan_day_standards WHERE tenant_id = $1 AND course_id = $2", [T, courseId]),
    db.query(
      "SELECT id, title, due_on, published, standards, rubric, quiz FROM assignments WHERE tenant_id = $1 AND course_id = $2 AND NOT archived AND due_on IS NOT NULL",
      [T, courseId],
    ),
  ]);
  const ev = new Map<string, CoverageEvent[]>();
  const add = (sids: string[], e: CoverageEvent) => {
    for (const s of sids) {
      const l = ev.get(s) ?? [];
      // One event per day, kind and thing.
      if (!l.some((x) => x.day === e.day && x.kind === e.kind && x.href === e.href)) l.push(e);
      ev.set(s, l);
    }
  };
  for (const l of lessons) {
    if (l.planned_for) add(ids(json(l.standards)), { day: dayStr(l.planned_for), kind: "taught", title: String(l.title), href: `/lessons/${l.id}/edit` });
  }
  for (const l of shown) add(ids(json(l.standards)), { day: dayStr(l.day), kind: "taught", title: String(l.title), href: `/lessons/${l.id}/edit` });
  for (const p of items) {
    if (p.kind === "assignment" && p.a_id) add(measuredBy({ standards: p.a_std, rubric: p.rubric, quiz: p.quiz }), { day: dayStr(p.day), kind: "assessed", title: String(p.a_title), href: `/assignments/${p.a_id}` });
    if (p.kind === "resource" && p.r_id && p.l_std) add(ids(json(p.l_std)), { day: dayStr(p.day), kind: "taught", title: String(p.r_title ?? ""), href: `/courses/${courseId}/materials/${p.r_id}` });
  }
  for (const h of hand) add([String(h.standard_id)], { day: dayStr(h.day), kind: "taught", title: "", href: `/planner?week=${dayStr(h.day)}` });
  for (const a of work) {
    const day = dayStr(a.due_on);
    if (!a.published && day <= today) continue;
    add(measuredBy(a), { day, kind: "assessed", title: String(a.title), href: `/assignments/${a.id}` });
  }

  const byDay: Record<Day, string[]> = {};
  const counts = { total: list.length, covered: 0, planned: 0, none: 0 };
  const rows = list.map((s): CoverageRow => {
    const events = (ev.get(s.id) ?? []).sort((a, b) => a.day.localeCompare(b.day));
    for (const e of events) {
      const l = byDay[e.day] ?? (byDay[e.day] = []);
      if (!l.includes(s.id)) l.push(s.id);
    }
    const past = events.filter((e) => e.day <= today);
    const ahead = events.filter((e) => e.day > today);
    const taught = new Set(past.filter((e) => e.kind === "taught").map((e) => e.day)).size;
    const assessed = new Set(past.filter((e) => e.kind === "assessed").map((e) => e.href)).size;
    const status: CoverageStatus = past.length ? "covered" : ahead.length ? "planned" : "none";
    counts[status]++;
    return { ...s, taught, assessed, last: past.at(-1)?.day ?? null, next: ahead[0]?.day ?? null, status, events };
  });
  return { rows, byDay, counts };
}

/** Notes that a lesson of this class was presented live today (the presenter's End). */
export async function recordPresentation(ctx: Ctx, courseId: string, lessonId: string, day: Day): Promise<void> {
  if (!isId(courseId) || !isId(lessonId) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
  const db = await getDb();
  await db.query(
    `INSERT INTO lesson_presentations (tenant_id, course_id, lesson_id, day, presented_by)
     SELECT $1, $2, $3, $4, $5 WHERE EXISTS (SELECT 1 FROM lessons WHERE tenant_id = $1 AND course_id = $2 AND id = $3)
     ON CONFLICT (lesson_id, day) DO NOTHING`,
    [ctx.tenantId, courseId, lessonId, day, ctx.userId],
  );
}

