import Link from "next/link";
import { notFound } from "next/navigation";
import { ctx, lang } from "@/lib/access";
import { courseFor } from "@/lib/courses";
import { previewFor } from "@/lib/preview";
import { getAssignment, getSubmission } from "@/lib/assignments";
import { gradesFor } from "@/lib/grades";
import { assignmentPenalties, type StandardsView } from "@/lib/gradebook";
import { finalScore } from "@/lib/late-policy";
import { courseGrading, listStandards } from "@/lib/standards";
import { alignedStandards } from "@/lib/standards-math";
import { studentQuiz } from "@/lib/quiz-store";
import { studentItems } from "@/lib/quiz";
import { linkForAssignment } from "@/lib/lti-platform";
import { dict } from "@/lib/i18n";
import { PreviewFrame, PreviewFailed } from "@/components/Preview";
import { When } from "@/components/When";
import { StandardsList } from "@/components/Work";
import RubricView from "@/components/RubricView";

export const dynamic = "force-dynamic";

/**
 * One assignment as the practice student sees it, read-only: their grade
 * once released (with the late penalty), the instructions and rubric, and
 * their work as plain text. A quiz shows its questions as they would see
 * them; no attempt is started and nothing is autosaved. Unlike the
 * student's own page, nothing is closed, synced or written here.
 */
export default async function PreviewAssignment({ params }: { params: Promise<{ personId: string; assignmentId: string }> }) {
  const { personId, assignmentId } = await params;
  const L = await lang();
  const d = dict(L);
  const p = await previewFor(personId, `assignment ${assignmentId}`);
  if (p === "failed") return <PreviewFailed d={d} retry={`/preview/${personId}/assignments/${assignmentId}`} />;
  const { me, who, base } = p;
  if (who.kind !== "student") notFound();
  const c = ctx(me);
  const a = await getAssignment(c, assignmentId);
  if (!a || !a.published) notFound();
  const course = await courseFor(me.tenantId, a.courseId, who.classes);
  if (!course || course.role !== "student") notFound();

  // The quiz as the student would see it: their attempts and accommodations, read only.
  const quizView = a.kind === "quiz" ? await studentQuiz({ tenantId: me.tenantId, userId: who.id }, a) : null;
  const items = a.kind === "quiz" && a.quiz ? studentItems(a.quiz, null) : [];
  const [submission, grades, grading, allStandards, toolLink] = await Promise.all([
    getSubmission(c, a.id, who.id), gradesFor(c, a.id), courseGrading(c, course.id), listStandards(c, course.id),
    linkForAssignment(me.tenantId, a.id),
  ]);
  const mine = grades.find((g) => g.studentId === who.id) || null;
  const shown = a.gradesReleased ? mine : null;
  const penalty = shown && shown.score !== null ? (await assignmentPenalties(c, a, [shown])).byStudent.get(who.id)?.penalty ?? null : null;
  const taken = penalty && penalty.points > 0 ? penalty : null;
  const aligned = grading.mode === "standards" ? alignedStandards(a) : [];
  const levelsView: StandardsView | null = aligned.length ? {
    settings: grading.settings,
    list: allStandards.filter((s) => aligned.includes(s.id))
      .map((s) => ({ id: s.id, code: s.code, description: s.description, level: shown?.flag === "exempt" ? null : shown?.levels?.[s.id] ?? null })),
  } : null;

  return (
    <PreviewFrame p={p} d={d} crumbs={<><Link href={base}>{who.display_name}</Link><span aria-hidden="true"> / </span><Link href={`${base}/courses/${course.id}`}>{course.name}</Link></>}>
      <div>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          {a.dueAt ? <>{d.due} <When iso={a.dueAt} lang={L} /></> : d.noDue} · {a.points} {d.pts}
        </p>
        <h1 style={{ fontSize: 34 }}>{a.title}</h1>
      </div>

      {levelsView && <section className="card"><StandardsList view={levelsView} d={d} id="a-standards" /></section>}
      {shown && (shown.score !== null || shown.flag || shown.comment) && (
        <section className="card" aria-labelledby="your-grade">
          <p className="label" id="your-grade">{d.yourGrade}</p>
          <p style={{ fontFamily: "var(--display)", fontSize: 30, fontWeight: 800, margin: "6px 0 0" }}>
            {shown.flag === "exempt" ? d.exempt
              : shown.score !== null ? `${taken ? finalScore(shown.score, taken) : shown.score} / ${a.points}`
              : shown.flag === "missing" ? d.missing : ""}
            {shown.flag === "late" && <span className="chip chip-late" style={{ marginLeft: 10, verticalAlign: "middle" }}>{d.late}</span>}
          </p>
          {taken && shown.score !== null && (
            <p className="muted" style={{ margin: "4px 0 0", fontSize: 14 }}>
              {d.rawScore} {shown.score} · {d.latePenalty} −{taken.percent}% ({d.schoolDaysLate}: {taken.days}) · {d.countsAs} {finalScore(shown.score, taken)}
            </p>
          )}
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
          <div className="body-text" style={{ whiteSpace: "pre-wrap", fontSize: 17, lineHeight: 1.6 }}>{a.instructions}</div>
        </section>
      )}

      {a.rubric && (
        <section className="card stack" style={{ gap: 8 }} aria-labelledby="rubric-title">
          <p className="label" id="rubric-title">{shown?.rubric ? d.rubricYours : d.rubricHowGraded}</p>
          <RubricView rubric={a.rubric} selection={shown?.rubric ?? null} d={d} />
        </section>
      )}

      {quizView ? (
        <section className="card stack" style={{ gap: 10 }} aria-labelledby="quiz-title">
          <h2 id="quiz-title" className="label">{d.quizWord}</h2>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>
            {d.previewQuizNote} {quizView.allowed === 0 ? d.quizUnlimitedAttempts : d.previewQuizAttempts.replace("{used}", String(quizView.used)).replace("{allowed}", String(quizView.allowed))}
            {quizView.minutes ? ` · ${d.previewQuizTime.replace("{n}", String(quizView.minutes))}` : ""}
          </p>
          {quizView.attempts.map((x) => (
            <p key={x.number} style={{ margin: 0 }}>
              {d.quizAttempt} {x.number}{x.submittedAt ? <> · <When iso={x.submittedAt} lang={L} /></> : null}
              {x.score !== null ? ` · ${x.score} / ${a.points}` : ""}{x.counts ? ` · ${d.quizCounts}` : ""}
            </p>
          ))}
          <ol className="stack" style={{ gap: 12, paddingLeft: 22, margin: 0 }}>
            {items.map((it) => (
              <li key={it.identifier}>
                <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{it.prompt} <span className="muted" style={{ fontSize: 13 }}>({it.points} {d.pts})</span></p>
                {it.kind === "match" ? (
                  <ul className="muted" style={{ margin: "4px 0 0", fontSize: 15 }}>
                    {it.choices.map((ch) => <li key={ch.identifier}>{ch.text} → …</li>)}
                  </ul>
                ) : it.choices.length > 0 ? (
                  <ul style={{ margin: "4px 0 0", fontSize: 15, listStyle: "none", paddingLeft: 0 }}>
                    {it.choices.map((ch, k) => <li key={ch.identifier}>{String.fromCharCode(65 + k)}. {ch.text}</li>)}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ) : a.kind === "online" ? (
        <section className="card stack" style={{ gap: 8 }} aria-labelledby="work-title">
          <h2 id="work-title" className="label">{d.previewWork}{submission?.submittedAt ? <> · {d.handedIn} <When iso={submission.submittedAt} lang={L} /></> : null}</h2>
          {submission?.body ? <div className="body-text" style={{ whiteSpace: "pre-wrap" }}>{submission.body}</div> : <p className="empty" style={{ margin: 0 }}>{d.previewNothingYet}</p>}
        </section>
      ) : toolLink ? (
        <p className="notice">{d.previewToolNote}</p>
      ) : (
        <p className="notice">{d.paperAssignment}</p>
      )}
    </PreviewFrame>
  );
}
