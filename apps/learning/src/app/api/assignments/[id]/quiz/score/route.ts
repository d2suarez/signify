import { NextResponse } from "next/server";
import { assignmentAccess, ctx, studentsOf } from "@/lib/access";
import { answerText, handGraded, keptAttempt, responseText, type Quiz } from "@/lib/quiz";
import { attemptFacts, attemptsOf, awayTimes, closeExpired, scoreQuestion, syncGrade } from "@/lib/quiz-store";
import { gradesFor } from "@/lib/grades";
import { passBack } from "@/lib/lti-passback";

export const dynamic = "force-dynamic";

/** The course's teachers only. */
async function teacher(id: string) {
  const access = await assignmentAccess(id);
  if (!access || access.assignment.kind !== "quiz" || !access.assignment.quiz) return { error: NextResponse.json({ error: "Not found." }, { status: 404 }) };
  if (access.course.role !== "teacher") return { error: NextResponse.json({ error: "Only the course's teachers can see this." }, { status: 403 }) };
  return { access };
}

/** One student's attempts with every answer, its score and the facts (left the page, pastes). ?student= */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { access, error } = await teacher(id);
  if (error) return error;
  const student = new URL(req.url).searchParams.get("student") || "";
  if (!student || student.length > 80) return NextResponse.json({ error: "Which student?" }, { status: 400 });
  const c = ctx(access.me);
  const a = access.assignment, quiz = a.quiz as Quiz;
  if ((await closeExpired(c, a, student)).length) {
    const { ok, students } = await studentsOf(access);
    if (ok && await syncGrade(c, a, student, new Set(students.map((s) => s.id)))) await passBack(access, student);
  }
  const list = await attemptsOf(c, a.id, student);
  const kept = keptAttempt(list, quiz.settings.keep);
  const attempts = await Promise.all(list.map(async (x) => {
    const facts = await attemptFacts(c, x.id);
    return {
      id: x.id, number: x.number, startedAt: x.startedAt, deadlineAt: x.deadlineAt, submittedAt: x.submittedAt,
      autoSubmitted: x.autoSubmitted, score: x.score, pending: x.pending, counts: kept?.id === x.id,
      items: quiz.items.map((i) => ({
        identifier: i.identifier, kind: i.kind, prompt: i.prompt, points: i.points,
        yours: responseText(i, x.responses[i.identifier]), answer: answerText(i), hand: handGraded(i),
        score: x.scores[i.identifier]?.score ?? null, by: x.scores[i.identifier]?.by ?? "auto",
        answered: x.responses[i.identifier] !== undefined,
      })),
      away: awayTimes(facts, x.submittedAt),
      pastes: facts.filter((f) => f.kind === "paste").map((f) => ({ at: f.at, item: f.item, chars: f.chars, body: f.body })),
    };
  }));
  return NextResponse.json({ attempts }, { headers: { "Cache-Control": "no-store" } });
}

/** A teacher's score for one question. Body: { attemptId, itemId, score } (score null = back to the automatic one). */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { access, error } = await teacher(id);
  if (error) return error;
  let body: Record<string, unknown>;
  try {
    const text = await req.text();
    if (text.length > 5_000) return NextResponse.json({ error: "Too long." }, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "That wasn't a score." }, { status: 400 });
  }
  const c = ctx(access.me);
  const { ok, students } = await studentsOf(access);
  if (!ok) return NextResponse.json({ error: "roster" }, { status: 503 });
  const attempt = await scoreQuestion(c, access.assignment, String(body.attemptId || ""), String(body.itemId || ""), body.score);
  if (!attempt) return NextResponse.json({ error: "bad-score" }, { status: 400 });
  const roster = new Set(students.map((s) => s.id));
  if (await syncGrade(c, access.assignment, attempt.studentId, roster)) await passBack(access, attempt.studentId);
  const grade = (await gradesFor(c, access.assignment.id)).find((g) => g.studentId === attempt.studentId) ?? null;
  return NextResponse.json({ attempt: { id: attempt.id, score: attempt.score, pending: attempt.pending, scores: attempt.scores }, grade });
}
