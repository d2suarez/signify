import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMe } from "@/lib/auth";
import { isSchoolAdmin, lang } from "@/lib/access";
import { dict } from "@/lib/i18n";
import { principalView } from "@/lib/school-plans";
import { TopBar } from "@/components/TopBar";
import { When } from "@/components/When";
import LessonReader from "@/components/LessonReader";
import Instructions from "@/components/Instructions";
import RubricView from "@/components/RubricView";

export const dynamic = "force-dynamic";

/**
 * One planned material as the principal reads it (B4): read-only, this
 * school only, school admins only. A lesson's slides as students see them,
 * an assignment's instructions and rubric (a quiz's questions and key are
 * never shown here), a folder material's content.
 */
export default async function PrincipalMaterialPage({ params }: { params: Promise<{ kind: string; id: string }> }) {
  const me = await requireMe();
  const L = await lang();
  const d = dict(L);
  if (!isSchoolAdmin(me)) notFound();
  const { kind, id } = await params;
  const v = await principalView(me.tenantId, kind, id);
  if (!v) notFound();
  return (
    <>
      <TopBar crumbs={<><Link href="/">{d.myCourses}</Link> · <Link href="/school/plans">{d.spTitle}</Link></>} />
      <main className="page stack" style={{ maxWidth: 860 }}>
        <div>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>
            {v.className} · {v.kind === "lesson" ? d.lesson : v.kind === "assignment" ? (v.quiz ? d.kindQuiz : d.pcKindAssignment) : d.matMaterial}
            {v.kind === "assignment" && <> · {v.dueAt ? <>{d.due} <When iso={v.dueAt} lang={L} /></> : d.noDue} · {v.points} {d.pts}{!v.published && ` · ${d.draft}`}</>}
            {v.kind === "resource" && !v.visible && ` · ${d.pcHiddenFromStudents}`}
          </p>
          <h1 style={{ fontSize: 32 }}>{v.title || d.untitled}</h1>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.spReadOnly}</p>
        </div>
        {v.kind === "assignment" ? (
          <>
            {v.instructions
              ? <section className="card stack" style={{ gap: 8 }}><p className="label">{d.instructions}</p><Instructions text={v.instructions} doc={v.doc} d={d} L={L} /></section>
              : <p className="empty">{d.spNoInstructions}</p>}
            {v.quiz && <p className="muted" style={{ margin: 0 }}>{d.spQuizHidden}</p>}
            {v.rubric && <section className="card stack" style={{ gap: 8 }}><p className="label">{d.rubricHowGraded}</p><RubricView rubric={v.rubric} selection={null} d={d} /></section>}
          </>
        ) : <LessonReader blocks={v.blocks} d={d} />}
      </main>
    </>
  );
}
