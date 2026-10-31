import Link from "next/link";
import { notFound } from "next/navigation";
import { ctx, lang } from "@/lib/access";
import { previewFor } from "@/lib/preview";
import { studentWork } from "@/lib/family";
import { gpaText } from "@/lib/grade-scale";
import { dict } from "@/lib/i18n";
import { PreviewFrame, PreviewFailed } from "@/components/Preview";
import { CourseWorkCard } from "@/components/Work";

export const dynamic = "force-dynamic";

/**
 * Every course grade the practice student sees: released grades only, the
 * school's letter scale and GPA points for the course's band, and the score
 * that counts after any late penalty (the same builder the parent view uses).
 */
export default async function PreviewGrades({ params }: { params: Promise<{ personId: string }> }) {
  const { personId } = await params;
  const L = await lang();
  const d = dict(L);
  const p = await previewFor(personId, "grades");
  if (p === "failed") return <PreviewFailed d={d} retry={`/preview/${personId}/grades`} />;
  const { me, who, base } = p;
  if (who.kind !== "student") notFound();
  const work = await studentWork(ctx(me), who.classes, who.id);

  return (
    <PreviewFrame p={p} d={d}>
      <h1 style={{ fontSize: 34 }}>{d.previewGradesTitle}</h1>
      <p className="muted" style={{ margin: 0 }}>{d.previewGradesHint}</p>
      {work.length === 0 && <p className="empty">{d.previewNoCourses}</p>}
      {work.length > 0 && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th scope="col">{d.previewCourse}</th><th scope="col">{d.courseGrade}</th><th scope="col">{d.latePenalty}</th></tr></thead>
            <tbody>
              {work.map((w) => {
                const late = w.items.filter((i) => i.lateTaken).length;
                return (
                  <tr key={w.course.id}>
                    <td><Link href={`${base}/courses/${w.course.id}`}>{w.course.name}</Link></td>
                    <td>{w.whole === null ? <span className="muted">{d.noGradeYet}</span> : <b>{w.whole}% · {w.letter}{w.gpa == null ? "" : ` · ${d.gpaShort.replace("{n}", gpaText(w.gpa))}`}</b>}</td>
                    <td>{late === 0 ? "—" : (late === 1 ? d.previewLatePenalties : d.previewLatePenaltiesMany).replace("{n}", String(late))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {work.map((w) => <CourseWorkCard key={w.course.id} w={w} d={d} L={L} />)}
    </PreviewFrame>
  );
}
