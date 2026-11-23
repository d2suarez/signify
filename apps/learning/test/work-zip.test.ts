import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { Zip } from "../src/lib/zip";
import { crc32, safeFileName, zipFiles } from "../src/lib/zip-write";
import { workZip, ZipTooBig, ZIP_MAX_BYTES } from "../src/lib/work-zip";
import { dict } from "../src/lib/i18n";
import type { Submission } from "../src/lib/assignments";

// Zip download of online writing (teacher story 01, F3).

const d = dict("en");
const sub = (studentId: string, body: string, submittedAt: string | null): Submission =>
  ({ assignmentId: "a", studentId, body, version: 1, submittedAt, updatedAt: "2026-11-23T10:00:00Z" });

test("zip writer: crc32 and a round trip through the app's own zip reader", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  const big = Buffer.from("scarcity ".repeat(500));
  const bytes = zipFiles([{ name: "Ana López.txt", data: big }, { name: "tiny.txt", data: Buffer.from("x") }]);
  const z = new Zip(bytes);
  assert.deepEqual([...z.entries.keys()].sort(), ["Ana López.txt", "tiny.txt"]);
  assert.equal(z.text("Ana López.txt"), big.toString());
  assert.equal(z.text("tiny.txt"), "x");
  assert.ok(bytes.length < big.length, "deflated");
  assert.ok(zlib.inflateRawSync(zlib.deflateRawSync(big)).equals(big));
});

test("zip writer: file names are safe everywhere", () => {
  assert.equal(safeFileName('a/b\\c:d*e?"f<g>h|i'), "a b c d e f g h i");
  assert.equal(safeFileName("..hidden"), "hidden");
  assert.equal(safeFileName("   ", "work"), "work");
  assert.equal(safeFileName("x".repeat(300)).length, 120);
  // Windows device names, trailing dots and spaces, and a byte cap for long non-Latin names.
  assert.equal(safeFileName("CON"), "_CON");
  assert.equal(safeFileName("nul.txt"), "_nul.txt");
  assert.equal(safeFileName("com1"), "_com1");
  assert.equal(safeFileName("Console"), "Console");
  assert.equal(safeFileName("Essay. . "), "Essay");
  const cjk = safeFileName("漢".repeat(120));
  assert.ok(Buffer.byteLength(cjk, "utf8") <= 200, "at most 200 bytes");
  assert.equal(cjk, "漢".repeat(66));
});

test("work zip: one file per student, named by student, with who handed in", () => {
  const students = [{ id: "s1", name: "Ana López" }, { id: "s2", name: "Ben" }, { id: "s3", name: "Ben" }, { id: "s4", name: "Cy" }];
  const subs = new Map([
    ["s1", sub("s1", "My essay.\nLine two.", "2026-11-23T09:00:00Z")],
    ["s2", sub("s2", "Draft only", null)],
    ["s3", sub("s3", "Other Ben", "2026-11-24T09:00:00Z")],
    ["x9", sub("x9", "Not in the class", "2026-11-23T09:00:00Z")],
  ]);
  const out = workZip({ title: "Essay 1", students, subs, groups: null, work: new Map(), mode: "each", late: (s) => s?.studentId === "s3", when: new Date(), d });
  const z = new Zip(out.bytes);
  assert.deepEqual([...z.entries.keys()].sort(), ["Ana López.txt", "Ben (2).txt", "Ben.txt", "_Who handed in.txt"]);
  assert.equal(out.count, 3);
  assert.equal(out.name, "Essay 1.zip");
  assert.match(z.text("Ana López.txt")!, /^Ana López\r?\nEssay 1\r?\nHanded in 2026-11-23 09:00 UTC\r?\n\r?\nMy essay\.\r\nLine two\./);
  assert.match(z.text("Ben (2).txt")!, /Late/);
  const index = z.text("_Who handed in.txt")!;
  assert.match(index, /Cy: nothing written/);
  assert.ok(!index.includes("Not in the class") && ![...z.entries.keys()].some((k) => k.includes("x9")));
  // One student's work only.
  const one = workZip({ title: "Essay 1", students, subs, groups: null, work: new Map(), mode: "each", late: () => false, only: "s1", when: new Date(), d });
  assert.deepEqual([...new Zip(one.bytes).entries.keys()].sort(), ["Ana López.txt", "_Who handed in.txt"]);
  assert.equal(one.name, "Essay 1 - Ana López.zip");
});

test("work zip: a group assignment is one file per group, named with its members", () => {
  const students = [{ id: "s1", name: "Ana" }, { id: "s2", name: "Ben" }, { id: "s3", name: "Cy" }];
  const groups = [
    { id: "g1", name: "Group 1", members: [{ id: "s1", name: "Ana" }, { id: "s2", name: "Ben" }] },
    { id: "g2", name: "Group 2", members: [{ id: "s3", name: "Cy" }] },
  ];
  const work = new Map([["g1", { groupId: "g1", body: "Our shared text", version: 3, submitter: null, submittedAt: null } as never]]);
  const subs = new Map([["s2", sub("s2", "Our shared text (handed in)", "2026-11-23T09:00:00Z")]]);
  const out = workZip({ title: "Lab", students, subs, groups, work, mode: "one", late: () => false, when: new Date(), d });
  const z = new Zip(out.bytes);
  assert.deepEqual([...z.entries.keys()].sort(), ["Group 1 - Ana, Ben.txt", "_Who handed in.txt"]);
  assert.match(z.text("Group 1 - Ana, Ben.txt")!, /handed in\)/, "the handed-in copy wins");
  assert.match(z.text("_Who handed in.txt")!, /Group 2: Cy: nothing written/);
  const one = workZip({ title: "Lab", students, subs, groups, work, mode: "one", late: () => false, only: "s1", when: new Date(), d });
  assert.deepEqual([...new Zip(one.bytes).entries.keys()].sort(), ["Group 1 - Ana, Ben.txt", "_Who handed in.txt"], "a member's download is their group's work");
});

test("work zip: group work in \"each\" mode keeps every member's own hand-in", () => {
  const students = [{ id: "s1", name: "Ana" }, { id: "s2", name: "Ben" }, { id: "s3", name: "Cy" }];
  const groups = [{ id: "g1", name: "Group 1", members: [{ id: "s1", name: "Ana" }, { id: "s2", name: "Ben" }, { id: "s3", name: "Cy" }] }];
  const work = new Map([["g1", { groupId: "g1", body: "Shared draft now", version: 5, submitter: null, submittedAt: null } as never]]);
  const subs = new Map([
    ["s1", sub("s1", "Ana's 9:00 copy", "2026-11-23T09:00:00Z")],
    ["s2", sub("s2", "Ben's 9:30 copy", "2026-11-23T09:30:00Z")],
  ]);
  const out = workZip({ title: "Lab", students, subs, groups, work, mode: "each", late: () => false, when: new Date(), d });
  const z = new Zip(out.bytes);
  assert.deepEqual([...z.entries.keys()].sort(), ["Ana (Group 1).txt", "Ben (Group 1).txt", "Cy (Group 1).txt", "_Who handed in.txt"]);
  assert.match(z.text("Ana (Group 1).txt")!, /^Ana · Group 1\r?\nLab\r?\nHanded in 2026-11-23 09:00 UTC[\s\S]*Ana's 9:00 copy/);
  assert.match(z.text("Ben (Group 1).txt")!, /Handed in 2026-11-23 09:30 UTC[\s\S]*Ben's 9:30 copy/, "Ben's own final copy, not Ana's");
  assert.match(z.text("Cy (Group 1).txt")!, /Not handed in|Working on it|Shared draft now/);
  assert.match(z.text("Cy (Group 1).txt")!, /Shared draft now/, "not handed in yet: the group's text as it is now");
  // One student's download in "each" mode is that student's own copy only.
  const one = workZip({ title: "Lab", students, subs, groups, work, mode: "each", late: () => false, only: "s2", when: new Date(), d });
  assert.deepEqual([...new Zip(one.bytes).entries.keys()].sort(), ["Ben (Group 1).txt", "_Who handed in.txt"]);
});

test("work zip: a member who left the class is named as having left", () => {
  const students = [{ id: "s1", name: "Ana" }];
  const groups = [{ id: "g1", name: "Group 1", members: [{ id: "s1", name: "Ana" }, { id: "gone", name: "Old Name" }] }];
  const work = new Map([["g1", { groupId: "g1", body: "Our text", version: 2, submitter: null, submittedAt: null } as never]]);
  const out = workZip({ title: "Lab", students, subs: new Map(), groups, work, mode: "one", late: () => false, when: new Date(), d });
  const z = new Zip(out.bytes);
  assert.deepEqual([...z.entries.keys()].sort(), ["Group 1 - Ana, Old Name (left the class).txt", "_Who handed in.txt"]);
  assert.match(z.text("_Who handed in.txt")!, /Old Name \(left the class\)/);
  const es = workZip({ title: "Lab", students, subs: new Map(), groups, work, mode: "one", late: () => false, when: new Date(), d: dict("es") });
  assert.ok([...new Zip(es.bytes).entries.keys()].some((k) => k.includes("(dejó la clase)")));
});

test("work zip: refused above the size cap", () => {
  const big = "x".repeat(LIMIT_CHUNK);
  const students = Array.from({ length: Math.ceil(ZIP_MAX_BYTES / LIMIT_CHUNK) + 1 }, (_, i) => ({ id: `s${i}`, name: `S${i}` }));
  const subs = new Map(students.map((s) => [s.id, sub(s.id, big, "2026-11-23T09:00:00Z")]));
  assert.throws(() => workZip({ title: "Big", students, subs, groups: null, work: new Map(), mode: "each", late: () => false, when: new Date(), d }), ZipTooBig);
});
const LIMIT_CHUNK = 4 * 1024 * 1024;
