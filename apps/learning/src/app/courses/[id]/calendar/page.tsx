import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMe } from "@/lib/auth";
import { courseAccess, ctx, lang } from "@/lib/access";
import { listLessons } from "@/lib/lessons";
import { listAssignments } from "@/lib/assignments";
import { dict } from "@/lib/i18n";
import { TopBar } from "@/components/TopBar";
import { CourseNav } from "@/components/CourseNav";
import CourseCalendar, { type CalendarItem } from "@/components/CourseCalendar";

export const dynamic = "force-dynamic";

/**
 * The class calendar. Teachers see planned lessons and every assignment's due
 * date (drafts marked); students see published assignments only — a lesson
 * stays the teacher's plan until it's presented.
 */
export default async function CalendarPage({ params }: { params: Promise<{ id: string }> }) {
  await requireMe();
  const { id } = await params;
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
  const items: CalendarItem[] = [
    ...lessons.filter((l) => l.plannedFor).map((l) => ({ kind: "lesson" as const, id: l.id, title: l.title, day: l.plannedFor!, href: `/lessons/${l.id}/edit` })),
    ...assignments.filter((a) => a.dueOn).map((a) => ({
      kind: "assignment" as const, id: a.id, title: a.title, day: a.dueOn!, dueAt: a.dueAt, href: `/assignments/${a.id}`, draft: teacher && !a.published,
    })),
  ];
  return (
    <>
      <TopBar crumbs={<><Link href="/">{d.myCourses}</Link> · <Link href={`/courses/${course.id}`}>{course.name}</Link></>} />
      <main className="page stack">
        <div>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>{course.subject}</p>
          <h1 style={{ fontSize: 34 }}>{course.name}</h1>
        </div>
        {teacher && <CourseNav courseId={course.id} current="calendar" d={d} />}
        <CourseCalendar items={items} teacher={teacher} L={L} d={d} />
      </main>
    </>
  );
}
