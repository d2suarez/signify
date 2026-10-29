import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMe } from "@/lib/auth";
import { assignmentAccess, ctx, lang } from "@/lib/access";
import { getSubmission } from "@/lib/assignments";
import { gradesFor, listCategories } from "@/lib/grades";
import { listUnits } from "@/lib/units";
import { courseGrading, listStandards } from "@/lib/standards";
import { dict } from "@/lib/i18n";
import { TopBar } from "@/components/TopBar";
import { When } from "@/components/When";
import AssignmentEditor from "@/components/AssignmentEditor";
import SubmissionEditor from "@/components/SubmissionEditor";
import ReadAloud from "@/components/ReadAloud";
import RubricView from "@/components/RubricView";
import SchoologyScores from "@/components/SchoologyScores";
import { placements } from "@/lib/lti-dl";
import { StandardsList } from "@/components/Work";
import type { StandardsView } from "@/lib/gradebook";
import { alignedStandards } from "@/lib/standards-math";
import QuizTaker from "@/components/QuizTaker";
import { attemptsOf, closeExpired, QUIZ_GRADER, studentQuiz, syncGrade } from "@/lib/quiz-store";
import { closeQuizForTeacher } from "@/lib/quiz-sync";
import { passBack } from "@/lib/lti-passback";
import { syncMyToolScore, syncToolScores } from "@/lib/lti-tool-sync";
import { linkForAssignment, getTool } from "@/lib/lti-platform";
import { toolScores } from "@/lib/lti-platform-ags";

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
    await closeQuizForTeacher(access);
    await syncToolScores(access, [a]);
    const toolLink = await linkForAssignment(me.tenantId, a.id);
    const tool = toolLink ? await getTool(me.tenantId, toolLink.toolId) : null;
    const sent = toolLink ? await toolScores(me.tenantId, a.id) : [];
    const [units, categories, placed, grading, standards, attempts] = await Promise.all([
      listUnits(c, course.id), listCategories(c, course.id), placements(me.tenantId, "assignment", a.id),
      courseGrading(c, course.id), listStandards(c, course.id), a.kind === "quiz" ? attemptsOf(c, a.id) : Promise.resolve([]),
    ]);
    return (
      <>
        <TopBar crumbs={crumbs} />
        <main className="page">
          <AssignmentEditor initial={a} d={d}
            units={units.map((u) => ({ id: u.id, name: u.title }))}
            categories={categories.map((k) => ({ id: k.id, name: k.name }))}
            standards={grading.mode === "standards" ? standards.map((s) => ({ id: s.id, name: s.code, description: s.description })) : undefined}
            attempted={new Set(attempts.filter((x) => x.submittedAt).map((x) => x.studentId)).size} />
          {toolLink && (
            <section className="card stack" style={{ marginTop: 24, gap: 8 }} aria-labelledby="tool-title">
              <h2 id="tool-title" className="label"><span className="shape s-square" style={{ marginRight: 8 }} />{d.toolFrom}: {tool?.name ?? d.toolRemovedShort}</h2>
              <p className="muted" style={{ margin: 0 }}>{d.toolAssignmentHint}</p>
              <p className="muted" style={{ margin: 0, fontSize: 14 }}>
                {d.toolScoresWritten}: {sent.filter((s) => s.status === "written").length} · {d.toolScoresWaiting}: {sent.filter((s) => s.status === "waiting").length}
                {sent.some((s) => s.status === "refused") && <> · {d.toolScoresRefused}: {sent.filter((s) => s.status === "refused").length}</>}
              </p>
              {tool && <div><a className="btn" href={`/lti/tool/launch?link=${toolLink.id}&target=window`} target="_blank" rel="noopener">{d.toolOpen} ↗</a></div>}
            </section>
          )}
          {placed.length > 0 && <div style={{ marginTop: 24 }}><SchoologyScores assignmentId={a.id} d={d} /></div>}
        </main>
      </>
    );
  }

  // A student: their own work, and their grade once it's released.
  // A quiz attempt left open past its time is handed in now, with what was saved.
  if (a.kind === "quiz" && (await closeExpired(c, a, me.id)).length) {
    if (await syncGrade({ tenantId: me.tenantId, userId: QUIZ_GRADER }, a, me.id, new Set([me.id]))) await passBack(access, me.id);
  }
  await syncMyToolScore(access, a);
  const toolLink = await linkForAssignment(me.tenantId, a.id);
  const quizView = a.kind === "quiz" ? await studentQuiz(c, a) : null;
  const [submission, grades, grading, allStandards] = await Promise.all([
    getSubmission(c, a.id, me.id), gradesFor(c, a.id), courseGrading(c, course.id), listStandards(c, course.id),
  ]);
  const mine = grades.find((g) => g.studentId === me.id) || null;
  const shown = a.gradesReleased ? mine : null;
  const locked = !!mine && (mine.score !== null || mine.flag === "exempt");
  // A standards course: the standards this measures, with the student's level once released.
  const aligned = grading.mode === "standards" ? alignedStandards(a) : [];
  const levelsView: StandardsView | null = aligned.length ? {
    settings: grading.settings,
    list: allStandards.filter((s) => aligned.includes(s.id))
      .map((s) => ({ id: s.id, code: s.code, description: s.description, level: shown?.flag === "exempt" ? null : shown?.levels?.[s.id] ?? null })),
  } : null;

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

        {levelsView && <section className="card"><StandardsList view={levelsView} d={d} id="a-standards" /></section>}
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

        {quizView
          ? <QuizTaker assignmentId={a.id} initial={quizView} points={a.points} d={d} />
          : a.kind === "online"
          ? <section className="card"><SubmissionEditor assignmentId={a.id} initial={submission} locked={locked} d={d} /></section>
          : toolLink
          ? <section className="card stack" style={{ gap: 8 }}><p style={{ margin: 0 }}>{d.toolStudentHint}</p>
              <div><a className="btn btn-primary" href={`/lti/tool/launch?link=${toolLink.id}&target=window`} target="_blank" rel="noopener">{d.toolOpen} ↗</a></div></section>
          : <p className="notice">{d.paperAssignment}</p>}
      </main>
    </>
  );
}
