import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import crypto from "node:crypto";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses } from "../src/lib/courses";
import {
  createAssignment, getAssignment, isClosed, saveAssignment, saveDraft, setClosesAt, setHandedIn, type Assignment,
} from "../src/lib/assignments";
import { createGroupSet } from "../src/lib/group-sets";
import { claimSubmitter, groupHandIn, saveGroupDraft } from "../src/lib/group-work";
import { gradesFor, setGrade } from "../src/lib/grades";
import { memoryStore, useFileStore } from "../src/lib/files";
import { addWorkFile, WorkFileError } from "../src/lib/work-files";
import { attemptsOf, closeExpired, saveAttempt, startAttempt } from "../src/lib/quiz-store";

// Stop accepting work (migration 044): enforced in the lib, so every route gets it.

let db: Db;
const T = { tenantId: "school-a", userId: "t1" };
const as = (id: string) => ({ tenantId: "school-a", userId: id });
const roster = new Map([["s1", "Ana"], ["s2", "Ben"], ["s3", "Cy"]]);
let course = "", setId = "";

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
  useFileStore(memoryStore());
  process.env.BACKUP_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  [course] = (await myCourses("school-a", [{ id: "lk-1", name: "AP Micro", role: "teacher" }], "t1")).map((c) => c.id);
  setId = (await createGroupSet(T, course, { name: "Pairs", groups: [{ id: "gA", name: "A", members: ["s1", "s2"] }] }, roster)).id;
});
after(() => { delete process.env.BACKUP_ENCRYPTION_KEY; useFileStore(undefined as never); db.close(); });

async function make(input: Record<string, unknown> = {}): Promise<Assignment> {
  const a = await createAssignment(T, course, { title: "Essay", kind: input.kind as string | undefined });
  const r = await saveAssignment(T, a.id, { baseVersion: a.version, published: true, ...input });
  assert.ok(r.ok);
  return r.ok ? r.assignment : a;
}
const fresh = async (a: Assignment) => (await getAssignment(T, a.id))!;
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF");

test("lock: now, later or never; a past moment means now; the editor's version is untouched", async () => {
  const a = await make();
  assert.equal(a.closesAt, null);
  assert.equal(isClosed(a), false);
  const later = new Date(Date.now() + 86_400_000).toISOString();
  const r = await setClosesAt(T, a.id, later);
  assert.ok(r.ok && r.closesAt === later);
  const b = await fresh(a);
  assert.equal(isClosed(b), false, "a future close isn't closed yet");
  assert.equal(isClosed(b, new Date(Date.now() + 2 * 86_400_000)), true);
  assert.equal(b.version, a.version, "locking never bumps the version an open editor holds");
  const past = await setClosesAt(T, a.id, "2020-01-01T00:00:00Z");
  assert.ok(past.ok && Math.abs(new Date(past.closesAt!).getTime() - Date.now()) < 5000);
  assert.equal((await setClosesAt(T, a.id, "nonsense")).ok, false);
  assert.equal((await setClosesAt({ tenantId: "school-b", userId: "x" }, a.id, "now")).ok, false, "never another school's");
  assert.ok((await setClosesAt(T, a.id, null)).ok);
  assert.equal((await fresh(a)).closesAt, null);
  // A save in the editor keeps the lock.
  await setClosesAt(T, a.id, later);
  const saved = await saveAssignment(T, a.id, { baseVersion: b.version, title: "Essay 2" });
  assert.ok(saved.ok && saved.assignment.closesAt === later);
});

test("lock: no saves, hand-ins or take-backs once closed; teachers still grade and mark; reopening lets work in again", async () => {
  const a = await make();
  const s1 = as("s1"), s2 = as("s2");
  const d1 = await saveDraft(s1, a, { baseVersion: 0, body: "Draft" });
  assert.ok(d1.ok);
  const h1 = await setHandedIn(s1, a, true, d1.submission.version);
  assert.ok(h1.ok);
  const d2 = await saveDraft(s2, a, { baseVersion: 0, body: "Mine" });
  assert.ok(d2.ok);

  await setClosesAt(T, a.id, "now");
  const c = await fresh(a);
  const why = (r: { ok: boolean; reason?: string }) => r.ok ? "ok" : r.reason;
  assert.equal(why(await saveDraft(s2, c, { baseVersion: d2.submission.version, body: "More" })), "closed");
  assert.equal(why(await saveDraft(as("s3"), c, { baseVersion: 0, body: "First" })), "closed", "nobody new starts");
  assert.equal(why(await setHandedIn(s2, c, true, d2.submission.version)), "closed");
  assert.equal(why(await setHandedIn(s1, c, false, h1.ok ? h1.submission.version : 0)), "closed", "no taking back either");

  assert.ok((await setGrade(T, c, "s1", new Set(roster.keys()), { score: 9 })).ok !== false);
  await setGrade(T, c, "s2", new Set(roster.keys()), { flag: "missing" });
  await setGrade(T, c, "s3", new Set(roster.keys()), { flag: "exempt" });
  const g = await gradesFor(T, a.id);
  assert.deepEqual(g.map((x) => [x.studentId, x.score, x.flag]).sort(), [["s1", 9, null], ["s2", null, "missing"], ["s3", null, "exempt"]]);

  await setClosesAt(T, a.id, null);
  assert.ok((await saveDraft(s2, await fresh(a), { baseVersion: d2.submission.version, body: "More" })).ok);
});

test("lock: file hand-ins and group work are refused too", async () => {
  const files = await make({ handIn: "files" });
  assert.ok(await addWorkFile(as("s1"), files, "page.pdf", PDF));
  await setClosesAt(T, files.id, "now");
  await assert.rejects(addWorkFile(as("s1"), await fresh(files), "page2.pdf", PDF), (e) => e instanceof WorkFileError && e.code === "closed");

  const g = await make({ groupSetId: setId, groupHandIn: "one" });
  assert.ok((await saveGroupDraft(as("s1"), g, { baseVersion: 0, body: "Ours" })).ok);
  await setClosesAt(T, g.id, "now");
  const gc = await fresh(g);
  const why = (r: { ok: boolean; reason?: string }) => r.ok ? "ok" : r.reason;
  assert.equal(why(await saveGroupDraft(as("s2"), gc, { baseVersion: 1, body: "x" })), "closed");
  assert.equal(why(await claimSubmitter(as("s1"), gc)), "closed");
  assert.equal(why(await groupHandIn(as("s1"), gc, true)), "closed");
});

test("lock: a quiz takes no new attempts; open ones are handed in with what was saved", async () => {
  const q = await make({
    kind: "quiz",
    quiz: { settings: {}, items: [{ identifier: "q1", kind: "truefalse", prompt: "Yes?", points: 1, correct: ["true"] }] },
  });
  const st = await startAttempt(as("s1"), q);
  assert.ok(st.ok);
  const sv = await saveAttempt(as("s1"), q, st.attempt.id, { baseVersion: st.attempt.version, responses: { q1: "true" } });
  assert.ok(sv.ok);
  const st2 = await startAttempt(as("s2"), q);
  assert.ok(st2.ok);

  // Closed a minute ago (past the save grace).
  await db.query("UPDATE assignments SET closes_at = now() - interval '1 minute' WHERE id = $1", [q.id]);
  const c = await fresh(q);
  const late = await saveAttempt(as("s1"), c, st.attempt.id, { baseVersion: sv.attempt.version, responses: { q1: "false" } });
  assert.ok(!late.ok && late.reason === "closed");
  assert.ok(!late.ok && late.reason === "closed" && late.attempt.submittedAt && late.attempt.autoSubmitted);
  const [kept] = await attemptsOf(T, q.id, "s1");
  assert.deepEqual(kept.responses, { q1: "true" }, "what was saved, not the late change");
  assert.equal(kept.score, 1);

  assert.deepEqual(await closeExpired(T, c), ["s2"], "every open attempt is handed in once it's closed");
  const r = await startAttempt(as("s3"), c);
  assert.ok(!r.ok && r.reason === "closed", "no new attempts");
  assert.equal((await attemptsOf(T, q.id, "s3")).length, 0);
});
