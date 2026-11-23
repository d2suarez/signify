import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses } from "../src/lib/courses";
import { createLesson, saveLesson } from "../src/lib/lessons";
import { normalizeBlocks, forStudent, remapAssignments, groupSetIdsIn, blockSpeech } from "../src/lib/blocks";
import { normalizeGroups, randomGroups, groupIndexOf, ungrouped, showGroups } from "../src/lib/groups";
import { createGroupSet, saveGroupSet, getGroupSet, listGroupSets, myGroups, copyGroupSet } from "../src/lib/group-sets";
import { studentBlocks, teacherBlocks } from "../src/lib/lesson-assignments";
import { normalizeResourceBlock } from "../src/lib/resources";

// Groups (story 01, A8/D8): saved per class, random or by hand, on slides.

let db: Db;
const T = { tenantId: "school-a", userId: "t1" };
const B = { tenantId: "school-b", userId: "t9" };
let course = "", other = "", foreign = "";
const roster = new Map([["s1", "Ana"], ["s2", "Ben"], ["s3", "Cy"], ["s4", "Dee"], ["s5", "Eli"]]);
const people = [...roster].map(([id, name]) => ({ id, name }));

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
  [course, other] = (await myCourses("school-a", [{ id: "c-1", name: "Bible 9", role: "teacher" }, { id: "c-2", name: "Art", role: "teacher" }], "t1")).map((c) => c.id);
  foreign = (await myCourses("school-b", [{ id: "c-9", name: "Elsewhere", role: "teacher" }], "t9"))[0].id;
});
after(() => db.close());

function seq(...xs: number[]) { let i = 0; return () => xs[i++ % xs.length]; }

test("random groups: by count or by size, sizes never more than one apart, everyone once", () => {
  for (const how of [{ count: 2 }, { count: 3 }, { size: 2 }, { size: 4 }, { count: 9 }] as const) {
    const g = randomGroups(people, how, "Group", seq(0.3, 0.9, 0.1, 0.5));
    const sizes = g.map((x) => x.members.length);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, JSON.stringify(how));
    assert.equal(g.flatMap((x) => x.members).length, 5);
    assert.equal(new Set(g.flatMap((x) => x.members.map((m) => m.id))).size, 5);
  }
  assert.equal(randomGroups(people, { size: 2 }).length, 3, "groups of two from five = three groups");
  assert.equal(randomGroups(people, { count: 3 }, "Grupo")[2].name, "Grupo 3");
  assert.equal(randomGroups(people, { count: 0 }).length, 1);
});

test("normalizeGroups: shapes, a student once, only the class (named as ID names them)", () => {
  const g = normalizeGroups([
    { id: "a", name: "  Reds  ", members: [{ id: "s1", name: "typed name" }, "s2", { id: "s1" }] },
    { id: "a", name: "", members: ["s2", "s3", "intruder"] },
    "junk", null,
    { members: [] },
  ], roster);
  assert.deepEqual(g.map((x) => x.name), ["Reds", "Group 2", "Group 3"]);
  assert.deepEqual(g[0].members, [{ id: "s1", name: "Ana" }, { id: "s2", name: "Ben" }], "names come from the class, never the browser");
  assert.deepEqual(g[1].members.map((m) => m.id), ["s3"], "s2 stays in its first group; strangers are dropped");
  assert.notEqual(g[1].id, "a", "ids unique");
  assert.equal(groupIndexOf(g, "s3"), 1);
  assert.equal(groupIndexOf(g, "s5"), null);
  assert.deepEqual(ungrouped(g, people).map((p) => p.id), ["s4", "s5"]);
});

test("showGroups: teacher and live class see all; afterwards a student sees only their own", () => {
  const g = normalizeGroups([{ name: "A", members: ["s1", "s2"] }, { name: "B", members: ["s3"] }], roster);
  assert.equal(showGroups("Lab", g, { studentId: null, live: false }).groups.length, 2);
  const live = showGroups("Lab", g, { studentId: "s3", live: true });
  assert.equal(live.groups.length, 2); assert.equal(live.mine, 1);
  const later = showGroups("Lab", g, { studentId: "s3", live: false });
  assert.deepEqual(later.groups, [{ name: "B", members: ["Cy"] }]); assert.equal(later.mine, 0); assert.ok(later.onlyMine);
  assert.deepEqual(showGroups("Lab", g, { studentId: "s5", live: false }).groups, [], "in no group: nothing");
  assert.ok(!JSON.stringify(live).includes("s1"), "names only, never ids");
});

test("group sets: save with versions, refreshed from the class, archived not deleted, per school", async () => {
  const set = await createGroupSet(T, course, { name: "Lab partners", groups: [{ name: "A", members: ["s1", "s2"] }, { name: "B", members: ["s3"] }] }, roster);
  assert.equal(set.version, 1);
  assert.equal(set.studentsSee, true);
  const left = new Map(roster); left.delete("s2"); left.set("s1", "Ana María");
  const r = await saveGroupSet(T, course, set.id, { baseVersion: 1, groups: set.groups }, left);
  assert.ok(r.ok);
  if (r.ok) {
    assert.deepEqual(r.set.groups[0].members, [{ id: "s1", name: "Ana María" }], "a student who left drops out; names follow ID");
    assert.equal(r.set.version, 2);
  }
  const stale = await saveGroupSet(T, course, set.id, { baseVersion: 1, name: "x" }, roster);
  assert.equal(!stale.ok && stale.reason, "conflict");
  assert.equal(await getGroupSet(B, course, set.id), null, "another school can't read it");
  assert.equal(await getGroupSet(T, other, set.id), null, "nor another class");
  const away = await saveGroupSet(B, foreign, set.id, { baseVersion: 2, archived: true }, roster);
  assert.equal(!away.ok && away.reason, "missing");

  const copy = await copyGroupSet(T, course, set.id, "Lab partners (copy)", roster);
  assert.equal(copy?.groups.length, 2);
  await saveGroupSet(T, course, set.id, { baseVersion: 2, archived: true }, roster);
  assert.deepEqual((await listGroupSets(T, course)).map((s) => s.name), ["Lab partners (copy)"]);
  assert.equal((await listGroupSets(T, course, { archived: true })).length, 1);
});

test("myGroups: a student's own group in sets they may see", async () => {
  const shown = await createGroupSet(T, other, { name: "Teams", groups: [{ name: "Owls", members: ["s4", "s5"] }, { name: "Larks", members: ["s1"] }] }, roster);
  await createGroupSet(T, other, { name: "Secret", studentsSee: false, groups: [{ name: "X", members: ["s4"] }] }, roster);
  assert.deepEqual(await myGroups(T, other, "s4"), [{ setId: shown.id, setName: "Teams", group: "Owls", members: ["Dee", "Eli"] }]);
  assert.deepEqual(await myGroups(T, other, "s2"), []);
});

test("group slide: normalized, never stored with groups, only the class's own set, per viewer", async () => {
  const set = await createGroupSet(T, course, { name: "Reading circles", studentsSee: false, groups: [{ name: "A", members: ["s1"] }, { name: "B", members: ["s2", "s3"] }] }, roster);
  const theirs = await createGroupSet(T, other, { name: "Art teams", groups: [] }, roster);
  const [b] = normalizeBlocks([{ type: "groups", title: "x", groupSetId: set.id.toUpperCase(), shown: { name: "fake", groups: [{ name: "Z", members: ["Mallory"] }] } }]);
  assert.deepEqual(b, { id: b.id, type: "groups", title: "x", groupSetId: set.id }, "shown is never kept from a browser");
  assert.equal(normalizeResourceBlock({ type: "groups", groupSetId: set.id }), null, "never a class resource");
  assert.deepEqual(remapAssignments([b], new Map()), [], "a class copy drops group slides");

  const lesson = await createLesson(T, course, "Day 2", [
    { type: "groups", groupSetId: set.id, title: "" },
    { type: "groups", groupSetId: theirs.id, title: "" },
    { type: "groups", groupSetId: "", title: "" },
  ] as never);
  assert.deepEqual(lesson.blocks.map((x) => (x as { title: string }).title), ["Reading circles", ""], "another class's set is dropped; title from the set");
  assert.deepEqual(groupSetIdsIn(lesson.blocks), [set.id]);

  const teacher = await teacherBlocks(T.tenantId, course, lesson.blocks);
  assert.equal((teacher[0] as { shown?: { groups: unknown[] } }).shown?.groups.length, 2);
  assert.match(blockSpeech(teacher[0]), /B: Ben, Cy/);
  const live = await studentBlocks(T.tenantId, course, lesson.blocks, { studentId: "s3", live: true });
  assert.equal((live[0] as { shown?: { groups: unknown[]; mine: number } }).shown?.groups.length, 2, "live: every group, even a set hidden from the class page");
  assert.equal((live[0] as { shown?: { mine: number } }).shown?.mine, 1);
  const later = await studentBlocks(T.tenantId, course, lesson.blocks, { studentId: "s3", live: false });
  assert.equal((later[0] as { shown?: unknown }).shown, undefined, "afterwards, a set hidden from students shows nothing");
  const r = await saveGroupSet(T, course, set.id, { baseVersion: set.version, studentsSee: true }, roster);
  assert.ok(r.ok);
  const later2 = await studentBlocks(T.tenantId, course, lesson.blocks, { studentId: "s3", live: false });
  assert.deepEqual((later2[0] as { shown?: { groups: unknown[] } }).shown?.groups, [{ name: "B", members: ["Ben", "Cy"] }]);
  assert.equal((await studentBlocks(B.tenantId, course, lesson.blocks, { studentId: "s3", live: true }))[0].type, "groups");
  assert.equal(((await studentBlocks(B.tenantId, course, lesson.blocks, { studentId: "s3", live: true }))[0] as { shown?: unknown }).shown, undefined, "another school learns nothing");
  assert.equal((forStudent(teacher[0]) as { shown?: unknown }).shown, undefined);

  // A save with the teacher's filled-in blocks stores no names.
  const saved = await saveLesson(T, lesson.id, { baseVersion: lesson.version, blocks: teacher });
  assert.ok(saved.ok);
  const row = await db.query("SELECT blocks::text AS b FROM lessons WHERE id = $1", [lesson.id]);
  assert.ok(!String(row[0].b).includes("Ben"), "group names are never written into the lesson");
});
