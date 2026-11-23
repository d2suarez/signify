import "server-only";
import type { ctx } from "./access";
import { listLessons } from "./lessons";
import { listAssignments } from "./assignments";
import { listUnits, subtreeIds } from "./units";
import { listResources } from "./resources";
import { coverage } from "./course-standards";
import { todayIn } from "./planner";
import { weekPlan, plannable, presentationLessonIds } from "./week-plan";
import type { Day } from "./calendar";
import type { PlannerCourse } from "@/components/WeekPlanner";

/** The school's own day. One school for now; a per-school setting comes with multi-school. */
export const SCHOOL_TZ = "America/New_York";

/**
 * One class's band in the Planner for these school days: lessons, work due,
 * folders, resources, the day plans (picked materials, standards, the
 * presentation) and what can be picked. The Planner (every class taught) and
 * a class's own Planner tab both build their bands here.
 */
export async function plannerCourse(c: ReturnType<typeof ctx>, course: { id: string; name: string }, days: Day[]): Promise<PlannerCourse> {
  const [lessons, assignments, units, resources, plan, pickable, standards] = await Promise.all([
    listLessons(c, course.id), listAssignments(c, course.id), listUnits(c, course.id), listResources({ ...c, role: "teacher" }, course.id),
    weekPlan(c, course.id, days), plannable(c, course.id), coverage(c, course.id, todayIn(SCHOOL_TZ)),
  ]);
  // A day's presentation lesson shows on its day, not in "Not scheduled".
  const shows = await presentationLessonIds(c, course.id);
  const folder = new Map(units.map((u) => [u.id, u.path]));
  return {
    id: course.id,
    name: course.name,
    lessons: lessons.filter((l) => !shows.has(l.id)).map((l) => ({ id: l.id, title: l.title, plannedFor: l.plannedFor, version: l.version, unitId: l.unitId })),
    due: assignments.filter((a) => a.dueOn && days.includes(a.dueOn))
      .map((a) => ({ id: a.id, title: a.title, dueOn: a.dueOn!, dueAt: a.dueAt, draft: !a.published })),
    units: units.map((u) => ({ id: u.id, title: u.path, within: [...subtreeIds(units, u.id)] })),
    resources: resources.map((r) => ({ id: r.id, title: r.title })),
    plan: Object.fromEntries(plan.map((p) => [p.day, { materials: p.materials, standards: p.standards, presentation: p.presentation, lessons: p.lessons.length }])),
    pickable: pickable.map((m) => ({ key: `${m.kind}:${m.id}`, title: m.title, sub: m.sub, kind: m.kind, folder: m.unitId ? folder.get(m.unitId) ?? "" : "" })),
    // Coverage status so the planner offers what is still to cover first.
    standards: standards.rows.map((x) => ({ id: x.id, code: x.code, description: x.description, status: x.status, set: x.set, strand: x.strand })),
  };
}
