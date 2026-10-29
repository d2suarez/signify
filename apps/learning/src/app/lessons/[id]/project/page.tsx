import { notFound } from "next/navigation";
import { requireMe } from "@/lib/auth";
import { lessonAccess, lang, studentsOf } from "@/lib/access";
import { dict } from "@/lib/i18n";
import { signTicket } from "@/lib/live-ticket";
import Projector from "@/components/Projector";

export const dynamic = "force-dynamic";

/**
 * The projector view: the slide on screen, nothing else, for the classroom
 * display. Opened by the teacher from the presenter; it watches the live
 * lesson and never moves it.
 */
export default async function ProjectLesson({ params }: { params: Promise<{ id: string }> }) {
  await requireMe();
  const { id } = await params;
  const L = await lang();
  const access = await lessonAccess(id);
  if (!access || access.course.role !== "teacher") notFound();
  const { me, course, lesson } = access;
  const ticket = signTicket({ sub: me.id, name: me.name, course: course.id, role: "teacher", lesson: lesson.id });
  // A picked name shows on the class screen, as on Teacher's Desk; whole-class pickers need ID's list for the name.
  const roster = lesson.blocks.some((b) => b.type === "picker" && b.from === "class")
    ? await studentsOf(access).then(({ students }) => students.map((s) => ({ id: s.id, name: s.name })))
    : [];
  return (
    <Projector lesson={{ id: lesson.id, title: lesson.title, version: lesson.version, blocks: lesson.blocks }}
      courseId={course.id} ticket={ticket} roster={roster} d={dict(L)} />
  );
}
