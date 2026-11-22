import { getDb } from "./db";
import { schoolWidgets } from "./school-grading";
import {
  classStudentDefaults, cleanKinds, contextKey, forViewer, resolveWidgets,
  type Audience, type Resolved, type SchoolWidgets, type WidgetKind,
} from "./widgets";

/**
 * Which Desk tools the rail shows, stored: each person's own list per
 * context and a class's students' defaults (its teacher's choice). The tools
 * themselves (timers, seating plans) live on the person's Teacher's Desk.
 * Every query filters on the signed-in person's tenant; who may do what is
 * checked here too (the routes check first).
 */

type Ctx = { tenantId: string; userId: string };
const UUID = /^[0-9a-f-]{36}$/i;
const json = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);

/** Where the rail is: home, or a class with the person's role in it (from live Signify ID). */
export type RailPlace = { courseId: null } | { courseId: string; role: "teacher" | "student" };

export async function railWidgets(ctx: Ctx, audience: Audience, place: RailPlace): Promise<Resolved & { school: SchoolWidgets; context: string }> {
  const db = await getDb();
  const context = contextKey(place.courseId);
  // In a class, the class decides: a teacher's tools there are staff tools,
  // a student's are student tools, whatever else they are elsewhere.
  const aud: Audience = place.courseId ? (place.role === "teacher" ? "staff" : "student") : audience;
  const [school, own, cls] = await Promise.all([
    schoolWidgets(ctx.tenantId),
    db.query("SELECT widgets FROM widget_layouts WHERE tenant_id = $1 AND user_id = $2 AND context = $3", [ctx.tenantId, ctx.userId, context]),
    place.courseId && UUID.test(place.courseId)
      ? db.query("SELECT student_widgets FROM courses WHERE tenant_id = $1 AND id = $2", [ctx.tenantId, place.courseId])
      : Promise.resolve([]),
  ]);
  const r = resolveWidgets({
    school: school.value, audience: aud, place: place.courseId ? "class" : "home",
    classStudents: cls[0]?.student_widgets == null ? null : json(cls[0].student_widgets),
    own: own[0] ? json(own[0].widgets) : null,
  });
  return { ...r, school: school.value, context };
}

/** Saves the person's own list here (null = back to the defaults). Only kinds they may have are kept. */
export async function saveOwnWidgets(ctx: Ctx, audience: Audience, place: RailPlace, kinds: unknown | null): Promise<Resolved> {
  const db = await getDb();
  const context = contextKey(place.courseId);
  const aud: Audience = place.courseId ? (place.role === "teacher" ? "staff" : "student") : audience;
  if (kinds === null) {
    await db.query("DELETE FROM widget_layouts WHERE tenant_id = $1 AND user_id = $2 AND context = $3", [ctx.tenantId, ctx.userId, context]);
  } else {
    const school = (await schoolWidgets(ctx.tenantId)).value;
    const clean = forViewer(cleanKinds(kinds), school, aud);
    await db.query(
      `INSERT INTO widget_layouts (tenant_id, user_id, context, widgets) VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (tenant_id, user_id, context) DO UPDATE SET widgets = EXCLUDED.widgets, updated_at = now()`,
      [ctx.tenantId, ctx.userId, context, JSON.stringify(clean)]);
  }
  return railWidgets(ctx, audience, place);
}

/** The students' defaults a class's teacher chose (null = the school's). */
export async function classStudentWidgets(ctx: Ctx, courseId: string): Promise<{ chosen: WidgetKind[] | null; school: SchoolWidgets }> {
  const db = await getDb();
  const [school, rows] = await Promise.all([
    schoolWidgets(ctx.tenantId),
    UUID.test(courseId) ? db.query("SELECT student_widgets FROM courses WHERE tenant_id = $1 AND id = $2", [ctx.tenantId, courseId]) : Promise.resolve([]),
  ]);
  const raw = rows[0]?.student_widgets;
  return { chosen: classStudentDefaults(school.value, raw == null ? null : json(raw)), school: school.value };
}

/**
 * A class's teacher sets the students' defaults (null = follow the school's).
 * Refused when the school doesn't let teachers choose; kinds outside what
 * students may have are dropped.
 */
export async function setClassStudentWidgets(
  ctx: Ctx, courseId: string, role: string, kinds: unknown | null,
): Promise<{ ok: true; chosen: WidgetKind[] | null } | { ok: false; reason: "notTeacher" | "notAllowed" }> {
  if (role !== "teacher" || !UUID.test(courseId)) return { ok: false, reason: "notTeacher" };
  const school = (await schoolWidgets(ctx.tenantId)).value;
  if (!school.teachersChoose) return { ok: false, reason: "notAllowed" };
  const chosen = kinds === null ? null : classStudentDefaults(school, kinds);
  const db = await getDb();
  await db.query("UPDATE courses SET student_widgets = $3::jsonb WHERE tenant_id = $1 AND id = $2",
    [ctx.tenantId, courseId, chosen ? JSON.stringify(chosen) : null]);
  return { ok: true, chosen };
}
