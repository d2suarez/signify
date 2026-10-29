import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses } from "../src/lib/courses";
import { createAssignment, saveAssignment, saveDraft, setHandedIn } from "../src/lib/assignments";
import { cleanPastes, shouldSnapshot, summarize, writingEvents, WRITING, type WritingEvent } from "../src/lib/writing";

let db: Db;
const T = { tenantId: "school-a", userId: "teacher-1" };
const S1 = { tenantId: "school-a", userId: "stu-1" };

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
});
after(() => db.close());

async function published() {
  const [c] = await myCourses("school-a", [{ id: "w1", name: "English", role: "teacher" }]);
  const a = await createAssignment(T, c.id, { title: "Essay" });
  const r = await saveAssignment(T, a.id, { baseVersion: a.version, published: true });
  assert.ok(r.ok);
  return r.assignment;
}

test("writing: paste events from a browser are capped and cleaned", () => {
  const many = Array.from({ length: 40 }, () => ({ ago: 1000, chars: 10, text: "0123456789" }));
  assert.equal(cleanPastes(many).length, WRITING.maxPastesPerSave);
  const [p] = cleanPastes([{ ago: -50, chars: 3, text: "x".repeat(9000) }]);
  assert.equal(p.text.length, WRITING.maxPasteText);
  assert.equal(p.chars, WRITING.maxPasteText, "chars is never less than the text kept");
  assert.equal(p.ago, 0);
  assert.equal(cleanPastes([{ ago: 1e12, chars: 20000, text: "" }])[0].ago, WRITING.maxPasteAgo);
  assert.deepEqual(cleanPastes([{ chars: 0, text: "" }, null, "nope"]), []);
  assert.deepEqual(cleanPastes("not a list"), []);
});

test("writing: a snapshot at most every 15 s, never a duplicate, always at hand-in", () => {
  assert.equal(shouldSnapshot(null, "a", 0, 0), true);
  assert.equal(shouldSnapshot({ at: 0, body: "a" }, "ab", 5_000, 1), false);
  assert.equal(shouldSnapshot({ at: 0, body: "a" }, "ab", 15_000, 1), true);
  assert.equal(shouldSnapshot({ at: 0, body: "ab" }, "ab", 99_000, 1), false, "unchanged text");
  assert.equal(shouldSnapshot({ at: 0, body: "a" }, "ab", 99_000, WRITING.maxSnapshots), false, "capped");
  assert.equal(shouldSnapshot({ at: 0, body: "a" }, "ab", 1, WRITING.maxSnapshots, true), true, "hand-in");
});

test("writing: the summary is plain facts (sittings, time, pastes), no score", () => {
  const t0 = Date.parse("2026-10-28T18:00:00Z");
  const ev = (kind: WritingEvent["kind"], min: number, chars = 10): WritingEvent => ({ kind, at: new Date(t0 + min * 60_000).toISOString(), body: "", chars });
  const s = summarize([ev("snapshot", 0), ev("snapshot", 2), ev("paste", 3, 400), ev("snapshot", 4), ev("snapshot", 120), ev("snapshot", 121)]);
  assert.equal(s.sessions, 2);
  assert.equal(s.activeMinutes, 5);
  assert.equal(s.snapshots, 5);
  assert.equal(s.pastes, 1);
  assert.equal(s.pastedChars, 400);
  assert.deepEqual(Object.keys(s).sort(), ["activeMinutes", "firstAt", "largestPaste", "lastAt", "pastedChars", "pastes", "sessions", "snapshots"]);
  assert.equal(summarize([]).sessions, 0);
});

test("writing: saves record snapshots and pastes for the student's own work; hand-in snapshots; other schools see nothing", async () => {
  const a = await published();
  const s1 = await saveDraft(S1, a, { baseVersion: 0, body: "Opening line." });
  assert.ok(s1.ok);
  // Too soon for another snapshot, but the paste is kept.
  const s2 = await saveDraft(S1, a, { baseVersion: 1, body: "Opening line. A pasted quote.", pastes: [{ ago: 500, chars: 14, text: "A pasted quote" }] });
  assert.ok(s2.ok);
  let ev = await writingEvents(db, "school-a", a.id, "stu-1");
  assert.deepEqual(ev.map((e) => e.kind).sort(), ["paste", "snapshot"]);
  assert.equal(ev.find((e) => e.kind === "paste")?.body, "A pasted quote");

  const h = await setHandedIn(S1, a, true, 2);
  assert.ok(h.ok);
  ev = await writingEvents(db, "school-a", a.id, "stu-1");
  const snaps = ev.filter((e) => e.kind === "snapshot");
  assert.equal(snaps.length, 2);
  assert.equal(snaps[snaps.length - 1].body, "Opening line. A pasted quote.", "the replay ends on what was handed in");

  assert.deepEqual(await writingEvents(db, "school-b", a.id, "stu-1"), []);
  assert.deepEqual(await writingEvents(db, "school-a", a.id, "stu-2"), []);
});
