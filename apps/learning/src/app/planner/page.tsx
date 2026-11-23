import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireMe, myClasses } from "@/lib/auth";
import { myCourses } from "@/lib/courses";
import { courseAccess, ctx, lang } from "@/lib/access";
import { listLessons, createLesson, saveLesson } from "@/lib/lessons";
import { listAssignments } from "@/lib/assignments";
import { listUnits, subtreeIds } from "@/lib/units";
import { listResources, blocksFromResources } from "@/lib/resources";
import { listStandards } from "@/lib/standards";
import { weekPlan, plannable, presentDay, presentationLessonIds, planMaterial, unplanMaterial, movePlanItem, addDayStandard, removeDayStandard, PlanError } from "@/lib/week-plan";
import { addDays, isSchoolDay, parseDay, schoolWeek, todayIn } from "@/lib/planner";
import { dict } from "@/lib/i18n";
import { TopBar } from "@/components/TopBar";
import WeekPlanner, { type PlannerCourse } from "@/components/WeekPlanner";

export const dynamic = "force-dynamic";

/** The school's own day. One school for now; a per-school setting comes with multi-school. */
const SCHOOL_TZ = "America/New_York";

/** Quick-add: a new lesson already planned for the day it was added on. */
async function addLesson(formData: FormData) {
  "use server";
  const access = await courseAccess(String(formData.get("courseId") || ""));
  if (!access || access.course.role !== "teacher") return;
  const day = parseDay(formData.get("day"));
  if (!day || !isSchoolDay(day)) return;
  const c = ctx(access.me);
  // "Start from" a class resource: its block(s) copied in, as the editor's "Add from class resources" does.
  const resource = String(formData.get("resource") || "");
  const blocks = resource ? await blocksFromResources({ ...c, role: "teacher" }, access.course.id, [resource]) : [];
  const lesson = await createLesson(c, access.course.id, String(formData.get("title") || ""), blocks);
  await saveLesson(c, lesson.id, { baseVersion: lesson.version, plannedFor: day });
  revalidatePath("/planner");
}

/**
 * Picking materials and standards onto a day (story 01, B1/B2). One action,
 * `op` says which: pick (kind:id), unpick / move (a plan item), std / unstd.
 * Only the course's teachers; the lib scopes every write to the course.
 */
async function planAction(formData: FormData): Promise<{ error?: string }> {
  "use server";
  const access = await courseAccess(String(formData.get("courseId") || ""));
  if (!access || access.course.role !== "teacher") return { error: "forbidden" };
  const c = ctx(access.me);
  const course = access.course.id;
  const day = formData.get("day");
  try {
    switch (String(formData.get("op"))) {
      case "pick": {
        const [kind, id] = String(formData.get("pick") || "").split(":");
        await planMaterial(c, course, day, kind, id);
        break;
      }
      case "unpick": await unplanMaterial(c, course, formData.get("item")); break;
      case "move": await movePlanItem(c, course, formData.get("item"), day); break;
      case "std": await addDayStandard(c, course, day, formData.get("standard")); break;
      case "unstd": await removeDayStandard(c, course, day, formData.get("standard")); break;
      default: return { error: "missing" };
    }
  } catch (e) {
    if (e instanceof PlanError) return { error: e.code };
    throw e;
  }
  revalidatePath("/planner");
  return {};
}

/**
 * "Present this day" (story 01, B3): the day's lessons and picked materials
 * become one lesson (or the one there was), opened in the live presenter,
 * the same path as Resources' "Present ticked". `again` makes it anew.
 */
async function presentAction(formData: FormData) {
  "use server";
  const access = await courseAccess(String(formData.get("courseId") || ""));
  if (!access || access.course.role !== "teacher") return;
  const title = String(formData.get("title") || "").trim().slice(0, 200) || "Presentation";
  let id: string | null = null;
  try {
    id = await presentDay(ctx(access.me), access.course.id, formData.get("day"), title, formData.get("again") === "1");
  } catch (e) {
    if (!(e instanceof PlanError)) throw e;
  }
  if (!id) redirect("/planner");
  redirect(formData.get("op") === "edit" ? `/lessons/${id}/edit` : `/lessons/${id}/present`);
}

/**
 * The week planner: every course a teacher teaches, Monday to Friday, with
 * the lessons planned for each day and the work due. Lessons move by drag or
 * by a "Move to" list (keyboard and phone); each move is one version-checked
 * save, the same as the lesson editor's, so nothing is written over.
 */
export default async function PlannerPage({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  const me = await requireMe();
  const L = await lang();
  const d = dict(L);
  const { week } = await searchParams;
  const today = todayIn(SCHOOL_TZ);
  const days = schoolWeek(parseDay(week) ?? today);
  const { ok, classes } = await myClasses();
  const teaching = (await myCourses(me.tenantId, classes, me.id)).filter((c) => c.role === "teacher");
  const c = ctx(me);

  const courses: PlannerCourse[] = await Promise.all(teaching.map(async (course) => {
    const [lessons, assignments, units, resources, plan, pickable, standards] = await Promise.all([
      listLessons(c, course.id), listAssignments(c, course.id), listUnits(c, course.id), listResources({ ...c, role: "teacher" }, course.id),
      weekPlan(c, course.id, days), plannable(c, course.id), listStandards(c, course.id),
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
      standards: standards.map((x) => ({ id: x.id, code: x.code, description: x.description })),
    };
  }));

  const locale = L === "es" ? "es" : "en-US";
  const range = `${new Date(`${days[0]}T12:00:00Z`).toLocaleDateString(locale, { month: "long", day: "numeric", timeZone: "UTC" })} – ${new Date(`${days[4]}T12:00:00Z`).toLocaleDateString(locale, { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}`;

  return (
    <>
      <TopBar crumbs={<Link href="/">{d.myCourses}</Link>} />
      <main className="page page-wide stack">
        <div className="row">
          <div className="grow">
            <h1 style={{ fontSize: 34 }}>{d.planner}</h1>
            <p className="muted" style={{ margin: 0 }} aria-live="polite">{range}</p>
          </div>
          <nav className="row" aria-label={d.planner}>
            <Link className="btn btn-sm" href={`/planner?week=${addDays(days[0], -7)}`}>← {d.previousWeek}</Link>
            <Link className="btn btn-sm" href="/planner" aria-current={days.includes(today) ? "page" : undefined}>{d.thisWeek}</Link>
            <Link className="btn btn-sm" href={`/planner?week=${addDays(days[0], 7)}`}>{d.nextWeek} →</Link>
          </nav>
        </div>
        {!ok && <div className="notice notice-bad" role="alert">{d.classesFailed} <a href="/planner">{d.tryAgain}</a></div>}
        {ok && courses.length === 0
          ? <p className="empty">{d.plannerEmpty}</p>
          : <WeekPlanner courses={courses} days={days} today={today} L={L} d={d} addLesson={addLesson} planAction={planAction} presentAction={presentAction} />}
      </main>
    </>
  );
}
