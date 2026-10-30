import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses } from "../src/lib/courses";
import { createAssignment, saveAssignment, type Assignment } from "../src/lib/assignments";
import { setGrade, addCategory, setWeighted, gradeHistory, gradesFor, type Period } from "../src/lib/grades";
import { buildGradebook, factsCsv, type Student } from "../src/lib/gradebook";
import {
  addStandard, archiveStandard, courseGrading, listStandards, moveStandard, saveStandardsSettings, setGradingMode, updateStandard,
} from "../src/lib/standards";
import {
  alignedStandards, averageLevel, cleanLevels, convert, criterionLevel, defaultConversion, defaultSettings, levelLabel,
  levelsFromRubric, levelWords, normalizeSettings, summarize,
} from "../src/lib/standards-math";
import { letterFor } from "../src/lib/grade-math";
import { DEFAULT_SCALES } from "../src/lib/grade-scale";
import { dict } from "../src/lib/i18n";

let db: Db;
const T = { tenantId: "school-a", userId: "teacher-1" };
const OTHER = { tenantId: "school-b", userId: "teacher-9" };
const ROSTER = new Set(["stu-1", "stu-2"]);
const STUDENTS: Student[] = [
  { id: "stu-1", name: "Ana Diaz", sortKey: "diaz\u0000ana", factsName: "Diaz, Ana" },
  { id: "stu-2", name: "Ben Ortiz", sortKey: "ortiz\u0000ben", factsName: "Ortiz, Ben" },
];

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
});
after(() => db.close());

let n = 0;
async function course(tenant = "school-a") {
  const [c] = await myCourses(tenant, [{ id: `sbg${++n}`, name: `Course ${n}`, role: "teacher" }]);
  return c;
}

async function assignment(courseId: string, extra: Record<string, unknown> = {}): Promise<Assignment> {
  const a = await createAssignment(T, courseId, { title: `Task ${++n}` });
  const r = await saveAssignment(T, a.id, { baseVersion: a.version, published: true, gradesReleased: true, points: 10, ...extra });
  assert.ok(r.ok);
  return r.assignment;
}

const due = (day: string) => ({ dueOn: day, dueAt: `${day}T15:00:00.000Z` });

// ---------- the maths ----------

test("standards maths: default settings, labels and the conversion table", () => {
  const s = defaultSettings();
  assert.equal(s.labels.length, 4);
  assert.equal(s.summary, "recent");
  assert.deepEqual(defaultConversion(4).map((r) => r.min), [3.5, 3, 2.5, 2, 0]);
  // Every default percent lands in the letter it is meant to.
  assert.deepEqual(s.conversion.map((r) => letterFor(r.percent, DEFAULT_SCALES.bands[0].rows)), ["A", "B", "C", "D", "F"]);
  const d = dict("en"), es = dict("es");
  assert.equal(levelLabel(s, 4, levelWords(d)), "Exceeds");
  assert.equal(levelLabel(s, 1, levelWords(es)), "Inicial");
  const own = normalizeSettings({ labels: ["Mastered", "", "Not yet"], summary: "mean" });
  assert.equal(levelLabel(own, 3, levelWords(d)), "Mastered");
  assert.equal(levelLabel(own, 2, levelWords(d)), "2", "a 3-level scale has no default words");
  assert.deepEqual(own.conversion.map((r) => r.min), [2.63, 2.25, 1.88, 1.5, 0], "default cut-offs in proportion");
});

test("standards maths: settings from a browser are cleaned", () => {
  const s = normalizeSettings({
    labels: ["A", "B", "C", "D"], summary: "loudest",
    conversion: [{ min: 1, percent: 60 }, { min: 9, percent: 300 }, { min: "x", percent: 1 }, { min: 1, percent: 70 }, { min: 3, percent: 90 }],
  });
  assert.equal(s.summary, "recent");
  assert.deepEqual(s.conversion, [{ min: 4, percent: 100 }, { min: 3, percent: 90 }, { min: 0, percent: 60 }], "sorted, capped, deduped, last row from 0");
  assert.deepEqual(normalizeSettings({ labels: ["only one"] }).labels.length, 4, "too few levels: default scale");
  assert.equal(normalizeSettings({ labels: Array(9).fill("x") }).labels.length, 6);
  assert.deepEqual(normalizeSettings(null), defaultSettings());
});

test("standards maths: most recent, mean and highest; average and conversion", () => {
  const ev = [
    { level: 2, at: "2026-09-10", gradedAt: "2026-09-11" },
    { level: 4, at: "2026-09-01", gradedAt: "2026-09-20" },
    { level: 3, at: "2026-09-10", gradedAt: "2026-09-12" },
  ];
  assert.equal(summarize(ev, "recent"), 3, "latest due; a tie goes to the later grading");
  assert.equal(summarize(ev, "mean"), 3);
  assert.equal(summarize(ev, "highest"), 4);
  assert.equal(summarize([], "recent"), null);
  assert.equal(summarize([{ level: 2, at: "a", gradedAt: "a" }, { level: 3, at: "b", gradedAt: "b" }, { level: 3, at: "c", gradedAt: "c" }], "mean"), 2.67);
  assert.equal(averageLevel([3, null, 4, 3]), 3.33);
  assert.equal(averageLevel([null]), null);
  const s = defaultSettings();
  assert.equal(convert(3.5, s), 95);
  assert.equal(convert(3.49, s), 85);
  assert.equal(convert(1, s), 55);
  assert.equal(convert(null, s), null);
});

test("standards maths: alignment, levels and rubric rows", () => {
  const rubric = { criteria: [
    { id: "c1", title: "Claim", description: "", standardId: "s-b", levels: [{ id: "l4", title: "", points: 4, description: "" }, { id: "l1", title: "", points: 1, description: "" }] },
    { id: "c2", title: "Evidence", description: "", standardId: "s-c", levels: [{ id: "h", title: "", points: 10, description: "" }, { id: "m", title: "", points: 6, description: "" }, { id: "z", title: "", points: 0, description: "" }] },
    { id: "c3", title: "Spelling", description: "", levels: [{ id: "x", title: "", points: 2, description: "" }] },
  ] };
  assert.deepEqual(alignedStandards({ standards: ["s-a", "s-b"], rubric }), ["s-a", "s-b", "s-c"]);
  assert.deepEqual(cleanLevels(["s-a", "s-b"], 4, { "s-a": 3, "s-b": 5, "s-z": 2 }), { "s-a": 3 }, "out of range and unaligned refused");
  assert.deepEqual(cleanLevels(["s-a"], 4, { "s-a": 2.5 }), null, "whole levels only");
  assert.equal(criterionLevel(rubric.criteria[1].levels, "m", 4), 2, "6 of 10 → 2.4 → 2");
  assert.equal(criterionLevel(rubric.criteria[1].levels, "z", 4), 1, "never below 1");
  assert.deepEqual(levelsFromRubric(rubric, { c1: "l4", c2: "h", c3: "x" }, 4), { "s-b": 4, "s-c": 4 });
});

// ---------- points courses are untouched ----------

/** A points course with categories, drop lowest, missing, exempt and late work. */
async function pointsCourse() {
  const c = await course();
  const cat1 = await addCategory(T, c.id, "Tests", 60, 0);
  const cat2 = await addCategory(T, c.id, "Homework", 40, 1);
  const a1 = await assignment(c.id, { categoryId: cat1.id, points: 50, ...due("2026-09-10") });
  const a2 = await assignment(c.id, { categoryId: cat2.id, ...due("2026-09-12") });
  const a3 = await assignment(c.id, { categoryId: cat2.id, ...due("2026-09-14") });
  const a4 = await assignment(c.id, { categoryId: cat2.id, ...due("2026-09-16") });
  for (const [a, sid, g] of [
    [a1, "stu-1", { score: 41 }], [a2, "stu-1", { score: 9, flag: "late" }], [a3, "stu-1", { flag: "missing" }], [a4, "stu-1", { score: 7 }],
    [a1, "stu-2", { score: 30 }], [a2, "stu-2", { flag: "exempt" }], [a3, "stu-2", { score: 10 }],
  ] as const) assert.ok((await setGrade(T, a, sid, ROSTER, g)).ok);
  return { c, a1, a2, a3, a4 };
}

async function snapshot(courseId: string, period: Period | null = null) {
  const gb = await buildGradebook(T, courseId, STUDENTS, period);
  const own = await buildGradebook(T, courseId, [STUDENTS[0]], period, { releasedOnly: true });
  return { gb, csv: factsCsv(gb), own: own.rows[0] };
}

test("points course: standards data in the database changes nothing", async () => {
  for (const weighted of [false, true]) {
    const { c, a1, a2 } = await pointsCourse();
    await setWeighted(T, c.id, weighted);
    const before = await snapshot(c.id);
    assert.equal(before.gb.standards, null);
    assert.equal((await courseGrading(T, c.id)).mode, "points", "points is the default");

    // Standards, alignment and settings on a points course...
    const s1 = await addStandard(T, c.id, "RL.1", "Cite evidence");
    await saveStandardsSettings(T, c.id, { labels: ["W", "X", "Y", "Z"], summary: "highest" });
    const r = await saveAssignment(T, a1.id, { baseVersion: a1.version, standards: [s1!.id] });
    assert.ok(r.ok);
    // ...and a grade sent with levels: the levels are not stored, the score is.
    const g = await setGrade(T, r.assignment, "stu-1", ROSTER, { score: 41, levels: { [s1!.id]: 4 } });
    assert.ok(g.ok && !g.changed, "same score; levels ignored in a points course");
    assert.equal((await gradesFor(T, a1.id)).find((x) => x.studentId === "stu-1")!.levels, null);
    const g2 = await setGrade(T, a2, "stu-1", ROSTER, { score: 9, flag: "late", levels: { [s1!.id]: 4 } });
    assert.ok(g2.ok && !g2.changed);

    const after = await snapshot(c.id);
    assert.deepEqual(after.gb.rows.map((x) => [x.whole, x.letter, x.grade]), before.gb.rows.map((x) => [x.whole, x.letter, x.grade]));
    assert.equal(after.csv, before.csv, "FACTS file byte for byte the same");
    assert.deepEqual([after.own.whole, after.own.letter], [before.own.whole, before.own.letter]);
    assert.deepEqual(after.gb.checks, before.gb.checks);
    assert.equal(after.gb.rows[0].standards, undefined);

    // Switching to standards and back gives the same points grades.
    await setGradingMode(T, c.id, "standards");
    assert.notEqual((await snapshot(c.id)).gb.standards, null);
    await setGradingMode(T, c.id, "points");
    const back = await snapshot(c.id);
    assert.equal(back.csv, before.csv);
    assert.deepEqual(back.gb.rows.map((x) => x.grade), before.gb.rows.map((x) => x.grade));
  }
});

test("points course: the numbers are the ones worked out by hand", async () => {
  const { c } = await pointsCourse();
  const { gb, csv } = await snapshot(c.id);
  // Ana: Homework drops its lowest (the missing 0): 41 + 9 + 7 of 70 = 81.43 → 81 B−.
  assert.equal(gb.rows[0].whole, 81);
  assert.equal(gb.rows[0].letter, "B−");
  // Ben: exempt left out; 30 + 10 of 60 (one homework, never dropped) = 66.67 → 67 D+.
  assert.equal(gb.rows[1].whole, 67);
  assert.match(csv, /"Diaz, Ana",81,B-\r\n"Ortiz, Ben",67,D\+/);
});

// ---------- standards courses ----------

async function standardsCourse() {
  const c = await course();
  await setGradingMode(T, c.id, "standards");
  const sA = (await addStandard(T, c.id, "  RL.1 ", "Cite textual evidence"))!;
  const sB = (await addStandard(T, c.id, "W.2", "Write to explain"))!;
  return { c, sA, sB };
}

test("standards: list, edit, order, archive; another school can't touch them", async () => {
  const { c, sA, sB } = await standardsCourse();
  assert.equal(sA.code, "RL.1");
  assert.ok(sA.itemId && sA.editable, "typed into the course: an item of the course's own framework");
  assert.equal(await addStandard(T, c.id, "   ", "no code"), null);
  assert.ok(await updateStandard(T, c.id, sB.id, "W.2a", "Explain clearly"));
  assert.ok(await moveStandard(T, c.id, sB.id, -1));
  assert.deepEqual((await listStandards(T, c.id)).map((s) => s.code), ["W.2a", "RL.1"]);
  assert.equal(await updateStandard(OTHER, c.id, sA.id, "X", ""), false);
  assert.equal(await archiveStandard(OTHER, c.id, sA.id), false);
  assert.ok(await archiveStandard(T, c.id, sA.id));
  assert.deepEqual((await listStandards(T, c.id)).map((s) => s.code), ["W.2a"]);
  assert.equal((await listStandards(T, c.id, { withArchived: true })).length, 2);
});

test("standards: alignment keeps only this course's live standards and is versioned", async () => {
  const { c, sA, sB } = await standardsCourse();
  const other = await standardsCourse();
  const a = await assignment(c.id);
  const r = await saveAssignment(T, a.id, {
    baseVersion: a.version, standards: [sA.id, other.sA.id, "nonsense", sA.id],
    rubric: { criteria: [{ title: "Claim", standardId: sB.id, levels: [{ title: "Good", points: 4 }] }, { title: "Other", standardId: other.sB.id, levels: [{ points: 2 }] }] },
  });
  assert.ok(r.ok && r.changed);
  assert.deepEqual(r.assignment.standards, [sA.id]);
  assert.equal(r.assignment.rubric!.criteria[0].standardId, sB.id);
  assert.equal(r.assignment.rubric!.criteria[1].standardId, undefined, "another course's standard dropped");
  const again = await saveAssignment(T, a.id, { baseVersion: r.assignment.version, standards: [sA.id] });
  assert.ok(again.ok && !again.changed, "same alignment is no new version");
  const none = await saveAssignment(T, a.id, { baseVersion: r.assignment.version, standards: [] });
  assert.ok(none.ok && none.changed && none.assignment.standards === null);
});

test("standards: levels per standard, summaries, conversion to FACTS, student view", async () => {
  const { c, sA, sB } = await standardsCourse();
  const a1 = await assignment(c.id, { standards: [sA.id, sB.id], ...due("2026-09-08") });
  const a2 = await assignment(c.id, { standards: [sA.id], ...due("2026-09-15") });
  const a3 = await assignment(c.id, { standards: [sB.id], ...due("2026-09-22"), gradesReleased: false });
  const a4 = await assignment(c.id, { ...due("2026-09-23") }); // measures nothing

  // Ana: RL.1 4 then 2 (recent 2, mean 3, highest 4); W.2 3 then (unreleased) 4.
  assert.ok((await setGrade(T, a1, "stu-1", ROSTER, { levels: { [sA.id]: 4, [sB.id]: 3 } })).ok);
  assert.ok((await setGrade(T, a2, "stu-1", ROSTER, { levels: { [sA.id]: 2, [sB.id]: 4 } })).ok, "W.2 not measured by a2: dropped");
  assert.ok((await setGrade(T, a3, "stu-1", ROSTER, { levels: { [sB.id]: 4 } })).ok);
  assert.ok((await setGrade(T, a4, "stu-1", ROSTER, { score: 10 })).ok);
  assert.deepEqual((await gradesFor(T, a2.id))[0].levels, { [sA.id]: 2 });
  // Ben: exempt on a1 (left out), missing on a2 (no evidence), 1 on W.2 via a3.
  assert.ok((await setGrade(T, a1, "stu-2", ROSTER, { flag: "exempt", levels: { [sA.id]: 1 } })).ok);
  assert.ok((await setGrade(T, a2, "stu-2", ROSTER, { flag: "missing" })).ok);
  assert.ok((await setGrade(T, a3, "stu-2", ROSTER, { levels: { [sB.id]: 1 } })).ok);
  // Out of range: refused (stored as none), not an error.
  const bad = await setGrade(T, a3, "stu-2", ROSTER, { levels: { [sB.id]: 7 } });
  assert.ok(bad.ok);
  assert.equal((await gradesFor(T, a3.id)).find((g) => g.studentId === "stu-2")?.levels ?? null, null);
  assert.ok((await setGrade(T, a3, "stu-2", ROSTER, { levels: { [sB.id]: 1 } })).ok);
  assert.equal((await setGrade(T, a1, "stranger", ROSTER, { levels: { [sA.id]: 4 } })).ok, false, "only the class's students");

  let gb = await buildGradebook(T, c.id, STUDENTS, null);
  const ana = gb.rows[0], ben = gb.rows[1];
  assert.equal(ana.standards!.summaries[sA.id].level, 2, "most recent");
  assert.equal(ana.standards!.summaries[sB.id].level, 4);
  assert.equal(ana.standards!.average, 3);
  assert.equal(ana.whole, 85);
  assert.equal(ana.letter, "B");
  assert.equal(ben.standards!.summaries[sA.id].level, null, "exempt and missing are no evidence");
  assert.equal(ben.standards!.average, 1);
  assert.equal(ben.whole, 55);
  assert.equal(gb.standards!.checks.unaligned, 1);
  assert.equal(gb.checks.missing.length, 1);
  assert.equal(gb.checks.below70, 1);
  assert.equal(gb.checks.uncategorized, 0);
  assert.match(factsCsv(gb), /"Diaz, Ana",85,B\r\n"Ortiz, Ben",55,F/);

  await saveStandardsSettings(T, c.id, { summary: "mean" });
  gb = await buildGradebook(T, c.id, STUDENTS, null);
  assert.equal(gb.rows[0].standards!.summaries[sA.id].level, 3);
  assert.equal(gb.rows[0].standards!.summaries[sB.id].level, 3.5);
  assert.equal(gb.rows[0].standards!.average, 3.25);
  assert.equal(gb.rows[0].whole, 85);
  await saveStandardsSettings(T, c.id, { summary: "highest", conversion: [{ min: 3, percent: 90 }, { min: 0, percent: 70 }] });
  gb = await buildGradebook(T, c.id, STUDENTS, null);
  assert.equal(gb.rows[0].standards!.summaries[sA.id].level, 4);
  assert.equal(gb.rows[0].whole, 90);
  assert.equal(gb.rows[0].letter, "A−");

  // The student's own view: released work only (a3 isn't), so W.2 is 3.
  await saveStandardsSettings(T, c.id, {});
  const own = await buildGradebook(T, c.id, [STUDENTS[0]], null, { releasedOnly: true });
  assert.equal(own.rows[0].standards!.summaries[sB.id].level, 3);
  assert.equal(own.rows[0].standards!.average, 2.5);
  assert.equal(own.rows[0].whole, 75);

  // A period covers only work due in it.
  const sept1to10 = { id: "p", name: "Q1a", startsOn: "2026-09-01", endsOn: "2026-09-10" };
  const p = await buildGradebook(T, c.id, STUDENTS, sept1to10);
  assert.equal(p.rows[0].standards!.summaries[sA.id].level, 4);

  // An archived standard leaves the summaries; its scores stay in the database.
  await archiveStandard(T, c.id, sB.id);
  gb = await buildGradebook(T, c.id, STUDENTS, null);
  assert.deepEqual(Object.keys(gb.rows[0].standards!.summaries), [sA.id]);
  assert.equal(gb.rows[0].standards!.average, 2);
  assert.deepEqual((await gradesFor(T, a1.id)).find((g) => g.studentId === "stu-1")!.levels, { [sA.id]: 4, [sB.id]: 3 });

  const hist = await gradeHistory(T, a1.id, "stu-1");
  assert.deepEqual(hist[0].levels, { [sA.id]: 4, [sB.id]: 3 }, "levels kept in the history");
});

test("standards: a rubric row's levels count for its standard", async () => {
  const { c, sA } = await standardsCourse();
  const a = await assignment(c.id, {
    rubric: { criteria: [{ id: "c1", title: "Claim", standardId: sA.id, levels: [4, 3, 2, 1].map((p) => ({ id: `l${p}`, points: p })) }] },
  });
  assert.deepEqual(alignedStandards(a), [sA.id]);
  // The grading screen sends the levels the rubric gives; the server checks them like any other.
  const levels = levelsFromRubric(a.rubric, { c1: "l3" }, 4);
  assert.ok((await setGrade(T, a, "stu-1", ROSTER, { score: 3, rubric: { c1: "l3" }, levels })).ok);
  const gb = await buildGradebook(T, c.id, STUDENTS, null);
  assert.equal(gb.rows[0].standards!.summaries[sA.id].level, 3);
});

test("standards: Spanish for every new string", () => {
  const en = dict("en") as Record<string, unknown>, es = dict("es") as Record<string, unknown>;
  for (const k of ["byStandards", "standards", "addStandard", "summaryMethod", "conversion", "levelExceeds", "levelBeginning", "standardsConversionCheck", "alignStandards", "proficiency", "unalignedCount", "noLevelYet"]) {
    assert.ok(en[k], `en ${k}`);
    assert.ok(es[k] && JSON.stringify(es[k]) !== JSON.stringify(en[k]), `es ${k}`);
  }
});

test("standards: work given levels but no score reads as graded for students and parents", async () => {
  const { workStatus } = await import("../src/lib/family");
  const a = { kind: "online" as const, dueAt: "2026-09-01T12:00:00.000Z" };
  assert.equal(workStatus(a, null, { score: null, flag: null, levels: { x: 3 } }, new Date("2026-10-01")), "graded");
  assert.equal(workStatus(a, null, { score: null, flag: null, levels: null }, new Date("2026-10-01")), "overdue");
  const { c, sA } = await standardsCourse();
  const a1 = await assignment(c.id, { standards: [sA.id] });
  await setGrade(T, a1, "stu-1", ROSTER, { levels: { [sA.id]: 3 } });
  const own = await buildGradebook(T, c.id, [STUDENTS[0]], null, { releasedOnly: true });
  assert.equal(own.rows[0].cells[a1.id].leveled, true);
});
