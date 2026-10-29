import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { normalizeBlocks, forStudent, newBlock, BlockError, LIMITS } from "../src/lib/blocks";
import { createLesson, getLesson, saveLesson, listVersions, restoreVersion, listLessons, KEEP_VERSIONS } from "../src/lib/lessons";
import { myCourses, courseFor, roleInClass } from "../src/lib/courses";

let db: Db;
const A = { tenantId: "school-a", userId: "teacher-1" };
const B = { tenantId: "school-b", userId: "teacher-9" };

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
});
after(() => db.close());

// ---------- blocks ----------

test("blocks: unknown types are dropped, not fatal", () => {
  const out = normalizeBlocks([{ type: "text", title: "Hi", body: "x" }, { type: "hologram" }, null, 5]);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "text");
});

test("blocks: ids are made safe and unique", () => {
  const out = normalizeBlocks([
    { id: "same", type: "text", title: "a" },
    { id: "same", type: "text", title: "b" },
    { id: "<script>", type: "timer", seconds: 60 },
  ]);
  const ids = out.map((b) => b.id);
  assert.equal(new Set(ids).size, 3);
  assert.equal(ids[0], "same");
  assert.ok(ids.every((id) => /^[A-Za-z0-9_-]+$/.test(id)));
});

test("blocks: text is trimmed and capped; titles are one line", () => {
  const [b] = normalizeBlocks([{ type: "text", title: "  two\nlines  ", body: "x".repeat(LIMITS.body + 50) }]);
  assert.equal(b.type === "text" && b.title, "two lines");
  assert.equal(b.type === "text" && b.body.length, LIMITS.body);
});

test("blocks: polls keep 2–8 choices and only a real true marks one correct", () => {
  const [few] = normalizeBlocks([{ type: "poll", question: "Q", choices: [{ text: "only", correct: "yes" }] }]);
  assert.equal(few.type === "poll" && few.choices.length, 2);
  assert.equal(few.type === "poll" && few.choices[0].correct, false);
  const many = normalizeBlocks([{ type: "poll", choices: Array.from({ length: 12 }, (_, i) => ({ text: String(i) })) }])[0];
  assert.equal(many.type === "poll" && many.choices.length, LIMITS.maxChoices);
});

test("blocks: timers are clamped to 10 s – 60 min", () => {
  const [lo, hi, junk] = normalizeBlocks([
    { type: "timer", seconds: 1 }, { type: "timer", seconds: 99999 }, { type: "timer", seconds: "abc" },
  ]);
  assert.deepEqual([lo, hi, junk].map((b) => b.type === "timer" && b.seconds), [10, 3600, 180]);
});

test("blocks: too many blocks is refused outright", () => {
  assert.throws(() => normalizeBlocks(Array.from({ length: LIMITS.blocks + 1 }, () => ({ type: "text" }))), BlockError);
});

test("blocks: a student never receives the answer key", () => {
  const poll = normalizeBlocks([{ type: "poll", question: "Q", choices: [{ text: "a", correct: true }, { text: "b" }] }])[0];
  const seen = forStudent(poll);
  assert.ok(seen.type === "poll" && seen.choices.every((c) => c.correct === false));
  assert.ok(poll.type === "poll" && poll.choices[0].correct, "the original is untouched");
});

// ---------- courses ----------

test("courses: a teacher's classes become courses; a student sees only opened ones", async () => {
  const teacherView = await myCourses("school-a", [
    { id: "c1", name: "AP Micro", role: "teacher" },
    { id: "c2", name: "Kid's class", role: "parent" },
  ]);
  assert.deepEqual(teacherView.map((c) => c.name), ["AP Micro"]);

  const studentView = await myCourses("school-a", [
    { id: "c1", name: "AP Micro", role: "student" },
    { id: "c3", name: "Not opened yet", role: "student" },
  ]);
  assert.deepEqual(studentView.map((c) => [c.name, c.role]), [["AP Micro", "student"]]);
});

test("courses: role is re-derived from live classes; other schools see nothing", async () => {
  const [course] = await myCourses("school-a", [{ id: "c1", name: "AP Micro", role: "teacher" }]);
  assert.equal((await courseFor("school-a", course.id, [{ id: "c1", name: "x", role: "aide" }]))?.role, "teacher");
  assert.equal(await courseFor("school-a", course.id, []), null, "taken off the class in ID = no access");
  assert.equal(await courseFor("school-b", course.id, [{ id: "c1", name: "x", role: "teacher" }]), null);
  assert.equal(await courseFor("school-a", "not-a-uuid", []), null);
  assert.equal(roleInClass({ role: "admin" }), "teacher");
});

// ---------- lessons ----------

async function course(tenant = "school-a", cls = "c1") {
  const [c] = await myCourses(tenant, [{ id: cls, name: "Course " + cls, role: "teacher" }]);
  return c;
}

test("lessons: create, save, and the version number moves", async () => {
  const c = await course();
  const l = await createLesson(A, c.id, "  Price   elasticity ");
  assert.equal(l.title, "Price elasticity");
  assert.equal(l.version, 1);
  const r = await saveLesson(A, l.id, { baseVersion: 1, blocks: [newBlock("text")] });
  assert.ok(r.ok && r.changed && r.lesson.version === 2 && r.lesson.blocks.length === 1);
});

test("lessons: a save based on an old version is refused, not written over", async () => {
  const c = await course();
  const l = await createLesson(A, c.id, "Two tabs");
  const tab1 = await saveLesson(A, l.id, { baseVersion: 1, title: "From tab 1" });
  assert.ok(tab1.ok);
  const tab2 = await saveLesson(A, l.id, { baseVersion: 1, title: "From tab 2" });
  assert.ok(!tab2.ok && tab2.reason === "conflict");
  assert.equal((await getLesson(A, l.id))?.title, "From tab 1");
});

test("lessons: an unchanged save writes nothing and keeps the version", async () => {
  const c = await course();
  const l = await createLesson(A, c.id, "Same");
  const r = await saveLesson(A, l.id, { baseVersion: 1, title: "Same" });
  assert.ok(r.ok && !r.changed && r.lesson.version === 1);
  assert.equal((await listVersions(A, l.id)).length, 0);
});

test("lessons: every change keeps the previous version, and restore is undoable", async () => {
  const c = await course();
  const l = await createLesson(A, c.id, "History", [{ type: "text", title: "Original" } as never]);
  const s1 = await saveLesson(A, l.id, { baseVersion: 1, blocks: [] });
  assert.ok(s1.ok);
  const versions = await listVersions(A, l.id);
  assert.deepEqual(versions.map((v) => [v.version, v.blockCount]), [[1, 1]]);

  const back = await restoreVersion(A, l.id, 1, 2);
  assert.ok(back.ok && back.lesson.version === 3 && back.lesson.blocks.length === 1);
  assert.deepEqual((await listVersions(A, l.id)).map((v) => v.version), [2, 1], "the emptied version is kept too");
});

test("lessons: only the newest versions are kept", async () => {
  const c = await course();
  const l = await createLesson(A, c.id, "Busy");
  let v = 1;
  for (let i = 0; i < KEEP_VERSIONS + 5; i++) {
    const r = await saveLesson(A, l.id, { baseVersion: v, title: "Busy " + i });
    assert.ok(r.ok);
    v = r.lesson.version;
  }
  const kept = await listVersions(A, l.id);
  assert.ok(kept.length <= KEEP_VERSIONS, `kept ${kept.length}`);
  assert.equal(kept[0].version, v - 1);
});

test("lessons: another school can neither read nor save nor list them", async () => {
  const c = await course();
  const l = await createLesson(A, c.id, "Private");
  assert.equal(await getLesson(B, l.id), null);
  const r = await saveLesson(B, l.id, { baseVersion: 1, title: "Hijacked" });
  assert.ok(!r.ok && r.reason === "missing");
  assert.equal((await listLessons(B, c.id)).length, 0);
  assert.equal((await listVersions(B, l.id)).length, 0);
  assert.equal((await getLesson(A, l.id))?.title, "Private");
});
