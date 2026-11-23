import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses } from "../src/lib/courses";
import { moveSection } from "../src/lib/sections";
import { archiveStandard, listStandards } from "../src/lib/standards";
import { addItemsToCourse, standardOptions, type Viewer } from "../src/lib/standards-library";
import { createLesson, saveLesson, setLessonStandards } from "../src/lib/lessons";
import { createAssignment, saveAssignment } from "../src/lib/assignments";
import {
  addCourseSet, classStandards, coverage, listCourseSets, mayChooseCourseSets, recordPresentation, removeCourseSet, setParts,
} from "../src/lib/course-standards";

let db: Db;
const T = "school-a";
const cls = (id: string, name: string) => ({ id, name, subject: "Math", role: "teacher", school_year: "2026" });
let secA = "", secB = "", catalog = "", fw = "", part = "";
const items: Record<string, string> = {};
const ana = (): Viewer => ({ tenantId: T, userId: "ana", admin: false, teaches: [secA] });
const stranger = (): Viewer => ({ tenantId: T, userId: "zed", admin: false, teaches: [] });
const admin = (): Viewer => ({ tenantId: T, userId: "boss", admin: true, teaches: [] });
const codes = async (sec: string, archived = false) =>
  (await listStandards({ tenantId: T, userId: "x" }, sec, { withArchived: true })).filter((s) => s.archived === archived).map((s) => s.code).sort();

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
  [{ id: secA, catalogId: catalog }] = (await myCourses(T, [cls("k-a", "Math 3 A")], "ana")).map((c) => ({ id: c.id, catalogId: c.catalogId! }));
  [{ id: secB }] = await myCourses(T, [cls("k-b", "Math 3 B")], "ben");
  assert.equal(await moveSection({ tenantId: T, userId: "ben" }, secB, catalog), catalog);
  // A school set: a heading with two grade-3 standards under it, and a grade-4 one.
  const [f] = await db.query("INSERT INTO standard_frameworks (tenant_id, owner_kind, identifier, title, version) VALUES ($1, 'school', 'fw-1', 'School Math', '2026') RETURNING id", [T]);
  fw = String(f.id);
  const item = async (identifier: string, code: string, statement: string, grades: string[], parent: string | null, pos: number) => {
    const [r] = await db.query(
      "INSERT INTO standard_items (tenant_id, framework_id, identifier, code, statement, grades, parent_id, depth, position) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id",
      [T, fw, identifier, code, statement, grades, parent, parent ? 1 : 0, pos],
    );
    return String(r.id);
  };
  part = await item("h", "", "Number Sense", ["03"], null, 0);
  items.A1 = await item("a1", "3.NS.1", "Count to 1000", ["03"], part, 1);
  items.A2 = await item("a2", "3.NS.2", "Compare numbers", ["03"], part, 2);
  items.B1 = await item("b1", "4.G.1", "Draw lines", ["04"], null, 3);
});
after(() => db.close());

test("course sets: who may choose them", async () => {
  assert.equal(await mayChooseCourseSets(ana(), catalog), true, "teaches a section now");
  assert.equal(await mayChooseCourseSets(stranger(), catalog), false);
  assert.equal(await mayChooseCourseSets(admin(), catalog), true);
  assert.equal(await addCourseSet(stranger(), catalog, { frameworkId: fw }), "forbidden");
  await db.query("INSERT INTO school_standards_settings (tenant_id, teacher_course_sets) VALUES ($1, false)", [T]);
  assert.equal(await mayChooseCourseSets(ana(), catalog), false, "the school said teachers may not");
  assert.equal(await mayChooseCourseSets(admin(), catalog), true);
  await db.query("UPDATE school_standards_settings SET teacher_course_sets = true WHERE tenant_id = $1", [T]);
});

let ownB1 = "";
test("course sets: every class gets the course's standards; a class's own standard keeps its id", async () => {
  // Before: the class added grade 4's standard itself.
  assert.deepEqual(await addItemsToCourse(ana(), secA, [items.B1]), { added: 1, refused: 0 });
  ownB1 = (await listStandards({ tenantId: T, userId: "ana" }, secA))[0].id;

  const parts = await setParts(ana(), fw);
  assert.deepEqual(parts?.parts.map((p) => p.title), ["Number Sense"]);
  assert.deepEqual(parts?.grades, ["03", "04"]);

  assert.equal(await addCourseSet(ana(), catalog, { frameworkId: fw, grades: ["3"] }), "ok");
  assert.equal(await addCourseSet(ana(), catalog, { frameworkId: fw, grades: "03" }), "exists");
  assert.deepEqual(await codes(secA), ["3.NS.1", "3.NS.2", "4.G.1"]);
  assert.deepEqual(await codes(secB), ["3.NS.1", "3.NS.2"], "the other teacher's class too, copied by nobody");

  // Whole set: B1 is already section A's own, so it isn't added twice there.
  assert.equal(await addCourseSet(ana(), catalog, { frameworkId: fw }), "ok");
  const a = await listStandards({ tenantId: T, userId: "ana" }, secA);
  assert.equal(a.filter((s) => s.code === "4.G.1").length, 1);
  assert.equal(a.find((s) => s.code === "4.G.1")!.id, ownB1);
  assert.equal(a.find((s) => s.code === "4.G.1")!.fromCourse, false);
  assert.deepEqual(await codes(secB), ["3.NS.1", "3.NS.2", "4.G.1"]);

  const sets = await listCourseSets({ tenantId: T }, catalog);
  assert.deepEqual(sets.map((s) => [s.title, s.grades, s.count]), [["School Math", ["03"], 2], ["School Math", [], 3]]);
  const cs = await classStandards({ tenantId: T, userId: "ana" }, secB);
  assert.deepEqual(cs.map((s) => [s.code, s.fromCourse, s.set, s.strand]), [
    ["3.NS.1", true, "School Math (2026)", "Number Sense"], ["3.NS.2", true, "School Math (2026)", "Number Sense"], ["4.G.1", true, "School Math (2026)", ""]]);
  // Inherited first in the pickers.
  assert.deepEqual((await standardOptions({ tenantId: T, userId: "ana" }, secA)).map((o) => o.name), ["3.NS.1", "3.NS.2", "4.G.1"]);
});

test("course sets: a part of a set; taking a set off archives (never deletes) and putting it back restores the same ids", async () => {
  const whole = (await listCourseSets({ tenantId: T }, catalog)).find((s) => !s.grades.length)!;
  const before = await listStandards({ tenantId: T, userId: "ben" }, secB);
  const g4 = before.find((s) => s.code === "4.G.1")!;
  assert.equal(await archiveStandard({ tenantId: T, userId: "ben" }, secB, g4.id), false, "the course decides its standards");

  assert.equal(await removeCourseSet(ana(), catalog, whole.id), true);
  assert.deepEqual(await codes(secB), ["3.NS.1", "3.NS.2"]);
  assert.deepEqual(await codes(secB, true), ["4.G.1"]);
  assert.deepEqual(await codes(secA), ["3.NS.1", "3.NS.2", "4.G.1"], "the class's own one stays");

  assert.equal(await addCourseSet(admin(), catalog, { frameworkId: fw, partId: part }), "ok");
  assert.equal(await addCourseSet(admin(), catalog, { frameworkId: fw }), "ok");
  const after = await listStandards({ tenantId: T, userId: "ben" }, secB);
  assert.deepEqual(after.map((s) => s.id).sort(), before.map((s) => s.id).sort(), "same ids back");
  assert.equal(await addCourseSet(admin(), catalog, { frameworkId: fw, partId: "00000000-0000-4000-8000-000000000000" }), "unknown");
});

test("course sets: a class moved out of the course loses (archives) its inherited standards; moved in, it gets them", async () => {
  const [{ id: secC }] = await myCourses(T, [cls("k-c", "Math 3 C")], "cal");
  assert.deepEqual(await codes(secC), []);
  await moveSection({ tenantId: T, userId: "cal" }, secC, catalog);
  assert.deepEqual(await codes(secC), ["3.NS.1", "3.NS.2", "4.G.1"]);
  await moveSection({ tenantId: T, userId: "cal" }, secC, "new");
  assert.deepEqual(await codes(secC), []);
  assert.deepEqual(await codes(secC, true), ["3.NS.1", "3.NS.2", "4.G.1"]);
});

test("coverage: taught, assessed, planned and still to cover", async () => {
  const c = { tenantId: T, userId: "ben" };
  const list = await listStandards(c, secB);
  const id = (code: string) => list.find((s) => s.code === code)!.id;
  const lesson = await createLesson(c, secB, "Counting");
  await saveLesson(c, lesson.id, { baseVersion: lesson.version, plannedFor: "2026-11-16" });
  await setLessonStandards(c, lesson.id, [id("3.NS.1")]);
  await recordPresentation(c, secB, lesson.id, "2026-11-17");
  const a = await createAssignment(c, secB, { title: "Compare quiz" });
  const saved = await saveAssignment(c, a.id, { baseVersion: a.version, standards: [id("3.NS.2"), id("3.NS.1")], dueOn: "2026-12-01", dueAt: "2026-12-01T20:00:00Z", published: true });
  assert.equal(saved.ok, true);

  const cov = await coverage(c, secB, "2026-11-23");
  const row = (code: string) => cov.rows.find((r) => r.code === code)!;
  assert.deepEqual([row("3.NS.1").status, row("3.NS.1").taught, row("3.NS.1").assessed, row("3.NS.1").last, row("3.NS.1").next], ["covered", 2, 0, "2026-11-17", "2026-12-01"]);
  assert.deepEqual([row("3.NS.2").status, row("3.NS.2").next], ["planned", "2026-12-01"]);
  assert.equal(row("4.G.1").status, "none");
  assert.deepEqual(cov.counts, { total: 3, covered: 1, planned: 1, none: 1 });
  assert.deepEqual(cov.byDay["2026-12-01"].length, 2);
  assert.deepEqual(cov.byDay["2026-11-16"], [id("3.NS.1")]);

  // After the due day, the quiz counts as assessed.
  const later = await coverage(c, secB, "2026-12-02");
  assert.deepEqual([later.rows.find((r) => r.code === "3.NS.2")!.status, later.rows.find((r) => r.code === "3.NS.2")!.assessed], ["covered", 1]);
});
