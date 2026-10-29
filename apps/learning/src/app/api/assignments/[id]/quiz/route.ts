import { NextResponse } from "next/server";
import { assignmentAccess, ctx, type AssignmentAccess } from "@/lib/access";
import { closeExpired, QUIZ_GRADER, saveAttempt, startAttempt, studentQuiz, syncGrade } from "@/lib/quiz-store";
import { passBack } from "@/lib/lti-passback";

export const dynamic = "force-dynamic";

/**
 * A student's own quiz: the student is whoever is signed in, and there is no
 * student id in any request to change. Signify ID says they are a student
 * in this class right now (courseAccess), so the quiz may write their grade.
 */
async function student(id: string) {
  const access = await assignmentAccess(id);
  if (!access || access.assignment.kind !== "quiz") return { error: NextResponse.json({ error: "Not found." }, { status: 404 }) };
  if (access.course.role !== "student") return { error: NextResponse.json({ error: "Only students take quizzes." }, { status: 403 }) };
  return { access };
}

async function json(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await req.text();
    if (text.length > 600_000) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** After a hand-in: the grade from the attempt that counts, and Schoology after it. */
async function grade(access: AssignmentAccess) {
  const me = access.me;
  const changed = await syncGrade({ tenantId: me.tenantId, userId: QUIZ_GRADER }, access.assignment, me.id, new Set([me.id]));
  if (changed) await passBack(access, me.id);
}

async function view(access: AssignmentAccess) {
  // An attempt left open past its time is handed in now, with what was saved.
  if ((await closeExpired(ctx(access.me), access.assignment, access.me.id)).length) await grade(access);
  return NextResponse.json({ view: await studentQuiz(ctx(access.me), access.assignment) }, { headers: { "Cache-Control": "no-store" } });
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { access, error } = await student(id);
  if (error) return error;
  return view(access);
}

/** Start (or carry on with) an attempt. Body: { action: "start" }. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { access, error } = await student(id);
  if (error) return error;
  const body = await json(req);
  if (body?.action !== "start") return NextResponse.json({ error: "Say start." }, { status: 400 });
  const r = await startAttempt(ctx(access.me), access.assignment);
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: r.reason === "missing" ? 404 : 409 });
  return view(access);
}

/** Save answers, and hand in with handIn: true. Body: { attemptId, baseVersion, responses, events?, pastes?, handIn? }. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { access, error } = await student(id);
  if (error) return error;
  const body = await json(req);
  if (!body) return NextResponse.json({ error: "Those answers are too long to save." }, { status: 413 });
  const r = await saveAttempt(ctx(access.me), access.assignment, String(body.attemptId || ""), {
    baseVersion: Number(body.baseVersion), responses: body.responses, events: body.events, pastes: body.pastes, handIn: body.handIn === true,
  });
  if (r.ok) {
    if (r.attempt.submittedAt) await grade(access);
    return NextResponse.json({ attempt: { id: r.attempt.id, version: r.attempt.version, submittedAt: r.attempt.submittedAt } });
  }
  if (r.reason === "time-up") {
    await grade(access);
    return NextResponse.json({ error: "time-up" }, { status: 409 });
  }
  if (r.reason === "conflict" || r.reason === "handed-in") return NextResponse.json({ error: r.reason }, { status: 409 });
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}
