import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMe } from "@/lib/auth";
import { lessonAccess, lang, studentsOf } from "@/lib/access";
import { dict, t } from "@/lib/i18n";
import { signTicket } from "@/lib/live-ticket";
import { TopBar } from "@/components/TopBar";
import Presenter from "@/components/Presenter";

export const dynamic = "force-dynamic";

export default async function PresentLesson({ params }: { params: Promise<{ id: string }> }) {
  await requireMe();
  const { id } = await params;
  const L = await lang();
  const access = await lessonAccess(id);
  if (!access || access.course.role !== "teacher") notFound();
  const { me, course, lesson } = access;
  const ticket = signTicket({ sub: me.id, name: me.name, course: course.id, role: "teacher", lesson: lesson.id });
  // Signify ID is asked for the class only when a name picker wants the whole class.
  const roster = lesson.blocks.some((b) => b.type === "picker" && b.from === "class")
    ? await studentsOf(access).then(({ ok, students }) => ({ ok, students: students.map((s) => ({ id: s.id, name: s.name })) }))
    : null;
  return (
    <>
      <TopBar crumbs={<><Link href="/">{t("myCourses", L)}</Link> · <Link href={`/courses/${course.id}`}>{course.name}</Link></>} />
      <main className="page">
        <Presenter
          lesson={{ id: lesson.id, title: lesson.title, version: lesson.version, blocks: lesson.blocks }}
          courseId={course.id} courseName={course.name} ticket={ticket} roster={roster} d={dict(L)} />
      </main>
    </>
  );
}
