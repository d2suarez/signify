import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import zlib from "node:zlib";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses } from "../src/lib/courses";
import { createLesson, getLesson } from "../src/lib/lessons";
import { createAssignment } from "../src/lib/assignments";
import { createUnit, listUnits } from "../src/lib/units";
import { feed, type Viewer } from "../src/lib/updates";
import { memoryStore, useFileStore } from "../src/lib/files";
import { readCartridge } from "../src/lib/cartridge";
import { commitImport } from "../src/lib/cc-import";
import { isPublicAddress, fetchPicture } from "../src/lib/import-media";
import {
  itemPlaces, moveItem, moveItemsToUnit, setStudentView, setAssignmentThread, shownLessons, lessonDoc, listImports, undoImport, parseKey, afterClass,
} from "../src/lib/organize";

// ---------- a stored (uncompressed) zip, for small exports ----------
function zip(entries: { name: string; data: string | Buffer }[]): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf8");
    const name = Buffer.from(e.name, "utf8");
    const crc = zlib.crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(raw.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(raw.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, raw); centrals.push(central, name);
    offset += 30 + name.length + raw.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

/** A made-up Schoology-style export: a folder inside a folder, a page with a web picture, an embedded video and a local picture. */
const EXPORT = () => zip([
  { name: "imsmanifest.xml", data: `<?xml version="1.0"?><manifest identifier="m"><organizations><organization identifier="o"><item identifier="root">
    <item identifier="u1"><title>Week 1</title>
      <item identifier="a" identifierref="p1"><title>Intro</title></item>
      <item identifier="sub"><title>Readings</title>
        <item identifier="b" identifierref="p2"><title>Chapter 1</title></item>
      </item>
    </item></item></organization></organizations>
    <resources>
      <resource identifier="p1" type="webcontent" href="pages/intro.html"/>
      <resource identifier="p2" type="webcontent" href="pages/ch1.html"/>
    </resources></manifest>` },
  { name: "pages/intro.html", data: `<h2>Welcome</h2><p>Hello class.</p><img src="https://pics.example.org/seed.png" alt="A seed">
     <img src="https://pics.example.org/notapicture.png" alt="Broken"><h3>Watch</h3><iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>
     <img src="../web_resources/leaf.png" alt="A leaf"><p><a href="../web_resources/notes.pdf">Notes</a></p>` },
  { name: "pages/ch1.html", data: `<p>Read pages 1-10.</p>` },
  { name: "web_resources/leaf.png", data: PNG },
  { name: "web_resources/notes.pdf", data: "%PDF-1.4 notes" },
]);
const fakeWeb = async (url: string) => (url.endsWith("/seed.png") ? PNG : url.endsWith("notapicture.png") ? Buffer.from("<html>login</html>") : null);

let db: Db;
const T = "school-a";
let course = "";
let teacher: Viewer, student: Viewer;
const C = { tenantId: T, userId: "t1" };

before(async () => {
  process.env.BACKUP_ENCRYPTION_KEY = "b".repeat(64);
  useFileStore(memoryStore());
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
  [course] = (await myCourses(T, [{ id: "k-bio", name: "Biology", role: "teacher" }], "t1")).map((c) => c.id);
  const base = { tenantId: T, schoolAdmin: false, canPostSchool: false, childCourses: new Set<string>() };
  teacher = { ...base, userId: "t1", name: "Ms Teach", kind: "staff", courses: new Map([[course, "teacher"]]) };
  student = { ...base, userId: "s1", name: "Sam", kind: "student", courses: new Map([[course, "student"]]) };
});
after(() => { delete process.env.BACKUP_ENCRYPTION_KEY; useFileStore(undefined as never); db.close(); });

test("web pictures: only public addresses are ever fetched", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ["8.8.8.8", "93.184.216.34", "2606:4700::1111"]) assert.equal(isPublicAddress(ip), true, ip);
  // Refused before any connection is made.
  for (const url of ["http://localhost/x.png", "http://127.0.0.1/x.png", "http://[::1]/x.png", "http://169.254.169.254/latest", "file:///etc/passwd", "http://user:pw@example.org/x.png", "http://intranet/x.png"]) {
    assert.equal(await fetchPicture(url), null, url);
  }
});

test("import: folders inside folders can be units of their own", () => {
  const flat = readCartridge(EXPORT());
  assert.deepEqual(flat.units.map((u) => [u.title, u.items.length]), [["Week 1", 2]]);
  const nested = readCartridge(EXPORT(), { nestedUnits: true });
  assert.deepEqual(nested.units.map((u) => [u.title, u.items.map((i) => i.title)]), [["Week 1", ["Intro"]], ["Week 1 › Readings", ["Chapter 1"]]]);
  assert.deepEqual(nested.units.map((u) => [u.name, u.parent]), [[undefined, undefined], ["Readings", 0]]);
});

test("import: kept folders inside folders arrive as real folders (migration 026), and undo removes them all", async () => {
  const [solo] = (await myCourses(T, [{ id: "k-nest", name: "Nested", role: "teacher" }], "t1")).map((c) => c.id);
  const r = await commitImport(C, solo, EXPORT(), "nested.imscc", { keepDates: false, nestedUnits: true, fetcher: fakeWeb });
  const units = await listUnits(C, solo);
  assert.deepEqual(units.map((u) => [u.path, u.depth]), [["Week 1", 0], ["Week 1 › Readings", 1]]);
  const [ch] = await db.query("SELECT unit_id FROM lessons WHERE course_id = $1 AND title = 'Chapter 1'", [solo]);
  assert.equal(ch.unit_id, units[1].id);
  const undone = await undoImport(teacher, solo, r.importId);
  assert.equal(undone?.units, 2, "the inner folder first, then its unit");
  assert.deepEqual(await listUnits(C, solo), []);
});

let importId = "";
let intro = "", ch1 = "";
test("import: pictures (from the export and the web) and linked files come in, in place; videos stay as links that play", async () => {
  const r = await commitImport(C, course, EXPORT(), "week1.imscc", { keepDates: false, studentView: "list", fetcher: fakeWeb });
  importId = r.importId;
  assert.equal(r.media.saved, 3, "seed.png from the web, leaf.png and notes.pdf from the export");
  [intro, ch1] = r.lessonIds;
  const lesson = (await getLesson(C, intro))!;
  assert.deepEqual(lesson.blocks.map((b) => b.type === "file" ? `file:${b.kind}:${b.alt || b.name}` : `${b.type}:${"title" in b ? b.title : ""}`), [
    "text:Welcome", "file:image:A seed", "link:Broken", "link:Watch", "file:image:A leaf", "text:", "file:pdf:notes.pdf",
  ]);
  // Something that isn't a picture stays a link to where it was.
  const broken = lesson.blocks[2];
  assert.ok(broken.type === "link" && broken.url === "https://pics.example.org/notapicture.png");
  assert.equal(lesson.studentView, "list");
  assert.deepEqual((await shownLessons(C, course)).map((l) => l.title), ["Intro", "Chapter 1"]);
});

test("lesson in Updates: words, pictures, the video as a player, files, and the link to open it", () => {
  const doc = lessonDoc({ id: intro, title: "Intro", blocks: [
    { id: "a", type: "text", title: "Welcome", body: "Hello class.\n\nSecond paragraph." },
    { id: "b", type: "link", title: "Watch", url: "https://www.youtube.com/embed/dQw4w9WgXcQ" },
    { id: "c", type: "link", title: "Map", url: "https://example.org/map" },
    { id: "d", type: "file", title: "", fileId: "00000000-0000-4000-8000-000000000001", name: "leaf.png", kind: "image", alt: "A leaf" },
  ] });
  assert.deepEqual(doc.nodes.map((n) => n.type), ["h", "p", "p", "h", "video", "p", "file", "material"]);
  const v = doc.nodes[4];
  assert.ok(v.type === "video" && v.provider === "youtube" && v.id === "dQw4w9WgXcQ");
  const last = doc.nodes.at(-1)!;
  assert.ok(last.type === "material" && last.kind === "lesson" && last.id === intro);
});

test("students see a lesson in Updates only while it is set to; taking it out deletes the post", async () => {
  assert.equal(await setStudentView(teacher, course, [intro], "thread"), 1);
  const places = await itemPlaces(C, course);
  const postId = places.get(`lesson:${intro}`)!.threadPostId!;
  assert.ok(postId);
  const seen = (await feed(student, { courseId: course })).find((p) => p.id === postId)!;
  assert.ok(seen, "the student sees it in the class's Updates");
  assert.ok(seen.doc.nodes.some((n) => n.type === "file" && n.kind === "image"), "with its pictures");
  assert.equal(seen.materials[intro].href, `/lessons/${intro}`, "and can open the lesson");
  // Asking again doesn't post twice.
  await setStudentView(teacher, course, [intro], "thread");
  assert.equal((await db.query("SELECT count(*)::int AS n FROM posts WHERE status = 'visible'"))[0].n, 1);

  await setStudentView(teacher, course, [intro], "hidden");
  assert.equal((await feed(student, { courseId: course })).find((p) => p.id === postId), undefined);
  assert.equal((await itemPlaces(C, course)).get(`lesson:${intro}`)!.threadPostId, null);
  assert.deepEqual((await shownLessons(C, course)).map((l) => l.title), ["Chapter 1"]);
  // Another course's lesson can't be touched from here.
  const [other] = (await myCourses(T, [{ id: "k-art", name: "Art", role: "teacher" }], "t2")).map((c) => c.id);
  const theirs = await createLesson({ tenantId: T, userId: "t2" }, other, "Theirs");
  assert.equal(await setStudentView(teacher, course, [theirs.id], "list"), 0);
});

test("assignments: only published ones go to Updates", async () => {
  const draft = await createAssignment(C, course, { title: "Draft lab" });
  assert.equal(await setAssignmentThread(teacher, course, [draft.id], true), 0);
  await db.query("UPDATE assignments SET published = true WHERE id = $1", [draft.id]);
  assert.equal(await setAssignmentThread(teacher, course, [draft.id], true), 1);
  const post = (await itemPlaces(C, course)).get(`assignment:${draft.id}`)!.threadPostId!;
  assert.ok((await feed(student, { courseId: course })).some((p) => p.id === post));
  assert.equal(await setAssignmentThread(teacher, course, [draft.id], false), 1);
  assert.ok(!(await feed(student, { courseId: course })).some((p) => p.id === post));
});

test("order: arrows swap neighbours in one unit's shared order; moving keeps the order chosen", async () => {
  const [week] = await listUnits(C, course);
  const extra = await createLesson(C, course, "Extra", [], week.id);
  const order = async (unitId: string | null) => (await db.query(
    `SELECT title FROM (SELECT title, unit_id, position, created_at FROM lessons WHERE archived = false AND course_id = $1
       UNION ALL SELECT title, unit_id, position, created_at FROM assignments WHERE archived = false AND course_id = $1) x
      WHERE unit_id IS NOT DISTINCT FROM $2::uuid ORDER BY position NULLS LAST, created_at`, [course, unitId])).map((r) => r.title);
  assert.deepEqual(await order(week.id), ["Intro", "Chapter 1", "Extra"]);
  assert.equal(await moveItem(C, course, `lesson:${extra.id}`, -1), true);
  assert.deepEqual(await order(week.id), ["Intro", "Extra", "Chapter 1"]);
  assert.equal(await moveItem(C, course, `lesson:${intro}`, -1), false, "the first can't go up");
  const two = await createUnit(C, course, "Week 2");
  assert.equal(await moveItemsToUnit(C, course, [`lesson:${ch1}`, `lesson:${intro}`], two.id), 2);
  assert.deepEqual(await order(two.id), ["Chapter 1", "Intro"]);
  assert.deepEqual(await order(week.id), ["Extra"]);
  assert.equal(await moveItemsToUnit(C, course, [`lesson:${extra.id}`], null), 1);
  assert.deepEqual(await order(null), ["Draft lab", "Extra"], "to the end of the items in no unit");
  // Another school's ids, and unit ids from elsewhere, do nothing.
  assert.equal(await moveItemsToUnit({ tenantId: "school-b", userId: "x" }, course, [`lesson:${extra.id}`], two.id), 0);
  assert.equal(await moveItemsToUnit(C, course, [`lesson:${extra.id}`], "00000000-0000-4000-8000-000000000009"), 0);
  assert.equal(parseKey("lesson:'; DROP TABLE lessons; --"), null);
});

test("undo an import: its lessons archived, its posts gone, empty units removed; work students did stays", async () => {
  await setStudentView(teacher, course, [intro], "thread");
  const r2 = await commitImport(C, course, zip([
    { name: "imsmanifest.xml", data: `<manifest><organizations><organization><item identifier="u"><title>Lab week</title>
      <item identifier="i" identifierref="x"><title>Lab</title></item></item></organization></organizations>
      <resources><resource identifier="x" type="assignment_xmlv1p0" href="a.xml"/></resources></manifest>` },
    { name: "a.xml", data: `<assignment><title>Lab</title><text>Do the lab.</text><gradable points_possible="5">true</gradable></assignment>` },
  ]), "lab.imscc", { keepDates: false });
  const [lab] = await db.query("SELECT id FROM assignments WHERE import_id = $1", [r2.importId]);
  await db.query("INSERT INTO submissions (tenant_id, assignment_id, student_id, body) VALUES ($1, $2, 's1', 'my lab')", [T, lab.id]);

  const listed = await listImports(C, course);
  assert.deepEqual(listed.map((i) => i.fileName), ["lab.imscc", "week1.imscc"]);

  const one = await undoImport(teacher, course, importId);
  // Week 1 came from the import and is empty now (Extra moved out), so it goes; Week 2 is the teacher's own.
  assert.deepEqual(one, { lessons: 2, assignments: 0, units: 1, kept: 0 });
  assert.deepEqual((await listUnits(C, course)).map((u) => u.title), ["Week 2"], "(a lone top folder is the export's own wrapper, so Lab came in outside any unit)");
  assert.equal((await db.query("SELECT count(*)::int AS n FROM posts WHERE status = 'visible' AND title = 'Intro'"))[0].n, 0, "its post is gone");
  const two = await undoImport(teacher, course, r2.importId);
  assert.deepEqual(two, { lessons: 0, assignments: 0, units: 0, kept: 1 }, "an assignment with a student's work stays, and so does its unit");
  assert.equal(await undoImport({ ...teacher, tenantId: "school-b" }, course, r2.importId), null);
});

test("after class (story 01, E1): ending a presentation leaves the slides open unless the teacher said otherwise", async () => {
  const { createLesson, getLesson } = await import("../src/lib/lessons");
  const view = async (id: string) => { const l = await getLesson(C, id); return [l?.studentView, l?.studentViewByHand]; };

  const a = await createLesson(C, course, "Monday slides");
  assert.deepEqual(await view(a.id), ["hidden", false]);
  assert.equal(await afterClass(teacher, course, a.id, true), "list", "nobody chose: students keep the slides");
  assert.deepEqual(await view(a.id), ["list", false], "shown by default, not by hand");
  assert.ok((await shownLessons(C, course)).some((l) => l.id === a.id));

  const b = await createLesson(C, course, "Tuesday slides");
  assert.equal(await afterClass(teacher, course, b.id, false), "hidden", "switched off");
  assert.deepEqual(await view(b.id), ["hidden", true], "and that is the teacher's choice next time");
  assert.equal(await afterClass(teacher, course, b.id, true), "list", "switched on again later");
  assert.deepEqual(await view(b.id), ["list", true]);

  const c = await createLesson(C, course, "Wednesday slides");
  await setStudentView(teacher, course, [c.id], "thread");
  assert.equal(await afterClass(teacher, course, c.id, true), "thread", "a view set by hand is left alone");
  assert.equal(await afterClass(teacher, course, c.id, false), "hidden", "turning it off hides it");
  assert.equal(await afterClass({ ...teacher, tenantId: "school-b" }, course, a.id, true), null, "another school can't");
});
