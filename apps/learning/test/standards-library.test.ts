import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses } from "../src/lib/courses";
import { createAssignment, saveAssignment, getAssignment } from "../src/lib/assignments";
import { setGrade, gradesFor } from "../src/lib/grades";
import { addStandard, courseGrading, listStandards, saveStandardsSettings, setGradingMode, updateStandard } from "../src/lib/standards";
import {
  addItem, addItemsToCourse, archiveFramework, canEdit, copyFramework, createFramework, frameworkItems, getFramework, getItem,
  importCsv, listFrameworks, loadLibrary, saveSchoolStandards, schoolSets, schoolStandards, searchItems, setSchoolSet, updateItem,
  followSet, jurisdictionCode, jurisdictionName, jurisdictionsOf, librarySets, standardOptions,
  LIBRARY, type Viewer,
} from "../src/lib/standards-library";
import { csvItems, gradeList, gradeSpan, parseCsv } from "../src/lib/standards-csv";
import { defaultSettings } from "../src/lib/standards-math";
import { setLessonStandards, getLesson, createLesson } from "../src/lib/lessons";

const MIGRATIONS = path.join(__dirname, "..", "migrations");
const SEEDS = path.join(__dirname, "..", "standards");

let db: Db;
const teacher = (over: Partial<Viewer> = {}): Viewer => ({ tenantId: "school-a", userId: "teacher-1", admin: false, teaches: [], ...over });
const ADMIN = teacher({ userId: "admin-1", admin: true });
const T = { tenantId: "school-a", userId: "teacher-1" };

// A tiny library: one open set (with a heading, a coded item under it and an
// association) and one set a school must turn on.
function writeSeeds(dir: string, version = "2010") {
  fs.mkdirSync(dir, { recursive: true });
  const seed = (key: string, distribution: string, items: unknown[]) => ({
    format: "signify-standards/1",
    framework: { key, version, title: `Test ${key}`, identifier: `doc-${key}-${version}`, subject: ["Mathematics"], distribution, notice: `© ${key}`, licenseTitle: "Test license", jurisdiction: key === "closed" ? "va" : null },
    items, associations: [{ origin: `${key}-1`, type: "exactMatchOf", dest: "elsewhere-1", destUri: null }],
  });
  const items = (key: string) => [
    { identifier: `${key}-h`, uri: null, code: "", statement: "Operations and Algebraic Thinking", abbreviated: null, type: "Domain", grades: ["03"], parent: null, list: null, notes: null },
    { identifier: `${key}-1`, uri: null, code: "3.OA.A.1", statement: "Interpret products of whole numbers", abbreviated: null, type: "Standard", grades: ["03"], parent: `${key}-h`, list: null, notes: null },
    { identifier: `${key}-2`, uri: null, code: "4.NBT.A.1", statement: "Recognize place value", abbreviated: null, type: "Standard", grades: ["04"], parent: null, list: null, notes: null },
  ];
  fs.writeFileSync(path.join(dir, `open@${version}.json`), JSON.stringify(seed("open", "open", items("open"))));
  fs.writeFileSync(path.join(dir, `closed@${version}.json`), JSON.stringify(seed("closed", "school", items("closed"))));
  const manifest = path.join(dir, "manifest.json");
  const prev: string[] = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, "utf8")) : [];
  fs.writeFileSync(manifest, JSON.stringify([...prev, `open@${version}.json`, `closed@${version}.json`]));
}
const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), "stdlib-"));

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, MIGRATIONS);
  useDb(db);
  writeSeeds(seedDir);
  assert.deepEqual(await loadLibrary(db, seedDir), ["open@2010.json", "closed@2010.json"]);
});
after(() => { fs.rmSync(seedDir, { recursive: true, force: true }); return db.close(); });

let n = 0;
async function course(tenant = "school-a") {
  const [c] = await myCourses(tenant, [{ id: `lib${++n}`, name: `Course ${n}`, role: "teacher" }]);
  return c;
}
const openId = async () => (await listFrameworks(teacher())).find((f) => f.key === "open")!.id;
const itemByCode = async (v: Viewer, code: string, frameworkId?: string) => (await searchItems(v, { q: code, frameworkId })).hits.find((h) => h.code === code)!;

// ---------- migration 014 ----------

test("migration 014: existing course standards become items of the course's own framework, ids, alignments and levels kept", async () => {
  const old = await openPglite("memory://");
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
    for (const f of fs.readdirSync(MIGRATIONS).filter((f) => f < "014")) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f));
    await migrate(old, dir);
    const [c] = await old.query<{ id: string }>("INSERT INTO courses (tenant_id, id_class_id, name) VALUES ('school-a', 'm1', 'Algebra') RETURNING id");
    const [s1] = await old.query<{ id: string }>("INSERT INTO standards (tenant_id, course_id, code, description, external_id, position) VALUES ('school-a', $1, 'A.1', 'Solve', 'case-9', 0) RETURNING id", [c.id]);
    const [s2] = await old.query<{ id: string }>("INSERT INTO standards (tenant_id, course_id, code, description, position, archived) VALUES ('school-a', $1, 'A.2', 'Graph', 1, true) RETURNING id", [c.id]);
    const [a] = await old.query<{ id: string }>(
      "INSERT INTO assignments (tenant_id, course_id, title, standards, created_by, updated_by) VALUES ('school-a', $1, 'Quiz', $2::jsonb, 't', 't') RETURNING id", [c.id, JSON.stringify([s1.id])]);
    await old.query("INSERT INTO grades (tenant_id, assignment_id, student_id, levels, graded_by) VALUES ('school-a', $1, 'stu-1', $2::jsonb, 't')", [a.id, JSON.stringify({ [s1.id]: 3 })]);
    fs.rmSync(dir, { recursive: true, force: true });

    assert.deepEqual(await migrate(old, MIGRATIONS), fs.readdirSync(MIGRATIONS).filter((f) => f >= "014" && f.endsWith(".sql")).sort());
    const rows = await old.query("SELECT s.id, s.code, s.archived, i.code AS icode, i.statement, i.uri, i.archived AS iarch, f.title, f.owner_kind, f.course_id FROM standards s JOIN standard_items i ON i.id = s.item_id JOIN standard_frameworks f ON f.id = i.framework_id ORDER BY s.position");
    assert.deepEqual(rows.map((r) => [r.id, r.icode, r.statement, r.title, r.owner_kind, r.course_id === c.id]), [
      [s1.id, "A.1", "Solve", "Algebra", "teacher", true], [s2.id, "A.2", "Graph", "Algebra", "teacher", true]]);
    assert.equal(rows[0].uri, "case-9", "a typed CASE id is kept as the item's uri");
    assert.equal(rows[1].iarch, true, "archived stays archived");
    const [g] = await old.query("SELECT levels FROM grades");
    assert.deepEqual(g.levels, { [s1.id]: 3 });
    const [as] = await old.query("SELECT standards FROM assignments");
    assert.deepEqual(as.standards, [s1.id]);
  } finally { await old.close(); }
});

// ---------- loading ----------

test("library: seeds load once, keep license and notice; a new version is a new framework, the old one superseded", async () => {
  assert.deepEqual(await loadLibrary(db, seedDir), [], "second run loads nothing");
  const f = (await listFrameworks(teacher())).find((x) => x.key === "open")!;
  assert.equal(f.ownerKind, "library");
  assert.equal(f.notice, "© open");
  assert.equal(f.licenseTitle, "Test license");
  assert.equal(f.itemCount, 3);
  const items = await frameworkItems(teacher(), f.id);
  assert.deepEqual(items.map((i) => [i.code, i.depth]), [["", 0], ["3.OA.A.1", 1], ["4.NBT.A.1", 0]]);
  assert.equal(items[1].parentId, items[0].id);
  const [{ n: assoc }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM standard_associations WHERE framework_id = $1", [f.id]);
  assert.equal(assoc, 1);

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "stdlib2-"));
  try {
    writeSeeds(dir2, "2010");
    writeSeeds(dir2, "2024");
    assert.deepEqual(await loadLibrary(db, dir2), ["open@2024.json", "closed@2024.json"]);
    const all = (await listFrameworks(teacher())).filter((x) => x.key === "open");
    assert.deepEqual(all.map((x) => [x.version, x.superseded]), [["2024", false], ["2010", true]]);
  } finally { fs.rmSync(dir2, { recursive: true, force: true }); }

  const bad = fs.mkdtempSync(path.join(os.tmpdir(), "stdlib3-"));
  try {
    fs.writeFileSync(path.join(bad, "manifest.json"), JSON.stringify(["x@1.json"]));
    fs.writeFileSync(path.join(bad, "x@1.json"), JSON.stringify({ format: "signify-standards/1", framework: { key: "y", version: "1", title: "Y", identifier: "y" }, items: [], associations: [] }));
    await assert.rejects(loadLibrary(db, bad), /don't match/);
  } finally { fs.rmSync(bad, { recursive: true, force: true }); }
});

test("library: the real seed files are well formed (ids unique, parents first, license and notice on each)", () => {
  const files: string[] = JSON.parse(fs.readFileSync(path.join(SEEDS, "manifest.json"), "utf8"));
  assert.ok(files.length >= 5);
  for (const file of files) {
    const s = JSON.parse(fs.readFileSync(path.join(SEEDS, file), "utf8"));
    assert.equal(s.format, "signify-standards/1", file);
    assert.equal(`${s.framework.key}@${s.framework.version}.json`, file);
    for (const k of ["title", "identifier", "licenseTitle", "licenseURI", "notice", "dataSource"]) assert.ok(s.framework[k], `${file}: ${k}`);
    assert.ok(["open", "school"].includes(s.framework.distribution), file);
    const seen = new Set<string>();
    for (const i of s.items) {
      assert.ok(!seen.has(i.identifier), `${file}: ${i.identifier} twice`);
      assert.ok(!i.parent || seen.has(i.parent), `${file}: ${i.identifier} before its parent`);
      assert.ok(i.statement, `${file}: ${i.identifier} has no statement`);
      assert.ok(!/<[a-z/][^>]*>/i.test(i.statement), `${file}: HTML in ${i.code}`);
      seen.add(i.identifier);
    }
    assert.ok(s.items.length > 300, `${file}: ${s.items.length} items`);
    assert.ok(!s.items.some((i: { statement: string }) => i.statement.includes("**")), `${file}: Markdown marks`);
    const j = s.framework.jurisdiction;
    assert.ok(j === null || jurisdictionCode(j) === j, `${file}: jurisdiction ${j}`);
    // Only Common Core is open to every school; a state's set needs the school to accept its terms.
    if (j) assert.equal(s.framework.distribution, "school", file);
    assert.ok(!s.framework.key.startsWith("nad"), "no NAD content without the NAD's permission and file");
  }
  const states = new Set(files.map((file) => JSON.parse(fs.readFileSync(path.join(SEEDS, file), "utf8")).framework.jurisdiction).filter(Boolean));
  for (const st of ["VA", "GA", "FL", "OK", "MD", "IN"]) assert.ok(states.has(st), st);
  const ccss = JSON.parse(fs.readFileSync(path.join(SEEDS, "ccss-math@2010.json"), "utf8"));
  assert.equal(ccss.framework.notice, "© Copyright 2010. National Governors Association Center for Best Practices and Council of Chief State School Officers. All rights reserved.");
  assert.ok(ccss.items.some((i: { code: string }) => i.code === "3.OA.A.1"));
});

test("library: the real seeds load into Postgres and can be searched", async () => {
  const real = await openPglite("memory://");
  try {
    await migrate(real, MIGRATIONS);
    const loaded = await loadLibrary(real, SEEDS);
    assert.ok(loaded.includes("ccss-math@2010.json") && loaded.includes("ccss-ela@2010.json"));
    const [{ n }] = await real.query<{ n: number }>("SELECT count(*)::int AS n FROM standard_items WHERE tenant_id = $1", [LIBRARY]);
    assert.ok(n > 6000, `${n} items`);
    const rl = await real.query("SELECT i.statement, i.grades FROM standard_items i JOIN standard_frameworks f ON f.id = i.framework_id WHERE f.key = 'ccss-ela' AND i.code = 'RL.3.1'");
    assert.deepEqual(rl[0].grades, ["03"]);
    const [{ open }] = await real.query<{ open: number }>("SELECT count(*)::int AS open FROM standard_frameworks WHERE distribution = 'open'");
    assert.equal(open, 2, "only Common Core is open to every school; the others need the school to turn them on");
  } finally { await real.close(); }
});

// ---------- browsing, search, visibility ----------

test("library: search by code, words, grade and subject; 'school' sets only once the school turns them on", async () => {
  const v = teacher();
  assert.equal((await itemByCode(v, "3.OA.A.1")).framework.notice, "© open");
  const pv = (await searchItems(v, { q: "VALUE place" })).hits;
  assert.ok(pv.length > 0 && pv.every((h) => h.code === "4.NBT.A.1"), "every word, any order, any case");
  const third = await searchItems(v, { frameworkId: await openId(), grade: "3" });
  assert.deepEqual(third.hits.map((h) => h.code), ["", "3.OA.A.1"], "a heading of the grade stays, the grade 4 item doesn't");
  assert.equal((await searchItems(v, { subject: "Science" })).hits.length, 0);
  assert.equal((await searchItems(v, { q: "100%_" })).hits.length, 0, "LIKE wildcards are plain text");

  assert.ok(!(await listFrameworks(v)).some((f) => f.key === "closed"));
  assert.ok(!(await searchItems(v, { q: "3.OA" })).hits.some((h) => h.framework.title === "Test closed"));
  assert.deepEqual((await schoolSets("school-a")).map((f) => f.key), ["closed"]);
  assert.ok(await setSchoolSet(ADMIN, "closed", true));
  assert.ok((await listFrameworks(v)).some((f) => f.key === "closed"));
  assert.ok(!(await listFrameworks({ ...v, tenantId: "school-b" })).some((f) => f.key === "closed"), "only that school");
  assert.equal(await setSchoolSet(ADMIN, "open", true), false, "open sets need no turning on");
  assert.equal(await setSchoolSet(ADMIN, "nope", true), false);
  assert.ok(await setSchoolSet(ADMIN, "closed", false));
  assert.deepEqual((await schoolStandards("school-a")).enabledSets, []);
});

test("library: adding items to a course copies code and statement, links the item, never twice", async () => {
  const c = await course();
  const v = teacher({ teaches: [c.id] });
  const it = await itemByCode(v, "3.OA.A.1");
  const heading = (await frameworkItems(v, it.frameworkId))[0];
  assert.deepEqual(await addItemsToCourse(v, c.id, [it.id, heading.id, it.id]), { added: 2, refused: 0 });
  assert.deepEqual(await addItemsToCourse(v, c.id, [it.id]), { added: 0, refused: 0 });
  const list = await listStandards(T, c.id);
  assert.deepEqual(list.map((s) => [s.code, s.description, s.itemId, s.editable]), [
    ["3.OA.A.1", "Interpret products of whole numbers", it.id, false],
    ["Operations and Algebraic Thinking", "Operations and Algebraic Thinking", heading.id, false],
  ]);
  assert.equal(list[0].externalId, it.identifier, "the CASE identifier");
  assert.equal(await updateStandard(T, c.id, list[0].id, "X", "Y"), false, "a library standard is changed at its source, not in the course");

  const closed = (await db.query<{ id: string }>("SELECT i.id FROM standard_items i JOIN standard_frameworks f ON f.id = i.framework_id WHERE f.key = 'closed' AND i.code = '3.OA.A.1'"))[0];
  assert.deepEqual(await addItemsToCourse(v, c.id, [closed.id]), { added: 0, refused: 1 }, "a set the school hasn't turned on");
  const other = await course("school-b");
  const own = await createFramework(teacher({ tenantId: "school-b", userId: "t9" }), "teacher", { title: "Mine" });
  const mine = await addItem(teacher({ tenantId: "school-b", userId: "t9" }), own!.id, { code: "B.1", statement: "Other school" });
  assert.deepEqual(await addItemsToCourse(v, c.id, [mine!.id]), { added: 0, refused: 1 }, "another school's item");
  assert.ok(other);
});

// ---------- school and teacher frameworks ----------

test("custom frameworks: admins make school ones, teachers their own when allowed; who may edit", async () => {
  assert.equal(await createFramework(teacher(), "school", { title: "School set" }), null, "teachers can't make school frameworks");
  const school = (await createFramework(ADMIN, "school", { title: "  Richmond Bible  ", subject: "Bible" }))!;
  assert.equal(school.title, "Richmond Bible");
  assert.deepEqual(school.subjects, ["Bible"]);
  assert.ok((await listFrameworks(teacher())).some((f) => f.id === school.id), "every teacher sees the school's");
  assert.equal(canEdit(teacher(), school), false);
  assert.equal(canEdit(ADMIN, school), true);
  assert.equal(await addItem(teacher(), school.id, { statement: "nope" }), null);

  const mine = (await createFramework(teacher(), "teacher", { title: "My set" }))!;
  assert.ok(!(await listFrameworks(teacher({ userId: "teacher-2" }))).some((f) => f.id === mine.id), "another teacher doesn't see it");
  assert.equal(await getFramework({ ...teacher(), tenantId: "school-b" }, mine.id), null);

  await saveSchoolStandards(ADMIN, { teacherFrameworks: false });
  try {
    assert.equal(await createFramework(teacher(), "teacher", { title: "Not allowed" }), null);
    assert.ok(await createFramework(ADMIN, "teacher", { title: "Admins still may" }));
    const c = await course();
    assert.equal(await addStandard(T, c.id, "X.1", "Typed in"), null, "typing standards into a course is making your own");
  } finally { await saveSchoolStandards(ADMIN, { teacherFrameworks: true }); }
  assert.ok(await archiveFramework(teacher(), mine.id, true));
  assert.ok(!(await listFrameworks(teacher())).some((f) => f.id === mine.id));
  assert.equal(await archiveFramework(teacher({ userId: "teacher-2" }), mine.id, false), false);
});

test("custom frameworks: items with grades and parents; an edit reaches courses using it", async () => {
  const fw = (await createFramework(ADMIN, "school", { title: "Bible", subject: "Bible" }))!;
  const top = (await addItem(ADMIN, fw.id, { code: "B.1", statement: "Biblical Foundations", grades: "K-8" }))!;
  const kid = (await addItem(ADMIN, fw.id, { code: "B.1.1", statement: "Identify God as Creator", grades: "1", parentId: top.id }))!;
  assert.deepEqual(top.grades, ["KG", "01", "02", "03", "04", "05", "06", "07", "08"]);
  assert.equal(kid.parentId, top.id);
  assert.equal(kid.depth, 1);
  const c = await course();
  const v = teacher({ teaches: [c.id] });
  await addItemsToCourse(v, c.id, [kid.id]);
  assert.ok(await updateItem(ADMIN, kid.id, { code: "B.1.1a", statement: "Identify the Godhead as Creator", grades: "1-2" }));
  const [s] = await listStandards(T, c.id);
  assert.deepEqual([s.code, s.description], ["B.1.1a", "Identify the Godhead as Creator"]);
  assert.equal(await updateItem(teacher(), kid.id, { statement: "teacher edit" }), false);
  assert.deepEqual((await getItem(v, kid.id))!.path.map((p) => p.code), ["B.1"]);
});

test("custom frameworks: CSV import, all or nothing, parents by code", async () => {
  const fw = (await createFramework(teacher(), "teacher", { title: "From CSV" }))!;
  const bad = await importCsv(teacher(), fw.id, "code,statement,grades,parent\nW.1,Write,3,\nW.1.a,,3,W.1\nW.2,Edit,3,ZZZ\n");
  assert.deepEqual(bad!.problems, [{ line: 3, problem: "noStatement" }, { line: 4, problem: "unknownParent" }]);
  assert.equal((await frameworkItems(teacher(), fw.id)).length, 0, "nothing written");
  const ok = await importCsv(teacher(), fw.id, '﻿Code;Description;Grade levels;Parent code\r\nW.1;"Write; with ""care""";3-4;\r\nW.1.a;Plan first;3;W.1\r\n');
  assert.deepEqual(ok, { added: 2, problems: [] });
  const items = await frameworkItems(teacher(), fw.id);
  assert.deepEqual(items.map((i) => [i.code, i.statement, i.grades, i.depth]), [["W.1", 'Write; with "care"', ["03", "04"], 0], ["W.1.a", "Plan first", ["03"], 1]]);
  const again = await importCsv(teacher(), fw.id, "code,statement\nW.1,Again\nW.3,New\n");
  assert.deepEqual(again!.problems, [{ line: 2, problem: "duplicateCode" }]);
  assert.equal(await importCsv(teacher({ userId: "teacher-2" }), fw.id, "code,statement\nX,Y\n"), null);
});

test("custom frameworks: copying a library set to edit keeps its license and points back at the originals", async () => {
  const copy = (await copyFramework(ADMIN, await openId(), "school"))!;
  assert.equal(copy.ownerKind, "school");
  assert.equal(copy.notice, "© open", "the copyright notice travels with the copy");
  assert.equal(copy.copiedFrom, await openId());
  const items = await frameworkItems(ADMIN, copy.id);
  assert.deepEqual(items.map((i) => [i.code, i.depth]), [["", 0], ["3.OA.A.1", 1], ["4.NBT.A.1", 0]]);
  const orig = await frameworkItems(ADMIN, await openId());
  assert.notEqual(items[1].identifier, orig[1].identifier, "new identifiers");
  const links = await db.query("SELECT dest_identifier FROM standard_associations WHERE framework_id = $1 AND association_type = 'exactMatchOf' ORDER BY dest_identifier", [copy.id]);
  assert.deepEqual(links.map((l) => l.dest_identifier), orig.map((i) => i.identifier).sort());
  assert.ok(await updateItem(ADMIN, items[1].id, { code: "3.OA.A.1", statement: "Our wording" }));
  assert.equal((await frameworkItems(ADMIN, await openId()))[1].statement, "Interpret products of whole numbers", "the library is never changed");
  assert.equal(await copyFramework(teacher(), copy.id, "school"), null, "teachers don't make school frameworks");
});

// ---------- school and course grading settings ----------

test("grading settings: school default for courses, a course's own only when the school allows", async () => {
  const c = await course();
  await setGradingMode(T, c.id, "standards");
  let g = await courseGrading(T, c.id);
  assert.equal(g.source, "default");
  assert.deepEqual(g.settings, defaultSettings());

  await saveSchoolStandards(ADMIN, { settings: { labels: ["Mastered", "Progressing", "Not yet"], summary: "mean" } });
  g = await courseGrading(T, c.id);
  assert.equal(g.source, "school");
  assert.deepEqual(g.settings.labels, ["Mastered", "Progressing", "Not yet"]);

  assert.ok(await saveStandardsSettings(T, c.id, { summary: "highest" }));
  g = await courseGrading(T, c.id);
  assert.equal(g.source, "course");
  assert.equal(g.settings.summary, "highest");

  await saveSchoolStandards(ADMIN, { courseSettings: false });
  g = await courseGrading(T, c.id);
  assert.equal(g.source, "school", "the school's when it stops allowing course settings");
  assert.equal(g.courseSettingsAllowed, false);
  assert.equal(await saveStandardsSettings(T, c.id, { summary: "highest" }), null, "refused");

  await saveSchoolStandards(ADMIN, { courseSettings: true });
  assert.equal((await courseGrading(T, c.id)).source, "course", "and back");
  await saveStandardsSettings(T, c.id, null);
  assert.equal((await courseGrading(T, c.id)).source, "school", "follow the school again");
  await saveSchoolStandards(ADMIN, { settings: null });
  assert.equal((await courseGrading(T, c.id)).source, "default");
  assert.equal((await courseGrading({ tenantId: "school-b", userId: "x" }, c.id)).source, "default", "other schools see nothing");
});

// ---------- lessons ----------

test("alignment: a lesson's standards are this course's live ones, filed without a new lesson version", async () => {
  const c = await course();
  const s1 = (await addStandard(T, c.id, "L.1", "One"))!;
  const other = await course();
  const s2 = (await addStandard(T, other.id, "L.2", "Two"))!;
  const lesson = await createLesson(T, c.id, "Lesson");
  assert.deepEqual(await setLessonStandards(T, lesson.id, [s1.id, s2.id, s1.id, "nope"]), [s1.id]);
  const l = (await getLesson(T, lesson.id))!;
  assert.deepEqual(l.standards, [s1.id]);
  assert.equal(l.version, lesson.version, "no new version");
  assert.deepEqual(await setLessonStandards(T, lesson.id, []), []);
  assert.equal((await getLesson(T, lesson.id))!.standards, null);
  assert.equal(await setLessonStandards({ tenantId: "school-b", userId: "x" }, lesson.id, [s1.id]), null);
});

test("alignment: assignments, rubric rows and quiz questions accept library standards added to the course; levels are kept", async () => {
  const c = await course();
  await setGradingMode(T, c.id, "standards");
  const v = teacher({ teaches: [c.id] });
  await addItemsToCourse(v, c.id, [(await itemByCode(v, "3.OA.A.1")).id]);
  const [s] = await listStandards(T, c.id);
  const a = await createAssignment(T, c.id, { title: "Products" });
  const r = await saveAssignment(T, a.id, {
    baseVersion: a.version, published: true, gradesReleased: true, points: 4, standards: [s.id],
    rubric: { criteria: [{ id: "c1", title: "Explains", standardId: s.id, levels: [{ id: "l4", title: "4", points: 4 }, { id: "l1", title: "1", points: 1 }] }] },
  });
  assert.ok(r.ok);
  assert.deepEqual((await getAssignment(T, a.id))!.standards, [s.id]);
  assert.equal((await getAssignment(T, a.id))!.rubric!.criteria[0].standardId, s.id);
  const saved = await setGrade(T, (await getAssignment(T, a.id))!, "stu-1", new Set(["stu-1"]), { score: 4, levels: { [s.id]: 3 } });
  assert.ok(saved.ok);
  assert.deepEqual((await gradesFor(T, a.id))[0].levels, { [s.id]: 3 });
});

// ---------- pure helpers ----------

// ---------- states and the sets a school follows ----------

test("migration 015: Virginia sets get their state, Markdown marks leave loaded statements and course copies", async () => {
  const old = await openPglite("memory://");
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mig15-"));
    for (const f of fs.readdirSync(MIGRATIONS).filter((f) => f < "015")) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(dir, f));
    await migrate(old, dir);
    const [fw] = await old.query<{ id: string }>("INSERT INTO standard_frameworks (tenant_id, owner_kind, key, identifier, title, version, distribution) VALUES ('_library', 'library', 'va-sol-english', 'd', 'VA English', '2024', 'school') RETURNING id");
    await old.query("INSERT INTO standard_frameworks (tenant_id, owner_kind, key, identifier, title, version) VALUES ('_library', 'library', 'ccss-math', 'c', 'CCSS', '2010')");
    const [it] = await old.query<{ id: string }>("INSERT INTO standard_items (tenant_id, framework_id, identifier, code, statement) VALUES ('_library', $1, 'i1', 'K.W.3', '**Usage** and Mechanics') RETURNING id", [fw.id]);
    const [c] = await old.query<{ id: string }>("INSERT INTO courses (tenant_id, id_class_id, name) VALUES ('school-a', 'm15', 'English') RETURNING id");
    await old.query("INSERT INTO standards (tenant_id, course_id, code, description, item_id, position) VALUES ('school-a', $1, 'K.W.3', '**Usage** and Mechanics', $2, 0)", [c.id, it.id]);
    fs.rmSync(dir, { recursive: true, force: true });
    await migrate(old, MIGRATIONS);
    assert.deepEqual((await old.query("SELECT key, jurisdiction FROM standard_frameworks ORDER BY key")).map((r) => [r.key, r.jurisdiction]), [["ccss-math", null], ["va-sol-english", "VA"]]);
    assert.equal((await old.query("SELECT statement FROM standard_items"))[0].statement, "Usage and Mechanics");
    assert.equal((await old.query("SELECT description FROM standards"))[0].description, "Usage and Mechanics");
    assert.equal((await old.query("SELECT count(*)::int AS n FROM school_followed_sets"))[0].n, 0);
  } finally { await old.close(); }
});

test("states: a seed's state is kept; codes are checked; names in English and Spanish; a school's picked states", async () => {
  const lib = await librarySets("school-s");
  assert.equal(lib.find((f) => f.key === "closed")!.jurisdiction, "VA", "lower case in a seed is stored as the code");
  assert.equal(lib.find((f) => f.key === "open")!.jurisdiction, null);
  assert.deepEqual(jurisdictionsOf(lib), ["VA"]);
  assert.equal(jurisdictionCode(" ga "), "GA");
  assert.equal(jurisdictionCode("nad"), "NAD");
  assert.equal(jurisdictionCode("XX"), null);
  assert.equal(jurisdictionCode(7), null);
  assert.equal(jurisdictionName("NC"), "North Carolina");
  assert.equal(jurisdictionName("NC", "es"), "Carolina del Norte");
  assert.equal(jurisdictionName("GA", "es"), "Georgia");
  const ctx = { tenantId: "school-s", userId: "admin-s" };
  assert.deepEqual((await schoolStandards("school-s")).jurisdictions, [], "a new school picked nothing");
  const saved = await saveSchoolStandards(ctx, { jurisdictions: ["va", "XX", "NAD", "VA", 3] });
  assert.deepEqual(saved.jurisdictions, ["NAD", "VA"]);
  assert.equal(saved.teacherFrameworks, true, "other settings untouched");
  await saveSchoolStandards(ctx, { teacherFrameworks: false });
  assert.deepEqual((await schoolStandards("school-s")).jurisdictions, ["NAD", "VA"], "saving something else keeps the states");
  assert.deepEqual((await schoolStandards("school-a")).jurisdictions, [], "another school untouched");
});

test("followed sets: none = the library as before; following a 'school' set needs its terms and turns it on", async () => {
  const school = "school-f";
  const v = teacher({ tenantId: school, userId: "t-f" });
  const admin = { tenantId: school, userId: "admin-f" };
  const before = await listFrameworks(v);
  assert.deepEqual(before.map((f) => [f.key, f.followed]), [["open", false], ["open", false]], "nothing followed; the 'school' set not on");
  assert.deepEqual((await schoolStandards(school)).followedSets, []);

  assert.equal(await followSet(admin, "nope", true, true), "unknown");
  assert.equal(await followSet(admin, "closed", true), "terms", "not accepted: refused");
  assert.deepEqual((await schoolStandards(school)).enabledSets, [], "and not turned on");
  assert.equal(await followSet(admin, "closed", true, true), "ok");
  const st = await schoolStandards(school);
  assert.deepEqual([st.followedSets, st.enabledSets], [["closed"], ["closed"]], "following turned it on");

  const list = await listFrameworks(v);
  assert.equal(list[0].key, "closed", "followed sets come first");
  assert.ok(list.filter((f) => f.key === "closed").every((f) => f.followed), "every version of a followed key");
  assert.ok(list.filter((f) => f.key === "open").every((f) => !f.followed));
  assert.deepEqual((await listFrameworks(teacher())).filter((f) => f.followed), [], "another school follows nothing");

  // Search: followed only (plus the school's and teacher's own sets) unless all are asked for.
  const mine = await createFramework(v, "teacher", { title: "My set" });
  await addItem(v, mine!.id, { code: "MY.1", statement: "Interpret my own products" });
  const scoped = await searchItems(v, { q: "interpret", followed: true });
  assert.deepEqual([...new Set(scoped.hits.map((h) => h.framework.title))].sort(), ["My set", "Test closed"]);
  assert.equal(scoped.hits[0].framework.title, "Test closed", "followed first");
  const all = await searchItems(v, { q: "interpret" });
  assert.ok(all.hits.some((h) => h.framework.title === "Test open"), "every set the teacher may see is still there");
  assert.equal(all.hits[0].framework.title, "Test closed", "followed first there too");
  const openFw = list.find((f) => f.key === "open")!;
  assert.ok((await searchItems(v, { frameworkId: openFw.id, followed: true })).hits.length > 0, "a set picked by name ignores the filter");

  // Following an open set needs no terms; stopping leaves a 'school' set on.
  assert.equal(await followSet(admin, "open", true), "ok");
  assert.equal(await followSet(admin, "closed", false), "ok");
  assert.deepEqual([(await schoolStandards(school)).followedSets, (await schoolStandards(school)).enabledSets], [["open"], ["closed"]]);
  assert.equal(await followSet(admin, "closed", true), "ok", "already on: no terms asked again");
  // Turning a set off stops following it.
  await setSchoolSet(admin, "closed", false);
  assert.deepEqual((await schoolStandards(school)).followedSets, ["open"]);
  assert.equal((await listFrameworks(v)).filter((f) => f.key === "closed").length, 0);
});

test("followed sets: the course pickers list standards from followed sets first, the course's order otherwise", async () => {
  const school = "school-p";
  const c = await course(school);
  const v = teacher({ tenantId: school, userId: "t-p", teaches: [c.id] });
  const admin = { tenantId: school, userId: "admin-p" };
  await setSchoolSet(admin, "closed", true);
  const open = await itemByCode(v, "4.NBT.A.1", (await listFrameworks(v)).find((f) => f.key === "open" && f.version === "2010")!.id);
  const closed = await itemByCode(v, "3.OA.A.1", (await listFrameworks(v)).find((f) => f.key === "closed" && f.version === "2010")!.id);
  await addItemsToCourse(v, c.id, [open.id, closed.id]);
  const ctx = { tenantId: school, userId: "t-p" };
  assert.deepEqual((await standardOptions(ctx, c.id)).map((o) => o.name), ["4.NBT.A.1", "3.OA.A.1"], "nothing followed: the course's order");
  await followSet(admin, "closed", true);
  assert.deepEqual((await standardOptions(ctx, c.id)).map((o) => o.name), ["3.OA.A.1", "4.NBT.A.1"]);
});

test("csv and grade helpers", () => {
  assert.deepEqual(gradeList("K, 2-3; 12"), ["KG", "02", "03", "12"]);
  assert.deepEqual(gradeList(["pre-k", "1"]), ["PK", "01"]);
  assert.deepEqual(gradeList("5-3"), ["03", "04", "05"]);
  assert.deepEqual(gradeList("13, x"), []);
  assert.equal(gradeSpan(["KG", "01", "02", "05", "09", "10", "11", "12"]), "K–2, 5, 9–12");
  assert.equal(gradeSpan([]), "");
  assert.deepEqual(parseCsv('a,b\n"x, y","z""q"\n\n'), [["a", "b"], ["x, y", 'z"q']]);
  assert.deepEqual(parseCsv("a\tb\n1\t2"), [["a", "b"], ["1", "2"]]);
  const r = csvItems("standard,text,type\nA,Alpha,Domain\n,Beta,\n");
  assert.deepEqual(r.items.map((i) => [i.code, i.statement, i.type]), [["A", "Alpha", "Domain"], ["", "Beta", null]]);
  assert.deepEqual(r.columns, ["code", "statement", "type"]);
});
