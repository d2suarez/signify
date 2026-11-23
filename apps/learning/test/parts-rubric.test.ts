import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses } from "../src/lib/courses";
import { createAssignment, saveAssignment, getAssignment } from "../src/lib/assignments";
import { setGrade, gradesFor, partNotesFor } from "../src/lib/grades";
import { changedParts, cleanParts, feedbackFromParts, isParts, normalizeRubric, partsScore, rubricMax, shortSections, type Rubric } from "../src/lib/rubric";
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
  assert.equal(g.score, null, "2 of 9 parts scored: no score yet, not a partial total");
  assert.ok(!JSON.stringify(g).includes("Copied"));
  // Not sending parts (e.g. the gradebook grid) keeps them.
  const grid = await setGrade(T, a, "stu-1", ROSTER, { score: 2, comment: "1b: Say why." });
  assert.ok(grid.ok);
  assert.deepEqual(grid.grade!.parts, r.grade!.parts);
  assert.deepEqual((await partNotesFor(T, a.id)).get("stu-1"), { p2: "Copied from the reading?" });
  // Parts sent again (the grading desk) win over the grid's typed score: still incomplete, so no score.
  const desk = await setGrade(T, a, "stu-1", ROSTER, { score: 2, comment: "1b: Say why.", parts: r.grade!.parts, notes: { p2: "Copied from the reading?" } });
  assert.ok(desk.ok && desk.changed && desk.grade!.score === null);
  // The same again changes nothing; history keeps each change with its parts.
  const same = await setGrade(T, a, "stu-1", ROSTER, { score: 2, comment: "1b: Say why.", parts: r.grade!.parts, notes: { p2: "Copied from the reading?" } });
  assert.ok(same.ok && !same.changed);
  const hist = await db.query("SELECT parts, part_notes FROM grade_history WHERE assignment_id = $1 ORDER BY id", [a.id]);
  assert.equal(hist.length, 3);
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

test("parts rubric: the score comes from the parts on the server, whatever number the client sends", async () => {
  const [c] = await myCourses("school-a", [{ id: "r1", name: "History", role: "teacher" }]);
  const a0 = await createAssignment(T, c.id, { title: "Workbook 8" });
  const two = { kind: "parts", sections: [{ id: "s1", title: "A", parts: [{ id: "q1", label: "1a", points: 2 }, { id: "q2", label: "1b", points: 2 }] }] };
  const s = await saveAssignment(T, a0.id, { baseVersion: a0.version, rubric: two });
  assert.ok(s.ok);
  const a = (await getAssignment(T, a0.id))!;
  // Every part scored: a stale tab's 9 is replaced by the parts' 3.5.
  const all = await setGrade(T, a, "stu-1", ROSTER, { score: 9, parts: { q1: { score: 2, message: "" }, q2: { score: 1.5, message: "" } } });
  assert.ok(all.ok && all.grade!.score === 3.5);
  // One part unscored again: the score is held back, the mark kept.
  const half = await setGrade(T, a, "stu-1", ROSTER, { score: 3.5, parts: { q1: { score: 2, message: "" }, q2: { score: null, message: "Redo" } } });
  assert.ok(half.ok && half.grade!.score === null);
  assert.equal(partsScore(a.rubric!, half.grade!.parts).complete, false);
  // No part scored: the teacher's own typed score stands.
  const own = await setGrade(T, a, "stu-2", ROSTER, { score: 3, parts: { q1: { score: null, message: "See me" } } });
  assert.ok(own.ok && own.grade!.score === 3);
});

test("parts rubric: a changed rubric with a 1-part section is refused; ids stay; edits that touch graded parts are listed", async () => {
  const [c] = await myCourses("school-a", [{ id: "r1", name: "History", role: "teacher" }]);
  const a0 = await createAssignment(T, c.id, { title: "Workbook 9" });
  const one = { kind: "parts", sections: [{ id: "s1", title: "A", parts: [{ id: "q1", label: "1a", points: 1 }] }] };
  const bad = await saveAssignment(T, a0.id, { baseVersion: a0.version, rubric: one });
  assert.ok(!bad.ok && bad.reason === "short-sections");
  assert.equal((await getAssignment(T, a0.id))!.rubric, null, "nothing stored");
  const ok = await saveAssignment(T, a0.id, { baseVersion: a0.version, rubric: RAW });
  assert.ok(ok.ok);
  const ids = ok.assignment.rubric!.sections!.flatMap((x) => x.parts.map((p) => p.id));
  assert.deepEqual(ids, ["p1", "p2", "p3", "p4", "p5", "p6", "p7"], "the editor's part ids are kept");
  // A legacy rubric with a short section still saves while the rubric itself is not changed.
  await db.query("UPDATE assignments SET rubric = $1::jsonb WHERE id = $2", [JSON.stringify(normalizeRubric(one)), a0.id]);
  const cur = (await getAssignment(T, a0.id))!;
  const title = await saveAssignment(T, a0.id, { baseVersion: cur.version, title: "Renamed", rubric: cur.rubric });
  assert.ok(title.ok);

  const saved = normalizeRubric(RAW)!;
  const edited = structuredClone(saved);
  edited.sections![0].parts[1].points = 0.5; // p2 changed
  edited.sections![1].parts.splice(0, 1); // p3 removed
  edited.sections![0].title = "Renamed only";
  assert.deepEqual(changedParts(saved, edited).map((p) => p.id), ["p2", "p3"]);
  assert.deepEqual(changedParts(saved, saved), []);
  assert.deepEqual(changedParts(null, edited), []);
});
