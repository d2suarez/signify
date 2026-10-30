/**
 * Two points courses with late work in every form (handed in late, marked
 * Late, missing, exempt, extra credit, drop lowest, weighted categories).
 * Uses only APIs that existed before school scales and late policies, so the
 * same fixture ran on the code before them to freeze the expected FACTS
 * files in scales-late.test.ts.
 */
import { getDb } from "../../src/lib/db";
import { myCourses } from "../../src/lib/courses";
import { createAssignment, saveAssignment, saveDraft, setHandedIn, type Assignment } from "../../src/lib/assignments";
import { addCategory, setGrade, setWeighted } from "../../src/lib/grades";
import { toStudents } from "../../src/lib/gradebook";

export const STUDENTS = toStudents([
  { id: "lf-1", display_name: "Ana Rodriguez", role: "student" },
  { id: "lf-2", display_name: "Ben Ortiz", role: "student" },
  { id: "lf-3", display_name: "Cara Lee Jr.", role: "student" },
  { id: "lf-4", display_name: "Dev Patel", role: "student" },
  { id: "lf-5", display_name: "=Eve Kim", role: "student" },
]);
const ROSTER = new Set(STUDENTS.map((s) => s.id));

type Ctx = { tenantId: string; userId: string };

async function published(t: Ctx, courseId: string, title: string, extra: Record<string, unknown>): Promise<Assignment> {
  const a = await createAssignment(t, courseId, { title, kind: extra.kind });
  const r = await saveAssignment(t, a.id, { baseVersion: a.version, published: true, gradesReleased: true, ...extra });
  if (!r.ok) throw new Error("save");
  return r.assignment;
}

/** A student hands in online work at a fixed moment. */
async function handIn(tenantId: string, a: Assignment, studentId: string, at: string) {
  const s = { tenantId, userId: studentId };
  const d = await saveDraft(s, a, { baseVersion: 0, body: "My answer." });
  if (!d.ok) throw new Error("draft");
  await setHandedIn(s, a, true, d.submission.version);
  const db = await getDb();
  await db.query("UPDATE submissions SET submitted_at = $3 WHERE tenant_id = $1 AND assignment_id = $2 AND student_id = $4", [tenantId, a.id, at, studentId]);
}

export async function lateFixture(t: Ctx, tag: string) {
  const [points] = await myCourses(t.tenantId, [{ id: `${tag}-p`, name: "Economics", role: "teacher" }]);
  const [weighted] = await myCourses(t.tenantId, [{ id: `${tag}-w`, name: "Biology", role: "teacher" }]);

  // Points course: due Monday 2 Nov 2026, 3 pm Eastern.
  const due = { dueOn: "2026-11-02", dueAt: "2026-11-02T20:00:00.000Z" };
  const essay = await published(t, points.id, "Essay", { points: 20, ...due });
  const quiz = await published(t, points.id, "Paper quiz", { points: 15, kind: "offline", ...due });
  const hw = await published(t, points.id, "Homework", { points: 10, ...due });
  await handIn(t.tenantId, essay, "lf-1", "2026-11-04T14:00:00.000Z"); // two school days late
  await handIn(t.tenantId, essay, "lf-2", "2026-11-02T19:00:00.000Z"); // on time
  await handIn(t.tenantId, essay, "lf-3", "2026-11-12T14:00:00.000Z"); // eight school days late
  await handIn(t.tenantId, essay, "lf-4", "2026-11-03T13:00:00.000Z"); // one school day late
  await setGrade(t, essay, "lf-1", ROSTER, { score: 19 });
  await setGrade(t, essay, "lf-2", ROSTER, { score: 17 });
  await setGrade(t, essay, "lf-3", ROSTER, { score: 19 });
  await setGrade(t, essay, "lf-4", ROSTER, { score: 2, flag: "late" });
  await setGrade(t, essay, "lf-5", ROSTER, { flag: "missing" });
  await setGrade(t, quiz, "lf-1", ROSTER, { score: 14, flag: "late" });
  await setGrade(t, quiz, "lf-2", ROSTER, { score: 13 });
  await setGrade(t, quiz, "lf-3", ROSTER, { flag: "exempt" });
  await setGrade(t, quiz, "lf-4", ROSTER, { score: 15, flag: "late" });
  await setGrade(t, quiz, "lf-5", ROSTER, { score: 9 });
  await setGrade(t, hw, "lf-1", ROSTER, { score: 9 });
  await setGrade(t, hw, "lf-2", ROSTER, { score: 11 }); // extra credit
  await setGrade(t, hw, "lf-3", ROSTER, { score: 7, flag: "late" });
  await setGrade(t, hw, "lf-5", ROSTER, { score: 10 });

  // Weighted course with drop lowest.
  const tests = await addCategory(t, weighted.id, "Tests", 60);
  const homework = await addCategory(t, weighted.id, "Homework", 40, 1);
  await setWeighted(t, weighted.id, true);
  const t1 = await published(t, weighted.id, "Test 1", { points: 50, categoryId: tests.id, ...due });
  const h1 = await published(t, weighted.id, "HW 1", { points: 10, categoryId: homework.id, ...due });
  const h2 = await published(t, weighted.id, "HW 2", { points: 10, categoryId: homework.id, ...due });
  await handIn(t.tenantId, h1, "lf-1", "2026-11-09T14:00:00.000Z");
  await handIn(t.tenantId, h1, "lf-2", "2026-11-07T01:00:00.000Z"); // Friday 8 pm: late
  for (const [s, a, b, c] of [["lf-1", 46.5, 9, 4], ["lf-2", 40, 8, 10], ["lf-3", 31, 10, 10], ["lf-4", 47, 6, 9], ["lf-5", 29.5, 10, 2]] as const) {
    await setGrade(t, t1, s, ROSTER, { score: a, flag: s === "lf-4" ? "late" : null });
    await setGrade(t, h1, s, ROSTER, { score: b });
    await setGrade(t, h2, s, ROSTER, { score: c, flag: s === "lf-3" ? "late" : null });
  }
  return { points, weighted, essay, quiz, hw, t1, h1, h2, tests, homework, ROSTER };
}
