import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses } from "../src/lib/courses";
import { createAssignment, saveAssignment, getAssignment } from "../src/lib/assignments";
import { setGrade, gradesFor, gradeHistory, computeGrade, droppedIds, addCategory, updateCategory, listCategories, cleanDrop, MAX_DROP } from "../src/lib/grades";
import { buildGradebook, toStudents } from "../src/lib/gradebook";
import { normalizeRubric, rubricMax, rubricScore, cleanSelection, newCriterion, RUBRIC_LIMITS } from "../src/lib/rubric";
import { dict } from "../src/lib/i18n";

let db: Db;
const T = { tenantId: "school-a", userId: "teacher-1" };
const OTHER = { tenantId: "school-b", userId: "teacher-9" };
const ROSTER = new Set(["stu-1", "stu-2"]);

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
});
after(() => db.close());

let n = 0;
async function course() {
  const [c] = await myCourses("school-a", [{ id: `r${++n}`, name: `Course ${n}`, role: "teacher" }]);
  return c;
}

// ---------- drop lowest ----------

const A = (id: string, points: number, categoryId: string | null = "hw") => ({ id, points, categoryId });
const G = (score: number | null, flag: "missing" | "late" | "exempt" | null = null) => ({ score, flag });

test("drop lowest: the lowest percents go, a missing zero first; one always stays", () => {
  const list = [{ id: "a", earned: 8, possible: 10 }, { id: "b", earned: 0, possible: 10 }, { id: "c", earned: 5, possible: 10 }];
  assert.deepEqual([...droppedIds(list, 1)], ["b"]);
  assert.deepEqual([...droppedIds(list, 2)].sort(), ["b", "c"]);
  assert.deepEqual([...droppedIds(list, 5)].sort(), ["b", "c"], "never all of them");
  assert.equal(droppedIds([list[0]], 1).size, 0);
  // A tie in percent: the one worth more points goes (it pulls the grade down more).
  assert.deepEqual([...droppedIds([{ id: "x", earned: 5, possible: 10 }, { id: "y", earned: 10, possible: 20 }, { id: "z", earned: 9, possible: 10 }], 1)], ["y"]);
  // Extra-credit work worth 0 points is never dropped.
  assert.equal(droppedIds([{ id: "e", earned: 2, possible: 0 }, { id: "f", earned: 9, possible: 10 }], 1).size, 0);
});

test("drop lowest: points and weighted grades leave the dropped work out", () => {
  const as = [A("a1", 10), A("a2", 10), A("a3", 10), A("t1", 100, "test")];
  const grades = new Map([["a1", G(10)], ["a2", G(null, "missing")], ["a3", G(6)], ["t1", G(80)]]);
  const cats = [{ id: "hw", weight: 50, dropLowest: 1 }, { id: "test", weight: 50 }];
  const pts = computeGrade(as, grades, { weighted: false, categories: cats });
  assert.deepEqual(pts.dropped, ["a2"]);
  assert.equal(pts.percent, (10 + 6 + 80) / 120 * 100);
  const w = computeGrade(as, grades, { weighted: true, categories: cats });
  assert.equal(w.byCategory.hw, 80);
  assert.equal(w.percent, 80);
  // Exempt and ungraded work isn't "dropped" (it never counted).
  const g2 = new Map([["a1", G(10)], ["a2", G(null, "exempt")], ["a3", G(null)]]);
  assert.deepEqual(computeGrade(as, g2, { weighted: false, categories: cats }).dropped, []);
});

test("drop lowest: saved per category, clamped, and the gradebook marks it", async () => {
  assert.equal(cleanDrop(-3), 0);
  assert.equal(cleanDrop(99), MAX_DROP);
  assert.equal(cleanDrop("2.7"), 2);
  const c = await course();
  const cat = await addCategory(T, c.id, "Homework", 0, 1);
  assert.equal(cat.dropLowest, 1);
  assert.ok(await updateCategory(T, c.id, cat.id, "Homework", 0, 2));
  assert.equal((await listCategories(T, c.id))[0].dropLowest, 2);
  assert.equal((await listCategories(OTHER, c.id)).length, 0);
  assert.ok(await updateCategory(T, c.id, cat.id, "Homework", 0, 1));

  const ids: string[] = [];
  for (const score of [9, 4, 7]) {
    const a = await createAssignment(T, c.id, { title: `HW ${score}` });
    const s = await saveAssignment(T, a.id, { baseVersion: 1, points: 10, categoryId: cat.id, published: true, gradesReleased: true });
    assert.ok(s.ok);
    await setGrade(T, s.assignment, "stu-1", ROSTER, { score });
    ids.push(a.id);
  }
  const students = toStudents([{ id: "stu-1", display_name: "Ana Diaz", role: "student" } as never]);
  const gb = await buildGradebook(T, c.id, students, null);
  assert.deepEqual(gb.rows[0].grade.dropped, [ids[1]]);
  assert.equal(gb.rows[0].whole, 80);
});

// ---------- rubrics ----------

const RUBRIC = {
  criteria: [
    { id: "thesis", title: "Thesis", levels: [{ id: "t2", title: "Developing", points: 2 }, { id: "t4", title: "Excellent", points: 4 }] },
    { id: "evidence", title: "Evidence", levels: [{ id: "e3", points: 3 }, { id: "e1", points: 1 }] },
  ],
};

test("rubric: cleaned on the way in; levels highest first; total is the best of each", () => {
  const r = normalizeRubric({ criteria: [...RUBRIC.criteria, { title: "No levels", levels: [] }, "junk", { id: "<bad>", levels: [{ points: -5, title: " x\ny " }] }] })!;
  assert.equal(r.criteria.length, 3);
  assert.deepEqual(r.criteria[0].levels.map((l) => l.id), ["t4", "t2"]);
  assert.ok(/^[A-Za-z0-9_-]+$/.test(r.criteria[2].id));
  assert.equal(r.criteria[2].levels[0].points, 0);
  assert.equal(r.criteria[2].levels[0].title, "x y");
  assert.equal(rubricMax(r), 7);
  assert.equal(normalizeRubric(null), null);
  assert.equal(normalizeRubric({ criteria: [] }), null);
  const many = normalizeRubric({ criteria: Array.from({ length: 40 }, () => newCriterion()) })!;
  assert.equal(many.criteria.length, RUBRIC_LIMITS.criteria);
});

test("rubric: a selection keeps only real levels and adds up", () => {
  const r = normalizeRubric(RUBRIC)!;
  assert.deepEqual(cleanSelection(r, { thesis: "t4", evidence: "nope", other: "t2" }), { thesis: "t4" });
  assert.equal(cleanSelection(r, { thesis: "e3" }), null, "a level from another criterion");
  assert.deepEqual(rubricScore(r, { thesis: "t4" }), { score: 4, complete: false });
  assert.deepEqual(rubricScore(r, { thesis: "t2", evidence: "e3" }), { score: 5, complete: true });
  assert.deepEqual(rubricScore(r, null), { score: null, complete: false });
});

test("rubric: saved on the assignment, sets its points, kept in versions, removable", async () => {
  const c = await course();
  const a = await createAssignment(T, c.id, { title: "Essay" });
  const s1 = await saveAssignment(T, a.id, { baseVersion: 1, rubric: RUBRIC, points: 50 });
  assert.ok(s1.ok);
  assert.equal(s1.assignment.points, 7, "points follow the rubric, not the typed number");
  assert.equal(s1.assignment.rubric?.criteria.length, 2);
  // Saving the same rubric again changes nothing.
  const same = await saveAssignment(T, a.id, { baseVersion: 2, rubric: s1.assignment.rubric });
  assert.ok(same.ok && !same.changed);
  const snap = await db.query("SELECT snapshot FROM assignment_versions WHERE assignment_id = $1 ORDER BY version", [a.id]);
  assert.equal(snap.length, 1);
  const off = await saveAssignment(T, a.id, { baseVersion: 2, rubric: null, points: 20 });
  assert.ok(off.ok && off.assignment.rubric === null && off.assignment.points === 20);
  const v2 = await db.query("SELECT snapshot FROM assignment_versions WHERE assignment_id = $1 AND version = 2", [a.id]);
  assert.equal((v2[0].snapshot as { rubric: { criteria: unknown[] } }).rubric.criteria.length, 2, "the old rubric is in history");
});

test("rubric: grading keeps the chosen levels with the score and in history", async () => {
  const c = await course();
  const a0 = await createAssignment(T, c.id, { title: "Essay" });
  const s = await saveAssignment(T, a0.id, { baseVersion: 1, rubric: RUBRIC, published: true });
  assert.ok(s.ok);
  const a = s.assignment;
  const r1 = await setGrade(T, a, "stu-1", ROSTER, { score: 5, rubric: { thesis: "t2", evidence: "e3", junk: "x" } });
  assert.ok(r1.ok && r1.changed);
  assert.deepEqual(r1.ok && r1.grade?.rubric, { thesis: "t2", evidence: "e3" });
  // The grid sends no rubric: a typed score keeps the chosen levels.
  const r2 = await setGrade(T, a, "stu-1", ROSTER, { score: 6 });
  assert.ok(r2.ok && r2.changed);
  assert.deepEqual((await gradesFor(T, a.id))[0].rubric, { thesis: "t2", evidence: "e3" });
  // Choosing levels with nothing else is still a grade worth keeping.
  const r3 = await setGrade(T, a, "stu-2", ROSTER, { rubric: { thesis: "t4" } });
  assert.ok(r3.ok && r3.grade?.rubric?.thesis === "t4");
  // Clearing everything removes it.
  const r4 = await setGrade(T, a, "stu-2", ROSTER, { rubric: null });
  assert.ok(r4.ok && r4.grade === null);
  const hist = await db.query("SELECT rubric FROM grade_history WHERE assignment_id = $1 AND student_id = 'stu-1' ORDER BY id", [a.id]);
  assert.equal(hist.length, 2);
  assert.deepEqual(hist[0].rubric, { thesis: "t2", evidence: "e3" });
  assert.equal((await gradeHistory(T, a.id, "stu-1")).length, 2);
  // Another school can't see the assignment at all.
  assert.equal(await getAssignment(OTHER, a.id), null);
});

test("i18n: every drop-lowest and rubric string has Spanish", () => {
  const en = dict("en"), es = dict("es");
  const keys = (Object.keys(en) as (keyof typeof en)[]).filter((k) => /^(drop|dropped|rubric|criterion|level)|pointsFromRubric/.test(k));
  assert.ok(keys.length >= 20);
  for (const k of keys) assert.notEqual(es[k], en[k], `${k} has no Spanish`);
});
