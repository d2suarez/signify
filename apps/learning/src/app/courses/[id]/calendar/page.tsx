import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMe } from "@/lib/auth";
import { courseAccess, ctx, lang } from "@/lib/access";
import { listLessons } from "@/lib/lessons";
import { listAssignments } from "@/lib/assignments";
import { dict } from "@/lib/i18n";
import { TopBar } from "@/components/TopBar";
import { ClassHeader } from "@/components/ClassHeader";
import CourseCalendar, { type CalendarItem } from "@/components/CourseCalendar";
import { coverage } from "@/lib/course-standards";
import { todayIn } from "@/lib/planner";

export const dynamic = "force-dynamic";

/**
 * The class calendar. Teachers see planned lessons and every assignment's due
 * date (drafts marked); students see published assignments only — a lesson
 * stays the teacher's plan until it's presented.
 */
export default async function CalendarPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ standards?: string }> }) {
  await requireMe();
  const { id } = await params;
  const showStandards = (await searchParams).standards === "1";
  const L = await lang();
  const d = dict(L);
  const access = await courseAccess(id);
  if (!access) notFound();
  const { me, course } = access;
  const c = ctx(me);
  const teacher = course.role === "teacher";
  const [lessons, assignments] = await Promise.all([
    teacher ? listLessons(c, course.id) : Promise.resolve([]),
    listAssignments(c, course.id, { publishedOnly: !teacher }),
  ]);
  // "See the standards I cover" (Desmond, 2026-11-23): each day's standards, taught, assessed or planned.
  let standardsByDay: Record<string, { code: string; description: string }[]> | undefined;
  if (teacher && showStandards && course.kind !== "club") {
    const cov = await coverage(c, course.id, todayIn("America/New_York"));
    const byId = new Map(cov.rows.map((r) => [r.id, { code: r.code, description: r.description }]));
    standardsByDay = Object.fromEntries(Object.entries(cov.byDay).map(([day, ids]) => [day, ids.map((x) => byId.get(x)!).filter(Boolean)]));
  }
  const items: CalendarItem[] = [
    ...lessons.filter((l) => l.plannedFor).map((l) => ({ kind: "lesson" as const, id: l.id, title: l.title, day: l.plannedFor!, href: `/lessons/${l.id}/edit` })),
    ...assignments.filter((a) => a.dueOn).map((a) => ({
      kind: "assignment" as const, id: a.id, title: a.title, day: a.dueOn!, dueAt: a.dueAt, href: `/assignments/${a.id}`, draft: teacher && !a.published,
    })),
  ];
  return (
    <>
      <TopBar crumbs={<Link href="/">{d.myCourses}</Link>} below={<ClassHeader course={course} d={d} tab="calendar" heading />} />
      <main className="page stack">
        {teacher && course.kind !== "club" && (
          <p style={{ margin: 0 }}>
            <Link className="btn btn-sm" href={showStandards ? `/courses/${course.id}/calendar` : `/courses/${course.id}/calendar?standards=1`} aria-pressed={showStandards}>
              {showStandards ? `✓ ${d.csCalShowing}` : d.csCalShow}
            </Link>
          </p>
        )}
        <CourseCalendar items={items} teacher={teacher} L={L} d={d} standardsByDay={standardsByDay} />
      </main>
    </>
  );
}
