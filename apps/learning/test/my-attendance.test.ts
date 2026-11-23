import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses } from "../src/lib/courses";
import { takeAttendance } from "../src/lib/attendance";
import { studentAttendance } from "../src/lib/my-attendance";
import { dict } from "../src/lib/i18n";

// A student's own attendance, for the student and their parents (story 01, D6 read side).

let db: Db;
const T = { tenantId: "school-a", userId: "t1" };
const roster = new Map([["s1", "Ana"], ["s2", "Ben"]]);

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
});
after(() => db.close());

test("my attendance: counts and the days not present, newest first, own record only, no notes", async () => {
  const [econ, art] = (await myCourses("school-a", [{ id: "i-1", name: "Econ", role: "teacher" }, { id: "i-2", name: "Art", role: "teacher" }], "t1")).map((c) => c.id);
  const today = "2026-11-20";
  await takeAttendance(T, econ, "2026-11-16", today, [{ studentId: "s1", status: "present" }, { studentId: "s2", status: "absent", note: "sick" }], roster);
  await takeAttendance(T, econ, "2026-11-17", today, [{ studentId: "s1", status: "tardy", note: "PRIVATE bus" }, { studentId: "s2", status: "present" }], roster);
  await takeAttendance(T, econ, "2026-11-18", today, [{ studentId: "s1", status: "excused" }], roster);
  await takeAttendance(T, art, "2026-11-18", today, [{ studentId: "s1", status: "absent" }], roster);

  const mine = await studentAttendance("school-a", [econ], "s1");
  const a = mine.get(econ)!;
  assert.deepEqual(a.counts, { present: 1, absent: 0, tardy: 1, excused: 1 });
  assert.equal(a.days, 3);
  assert.deepEqual(a.notPresent, [{ day: "2026-11-18", status: "excused" }, { day: "2026-11-17", status: "tardy" }]);
  assert.ok(!JSON.stringify(a).includes("PRIVATE"), "the teacher's notes never reach the family");
  assert.ok(!mine.has(art), "only the classes asked for");

  const ben = (await studentAttendance("school-a", [econ, art], "s2"));
  assert.deepEqual(ben.get(econ)!.counts, { present: 1, absent: 1, tardy: 0, excused: 0 });
  assert.equal(ben.get(art)!.days, 0, "a class with nothing taken");
  assert.equal((await studentAttendance("school-b", [econ], "s1")).get(econ)!.days, 0, "another school sees nothing");
});

test("my attendance: Spanish for every new string", () => {
  const en = dict("en"), es = dict("es");
  for (const k of ["attMine", "attMineNone", "attMineDays", "attMineAllPresent"] as const) {
    assert.ok(es[k] && es[k] !== en[k] || k === "attMine", k);
  }
});
