import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import crypto from "node:crypto";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses, type CourseRole } from "../src/lib/courses";
import { createAssignment, saveAssignment, getAssignment, forStudent } from "../src/lib/assignments";
import { memoryStore, useFileStore, saveFile, canOpen } from "../src/lib/files";
import { assignmentDoc } from "../src/lib/organize";
import { copyContent } from "../src/lib/sections";

// Rich instructions on assignments (migration 028, teacher story 01 step A12).

let db: Db;
const T = { tenantId: "school-a", userId: "t1", role: "teacher" as const };
const B = { tenantId: "school-b", userId: "t9", role: "teacher" as const };
let course = "", copyTo = "", otherSchool = "";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("a picture")]);

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
  useFileStore(memoryStore());
  process.env.BACKUP_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  [course, copyTo] = (await myCourses("school-a", [{ id: "i-1", name: "History", role: "teacher" }, { id: "i-2", name: "History 2", role: "teacher" }], "t1")).map((c) => c.id);
  otherSchool = (await myCourses("school-b", [{ id: "i-9", name: "Other", role: "teacher" }], "t9"))[0].id;
});
after(() => { delete process.env.BACKUP_ENCRYPTION_KEY; useFileStore(undefined as never); db.close(); });

const roles = (map: Record<string, CourseRole>) => async (c: string) => map[c] ?? null;

test("instructions: plain text still saves and reads as before, with no document", async () => {
  const a = await createAssignment(T, course, { title: "Essay" });
  const r = await saveAssignment(T, a.id, { baseVersion: a.version, instructions: "Read chapter 3.\n\nAnswer the questions." });
  assert.ok(r.ok);
  assert.equal(r.assignment.instructions, "Read chapter 3.\n\nAnswer the questions.");
  assert.equal(r.assignment.instructionsDoc, null);
  // Updates' post of it: one paragraph per block, then the link.
  const doc = assignmentDoc(r.assignment);
  assert.deepEqual(doc.nodes.map((n) => n.type), ["p", "p", "material"]);
});

test("instructions: a document is cleaned, its words kept as the text, and saved with history", async () => {
  const a = await createAssignment(T, course, { title: "Map work" });
  const pic = await saveFile(T, course, "map.png", PNG);
  const foreign = await saveFile(B, otherSchool, "theirs.png", PNG);
  const r = await saveAssignment(T, a.id, {
    baseVersion: a.version,
    instructionsDoc: {
      v: 1, nodes: [
        { type: "h", content: [{ text: "Before you start" }] },
        { type: "p", content: [{ text: "Label ", b: true }, { text: "every river", href: "javascript:alert(1)" }] },
        { type: "file", fileId: pic.id, name: "map.png", kind: "image", alt: "A blank map" },
        { type: "file", fileId: foreign.id, name: "theirs.png", kind: "image", alt: "" },
        { type: "video", provider: "youtube", id: "dQw4w9WgXcQ" },
        { type: "material", kind: "lesson", id: crypto.randomUUID(), title: "Somewhere else" },
        { type: "script", html: "<b>no</b>" },
      ],
    },
  });
  assert.ok(r.ok && r.changed);
  const doc = r.assignment.instructionsDoc!;
  assert.deepEqual(doc.nodes.map((n) => n.type), ["h", "p", "file", "video"], "another school's file, Learning links and unknown shapes dropped");
  assert.ok(doc.nodes[1].type === "p" && !doc.nodes[1].content.some((x) => x.href), "a javascript: link is not a link");
  assert.match(r.assignment.instructions, /Before you start/);
  assert.match(r.assignment.instructions, /youtu\.be\/dQw4w9WgXcQ/);
  // Read back the same; a student sees the same document.
  const back = await getAssignment(T, a.id);
  assert.deepEqual(back?.instructionsDoc, doc);
  assert.deepEqual(forStudent(back!).instructionsDoc, doc);
  const [v] = await db.query("SELECT count(*)::int AS n FROM assignment_versions WHERE assignment_id = $1", [a.id]);
  assert.equal(v.n, 1, "the earlier state is kept");
  // The same document again changes nothing.
  const same = await saveAssignment(T, a.id, { baseVersion: r.assignment.version, instructionsDoc: doc });
  assert.ok(same.ok && !same.changed);
  // Saving plain text afterwards goes back to plain text.
  const plain = await saveAssignment(T, a.id, { baseVersion: r.assignment.version, instructions: "Just text" });
  assert.ok(plain.ok && plain.assignment.instructionsDoc === null && plain.assignment.instructions === "Just text");
  // An empty document is no instructions.
  const empty = await saveAssignment(T, a.id, { baseVersion: plain.assignment.version, instructionsDoc: { v: 1, nodes: [] } });
  assert.ok(empty.ok && empty.assignment.instructions === "" && empty.assignment.instructionsDoc === null);
});

test("instructions: a picture in them opens for the class's students once the assignment is published", async () => {
  const a = await createAssignment(T, course, { title: "Picture work" });
  const f = await saveFile(T, course, "diagram.png", PNG);
  const file = { id: f.id, courseId: course };
  const doc = { v: 1, nodes: [{ type: "file", fileId: f.id, name: "diagram.png", kind: "image", alt: "" }] };
  const r = await saveAssignment(T, a.id, { baseVersion: a.version, instructionsDoc: doc });
  assert.ok(r.ok);
  assert.ok(!(await canOpen("school-a", file, roles({ [course]: "student" }))), "a draft's picture stays closed");
  assert.ok(await canOpen("school-a", file, roles({ [course]: "teacher" })));
  const p = await saveAssignment(T, a.id, { baseVersion: r.assignment.version, published: true });
  assert.ok(p.ok);
  assert.ok(await canOpen("school-a", file, roles({ [course]: "student" })), "published");
  assert.ok(!(await canOpen("school-a", file, roles({ [copyTo]: "student" }))), "another class's student");
  assert.ok(!(await canOpen("school-b", file, roles({ [course]: "student" }))), "another school");

  // Updates' post of it keeps the document, then links the assignment.
  const posted = assignmentDoc(p.assignment);
  assert.deepEqual(posted.nodes.map((n) => n.type), ["file", "material"]);

  // A copy to another class keeps the document (as a draft); its picture opens there once published.
  await copyContent(T, course, copyTo, { assignments: [a.id] });
  const [c] = await db.query("SELECT id, instructions_doc, published FROM assignments WHERE course_id = $1 AND title = 'Picture work'", [copyTo]);
  assert.equal(c.published, false);
  assert.equal((typeof c.instructions_doc === "string" ? JSON.parse(c.instructions_doc) : c.instructions_doc).nodes[0].fileId, f.id);
  assert.ok(!(await canOpen("school-a", file, roles({ [copyTo]: "student" }))), "the copy is a draft");
  const copied = await getAssignment(T, String(c.id));
  await saveAssignment(T, String(c.id), { baseVersion: copied!.version, published: true });
  assert.ok(await canOpen("school-a", file, roles({ [copyTo]: "student" })), "the copy, published");
});
