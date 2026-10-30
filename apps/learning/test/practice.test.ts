import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses } from "../src/lib/courses";
import { listLessons } from "../src/lib/lessons";
import { listUnits } from "../src/lib/units";
import { listAssignments } from "../src/lib/assignments";
import { courseGrades } from "../src/lib/grades";
import { listAnnouncements } from "../src/lib/announcements";
import { buildGradebook, toStudents } from "../src/lib/gradebook";
import { isPracticeCourse, fillPractice, clearPractice } from "../src/lib/practice";

let db: Db;
const T = { tenantId: "school-a", userId: "teacher-1" };
const STUDENTS = ["stu-1", "stu-2", "stu-3", "stu-4"];

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
});
after(() => db.close());

test("practice: only a course named Practice can be filled", () => {
  assert.equal(isPracticeCourse({ name: "Practice — Demo class" }), true);
  assert.equal(isPracticeCourse({ name: "practice class" }), true);
  assert.equal(isPracticeCourse({ name: "AP Microeconomics" }), false);
  assert.equal(isPracticeCourse({ name: "Practicum in Teaching" }), false);
});

test("practice: sample work, graded through the live roster, and cleared cleanly", async () => {
  const [c] = await myCourses("school-a", [{ id: "practice-class", name: "Practice — Demo class", role: "teacher" }]);
  const [real] = await myCourses("school-a", [{ id: "real-class", name: "AP Micro", role: "teacher" }]);
  const now = new Date("2026-10-30T15:00:00Z");
  const r = await fillPractice(T, c.id, STUDENTS, now);
  assert.deepEqual([r.units, r.lessons, r.assignments], [2, 3, 3]);
  assert.equal((await listUnits(T, c.id)).length, 2);
  assert.equal((await listLessons(T, c.id)).length, 3);
  const work = await listAssignments(T, c.id);
  assert.deepEqual(work.map((a) => a.kind).sort(), ["offline", "online", "quiz"]);
  assert.ok(work.every((a) => a.published), "everything is published, so students see it");
  const ws = work.find((a) => a.kind === "offline")!;
  assert.equal(ws.gradesReleased, true, "one assignment's grades are released");
  assert.equal(ws.dueOn, "2026-10-24");
  assert.equal(ws.dueAt, "2026-10-25T03:59:00.000Z", "due at 11:59 pm New York time (EDT that day)");
  assert.equal(work.find((a) => a.kind === "quiz")!.gradesReleased, false);
  assert.equal(work.find((a) => a.kind === "quiz")!.points, 3, "the quiz is worth its questions");
  assert.equal((await listAnnouncements(T, c.id)).length, 1);

  const grades = await courseGrades(T, c.id);
  assert.ok(grades.every((g) => STUDENTS.includes(g.studentId)), "grades only for students on the roster");
  assert.equal(grades.filter((g) => g.assignmentId === ws.id).length, 4);
  assert.ok(grades.some((g) => g.flag === "missing") && grades.some((g) => g.flag === "late"));

  // What a student sees: the released worksheet counts, the unreleased quiz does not.
  const gb = await buildGradebook(T, c.id, toStudents(STUDENTS.map((id) => ({ id, display_name: id, role: "student" }))), null, { releasedOnly: true });
  assert.ok(gb.rows.some((row) => row.whole !== null));

  // Filling again starts over rather than doubling up.
  await fillPractice(T, c.id, STUDENTS, now);
  assert.equal((await listAssignments(T, c.id)).length, 3);
  assert.equal((await listLessons(T, c.id)).length, 3);

  await clearPractice(T, c.id);
  assert.equal((await listAssignments(T, c.id)).length, 0);
  assert.equal((await listLessons(T, c.id)).length, 0);
  assert.equal((await listUnits(T, c.id)).length, 0);
  assert.equal((await courseGrades(T, c.id)).length, 0);
  assert.ok(real, "another course is untouched");
});
