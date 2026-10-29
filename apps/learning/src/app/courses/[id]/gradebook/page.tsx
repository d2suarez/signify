import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMe } from "@/lib/auth";
import { courseAccess, ctx, isSchoolAdmin, lang, studentsOf } from "@/lib/access";
import { buildGradebook, periodOn } from "@/lib/gradebook";
import { listPeriods } from "@/lib/grades";
import { dict } from "@/lib/i18n";
import { TopBar } from "@/components/TopBar";
import { CourseNav } from "@/components/CourseNav";
import GradebookGrid from "@/components/GradebookGrid";

export const dynamic = "force-dynamic";

/** "Oct 20" from "2026-10-20" (a calendar day, so no time zone applies). */
function shortDay(day: string, L: string) {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(L === "es" ? "es" : "en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export default async function GradebookPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ period?: string }>;
}) {
  await requireMe();
  const { id } = await params;
  const sp = await searchParams;
  const L = await lang();
  const d = dict(L);
  const access = await courseAccess(id);
  if (!access || access.course.role !== "teacher") notFound();
  const { me, course } = access;

  const periods = await listPeriods(me.tenantId);
  // The period asked for; else the one today is in; else the whole year.
  const period = sp.period === "year" ? null
    : periods.find((p) => p.id === sp.period) ?? periodOn(periods, new Date().toISOString().slice(0, 10));
  const { ok, students } = await studentsOf(access);
  const gb = await buildGradebook(ctx(me), course.id, students, period);

  return (
    <>
      <TopBar crumbs={<><Link href="/">{d.myCourses}</Link> · <Link href={`/courses/${course.id}`}>{course.name}</Link></>} />
      <main className="page page-wide stack">
        <div className="row" style={{ alignItems: "flex-end" }}>
          <div className="grow" style={{ flex: 1 }}>
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>{course.name} · {d.gradebook}</p>
            <h1 style={{ fontSize: 30 }}>{period ? `${period.name} · ${shortDay(period.startsOn, L)} – ${shortDay(period.endsOn, L)}` : d.wholeYear}</h1>
          </div>
          <nav className="seg" aria-label={d.period}>
            {periods.map((p) => (
              <Link key={p.id} href={`?period=${p.id}`} aria-current={period?.id === p.id ? "page" : undefined} className="seg-link">{p.name}</Link>
            ))}
            <Link href="?period=year" aria-current={!period ? "page" : undefined} className="seg-link">{d.wholeYear}</Link>
          </nav>
        </div>
        <CourseNav courseId={course.id} current="gradebook" d={d} />

        {periods.length === 0 && (
          <p className="notice">
            {d.noPeriods} {isSchoolAdmin(me) && <Link href="/school/periods">{d.setPeriods}</Link>}
          </p>
        )}
        {!ok && <div className="notice notice-bad" role="alert">{d.rosterFailed}</div>}
        {ok && students.length === 0 && <p className="empty">{d.noStudents}</p>}
        {ok && students.length > 0 && (
          <GradebookGrid
            key={period?.id || "year"}
            courseId={course.id}
            periodKey={period?.id || "year"}
            periodLabel={period ? period.name : d.wholeYear}
            weighted={gb.weighted}
            categories={gb.categories}
            assignments={gb.assignments.map((a) => ({ id: a.id, title: a.title, points: a.points, categoryId: a.categoryId, dueOn: a.dueOn, published: a.published }))}
            rows={gb.rows.map((r) => ({ id: r.student.id, name: r.student.name, factsName: r.student.factsName, cells: r.cells }))}
            noDueDate={gb.checks.noDueDate}
            uncategorized={gb.checks.uncategorized}
            d={d}
          />
        )}
      </main>
    </>
  );
}
