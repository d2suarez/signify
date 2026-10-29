import "server-only";
import { ctx, studentsOf, type AssignmentAccess } from "./access";
import { closeExpired, syncGrade } from "./quiz-store";
import { passBack } from "./lti-passback";

/**
 * Before a teacher's page shows a quiz: attempts left open past their time
 * are handed in, and those students' grades written (only for students
 * Signify ID says are in the class now).
 */
export async function closeQuizForTeacher(access: AssignmentAccess): Promise<void> {
  if (access.assignment.kind !== "quiz") return;
  const c = ctx(access.me);
  const closed = await closeExpired(c, access.assignment);
  if (!closed.length) return;
  const { ok, students } = await studentsOf(access);
  if (!ok) return;
  const roster = new Set(students.map((s) => s.id));
  for (const s of closed) if (await syncGrade(c, access.assignment, s, roster)) await passBack(access, s);
}
