import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses } from "../src/lib/courses";
import { createLesson, saveLesson, listLessons } from "../src/lib/lessons";
import { createUnit, listUnits, moveUnit, deleteUnit, renameUnit } from "../src/lib/units";
import {
  createAssignment, saveAssignment, getAssignment, listAssignments, archiveAssignment, versionCount,
  saveDraft, setHandedIn, getSubmission, isLate, forStudent,
} from "../src/lib/assignments";
import {
  setGrade, gradeHistory, gradesFor, computeGrade, letterFor, wholePercent, parseScore, addCategory,
  setWeighted, addPeriod, listPeriods, inPeriod,
} from "../src/lib/grades";
import { buildGradebook, factsCsv, splitName, toStudents } from "../src/lib/gradebook";
import { LEGACY_SCALE } from "../src/lib/grade-scale";

let db: Db;
const T = { tenantId: "school-a", userId: "teacher-1" };
const OTHER = { tenantId: "school-b", userId: "teacher-9" };
const S1 = { tenantId: "school-a", userId: "stu-1" };
const S2 = { tenantId: "school-a", userId: "stu-2" };
const ROSTER = new Set(["stu-1", "stu-2"]);

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
});
after(() => db.close());

let n = 0;
async function course() {
  const [c] = await myCourses("school-a", [{ id: `g${++n}`, name: `Course ${n}`, role: "teacher" }]);
  return c;
}

async function published(courseId: string, extra: Record<string, unknown> = {}) {
  const a = await createAssignment(T, courseId, { title: "Essay" });
  const r = await saveAssignment(T, a.id, { baseVersion: a.version, published: true, ...extra });
  assert.ok(r.ok);
  return r.assignment;
}

// ---------- units ----------

test("units: made in order, moved, renamed; deleting one keeps its lessons", async () => {
  const c = await course();
  const u1 = await createUnit(T, c.id, " Supply  and demand ");
  const u2 = await createUnit(T, c.id, "Elasticity");
  assert.equal(u1.title, "Supply and demand");
  assert.ok(await moveUnit(T, c.id, u2.id, -1));
  assert.deepEqual((await listUnits(T, c.id)).map((u) => u.title), ["Elasticity", "Supply and demand"]);
  assert.equal(await moveUnit(T, c.id, u2.id, -1), false, "already first");
  assert.ok(await renameUnit(T, c.id, u1.id, "Markets"));

  const l = await createLesson(T, c.id, "Intro", [], u1.id);
  assert.equal(l.unitId, u1.id);
  assert.ok(await deleteUnit(T, c.id, u1.id));
  const [after] = await listLessons(T, c.id);
  assert.equal(after.title, "Intro");
  assert.equal(after.unitId, null);
});

test("units: a lesson can be filed into a unit without a new version; other courses' units are refused", async () => {
  const c = await course();
  const other = await course();
  const u = await createUnit(T, c.id, "Unit 1");
  const foreign = await createUnit(T, other.id, "Not this course");
  const l = await createLesson(T, c.id, "Filed");
  const r = await saveLesson(T, l.id, { baseVersion: 1, unitId: u.id });
  assert.ok(r.ok && r.lesson.unitId === u.id && r.lesson.version === 1);
  const r2 = await saveLesson(T, l.id, { baseVersion: 1, unitId: foreign.id });
  assert.ok(r2.ok && r2.lesson.unitId === null);
  assert.equal(await renameUnit(OTHER, c.id, u.id, "Hijack"), false);
});

// ---------- assignments ----------

test("assignments: drafts are hidden from students until published", async () => {
  const c = await course();
  const a = await createAssignment(T, c.id, { title: "Draft" });
  assert.equal(a.published, false);
  assert.equal((await listAssignments(T, c.id, { publishedOnly: true })).length, 0);
  await saveAssignment(T, a.id, { baseVersion: 1, published: true });
  assert.equal((await listAssignments(T, c.id, { publishedOnly: true })).length, 1);
  const seen = forStudent((await getAssignment(T, a.id))!);
  assert.ok(!("published" in seen) && !("version" in seen));
});

test("assignments: stale saves are refused and every change keeps the old version", async () => {
  const c = await course();
  const a = await createAssignment(T, c.id, { title: "Two tabs" });
  const r1 = await saveAssignment(T, a.id, { baseVersion: 1, instructions: "Read chapter 3", points: "25" });
  assert.ok(r1.ok && r1.assignment.points === 25);
  const r2 = await saveAssignment(T, a.id, { baseVersion: 1, instructions: "Overwritten?" });
  assert.ok(!r2.ok && r2.reason === "conflict");
  assert.equal((await getAssignment(T, a.id))?.instructions, "Read chapter 3");
  assert.equal(await versionCount(T, a.id), 1);
  const same = await saveAssignment(T, a.id, { baseVersion: 2, points: 25 });
  assert.ok(same.ok && !same.changed);
});

test("assignments: points are clamped; due date needs both the day and the moment", async () => {
  const c = await course();
  const a = await createAssignment(T, c.id, { title: "Due" });
  const r = await saveAssignment(T, a.id, { baseVersion: 1, points: -5, dueOn: "2026-10-30", dueAt: "2026-10-31T06:59:00.000Z" });
  assert.ok(r.ok && r.assignment.points === 0 && r.assignment.dueOn === "2026-10-30");
  const r2 = await saveAssignment(T, a.id, { baseVersion: 2, dueOn: "2026-10-30", dueAt: "nonsense" });
  assert.ok(r2.ok && r2.assignment.dueOn === null && r2.assignment.dueAt === null);
});

test("assignments: other schools can't read, save or archive them", async () => {
  const c = await course();
  const a = await createAssignment(T, c.id, { title: "Private" });
  assert.equal(await getAssignment(OTHER, a.id), null);
  const r = await saveAssignment(OTHER, a.id, { baseVersion: 1, title: "Hijacked" });
  assert.ok(!r.ok && r.reason === "missing");
  assert.equal(await archiveAssignment(OTHER, a.id), false);
  assert.equal((await getAssignment(T, a.id))?.title, "Private");
});

// ---------- submissions ----------

test("submissions: a student saves, hands in, and can't edit until taking it back", async () => {
  const c = await course();
  const a = await published(c.id);
  const s1 = await saveDraft(S1, a, { baseVersion: 0, body: "First draft" });
  assert.ok(s1.ok && s1.submission.version === 1);
  const s2 = await saveDraft(S1, a, { baseVersion: 1, body: "Second draft" });
  assert.ok(s2.ok && s2.submission.version === 2);
  const stale = await saveDraft(S1, a, { baseVersion: 1, body: "From the other Chromebook" });
  assert.ok(!stale.ok && stale.reason === "conflict");

  const handed = await setHandedIn(S1, a, true, 2);
  assert.ok(handed.ok && handed.submission.submittedAt);
  const locked = await saveDraft(S1, a, { baseVersion: 3, body: "Sneaky edit" });
  assert.ok(!locked.ok && locked.reason === "handed-in");
  const back = await setHandedIn(S1, a, false, 3);
  assert.ok(back.ok && back.submission.submittedAt === null);
  assert.equal((await getSubmission(T, a.id, "stu-1"))?.body, "Second draft");
});

test("submissions: each student has their own; unpublished or paper assignments take none", async () => {
  const c = await course();
  const a = await published(c.id);
  await saveDraft(S1, a, { baseVersion: 0, body: "Mine" });
  await saveDraft(S2, a, { baseVersion: 0, body: "Theirs" });
  assert.equal((await getSubmission(T, a.id, "stu-1"))?.body, "Mine");
  assert.equal((await getSubmission(T, a.id, "stu-2"))?.body, "Theirs");

  const draft = await createAssignment(T, c.id, { title: "Hidden" });
  assert.ok(!(await saveDraft(S1, draft, { baseVersion: 0, body: "x" })).ok);
  const paper = await published(c.id, { kind: "offline" });
  assert.ok(!(await saveDraft(S1, paper, { baseVersion: 0, body: "x" })).ok);
});

test("submissions: graded work can't be taken back; late is after the due moment", async () => {
  const c = await course();
  const a = await published(c.id, { dueOn: "2020-01-01", dueAt: "2020-01-01T12:00:00Z" });
  await saveDraft(S1, a, { baseVersion: 0, body: "Late work" });
  const h = await setHandedIn(S1, a, true, 1);
  assert.ok(h.ok);
  assert.equal(isLate(a, h.submission), true);
  assert.equal(isLate({ dueAt: null }, h.submission), false);
  await setGrade(T, a, "stu-1", ROSTER, { score: 8 });
  const back = await setHandedIn(S1, a, false, 2);
  assert.ok(!back.ok && back.reason === "graded");
});

// ---------- grades ----------

test("grades: only students on the live roster can be graded; scores are checked", async () => {
  const c = await course();
  const a = await published(c.id, { points: 20 });
  assert.deepEqual(await setGrade(T, a, "stranger", ROSTER, { score: 5 }), { ok: false, reason: "not-a-student" });
  assert.deepEqual(await setGrade(T, a, "stu-1", ROSTER, { score: "abc" }), { ok: false, reason: "bad-score" });
  assert.deepEqual(await setGrade(T, a, "stu-1", ROSTER, { score: -1 }), { ok: false, reason: "bad-score" });
  assert.deepEqual(await setGrade(T, a, "stu-1", ROSTER, { score: 201 }), { ok: false, reason: "bad-score" });
  const ok = await setGrade(T, a, "stu-1", ROSTER, { score: "18,5", comment: " Good " });
  assert.ok(ok.ok && ok.grade?.score === 18.5 && ok.grade.comment === "Good");
  assert.equal(parseScore("", 10), null);
  assert.equal(parseScore("22", 20), 22, "extra credit is allowed");
});

test("grades: every change is kept in the history; clearing removes the grade", async () => {
  const c = await course();
  const a = await published(c.id);
  await setGrade(T, a, "stu-1", ROSTER, { score: 7 });
  const same = await setGrade(T, a, "stu-1", ROSTER, { score: 7 });
  assert.ok(same.ok && !same.changed);
  await setGrade(T, a, "stu-1", ROSTER, { score: 9, flag: "late" });
  await setGrade(T, a, "stu-1", ROSTER, { score: "" });
  assert.equal((await gradesFor(T, a.id)).length, 0);
  const h = await gradeHistory(T, a.id, "stu-1");
  assert.deepEqual(h.map((e) => [e.score, e.flag]), [[null, null], [9, "late"], [7, null]]);
  assert.equal((await gradeHistory(OTHER, a.id, "stu-1")).length, 0);
});

test("grade maths: points, missing counts zero, exempt and ungraded are left out", () => {
  const as = [
    { id: "a", points: 100, categoryId: null },
    { id: "b", points: 20, categoryId: null },
    { id: "c", points: 10, categoryId: null },
    { id: "d", points: 10, categoryId: null },
  ];
  const g = new Map([
    ["a", { score: 90, flag: null }],
    ["b", { score: null, flag: "missing" as const }],
    ["c", { score: 3, flag: "exempt" as const }],
  ]);
  const r = computeGrade(as, g, { weighted: false, categories: [] });
  assert.equal(r.counted, 2);
  assert.equal(r.percent, 75);
  assert.equal(computeGrade(as, new Map(), { weighted: false, categories: [] }).percent, null);
});

test("grade maths: weighted categories, scaled over the categories with work in them", () => {
  const cats = [{ id: "tests", weight: 40 }, { id: "quiz", weight: 25 }, { id: "hw", weight: 20 }, { id: "part", weight: 15 }];
  const as = [
    { id: "t1", points: 100, categoryId: "tests" },
    { id: "q1", points: 20, categoryId: "quiz" },
    { id: "q2", points: 20, categoryId: "quiz" },
    { id: "loose", points: 50, categoryId: null },
  ];
  const g = new Map([
    ["t1", { score: 80, flag: null }],
    ["q1", { score: 20, flag: null }],
    ["q2", { score: 10, flag: null }],
    ["loose", { score: 0, flag: null }],
  ]);
  const r = computeGrade(as, g, { weighted: true, categories: cats });
  assert.equal(r.byCategory.tests, 80);
  assert.equal(r.byCategory.quiz, 75);
  assert.equal(r.byCategory.hw, null);
  // (80*40 + 75*25) / 65
  assert.ok(Math.abs((r.percent as number) - (80 * 40 + 75 * 25) / 65) < 1e-9);
  assert.equal(r.counted, 3, "uncategorized work is left out of a weighted grade");
});

test("letters follow the rounded percent", () => {
  assert.equal(wholePercent(89.5), 90);
  assert.equal(wholePercent(89.49), 89);
  assert.equal(letterFor(89.5, LEGACY_SCALE), "A−");
  assert.equal(letterFor(92.9, LEGACY_SCALE), "A");
  assert.equal(letterFor(65, LEGACY_SCALE), "D");
  assert.equal(letterFor(59.4, LEGACY_SCALE), "F");
  assert.equal(letterFor(null, LEGACY_SCALE), "");
});

// ---------- periods and the gradebook ----------

test("periods: bad dates are refused; assignments count in the period they're due in", async () => {
  assert.equal(await addPeriod("school-p", "Q1", "2026-10-17", "2026-08-18"), null);
  const q1 = await addPeriod("school-p", "Quarter 1", "2026-08-18", "2026-10-17");
  assert.ok(q1);
  assert.equal((await listPeriods("school-p")).length, 1);
  assert.equal((await listPeriods("school-a")).length, 0);
  assert.equal(inPeriod({ dueOn: "2026-10-17" }, q1), true);
  assert.equal(inPeriod({ dueOn: "2026-10-18" }, q1), false);
  assert.equal(inPeriod({ dueOn: null }, q1), true);
});

test("names: FACTS order is last name, then first", () => {
  assert.deepEqual(splitName("Ana Maria Rodriguez"), { first: "Ana Maria", last: "Rodriguez" });
  assert.deepEqual(splitName("Martin Luther King Jr."), { first: "Martin Luther", last: "King Jr." });
  assert.deepEqual(splitName("Cher"), { first: "", last: "Cher" });
  const s = toStudents([
    { id: "1", display_name: "Sofia Garcia", role: "student" },
    { id: "2", display_name: "Ezra Kim", role: "student" },
    { id: "3", display_name: "Ana Rodriguez", role: "student" },
    { id: "4", display_name: "Dev Teacher", role: "teacher" },
  ]);
  assert.deepEqual(s.map((x) => x.factsName), ["Garcia, Sofia", "Kim, Ezra", "Rodriguez, Ana"]);
  assert.ok(s.every((x) => !x.official), "with no official names, every one is a marked guess");
});

test("names: the official name from Signify ID decides FACTS order, the display name everything else", () => {
  const s = toStudents([
    // Shown as "Gina", officially Regina van der Berg: a guess would file her under G.
    { id: "1", display_name: "Gina", role: "student", official_name: { given: "Regina", middle: "Louise", family: "van der Berg", suffix: "" } },
    { id: "2", display_name: "Bobby Fielding", role: "student", official_name: { given: "Robert", family: "Fielding", suffix: "Jr." } },
    // No official name yet: falls back to the guess, and is marked.
    { id: "3", display_name: "Ana Maria Rodriguez", role: "student", official_name: null },
    { id: "4", display_name: "Mia Santos", role: "student" },
    { id: "5", display_name: "Ana Fielding", role: "student", official_name: { given: "Ana", family: "Fielding" } },
  ]);
  assert.deepEqual(s.map((x) => x.factsName),
    ["Fielding, Ana", "Fielding Jr., Robert", "Rodriguez, Ana Maria", "Santos, Mia", "van der Berg, Regina"]);
  assert.deepEqual(s.map((x) => x.name), ["Ana Fielding", "Bobby Fielding", "Ana Maria Rodriguez", "Mia Santos", "Gina"]);
  assert.deepEqual(s.map((x) => !!x.official), [true, true, false, false, true]);
});

test("gradebook: rows, checks, released-only view and the FACTS file agree", async () => {
  const c = await course();
  const students = toStudents([
    { id: "stu-1", display_name: "Ana Rodriguez", role: "student" },
    { id: "stu-2", display_name: "=HYPERLINK(1)", role: "student" },
  ]);
  const quiz = await published(c.id, { points: 20 });
  const hw = await published(c.id, { points: 10 });
  await setGrade(T, quiz, "stu-1", ROSTER, { score: 18 });
  await setGrade(T, hw, "stu-1", ROSTER, { flag: "missing" });
  await setGrade(T, quiz, "stu-2", ROSTER, { score: 10 });

  const gb = await buildGradebook(T, c.id, students, null);
  const ana = gb.rows.find((r) => r.student.id === "stu-1")!;
  assert.equal(ana.whole, 60);
  assert.equal(ana.letter, "D−");
  assert.equal(gb.checks.missing.length, 1);
  assert.equal(gb.checks.ungraded, 1);
  assert.equal(gb.checks.below70, 2);

  const csv = factsCsv(gb);
  assert.ok(csv.includes('"Rodriguez, Ana",60,D-'));
  assert.ok(csv.includes("'=HYPERLINK(1)"), "a name can't run as a formula");

  // Nothing released yet: a student's own view counts nothing.
  const anaOnly = students.filter((s) => s.id === "stu-1");
  const mine = await buildGradebook(T, c.id, anaOnly, null, { releasedOnly: true });
  assert.equal(mine.rows[0].grade.percent, null);
  await saveAssignment(T, quiz.id, { baseVersion: quiz.version, gradesReleased: true });
  const released = await buildGradebook(T, c.id, anaOnly, null, { releasedOnly: true });
  assert.equal(released.rows[0].whole, 90);
});

test("gradebook: weighted course with categories", async () => {
  const c = await course();
  const tests = await addCategory(T, c.id, "Tests", 60);
  const hw = await addCategory(T, c.id, "Homework", 40);
  await setWeighted(T, c.id, true);
  const t1 = await published(c.id, { points: 100, categoryId: tests.id });
  const h1 = await published(c.id, { points: 10, categoryId: hw.id });
  await published(c.id, { points: 10 }); // uncategorized
  await setGrade(T, t1, "stu-1", ROSTER, { score: 70 });
  await setGrade(T, h1, "stu-1", ROSTER, { score: 10 });
  const gb = await buildGradebook(T, c.id, toStudents([{ id: "stu-1", display_name: "Ana R", role: "student" }]), null);
  assert.equal(gb.weighted, true);
  assert.equal(gb.rows[0].whole, 82); // 70*.6 + 100*.4
  assert.equal(gb.checks.uncategorized, 1);
});

test("grid cells: what's typed and what's shown agree", async () => {
  const { cellText, parseCell } = await import("../src/lib/grade-math");
  assert.deepEqual(parseCell(" 18 "), { score: "18", flag: null });
  assert.deepEqual(parseCell("18l"), { score: "18", flag: "late" });
  assert.deepEqual(parseCell("18,5 L"), { score: "18.5", flag: "late" });
  assert.deepEqual(parseCell("M"), { score: "", flag: "missing" });
  assert.deepEqual(parseCell("ex"), { score: "", flag: "exempt" });
  assert.deepEqual(parseCell(""), { score: "", flag: null });
  assert.equal(parseCell("abc"), null);
  assert.equal(parseCell("-3"), null);
  for (const g of [{ score: 18, flag: null }, { score: null, flag: "missing" }, { score: 9, flag: "late" }, { score: null, flag: "exempt" }] as const) {
    const back = parseCell(cellText(g))!;
    assert.equal(back.flag, g.flag);
    assert.equal(back.score === "" ? null : Number(back.score), g.score);
  }
});
