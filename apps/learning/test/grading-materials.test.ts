import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import crypto from "node:crypto";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses, type CourseRole } from "../src/lib/courses";
import { createAssignment, saveAssignment, getAssignment, forStudent } from "../src/lib/assignments";
import { memoryStore, useFileStore, saveFile, canOpen } from "../src/lib/files";
import { createLesson } from "../src/lib/lessons";
import { normalizeBlocks } from "../src/lib/blocks";
import { addMaterial, isGradingFile, listMaterials, MaterialError, removeMaterial } from "../src/lib/grading-materials";
import { copyContent } from "../src/lib/sections";

// Answer keys and grading materials (migration 035, teacher story 01 A11): teacher-only, by every route.

let db: Db;
const T = { tenantId: "school-a", userId: "t1", role: "teacher" as const };
let course = "", copyTo = "", other = "";
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
  useFileStore(memoryStore());
  process.env.BACKUP_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  [course, copyTo, other] = (await myCourses("school-a", [
    { id: "i-1", name: "History", role: "teacher" }, { id: "i-2", name: "History 2", role: "teacher" }, { id: "i-3", name: "Art", role: "teacher" },
  ], "t1")).map((c) => c.id);
});
after(() => { delete process.env.BACKUP_ENCRYPTION_KEY; useFileStore(undefined as never); db.close(); });

const roles = (map: Record<string, CourseRole>) => async (c: string) => map[c] ?? null;

test("grading materials: a file and a link attach; bad ones are refused", async () => {
  const a = await createAssignment(T, course, { title: "Workbook 4" });
  const key = await saveFile(T, course, "key.pdf", PDF);
  const m1 = await addMaterial(T, { id: a.id, courseId: course }, { role: "key", title: "  Key  ", fileId: key.id });
  assert.equal(m1.title, "Key");
  assert.equal(m1.fileName, "key.pdf");
  const m2 = await addMaterial(T, { id: a.id, courseId: course }, { role: "reading", url: "https://example.com/reading" });
  assert.equal(m2.url, "https://example.com/reading");
  const m3 = await addMaterial(T, { id: a.id, courseId: course }, { role: "nonsense", url: "https://example.com/x" });
  assert.equal(m3.role, "key", "an unknown role is a key");
  await assert.rejects(addMaterial(T, { id: a.id, courseId: course }, { url: "javascript:alert(1)" }), MaterialError);
  const elsewhere = await saveFile(T, other, "art.pdf", PDF);
  await assert.rejects(addMaterial(T, { id: a.id, courseId: course }, { fileId: elsewhere.id }), MaterialError, "another class's file");
  assert.deepEqual((await listMaterials(T, a.id)).map((m) => m.role), ["key", "reading", "key"]);
  assert.ok(await removeMaterial(T, a.id, m3.id));
  assert.ok(!(await removeMaterial(T, a.id, m3.id)));
  assert.ok(!(await removeMaterial(T, crypto.randomUUID(), m2.id)), "only from its own assignment");
  assert.equal((await listMaterials(T, a.id)).length, 2);
});

test("grading materials: a key file opens for teachers only, even when it is also in a lesson or the instructions", async () => {
  const a = await createAssignment(T, course, { title: "Workbook 5" });
  const key = await saveFile(T, course, "key5.pdf", PDF);
  const file = { id: key.id, courseId: course };
  // The same file shown to students in a lesson, and in the published instructions.
  await createLesson(T, course, "Lesson", normalizeBlocks([{ type: "file", title: "Key", fileId: key.id, name: key.name, kind: key.kind }]));
  const s = await saveAssignment(T, a.id, { baseVersion: a.version, published: true,
    instructionsDoc: { v: 1, nodes: [{ type: "file", fileId: key.id, name: key.name, kind: "pdf", alt: "" }] } });
  assert.ok(s.ok);
  assert.ok(await canOpen("school-a", file, roles({ [course]: "student" })), "before it's a key, students may open it");
  await addMaterial(T, { id: a.id, courseId: course }, { fileId: key.id });
  assert.ok(await isGradingFile("school-a", key.id));
  assert.ok(!(await canOpen("school-a", file, roles({ [course]: "student" }))), "a student, even though a lesson holds it");
  assert.ok(!(await canOpen("school-a", file, roles({ [course]: "guardian" as CourseRole }))), "a parent");
  assert.ok(!(await canOpen("school-a", file, roles({ [other]: "teacher" }))), "a teacher of an unrelated class");
  assert.ok(!(await canOpen("school-a", file, roles({}), { userId: "s1", reads: () => true })), "an Updates reader");
  assert.ok(await canOpen("school-a", file, roles({ [course]: "teacher" })));
  // Nothing about it is part of the assignment students get.
  const back = await getAssignment(T, a.id);
  assert.ok(!JSON.stringify(forStudent(back!)).includes("grading"), "no grading materials in a student's assignment");
});

test("grading materials: copying the assignment to another class copies them, still teacher-only", async () => {
  const a = await createAssignment(T, course, { title: "Workbook 6" });
  const key = await saveFile(T, course, "key6.pdf", PDF);
  await addMaterial(T, { id: a.id, courseId: course }, { role: "key", title: "Key 6", fileId: key.id });
  await addMaterial(T, { id: a.id, courseId: course }, { role: "guide", url: "https://example.com/guide" });
  await copyContent(T, course, copyTo, { assignments: [a.id] });
  const [c] = await db.query("SELECT id FROM assignments WHERE course_id = $1 AND title = 'Workbook 6'", [copyTo]);
  const copied = await listMaterials(T, String(c.id));
  assert.deepEqual(copied.map((m) => [m.role, m.title || m.url]), [["key", "Key 6"], ["guide", "https://example.com/guide"]]);
  const file = { id: key.id, courseId: course };
  assert.ok(await canOpen("school-a", file, roles({ [copyTo]: "teacher" })), "the copy's teacher");
  assert.ok(!(await canOpen("school-a", file, roles({ [copyTo]: "student" }))), "the copy's student");
  // Removing it from the original leaves the copy's.
  const orig = await listMaterials(T, a.id);
  await removeMaterial(T, a.id, orig[0].id);
  assert.equal((await listMaterials(T, String(c.id))).length, 2);
});

test("grading materials: a file also used where students open it is marked, so the teacher is told", async () => {
  const a = await createAssignment(T, course, { title: "Workbook 6" });
  const shared = await saveFile(T, course, "shared6.pdf", PDF);
  const fresh = await saveFile(T, course, "fresh6.pdf", PDF);
  await createLesson(T, course, "Lesson 6", normalizeBlocks([{ type: "file", title: "Reading", fileId: shared.id, name: shared.name, kind: shared.kind }]));
  const m1 = await addMaterial(T, { id: a.id, courseId: course }, { fileId: shared.id, role: "reading" });
  const m2 = await addMaterial(T, { id: a.id, courseId: course }, { fileId: fresh.id });
  const m3 = await addMaterial(T, { id: a.id, courseId: course }, { url: "https://example.org/key" });
  assert.equal(m1.elsewhere, true, "in a lesson");
  assert.equal(m2.elsewhere, false, "uploaded just for grading");
  assert.equal(m3.elsewhere, false, "a link");
  assert.deepEqual((await listMaterials(T, a.id)).map((m) => m.elsewhere), [true, false, false]);
});
