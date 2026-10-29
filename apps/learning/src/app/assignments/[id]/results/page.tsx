import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMe } from "@/lib/auth";
import { assignmentAccess, ctx, lang, studentsOf } from "@/lib/access";
import { dict, type Key } from "@/lib/i18n";
import { handGraded, keptAttempt, responseText, type Quiz } from "@/lib/quiz";
import { attemptsOf, listAccommodations, quizAnalysis } from "@/lib/quiz-store";
import { closeQuizForTeacher } from "@/lib/quiz-sync";
import { TopBar } from "@/components/TopBar";
import QuizByQuestion, { type ByQuestionItem } from "@/components/QuizByQuestion";
import Accommodations from "@/components/Accommodations";

export const dynamic = "force-dynamic";

/** A quiz's results for its teachers: percent correct per question, grading by question, accommodations. */
export default async function QuizResultsPage({ params }: { params: Promise<{ id: string }> }) {
  await requireMe();
  const { id } = await params;
  const L = await lang();
  const d = dict(L);
  const access = await assignmentAccess(id);
  if (!access || access.course.role !== "teacher" || access.assignment.kind !== "quiz" || !access.assignment.quiz) notFound();
  await closeQuizForTeacher(access);
  const { me, course, assignment: a } = access;
  const quiz = a.quiz as Quiz;
  const c = ctx(me);
  const [{ ok, students }, analysis, attempts, acc] = await Promise.all([
    studentsOf(access), quizAnalysis(c, a), attemptsOf(c, a.id), listAccommodations(c, course.id),
  ]);
  const name = new Map(students.map((s) => [s.id, s.name]));
  const keptIds = new Set<string>();
  const byStudent = new Map<string, typeof attempts>();
  for (const x of attempts) byStudent.set(x.studentId, [...(byStudent.get(x.studentId) ?? []), x]);
  for (const list of byStudent.values()) { const k = keptAttempt(list, quiz.settings.keep); if (k) keptIds.add(k.id); }

  const hand: ByQuestionItem[] = quiz.items.filter(handGraded).map((i) => ({
    identifier: i.identifier, prompt: i.prompt, points: i.points, kind: i.kind,
    rows: attempts.filter((x) => x.submittedAt && x.responses[i.identifier] !== undefined)
      .map((x) => ({
        attemptId: x.id, student: name.get(x.studentId) ?? d.quizFormerStudent, number: x.number, counts: keptIds.has(x.id),
        yours: responseText(i, x.responses[i.identifier]), score: x.scores[i.identifier]?.score ?? null,
      }))
      .sort((p, q) => Number(q.score === null) - Number(p.score === null) || p.student.localeCompare(q.student)),
  }));

  return (
    <>
      <TopBar crumbs={<><Link href="/">{d.myCourses}</Link> · <Link href={`/courses/${course.id}`}>{course.name}</Link> · <Link href={`/assignments/${a.id}`}>{a.title}</Link></>} />
      <main className="page stack">
        <div className="row">
          <h1 style={{ fontSize: 30 }} className="grow">{d.quizResults}: {a.title}</h1>
          <Link className="btn" href={`/assignments/${a.id}/grade`}>{d.openGrading}</Link>
          <Link className="btn" href={`/assignments/${a.id}`}>{d.edit}</Link>
        </div>
        <dl className="facts-grid">
          <div><dt>{d.quizTakenBy}</dt><dd>{analysis.students}{ok ? ` ${d.of} ${students.length}` : ""}</dd></div>
          <div><dt>{d.quizQuestions}</dt><dd>{quiz.items.length}</dd></div>
          <div><dt>{d.quizWaitingAttempts}</dt><dd>{analysis.waiting}</dd></div>
        </dl>

        <section className="card stack" aria-labelledby="qa-title" style={{ gap: 8 }}>
          <h2 id="qa-title" style={{ fontSize: 22 }}>{d.quizItemAnalysis}</h2>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.quizItemAnalysisHint}</p>
          {analysis.students === 0 ? <p className="empty">{d.quizNobodyYet}</p> : (
            <div style={{ overflowX: "auto" }}>
              <table className="plain-table">
                <thead>
                  <tr><th scope="col">#</th><th scope="col">{d.quizQuestion}</th><th scope="col">{d.quizPercentCorrect}</th><th scope="col">{d.quizAverage}</th><th scope="col">{d.quizToScore}</th></tr>
                </thead>
                <tbody>
                  {quiz.items.map((i, k) => {
                    const s = analysis.stats[k];
                    return (
                      <tr key={i.identifier}>
                        <td>{k + 1}</td>
                        <td style={{ minWidth: 220 }}>
                          <span className="muted" style={{ fontSize: 12 }}>{d[`qk_${i.kind}` as Key]}</span><br />
                          {i.prompt.length > 140 ? `${i.prompt.slice(0, 140)}…` : i.prompt}
                          {Object.keys(s.picks).length > 0 && (
                            <details style={{ marginTop: 4 }}>
                              <summary style={{ cursor: "pointer", fontSize: 13 }}>{d.quizPicks}</summary>
                              <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 13 }}>
                                {i.choices.map((ch) => (
                                  <li key={ch.identifier}>{ch.text} · {s.picks[ch.identifier] ?? 0}{i.correct.includes(ch.identifier) ? ` · ${d.quizCorrect}` : ""}</li>
                                ))}
                              </ul>
                            </details>
                          )}
                        </td>
                        <td>
                          {s.percentCorrect === null ? "—" : (
                            <span className="meter-cell"><span className="meter" aria-hidden><span style={{ width: `${s.percentCorrect}%` }} /></span><b>{s.percentCorrect}%</b></span>
                          )}
                        </td>
                        <td>{s.averageScore === null ? "—" : `${s.averageScore} / ${i.points}`}</td>
                        <td>{s.waiting || ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {hand.length > 0 && (
          <section className="card stack" aria-labelledby="qbq-title" style={{ gap: 8 }}>
            <h2 id="qbq-title" style={{ fontSize: 22 }}>{d.quizByQuestion}</h2>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.quizByQuestionHint}</p>
            <QuizByQuestion assignmentId={a.id} items={hand} d={d} />
          </section>
        )}

        <section className="card stack" aria-labelledby="acc-title" style={{ gap: 8 }}>
          <h2 id="acc-title" style={{ fontSize: 22 }}>{d.quizAccommodations}</h2>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.quizAccommodationsCourse}</p>
          {!ok ? <p className="notice notice-bad" role="alert">{d.rosterFailed}</p> : (
            <Accommodations courseId={course.id} d={d}
              students={students.map((s) => {
                const x = acc.find((y) => y.studentId === s.id);
                return { id: s.id, name: s.name, timeFactor: x?.timeFactor ?? 1, extraAttempts: x?.extraAttempts ?? 0 };
              })} />
          )}
        </section>
      </main>
    </>
  );
}
