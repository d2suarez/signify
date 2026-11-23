import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireMe } from "@/lib/auth";
import { courseAccess, ctx, lang } from "@/lib/access";
import { addDays, parseDay, schoolWeek, todayIn } from "@/lib/planner";
import { plannerCourse, SCHOOL_TZ } from "@/lib/planner-data";
import { dict } from "@/lib/i18n";
import { TopBar } from "@/components/TopBar";
import { CourseNav } from "@/components/CourseNav";
import WeekPlanner from "@/components/WeekPlanner";
import { addLesson, planAction, presentAction } from "@/app/planner/actions";

export const dynamic = "force-dynamic";

/**
 * A class's own Planner tab (Desmond, 2026-11-23): the same Planner as
 * /planner, showing only this class. Teachers only; a student goes to the class.
 */
export default async function ClassPlannerPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ week?: string }> }) {
  await requireMe();
  const [{ id }, { week }] = await Promise.all([params, searchParams]);
  const L = await lang();
  const d = dict(L);
  const access = await courseAccess(id);
  if (!access) notFound();
  const { me, course } = access;
  if (course.role !== "teacher") redirect(`/courses/${course.id}`);
  const today = todayIn(SCHOOL_TZ);
  const days = schoolWeek(parseDay(week) ?? today);
  const band = await plannerCourse(ctx(me), course, days);
  const base = `/courses/${course.id}/planner`;
  const locale = L === "es" ? "es" : "en-US";
  const range = `${new Date(`${days[0]}T12:00:00Z`).toLocaleDateString(locale, { month: "long", day: "numeric", timeZone: "UTC" })} – ${new Date(`${days[4]}T12:00:00Z`).toLocaleDateString(locale, { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
  return (
    <>
      <TopBar crumbs={<><Link href="/">{d.myCourses}</Link> · <Link href={`/courses/${course.id}`}>{course.name}</Link></>} />
      <main className="page page-wide stack">
        <div>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>{course.subject}</p>
          <h1 style={{ fontSize: 34 }}>{course.name}</h1>
        </div>
        <CourseNav courseId={course.id} current="planner" d={d} club={course.kind === "club"} />
        <div className="row">
          <div className="grow">
            <h2 style={{ fontSize: 24 }}>{d.planner}</h2>
            <p className="muted" style={{ margin: 0 }} aria-live="polite">{range}</p>
          </div>
          <nav className="row" aria-label={d.planner}>
            <Link className="btn btn-sm" href={`${base}?week=${addDays(days[0], -7)}`}>← {d.previousWeek}</Link>
            <Link className="btn btn-sm" href={base} aria-current={days.includes(today) ? "page" : undefined}>{d.thisWeek}</Link>
            <Link className="btn btn-sm" href={`${base}?week=${addDays(days[0], 7)}`}>{d.nextWeek} →</Link>
            <Link className="btn btn-sm" href={week ? `/planner?week=${days[0]}` : "/planner"}>{d.plannerAllClasses}</Link>
          </nav>
        </div>
        <WeekPlanner courses={[band]} days={days} today={today} L={L} d={d} single
          addLesson={addLesson} planAction={planAction} presentAction={presentAction} back={week ? `${base}?week=${days[0]}` : base} />
      </main>
    </>
  );
}
