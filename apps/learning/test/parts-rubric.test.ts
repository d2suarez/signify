import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses } from "../src/lib/courses";
import { createAssignment, saveAssignment, getAssignment } from "../src/lib/assignments";
import { setGrade, gradesFor, partNotesFor } from "../src/lib/grades";
import { cleanParts, feedbackFromParts, isParts, normalizeRubric, partsScore, rubricMax, shortSections, type Rubric } from "../src/lib/rubric";
import { alignedStandards } from "../src/lib/standards-math";

// Sections-and-parts rubric (migration 036, teacher story 01 grade assistant).

let db: Db;
const T = { tenantId: "school-a", userId: "teacher-1" };
const ROSTER = new Set(["stu-1", "stu-2"]);

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
});
after(() => db.close());

const RAW = {
  kind: "parts",
  sections: [
    { id: "s1", title: "Preview", parts: [
      { id: "p1", label: "1a", question: "What do you already know?", points: 1 },
      { id: "p2", label: "1b", question: "  Predict one thing.  ", points: 1.1 }, // rounds to 1
    ] },
    { id: "s2", title: "Processing", parts: [
      { id: "p3", label: "2a", question: "Explain.", points: 2.6 }, // rounds to 2.5
      { id: "p4", label: "2b", question: "Draw it.", points: 1.5 },
      { id: "p5", label: "2c", points: 1 }, { id: "p6", points: 1 }, { id: "p7", points: 1 }, { id: "p8", points: 1 },
    ] },
    { id: "s3", title: "Empty", parts: [] },
  ],
};

test("parts rubric: cleaned on the way in; quarter points; at most 5 parts; total adds up", () => {
  const r = normalizeRubric(RAW)!;
  assert.ok(isParts(r));
  assert.deepEqual(r.criteria, [], "criteria stay empty, so standards and levels code finds none");
  assert.equal(r.sections!.length, 2, "a section with no parts is dropped");
  assert.equal(r.sections![0].parts[1].points, 1);
  assert.equal(r.sections![0].parts[1].question, "Predict one thing.");
  assert.equal(r.sections![1].parts.length, 5);
  assert.equal(r.sections![1].parts[0].points, 2.5);
  assert.equal(rubricMax(r), 2 + 2.5 + 1.5 + 1 + 1 + 1);
  assert.deepEqual(shortSections(r), []);
  assert.deepEqual(alignedStandards({ standards: null, rubric: r }), []);
  // Today's criteria × levels rubric is untouched.
  const levels = normalizeRubric({ criteria: [{ title: "Thesis", levels: [{ points: 2 }, { points: 4 }] }] })!;
  assert.ok(!isParts(levels));
  assert.equal(rubricMax(levels), 4);
});

test("parts rubric: marks are clamped to each part, on quarter points; feedback is built in order", () => {
  const r = normalizeRubric(RAW)!;
  const m = cleanParts(r, {
    p1: { score: 5, message: "Good." }, p2: { score: 0.3, message: "  Say why.  " }, p3: { score: -1 }, nope: { score: 1, message: "x" }, p4: { message: "" },
  })!;
  assert.deepEqual(m, { p1: { score: 1, message: "Good." }, p2: { score: 0.25, message: "Say why." }, p3: { score: 0, message: "" } });
  assert.deepEqual(partsScore(r, m), { score: 1.25, complete: false });
  assert.equal(feedbackFromParts(r, m), "1a: Good.\n\n1b: Say why.");
  assert.equal(cleanParts(normalizeRubric({ criteria: [{ levels: [{ points: 1 }] }] }), { p1: { score: 1 } }), null, "not a parts rubric");
});

test("parts rubric: saved on the assignment, points from the parts; grades keep part marks, notes apart, history", async () => {
  const [c] = await myCourses("school-a", [{ id: "r1", name: "History", role: "teacher" }]);
  const a0 = await createAssignment(T, c.id, { title: "Workbook 7" });
  const s = await saveAssignment(T, a0.id, { baseVersion: a0.version, rubric: RAW });
  assert.ok(s.ok);
  assert.equal(s.assignment.points, 9);
  const a = (await getAssignment(T, a0.id))!;
  assert.ok(isParts(a.rubric));

  const r = await setGrade(T, a, "stu-1", ROSTER, {
    score: 1.75, comment: "1b: Say why.",
    parts: { p1: { score: 1, message: "" }, p2: { score: 0.75, message: "Say why." } },
    notes: { p2: "Copied from the reading?", zzz: "dropped" },
  });
  assert.ok(r.ok && r.changed);
  assert.deepEqual(r.grade!.parts, { p1: { score: 1, message: "" }, p2: { score: 0.75, message: "Say why." } });
  assert.ok(!("notes" in r.grade!) && !JSON.stringify(r.grade).includes("Copied"), "the teacher's note is never on a Grade");
  assert.deepEqual((await partNotesFor(T, a.id)).get("stu-1"), { p2: "Copied from the reading?" });
  // What a student would read (gradesFor) has the marks, not the notes.
  const [g] = await gradesFor(T, a.id);
  assert.equal(g.score, 1.75);
  assert.ok(!JSON.stringify(g).includes("Copied"));
  // Not sending parts (e.g. the gradebook grid) keeps them.
  const grid = await setGrade(T, a, "stu-1", ROSTER, { score: 2, comment: "1b: Say why." });
  assert.ok(grid.ok);
  assert.deepEqual(grid.grade!.parts, r.grade!.parts);
  assert.deepEqual((await partNotesFor(T, a.id)).get("stu-1"), { p2: "Copied from the reading?" });
  // The same again changes nothing; history keeps each change with its parts.
  const same = await setGrade(T, a, "stu-1", ROSTER, { score: 2, comment: "1b: Say why.", parts: r.grade!.parts, notes: { p2: "Copied from the reading?" } });
  assert.ok(same.ok && !same.changed);
  const hist = await db.query("SELECT parts, part_notes FROM grade_history WHERE assignment_id = $1 ORDER BY id", [a.id]);
  assert.equal(hist.length, 2);
  assert.ok(hist[0].parts && hist[0].part_notes);
  // Notes alone are kept for a student without a score yet.
  const n = await setGrade(T, a, "stu-2", ROSTER, { notes: { p1: "Look again" } });
  assert.ok(n.ok && n.grade && n.grade.score === null);
  // Clearing everything removes the grade.
  const gone = await setGrade(T, a, "stu-2", ROSTER, { notes: {} });
  assert.ok(gone.ok && gone.grade === null);
});

test("parts rubric: a criteria rubric's grades never get parts", async () => {
  const [c] = await myCourses("school-a", [{ id: "r2", name: "Art", role: "teacher" }]);
  const a0 = await createAssignment(T, c.id, { title: "Essay" });
  await saveAssignment(T, a0.id, { baseVersion: a0.version, rubric: { criteria: [{ id: "c1", title: "Thesis", levels: [{ id: "l1", points: 4 }] }] } as Rubric });
  const a = (await getAssignment(T, a0.id))!;
  const r = await setGrade(T, a, "stu-1", ROSTER, { score: 4, rubric: { c1: "l1" }, parts: { p1: { score: 1 } }, notes: { p1: "x" } });
  assert.ok(r.ok);
  assert.equal(r.grade!.parts, null);
  assert.deepEqual(r.grade!.rubric, { c1: "l1" });
  assert.equal((await partNotesFor(T, a.id)).size, 0);
});
