import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses } from "../src/lib/courses";
import { createLesson, saveLesson, setLessonStandards } from "../src/lib/lessons";
import { createAssignment, saveAssignment, archiveAssignment } from "../src/lib/assignments";
import { createResource } from "../src/lib/resources";
import { addStandard } from "../src/lib/standards";
import { createUnit } from "../src/lib/units";
import {
  weekPlan, planMaterial, unplanMaterial, movePlanItem, addDayStandard, removeDayStandard, plannable, PlanError, PLAN_LIMITS,
} from "../src/lib/week-plan";

// The planner picks any material and shows standards (migration 029, story 01 B1/B2).

let db: Db;
const T = { tenantId: "school-a", userId: "t1" };
const B = { tenantId: "school-b", userId: "t9" };
let course = "", other = "", foreign = "";
const MON = "2026-11-23", TUE = "2026-11-24", WED = "2026-11-25", SAT = "2026-11-28";

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
  [course, other] = (await myCourses("school-a", [{ id: "w-1", name: "Bible 9", role: "teacher" }, { id: "w-2", name: "Art", role: "teacher" }], "t1")).map((c) => c.id);
  foreign = (await myCourses("school-b", [{ id: "w-9", name: "Elsewhere", role: "teacher" }], "t9"))[0].id;
});
after(() => db.close());

test("week plan: lessons, picked materials, due work and the standards they measure, per day", async () => {
  const s1 = (await addStandard(T, course, "B.9.1", "Explains the Exodus narrative"))!;
  const s2 = (await addStandard(T, course, "B.9.2", "Compares the covenants"))!;
  const s3 = (await addStandard(T, course, "B.9.10", "Applies a passage to daily life"))!;
  const unit = (await createUnit(T, course, "Unit 3")).id;

  const lesson = await createLesson(T, course, "Crossing the Red Sea", []);
  await saveLesson(T, lesson.id, { baseVersion: lesson.version, plannedFor: MON });
  await setLessonStandards(T, lesson.id, [s1.id]);

  const quiz = await createAssignment(T, course, { title: "Chapter quiz", kind: "quiz" });
  const sheet = await createAssignment(T, course, { title: "Worksheet" });
  await saveAssignment(T, sheet.id, { baseVersion: sheet.version, standards: [s2.id], dueOn: WED, dueAt: `${WED}T23:59:00Z`, published: true, unitId: unit });
  const video = await createResource({ ...T, role: "teacher" }, course, { block: { type: "link", title: "Exodus video", url: "https://example.org/v" } });

  await planMaterial(T, course, MON, "assignment", sheet.id);
  await planMaterial(T, course, MON, "resource", video.id);
  await planMaterial(T, course, TUE, "assignment", quiz.id);
  const again = await planMaterial(T, course, MON, "assignment", sheet.id);
  await addDayStandard(T, course, MON, s3.id);
  await addDayStandard(T, course, MON, s1.id); // already measured by the lesson: kept once, marked by hand

  const [mon, tue, wed] = await weekPlan(T, course, [MON, TUE, WED]);
  assert.deepEqual(mon.lessons.map((l) => l.title), ["Crossing the Red Sea"]);
  assert.deepEqual(mon.materials.map((m) => [m.kind, m.title, m.sub, m.hidden]), [["assignment", "Worksheet", "online", false], ["resource", "Exodus video", "link", true]]);
  assert.equal(mon.materials.filter((m) => m.title === "Worksheet").length, 1, "once per day");
  assert.equal(again, mon.materials[0].itemId);
  assert.deepEqual(mon.standards.map((s) => [s.code, s.byHand, s.from]), [
    ["B.9.1", true, ["Crossing the Red Sea"]], ["B.9.2", false, ["Worksheet"]], ["B.9.10", true, []],
  ], "numeric code order; lessons, assignments and hand-added");
  assert.deepEqual(tue.materials.map((m) => [m.title, m.sub, m.hidden]), [["Chapter quiz", "quiz", true]]);
  assert.deepEqual(wed.due.map((a) => a.title), ["Worksheet"]);
  assert.deepEqual(wed.materials, []);

  // Move, take off, hand standard off.
  assert.ok(await movePlanItem(T, course, mon.materials[1].itemId, WED));
  assert.ok(await unplanMaterial(T, course, tue.materials[0].itemId));
  assert.ok(await removeDayStandard(T, course, MON, s3.id));
  const [mon2, tue2, wed2] = await weekPlan(T, course, [MON, TUE, WED]);
  assert.deepEqual(mon2.materials.map((m) => m.title), ["Worksheet"]);
  assert.deepEqual(tue2.materials, []);
  assert.deepEqual(wed2.materials.map((m) => m.title), ["Exodus video"]);
  assert.ok(!mon2.standards.some((s) => s.code === "B.9.10"));

  // An archived assignment drops off the plan (the material is the truth).
  await archiveAssignment(T, sheet.id);
  const [mon3] = await weekPlan(T, course, [MON]);
  assert.deepEqual(mon3.materials, []);
  assert.ok(!mon3.standards.some((s) => s.code === "B.9.2"));

  // What can be picked: the course's assignments and resources, with their folder.
  const picks = await plannable(T, course);
  assert.ok(picks.some((p) => p.kind === "assignment" && p.title === "Chapter quiz" && p.sub === "quiz"));
  assert.ok(picks.some((p) => p.kind === "resource" && p.title === "Exodus video"));
  assert.ok(!picks.some((p) => p.title === "Worksheet"), "archived work isn't offered");
});

test("week plan: only school days, only the course's own materials and standards, never another school's", async () => {
  const a = await createAssignment(T, course, { title: "Essay" });
  const elsewhere = await createAssignment(T, other, { title: "Art project" });
  const theirs = await createAssignment(B, foreign, { title: "Theirs" });
  const theirStd = (await addStandard(B, foreign, "X.1", "Not ours"))!;
  const otherStd = (await addStandard(T, other, "A.1", "Art standard"))!;
  const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return e instanceof PlanError ? e.code : String(e); } };

  assert.equal(await code(planMaterial(T, course, SAT, "assignment", a.id)), "day", "never on the Sabbath");
  assert.equal(await code(planMaterial(T, course, "2026-02-30", "assignment", a.id)), "day");
  assert.equal(await code(planMaterial(T, course, MON, "assignment", elsewhere.id)), "missing", "another class's");
  assert.equal(await code(planMaterial(T, course, MON, "assignment", theirs.id)), "missing", "another school's");
  assert.equal(await code(planMaterial(B, course, MON, "assignment", a.id)), "missing", "another school writing into ours");
  assert.equal(await code(planMaterial(T, course, MON, "lesson", a.id)), "missing", "lessons use planned_for");
  assert.equal(await code(addDayStandard(T, course, MON, otherStd.id)), "missing");
  assert.equal(await code(addDayStandard(T, course, MON, theirStd.id)), "missing");

  const id = await planMaterial(T, course, TUE, "assignment", a.id);
  assert.equal(await unplanMaterial(B, course, id), false, "another school can't take it off");
  assert.equal(await unplanMaterial(T, other, id), false, "nor through another class");
  assert.equal((await weekPlan(B, course, [TUE]))[0].materials.length, 0, "another school reads nothing");
  assert.equal((await weekPlan(T, course, [TUE]))[0].materials.length, 1);
});

test("week plan: a day holds at most so many materials", async () => {
  const day = "2026-12-01";
  for (let i = 0; i < PLAN_LIMITS.itemsPerDay; i++) {
    const a = await createAssignment(T, other, { title: `Item ${i}` });
    await planMaterial(T, other, day, "assignment", a.id);
  }
  const extra = await createAssignment(T, other, { title: "One more" });
  await assert.rejects(planMaterial(T, other, day, "assignment", extra.id), (e: PlanError) => e.code === "full");
});
