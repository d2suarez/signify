import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses } from "../src/lib/courses";
import { createLesson, saveLesson } from "../src/lib/lessons";
import { createAssignment, saveAssignment, archiveAssignment } from "../src/lib/assignments";
import { normalizeBlocks, remapAssignments, assignmentIdsIn, newBlock } from "../src/lib/blocks";
import { studentBlocks } from "../src/lib/lesson-assignments";
import { lessonDoc } from "../src/lib/organize";
import { normalizeResourceBlock } from "../src/lib/resources";

// Assignments and quizzes on slides, published from the presenter (story 01, D3/D10).

let db: Db;
const T = { tenantId: "school-a", userId: "t1" };
const B = { tenantId: "school-b", userId: "t9" };
let course = "", other = "", foreign = "";
const ID = "0b4c2a9e-1f00-4c3b-9a55-0d6e5b1f2a3c";

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
  [course, other] = (await myCourses("school-a", [{ id: "s-1", name: "Bible 9", role: "teacher" }, { id: "s-2", name: "Art", role: "teacher" }], "t1")).map((c) => c.id);
  foreign = (await myCourses("school-b", [{ id: "s-9", name: "Elsewhere", role: "teacher" }], "t9"))[0].id;
});
after(() => db.close());

test("assignment block: normalized like every block (id shape only, unpicked kept while writing)", () => {
  const out = normalizeBlocks([
    { type: "assignment", title: "  Quiz\n 1 ", assignmentId: ID.toUpperCase() },
    { type: "assignment", title: "x", assignmentId: "../../etc" },
    { type: "assignment", assignmentId: 42 },
  ]);
  assert.deepEqual(out.map((b) => [b.type, (b as { title: string }).title, (b as { assignmentId: string }).assignmentId]), [
    ["assignment", "Quiz 1", ID], ["assignment", "x", ""], ["assignment", "", ""],
  ]);
  assert.deepEqual(assignmentIdsIn(out), [ID]);
  assert.equal(newBlock("assignment").type, "assignment");
  const map = new Map([[ID, "11111111-2222-4333-8444-555555555555"]]);
  assert.deepEqual(remapAssignments(out, map).map((b) => (b as { assignmentId: string }).assignmentId), ["11111111-2222-4333-8444-555555555555", "", ""]);
  assert.deepEqual(remapAssignments(out, new Map()).length, 2, "a picked one with no copy is dropped");
  assert.equal(normalizeResourceBlock({ type: "assignment", assignmentId: ID }), null, "never a class resource's block");
});

test("assignment block: a lesson keeps only its own course's assignments, with their titles", async () => {
  const mine = await createAssignment(T, course, { title: "Worksheet" });
  const theirs = await createAssignment(T, other, { title: "Art project" });
  const far = await createAssignment(B, foreign, { title: "Elsewhere" });
  const gone = await createAssignment(T, course, { title: "Old" });
  await archiveAssignment(T, gone.id);
  const lesson = await createLesson(T, course, "Day 1", [
    { type: "assignment", title: "typed", assignmentId: mine.id },
    { type: "assignment", title: "", assignmentId: theirs.id },
    { type: "assignment", title: "", assignmentId: far.id },
    { type: "assignment", title: "", assignmentId: gone.id },
    { type: "assignment", title: "", assignmentId: "" },
  ] as never);
  assert.deepEqual(lesson.blocks.map((b) => [(b as { assignmentId: string }).assignmentId, (b as { title: string }).title]), [[mine.id, "Worksheet"], ["", ""]]);
  const saved = await saveLesson(T, lesson.id, { baseVersion: lesson.version, blocks: [...lesson.blocks, { type: "assignment", assignmentId: theirs.id }] });
  assert.ok(saved.ok && saved.lesson.blocks.length === 2, "saving drops another course's assignment too");
});

test("assignment block: students see a draft's slide empty, and the assignment once published", async () => {
  const quiz = await createAssignment(T, course, { title: "Secret quiz", kind: "quiz" });
  const lesson = await createLesson(T, course, "Quiz day", [
    { type: "poll", question: "Ready?", choices: [{ text: "Yes", correct: true }, { text: "No" }] },
    { type: "assignment", assignmentId: quiz.id },
  ] as never);
  let seen = await studentBlocks(T.tenantId, course, lesson.blocks);
  assert.equal(seen.length, 2, "slide numbers stay the teacher's");
  assert.deepEqual(seen[1], { ...lesson.blocks[1], title: "", assignmentId: "" }, "a draft's title and id never reach students");
  assert.ok(!JSON.stringify(seen).includes("Secret quiz"));
  assert.ok((seen[0] as { choices: { correct: boolean }[] }).choices.every((c) => !c.correct), "no poll answer keys");

  await saveAssignment(T, quiz.id, { baseVersion: quiz.version, published: true, title: "Chapter quiz" });
  seen = await studentBlocks(T.tenantId, course, lesson.blocks);
  assert.deepEqual(seen[1], { ...lesson.blocks[1], title: "Chapter quiz" }, "published: the assignment as it is now");
  assert.equal((await studentBlocks(B.tenantId, course, lesson.blocks))[1].type, "assignment");
  assert.equal(((await studentBlocks(B.tenantId, course, lesson.blocks))[1] as { assignmentId: string }).assignmentId, "", "another school learns nothing");
});

test("assignment block: in Updates the lesson links the assignment, its title filled per reader", () => {
  const doc = lessonDoc({ id: ID, title: "Day 2", blocks: normalizeBlocks([{ type: "assignment", title: "Draft title", assignmentId: "11111111-2222-4333-8444-555555555555" }]) });
  assert.deepEqual(doc.nodes, [
    { type: "material", kind: "assignment", id: "11111111-2222-4333-8444-555555555555", title: "" },
    { type: "material", kind: "lesson", id: ID, title: "Day 2" },
  ]);
});
