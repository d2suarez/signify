import { NextResponse } from "next/server";
import { assignmentAccess, ctx } from "@/lib/access";
import { getSubmission } from "@/lib/assignments";
import { gradesFor } from "@/lib/grades";
import { closeExpired, QUIZ_GRADER, studentQuiz, syncGrade } from "@/lib/quiz-store";
import { passBack } from "@/lib/lti-passback";
import { linkForAssignment } from "@/lib/lti-platform";
import { groupState } from "@/lib/group-work";

export const dynamic = "force-dynamic";

/**
 * An assignment as an assignment slide shows it (story 01, D3/D10).
 * A teacher gets its state, for the presenter's Publish button. A student
 * gets their own work on it, as its page would give it: their writing box,
 * their quiz (handed in at the time limit, results as the quiz allows) or a
 * paper assignment's details. A draft is "not found" to a student
 * (assignmentAccess), so nothing of it reaches them before it is published.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await assignmentAccess(id);
  const noStore = { headers: { "Cache-Control": "no-store" } };
  if (!access) return NextResponse.json({ waiting: true }, { status: 404, ...noStore });
  const { me, course, assignment: a } = access;
  const base = { id: a.id, courseId: course.id, title: a.title, kind: a.kind, points: a.points, dueAt: a.dueAt };
  if (course.role === "teacher") {
    return NextResponse.json({ role: "teacher", ...base, published: a.published, version: a.version }, noStore);
  }
  const c = ctx(me);
  if (a.kind === "quiz" && (await closeExpired(c, a, me.id)).length) {
    if (await syncGrade({ tenantId: me.tenantId, userId: QUIZ_GRADER }, a, me.id, new Set([me.id]))) await passBack(access, me.id);
  }
  const [submission, grades, toolLink, quiz, group] = await Promise.all([
    a.kind === "online" ? getSubmission(c, a.id, me.id) : Promise.resolve(null),
    gradesFor(c, a.id), linkForAssignment(me.tenantId, a.id),
    a.kind === "quiz" ? studentQuiz(c, a) : Promise.resolve(null),
    a.kind === "online" ? groupState(c, a, me.id) : Promise.resolve(null),
  ]);
  const mine = grades.find((g) => g.studentId === me.id) || null;
  return NextResponse.json({
    role: "student", ...base,
    instructions: a.instructions, instructionsDoc: a.instructionsDoc ?? null,
    quiz, submission, locked: !!mine && (mine.score !== null || mine.flag === "exempt"),
    toolLinkId: toolLink?.id ?? null, group, me: me.id,
  }, noStore);
}
