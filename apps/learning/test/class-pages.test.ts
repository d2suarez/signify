import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import crypto from "node:crypto";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses, courseFor, setCoursePicture, type CourseRole } from "../src/lib/courses";
import { memoryStore, useFileStore, saveFile, canOpen } from "../src/lib/files";
import { createLesson } from "../src/lib/lessons";
import { createAssignment, archiveAssignment } from "../src/lib/assignments";
import { createResource } from "../src/lib/resources";
import { pickedBlocks } from "../src/lib/present-picked";
import { createKindsFor, asCreateKind, MATERIAL_BLOCKS } from "../src/lib/create-kinds";
import { startingGroups } from "../src/lib/groups";
import { newBlock } from "../src/lib/blocks";

// Desmond's class-page feedback (2026-11-23): the class picture, the Create
// menu's kinds, "Present ticked" from the class page, groups made inside an
// assignment.

let db: Db;
let bio: string, chem: string, bioB: string;
const T = { tenantId: "school-a", userId: "teacher-1", role: "teacher" as const };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("a class picture")]);
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF");
const roles = (map: Record<string, CourseRole>) => async (c: string) => map[c] ?? null;

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
  useFileStore(memoryStore());
  process.env.BACKUP_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  const cs = await myCourses("school-a", [{ id: "k1", name: "Biology", role: "teacher" }, { id: "k2", name: "Chemistry", role: "teacher" }]);
  bio = cs.find((c) => c.name === "Biology")!.id;
  chem = cs.find((c) => c.name === "Chemistry")!.id;
  bioB = (await myCourses("school-b", [{ id: "k1", name: "Biology B", role: "teacher" }]))[0].id;
});
after(() => { delete process.env.BACKUP_ENCRYPTION_KEY; useFileStore(undefined as never); db.close(); });

test("class picture: only a picture uploaded to the same class is kept; null takes it away", async () => {
  const pic = await saveFile(T, bio, "class.png", PNG);
  const pdf = await saveFile(T, bio, "notes.pdf", PDF);
  const other = await saveFile(T, chem, "chem.png", PNG);
  assert.equal(await setCoursePicture("school-a", bio, pdf.id), false, "not a picture");
  assert.equal(await setCoursePicture("school-a", bio, other.id), false, "another class's file");
  assert.equal(await setCoursePicture("school-b", bioB, pic.id), false, "another school");
  assert.equal(await setCoursePicture("school-a", bio, "not-an-id"), false);
  assert.equal((await courseFor("school-a", bio, [{ id: "k1", name: "Biology", role: "teacher" }]))!.pictureFileId, null);
  assert.equal(await setCoursePicture("school-a", bio, pic.id), true);
  assert.equal((await courseFor("school-a", bio, [{ id: "k1", name: "Biology", role: "teacher" }]))!.pictureFileId, pic.id);
  assert.equal(await setCoursePicture("school-a", bio, null), true);
  assert.equal((await courseFor("school-a", bio, [{ id: "k1", name: "Biology", role: "teacher" }]))!.pictureFileId, null);
});

test("class picture: anyone in the class may open it; nobody else", async () => {
  const pic = await saveFile(T, bio, "class2.png", PNG);
  const file = { id: pic.id, courseId: bio };
  assert.ok(!(await canOpen("school-a", file, roles({ [bio]: "student" }))), "not the picture yet");
  await setCoursePicture("school-a", bio, pic.id);
  assert.ok(await canOpen("school-a", file, roles({ [bio]: "student" })));
  assert.ok(await canOpen("school-a", file, roles({ [bio]: "teacher" })));
  assert.ok(!(await canOpen("school-a", file, roles({ [chem]: "student" }))), "another class");
  assert.ok(!(await canOpen("school-a", file, roles({}))), "not in the class");
  assert.ok(!(await canOpen("school-b", file, roles({ [bio]: "student" }))), "another school asking");
  await setCoursePicture("school-a", bio, null);
  assert.ok(!(await canOpen("school-a", file, roles({ [bio]: "student" }))), "taken away");
});

test("create menu: a club makes no academic work; outside tools only when the school has some", () => {
  const all = createKindsFor({ club: false, tools: true });
  assert.deepEqual(all, ["folder", "page", "assignment", "assessment", "upload", "link", "board", "text", "classtool", "poll", "lti"]);
  assert.ok(!createKindsFor({ club: false, tools: false }).includes("lti"));
  const club = createKindsFor({ club: true, tools: true });
  for (const k of ["assignment", "assessment", "lti"] as const) assert.ok(!club.includes(k), k);
  assert.ok(club.includes("folder") && club.includes("page") && club.includes("upload"));
  assert.equal(asCreateKind("folder"), "folder");
  assert.equal(asCreateKind("unit"), null);
  assert.equal(asCreateKind(undefined), null);
  for (const types of Object.values(MATERIAL_BLOCKS)) for (const t of types!) assert.ok(newBlock(t).type === t);
});

test("present ticked: pages, materials and assignments in the ticked order, only this class's, fresh ids", async () => {
  const p1 = await createLesson(T, bio, "Cells", [newBlock("text"), newBlock("timer")]);
  const p2 = await createLesson(T, bio, "Mitosis", [newBlock("text")]);
  const elsewhere = await createLesson(T, chem, "Atoms", [newBlock("text")]);
  const link = { ...newBlock("link"), url: "https://example.org/cells" } as ReturnType<typeof newBlock>;
  const mat = await createResource(T, bio, { block: link, title: "Cell video" });
  const a = await createAssignment(T, bio, { title: "Lab report" });
  const gone = await createAssignment(T, bio, { title: "Old" });
  await archiveAssignment(T, gone.id);
  const out = await pickedBlocks(T, bio, [`assignment:${a.id}`, `lesson:${p1.id}`, `resource:${mat.id}`, `lesson:${elsewhere.id}`, `assignment:${gone.id}`, "nonsense", `lesson:${p1.id}`]);
  assert.deepEqual(out.blocks.map((b) => b.type), ["assignment", "text", "timer", "link"]);
  assert.equal(out.onlyLesson, null);
  assert.ok(!out.blocks.some((b) => p1.blocks.some((x) => x.id === b.id)), "fresh ids");
  assert.equal((await pickedBlocks(T, bio, [`lesson:${p2.id}`])).onlyLesson, p2.id, "one page alone is presented as itself");
  assert.equal((await pickedBlocks(T, bio, [`lesson:${elsewhere.id}`])).blocks.length, 0);
  assert.equal((await pickedBlocks({ tenantId: "school-b", userId: "x" }, bio, [`lesson:${p1.id}`])).blocks.length, 0, "another school");
});

test("groups from an assignment: random by count or size, or empty to fill by hand", () => {
  const people = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, name: `S${i}` }));
  const byCount = startingGroups(people, "count", 3);
  assert.equal(byCount.length, 3);
  assert.equal(byCount.reduce((n, g) => n + g.members.length, 0), 10);
  const bySize = startingGroups(people, "size", 4);
  assert.equal(bySize.length, 3);
  const hand = startingGroups(people, "hand", 5);
  assert.equal(hand.length, 5);
  assert.ok(hand.every((g) => g.members.length === 0));
  assert.equal(startingGroups(people, "hand", 999).length, 40, "at most 40");
  assert.equal(startingGroups(people, "count", "x").length, 1, "nonsense is one group");
});
