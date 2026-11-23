import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses } from "../src/lib/courses";
import { createLesson, getLesson } from "../src/lib/lessons";
import { createUnit } from "../src/lib/units";
import {
  canCopyFrom, catalogOf, copyContent, copySources, sourceContents, moveSection, suggestedCatalog, myCatalog,
  requestShare, requestsToAnswer, answerShare, askableSections, renameCatalog, CopyError,
} from "../src/lib/sections";

let db: Db;
const T = "school-a";
const ana = { tenantId: T, userId: "teacher-ana" };
const ben = { tenantId: T, userId: "teacher-ben" };
const admin = { tenantId: T, userId: "admin-1", admin: true };
const other = { tenantId: "school-b", userId: "teacher-ana" };

const cls = (id: string, name: string, year: string, role = "teacher") => ({ id, name, subject: "Bible", role, school_year: year });

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
});
after(() => db.close());

test("sections: migration 017 gives every existing class a course of its own and keeps all its content", async () => {
  const fresh = await openPglite("memory://");
  const dir = path.join(__dirname, "..", "migrations");
  // Migrate up to 016, add data the old way, then run 017.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
  for (const f of fs.readdirSync(dir).filter((f: string) => f < "017")) fs.copyFileSync(path.join(dir, f), path.join(tmp, f));
  await migrate(fresh, tmp);
  const [c] = await fresh.query("INSERT INTO courses (tenant_id, id_class_id, name) VALUES ('s', 'k1', 'Old class') RETURNING id");
  await fresh.query("INSERT INTO lessons (tenant_id, course_id, title, created_by, updated_by) VALUES ('s', $1, 'L', 'teacher-x', 'teacher-x')", [c.id]);
  await fresh.query("INSERT INTO assignments (tenant_id, course_id, title, created_by, updated_by) VALUES ('s', $1, 'A', 'teacher-y', 'teacher-y')", [c.id]);
  fs.copyFileSync(path.join(dir, "017_courses_sections.sql"), path.join(tmp, "017_courses_sections.sql"));
  await migrate(fresh, tmp);
  const [row] = await fresh.query("SELECT c.catalog_id, k.name FROM courses c JOIN catalog_courses k ON k.id = c.catalog_id WHERE c.id = $1", [c.id]);
  assert.equal(row.name, "Old class");
  const teachers = (await fresh.query("SELECT user_id FROM section_teachers WHERE course_id = $1 ORDER BY user_id", [c.id])).map((r) => r.user_id);
  assert.deepEqual(teachers, ["teacher-x", "teacher-y"]);
  const [{ n }] = await fresh.query("SELECT (SELECT count(*) FROM lessons) + (SELECT count(*) FROM assignments) AS n");
  assert.equal(Number(n), 2);
  await fresh.close();
  fs.rmSync(tmp, { recursive: true });
});

let bible25 = "", bible26 = "", benClass = "";

test("sections: a new class gets its own course, its school year, and remembers its teacher", async () => {
  const [c] = await myCourses(T, [cls("id-bible-25", "Bible 9", "2025")], ana.userId);
  bible25 = c.id;
  assert.ok(c.catalogId);
  assert.equal(c.schoolYear, "2025");
  const [again] = await myCourses(T, [cls("id-bible-25", "Bible 9", "2025")], ana.userId);
  assert.equal(again.catalogId, c.catalogId, "seen twice, still one course");
  const cat = await catalogOf(ana, bible25);
  assert.equal(cat?.name, "Bible 9");
  assert.deepEqual(cat?.sections.map((s) => [s.id, s.mine]), [[bible25, true]]);
  // A student seeing the class doesn't make them its teacher.
  await myCourses(T, [cls("id-bible-25", "Bible 9", "2025", "student")], "student-1");
  assert.equal(await canCopyFrom({ tenantId: T, userId: "student-1" }, bible25), false);
});

test("sections: nothing is copied into next year's class on its own; the teacher may put it in the same course", async () => {
  const u = await createUnit(ana, bible25, "Creation");
  await createLesson(ana, bible25, "Day one", [{ id: "b1", type: "text", title: "Light", body: "Genesis 1" }], u.id);
  const [c] = await myCourses(T, [cls("id-bible-26", "Bible 9", "2026")], ana.userId);
  bible26 = c.id;
  const [{ n }] = await db.query("SELECT count(*)::int AS n FROM lessons WHERE course_id = $1", [bible26]);
  assert.equal(n, 0);
  assert.notEqual(c.catalogId, (await catalogOf(ana, bible25))!.id);
  const suggested = await suggestedCatalog(ana, bible26);
  assert.equal(suggested?.name, "Bible 9");
  const empty = c.catalogId;
  assert.equal(await moveSection(ana, bible26, suggested!.id), suggested!.id);
  const cat = await catalogOf(ana, bible26);
  assert.deepEqual(cat?.sections.map((s) => s.schoolYear), ["2026", "2025"], "newest year first");
  const [gone] = await db.query("SELECT 1 FROM catalog_courses WHERE id = $1", [empty]);
  assert.equal(gone, undefined, "the empty course left behind is removed");
  const [{ n: still }] = await db.query("SELECT count(*)::int AS n FROM lessons WHERE course_id = $1", [bible26]);
  assert.equal(still, 0, "moving copies nothing");
  assert.ok((await myCatalog(ana)).some((k) => k.id === cat!.id));
});

test("sections: a teacher copies a unit from last year's class, as drafts, with standards, categories and tool placements", async () => {
  const [unit] = await db.query("SELECT id FROM units WHERE course_id = $1", [bible25]);
  const [std] = await db.query("INSERT INTO standards (tenant_id, course_id, code, description) VALUES ($1, $2, 'BC.9.1', 'Creation') RETURNING id", [T, bible25]);
  const [cat] = await db.query("INSERT INTO grade_categories (tenant_id, course_id, name, weight) VALUES ($1, $2, 'Tests', 40) RETURNING id", [T, bible25]);
  await db.query(
    `INSERT INTO assignments (tenant_id, course_id, unit_id, category_id, title, kind, points, standards, rubric, due_on, due_at, published, grades_released, created_by, updated_by)
     VALUES ($1, $2, $3, $4, 'Creation test', 'offline', 20, $5::jsonb, $6::jsonb, '2025-09-10', '2025-09-10T12:00:00Z', true, true, $7, $7)`,
    [T, bible25, unit.id, cat.id, JSON.stringify([std.id]), JSON.stringify({ criteria: [{ id: "c1", title: "Recall", standardId: std.id, levels: [] }] }), ana.userId],
  );
  const [tool] = await db.query(
    "INSERT INTO lti_tools (tenant_id, name, client_id, login_url, launch_url, jwks_url, created_by) VALUES ($1, 'Quizzer', 'cid-1', 'https://t.example/login', 'https://t.example/launch', 'https://t.example/jwks', $2) RETURNING id",
    [T, ana.userId]);
  const [lessonWithTool] = await db.query("SELECT id FROM lessons WHERE course_id = $1", [bible25]);
  const [link] = await db.query("INSERT INTO lti_tool_links (tenant_id, tool_id, course_id, lesson_id, title, created_by) VALUES ($1, $2, $3, $4, 'Quiz', $5) RETURNING id",
    [T, tool.id, bible25, lessonWithTool.id, ana.userId]);
  await db.query(`UPDATE lessons SET blocks = blocks || $2::jsonb WHERE id = $1`,
    [lessonWithTool.id, JSON.stringify([{ id: "t1", type: "tool", title: "Quiz", linkId: link.id, display: "tab" }])]);
  await db.query("UPDATE lessons SET planned_for = '2025-09-08' WHERE id = $1", [lessonWithTool.id]);

  const sources = await copySources(ana, bible26);
  assert.deepEqual(sources.map((s) => s.id), [bible25]);
  const contents = await sourceContents(ana, bible25);
  assert.equal(contents?.units.length, 1);
  const r = await copyContent(ana, bible25, bible26, { units: [unit.id] });
  assert.deepEqual(r, { units: 1, lessons: 1, assignments: 1, resources: 0, standards: 1, categories: 1, tools: 1 });

  const [a] = await db.query("SELECT * FROM assignments WHERE course_id = $1", [bible26]);
  assert.equal(a.published, false);
  assert.equal(a.grades_released, false);
  assert.equal(a.due_on, null);
  assert.equal(a.due_at, null);
  const [newStd] = await db.query("SELECT id FROM standards WHERE course_id = $1", [bible26]);
  assert.deepEqual(a.standards, [newStd.id], "standards point at the new class's own copy");
  assert.equal((a.rubric as { criteria: { standardId: string }[] }).criteria[0].standardId, newStd.id);
  const [newCat] = await db.query("SELECT id, weight FROM grade_categories WHERE course_id = $1", [bible26]);
  assert.equal(a.category_id, newCat.id);
  const [l] = await db.query("SELECT * FROM lessons WHERE course_id = $1", [bible26]);
  assert.equal(l.planned_for, null, "copied lessons are unscheduled");
  assert.equal(l.version, 1);
  const toolBlock = (l.blocks as { type: string; linkId: string }[]).find((b) => b.type === "tool")!;
  const [newLink] = await db.query("SELECT * FROM lti_tool_links WHERE id = $1", [toolBlock.linkId]);
  assert.equal(newLink.course_id, bible26, "the tool placement is the new class's own");
  assert.equal(newLink.lesson_id, l.id);
  assert.equal(l.unit_id, (await db.query("SELECT id FROM units WHERE course_id = $1", [bible26]))[0].id);
  const lesson = await getLesson(ana, String(l.id));
  assert.equal(lesson?.title, "Day one");
  // No grades, submissions or student data travel.
  const [{ n }] = await db.query("SELECT count(*)::int AS n FROM grades g JOIN assignments a ON a.id = g.assignment_id WHERE a.course_id = $1", [bible26]);
  assert.equal(n, 0);
  const [log] = await db.query("SELECT * FROM content_copies WHERE to_course = $1", [bible26]);
  assert.equal(log.from_course, bible25);

  // Copying again matches the standard and category by code/name instead of adding them twice.
  const again = await copyContent(ana, bible25, bible26, { assignments: [(await db.query("SELECT id FROM assignments WHERE course_id = $1", [bible25]))[0].id] });
  assert.equal(again.standards, 0);
  assert.equal(again.categories, 0);
  const [{ u }] = await db.query("SELECT count(*)::int AS u FROM units WHERE course_id = $1", [bible26]);
  assert.equal(u, 1, "a single item goes into the class's unit of the same name");
});

test("sections: copying from a class someone never taught, or across schools, is refused", async () => {
  const [c] = await myCourses(T, [cls("id-ben", "Bible 10", "2026")], ben.userId);
  benClass = c.id;
  await createLesson(ben, benClass, "Ben's lesson", []);
  assert.equal(await canCopyFrom(ana, benClass), false);
  assert.equal(await sourceContents(ana, benClass), null);
  await assert.rejects(copyContent(ana, benClass, bible26, { lessons: [(await db.query("SELECT id FROM lessons WHERE course_id = $1", [benClass]))[0].id] }), CopyError);
  assert.equal(await canCopyFrom(other, bible25), false, "same person id in another school");
  await assert.rejects(copyContent(other, bible25, bible26, { units: [] }), CopyError);
  await assert.rejects(copyContent(ana, bible25, bible25, { units: [] }), CopyError);
});

test("sections: ask another teacher's class to share; its teacher or an admin answers; taking it back stops copying", async () => {
  const askable = await askableSections(ana);
  assert.ok(askable.some((s) => s.id === benClass));
  assert.ok(!askable.some((s) => s.id === bible25), "own classes aren't offered");
  const req = await requestShare({ ...ana, name: "Ana Teacher" }, benClass, { forCourseId: bible26, message: "May I use your unit?" });
  assert.ok(req);
  assert.equal(req!.forCourseName, "Bible 9");
  assert.equal(req!.requestedName, "Ana Teacher");
  assert.equal(await requestShare(ana, benClass, {}), null, "one open request at a time");
  assert.equal(await requestShare(ana, bible25, {}), null, "no asking for a class you may copy already");

  assert.deepEqual((await requestsToAnswer(ben)).map((r) => r.id), [req!.id]);
  assert.deepEqual((await requestsToAnswer(ana)), [], "the asker doesn't answer their own");
  assert.equal((await requestsToAnswer(admin)).length, 1, "an admin sees the school's");
  assert.equal(await answerShare(ana, req!.id, "approve"), false, "nobody approves their own request");
  assert.equal(await answerShare({ tenantId: T, userId: "teacher-zed" }, req!.id, "approve"), false, "a stranger can't answer");
  assert.equal(await answerShare({ tenantId: "school-b", userId: "admin-1", admin: true }, req!.id, "approve"), false, "another school's admin can't");
  assert.equal(await answerShare(ben, req!.id, "approve"), true);
  assert.equal(await canCopyFrom(ana, benClass), true);
  assert.ok((await copySources(ana, bible26)).some((s) => s.id === benClass && s.shared));
  const lessonId = (await db.query("SELECT id FROM lessons WHERE course_id = $1", [benClass]))[0].id;
  assert.equal((await copyContent(ana, benClass, bible26, { lessons: [lessonId] })).lessons, 1);

  assert.equal(await answerShare(admin, req!.id, "revoke"), true, "the school can take it back");
  assert.equal(await canCopyFrom(ana, benClass), false);
  const again = await requestShare(ana, benClass, {});
  assert.ok(again, "can ask again after a revoke");
  assert.equal(await answerShare(ana, again!.id, "withdraw"), true);
  assert.equal(await answerShare(ben, again!.id, "approve"), false, "a withdrawn request can't be approved");
});

test("sections: renaming a course needs a teacher of one of its sections or an admin", async () => {
  const cat = (await catalogOf(ana, bible26))!;
  assert.equal(await renameCatalog(ben, cat.id, "Hijacked"), false);
  assert.equal(await renameCatalog(ana, cat.id, "  Bible 9:  Foundations "), true);
  assert.equal((await catalogOf(ana, bible26))!.name, "Bible 9: Foundations");
  assert.equal(await renameCatalog(admin, cat.id, "Bible 9"), true);
  assert.equal(await renameCatalog({ ...other, admin: true }, cat.id, "x"), false);
});

test("sections: class resources copy too, hidden from students; a lesson resource brings its lesson; a club gets no assignments", async () => {
  const [lesson] = await db.query("SELECT id FROM lessons WHERE course_id = $1 LIMIT 1", [bible25]);
  const [link] = await db.query(
    `INSERT INTO class_resources (tenant_id, course_id, kind, title, block, visible, created_by, updated_by)
     VALUES ($1, $2, 'block', 'Bible Project video', $3::jsonb, true, $4, $4) RETURNING id`,
    [T, bible25, JSON.stringify({ id: "r1", type: "link", title: "Video", url: "https://example.org/v" }), ana.userId]);
  const [pointer] = await db.query(
    "INSERT INTO class_resources (tenant_id, course_id, kind, lesson_id, created_by, updated_by) VALUES ($1, $2, 'lesson', $3, $4, $4) RETURNING id",
    [T, bible25, lesson.id, ana.userId]);
  const listed = await sourceContents(ana, bible25);
  assert.equal(listed?.resources.length, 2);
  const [fresh] = await myCourses(T, [cls("id-bible-27", "Bible 9", "2027")], ana.userId);
  const r = await copyContent(ana, bible25, fresh.id, { resources: [link.id, pointer.id] });
  assert.equal(r.resources, 2);
  assert.equal(r.lessons, 1, "the pointed-at lesson came along");
  const copied = await db.query("SELECT * FROM class_resources WHERE course_id = $1 ORDER BY position", [fresh.id]);
  assert.ok(copied.every((c) => c.visible === false), "hidden until the teacher shows them");
  const [newLesson] = await db.query("SELECT id FROM lessons WHERE course_id = $1", [fresh.id]);
  assert.equal(copied.find((c) => c.kind === "lesson")!.lesson_id, newLesson.id);

  await db.query("UPDATE courses SET kind = 'club' WHERE id = $1", [fresh.id]);
  const clubCopy = await copyContent(ana, bible25, fresh.id, { units: [(await db.query("SELECT id FROM units WHERE course_id = $1", [bible25]))[0].id] });
  assert.equal(clubCopy.assignments, 0, "assignments never go into a club");
  assert.ok(clubCopy.lessons > 0);
});

test("sections: a copied lesson's assignment slides bring their assignment and point at the copy (story 01, D3)", async () => {
  const { createAssignment } = await import("../src/lib/assignments");
  const quiz = await createAssignment(ana, bible25, { title: "Slide quiz", kind: "quiz" });
  const lesson = await createLesson(ana, bible25, "Quiz day", [
    { id: "a1", type: "text", title: "Warm up", body: "" },
    { id: "a2", type: "assignment", title: "old title", assignmentId: quiz.id },
  ] as never);
  assert.equal((lesson.blocks[1] as { title: string }).title, "Slide quiz", "the slide's title comes from the assignment");
  const before = Number((await db.query("SELECT count(*)::int AS n FROM assignments WHERE course_id = $1", [bible26]))[0].n);
  const r = await copyContent(ana, bible25, bible26, { lessons: [lesson.id] });
  assert.equal(r.assignments, 1, "the slide's assignment came along");
  const [copy] = await db.query("SELECT id FROM assignments WHERE course_id = $1 AND title = 'Slide quiz'", [bible26]);
  assert.ok(copy && Number((await db.query("SELECT count(*)::int AS n FROM assignments WHERE course_id = $1", [bible26]))[0].n) === before + 1);
  const [l] = await db.query("SELECT blocks FROM lessons WHERE course_id = $1 AND title = 'Quiz day'", [bible26]);
  const blocks = typeof l.blocks === "string" ? JSON.parse(l.blocks) : l.blocks;
  assert.deepEqual(blocks.map((b: { type: string }) => b.type), ["text", "assignment"]);
  assert.equal(blocks[1].assignmentId, String(copy.id), "points at this class's copy, never last year's");

  // Into a club: no assignments go, so the slide is dropped rather than left pointing at the old class.
  const [club] = await db.query("INSERT INTO courses (tenant_id, id_class_id, name, kind) VALUES ($1, 'club-d3', 'Choir', 'club') RETURNING id", [T]);
  await copyContent(ana, bible25, String(club.id), { lessons: [lesson.id] });
  {
    const [cl] = await db.query("SELECT blocks FROM lessons WHERE course_id = $1 AND title = 'Quiz day'", [club.id]);
    const cb = typeof cl.blocks === "string" ? JSON.parse(cl.blocks) : cl.blocks;
    assert.deepEqual(cb.map((b: { type: string }) => b.type), ["text"]);
  }
});
