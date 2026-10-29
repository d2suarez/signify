import Link from "next/link";
import { revalidatePath } from "next/cache";
import { requireMe, myClasses } from "@/lib/auth";
import { myCourses } from "@/lib/courses";
import { courseAccess, ctx, lang } from "@/lib/access";
import { listLessons, createLesson, saveLesson } from "@/lib/lessons";
import { listAssignments } from "@/lib/assignments";
import { listUnits } from "@/lib/units";
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
  const lesson = await createLesson(c, access.course.id, String(formData.get("title") || ""));
  await saveLesson(c, lesson.id, { baseVersion: lesson.version, plannedFor: day });
  revalidatePath("/planner");
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
  const teaching = (await myCourses(me.tenantId, classes)).filter((c) => c.role === "teacher");
  const c = ctx(me);

  const courses: PlannerCourse[] = await Promise.all(teaching.map(async (course) => {
    const [lessons, assignments, units] = await Promise.all([
      listLessons(c, course.id), listAssignments(c, course.id), listUnits(c, course.id),
    ]);
    return {
      id: course.id,
      name: course.name,
      lessons: lessons.map((l) => ({ id: l.id, title: l.title, plannedFor: l.plannedFor, version: l.version, unitId: l.unitId })),
      due: assignments.filter((a) => a.dueOn && days.includes(a.dueOn))
        .map((a) => ({ id: a.id, title: a.title, dueOn: a.dueOn!, dueAt: a.dueAt, draft: !a.published })),
      units: units.map((u) => ({ id: u.id, title: u.title })),
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
          : <WeekPlanner courses={courses} days={days} today={today} L={L} d={d} addLesson={addLesson} />}
      </main>
    </>
  );
}
