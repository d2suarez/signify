import { NextResponse } from "next/server";
import { assignmentAccess, ctx, studentsOf } from "@/lib/access";
import { archiveAssignment, saveAssignment } from "@/lib/assignments";
import { passBack } from "@/lib/lti-passback";
import { scoringKey } from "@/lib/quiz";
import { regradeQuiz } from "@/lib/quiz-store";

export const dynamic = "force-dynamic";

async function teacher(id: string) {
  const access = await assignmentAccess(id);
  if (!access) return { error: NextResponse.json({ error: "Not found." }, { status: 404 }) };
  if (access.course.role !== "teacher") return { error: NextResponse.json({ error: "Only the course's teachers can change it." }, { status: 403 }) };
  return { access };
}

/** Save an assignment. Body: { baseVersion, title?, instructions?, kind?, points?, dueOn?, dueAt?, unitId?, categoryId?, published?, gradesReleased?, rubric?, standards?, quiz? }. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { access, error } = await teacher(id);
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    const text = await req.text();
    if (text.length > 2_000_000) return NextResponse.json({ error: "That assignment is too large to save." }, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "That wasn't an assignment." }, { status: 400 });
  }

  const r = await saveAssignment(ctx(access.me), id, {
    baseVersion: Number(body.baseVersion),
    title: body.title, instructions: body.instructions, kind: body.kind, points: body.points,
    dueOn: body.dueOn, dueAt: body.dueAt, unitId: body.unitId, categoryId: body.categoryId,
    published: body.published, gradesReleased: body.gradesReleased, rubric: body.rubric, standards: body.standards, quiz: body.quiz,
  });
  if (r.ok) {
    // A quiz whose answer key changed: every handed-in attempt is scored again and grades rewritten (history kept).
    let regraded: { attempts: number; grades: number; roster: boolean } | null = null;
    if (r.changed && r.assignment.kind === "quiz" && scoringKey(r.assignment.quiz) !== scoringKey(access.assignment.quiz)) {
      const { ok, students } = await studentsOf(access);
      regraded = { ...await regradeQuiz(ctx(access.me), r.assignment, new Set(ok ? students.map((s) => s.id) : [])), roster: ok };
    }
    // Releasing grades (or new points, or a regrade) changes what Schoology should hold.
    if (r.changed && (r.assignment.gradesReleased || access.assignment.gradesReleased)) {
      await passBack({ ...access, assignment: r.assignment });
    }
    return NextResponse.json({ assignment: r.assignment, changed: r.changed, regraded });
  }
  if (r.reason === "conflict") return NextResponse.json({ error: "conflict", assignment: r.assignment }, { status: 409 });
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}

/** Archive (never delete): its work and grades are kept. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { access, error } = await teacher(id);
  if (error) return error;
  await archiveAssignment(ctx(access.me), id);
  return NextResponse.json({ ok: true, courseId: access.course.id });
}
