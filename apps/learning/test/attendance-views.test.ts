import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses } from "../src/lib/courses";
import { schoolExport, takeAttendance } from "../src/lib/attendance";
import {
  asView, classRows, gridOf, monthRange, pickPeriod, rangeRecords, rateOf, recentWeeksRange, schoolDaysBetween,
  slippingFirst, summarize, takenOn, weekRange, weeklyRates, type Rec,
} from "../src/lib/attendance-views";

// Week / month / term / trends views (Desmond 2026-11-23) and the home page's "Take attendance".

let db: Db;
const T = { tenantId: "school-a", userId: "t1" };
let course = "", other = "", foreign = "";
const roster = new Map([["s1", "Ana Lopez"], ["s2", "Ben Cho"]]);

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
  const mine = await myCourses("school-a", [{ id: "a-1", name: "Bible 9", role: "teacher" }, { id: "a-2", name: "Art", role: "teacher" }], "t1");
  course = mine.find((c) => c.name === "Bible 9")!.id;
  other = mine.find((c) => c.name === "Art")!.id;
  foreign = (await myCourses("school-b", [{ id: "a-9", name: "Elsewhere", role: "teacher" }], "t9"))[0].id;
});
after(() => db.close());

test("attendance views: ranges are school days only, never after today", () => {
  assert.equal(asView("month"), "month");
  assert.equal(asView("year"), "day", "anything else is the day view");
  const w = weekRange("2026-11-25", "2026-11-25");
  assert.deepEqual([w.from, w.to], ["2026-11-23", "2026-11-27"]);
  assert.deepEqual(w.days, ["2026-11-23", "2026-11-24", "2026-11-25"], "no days to come");
  assert.equal(w.prev, "2026-11-16");
  assert.equal(w.next, null, "no week after this one yet");
  assert.equal(weekRange("2026-11-11", "2026-11-25").next, "2026-11-16");
  const m = monthRange("2026-11-25", "2026-12-10");
  assert.deepEqual([m.from, m.to, m.prev, m.next], ["2026-11-01", "2026-11-30", "2026-10-01", "2026-12-01"]);
  assert.equal(m.days.length, 21, "November 2026's weekdays");
  assert.ok(m.days.every((d) => { const w = new Date(`${d}T12:00:00Z`).getUTCDay(); return w >= 1 && w <= 5; }), "never a Sabbath or Sunday");
  assert.equal(monthRange("2026-12-31", "2026-12-31").to, "2026-12-31");
  assert.equal(monthRange("2027-02-10", "2027-03-01").to, "2027-02-28");
  assert.equal(schoolDaysBetween("2026-01-01", "2030-01-01", "2030-01-01").length, 400, "capped");
  const r = recentWeeksRange("2026-11-25");
  assert.equal(r.from, "2026-10-05", "eight school weeks, from a Monday");
});

test("attendance views: the grading period shown", () => {
  const ps = [
    { id: "s1", name: "Semester 1", startsOn: "2026-08-17", endsOn: "2026-12-18" },
    { id: "q1", name: "Q1", startsOn: "2026-08-17", endsOn: "2026-10-16" },
    { id: "q2", name: "Q2", startsOn: "2026-10-19", endsOn: "2026-12-18" },
    { id: "q3", name: "Q3", startsOn: "2027-01-04", endsOn: "2027-03-12" },
  ];
  assert.equal(pickPeriod([], "2026-11-23"), null);
  assert.equal(pickPeriod(ps, "2026-11-23")?.id, "q2", "nested: the shortest one today is in");
  assert.equal(pickPeriod(ps, "2026-11-23", "s1")?.id, "s1", "the one asked for");
  assert.equal(pickPeriod(ps, "2026-11-23", "nope")?.id, "q2");
  assert.equal(pickPeriod(ps, "2026-12-28")?.id, "q2", "in a break: the last one started");
  assert.equal(pickPeriod(ps, "2026-01-05")?.id, "s1", "before any: the first");
});

const rec = (day: string, studentId: string, status: Rec["status"], courseId = "c1", name = studentId): Rec => ({ courseId, day, studentId, name, status });

test("attendance views: rates, who is slipping, the class by week", () => {
  assert.equal(rateOf({ present: 3, tardy: 1, absent: 1, excused: 5 }), 0.8, "tardy counts as there; excused not at all");
  assert.equal(rateOf({ present: 0, tardy: 0, absent: 0, excused: 2 }), null);
  const today = "2026-11-27";
  const recs: Rec[] = [];
  // Two earlier weeks: both there every day.
  for (const d of ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-09", "2026-11-10"]) {
    recs.push(rec(d, "s1", "present"), rec(d, "s2", "present"));
  }
  // The last two weeks: s1 still there; s2 misses three of five.
  for (const [d, s2] of [["2026-11-16", "absent"], ["2026-11-17", "present"], ["2026-11-18", "absent"], ["2026-11-23", "tardy"], ["2026-11-24", "present"]] as const) {
    recs.push(rec(d, "s1", "present"), rec(d, "s2", s2));
  }
  const rows = summarize(recs, today, new Map([["s1", "Ana"], ["s2", "Ben"], ["s3", "Cara (no marks)"]]));
  assert.deepEqual(rows.map((r) => r.name), ["Ana", "Ben", "Cara (no marks)"], "the roster's names, everyone listed");
  const ben = rows.find((r) => r.studentId === "s2")!;
  assert.deepEqual(ben.counts, { present: 9, absent: 2, tardy: 1, excused: 0 });
  assert.equal(ben.recentRate, 0.6);
  assert.equal(ben.earlierRate, 1);
  assert.equal(ben.slipping, true);
  assert.deepEqual(slippingFirst(rows).map((r) => r.studentId), ["s2"]);
  assert.equal(rows.find((r) => r.studentId === "s3")!.rate, null);
  // The school's view: one student's meetings across classes; a left student keeps their last name.
  const school = summarize([rec("2026-11-23", "s9", "absent", "c1", "Old Name"), rec("2026-11-24", "s9", "absent", "c2", "New Name"), rec("2026-11-25", "s9", "absent", "c1", "New Name")], today);
  assert.equal(school[0].name, "New Name");
  assert.equal(school[0].slipping, true, "three absences in two weeks");
  const range = { from: "2026-11-02", to: "2026-11-27", days: schoolDaysBetween("2026-11-02", "2026-11-27", today), prev: null, next: null };
  const weeks = weeklyRates(recs, range);
  assert.deepEqual(weeks.map((w) => w.monday), ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23"], "every week, even an untaken one");
  assert.deepEqual(weeks.map((w) => w.rate), [1, 1, 4 / 6, 1]);
  assert.equal(weeks[0].meetings, 5);
  const g = gridOf(recs, ["2026-11-16", "2026-11-17", "2026-11-19"]);
  assert.deepEqual(g.get("s2"), ["absent", "present", null]);
  const cls = classRows([{ courseId: "c1", name: "Bible", teacher: "T" }, { courseId: "c2", name: "Art", teacher: "" }], recs, ["2026-11-16", "2026-11-19"]);
  assert.equal(cls[0].daysTaken, 1);
  assert.deepEqual(cls[0].cells[0], { present: 1, absent: 1, tardy: 0, excused: 0 });
  assert.equal(cls[0].cells[1], null, "not taken that day");
  assert.equal(cls[1].daysTaken, 0);
});

test("attendance views: reads stay in the school and the classes asked for; a class's CSV is only that class", async () => {
  await takeAttendance(T, course, "2026-11-23", "2026-11-24", [{ studentId: "s1", status: "present" }, { studentId: "s2", status: "absent" }], roster);
  await takeAttendance(T, course, "2026-11-24", "2026-11-24", [{ studentId: "s1", status: "tardy" }], roster);
  await takeAttendance(T, other, "2026-11-24", "2026-11-24", [{ studentId: "s2", status: "present" }], roster);
  await takeAttendance({ tenantId: "school-b", userId: "t9" }, foreign, "2026-11-24", "2026-11-24", [{ studentId: "s1", status: "absent" }], roster);
  const recs = await rangeRecords("school-a", [course], "2026-11-23", "2026-11-27");
  assert.deepEqual(recs.map((r) => [r.day, r.studentId, r.status]).sort(), [["2026-11-23", "s1", "present"], ["2026-11-23", "s2", "absent"], ["2026-11-24", "s1", "tardy"]]);
  assert.equal((await rangeRecords("school-a", [foreign], "2026-11-01", "2026-11-30")).length, 0, "another school's class: nothing");
  assert.equal((await rangeRecords("school-a", [], "2026-11-01", "2026-11-30")).length, 0);
  const today = await takenOn("school-a", [course, other, foreign], "2026-11-24");
  assert.deepEqual(today.get(course), { present: 0, absent: 0, tardy: 1, excused: 0 });
  assert.deepEqual(today.get(other), { present: 1, absent: 0, tardy: 0, excused: 0 });
  assert.equal(today.has(foreign), false);
  assert.equal((await takenOn("school-a", [course], "2026-11-25")).size, 0, "not taken");
  const classCsv = await schoolExport("school-a", "2026-11-01", "2026-11-30", course);
  assert.equal(classCsv.length, 3);
  assert.ok(classCsv.every((r) => r.courseId === course));
  assert.equal((await schoolExport("school-a", "2026-11-01", "2026-11-30")).length, 4, "the school's has every class");
  assert.equal((await schoolExport("school-a", "2026-11-01", "2026-11-30", foreign)).length, 0, "another school's class id: nothing");
});
