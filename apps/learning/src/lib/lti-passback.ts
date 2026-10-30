import "server-only";
import { token } from "./auth";
import { membersOf } from "./roster";
import { gradesFor } from "./grades";
import { courseGrading } from "./standards";
import { assignmentPenalties } from "./gradebook";
import { finalScore } from "./late-policy";
import { kickScores, queueGrades, type QueueGrade } from "./lti-ags";
import type { AssignmentAccess } from "./access";

/**
 * After a teacher's save: queue what Schoology should now hold and nudge the
 * sender. Never throws and never waits on Schoology, so a grade save can't
 * fail because of it.
 */
export async function passBack(access: AssignmentAccess, only?: string): Promise<void> {
  try {
    const { me, course, assignment: a } = access;
    const [{ members }, grades, grading] = await Promise.all([
      membersOf({ id: me.id, role: me.role, dev: me.dev }, await token(), course.idClassId),
      gradesFor({ tenantId: me.tenantId, userId: me.id }, a.id),
      courseGrading({ tenantId: me.tenantId, userId: me.id }, course.id),
    ]);
    const email = new Map(members.map((m) => [m.id, m.email || ""]));
    // What goes is the score that counts: after the late policy's penalty, if any (none = as given).
    const { byStudent: late } = await assignmentPenalties({ tenantId: me.tenantId, userId: me.id }, a, grades);
    const byStudent = new Map(grades.map((g) => {
      const p = late.get(g.studentId)?.penalty ?? null;
      return [g.studentId, p && g.score !== null ? { ...g, score: finalScore(g.score, p) } : g];
    }));
    const ids = only ? [only] : [...new Set([...byStudent.keys(), ...members.filter((m) => m.role === "student").map((m) => m.id)])];
    const list: QueueGrade[] = ids.map((id) => ({ studentId: id, email: email.get(id) || null, grade: byStudent.get(id) || null }));
    // A standards course sends levels-only work as its converted percent of the points.
    const standards = grading.mode === "standards" ? grading.settings : null;
    const waiting = await queueGrades(me.tenantId, { id: a.id, points: a.points, gradesReleased: a.gradesReleased, standards }, list);
    if (waiting) kickScores();
  } catch (e) {
    console.warn(`learning: grade passback queue: ${(e as Error).message}`);
  }
}
