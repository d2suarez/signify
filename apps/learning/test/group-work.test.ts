import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses } from "../src/lib/courses";
import { createAssignment, saveAssignment, listSubmissions, type Assignment } from "../src/lib/assignments";
import { createGroupSet } from "../src/lib/group-sets";
import { setGrade, gradesFor } from "../src/lib/grades";
import {
  groupFor, groupState, saveGroupDraft, groupHandIn, claimSubmitter, setSubmitter, gradeTargets, workFor, listGroupWork,
} from "../src/lib/group-work";

// Group assignments (story 01, A10/F4): a shared text per group, two hand-in modes, one grade per group.

let db: Db;
const T = { tenantId: "school-a", userId: "t1" };
const as = (id: string) => ({ tenantId: "school-a", userId: id });
let course = "", other = "";
const roster = new Map([["s1", "Ana"], ["s2", "Ben"], ["s3", "Cy"], ["s4", "Dee"], ["s5", "Eli"]]);
let setId = "", otherSet = "";

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
  [course, other] = (await myCourses("school-a", [{ id: "c-1", name: "Bible 9", role: "teacher" }, { id: "c-2", name: "Art", role: "teacher" }], "t1")).map((c) => c.id);
  setId = (await createGroupSet(T, course, { name: "Pairs", groups: [{ id: "gA", name: "A", members: ["s1", "s2"] }, { id: "gB", name: "B", members: ["s3", "s4"] }] }, roster)).id;
  otherSet = (await createGroupSet(T, other, { name: "Art teams", groups: [] }, roster)).id;
});
after(() => db.close());

async function groupAssignment(input: Record<string, unknown>): Promise<Assignment> {
  const a = await createAssignment(T, course, { title: "Worksheet" });
  const r = await saveAssignment(T, a.id, { baseVersion: a.version, published: true, groupSetId: setId, ...input });
  assert.ok(r.ok);
  return r.ok ? r.assignment : a;
}

test("group settings: only the class's own set, never on a quiz, kept in versions", async () => {
  const a = await createAssignment(T, course, { title: "x" });
  let r = await saveAssignment(T, a.id, { baseVersion: 1, groupSetId: otherSet });
  assert.ok(r.ok && r.assignment.groupSetId === null, "another class's set is refused");
  r = await saveAssignment(T, a.id, { baseVersion: 1, groupSetId: setId, groupHandIn: "one", groupSubmitter: "teacher" });
  assert.ok(r.ok && r.assignment.groupSetId === setId && r.assignment.groupHandIn === "one" && r.assignment.groupSubmitter === "teacher");
  r = await saveAssignment(T, a.id, { baseVersion: 2, groupHandIn: "weird" });
  assert.ok(r.ok && r.assignment.groupHandIn === "each");
  const q = await createAssignment(T, course, { title: "Quiz", kind: "quiz" });
  const rq = await saveAssignment(T, q.id, { baseVersion: 1, groupSetId: setId });
  assert.ok(rq.ok && rq.assignment.groupSetId === null, "a quiz is never group work");
});

test("each member hands in: one shared text, version-checked; a member who handed in can't change it", async () => {
  const a = await groupAssignment({ groupHandIn: "each" });
  assert.equal((await groupFor(T, a, "s5")), null, "s5 is in no group: works alone");
  let r = await saveGroupDraft(as("s1"), a, { baseVersion: 0, body: "Our answer", pastes: [{ ago: 10, chars: 4, text: "copy" }] });
  assert.ok(r.ok && r.work.version === 1);
  const stale = await saveGroupDraft(as("s2"), a, { baseVersion: 0, body: "Mine instead" });
  assert.equal(!stale.ok && stale.reason, "conflict", "never written over");
  r = await saveGroupDraft(as("s2"), a, { baseVersion: 1, body: "Our answer, improved" });
  assert.ok(r.ok && r.work.version === 2);
  assert.equal((await groupState(as("s1"), a, "s1"))?.work.body, "Our answer, improved");
  const outsider = await saveGroupDraft(as("s3"), a, { baseVersion: 2, body: "hijack" });
  assert.equal(!outsider.ok && outsider.reason, "conflict", "group B has its own text (version 0)");
  assert.equal((await groupState(as("s3"), a, "s3"))?.work.body, "");

  assert.ok((await groupHandIn(as("s1"), a, true)).ok);
  const subs = await listSubmissions(T, a.id);
  assert.equal(subs.find((s) => s.studentId === "s1")?.body, "Our answer, improved", "the hand-in keeps the text as it was");
  assert.ok(subs.find((s) => s.studentId === "s1")?.submittedAt);
  assert.ok(!subs.find((s) => s.studentId === "s2")?.submittedAt, "only s1 handed in");
  const locked = await saveGroupDraft(as("s1"), a, { baseVersion: 2, body: "later" });
  assert.equal(!locked.ok && locked.reason, "handed-in");
  assert.ok((await saveGroupDraft(as("s2"), a, { baseVersion: 2, body: "s2 still writes" })).ok);
  const events = await db.query("SELECT count(*)::int AS n FROM writing_events w JOIN submissions s ON s.id = w.submission_id WHERE s.student_id = 's1' AND w.kind = 'paste'");
  assert.equal(events[0].n, 1, "s1's paste is on s1's own record");
});

test("one hands in for the group: claimed or set by the teacher, everyone handed in together, take back until graded", async () => {
  const a = await groupAssignment({ groupHandIn: "one", groupSubmitter: "group" });
  await saveGroupDraft(as("s1"), a, { baseVersion: 0, body: "Team text" });
  assert.equal((await groupHandIn(as("s1"), a, true) as { reason?: string }).reason, "no-submitter");
  assert.ok((await claimSubmitter(as("s2"), a)).ok);
  assert.equal((await groupHandIn(as("s1"), a, true) as { reason?: string }).reason, "not-submitter");
  assert.ok((await claimSubmitter(as("s1"), a)).ok, "another member can take it on before hand-in");
  assert.ok((await groupHandIn(as("s1"), a, true)).ok);
  const subs = await listSubmissions(T, a.id);
  assert.deepEqual(subs.filter((s) => s.submittedAt).map((s) => s.studentId).sort(), ["s1", "s2"], "both members handed in");
  assert.equal(subs.find((s) => s.studentId === "s2")?.body, "Team text");
  assert.equal((await saveGroupDraft(as("s2"), a, { baseVersion: 1, body: "x" }) as { reason?: string }).reason, "handed-in", "locked for all");
  assert.equal((await claimSubmitter(as("s2"), a) as { reason?: string }).reason, "handed-in");

  await setGrade(T, a, "s2", new Set(roster.keys()), { score: 9 });
  assert.equal((await groupHandIn(as("s1"), a, false) as { reason?: string }).reason, "graded", "a member's grade stops the take-back");

  const b = await groupAssignment({ groupHandIn: "one", groupSubmitter: "teacher" });
  assert.equal(!(await claimSubmitter(as("s3"), b)).ok, true, "the group can't choose when the teacher does");
  assert.equal((await setSubmitter(T, b, "gB", "s1") as { reason?: string }).reason, "missing", "only a member of that group");
  assert.ok((await setSubmitter(T, b, "gB", "s4")).ok);
  assert.equal((await listGroupWork(T, b.id)).get("gB")?.submitter, "s4");
  await saveGroupDraft(as("s3"), b, { baseVersion: 0, body: "B's text" });
  assert.ok((await groupHandIn(as("s4"), b, true)).ok);
  assert.ok((await groupHandIn(as("s4"), b, false)).ok, "taken back before any grade");
  assert.equal((await listSubmissions(T, b.id)).filter((s) => s.submittedAt).length, 0);
});

test("group grade targets and the desk's work", async () => {
  const a = await groupAssignment({});
  const all = new Set(roster.keys());
  assert.deepEqual((await gradeTargets(T, a, "s3", all)).sort(), ["s3", "s4"]);
  assert.deepEqual(await gradeTargets(T, a, "s5", all), ["s5"], "no group: just them");
  assert.deepEqual(await gradeTargets(T, a, "s3", new Set(["s3"])), ["s3"], "only members still in the class");
  for (const id of await gradeTargets(T, a, "s1", all)) await setGrade(T, a, id, all, { score: 7, comment: "Good team work" });
  await setGrade(T, a, "s2", all, { score: 8, comment: "Good team work, and your diagram" });
  const g = await gradesFor(T, a.id);
  assert.deepEqual(g.map((x) => [x.studentId, x.score]).sort(), [["s1", 7], ["s2", 8]], "any member can be changed");
  assert.equal(workFor(null, { groupId: "g", body: "draft", version: 2, submitter: null, submitterBy: null, submittedAt: null, updatedAt: "" }), "draft");
  assert.equal(workFor({ assignmentId: "", studentId: "", body: "handed", version: 1, submittedAt: "2026-01-01T00:00:00Z", updatedAt: "" }, null), "handed");
});
