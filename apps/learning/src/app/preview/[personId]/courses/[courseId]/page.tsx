import Link from "next/link";
import { notFound } from "next/navigation";
import { ctx, lang } from "@/lib/access";
import { courseFor } from "@/lib/courses";
import { previewFor } from "@/lib/preview";
import { dict } from "@/lib/i18n";
import { PreviewFrame, PreviewFailed } from "@/components/Preview";
import { StudentCourse } from "@/components/StudentCourse";

export const dynamic = "force-dynamic";

/** A course page exactly as the practice student sees it, read-only. */
export default async function PreviewCourse({ params }: { params: Promise<{ personId: string; courseId: string }> }) {
  const { personId, courseId } = await params;
  const L = await lang();
  const d = dict(L);
  const p = await previewFor(personId, `course ${courseId}`);
  if (p === "failed") return <PreviewFailed d={d} retry={`/preview/${personId}/courses/${courseId}`} />;
  const { me, who, base } = p;
  if (who.kind !== "student") notFound();
  // The course must be one of the student's own classes in Signify ID.
  const course = await courseFor(me.tenantId, courseId, who.classes);
  if (!course || course.role !== "student") notFound();
  return (
    <PreviewFrame p={p} d={d} crumbs={<><Link href={base}>{who.display_name}</Link><span aria-hidden="true"> / </span><span>{course.name}</span></>}>
      <StudentCourse course={course} c={ctx(me)} person={{ id: who.id, name: who.display_name }} L={L} previewBase={base} />
    </PreviewFrame>
  );
}
