import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses } from "../src/lib/courses";
import { createLesson, saveLesson, setLessonStandards } from "../src/lib/lessons";
import { createAssignment, saveAssignment } from "../src/lib/assignments";
import { addStandard } from "../src/lib/standards";
import { planMaterial } from "../src/lib/week-plan";
import { noteTeacherName, schoolTeachers, schoolWeekPlans, principalView } from "../src/lib/school-plans";

// The principal's weekly plans (story 01, B4; migration 031).

let db: Db;
const MON = "2026-11-23", TUE = "2026-11-24";
const WEEK = [MON, TUE, "2026-11-25", "2026-11-26", "2026-11-27"];
let bible = "", math = "", club = "", theirs = "";

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
  bible = (await myCourses("school-a", [{ id: "s-1", name: "Bible 9", role: "teacher" }], "t-ruth"))[0].id;
  math = (await myCourses("school-a", [{ id: "s-2", name: "Algebra", role: "teacher" }], "t-amos"))[0].id;
  // A co-teacher of Bible 9.
  await myCourses("school-a", [{ id: "s-1", name: "Bible 9", role: "teacher" }], "t-amos");
  club = (await myCourses("school-a", [{ id: "s-3", name: "Chess club", role: "teacher" }], "t-ruth"))[0].id;
  await db.query("UPDATE courses SET kind = 'club' WHERE id = $1", [club]);
  theirs = (await myCourses("school-b", [{ id: "s-9", name: "Elsewhere", role: "teacher" }], "t-other"))[0].id;
  await noteTeacherName("school-a", "t-ruth", "  Ruth   Ortiz ");
  await noteTeacherName("school-b", "t-other", "Someone Else");
});
after(() => db.close());

test("school plans: each teacher by their own name, with the classes they teach now (no clubs, no other school)", async () => {
  const ts = await schoolTeachers("school-a");
  assert.deepEqual(ts.map((t) => [t.userId, t.name, t.classes.map((c) => c.name).sort()]), [
    ["t-ruth", "Ruth Ortiz", ["Bible 9"]],
    ["t-amos", "", ["Algebra", "Bible 9"]],
  ], "named first; an unnamed teacher still listed; a club left out");
  // Someone not seen teaching for a long time drops off.
  const later = new Date(Date.now() + 90 * 86_400_000);
  assert.deepEqual(await schoolTeachers("school-a", later), []);
});

test("school plans: the week as planned, with standards; read-only views never show a quiz's key", async () => {
  const T = { tenantId: "school-a", userId: "t-ruth" };
  const s = (await addStandard(T, bible, "B.9.1", "Explains the Exodus"))!;
  const l = await createLesson(T, bible, "Red Sea", [{ id: "p1", type: "poll", question: "Who led?", choices: [{ id: "c1", text: "Moses", correct: true }, { id: "c2", text: "Aaron", correct: false }] }] as never);
  await saveLesson(T, l.id, { baseVersion: l.version, plannedFor: MON });
  await setLessonStandards(T, l.id, [s.id]);
  const q = await createAssignment(T, bible, { title: "Exodus quiz", kind: "quiz" });
  await planMaterial(T, bible, TUE, "assignment", q.id);

  const plans = await schoolWeekPlans("school-a", WEEK);
  const ruth = plans.find((p) => p.userId === "t-ruth")!;
  assert.equal(ruth.empty, false);
  const [bibleWeek] = ruth.classes;
  assert.deepEqual(bibleWeek.days[0].lessons.map((x) => x.title), ["Red Sea"]);
  assert.deepEqual(bibleWeek.days[0].standards.map((x) => x.code), ["B.9.1"]);
  assert.deepEqual(bibleWeek.days[1].materials.map((x) => [x.title, x.sub]), [["Exodus quiz", "quiz"]]);
  const amos = plans.find((p) => p.userId === "t-amos")!;
  assert.ok(amos.classes.find((c) => c.name === "Bible 9" && !c.empty), "the co-teacher sees the same class plan");
  assert.ok(amos.classes.find((c) => c.name === "Algebra")?.empty);
  assert.deepEqual((await schoolWeekPlans("school-a", WEEK, { teacher: "t-amos" })).map((t) => t.userId), ["t-amos"]);
  assert.deepEqual((await schoolWeekPlans("school-b", WEEK)).map((t) => t.name), ["Someone Else"], "another school sees only its own");

  const lv = await principalView("school-a", "lesson", l.id);
  assert.ok(lv?.kind === "lesson");
  const poll = lv.blocks[0] as unknown as { choices: { correct: boolean }[] };
  assert.ok(poll.choices.every((c) => !c.correct), "a poll's answer isn't shown");
  await saveAssignment(T, q.id, { baseVersion: Number((await db.query("SELECT version FROM assignments WHERE id = $1", [q.id]))[0].version), instructions: "Twenty minutes." });
  const qv = await principalView("school-a", "assignment", q.id);
  assert.ok(qv?.kind === "assignment" && qv.quiz && qv.instructions === "Twenty minutes.");
  assert.ok(!("items" in qv) && !JSON.stringify(qv).includes("correct"), "no questions or key");
  assert.equal(await principalView("school-b", "lesson", l.id), null, "another school's admin gets nothing");
  assert.equal(await principalView("school-a", "nonsense", l.id), null);
  assert.equal(await principalView("school-a", "lesson", "not-an-id"), null);
});
