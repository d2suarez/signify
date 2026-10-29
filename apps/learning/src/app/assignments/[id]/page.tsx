import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMe } from "@/lib/auth";
import { assignmentAccess, ctx, lang } from "@/lib/access";
import { getSubmission } from "@/lib/assignments";
import { gradesFor, listCategories } from "@/lib/grades";
import { listUnits } from "@/lib/units";
import { dict } from "@/lib/i18n";
import { TopBar } from "@/components/TopBar";
import { When } from "@/components/When";
import AssignmentEditor from "@/components/AssignmentEditor";
import SubmissionEditor from "@/components/SubmissionEditor";
import ReadAloud from "@/components/ReadAloud";
import RubricView from "@/components/RubricView";

export const dynamic = "force-dynamic";

export default async function AssignmentPage({ params }: { params: Promise<{ id: string }> }) {
  await requireMe();
  const { id } = await params;
  const L = await lang();
  const d = dict(L);
  const access = await assignmentAccess(id);
  if (!access) notFound();
  const { me, course, assignment: a } = access;
  const c = ctx(me);
  const crumbs = <><Link href="/">{d.myCourses}</Link> · <Link href={`/courses/${course.id}`}>{course.name}</Link></>;

  if (course.role === "teacher") {
    const [units, categories] = await Promise.all([listUnits(c, course.id), listCategories(c, course.id)]);
    return (
      <>
        <TopBar crumbs={crumbs} />
        <main className="page">
          <AssignmentEditor initial={a} d={d}
            units={units.map((u) => ({ id: u.id, name: u.title }))}
            categories={categories.map((k) => ({ id: k.id, name: k.name }))} />
        </main>
      </>
    );
  }

  // A student: their own work, and their grade once it's released.
  const [submission, grades] = await Promise.all([getSubmission(c, a.id, me.id), gradesFor(c, a.id)]);
  const mine = grades.find((g) => g.studentId === me.id) || null;
  const shown = a.gradesReleased ? mine : null;
  const locked = !!mine && (mine.score !== null || mine.flag === "exempt");

  return (
    <>
      <TopBar crumbs={crumbs} />
      <main className="page stack" style={{ maxWidth: 860 }}>
        <div>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>
            {a.dueAt ? <>{d.due} <When iso={a.dueAt} lang={L} /></> : d.noDue} · {a.points} {d.pts}
          </p>
          <h1 style={{ fontSize: 34 }}>{a.title}</h1>
        </div>
        {!a.instructions && <ReadAloud text={a.title} d={d} />}

        {shown && (shown.score !== null || shown.flag || shown.comment) && (
          <section className="card" aria-labelledby="your-grade">
            <p className="label" id="your-grade">{d.yourGrade}</p>
            <p style={{ fontFamily: "var(--display)", fontSize: 30, fontWeight: 800, margin: "6px 0 0" }}>
              {shown.flag === "exempt" ? d.exempt
                : shown.score !== null ? `${shown.score} / ${a.points}`
                : shown.flag === "missing" ? d.missing : ""}
              {shown.flag === "late" && <span className="chip chip-late" style={{ marginLeft: 10, verticalAlign: "middle" }}>{d.late}</span>}
            </p>
            {shown.comment && (
              <div style={{ marginTop: 10 }}>
                <p className="label">{d.teacherComment}</p>
                <p style={{ whiteSpace: "pre-wrap", margin: "4px 0 0" }}>{shown.comment}</p>
              </div>
            )}
          </section>
        )}

        {a.instructions && (
          <section className="card stack" style={{ gap: 8 }}>
            <p className="label">{d.instructions}</p>
            <ReadAloud text={`${a.title}.\n${a.instructions}`} d={d} />
            <div className="body-text" style={{ whiteSpace: "pre-wrap", fontSize: 17, lineHeight: 1.6 }}>{a.instructions}</div>
          </section>
        )}

        {a.rubric && (
          <section className="card stack" style={{ gap: 8 }} aria-labelledby="rubric-title">
            <p className="label" id="rubric-title">{shown?.rubric ? d.rubricYours : d.rubricHowGraded}</p>
            <RubricView rubric={a.rubric} selection={shown?.rubric ?? null} d={d} />
          </section>
        )}

        {a.kind === "online"
          ? <section className="card"><SubmissionEditor assignmentId={a.id} initial={submission} locked={locked} d={d} /></section>
          : <p className="notice">{d.paperAssignment}</p>}
      </main>
    </>
  );
}
