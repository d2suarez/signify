import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMe } from "@/lib/auth";
import { lessonAccess, lang, ctx } from "@/lib/access";
import { listUnits } from "@/lib/units";
import { dict, t } from "@/lib/i18n";
import { TopBar } from "@/components/TopBar";
import LessonEditor from "@/components/LessonEditor";
import { toolChoices } from "@/lib/lti-platform";
import { standardOptions } from "@/lib/standards-library";
import LessonStandards from "@/components/LessonStandards";

export const dynamic = "force-dynamic";

export default async function EditLesson({ params }: { params: Promise<{ id: string }> }) {
  await requireMe();
  const { id } = await params;
  const L = await lang();
  const access = await lessonAccess(id);
  if (!access || access.course.role !== "teacher") notFound();
  const { course, lesson } = access;
  const [units, tools, options] = await Promise.all([listUnits(ctx(access.me), course.id), toolChoices(access.me.tenantId), standardOptions(ctx(access.me), course.id)]);
  return (
    <>
      <TopBar crumbs={<><Link href="/">{t("myCourses", L)}</Link> · <Link href={`/courses/${course.id}`}>{course.name}</Link></>} />
      <main className="page">
        <LessonEditor initial={lesson} courseId={course.id} units={units.map((u) => ({ id: u.id, title: u.title }))} tools={tools} d={dict(L)} />
        <LessonStandards lessonId={lesson.id} courseId={course.id} options={options} initial={lesson.standards ?? []} d={dict(L)} />
      </main>
    </>
  );
}
