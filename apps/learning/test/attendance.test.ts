import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses } from "../src/lib/courses";
import { noteTeacher } from "../src/lib/sections";
import { noteTeacherName } from "../src/lib/school-plans";
import { AttendanceError, checkAttendanceDay, classDay, schoolDay, schoolExport, takeAttendance } from "../src/lib/attendance";
import { csvCell } from "../src/lib/review";

// Attendance (teacher story 01, D6; migration 039).

let db: Db;
const T = { tenantId: "school-a", userId: "t1" };
const B = { tenantId: "school-b", userId: "t9" };
let course = "", other = "", foreign = "";
const MON = "2026-11-23", TUE = "2026-11-24", SAT = "2026-11-28";
const roster = new Map([["s1", "Ana Lopez"], ["s2", "Ben Cho"], ["s3", "=Cara"]]);

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
  const mine = await myCourses("school-a", [{ id: "a-1", name: "Bible 9", role: "teacher" }, { id: "a-2", name: "Art", role: "teacher" }], "t1");
  course = mine.find((c) => c.name === "Bible 9")!.id;
  other = mine.find((c) => c.name === "Art")!.id;
  foreign = (await myCourses("school-b", [{ id: "a-9", name: "Elsewhere", role: "teacher" }], "t9"))[0].id;
  await noteTeacher(T, course); await noteTeacher(T, other);
  await noteTeacherName("school-a", "t1", "Mr. Suarez");
});
after(() => db.close());

test("attendance: only school days, today or earlier", () => {
  assert.equal(checkAttendanceDay(MON, TUE), MON);
  assert.throws(() => checkAttendanceDay(SAT, "2026-11-30"), (e: AttendanceError) => e.code === "day", "never on the Sabbath or Sunday");
  assert.throws(() => checkAttendanceDay(TUE, MON), (e: AttendanceError) => e.code === "future");
  assert.throws(() => checkAttendanceDay("2026-02-30", TUE), (e: AttendanceError) => e.code === "day");
});

test("attendance: a teacher marks the class; only students on the roster, notes trimmed, saving again updates", async () => {
  const n = await takeAttendance(T, course, MON, TUE, [
    { studentId: "s1", status: "present" },
    { studentId: "s2", status: "absent", note: "  sick \n note " },
    { studentId: "s3", status: "tardy" },
    { studentId: "intruder", status: "absent" },
    { studentId: "s1", status: "absent" },
    { studentId: "s3", status: "asleep" },
  ], roster);
  assert.equal(n, 3, "not on the roster, twice, or a made-up status: ignored");
  let day = await classDay(T, course, MON);
  assert.deepEqual([...day.values()].map((m) => [m.studentId, m.name, m.status, m.note]).sort(), [
    ["s1", "Ana Lopez", "present", ""], ["s2", "Ben Cho", "absent", "sick note"], ["s3", "=Cara", "tardy", ""],
  ]);
  await takeAttendance({ ...T, userId: "t2" }, course, MON, TUE, [{ studentId: "s2", status: "excused", note: "doctor" }], roster);
  day = await classDay(T, course, MON);
  assert.equal(day.get("s2")?.status, "excused", "a co-teacher's correction replaces the mark");
  assert.equal(day.get("s1")?.status, "present", "students not sent keep their mark");
  assert.equal((await classDay(B, course, MON)).size, 0, "another school sees nothing");
  assert.equal((await classDay(T, course, TUE)).size, 0, "another day is not taken");
});

test("attendance: the school's day and export, for admins", async () => {
  await takeAttendance(B, foreign, MON, TUE, [{ studentId: "x", status: "absent" }], new Map([["x", "Elsewhere kid"]]));
  const day = await schoolDay("school-a", MON);
  assert.deepEqual(day.map((c) => [c.name, c.taken, c.teacher]), [["Art", false, "Mr. Suarez"], ["Bible 9", true, "Mr. Suarez"]], "not taken first");
  const bible = day.find((c) => c.name === "Bible 9")!;
  assert.deepEqual(bible.counts, { present: 1, absent: 0, tardy: 1, excused: 1 });
  assert.deepEqual(bible.notPresent.map((p) => [p.name, p.status]), [["=Cara", "tardy"], ["Ben Cho", "excused"]]);
  const rows = await schoolExport("school-a", MON, TUE);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.className === "Bible 9" && r.day === MON), "only this school");
  assert.equal(csvCell(rows.find((r) => r.studentId === "s3")!.studentName), "'=Cara", "a name can't run as a spreadsheet formula");
  assert.equal((await schoolExport("school-a", TUE, TUE)).length, 0);
});
