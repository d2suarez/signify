import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import zlib from "node:zlib";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { Zip, ZipError, safeEntryName } from "../src/lib/zip";
import { parseXml, XmlError } from "../src/lib/xml";
import { htmlToBlocks } from "../src/lib/html-text";
import { readCartridge, summarize, dueFrom, CartridgeError } from "../src/lib/cartridge";
import { previewImport, commitImport } from "../src/lib/cc-import";
import { listUnits, createUnit } from "../src/lib/units";
import { listLessons, getLesson, saveLesson } from "../src/lib/lessons";
import { listAssignments } from "../src/lib/assignments";
import { normalizeBlocks, webLink } from "../src/lib/blocks";

// ---------- a tiny zip writer, for fixtures ----------

type Entry = { name: string; data: string | Buffer; store?: boolean; lieSize?: number };

function zip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, "utf8");
    const body = e.store ? raw : zlib.deflateRawSync(raw);
    const name = Buffer.from(e.name, "utf8");
    const crc = zlib.crc32(raw);
    const size = e.lieSize ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(e.store ? 0 : 8, 8); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt16LE(e.store ? 0 : 8, 10); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(size, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ---------- a small made-up course export (no real people) ----------

const MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="cc1" xmlns="http://www.imsglobal.org/xsd/imsccv1p3/imscp_v1p1" xmlns:lomimscc="http://ltsc.ieee.org/xsd/imsccv1p3/LOM/manifest">
  <metadata>
    <schema>IMS Common Cartridge</schema><schemaversion>1.3.0</schemaversion>
    <lomimscc:lom><lomimscc:general><lomimscc:title><lomimscc:string>Biology 9 &amp; Lab</lomimscc:string></lomimscc:title></lomimscc:general></lomimscc:lom>
  </metadata>
  <organizations>
    <organization identifier="org" structure="rooted-hierarchy">
      <item identifier="root">
        <item identifier="u1"><title>Unit 1: Cells</title>
          <item identifier="i1" identifierref="page1"><title>What is a cell?</title></item>
          <item identifier="sub"><title>Readings</title>
            <item identifier="i2" identifierref="link1"><title>Cell explorer</title></item>
          </item>
          <item identifier="i3" identifierref="asg1"><title>Cell diagram</title></item>
          <item identifier="i4" identifierref="quiz1"><title>Cells quiz</title></item>
          <item identifier="i5" identifierref="pdf1"><title>Worksheet.pdf</title></item>
        </item>
        <item identifier="u2"><title>Unit 2: Genetics</title>
          <item identifier="i6" identifierref="disc1"><title>Talk about traits</title></item>
          <item identifier="i7" identifierref="lti1"><title>Outside tool</title></item>
          <item identifier="i8" identifierref="bad1"><title>Sneaky link</title></item>
        </item>
        <item identifier="i9" identifierref="page2"><title>Welcome</title></item>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="page1" type="webcontent" href="pages/cell.html"><file href="pages/cell.html"/></resource>
    <resource identifier="page2" type="webcontent" href="pages/welcome.html"><file href="pages/welcome.html"/></resource>
    <resource identifier="link1" type="imswl_xmlv1p3"><file href="links/l1.xml"/></resource>
    <resource identifier="bad1" type="imswl_xmlv1p3"><file href="links/bad.xml"/></resource>
    <resource identifier="asg1" type="assignment_xmlv1p0" href="asg/a1.xml"><file href="asg/a1.xml"/></resource>
    <resource identifier="quiz1" type="imsqti_xmlv1p2/imscc_xmlv1p3/assessment"><file href="quiz/q1.xml"/></resource>
    <resource identifier="pdf1" type="webcontent" href="web_resources/Worksheet.pdf"><file href="web_resources/Worksheet.pdf"/></resource>
    <resource identifier="disc1" type="imsdt_xmlv1p3"><file href="disc/d1.xml"/></resource>
    <resource identifier="lti1" type="imsbasiclti_xmlv1p0"><file href="lti/t1.xml"/></resource>
    <resource identifier="canvas1" type="associatedcontent/imscc_xmlv1p1/learning-application-resource" href="ca1/lab-report.html">
      <file href="ca1/lab-report.html"/><file href="ca1/assignment_settings.xml"/>
    </resource>
  </resources>
</manifest>`;

const CELL_PAGE = `<html><head><title>x</title><script>alert(1)</script></head><body>
<h2>Parts of a cell</h2>
<p onclick="steal()">The <b>nucleus</b> holds DNA. See <a href="https://example.org/cells">this page</a>
and <a href="javascript:alert(1)">this</a>.</p>
<ul><li>Membrane</li><li>Cytoplasm</li></ul>
<img src="$IMS-CC-FILEBASE$/cell%20diagram.png" alt="A plant cell">
<style>p { color: red }</style>
<h2>Watch</h2>
<iframe src="https://www.youtube.com/embed/abc123" title="Cells video">fallback words</iframe>
<p>Then answer &ldquo;why?&rdquo;&nbsp;&amp; discuss.</p>
</body></html>`;

const FILES: Entry[] = [
  { name: "imsmanifest.xml", data: MANIFEST },
  { name: "pages/cell.html", data: CELL_PAGE },
  { name: "pages/welcome.html", data: "<p>Welcome to biology!</p>" },
  { name: "web_resources/cell diagram.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), store: true },
  { name: "web_resources/Worksheet.pdf", data: "%PDF-1.4", store: true },
  { name: "links/l1.xml", data: `<webLink xmlns="http://www.imsglobal.org/xsd/imsccv1p3/imswl_v1p3"><title>Cell explorer</title><url href="https://example.org/explorer"/></webLink>` },
  { name: "links/bad.xml", data: `<webLink><title>Sneaky</title><url href="javascript:alert(document.cookie)"/></webLink>` },
  { name: "asg/a1.xml", data: `<assignment xmlns="http://www.imsglobal.org/xsd/imscc_extensions/assignment" identifier="a1">
      <title>Cell diagram</title>
      <text texttype="text/html">&lt;p&gt;Draw and label a cell.&lt;/p&gt;&lt;script&gt;x()&lt;/script&gt;</text>
      <gradable points_possible="20">true</gradable>
      <due_at>2026-11-06T15:30:00</due_at>
    </assignment>` },
  { name: "quiz/q1.xml", data: `<questestinterop><assessment ident="q1" title="Cells quiz"><section ident="s"/></assessment></questestinterop>` },
  { name: "disc/d1.xml", data: `<topic><title>Talk about traits</title><text texttype="text/html">Which traits run in your family?</text></topic>` },
  { name: "lti/t1.xml", data: `<cartridge_basiclti_link/>` },
  { name: "ca1/lab-report.html", data: "<p>Write up the lab.</p>" },
  { name: "ca1/assignment_settings.xml", data: `<assignment identifier="ca1" xmlns="http://canvas.instructure.com/xsd/cccv1p0"><title>Lab report</title><points_possible>50</points_possible><due_at>2026-11-13T23:59:00Z</due_at></assignment>` },
];

const fixture = () => zip(FILES);

let db: Db;
const A = { tenantId: "school-a", userId: "teacher-1" };
const B = { tenantId: "school-b", userId: "teacher-9" };
let courseA: string;
let courseB: string;

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
  courseA = String((await db.query("INSERT INTO courses (tenant_id, id_class_id, name) VALUES ('school-a', 'c1', 'Bio') RETURNING id"))[0].id);
  courseB = String((await db.query("INSERT INTO courses (tenant_id, id_class_id, name) VALUES ('school-b', 'c9', 'Bio B') RETURNING id"))[0].id);
});
after(() => db.close());

// ---------- zip safety ----------

test("zip: reads stored and deflated entries", () => {
  const z = new Zip(zip([{ name: "a.txt", data: "hello" }, { name: "b.bin", data: "raw", store: true }]));
  assert.equal(z.text("a.txt"), "hello");
  assert.equal(z.text("b.bin"), "raw");
  assert.equal(z.read("missing"), null);
});

test("zip: a name that climbs out of the archive refuses the whole file", () => {
  for (const bad of ["../evil.html", "a/../../evil", "/etc/passwd", "C:/x", "a\\..\\..\\x"]) {
    assert.equal(safeEntryName(bad), null, bad);
    assert.throws(() => new Zip(zip([{ name: bad, data: "x" }])), (e: unknown) => e instanceof ZipError && e.message === "unsafe-path");
  }
  assert.equal(safeEntryName("./pages/a.html"), "pages/a.html");
});

test("zip: too many entries is refused", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ name: `f${i}.txt`, data: "x" }));
  assert.throws(() => new Zip(zip(many), { entries: 20, entryBytes: 1e6, totalInflated: 1e7, totalDeclared: 1e9 }), /too-many-files/);
});

test("zip: a bomb stops inflating at the cap, whatever size it declares", () => {
  const bomb = Buffer.alloc(5_000_000, 0); // deflates to a few KB
  const z = zip([{ name: "bomb.html", data: bomb, lieSize: 100 }]);
  assert.ok(z.length < 50_000);
  const reader = new Zip(z, { entries: 10, entryBytes: 1_000_000, totalInflated: 2_000_000, totalDeclared: 1e9 });
  assert.throws(() => reader.read("bomb.html"), ZipError);
  // Honest about its size, it is refused before inflating.
  const honest = new Zip(zip([{ name: "big.html", data: bomb }]), { entries: 10, entryBytes: 1_000_000, totalInflated: 2_000_000, totalDeclared: 1e9 });
  assert.throws(() => honest.read("big.html"), /file-too-large/);
});

test("zip: the total inflated across entries is capped", () => {
  const files = Array.from({ length: 5 }, (_, i) => ({ name: `p${i}.html`, data: Buffer.alloc(400_000, 65) }));
  const z = new Zip(zip(files), { entries: 10, entryBytes: 1_000_000, totalInflated: 1_000_000, totalDeclared: 1e9 });
  z.read("p0.html"); z.read("p1.html");
  assert.throws(() => z.read("p2.html"), ZipError);
});

test("zip: not a zip at all", () => {
  assert.throws(() => new Zip(Buffer.from("just some text, not an archive")), /not-zip/);
});

// ---------- xml safety ----------

test("xml: a DOCTYPE or ENTITY is refused, so no external entities", () => {
  const xxe = `<?xml version="1.0"?><!DOCTYPE m [<!ENTITY x SYSTEM "file:///etc/passwd">]><manifest>&x;</manifest>`;
  assert.throws(() => parseXml(xxe), XmlError);
  const laughs = `<!DOCTYPE m [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><m>&b;</m>`;
  assert.throws(() => parseXml(laughs), XmlError);
});

test("xml: built-in entities, CDATA and prefixes", () => {
  const n = parseXml(`<a:root x:id="1"><b>&lt;p&gt; &amp; &#233;&#x41;</b><c><![CDATA[<raw>]]></c><d/></a:root>`);
  assert.equal(n.name, "root");
  assert.equal(n.attrs.id, "1");
  assert.equal(n.children[0].text, "<p> & éA");
  assert.equal(n.children[1].text, "<raw>");
  assert.equal(n.children.length, 3);
});

test("xml: a cartridge whose manifest has a DOCTYPE is refused", () => {
  const bad = zip([{ name: "imsmanifest.xml", data: `<!DOCTYPE manifest [<!ENTITY x SYSTEM "http://evil/">]><manifest>&x;</manifest>` }]);
  assert.throws(() => readCartridge(bad), (e: unknown) => e instanceof CartridgeError && e.code === "doctype");
});

// ---------- html → blocks ----------

test("html: nothing executable survives; links kept only when http(s)", () => {
  const page = htmlToBlocks(CELL_PAGE, "What is a cell?");
  const all = JSON.stringify(page.blocks);
  for (const bad of ["<script", "alert", "onclick", "steal", "javascript:", "color: red", "<b>", "fallback words"]) {
    assert.ok(!all.includes(bad), `${bad} leaked`);
  }
  const [parts, video, rest] = page.blocks;
  assert.equal(parts.type === "text" && parts.title, "Parts of a cell");
  assert.ok(parts.type === "text" && parts.body.includes("The nucleus holds DNA. See this page (https://example.org/cells)"));
  assert.ok(parts.type === "text" && parts.body.includes("• Membrane\n• Cytoplasm"));
  assert.ok(parts.type === "text" && parts.body.includes("[Image: A plant cell]"));
  // The heading over the video names it, rather than leaving an empty slide.
  assert.deepEqual(video, { type: "link", title: "Watch", url: "https://www.youtube.com/embed/abc123" });
  assert.ok(rest.type === "text" && rest.body === "Then answer “why?” & discuss.");
  assert.deepEqual(page.missing, ["cell diagram.png"]);
});

test("html: a page with no headings takes the item's title", () => {
  const page = htmlToBlocks("<p>One</p><p>Two</p>", "Welcome");
  assert.deepEqual(page.blocks, [{ type: "text", title: "Welcome", body: "One\n\nTwo" }]);
});

test("html: a huge page is split to fit a lesson's limits", () => {
  const big = Array.from({ length: 3000 }, (_, i) => `<p>${"word ".repeat(20)}${i}</p>`).join("");
  const blocks = normalizeBlocks(htmlToBlocks(big).blocks);
  assert.ok(blocks.length > 1);
});

test("link block: only http(s) links are ever opened", () => {
  assert.equal(webLink("https://example.org/a b"), "https://example.org/a%20b");
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "/relative", "ftp://x", ""]) assert.equal(webLink(bad), "", bad);
  const [b] = normalizeBlocks([{ type: "link", title: " Go\nthere ", url: "javascript:alert(1)" }]);
  assert.equal(b.type, "link");
  assert.equal(b.type === "link" && b.title, "Go there");
});

// ---------- the cartridge plan ----------

test("cartridge: folders become units, everything else is listed", () => {
  const plan = readCartridge(fixture());
  assert.equal(plan.courseTitle, "Biology 9 & Lab");
  assert.deepEqual(plan.units.map((u) => u.title), ["Unit 1: Cells", "Unit 2: Genetics"]);
  assert.deepEqual(plan.units[0].items.map((i) => `${i.kind}:${i.title}`), ["lesson:What is a cell?", "lesson:Cell explorer", "assignment:Cell diagram"]);
  assert.deepEqual(plan.units[1].items, []);
  // A loose page, and Canvas's assignment that is in no module.
  assert.deepEqual(plan.loose.map((i) => `${i.kind}:${i.title}`), ["lesson:Welcome", "assignment:Lab report"]);
  assert.deepEqual(plan.skipped.map((s) => `${s.kind}:${s.title}`).sort(), [
    "discussion:Talk about traits", "file:Worksheet.pdf", "other:Sneaky link", "quiz:Cells quiz", "tool:Outside tool",
  ]);
  assert.deepEqual(plan.missingFiles, ["web_resources/cell diagram.png"]);
  assert.deepEqual(summarize(plan), { units: 2, lessons: 3, assignments: 2, datedAssignments: 2, quizzes: 1, discussions: 1, tools: 1, files: 1, other: 1 });
});

test("cartridge: assignments keep title, instructions, points and due date", () => {
  const plan = readCartridge(fixture());
  const a = plan.units[0].items[2];
  assert.ok(a.kind === "assignment");
  assert.equal(a.instructions, "Draw and label a cell.");
  assert.equal(a.points, 20);
  // No zone in the file: the school's wall clock (EST in November).
  assert.equal(a.dueOn, "2026-11-06");
  assert.equal(a.dueAt, "2026-11-06T20:30:00.000Z");
  const lab = plan.loose[1];
  assert.ok(lab.kind === "assignment" && lab.points === 50 && lab.instructions === "Write up the lab.");
  // 23:59 UTC is still the 13th in New York.
  assert.equal(lab.kind === "assignment" && lab.dueOn, "2026-11-13");
});

test("cartridge: quizzes and discussions keep their source for later", () => {
  const plan = readCartridge(fixture());
  const quiz = plan.kept.find((k) => k.kind === "quiz");
  assert.ok(quiz && quiz.source.includes("<questestinterop>") && quiz.unit === "Unit 1: Cells");
  assert.equal(plan.kept.find((k) => k.kind === "discussion")?.source, "Which traits run in your family?");
});

test("cartridge: due dates as exports write them", () => {
  const tz = "America/New_York";
  assert.deepEqual(dueFrom("2026-09-10", tz), { dueOn: "2026-09-10", dueAt: "2026-09-11T03:59:00.000Z" });
  assert.deepEqual(dueFrom("2026-09-10 08:00:00", tz), { dueOn: "2026-09-10", dueAt: "2026-09-10T12:00:00.000Z" });
  assert.deepEqual(dueFrom("2026-09-10T08:00:00-05:00", tz), { dueOn: "2026-09-10", dueAt: "2026-09-10T13:00:00.000Z" });
  assert.equal(dueFrom("next Tuesday", tz), null);
  assert.equal(dueFrom("2026-13-01", tz), null);
});

test("cartridge: no manifest, or not a zip, is a clear refusal", () => {
  assert.throws(() => readCartridge(zip([{ name: "readme.txt", data: "hi" }])), (e: unknown) => e instanceof CartridgeError && e.code === "no-manifest");
  assert.throws(() => readCartridge(Buffer.from("nope")), (e: unknown) => e instanceof CartridgeError && e.code === "not-zip");
});

test("cartridge: Canvas-style flat organization (no wrapper) still works", () => {
  const m = `<manifest><organizations><organization><item identifier="w"><title>Week 1</title><item identifier="x" identifierref="p"><title>Intro</title></item></item><item identifier="y" identifierref="p"><title>Again</title></item></organization></organizations>
    <resources><resource identifier="p" type="webcontent" href="p.html"/></resources></manifest>`;
  const plan = readCartridge(zip([{ name: "imsmanifest.xml", data: m }, { name: "p.html", data: "<h1>Hi</h1><p>there</p>" }]));
  assert.deepEqual(plan.units.map((u) => u.title), ["Week 1"]);
  assert.deepEqual(plan.loose.map((i) => i.title), ["Again"]);
});

// ---------- writing it ----------

test("import: preview writes nothing", async () => {
  const p = await previewImport(A, courseA, fixture());
  assert.equal(p.summary.lessons, 3);
  assert.equal(p.outline.length, 3);
  assert.equal(p.outline[2].title, null);
  assert.deepEqual(p.importedBefore, []);
  assert.equal((await listUnits(A, courseA)).length, 0);
  assert.equal((await listLessons(A, courseA)).length, 0);
});

test("import: one transaction; everything a draft; units after existing ones; versions as usual", async () => {
  await createUnit(A, courseA, "Already here");
  const r = await commitImport(A, courseA, fixture(), "bio.imscc", { keepDates: true });
  assert.equal(r.summary.assignments, 2);

  const units = await listUnits(A, courseA);
  assert.deepEqual(units.map((u) => u.title), ["Already here", "Unit 1: Cells", "Unit 2: Genetics"]);
  const lessons = await listLessons(A, courseA);
  assert.equal(lessons.length, 3);
  assert.ok(lessons.every((l) => l.plannedFor === null && l.version === 1));
  const asg = await listAssignments(A, courseA);
  assert.equal(asg.length, 2);
  assert.ok(asg.every((a) => !a.published && !a.gradesReleased));
  assert.equal(asg.find((a) => a.title === "Cell diagram")?.dueOn, "2026-11-06");

  // Lessons keep history on the first edit, as any other lesson.
  const cell = lessons.find((l) => l.title === "What is a cell?")!;
  const full = await getLesson(A, cell.id);
  assert.equal(full?.unitId, r.unitIds[0]);
  assert.ok(full!.blocks.some((b) => b.type === "link"));
  const saved = await saveLesson(A, cell.id, { baseVersion: 1, title: "Cells" });
  assert.ok(saved.ok && saved.lesson.version === 2);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM lesson_versions WHERE lesson_id = $1", [cell.id]))[0].n, 1);

  // Quiz and discussion sources kept, with the school on every row.
  const kept = await db.query("SELECT kind, tenant_id FROM import_sources WHERE import_id = $1 ORDER BY kind", [r.importId]);
  assert.deepEqual(kept.map((k) => `${k.kind}:${k.tenant_id}`), ["discussion:school-a", "quiz:school-a"]);

  // The same file again is noticed.
  const again = await previewImport(A, courseA, fixture());
  assert.equal(again.importedBefore.length, 1);
  assert.equal(again.importedBefore[0].fileName, "bio.imscc");
});

test("import: keepDates false drops the dates", async () => {
  await commitImport(B, courseB, fixture(), "bio.imscc", { keepDates: false });
  const asg = await listAssignments(B, courseB);
  assert.ok(asg.length === 2 && asg.every((a) => a.dueOn === null && a.dueAt === null));
});

test("import: another school sees none of it", async () => {
  assert.equal((await listLessons(B, courseA)).length, 0);
  assert.equal((await listUnits(B, courseA)).length, 0);
  const again = await previewImport(B, courseA, fixture());
  assert.deepEqual(again.importedBefore, []);
});

test("import: a failure part-way leaves the course as it was", async () => {
  const fresh = String((await db.query("INSERT INTO courses (tenant_id, id_class_id, name) VALUES ('school-a', 'c2', 'Empty') RETURNING id"))[0].id);
  // Make the assignment insert fail, after the record, units and lessons are written.
  await db.exec(`CREATE FUNCTION boom() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$ LANGUAGE plpgsql;
    CREATE TRIGGER boom BEFORE INSERT ON assignments FOR EACH ROW WHEN (NEW.title = 'Cell diagram') EXECUTE FUNCTION boom();`);
  try {
    await assert.rejects(commitImport(A, fresh, fixture(), "x.imscc", { keepDates: true }), /boom/);
  } finally {
    await db.exec("DROP TRIGGER boom ON assignments; DROP FUNCTION boom();");
  }
  assert.equal((await listUnits(A, fresh)).length, 0);
  assert.equal((await listLessons(A, fresh)).length, 0);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM course_imports WHERE course_id = $1", [fresh]))[0].n, 0);
});

test("i18n: every import and link string has Spanish", async () => {
  const { dict } = await import("../src/lib/i18n");
  const en = dict("en"), es = dict("es");
  const keys = (Object.keys(en) as (keyof typeof en)[]).filter((k) => /^import|^link|^blockLink$|^openLink$/.test(k));
  assert.ok(keys.length > 40);
  for (const k of keys) assert.notEqual(es[k], en[k], `${k} has no Spanish`);
});
