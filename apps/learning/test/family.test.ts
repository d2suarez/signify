import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses } from "../src/lib/courses";
import { createAssignment, saveAssignment, saveDraft, setHandedIn } from "../src/lib/assignments";
import { setGrade } from "../src/lib/grades";
import { postAnnouncement } from "../src/lib/announcements";
import { workStatus, studentCourses, studentWork, weekSummary, recentNews, type CourseWork, type WorkItem } from "../src/lib/family";
import { childrenFor } from "../src/lib/roster";
import { dict } from "../src/lib/i18n";

let db: Db;
const T = { tenantId: "school-a", userId: "teacher-1" };
const KID = { tenantId: "school-a", userId: "kid-1" };
const PARENT = { tenantId: "school-a", userId: "parent-1" };
const ROSTER = new Set(["kid-1", "kid-2"]);

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
});
after(() => db.close());

let n = 0;
async function course() {
  const cls = { id: `fam${++n}`, name: `Course ${n}`, role: "teacher" };
  const [c] = await myCourses("school-a", [cls]);
  return { course: c, cls: { ...cls, role: "student" } };
}

async function assignment(courseId: string, extra: Record<string, unknown> = {}) {
  const a = await createAssignment(T, courseId, { title: `Work ${++n}` });
  const r = await saveAssignment(T, a.id, { baseVersion: a.version, published: true, points: 10, ...extra });
  assert.ok(r.ok);
  return r.assignment;
}

// ---------- status ----------

test("family: status reads released grades first, then hand-in and the clock", () => {
  const now = new Date("2026-10-29T15:00:00Z");
  const online = { kind: "online" as const, dueAt: "2026-10-28T23:59:00Z" };
  assert.equal(workStatus(online, null, undefined, now), "overdue");
  assert.equal(workStatus({ ...online, dueAt: "2026-10-30T23:59:00Z" }, null, undefined, now), "notStarted");
  assert.equal(workStatus({ ...online, dueAt: null }, { submittedAt: null }, undefined, now), "working");
  assert.equal(workStatus(online, { submittedAt: "2026-10-28T20:00:00Z" }, undefined, now), "handedIn");
  assert.equal(workStatus(online, null, { score: 8, flag: null }, now), "graded");
  assert.equal(workStatus(online, null, { score: null, flag: "missing" }, now), "missing");
  assert.equal(workStatus(online, null, { score: 9, flag: "exempt" }, now), "exempt");
  assert.equal(workStatus({ kind: "offline", dueAt: "2026-10-28T23:59:00Z" }, null, undefined, now), "inClass",
    "paper work is never called past due before it's graded");
});

// ---------- what a parent sees ----------

test("family: only published work, and a score only once grades are released", async () => {
  const { course: c, cls } = await course();
  const draft = await createAssignment(T, c.id, { title: "Still a draft" });
  const held = await assignment(c.id, { dueOn: "2026-10-28", dueAt: "2026-10-28T23:59:00Z" });
  const shown = await assignment(c.id, { dueOn: "2026-10-27", dueAt: "2026-10-27T23:59:00Z", gradesReleased: true });
  await setGrade(T, held, "kid-1", ROSTER, { score: 3 });
  await setGrade(T, shown, "kid-1", ROSTER, { score: 9 });
  await setGrade(T, shown, "kid-2", ROSTER, { score: 2 });

  const [w] = await studentWork(PARENT, [cls], "kid-1");
  const ids = w.items.map((i) => i.id);
  assert.ok(!ids.includes(draft.id), "a draft never reaches a family");
  const h = w.items.find((i) => i.id === held.id)!;
  assert.equal(h.score, null, "an unreleased grade is not shown");
  assert.equal(h.gradedAt, null);
  assert.notEqual(h.status, "graded");
  const s = w.items.find((i) => i.id === shown.id)!;
  assert.equal(s.status, "graded");
  assert.equal(s.score, 9, "their own child's score, never a classmate's");
  assert.equal(w.whole, 90, "the course grade counts released grades only");
  assert.equal(w.letter, "A−");
});

test("family: hand-in shows as handed in, and late when it was", async () => {
  const { course: c, cls } = await course();
  const a = await assignment(c.id, { dueOn: "2020-01-06", dueAt: "2020-01-06T23:59:00Z" });
  const d = await saveDraft(KID, a, { baseVersion: 0, body: "My essay" });
  assert.ok(d.ok);
  await setHandedIn(KID, a, true, 1);
  const [w] = await studentWork(PARENT, [cls], "kid-1");
  assert.equal(w.items[0].status, "handedIn");
  assert.equal(w.items[0].late, true);
  const [other] = await studentWork(PARENT, [cls], "kid-2");
  assert.equal(other.items[0].status, "overdue", "each child's own submission, nobody else's");
});

test("family: a class whose teacher hasn't opened it yet is no course, and none is made", async () => {
  const before = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM courses");
  const got = await studentCourses("school-a", [{ id: "never-opened", name: "Art", role: "student" }]);
  assert.equal(got.length, 0);
  const after = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM courses");
  assert.equal(after[0].n, before[0].n);
  assert.equal((await studentCourses("school-b", [{ id: "fam1", name: "x", role: "student" }])).length, 0,
    "another school's course with the same class id is not this one");
});

// ---------- the week ----------

const item = (over: Partial<WorkItem>): WorkItem => ({
  id: Math.random().toString(36), title: "x", courseId: "c", courseName: "Course", kind: "online", points: 10,
  dueOn: null, dueAt: null, status: "notStarted", late: false, score: null, gradedAt: null, ...over,
});

test("week: Monday to Sunday at the school, with next week after it", () => {
  const now = new Date("2026-10-29T15:00:00Z");     // a Thursday
  const work: CourseWork[] = [{
    course: { id: "c", tenantId: "t", idClassId: "k", name: "Course", subject: "", role: "student", covering: false, lessonCount: 0 },
    whole: null, letter: null,
    items: [
      item({ title: "Mon", dueOn: "2026-10-26", dueAt: "2026-10-26T20:00:00Z", status: "overdue" }),
      item({ title: "Fri", dueOn: "2026-10-30", dueAt: "2026-10-30T20:00:00Z" }),
      item({ title: "Sun", dueOn: "2026-11-01", dueAt: "2026-11-01T20:00:00Z" }),
      item({ title: "Next", dueOn: "2026-11-04", dueAt: "2026-11-04T20:00:00Z" }),
      item({ title: "Later", dueOn: "2026-11-20" }),
      item({ title: "Old missing", dueOn: "2026-09-01", status: "missing", score: null, gradedAt: "2026-10-20T12:00:00Z" }),
      item({ title: "Graded", dueOn: "2026-10-20", status: "graded", score: 9, gradedAt: "2026-10-27T12:00:00Z" }),
      item({ title: "Exempt", dueOn: "2026-10-21", status: "exempt", gradedAt: "2026-10-28T12:00:00Z" }),
    ],
  }];
  const w = weekSummary(work, "2026-10-29", now, [
    { courseId: "c", courseName: "Course", title: "New", createdAt: "2026-10-28T12:00:00Z" },
    { courseId: "c", courseName: "Course", title: "Old", createdAt: "2026-10-01T12:00:00Z" },
  ]);
  assert.equal(w.from, "2026-10-26");
  assert.equal(w.to, "2026-11-01");
  assert.deepEqual(w.dueThisWeek.map((i) => i.title), ["Mon", "Fri", "Sun"]);
  assert.deepEqual(w.needsAttention.map((i) => i.title), ["Old missing", "Mon"]);
  assert.deepEqual(w.newGrades.map((i) => i.title), ["Graded"], "older grades and exemptions aren't news");
  assert.deepEqual(w.nextWeek.map((i) => i.title), ["Next"]);
  assert.deepEqual(w.news.map((x) => x.title), ["New"]);
  assert.equal(weekSummary(work, "2026-11-01", now).from, "2026-10-26", "Sunday still belongs to the week ending");
});

test("week: recent announcements come from the student's courses", async () => {
  const { course: c } = await course();
  await postAnnouncement(T, c.id, { title: "Field trip", body: "Bring a lunch." });
  const news = await recentNews(PARENT, [c]);
  assert.deepEqual(news.map((x) => x.title), ["Field trip"]);
});

// ---------- Signify ID ----------

test("family: children come from Signify ID only; without it, a failure, never 'no children'", async () => {
  assert.deepEqual((await childrenFor({ id: "p", role: "guardian", dev: true }, "")).children.map((c) => c.id), ["dev-student-0000"]);
  assert.equal((await childrenFor({ id: "t", role: "teacher", dev: true }, "")).children.length, 0);
  assert.deepEqual(await childrenFor({ id: "p", role: "guardian" }, ""), { ok: false, children: [] });
});

test("i18n: the family strings have Spanish", () => {
  const en = dict("en");
  const es = dict("es");
  for (const k of ["yourChildren", "childrenFailed", "noChildren", "parentNote", "noCoursesChild", "seeAllWork", "weekOf",
    "dueThisWeek", "needsAttention", "newGrades", "comingNextWeek", "nothingDueWeek", "allCaughtUp", "noNewGrades",
    "nothingNextWeek", "weekTeacher", "inClassWork", "weekNoEmail"] as const) {
    assert.notEqual(es[k], en[k], `${k} has no Spanish`);
  }
});
