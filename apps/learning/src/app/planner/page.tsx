import Link from "next/link";
import { requireMe, myClasses } from "@/lib/auth";
import { myCourses } from "@/lib/courses";
import { ctx, lang } from "@/lib/access";
import { addDays, parseDay, schoolWeek, todayIn } from "@/lib/planner";
import { plannerCourse, SCHOOL_TZ } from "@/lib/planner-data";
import { dict } from "@/lib/i18n";
import { noteTeacherName } from "@/lib/school-plans";
import { TopBar } from "@/components/TopBar";
import WeekPlanner from "@/components/WeekPlanner";
import { addLesson, planAction, presentAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * The Planner: every course a teacher teaches, Monday to Friday, with
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
  if (teaching.length) await noteTeacherName(me.tenantId, me.id, me.name).catch(() => {});
  const c = ctx(me);

  const courses = await Promise.all(teaching.map((course) => plannerCourse(c, course, days)));

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
          : <WeekPlanner courses={courses} days={days} today={today} L={L} d={d} addLesson={addLesson} planAction={planAction} presentAction={presentAction} back={week ? `/planner?week=${days[0]}` : "/planner"} />}
      </main>
    </>
  );
}
