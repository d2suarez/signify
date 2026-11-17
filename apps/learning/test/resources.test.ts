import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { createLesson } from "../src/lib/lessons";
import { normalizeBlocks } from "../src/lib/blocks";
import { myCourses } from "../src/lib/courses";
import {
  normalizeResourceBlock, resourceBlocks, studentCanSee, createResource, updateResource, listResources, getResource,
  archiveResource, moveResource, blocksFromResources, resourceChoices, ResourceError, type Who,
} from "../src/lib/resources";

let db: Db;
let course: string;
let other: string;
let courseB: string;
const T: Who = { tenantId: "school-a", userId: "teacher-1", role: "teacher" };
const S: Who = { tenantId: "school-a", userId: "student-1", role: "student" };
const B: Who = { tenantId: "school-b", userId: "teacher-9", role: "teacher" };

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
  const cs = await myCourses("school-a", [{ id: "r1", name: "Biology", role: "teacher" }, { id: "r2", name: "Chemistry", role: "teacher" }]);
  course = cs.find((c) => c.name === "Biology")!.id;
  other = cs.find((c) => c.name === "Chemistry")!.id;
  courseB = (await myCourses("school-b", [{ id: "r1", name: "Biology B", role: "teacher" }]))[0].id;
});
after(() => db.close());

// ---------- normalisation and conversion (pure) ----------

test("resources: a resource block goes through normalizeBlocks (unknown dropped, Boards origins only, one block)", () => {
  assert.equal(normalizeResourceBlock({ type: "hologram" }), null);
  assert.equal(normalizeResourceBlock(null), null);
  const board = normalizeResourceBlock({ type: "board", title: "B", url: "https://evil.example/embed/x" });
  assert.equal(board?.type === "board" && board.url, "");
  const two = normalizeResourceBlock([{ type: "text", title: "first" }, { type: "text", title: "second" }]);
  assert.equal(two?.type === "text" && two.title, "first");
  const t = normalizeResourceBlock({ type: "timer", seconds: 99999, id: "<x>" });
  assert.ok(t?.type === "timer" && t.seconds === 3600 && /^[A-Za-z0-9_-]+$/.test(t.id));
});

test("resources: becoming blocks gives a copy with fresh ids, same content", () => {
  const block = normalizeResourceBlock({ id: "keep", type: "poll", question: "Q?", choices: [{ text: "a", correct: true }, { text: "b" }] })!;
  const one = resourceBlocks({ kind: "block", block });
  const two = resourceBlocks({ kind: "block", block });
  assert.equal(one.length, 1);
  assert.notEqual(one[0].id, "keep");
  assert.notEqual(one[0].id, two[0].id);
  assert.deepEqual({ ...one[0], id: "" }, { ...block, id: "" });
  const lesson = resourceBlocks({ kind: "lesson", block: null }, [block, { ...block, id: "k2" }]);
  assert.equal(lesson.length, 2);
  assert.equal(new Set(lesson.map((b) => b.id)).size, 2);
});

test("resources: only text, link and board can ever be shown to students", () => {
  for (const type of ["text", "link", "board"]) assert.ok(studentCanSee({ kind: "block", block: normalizeResourceBlock({ type })! }));
  for (const type of ["poll", "timer", "picker", "noise", "tool"]) assert.ok(!studentCanSee({ kind: "block", block: normalizeResourceBlock({ type })! }));
  assert.ok(!studentCanSee({ kind: "lesson", block: null }));
});

// ---------- the library ----------

test("resources: teachers add, order, archive and bring back", async () => {
  const a = await createResource(T, course, { block: { type: "link", title: "Cells video", url: "https://example.org/cells" } });
  const b = await createResource(T, course, { block: { type: "timer", label: "Lab clean-up", seconds: 300 } });
  const c = await createResource(T, course, { block: { type: "text", title: "Exit ticket", body: "One thing you learned" } });
  assert.equal(a.title, "Cells video");
  assert.equal(b.title, "Lab clean-up", "the block's own words name it");
  let list = await listResources(T, course);
  assert.deepEqual(list.map((r) => r.id), [a.id, b.id, c.id]);
  assert.ok(await moveResource(T, course, c.id, -1));
  assert.ok(!(await moveResource(T, course, a.id, -1)), "the first can't go higher");
  list = await listResources(T, course);
  assert.deepEqual(list.map((r) => r.id), [a.id, c.id, b.id]);
  assert.ok(await archiveResource(T, course, b.id));
  assert.deepEqual((await listResources(T, course)).map((r) => r.id), [a.id, c.id]);
  assert.deepEqual((await listResources(T, course, { archived: true })).map((r) => r.id), [b.id]);
  assert.ok(await archiveResource(T, course, b.id, false));
  assert.equal((await listResources(T, course)).length, 3);
  for (const r of [a, b, c]) await archiveResource(T, course, r.id);
});

test("resources: students see only visible text/link/board, never hidden ones, never a poll", async () => {
  const shown = await createResource(T, course, { block: { type: "link", title: "Shown", url: "https://example.org" }, visible: true });
  const hidden = await createResource(T, course, { block: { type: "text", title: "Hidden", body: "teacher notes" } });
  const poll = await createResource(T, course, { block: { type: "poll", question: "Key?", choices: [{ text: "yes", correct: true }, { text: "no" }] }, visible: true });
  assert.equal(poll.visible, false, "a poll can't be made visible");
  const seen = await listResources(S, course);
  assert.deepEqual(seen.map((r) => r.title), ["Shown"]);
  assert.equal(await getResource(S, course, hidden.id), null);
  assert.equal(await getResource(S, course, poll.id), null);
  assert.ok(await getResource(S, course, shown.id));
  // Turning a visible link into a poll hides it.
  const changed = await updateResource(T, course, shown.id, { block: { type: "poll", question: "?" } });
  assert.equal(changed?.visible, false);
  assert.equal((await listResources(S, course)).length, 0);
  // Archived resources are gone for students even if marked visible.
  const again = await createResource(T, course, { block: { type: "text", title: "Notes", body: "x" }, visible: true });
  await archiveResource(T, course, again.id);
  assert.equal(await getResource(S, course, again.id), null);
  for (const r of [shown, hidden, poll]) await archiveResource(T, course, r.id);
});

test("resources: a student can't add, change, move, archive or copy resources", async () => {
  const r = await createResource(T, course, { block: { type: "text", title: "Mine", body: "x" } });
  await assert.rejects(createResource(S, course, { block: { type: "text", title: "x" } }), ResourceError);
  await assert.rejects(updateResource(S, course, r.id, { title: "hacked" }), ResourceError);
  await assert.rejects(archiveResource(S, course, r.id), ResourceError);
  await assert.rejects(moveResource(S, course, r.id, 1), ResourceError);
  await assert.rejects(blocksFromResources(S, course, [r.id]), ResourceError);
  assert.deepEqual(await resourceChoices(S, course), []);
  assert.equal((await getResource(T, course, r.id))?.title, "Mine");
  await archiveResource(T, course, r.id);
});

test("resources: another school sees and changes nothing", async () => {
  const r = await createResource(T, course, { block: { type: "link", title: "A's", url: "https://example.org" }, visible: true });
  const BinA: Who = { ...B };
  assert.deepEqual(await listResources(BinA, course), []);
  assert.equal(await getResource(BinA, course, r.id), null);
  assert.equal(await updateResource(BinA, course, r.id, { title: "taken" }), null);
  assert.equal(await archiveResource(BinA, course, r.id), false);
  assert.deepEqual(await blocksFromResources(BinA, courseB, [r.id]), []);
  assert.deepEqual(await blocksFromResources(BinA, course, [r.id]), []);
  assert.equal((await getResource(T, course, r.id))?.title, "A's");
  await archiveResource(T, course, r.id);
});

test("resources: a lesson resource is this course's lesson only, and adds its blocks as copies", async () => {
  const lesson = await createLesson(T, course, "Photosynthesis", normalizeBlocks([{ type: "text", title: "Light", body: "" }, { type: "timer", seconds: 60 }]));
  const elsewhere = await createLesson(T, other, "Acids", []);
  await assert.rejects(createResource(T, course, { lessonId: elsewhere.id }), ResourceError);
  await assert.rejects(createResource(B, courseB, { lessonId: lesson.id }), ResourceError, "another school's lesson");
  const r = await createResource(T, course, { lessonId: lesson.id, visible: true });
  assert.equal(r.title, "Photosynthesis");
  assert.equal(r.visible, false, "lessons are never shown to students as resources");
  assert.equal(r.lesson?.blockCount, 2);
  const blocks = await blocksFromResources(T, course, [r.id]);
  assert.deepEqual(blocks.map((b) => b.type), ["text", "timer"]);
  assert.ok(blocks.every((b) => !lesson.blocks.some((x) => x.id === b.id)));
  const choices = await resourceChoices(T, course);
  assert.equal(choices.find((c) => c.id === r.id)?.kind, "lesson");
  await archiveResource(T, course, r.id);
});

test("resources: blocks for presenting come in the order given, skipping archived and other courses' ids", async () => {
  const x = await createResource(T, course, { block: { type: "text", title: "X" } });
  const y = await createResource(T, course, { block: { type: "text", title: "Y" } });
  const z = await createResource(T, course, { block: { type: "text", title: "Z" } });
  const foreign = await createResource(T, other, { block: { type: "text", title: "Chem" } });
  await archiveResource(T, course, z.id);
  const blocks = await blocksFromResources(T, course, [y.id, foreign.id, z.id, x.id, "not-a-uuid", 5]);
  assert.deepEqual(blocks.map((b) => b.type === "text" && b.title), ["Y", "X"]);
  for (const r of [x, y]) await archiveResource(T, course, r.id);
  await archiveResource(T, other, foreign.id);
});

test("resources: an outside-tool block keeps its placement only when it's in this course", async () => {
  const r = await createResource(T, course, { block: { type: "tool", title: "Quizlet", linkId: "11111111-2222-4333-8444-555555555555", display: "tab" } });
  assert.equal(r.block?.type === "tool" && r.block.linkId, "");
  await archiveResource(T, course, r.id);
});

test("resources: a link resource keeps only what normalizeBlocks keeps; webLink decides what opens", async () => {
  const r = await createResource(T, course, { block: { type: "link", title: "Bad", url: "javascript:alert(1)" }, visible: true });
  assert.equal(r.block?.type, "link");
  // Stored as typed (the editor's rule), but the student page and Stage only ever open http(s) via webLink.
  const { webLink } = await import("../src/lib/blocks");
  assert.equal(webLink(r.block?.type === "link" ? r.block.url : ""), "");
  await archiveResource(T, course, r.id);
});
