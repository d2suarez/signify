import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses } from "../src/lib/courses";
import { createLesson, saveLesson } from "../src/lib/lessons";
import { normalizeBlocks } from "../src/lib/blocks";
import { createResource, updateResource } from "../src/lib/resources";
import {
  sniffFile, cleanName, sealFile, openFile, memoryStore, r2Store, useFileStore, saveFile, getFile, fileBytes, canOpen, FileError, MAX_FILE,
} from "../src/lib/files";
import type { CourseRole } from "../src/lib/courses";

let db: Db;
let bio: string, chem: string, bioB: string;
const store = memoryStore();
const T = { tenantId: "school-a", userId: "teacher-1", role: "teacher" as const };
const S = { tenantId: "school-a", userId: "student-1", role: "student" as const };
const KEY = crypto.randomBytes(32);

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest of a picture")]);
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF");
const zip = (...parts: string[]) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(parts.join("\0"))]);

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
  useFileStore(store);
  process.env.BACKUP_ENCRYPTION_KEY = KEY.toString("hex");
  const cs = await myCourses("school-a", [{ id: "f1", name: "Biology", role: "teacher" }, { id: "f2", name: "Chemistry", role: "teacher" }]);
  bio = cs.find((c) => c.name === "Biology")!.id;
  chem = cs.find((c) => c.name === "Chemistry")!.id;
  bioB = (await myCourses("school-b", [{ id: "f1", name: "Biology B", role: "teacher" }]))[0].id;
});
after(() => { delete process.env.BACKUP_ENCRYPTION_KEY; useFileStore(undefined as never); db.close(); });

// ---------- what a file is ----------

test("files: each allowed kind is recognised by its bytes AND its extension", () => {
  assert.deepEqual(sniffFile("cell.png", PNG), { contentType: "image/png", kind: "image" });
  assert.equal(sniffFile("p.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]))?.kind, "image");
  assert.equal(sniffFile("a.gif", Buffer.from("GIF89a...."))?.contentType, "image/gif");
  assert.equal(sniffFile("a.webp", Buffer.from("RIFF\0\0\0\0WEBPVP8 "))?.contentType, "image/webp");
  assert.equal(sniffFile("notes.pdf", PDF)?.kind, "pdf");
  assert.equal(sniffFile("lab.docx", zip("[Content_Types].xml", "word/document.xml"))?.kind, "doc");
  assert.equal(sniffFile("deck.PPTX", zip("[Content_Types].xml"))?.contentType, "application/vnd.openxmlformats-officedocument.presentationml.presentation");
  assert.equal(sniffFile("song.mp3", Buffer.from("ID3\x04\0\0"))?.kind, "audio");
  assert.equal(sniffFile("clip.mp4", Buffer.from("\0\0\0\x18ftypmp42"))?.kind, "video");
  assert.equal(sniffFile("clip.m4a", Buffer.from("\0\0\0\x18ftypM4A "))?.contentType, "audio/mp4");
  assert.equal(sniffFile("list.csv", Buffer.from("name,score\nAna,9\n"))?.contentType, "text/csv; charset=utf-8");
  assert.equal(sniffFile("read.txt", Buffer.from("señor ñ"))?.kind, "doc");
});

test("files: anything else, or a name that lies about the bytes, is refused", () => {
  assert.equal(sniffFile("x.svg", Buffer.from("<svg onload=alert(1)>")), null);
  assert.equal(sniffFile("x.html", Buffer.from("<script>")), null);
  assert.equal(sniffFile("x.exe", Buffer.from("MZ\x90\0")), null);
  assert.equal(sniffFile("photo.png", Buffer.from("<html><script>alert(1)</script>")), null, "HTML named .png");
  assert.equal(sniffFile("notes.pdf", PNG), null, "a picture named .pdf");
  assert.equal(sniffFile("lab.docx", zip("evil.js")), null, "a zip that isn't an Office file");
  assert.equal(sniffFile("lab.docx", zip("[Content_Types].xml", "word/vbaProject.bin")), null, "macros");
  assert.equal(sniffFile("a.txt", Buffer.from([0x61, 0, 0x62])), null, "binary named .txt");
  assert.equal(sniffFile("a.txt", Buffer.from([0xc3, 0x28])), null, "not UTF-8");
  assert.equal(sniffFile("noext", PDF), null);
  assert.equal(sniffFile("empty.pdf", Buffer.alloc(0)), null);
});

test("files: names lose folders and control characters and keep their extension when cut", () => {
  assert.equal(cleanName("../../etc/passwd"), "passwd");
  assert.equal(cleanName("C:\\Users\\me\\Lab 1.pdf"), "Lab 1.pdf");
  assert.equal(cleanName('a"\nb\u0000.png'), "ab.png");
  const long = cleanName(`${"x".repeat(300)}.pdf`);
  assert.equal(long.length, 200);
  assert.ok(long.endsWith(".pdf"));
  assert.equal(cleanName(""), "file");
});

// ---------- encryption ----------

test("files: sealed bytes are unreadable, tied to their name, and need the key", () => {
  const sealed = sealFile(PDF, "files/a/1", KEY);
  assert.ok(!sealed.includes("%PDF"));
  assert.deepEqual(openFile(sealed, "files/a/1", KEY), PDF);
  assert.throws(() => openFile(sealed, "files/a/2", KEY), "another object's name");
  assert.throws(() => openFile(sealed, "files/a/1", crypto.randomBytes(32)), "another key");
  const tampered = Buffer.from(sealed); tampered[40] ^= 1;
  assert.throws(() => openFile(tampered, "files/a/1", KEY));
});

// ---------- blocks ----------

test("files: a file block keeps only a real file id; kind and name only with one", () => {
  const [ok, bad, junk] = normalizeBlocks([
    { type: "file", title: "Lab", fileId: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE", name: "lab.pdf", kind: "pdf", alt: "x".repeat(400) },
    { type: "file", title: "Bad", fileId: "../../secrets", name: "x", kind: "pdf" },
    { type: "file", fileId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", kind: "exe" },
  ]);
  assert.ok(ok.type === "file" && ok.fileId === "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" && ok.kind === "pdf" && ok.alt.length === 300);
  assert.ok(bad.type === "file" && bad.fileId === "" && bad.name === "" && bad.kind === "");
  assert.ok(junk.type === "file" && junk.kind === "");
});

// ---------- uploads ----------

test("files: teachers upload; the store holds only encrypted bytes; students and bad files are refused", async () => {
  const f = await saveFile(T, bio, "Cell diagram.png", PNG);
  assert.equal(f.kind, "image");
  assert.equal(f.contentType, "image/png");
  const row = await getFile("school-a", f.id);
  const stored = store.objects.get(row!.storageKey)!;
  assert.ok(row!.storageKey.startsWith("files/school-a/"));
  assert.ok(!stored.includes("rest of a picture"), "never stored in the clear");
  assert.deepEqual(await fileBytes(row!), PNG);
  await assert.rejects(saveFile(S, bio, "x.png", PNG), (e: FileError) => e.code === "teachers");
  await assert.rejects(saveFile(T, bio, "x.svg", Buffer.from("<svg/>")), (e: FileError) => e.code === "type");
  await assert.rejects(saveFile(T, bio, "x.pdf", Buffer.alloc(0)), (e: FileError) => e.code === "empty");
  await assert.rejects(saveFile(T, bio, "x.pdf", Buffer.alloc(MAX_FILE + 1, 0x25)), (e: FileError) => e.code === "too-large");
  assert.equal(await getFile("school-b", f.id), null, "another school never finds it");
});

test("files: with no store (on Railway without R2), uploads are off", async () => {
  useFileStore(null);
  try {
    await assert.rejects(saveFile(T, bio, "a.pdf", PDF), (e: FileError) => e.code === "off");
  } finally {
    useFileStore(store);
  }
});

// ---------- who may open ----------

function roles(map: Record<string, CourseRole>) {
  return async (c: string) => map[c] ?? null;
}

test("files: the course's teacher may open; a student only once a lesson holds it or a visible resource shows it", async () => {
  const f = await saveFile(T, bio, "worksheet.pdf", PDF);
  const file = { id: f.id, courseId: bio };
  assert.ok(await canOpen("school-a", file, roles({ [bio]: "teacher" })));
  assert.ok(!(await canOpen("school-a", file, roles({ [bio]: "student" }))), "not used anywhere yet");
  assert.ok(!(await canOpen("school-a", file, roles({}))), "not in the class");

  const block = { type: "file", title: "Worksheet", fileId: f.id, name: f.name, kind: "pdf" };
  const r = await createResource(T, bio, { block });
  assert.ok(!(await canOpen("school-a", file, roles({ [bio]: "student" }))), "a hidden resource");
  await updateResource(T, bio, r.id, { visible: true });
  assert.ok(await canOpen("school-a", file, roles({ [bio]: "student" })), "shown to students");
  await updateResource(T, bio, r.id, { visible: false });
  assert.ok(!(await canOpen("school-a", file, roles({ [bio]: "student" }))));

  const lesson = await createLesson(T, bio, "Lab day", normalizeBlocks([block]));
  assert.ok(await canOpen("school-a", file, roles({ [bio]: "student" })), "in a lesson");
  await saveLesson(T, lesson.id, { baseVersion: lesson.version, blocks: [] });
  assert.ok(!(await canOpen("school-a", file, roles({ [bio]: "student" }))), "taken out of the lesson");
});

test("files: a lesson copied to another class still opens there; an unrelated class can't", async () => {
  const f = await saveFile(T, bio, "map.png", PNG);
  const file = { id: f.id, courseId: bio };
  assert.ok(!(await canOpen("school-a", file, roles({ [chem]: "teacher" }))), "teaches another class that doesn't use it");
  await createLesson(T, chem, "Copied", normalizeBlocks([{ type: "file", title: "Map", fileId: f.id, name: f.name, kind: "image" }]));
  assert.ok(await canOpen("school-a", file, roles({ [chem]: "teacher" })));
  assert.ok(await canOpen("school-a", file, roles({ [chem]: "student" })));
  // Another school's lesson naming the id gives that school nothing: the file isn't theirs.
  await createLesson({ tenantId: "school-b", userId: "t9" }, bioB, "Theirs", normalizeBlocks([{ type: "file", fileId: f.id }]));
  assert.equal(await getFile("school-b", f.id), null);
});

test("files: a resource keeps a file id only if it is this school's file", async () => {
  const f = await saveFile(T, bio, "a.pdf", PDF);
  const theirs = await createResource({ tenantId: "school-b", userId: "t9", role: "teacher" }, bioB, { block: { type: "file", title: "x", fileId: f.id, kind: "pdf", name: "a.pdf" } });
  assert.ok(theirs.block?.type === "file" && theirs.block.fileId === "" && theirs.block.kind === "");
  const ours = await createResource(T, bio, { block: { type: "file", title: "x", fileId: f.id, kind: "pdf", name: "a.pdf" }, visible: true });
  assert.ok(ours.block?.type === "file" && ours.block.fileId === f.id && ours.visible, "a file resource may be shown to students");
});

// ---------- the R2 store ----------

test("files: the R2 store signs each request and keeps bytes as bytes", async () => {
  const objects = new Map<string, Buffer>();
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push(req.headers);
      const body = Buffer.concat(chunks);
      const key = decodeURIComponent(req.url!.split("?")[0]);
      if (req.method === "PUT") { objects.set(key, body); res.end(); return; }
      if (req.method === "DELETE") { objects.delete(key); res.statusCode = 204; res.end(); return; }
      const got = objects.get(key);
      if (!got) { res.statusCode = 404; res.end("<Error/>"); return; }
      res.end(got);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    const s = r2Store({ endpoint: `http://127.0.0.1:${port}`, bucket: "learn", keyId: "KID", secret: "SECRET" });
    const binary = crypto.randomBytes(5000);
    await s.put("files/school-a/x", binary);
    assert.deepEqual(objects.get("/learn/files/school-a/x"), binary);
    assert.deepEqual(await s.get("files/school-a/x"), binary, "binary survives the round trip");
    assert.equal(await s.get("files/school-a/missing"), null);
    await s.del("files/school-a/x");
    assert.equal(objects.size, 0);
    const put = seen[0];
    assert.match(String(put.authorization), /^AWS4-HMAC-SHA256 Credential=KID\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    assert.equal(put["x-amz-content-sha256"], crypto.createHash("sha256").update(binary).digest("hex"));
  } finally {
    server.close();
  }
});
