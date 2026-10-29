import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMe } from "@/lib/auth";
import { lessonAccess, lang } from "@/lib/access";
import { dict, t } from "@/lib/i18n";
import { TopBar } from "@/components/TopBar";
import LessonEditor from "@/components/LessonEditor";

export const dynamic = "force-dynamic";

export default async function EditLesson({ params }: { params: Promise<{ id: string }> }) {
  await requireMe();
  const { id } = await params;
  const L = await lang();
  const access = await lessonAccess(id);
  if (!access || access.course.role !== "teacher") notFound();
  const { course, lesson } = access;
  return (
    <>
      <TopBar crumbs={<><Link href="/">{t("myCourses", L)}</Link> · <Link href={`/courses/${course.id}`}>{course.name}</Link></>} />
      <main className="page">
        <LessonEditor initial={lesson} courseId={course.id} d={dict(L)} />
      </main>
    </>
  );
}
