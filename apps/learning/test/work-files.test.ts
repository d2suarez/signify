import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import crypto from "node:crypto";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses, type CourseRole } from "../src/lib/courses";
import { createAssignment, saveAssignment, saveDraft, setHandedIn, listSubmissions, getAssignment, type Assignment } from "../src/lib/assignments";
import { createGroupSet } from "../src/lib/group-sets";
import { claimSubmitter, groupHandIn } from "../src/lib/group-work";
import { memoryStore, useFileStore, getFile, fileBytes, MAX_FILE } from "../src/lib/files";
import {
  addWorkFile, removeWorkFile, reorderWorkFiles, myFiles, getWorkFile, canOpenWork, filesForStudents, takesFiles, takesText, WorkFileError,
} from "../src/lib/work-files";
import { photosPdf, jpegInfo } from "../src/lib/photo-pdf";
import { workZip } from "../src/lib/work-zip";
import { Zip } from "../src/lib/zip";
import { dict } from "../src/lib/i18n";

// Student file hand-in (story 01, A7): photos, PDFs and Office files, handed in like writing, opened only by the right people.

let db: Db;
const store = memoryStore();
const T = { tenantId: "school-a", userId: "t1" };
const as = (id: string) => ({ tenantId: "school-a", userId: id });
let course = "", other = "", setId = "";
const roster = new Map([["s1", "Ana"], ["s2", "Ben"], ["s3", "Cy"], ["s4", "Dee"], ["s5", "Eli"]]);

/** A JPEG header with a real SOF0 (so the PDF knows its size); the rest is filler. */
const jpeg = (w: number, h: number, fill = "x") => Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1"),
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
  Buffer.from(fill.repeat(50)), Buffer.from([0xff, 0xd9]),
]);
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF");
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("[Content_Types].xml word/document.xml")]);

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
  useFileStore(store);
  process.env.BACKUP_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  [course, other] = (await myCourses("school-a", [{ id: "c-1", name: "AP Micro", role: "teacher" }, { id: "c-2", name: "Art", role: "teacher" }], "t1")).map((c) => c.id);
  setId = (await createGroupSet(T, course, { name: "Pairs", groups: [{ id: "gA", name: "A", members: ["s1", "s2"] }, { id: "gB", name: "B", members: ["s3", "s4"] }] }, roster)).id;
});
after(() => { delete process.env.BACKUP_ENCRYPTION_KEY; useFileStore(undefined as never); db.close(); });

async function make(input: Record<string, unknown>, where = course): Promise<Assignment> {
  const a = await createAssignment(T, where, { title: "Workbook" });
  const r = await saveAssignment(T, a.id, { baseVersion: a.version, published: true, handIn: "files", ...input });
  assert.ok(r.ok);
  return r.ok ? r.assignment : a;
}

const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { if (e instanceof WorkFileError) return e.code; throw e; } };

test("hand-in setting: text by default, files or both, anything else is text; copied into versions", async () => {
  const a = await createAssignment(T, course, { title: "x" });
  assert.equal(a.handIn, "text");
  assert.ok(!takesFiles(a) && takesText(a));
  let r = await saveAssignment(T, a.id, { baseVersion: 1, handIn: "both" });
  assert.ok(r.ok && r.assignment.handIn === "both" && takesFiles(r.assignment) && takesText(r.assignment));
  r = await saveAssignment(T, a.id, { baseVersion: 2, handIn: "files" });
  assert.ok(r.ok && !takesText(r.assignment));
  r = await saveAssignment(T, a.id, { baseVersion: 3, handIn: "<script>" });
  assert.ok(r.ok && r.assignment.handIn === "text");
  const v = await db.query("SELECT snapshot FROM assignment_versions WHERE assignment_id = $1 AND version = 3", [a.id]);
  assert.equal((v[0].snapshot as { handIn: string }).handIn, "files", "the previous setting is kept with the version");
  const paper = await saveAssignment(T, a.id, { baseVersion: 4, kind: "offline", handIn: "files" });
  assert.ok(paper.ok && !takesFiles(paper.assignment), "paper work never takes files");
});

test("upload: pictures, PDFs and Office only, checked by their bytes, sealed in the store", async () => {
  const a = await make({});
  const s1 = as("s1");
  const photo = await addWorkFile(s1, a, "page 1.jpg", jpeg(1200, 1600));
  assert.equal(photo.kind, "image");
  assert.equal((await addWorkFile(s1, a, "worksheet.pdf", PDF)).kind, "pdf");
  assert.equal((await addWorkFile(s1, a, "essay.docx", DOCX)).kind, "doc");
  assert.equal(await code(addWorkFile(s1, a, "notes.txt", Buffer.from("hello"))), "type", "text files aren't hand-ins here");
  assert.equal(await code(addWorkFile(s1, a, "song.mp3", Buffer.from("ID3abc"))), "type");
  assert.equal(await code(addWorkFile(s1, a, "x.svg", Buffer.from("<svg onload=alert(1)>"))), "type");
  assert.equal(await code(addWorkFile(s1, a, "fake.jpg", PDF)), "type", "the bytes must match the name");
  assert.equal(await code(addWorkFile(s1, a, "macro.docx", Buffer.concat([DOCX, Buffer.from("vbaProject.bin")]))), "type");
  assert.equal(await code(addWorkFile(s1, a, "empty.pdf", Buffer.alloc(0))), "empty");
  assert.equal(await code(addWorkFile(s1, a, "huge.pdf", Buffer.concat([PDF, Buffer.alloc(MAX_FILE)]))), "too-large");
  // Stored encrypted, never as it was sent.
  const stored = (await getWorkFile("school-a", photo.id))!;
  const sealed = store.objects.get(stored.storageKey)!;
  assert.ok(stored.storageKey.startsWith("work/school-a/"));
  assert.ok(!sealed.includes(Buffer.from("JFIF")), "sealed");
  assert.ok((await fileBytes(stored))!.equals(jpeg(1200, 1600)));
  // A text-only or unpublished assignment takes no files.
  const textOnly = await make({ handIn: "text" });
  assert.equal(await code(addWorkFile(s1, textOnly, "p.jpg", jpeg(10, 10))), "missing");
  const draft = await createAssignment(T, course, { title: "Draft" });
  const d2 = await saveAssignment(T, draft.id, { baseVersion: 1, handIn: "files" });
  assert.ok(d2.ok);
  assert.equal(await code(addWorkFile(s1, d2.ok ? d2.assignment : draft, "p.jpg", jpeg(10, 10))), "missing");
});

test("a student's files are never a class file: /files/[id] can't find them", async () => {
  const a = await make({});
  const f = await addWorkFile(as("s5"), a, "p.jpg", jpeg(10, 10));
  assert.equal(await getFile("school-a", f.id), null);
  assert.equal(await getWorkFile("school-b", f.id), null, "another school never finds it");
});

test("order, remove, hand in, take back: like writing, and every hand-in's list is kept", async () => {
  const a = await make({ handIn: "both" });
  const s = as("s5");
  const p1 = await addWorkFile(s, a, "p1.jpg", jpeg(10, 10, "1"));
  const p2 = await addWorkFile(s, a, "p2.jpg", jpeg(10, 10, "2"));
  const p3 = await addWorkFile(s, a, "p3.jpg", jpeg(10, 10, "3"));
  let list = await reorderWorkFiles(s, a, [p3.id, p1.id, "not-mine", p3.id]);
  assert.deepEqual(list.map((f) => f.name), ["p3.jpg", "p1.jpg", "p2.jpg"], "named first, the rest after; junk ignored");
  list = await removeWorkFile(s, a, p2.id);
  assert.deepEqual(list.map((f) => f.name), ["p3.jpg", "p1.jpg"]);
  // Another student can't touch them.
  assert.equal(await code(removeWorkFile(as("s1"), a, p1.id)), "missing");
  assert.equal((await myFiles(as("s1"), a)).files.length, 0, "and doesn't see them");
  // Files only, no text: the first save makes the row, then hand in.
  const first = await saveDraft(s, a, { baseVersion: 0, body: "" });
  assert.ok(first.ok);
  const handed = await setHandedIn(s, a, true, first.ok ? first.submission.version : 0);
  assert.ok(handed.ok);
  assert.deepEqual(handed.ok && handed.submission.files?.map((f) => f.name), ["p3.jpg", "p1.jpg"]);
  assert.ok((await myFiles(s, a)).locked);
  assert.equal(await code(addWorkFile(s, a, "late.jpg", jpeg(10, 10))), "handed-in");
  assert.equal(await code(removeWorkFile(s, a, p1.id)), "handed-in");
  assert.equal(await code(reorderWorkFiles(s, a, [p1.id])), "handed-in");
  // Take back, change, hand in again: the first list is still recorded.
  const back = await setHandedIn(s, a, false, handed.ok ? handed.submission.version : 0);
  assert.ok(back.ok);
  await removeWorkFile(s, a, p3.id);
  const again = await setHandedIn(s, a, true, back.ok ? back.submission.version : 0);
  assert.deepEqual(again.ok && again.submission.files?.map((f) => f.name), ["p1.jpg"]);
  const log = await db.query("SELECT h.files FROM work_file_hand_ins h JOIN submissions s ON s.id = h.submission_id WHERE s.assignment_id = $1 ORDER BY h.handed_in_at", [a.id]);
  assert.deepEqual(log.map((r) => (r.files as { name: string }[]).map((f) => f.name)), [["p3.jpg", "p1.jpg"], ["p1.jpg"]]);
  // The removed file still opens for the teacher (an old hand-in holds it).
  assert.ok(await getWorkFile("school-a", p3.id));
});

test("who may open a student's file: the student, the class's teachers, school admins. Never classmates, parents or other classes", async () => {
  const a = await make({});
  const f = await addWorkFile(as("s1"), a, "p.jpg", jpeg(10, 10));
  const file = (await getWorkFile("school-a", f.id))!;
  const ask = (userId: string, role: CourseRole | null, admin = false) => canOpenWork(as(userId), file, {
    admin, roleIn: async (c) => (c === course ? role : null), assignment: (id) => getAssignment(as(userId), id),
  });
  assert.equal(await ask("s1", "student"), true, "its own student");
  assert.equal(await ask("t1", "teacher"), true, "a teacher of the class");
  assert.equal(await ask("admin-1", null, true), true, "a school admin");
  assert.equal(await ask("s3", "student"), false, "a classmate");
  assert.equal(await ask("p1", null), false, "a parent (no class role)");
  assert.equal(await ask("s1", null), false, "the student once they have left the class");
  assert.equal(await ask("t9", null), false, "a teacher of another class");
});

test("group, one hands in: the files are the group's, opened by its members only; hand-in covers every member", async () => {
  const a = await make({ groupSetId: setId, groupHandIn: "one" });
  const f = await addWorkFile(as("s1"), a, "group page.jpg", jpeg(10, 10));
  assert.deepEqual((await myFiles(as("s2"), a)).files.map((x) => x.id), [f.id], "Ben sees the group's file");
  assert.equal((await myFiles(as("s3"), a)).files.length, 0, "the other group doesn't");
  const file = (await getWorkFile("school-a", f.id))!;
  const ask = (userId: string) => canOpenWork(as(userId), file, { admin: false, roleIn: async () => "student", assignment: (id) => getAssignment(as(userId), id) });
  assert.equal(await ask("s2"), true);
  assert.equal(await ask("s3"), false);
  assert.equal(await ask("s5"), false, "a student in no group");
  await claimSubmitter(as("s2"), a);
  const r = await groupHandIn(as("s2"), a, true);
  assert.ok(r.ok);
  const subs = await listSubmissions(T, a.id);
  for (const id of ["s1", "s2"]) assert.deepEqual(subs.find((s) => s.studentId === id)?.files?.map((x) => x.id), [f.id]);
  assert.ok((await myFiles(as("s1"), a)).locked, "locked for every member");
  // Moved out of the group: no longer theirs to open.
  await db.query("UPDATE group_sets SET groups = $2::jsonb WHERE id = $1", [setId, JSON.stringify([{ id: "gA", name: "A", members: [{ id: "s2", name: "Ben" }] }, { id: "gB", name: "B", members: [{ id: "s1", name: "Ana" }, { id: "s3", name: "Cy" }] }])]);
  assert.equal(await ask("s1"), false);
  await db.query("UPDATE group_sets SET groups = $2::jsonb WHERE id = $1", [setId, JSON.stringify([{ id: "gA", name: "A", members: [{ id: "s1", name: "Ana" }, { id: "s2", name: "Ben" }] }, { id: "gB", name: "B", members: [{ id: "s3", name: "Cy" }, { id: "s4", name: "Dee" }] }])]);
});

test("group, each hands in: every member's files are their own", async () => {
  const a = await make({ groupSetId: setId, groupHandIn: "each" });
  const f = await addWorkFile(as("s1"), a, "mine.jpg", jpeg(10, 10));
  assert.equal((await myFiles(as("s2"), a)).files.length, 0);
  const file = (await getWorkFile("school-a", f.id))!;
  assert.equal(await canOpenWork(as("s2"), file, { admin: false, roleIn: async () => "student", assignment: (id) => getAssignment(as("s2"), id) }), false);
  const r = await groupHandIn(as("s1"), a, true);
  assert.ok(r.ok);
  assert.deepEqual((await listSubmissions(T, a.id)).find((s) => s.studentId === "s1")?.files?.map((x) => x.id), [f.id]);
  assert.ok(!(await myFiles(as("s2"), a)).locked, "Ben hasn't handed in");
});

test("grading desk: what was handed in, else the list so far", async () => {
  const a = await make({});
  const f1 = await addWorkFile(as("s5"), a, "a.jpg", jpeg(10, 10));
  const sub = await saveDraft(as("s5"), a, { baseVersion: 0, body: "" });
  await setHandedIn(as("s5"), a, true, sub.ok ? sub.submission.version : 0);
  await addWorkFile(as("s3"), a, "so far.pdf", PDF);
  const subs = new Map((await listSubmissions(T, a.id)).map((s) => [s.studentId, s]));
  const by = await filesForStudents(T, a, ["s5", "s3", "s4"], subs);
  assert.deepEqual(by.get("s5")?.map((f) => f.id), [f1.id]);
  assert.deepEqual(by.get("s3")?.map((f) => f.name), ["so far.pdf"]);
  assert.equal(by.has("s4"), false);
  void other;
});

test("photos as one PDF: a page per photo in order, unknown kinds left out", () => {
  assert.deepEqual(jpegInfo(jpeg(1200, 1600)), { w: 1200, h: 1600, colors: 3 });
  const gif = Buffer.from("GIF89a....");
  const pdf = photosPdf([jpeg(1200, 1600, "a"), gif, jpeg(1600, 1200, "b")], "Workbook - Ana");
  assert.equal(pdf.pages, 2);
  assert.equal(pdf.skipped, 1);
  const text = pdf.bytes.toString("latin1");
  assert.ok(text.startsWith("%PDF-1.4"));
  assert.ok(text.trimEnd().endsWith("%%EOF"));
  assert.ok(text.includes("/MediaBox [0 0 612 792]") && text.includes("/MediaBox [0 0 792 612]"), "portrait and landscape pages");
  assert.ok(text.indexOf("a".repeat(50)) < text.indexOf("b".repeat(50)), "in the student's order");
  // The cross-reference table points at each object.
  const start = Number(/startxref\n(\d+)/.exec(text)![1]);
  assert.ok(text.slice(start).startsWith("xref"));
  for (const m of text.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)) assert.match(text.slice(Number(m[1]), Number(m[1]) + 12), /^\d+ 0 obj/);
});

test("zip: files in a folder per student, numbered in order, with the photos as one PDF", () => {
  const d = dict("en");
  const subs = new Map([["s1", { assignmentId: "a", studentId: "s1", body: "", version: 2, submittedAt: "2026-11-23T10:00:00Z", updatedAt: "2026-11-23T10:00:00Z" }]]);
  const zip = workZip({
    title: "Workbook 3", students: [{ id: "s1", name: "Ana López" }, { id: "s2", name: "Ben" }], subs, groups: null, work: new Map(), mode: "each",
    late: () => false, when: new Date("2026-11-23T12:00:00Z"), d,
    files: new Map([["s1", [
      { name: "IMG_2.jpg", kind: "image", data: jpeg(10, 10, "2") }, { name: "IMG_1.jpg", kind: "image", data: jpeg(10, 10, "1") },
      { name: "notes.docx", kind: "doc", data: DOCX },
    ]]]),
  });
  const z = new Zip(zip.bytes);
  const names = [...z.entries.keys()];
  assert.ok(names.includes("Ana López/01 IMG_2.jpg") && names.includes("Ana López/02 IMG_1.jpg") && names.includes("Ana López/03 notes.docx"), names.join(", "));
  assert.ok(names.includes(`Ana López/Ana López - ${d.wfOnePdf}.pdf`));
  assert.ok(!names.some((n) => n.startsWith("Ben")), "nothing for a student with nothing");
  assert.ok(z.read("Ana López/01 IMG_2.jpg")!.equals(jpeg(10, 10, "2")));
  assert.match(z.text(`_${d.zipIndex}.txt`)!, /Ana López: Handed in .* · 3 files/);
});
