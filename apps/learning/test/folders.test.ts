import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses } from "../src/lib/courses";
import { createLesson } from "../src/lib/lessons";
import { createAssignment } from "../src/lib/assignments";
import {
  createUnit, listUnits, moveUnit, setUnitParent, deleteUnit, orderTree, subtreeIds, unitChoices, FolderError, MAX_DEPTH,
} from "../src/lib/units";
import { moveItemsToUnit } from "../src/lib/organize";
import { copyContent, sourceContents } from "../src/lib/sections";

// Folders inside folders (migration 026, teacher story 01): Unit 3 > Chapter 7.

let db: Db;
const T = "school-a";
const C = { tenantId: T, userId: "t1" };
let course = "", other = "", copyTo = "";

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
  [course, other, copyTo] = (await myCourses(T, [
    { id: "k-hist", name: "History", role: "teacher" },
    { id: "k-art", name: "Art", role: "teacher" },
    { id: "k-hist-26", name: "History 26", role: "teacher" },
  ], "t1")).map((c) => c.id);
});
after(() => db.close());

const titles = async () => (await listUnits(C, course)).map((u) => `${"  ".repeat(u.depth)}${u.title}`);

test("orderTree: tree order with depth and path; a missing parent or a loop counts as top level", () => {
  const row = (id: string, parentId: string | null, position = 0) => ({ id, courseId: "c", title: id.toUpperCase(), position, parentId });
  const t = orderTree([row("a", null, 0), row("b", null, 1), row("a1", "a", 0), row("a1x", "a1", 0), row("lost", "gone"), row("x", "y"), row("y", "x")]);
  assert.deepEqual(t.map((u) => [u.id, u.depth, u.path]), [
    ["a", 0, "A"], ["a1", 1, "A › A1"], ["a1x", 2, "A › A1 › A1X"], ["b", 0, "B"], ["lost", 0, "LOST"],
    ["x", 0, "X"], ["y", 1, "X › Y"],
  ]);
  assert.deepEqual([...subtreeIds(t, "a")].sort(), ["a", "a1", "a1x"]);
  assert.deepEqual(unitChoices(t).find((c) => c.id === "a1x"), { id: "a1x", title: "A › A1 › A1X", label: " ".repeat(6) + "↳ A1X" });
});

let unit3 = "", ch7 = "", ch8 = "", unit4 = "";
test("folders: a folder inside a unit, and inside that, in the teacher's order", async () => {
  unit3 = (await createUnit(C, course, "Unit 3")).id;
  unit4 = (await createUnit(C, course, "Unit 4")).id;
  ch7 = (await createUnit(C, course, "Chapter 7", unit3)).id;
  const c8 = await createUnit(C, course, "Chapter 8", unit3);
  ch8 = c8.id;
  assert.equal(c8.depth, 1);
  assert.equal(c8.path, "Unit 3 › Chapter 8");
  await createUnit(C, course, "Readings", ch7);
  assert.deepEqual(await titles(), ["Unit 3", "  Chapter 7", "    Readings", "  Chapter 8", "Unit 4"]);
  // Up and down move a folder among its siblings only.
  assert.equal(await moveUnit(C, course, ch8, -1), true);
  assert.deepEqual(await titles(), ["Unit 3", "  Chapter 8", "  Chapter 7", "    Readings", "Unit 4"]);
  assert.equal(await moveUnit(C, course, ch8, -1), false, "already first inside Unit 3");
  assert.equal(await moveUnit(C, course, unit3, 1), true);
  assert.deepEqual(await titles(), ["Unit 4", "Unit 3", "  Chapter 8", "  Chapter 7", "    Readings"]);
  await moveUnit(C, course, unit3, -1);
});

test("folders: never inside another course's folder, and never deeper than MAX_DEPTH", async () => {
  const art = await createUnit(C, other, "Art unit");
  await assert.rejects(createUnit(C, course, "Sneaky", art.id), FolderError);
  let parent = unit4;
  for (let d = 1; d < MAX_DEPTH; d++) parent = (await createUnit(C, course, `Level ${d}`, parent)).id;
  await assert.rejects(createUnit(C, course, "Too deep", parent), FolderError);
  // Clean up the deep chain (deleting moves its folders up, so delete from the bottom).
  for (const u of (await listUnits(C, course)).filter((u) => u.title.startsWith("Level ")).reverse()) await deleteUnit(C, course, u.id);
  assert.deepEqual(await titles(), ["Unit 3", "  Chapter 8", "  Chapter 7", "    Readings", "Unit 4"]);
});

test("folders: moving a folder takes everything in it; never into itself or too deep", async () => {
  const lesson = await createLesson(C, course, "Map work", [], ch7);
  assert.equal(await setUnitParent(C, course, unit3, ch7), false, "not inside its own folder");
  assert.equal(await setUnitParent(C, course, unit3, unit3), false);
  assert.equal(await setUnitParent(C, course, ch7, unit4), true);
  assert.deepEqual(await titles(), ["Unit 3", "  Chapter 8", "Unit 4", "  Chapter 7", "    Readings"]);
  const [l] = await db.query("SELECT unit_id FROM lessons WHERE id = $1", [lesson.id]);
  assert.equal(l.unit_id, ch7, "its lesson moved with it");
  assert.equal(await setUnitParent(C, course, ch7, null), true, "to the top level: a unit of its own");
  assert.deepEqual(await titles(), ["Unit 3", "  Chapter 8", "Unit 4", "Chapter 7", "  Readings"]);
  await setUnitParent(C, course, ch7, unit3);
  await moveUnit(C, course, ch7, -1);
  assert.deepEqual(await titles(), ["Unit 3", "  Chapter 7", "    Readings", "  Chapter 8", "Unit 4"]);
  // A chain as deep as allowed can't go under another folder.
  let parent = unit4;
  const chain: string[] = [];
  for (let d = 1; d < MAX_DEPTH; d++) { parent = (await createUnit(C, course, `Deep ${d}`, parent)).id; chain.push(parent); }
  assert.equal(await setUnitParent(C, course, unit4, unit3), false, "Unit 4's folders would go past MAX_DEPTH");
  for (const id of chain.reverse()) await deleteUnit(C, course, id);
});

test("folders: deleting one moves its folders, lessons and assignments up into its parent", async () => {
  const readings = (await listUnits(C, course)).find((u) => u.title === "Readings")!;
  const inCh7 = await createAssignment(C, course, { title: "Worksheet", unitId: ch7, kind: "online" });
  const inReadings = await createLesson(C, course, "Chapter text", [], readings.id);
  const already = await createLesson(C, course, "Unit 3 intro", [], unit3);
  await moveItemsToUnit(C, course, [`lesson:${already.id}`], unit3);
  assert.equal(await deleteUnit(C, course, ch7), true);
  assert.deepEqual(await titles(), ["Unit 3", "  Chapter 8", "  Readings", "Unit 4"]);
  const rows = await db.query(
    "SELECT title, unit_id, position FROM (SELECT title, unit_id, position FROM lessons UNION ALL SELECT title, unit_id, position FROM assignments) x WHERE unit_id = $1 ORDER BY position",
    [unit3]);
  // The parent's own item stays first; Chapter 7's items follow it.
  assert.deepEqual(rows.map((r) => r.title), ["Unit 3 intro", "Map work", "Worksheet"]);
  const [r] = await db.query("SELECT unit_id FROM lessons WHERE id = $1", [inReadings.id]);
  assert.equal(r.unit_id, readings.id, "a folder inside keeps its own items");
  assert.ok(inCh7.id);
  // A top-level unit's folders become units; its items leave any unit.
  await deleteUnit(C, course, unit3);
  assert.deepEqual(await titles(), ["Unit 4", "Chapter 8", "Readings"]);
  const [w] = await db.query("SELECT unit_id FROM assignments WHERE id = $1", [inCh7.id]);
  assert.equal(w.unit_id, null);
});

test("copy: a picked folder brings its folders, in place, with what's in them", async () => {
  const a = (await createUnit(C, course, "Unit 5")).id;
  const b = (await createUnit(C, course, "Chapter 9", a)).id;
  const c = (await createUnit(C, course, "Primary sources", b)).id;
  await createLesson(C, course, "Letters", [], c);
  const contents = await sourceContents(C, course);
  assert.ok(contents);
  assert.ok(contents.units.some((u) => u.title === "Unit 5 › Chapter 9 › Primary sources"), "picked by path");
  const r = await copyContent(C, course, copyTo, { units: [a] });
  assert.equal(r.units, 3);
  assert.equal(r.lessons, 1);
  const copied = await listUnits(C, copyTo);
  assert.deepEqual(copied.map((u) => u.path), ["Unit 5", "Unit 5 › Chapter 9", "Unit 5 › Chapter 9 › Primary sources"]);
  const [l] = await db.query("SELECT unit_id FROM lessons WHERE course_id = $1 AND title = 'Letters'", [copyTo]);
  assert.equal(l.unit_id, copied[2].id);
  // Picking only an inner folder copies it (and its folders) as a unit of its own.
  await copyContent(C, course, copyTo, { units: [b] });
  assert.deepEqual((await listUnits(C, copyTo)).map((u) => u.path).slice(3), ["Chapter 9", "Chapter 9 › Primary sources"]);
});
