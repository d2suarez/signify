import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMe } from "@/lib/auth";
import { lessonAccess, lang, ctx } from "@/lib/access";
import { listUnits, unitChoices } from "@/lib/units";
import { dict, t } from "@/lib/i18n";
import { TopBar } from "@/components/TopBar";
import { ClassHeader } from "@/components/ClassHeader";
import LessonEditor from "@/components/LessonEditor";
import { toolChoices } from "@/lib/lti-platform";
import { standardOptions } from "@/lib/standards-library";
import LessonStandards from "@/components/LessonStandards";
import { resourceChoices } from "@/lib/resources";
import { listAssignments } from "@/lib/assignments";
import { listGroupSets } from "@/lib/group-sets";

export const dynamic = "force-dynamic";

export default async function EditLesson({ params }: { params: Promise<{ id: string }> }) {
  await requireMe();
  const { id } = await params;
  const L = await lang();
  const access = await lessonAccess(id);
  if (!access || access.course.role !== "teacher") notFound();
  const { course, lesson } = access;
  const [units, tools, options, resources, assignments, groupSets] = await Promise.all([
    listUnits(ctx(access.me), course.id), toolChoices(access.me.tenantId), standardOptions(ctx(access.me), course.id),
    resourceChoices({ ...ctx(access.me), role: "teacher" }, course.id), listAssignments(ctx(access.me), course.id), listGroupSets(ctx(access.me), course.id),
  ]);
  return (
    <>
      <TopBar crumbs={<Link href="/">{t("myCourses", L)}</Link>} below={<ClassHeader course={course} d={dict(L)} />} />
      <main className="page">
        <LessonEditor initial={lesson} courseId={course.id} units={unitChoices(units).map((u) => ({ id: u.id, title: u.label }))} tools={tools} resources={resources}
          assignments={assignments.map((a) => ({ id: a.id, title: a.title, kind: a.kind, published: a.published }))}
          groupSets={groupSets.map((g) => ({ id: g.id, name: g.name }))} d={dict(L)} />
        <LessonStandards lessonId={lesson.id} courseId={course.id} options={options} initial={lesson.standards ?? []} d={dict(L)} />
      </main>
    </>
  );
}
