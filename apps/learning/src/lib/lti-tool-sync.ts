import "server-only";
import { studentsOf, type CourseAccess } from "./access";
import type { Assignment } from "./assignments";
import { applyToolScores } from "./lti-platform-ags";
import { passBack } from "./lti-passback";
import { getDb } from "./db";

/**
 * Before a teacher's page shows grades: scores outside tools sent for these
 * assignments are written, for students Signify ID says are in the class now.
 */
export async function syncToolScores(access: CourseAccess, assignments: Assignment[]): Promise<void> {
  const ids = assignments.map((a) => a.id);
  if (!ids.length) return;
  const db = await getDb();
  const waiting = await db.query(
    "SELECT DISTINCT assignment_id FROM lti_tool_scores WHERE tenant_id = $1 AND status = 'waiting' AND assignment_id = ANY($2)",
    [access.me.tenantId, ids]);
  if (!waiting.length) return;
  const { ok, students } = await studentsOf(access);
  if (!ok) return;
  const roster = new Set(students.map((s) => s.id));
  for (const w of waiting) {
    const a = assignments.find((x) => x.id === String(w.assignment_id));
    if (!a) continue;
    for (const s of await applyToolScores(access.me.tenantId, a, roster)) await passBack({ ...access, assignment: a }, s);
  }
}

/** The student's own page: their waiting tool score is written (assignmentAccess said they're in the class). */
export async function syncMyToolScore(access: CourseAccess, a: Assignment): Promise<void> {
  const me = access.me.id;
  for (const s of await applyToolScores(access.me.tenantId, a, new Set([me]), me)) await passBack({ ...access, assignment: a }, s);
}
