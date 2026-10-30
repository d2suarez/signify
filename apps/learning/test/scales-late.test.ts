import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses } from "../src/lib/courses";
import { gradeFor, wholePercent } from "../src/lib/grade-math";
import { DEFAULT_SCALES, LEGACY_SCALE, bandFor, gpaText, normalizeScales, type SchoolScales } from "../src/lib/grade-scale";
import {
  finalScore, lateDays, normalizeCoursePolicy, normalizePolicies, penaltyFor, ruleFor, DEFAULT_LATE, type Applied, type LatePolicies,
} from "../src/lib/late-policy";
import {
  courseSetup, restoreSetting, saveLate, saveScales, schoolLate, schoolScales, setCourseBand, setCoursePolicy, settingHistory,
} from "../src/lib/school-grading";
import { assignmentPenalties, buildGradebook, factsCsv, toStudents } from "../src/lib/gradebook";
import { gradeHistory, gradesFor, setGrade } from "../src/lib/grades";
import { createAssignment, saveAssignment } from "../src/lib/assignments";
import { setGradingMode } from "../src/lib/standards";
import { lateFixture, STUDENTS } from "./fixtures/late-fixture";

let db: Db;
const TZ = "America/New_York";

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
});
after(() => db.close());

let n = 0;
const school = () => ({ tenantId: `school-sl${++n}`, userId: "admin-1" });

// ---------- scales ----------

// Desmond's scales, 2026-10-30, as ranges in his own words.
const TABLE_9_12: [string, number, number, number][] = [
  ["A", 94, 100, 4], ["A−", 90, 93, 3.67], ["B+", 87, 89, 3.33], ["B", 84, 86, 3], ["B−", 80, 83, 2.67], ["C+", 77, 79, 2.33],
  ["C", 74, 76, 2], ["C−", 70, 73, 1.67], ["D+", 67, 69, 1.33], ["D", 64, 66, 1], ["D−", 60, 63, 0.67], ["F", 0, 59, 0],
];
const TABLE_3_8: [string, number, number, number][] = [
  ["A", 94, 100, 4], ["A−", 90, 93, 3.667], ["B+", 88, 89, 3.333], ["B", 84, 87, 3], ["B−", 80, 83, 2.667], ["C+", 78, 79, 2.333],
  ["C", 74, 77, 2], ["C−", 70, 73, 1.667], ["D+", 68, 69, 1.333], ["D", 64, 67, 1], ["D−", 60, 63, 0.667], ["F", 0, 59, 0],
];

test("scales: Richmond's two bands give Desmond's letter and GPA for every whole percent", () => {
  for (const [band, table] of [[DEFAULT_SCALES.bands[0], TABLE_9_12], [DEFAULT_SCALES.bands[1], TABLE_3_8]] as const) {
    for (let p = 0; p <= 100; p++) {
      const [letter, , , gpa] = table.find(([, lo, hi]) => p >= lo && p <= hi)!;
      assert.deepEqual(gradeFor(p, band.rows), { letter, gpa }, `${band.name} ${p}%`);
    }
  }
  const hs = DEFAULT_SCALES.bands[0].rows;
  assert.equal(gradeFor(93.5, hs).letter, "A", "rounded to a whole percent first, half up");
  assert.equal(gradeFor(93.49, hs).letter, "A−");
  assert.equal(gradeFor(105, hs).letter, "A", "extra credit past 100");
  assert.deepEqual(gradeFor(null, hs), { letter: "", gpa: null });
  assert.equal(gpaText(4), "4.00");
  assert.equal(gpaText(3.67), "3.67");
  assert.equal(gpaText(3.667), "3.667");
  assert.equal(gpaText(0), "0.00");
});

test("scales: the old A 93 scale is kept only for comparison", () => {
  assert.equal(gradeFor(93, LEGACY_SCALE).letter, "A");
  assert.equal(gradeFor(93, DEFAULT_SCALES.bands[0].rows).letter, "A−");
});

test("scales: a school's own scale is checked, never guessed", () => {
  const band = (rows: unknown[], extra: Record<string, unknown> = {}) => ({ bands: [{ id: "x", name: "All", grades: ["9"], rows, ...extra }] });
  const ok = normalizeScales(band([{ letter: "P", min: 60, gpa: "" }, { letter: "F", min: 0, gpa: 0 }, { letter: "A-", min: 90, gpa: "3,7" }]));
  assert.ok(ok.ok);
  assert.deepEqual(ok.scales.bands[0].rows.map((r) => [r.letter, r.min, r.gpa]), [["A−", 90, 3.7], ["P", 60, null], ["F", 0, 0]], "top first; a typed A- is written A−");
  const problem = (input: unknown) => { const r = normalizeScales(input); return r.ok ? "ok" : r.problem; };
  assert.equal(problem({ bands: [] }), "noBands");
  assert.equal(problem(band([{ letter: "A", min: 90 }, { letter: "B", min: 80 }])), "noZero");
  assert.equal(problem(band([{ letter: "A", min: 90 }, { letter: "B", min: 90 }, { letter: "F", min: 0 }])), "sameMin");
  assert.equal(problem(band([{ letter: "A", min: 90 }, { letter: "A", min: 0 }])), "sameLetter");
  assert.equal(problem(band([{ letter: "A", min: 90.5 }, { letter: "F", min: 0 }])), "min");
  assert.equal(problem(band([{ letter: "A", min: 90, gpa: 9 }, { letter: "F", min: 0 }])), "gpa");
  assert.equal(problem(band([{ letter: "", min: 90 }, { letter: "F", min: 0 }])), "letter");
  assert.equal(problem(band([{ letter: "F", min: 0 }])), "rowCount");
  assert.equal(problem({ bands: [{ name: "A", grades: ["9"], rows: DEFAULT_SCALES.bands[0].rows }, { name: "B", grades: ["9", "10"], rows: DEFAULT_SCALES.bands[0].rows }] }), "gradeTwice");
  assert.equal(problem({ bands: [{ name: " ", rows: DEFAULT_SCALES.bands[0].rows }] }), "bandName");
});

test("scales: a course's band is the teacher's pick, else its grade levels, else the first band", () => {
  const s: SchoolScales = DEFAULT_SCALES;
  assert.equal(bandFor(s, { gradeBand: "3-8", gradeLevels: ["10"] }).band.id, "3-8");
  assert.equal(bandFor(s, { gradeBand: "3-8", gradeLevels: ["10"] }).from, "teacher");
  assert.equal(bandFor(s, { gradeBand: null, gradeLevels: ["6", "7"] }).band.id, "3-8");
  assert.equal(bandFor(s, { gradeBand: null, gradeLevels: ["8", "9"] }).band.id, "9-12", "a tie goes to the higher band");
  assert.equal(bandFor(s, { gradeBand: null, gradeLevels: ["7", "8", "9"] }).band.id, "3-8", "most grade levels wins");
  assert.deepEqual(bandFor(s, { gradeBand: "gone", gradeLevels: ["K"] }).from, "first");
});

test("scales: saves are versioned, a stale save is refused, history is kept and restorable, schools are apart", async () => {
  const a = school();
  assert.deepEqual((await schoolScales(a.tenantId)).value, DEFAULT_SCALES, "no row = Richmond's defaults");
  const mine = structuredClone(DEFAULT_SCALES);
  mine.bands[0].rows[0].min = 95;
  const s1 = await saveScales(a, mine, 0);
  assert.ok(s1.ok);
  assert.equal(s1.setting.version, 1);
  const stale = await saveScales(a, DEFAULT_SCALES, 0);
  assert.ok(!stale.ok && stale.reason === "stale");
  const bad = await saveScales(a, { bands: [{ name: "x", rows: [{ letter: "A", min: 90 }] }] }, 1);
  assert.ok(!bad.ok && bad.reason === "bad" && bad.problem === "rowCount" && bad.band === 0);
  const renamed = structuredClone(mine);
  renamed.bands[1].name = "Middle school";
  assert.ok((await saveScales(a, renamed, 1)).ok);

  const history = await settingHistory(a.tenantId, "scales");
  assert.deepEqual(history.map((h) => h.version), [1]);
  assert.equal(history[0].value.bands[0].rows[0].min, 95);
  assert.ok(await restoreSetting(a, "scales", history[0].id, 2));
  const now = await schoolScales(a.tenantId);
  assert.equal(now.version, 3);
  assert.equal(now.value.bands[1].name, "Grades 3–8", "the old version is back, as a new save");
  assert.equal((await settingHistory(a.tenantId, "scales")).length, 2);
  assert.deepEqual((await schoolScales(school().tenantId)).value, DEFAULT_SCALES, "another school is untouched");
  assert.equal(await restoreSetting(school(), "scales", history[0].id, 0), false, "another school can't restore this one's version");
});

test("scales: the gradebook, FACTS file and GPA follow the course's band from Signify ID or the teacher", async () => {
  const T = school();
  const [hs] = await myCourses(T.tenantId, [{ id: "hs", name: "Econ", role: "teacher", grade_levels: ["11", "12"] }]);
  const [ms] = await myCourses(T.tenantId, [{ id: "ms", name: "Science 6", role: "teacher", grade_levels: ["6"] }]);
  const students = toStudents([{ id: "s1", display_name: "Ana Diaz", role: "student" }]);
  for (const c of [hs, ms]) {
    const a = await createAssignment(T, c.id, { title: "Test" });
    const r = await saveAssignment(T, a.id, { baseVersion: a.version, published: true, points: 100 });
    assert.ok(r.ok);
    await setGrade(T, r.assignment, "s1", new Set(["s1"]), { score: 87 });
  }
  const hsBook = await buildGradebook(T, hs.id, students, null);
  assert.deepEqual([hsBook.band.id, hsBook.band.from, hsBook.rows[0].letter, hsBook.rows[0].gpa], ["9-12", "grades", "B+", 3.33]);
  assert.match(factsCsv(hsBook), /"Diaz, Ana",87,B\+\r\n/);
  const msBook = await buildGradebook(T, ms.id, students, null);
  assert.deepEqual([msBook.band.id, msBook.rows[0].letter, msBook.rows[0].gpa], ["3-8", "B", 3]);

  assert.ok(await setCourseBand(T, ms.id, "9-12"));
  assert.equal((await buildGradebook(T, ms.id, students, null)).rows[0].letter, "B+", "the teacher's pick wins");
  assert.equal(await setCourseBand(T, ms.id, "nope"), false);
  assert.ok(await setCourseBand(T, ms.id, null));
  assert.equal((await courseSetup(T, ms.id)).bandFrom, "grades");

  // A standards course's converted percent uses the same scale.
  await setGradingMode(T, hs.id, "standards");
  assert.deepEqual((await buildGradebook(T, hs.id, students, null)).scale, DEFAULT_SCALES.bands[0].rows);
});

// ---------- late: how late ----------

test("late days: school days after the due day, at least 1, nothing for Sabbath hours", () => {
  const due = "2026-11-02T20:00:00.000Z"; // Monday 2 Nov, 3 pm Eastern
  assert.equal(lateDays(due, "2026-11-02T19:59:00.000Z", TZ), 0, "on time");
  assert.equal(lateDays(due, "2026-11-02T20:00:00.000Z", TZ), 0, "exactly at the due time");
  assert.equal(lateDays(due, "2026-11-02T22:00:00.000Z", TZ), 1, "same day, after the time");
  assert.equal(lateDays(due, "2026-11-03T13:00:00.000Z", TZ), 1, "Tuesday");
  assert.equal(lateDays(due, "2026-11-05T13:00:00.000Z", TZ), 3, "Thursday");
  assert.equal(lateDays(due, "2026-11-08T15:00:00.000Z", TZ), 4, "Sunday: the weekend adds nothing");
  assert.equal(lateDays(due, "2026-11-09T15:00:00.000Z", TZ), 5, "next Monday");
  const fri = "2026-11-06T20:00:00.000Z"; // Friday 3 pm
  assert.equal(lateDays(fri, "2026-11-07T01:00:00.000Z", TZ), 1, "Friday 8 pm: late before the Sabbath began");
  assert.equal(lateDays(fri, "2026-11-09T14:00:00.000Z", TZ), 1, "Monday after a Friday due date");
  const friEvening = "2026-11-07T00:00:00.000Z"; // Friday 7 pm: in the Sabbath
  assert.equal(lateDays(friEvening, "2026-11-07T23:00:00.000Z", TZ), 0, "late only during Sabbath hours costs nothing");
  assert.equal(lateDays(friEvening, "2026-11-08T14:00:00.000Z", TZ), 1, "Sunday morning: late after the Sabbath");
  assert.equal(lateDays("2026-11-07T15:00:00.000Z", "2026-11-07T20:00:00.000Z", TZ), 0, "due Saturday, in Saturday");
});

// ---------- late: policies ----------

const perDay: Applied = { kind: "perDay", percent: 10, max: 50, name: "Standard", from: "school" };

test("penalty: per day with a cap, flat, none; never below 0; missing and exempt untouched", () => {
  const cell = (over: Record<string, unknown>) => ({ score: 18, flag: null, autoDays: null, override: null, ...over }) as Parameters<typeof penaltyFor>[2];
  assert.equal(penaltyFor(perDay, 20, cell({})), null, "not late");
  assert.deepEqual(penaltyFor(perDay, 20, cell({ autoDays: 2 })), { days: 2, percent: 20, points: 4, rule: "Standard", override: null });
  assert.equal(penaltyFor(perDay, 20, cell({ autoDays: 8 }))!.percent, 50, "capped");
  assert.equal(penaltyFor(perDay, 20, cell({ autoDays: 0 }))!.percent, 0, "Sabbath hours only");
  assert.equal(penaltyFor(perDay, 15, cell({ flag: "late" }))!.days, 1, "paper work marked Late = 1 day");
  assert.equal(penaltyFor({ ...perDay, kind: "flat", percent: 20 }, 20, cell({ autoDays: 5 }))!.points, 4);
  assert.equal(penaltyFor({ ...perDay, kind: "none" }, 20, cell({ autoDays: 5 }))!.points, 0);
  assert.equal(penaltyFor(perDay, 20, cell({ score: null, flag: "missing", autoDays: 3 })), null, "missing stays 0 by its own rule");
  assert.equal(penaltyFor(perDay, 20, cell({ flag: "exempt", autoDays: 3 })), null);
  assert.equal(penaltyFor(null, 20, cell({ autoDays: 3 })), null, "no policy: a mark only");
  const big = penaltyFor(perDay, 20, cell({ score: 2, autoDays: 3 }))!;
  assert.equal(finalScore(2, big), 0, "never below 0");
  assert.equal(finalScore(18, null), 18);
  // Teacher overrides.
  assert.equal(penaltyFor(perDay, 20, cell({ autoDays: 3, override: { waive: true } }))!.points, 0);
  assert.equal(penaltyFor(perDay, 20, cell({ autoDays: 3, override: { percent: 5 } }))!.points, 1);
  assert.equal(penaltyFor(perDay, 20, cell({ flag: "late", override: { days: 4 } }))!.percent, 40);
});

test("policies: the first rule that fits the band, category and kind; teachers' own within the school's choice", () => {
  const school: LatePolicies = normalizePolicies({
    rules: [
      { name: "Quizzes free", kind: "none", kinds: ["quiz"] },
      { name: "HS homework", kind: "flat", percent: 20, bands: ["9-12"], categories: [" Homework "] },
      { name: "Everything else", kind: "perDay", percent: 10, max: 50 },
    ],
    teachers: "within", limits: { minPercent: 5, maxPercent: 15, maxCap: 60 },
  });
  const rule = (band: string, category: string | null, kind: "online" | "offline" | "quiz") => ruleFor(school, null, { band, category, kind })?.name;
  assert.equal(rule("9-12", "Homework", "quiz"), "Quizzes free");
  assert.equal(rule("9-12", "HOMEWORK", "offline"), "HS homework", "category names match without case");
  assert.equal(rule("3-8", "Homework", "online"), "Everything else");
  assert.equal(rule("9-12", null, "online"), "Everything else", "uncategorized only fits a rule for every category");
  assert.equal(ruleFor(DEFAULT_LATE, null, { band: "9-12", category: null, kind: "online" }), null, "no policies: none applies");

  assert.deepEqual(normalizeCoursePolicy({ kind: "perDay", percent: 12, max: 60 }, school), { ok: true, policy: { kind: "perDay", percent: 12, max: 60 } });
  assert.deepEqual(normalizeCoursePolicy({ kind: "perDay", percent: 20, max: 50 }, school), { ok: false, reason: "outsideLimits" });
  assert.deepEqual(normalizeCoursePolicy({ kind: "perDay", percent: 10, max: 80 }, school), { ok: false, reason: "outsideLimits" }, "cap past the limit");
  assert.deepEqual(normalizeCoursePolicy({ kind: "none" }, school), { ok: false, reason: "outsideLimits" }, "no penalty only when the lowest allowed is 0");
  assert.deepEqual(normalizeCoursePolicy({ kind: "flat", percent: 5 }, { ...school, teachers: "no" }), { ok: false, reason: "notAllowed" });
  assert.deepEqual(normalizeCoursePolicy(null, school), { ok: true, policy: null });
  const own = { kind: "flat" as const, percent: 12, max: 0 };
  assert.equal(ruleFor(school, own, { band: "9-12", category: null, kind: "quiz" })!.from, "course", "the teacher's own replaces the school's");
  assert.equal(ruleFor({ ...school, teachers: "no" }, own, { band: "9-12", category: null, kind: "quiz" })!.name, "Quizzes free", "ignored once the school says no");
  assert.equal(ruleFor({ ...school, limits: { ...school.limits, maxPercent: 10 } }, own, { band: "9-12", category: null, kind: "online" })!.from, "school", "ignored once outside new limits");
});

// ---------- late: in the gradebook ----------

const FACTS_BEFORE = {
  Economics: "﻿Student,Percent,Letter\r\n\"Kim, =Eve\",42,F\r\n\"Lee Jr., Cara\",87,B+\r\n\"Ortiz, Ben\",91,A-\r\n\"Patel, Dev\",49,F\r\n\"Rodriguez, Ana\",93,A\r\n",
  Biology: "﻿Student,Percent,Letter\r\n\"Kim, =Eve\",75,C\r\n\"Lee Jr., Cara\",77,C+\r\n\"Ortiz, Ben\",88,B+\r\n\"Patel, Dev\",92,A-\r\n\"Rodriguez, Ana\",92,A-\r\n",
};

test("no late policy: grades and FACTS files are byte for byte what they were before this feature", async () => {
  // FACTS_BEFORE was printed by test/fixtures/late-fixture.ts on main 524a9b7, before school scales and late policies.
  const T = school();
  // The school keeps the old A 93 scale: everything is identical.
  const legacy = { bands: [{ id: "all", name: "All", grades: [], rows: LEGACY_SCALE }] };
  assert.ok((await saveScales(T, legacy, 0)).ok);
  const f = await lateFixture(T, "nolate");
  for (const c of [f.points, f.weighted]) {
    const gb = await buildGradebook(T, c.id, STUDENTS, null);
    assert.equal(factsCsv(gb), FACTS_BEFORE[c.name as keyof typeof FACTS_BEFORE], `${c.name}: FACTS file unchanged`);
    assert.ok(gb.rows.every((r) => Object.values(r.cells).every((cell) => cell.penalty === null)), "no penalty anywhere");
  }
  // A policy that fits nothing in these courses changes nothing either.
  assert.ok((await saveLate(T, { rules: [{ kind: "perDay", percent: 10, bands: ["elsewhere"] }] }, 0)).ok);
  for (const c of [f.points, f.weighted]) {
    assert.equal(factsCsv(await buildGradebook(T, c.id, STUDENTS, null)), FACTS_BEFORE[c.name as keyof typeof FACTS_BEFORE]);
  }
  // Richmond's scale: the same percents; only letters the new cut-offs move (93 is A− now).
  const R = school();
  const g = await lateFixture(R, "richmond");
  const econ = factsCsv(await buildGradebook(R, g.points.id, STUDENTS, null));
  assert.equal(econ, FACTS_BEFORE.Economics.replace("93,A\r\n", "93,A-\r\n"));
  assert.equal(factsCsv(await buildGradebook(R, g.weighted.id, STUDENTS, null)), FACTS_BEFORE.Biology);
});

test("late policy: applied automatically; raw, penalty and final shown; missing 0, exempt out, never below 0", async () => {
  const T = school();
  const f = await lateFixture(T, "late");
  assert.ok((await saveLate(T, { rules: [{ name: "Standard", kind: "perDay", percent: 10, max: 50 }] }, 0)).ok);
  const gb = await buildGradebook(T, f.points.id, STUDENTS, null);
  const row = (id: string) => gb.rows.find((r) => r.student.id === id)!;
  const ana = row("lf-1");
  assert.deepEqual([ana.cells[f.essay.id].score, ana.cells[f.essay.id].autoDays, ana.cells[f.essay.id].penalty?.points], [19, 2, 4], "two school days, 20% of 20");
  assert.equal(ana.cells[f.quiz.id].penalty?.days, 1, "paper work marked Late");
  assert.equal(ana.whole, wholePercent(((19 - 4) + (14 - 1.5) + 9) / 45 * 100));
  assert.equal(row("lf-3").cells[f.essay.id].penalty?.percent, 50, "eight days, capped at 50%");
  assert.equal(row("lf-3").cells[f.quiz.id].penalty, null, "exempt");
  assert.equal(row("lf-2").cells[f.essay.id].penalty, null, "on time");
  const dev = row("lf-4");
  assert.equal(dev.cells[f.essay.id].penalty?.points, 2);
  assert.equal(dev.grade.percent, ((0) + (15 - 1.5)) / 35 * 100, "2 less 2 is 0, never below; homework ungraded");
  assert.equal(row("lf-5").cells[f.essay.id].penalty, null, "missing stays a plain 0");
  assert.equal(row("lf-5").whole, wholePercent((0 + 9 + 10) / 45 * 100));

  // The single-assignment view (grading desk, student page, passback) agrees with the gradebook.
  const one = await assignmentPenalties(T, f.essay, await gradesFor(T, f.essay.id));
  assert.equal(one.rule?.name, "Standard");
  assert.equal(one.byStudent.get("lf-1")?.penalty?.points, 4);
  assert.equal(one.byStudent.get("lf-2")?.penalty, null);

  // The student's own view counts the final score too.
  const own = await buildGradebook(T, f.points.id, STUDENTS.filter((s) => s.id === "lf-1"), null, { releasedOnly: true });
  assert.equal(own.rows[0].whole, ana.whole);
});

test("late override: waive or change per grade, kept in the grade history; the grid's saves leave it alone", async () => {
  const T = school();
  const f = await lateFixture(T, "override");
  assert.ok((await saveLate(T, { rules: [{ kind: "perDay", percent: 10, max: 50 }] }, 0)).ok);
  const r = await setGrade(T, f.essay, "lf-1", f.ROSTER, { score: 19, late: { waive: true } });
  assert.ok(r.ok && r.changed);
  let gb = await buildGradebook(T, f.points.id, STUDENTS, null);
  let ana = gb.rows.find((x) => x.student.id === "lf-1")!;
  assert.deepEqual(ana.cells[f.essay.id].penalty?.points, 0);
  assert.deepEqual(ana.cells[f.essay.id].lateOverride, { waive: true });

  await setGrade(T, f.essay, "lf-1", f.ROSTER, { score: 19, comment: "Good" }); // no `late` sent: kept
  await setGrade(T, f.essay, "lf-1", f.ROSTER, { score: 19, comment: "Good", late: { percent: 5 } });
  gb = await buildGradebook(T, f.points.id, STUDENTS, null);
  ana = gb.rows.find((x) => x.student.id === "lf-1")!;
  assert.equal(ana.cells[f.essay.id].penalty?.points, 1);
  const history = await gradeHistory(T, f.essay.id, "lf-1");
  assert.deepEqual(history.slice(0, 3).map((h) => h.lateOverride), [{ percent: 5 }, { waive: true }, { waive: true }]);
  await setGrade(T, f.essay, "lf-1", f.ROSTER, { score: 19, comment: "Good", late: null });
  assert.equal((await gradesFor(T, f.essay.id)).find((g) => g.studentId === "lf-1")!.lateOverride, null, "back to the policy");
  const same = await setGrade(T, f.essay, "lf-1", f.ROSTER, { score: 19, comment: "Good", late: { bogus: 1 } });
  assert.ok(same.ok && !same.changed, "an override that isn't one is no override");
});

test("late policy: a teacher's own, when the school allows it; the school's choice wins", async () => {
  const T = school();
  const f = await lateFixture(T, "own");
  assert.deepEqual(await setCoursePolicy(T, f.points.id, { kind: "flat", percent: 5 }), { ok: false, reason: "notAllowed" });
  assert.ok((await saveLate(T, { rules: [{ kind: "perDay", percent: 10, max: 50 }], teachers: "within", limits: { minPercent: 0, maxPercent: 10, maxCap: 50 } }, 0)).ok);
  assert.deepEqual(await setCoursePolicy(T, f.points.id, { kind: "flat", percent: 25 }), { ok: false, reason: "outsideLimits" });
  assert.deepEqual(await setCoursePolicy(T, f.points.id, { kind: "flat", percent: 5 }), { ok: true });
  const gb = await buildGradebook(T, f.points.id, STUDENTS, null);
  assert.equal(gb.rows.find((r) => r.student.id === "lf-1")!.cells[f.essay.id].penalty?.points, 1, "5% of 20, flat");
  assert.equal((await buildGradebook(T, f.weighted.id, STUDENTS, null)).lateRules[f.h1.id]?.from, "school", "only that course");
  // The school stops allowing it: the school's policy applies again.
  const cur = await schoolLate(T.tenantId);
  assert.ok((await saveLate(T, { ...cur.value, teachers: "no" }, cur.version)).ok);
  const again = await buildGradebook(T, f.points.id, STUDENTS, null);
  assert.equal(again.rows.find((r) => r.student.id === "lf-1")!.cells[f.essay.id].penalty?.points, 4);
});

test("late policy: a standards course is unaffected (levels, not scores)", async () => {
  const T = school();
  const f = await lateFixture(T, "sbg");
  assert.ok((await saveLate(T, { rules: [{ kind: "flat", percent: 50 }] }, 0)).ok);
  await setGradingMode(T, f.points.id, "standards");
  const gb = await buildGradebook(T, f.points.id, STUDENTS, null);
  assert.deepEqual(gb.lateRules, {});
  assert.equal((await assignmentPenalties(T, f.essay, await gradesFor(T, f.essay.id))).byStudent.size, 0);
});
