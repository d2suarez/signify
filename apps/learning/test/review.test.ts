import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses } from "../src/lib/courses";
import { createAssignment, saveAssignment, getAssignment } from "../src/lib/assignments";
import { setGrade, gradesFor } from "../src/lib/grades";
import { normalizeRubric } from "../src/lib/rubric";
import { csvCell, locate, reviewCsv, segments } from "../src/lib/review";
import { reviewedFor, setReviewed } from "../src/lib/grade-review";

// The grading review screen (story 01, grade assistant, no AI): migration 037 + src/lib/review.ts.

let db: Db;
const T = { tenantId: "school-a", userId: "teacher-1" };
const OTHER = { tenantId: "school-b", userId: "teacher-9" };
const ROSTER = new Set(["stu-1", "stu-2"]);

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
});
after(() => db.close());

const RUBRIC = normalizeRubric({
  kind: "parts",
  sections: [
    { id: "s1", title: "Preview", parts: [
      { id: "p1", label: "1a", question: "What do you already know about cities?", points: 1 },
      { id: "p2", label: "1b", question: "Predict one problem a growing city faces.", points: 1 },
    ] },
    { id: "s2", title: "Reading Notes", parts: [
      { id: "p3", label: "2a", question: "Identify three challenges facing Portland in 1973.", points: 1.5 },
      { id: "p4", label: "2b", question: "Explain the plan.", points: 1.5 },
    ] },
  ],
})!;

const BODY = [
  "Preview",
  "1a. Cities have lots of people and buses.",
  "1b) Traffic gets worse.",
  "",
  "READING   NOTES",
  "identify three challenges facing portland in 1973: farms, growth, sprawl",
  "2b Explain: they drew a growth boundary.",
].join("\n");

test("review: sections by title, parts by label or the start of their question, each up to the next", () => {
  const loc = locate(RUBRIC, BODY);
  const at = (s: { start: number; end: number }) => BODY.slice(s.start, s.end);
  assert.ok(at(loc.sections.s1).startsWith("Preview"));
  assert.ok(at(loc.sections.s1).endsWith("worse.\n\n"), "a section runs to the next section");
  assert.equal(at(loc.parts.p1), "1a. Cities have lots of people and buses.\n");
  assert.equal(at(loc.parts.p2), "1b) Traffic gets worse.\n\n");
  assert.ok(at(loc.sections.s2).startsWith("READING   NOTES"), "titles match whatever the case and spacing");
  assert.ok(at(loc.parts.p3).startsWith("identify three challenges"), "no label: found by the question's opening words");
  assert.equal(at(loc.parts.p4), "2b Explain: they drew a growth boundary.");
  // Boxes cover the text exactly once, in order.
  const segs = segments(BODY, loc);
  assert.equal(segs.map((s) => s.text).join(""), BODY);
  assert.deepEqual(segs.filter((s) => s.partId).map((s) => s.partId), ["p1", "p2", "p3", "p4"]);
});

test("review: nothing found leaves the writing whole; a label inside a word or mid-line isn't a part", () => {
  assert.deepEqual(locate(RUBRIC, "I wrote about something else entirely."), { sections: {}, parts: {} });
  assert.deepEqual(locate(RUBRIC, null), { sections: {}, parts: {} });
  assert.deepEqual(locate(normalizeRubric({ criteria: [{ levels: [{ points: 1 }] }] }), BODY), { sections: {}, parts: {} });
  const loc = locate(RUBRIC, "Answer: room 1a is mine. 21a is not.\n1b yes");
  assert.equal(loc.parts.p1, undefined);
  assert.ok(loc.parts.p2);
  // A section not found by title starts at its first part.
  assert.deepEqual(loc.sections.s1, loc.parts.p2);
  const segs = segments("x", { sections: {}, parts: {} });
  assert.deepEqual(segs, [{ text: "x", partId: null }]);
});

test("review: CSV cells are quoted, and text a spreadsheet would run as a formula is defused", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell('say "hi", ok'), '"say ""hi"", ok"');
  assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(csvCell("-1+2"), "'-1+2");
  assert.equal(csvCell("@x"), "'@x");
  assert.equal(csvCell(-1.5), "-1.5");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell("two\nlines"), '"two\nlines"');
});

const WORDS = { student: "Student", group: "Group", handedIn: "Handed in", late: "Late", total: "Total", percent: "Percent", countsAs: "Counts as",
  flag: "Mark", reviewed: "Reviewed", concerns: "Integrity concerns", feedback: "Feedback", yes: "yes", section: "Section" };

test("review: the full table has sections, parts, total, percent, counts as, reviewed, concerns and feedback", () => {
  const csv = reviewCsv(RUBRIC, 5, [
    { name: "Ana López", group: null, handedIn: "2026-11-20 09:00", late: true, score: 3.25, countsAs: 2.75, flag: null,
      parts: { p1: { score: 1, message: "" }, p2: { score: 0.75, message: "Say why." }, p3: { score: 1.5, message: "" } },
      comment: "1b: Say why.", reviewed: true, concerns: ["High: same wording as another student"] },
    { name: "=Ben", group: "Group 1", handedIn: null, late: false, score: null, countsAs: null, flag: "Missing", parts: null, comment: "", reviewed: false, concerns: [] },
  ], WORDS);
  assert.ok(csv.startsWith("﻿"), "a byte-order mark so Excel reads accents");
  const lines = csv.slice(1).trim().split("\r\n");
  assert.equal(lines[0], "Student,Group,Handed in,Late,Preview (2),Reading Notes (3),1a (1),1b (1),2a (1.5),2b (1.5),Total (5),Percent,Counts as,Mark,Reviewed,Integrity concerns,Feedback");
  assert.equal(lines[1], "Ana López,,2026-11-20 09:00,yes,1.75,1.5,1,0.75,1.5,,3.25,65,2.75,,yes,High: same wording as another student,1b: Say why.");
  assert.equal(lines[2], "'=Ben,Group 1,,,,,,,,,,,,Missing,,,");
});

test("review: reviewed marks are per student, roster-only, teacher-only data, and stay in their school", async () => {
  const [c] = await myCourses("school-a", [{ id: "rv1", name: "Geography", role: "teacher" }]);
  const a0 = await createAssignment(T, c.id, { title: "Workbook 5" });
  const s = await saveAssignment(T, a0.id, { baseVersion: a0.version, rubric: { ...RUBRIC } });
  assert.ok(s.ok);
  const a = (await getAssignment(T, a0.id))!;
  await setGrade(T, a, "stu-1", ROSTER, { score: 2, parts: { p1: { score: 1, message: "" }, p2: { score: 1, message: "" } } });

  const out = await setReviewed(T, a.id, ["stu-1", "stranger"], true, ROSTER);
  assert.deepEqual(Object.keys(out), ["stu-1"], "only students on the class list");
  assert.ok(out["stu-1"]);
  assert.deepEqual([...(await reviewedFor(T, a.id)).keys()], ["stu-1"]);
  assert.equal((await reviewedFor(OTHER, a.id)).size, 0, "another school sees none");
  await setReviewed(OTHER, a.id, ["stu-1"], false, ROSTER);
  assert.equal((await reviewedFor(T, a.id)).size, 1, "another school can't unmark ours");
  const theirs = await setReviewed(OTHER, a.id, ["stu-1"], true, ROSTER);
  assert.equal(theirs["stu-1"], null, "nor take over our row");

  // Never on the grade itself: students and parents read Grades.
  const [g] = await gradesFor(T, a.id);
  assert.ok(!("reviewedAt" in g) && !("reviewed" in g));

  await setReviewed(T, a.id, ["stu-1"], false, ROSTER);
  assert.equal((await reviewedFor(T, a.id)).size, 0);
});
