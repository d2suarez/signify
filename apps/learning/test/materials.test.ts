import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses } from "../src/lib/courses";
import { createLesson } from "../src/lib/lessons";
import { createUnit, deleteUnit, listUnits } from "../src/lib/units";
import { createResource, listResources, getResource, ResourceError, type Who } from "../src/lib/resources";
import { itemPlaces, moveItem, moveItemsToUnit } from "../src/lib/organize";
import { copyContent } from "../src/lib/sections";
import { googleEmbed } from "../src/lib/embeds";

// Any material in a folder (migration 027, teacher story 01 step A13).

let db: Db;
const T = "school-a";
const teacher: Who = { tenantId: T, userId: "t1", role: "teacher" };
const student: Who = { tenantId: T, userId: "s1", role: "student" };
let course = "", other = "", copyTo = "";

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
  [course, other, copyTo] = (await myCourses(T, [
    { id: "k-bible", name: "Bible", role: "teacher" },
    { id: "k-art", name: "Art", role: "teacher" },
    { id: "k-bible-26", name: "Bible 26", role: "teacher" },
  ], "t1")).map((c) => c.id);
});
after(() => db.close());

test("googleEmbed: Slides, Docs, Sheets, Forms and Drive files show in place; nothing else does", () => {
  const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
  assert.deepEqual(googleEmbed(`https://docs.google.com/presentation/d/${id}/edit#slide=id.p`),
    { kind: "slides", id, src: `https://docs.google.com/presentation/d/${id}/embed?start=false&loop=false` });
  assert.equal(googleEmbed(`https://docs.google.com/a/rasda.org/document/d/${id}/edit`)?.src, `https://docs.google.com/document/d/${id}/preview`);
  assert.equal(googleEmbed(`https://docs.google.com/spreadsheets/d/${id}/edit?gid=0`)?.kind, "sheet");
  assert.equal(googleEmbed(`https://docs.google.com/forms/d/e/${id}/viewform`)?.src, `https://docs.google.com/forms/d/e/${id}/viewform?embedded=true`);
  assert.equal(googleEmbed(`https://drive.google.com/file/d/${id}/view?usp=sharing`)?.src, `https://drive.google.com/file/d/${id}/preview`);
  assert.equal(googleEmbed(`https://drive.google.com/open?id=${id}`)?.kind, "drive");
  for (const bad of [
    `http://docs.google.com/document/d/${id}/edit`, // not https
    `https://docs.google.com.evil.example/document/d/${id}/edit`,
    `https://docs.google.com/document/d/<script>/edit`,
    "https://drive.google.com/drive/folders/abc", "https://example.org/x", "javascript:alert(1)", "",
  ]) assert.equal(googleEmbed(bad), null, bad);
});

let unit = "", chapter = "", lesson = "", video = "", slides = "", poll = "";
test("materials: made in a folder, in one order with its lessons; students see only what's shown", async () => {
  unit = (await createUnit(teacher, course, "Unit 3")).id;
  chapter = (await createUnit(teacher, course, "Chapter 7", unit)).id;
  lesson = (await createLesson(teacher, course, "Acts 2", [], chapter)).id;
  video = (await createResource(teacher, course, { block: { type: "link", title: "Pentecost video", url: "https://youtu.be/dQw4w9WgXcQ" }, unitId: chapter, visible: true })).id;
  slides = (await createResource(teacher, course, { block: { type: "link", title: "Acts slides", url: "https://docs.google.com/presentation/d/1AbCdEfGhIjKlMnOp/edit" }, unitId: chapter })).id;
  poll = (await createResource(teacher, course, { block: { type: "poll", question: "Ready?", choices: [{ id: "a", text: "Yes", correct: true }] }, unitId: chapter, visible: true })).id;
  await createResource(teacher, course, { block: { type: "link", title: "Library only", url: "https://example.org" } });

  const places = await itemPlaces(teacher, course);
  assert.deepEqual([lesson, video, slides, poll].map((x, i) => places.get(`${i ? "resource" : "lesson"}:${x}`)?.position ?? null), [0, 1, 2, 3],
    "a material goes after what the folder already holds");
  assert.equal(places.get(`resource:${video}`)?.studentView, "list");
  assert.equal(places.get(`resource:${slides}`)?.studentView, "hidden");
  assert.equal(places.get(`resource:${poll}`)?.studentView, "hidden", "a poll can never be shown to students");
  assert.equal([...places.keys()].filter((k) => k.startsWith("resource:")).length, 3, "the library-only resource has no folder place");

  const seen = await listResources(student, course);
  assert.deepEqual(seen.map((r) => [r.title, r.unitId]), [["Pentecost video", chapter]]);
  assert.equal(await getResource(student, course, slides), null);
});

test("materials: never in another class's folder", async () => {
  const art = await createUnit(teacher, other, "Art unit");
  await assert.rejects(createResource(teacher, course, { block: { type: "text", title: "x", body: "y" }, unitId: art.id }), ResourceError);
});

test("materials: moved and reordered like lessons; out of every folder they stay in Resources", async () => {
  assert.equal(await moveItem(teacher, course, `resource:${slides}`, -1), true);
  let places = await itemPlaces(teacher, course);
  assert.ok(places.get(`resource:${slides}`)!.position! < places.get(`resource:${video}`)!.position!);
  assert.equal(await moveItemsToUnit(teacher, course, [`resource:${video}`], unit), 1);
  const [r] = await db.query("SELECT unit_id FROM class_resources WHERE id = $1", [video]);
  assert.equal(r.unit_id, unit);
  await moveItemsToUnit(teacher, course, [`resource:${poll}`], null);
  places = await itemPlaces(teacher, course);
  assert.equal(places.has(`resource:${poll}`), false);
  assert.ok((await listResources(teacher, course)).some((x) => x.id === poll), "still in the Resources list");
});

test("materials: deleting a folder moves them up; a unit's go back to the Resources list", async () => {
  await deleteUnit(teacher, course, chapter);
  const [s] = await db.query("SELECT unit_id, unit_position FROM class_resources WHERE id = $1", [slides]);
  assert.equal(s.unit_id, unit);
  assert.notEqual(s.unit_position, null);
  const keep = (await createUnit(teacher, course, "Unit 4")).id;
  const m = await createResource(teacher, course, { block: { type: "text", title: "Notes", body: "Read." }, unitId: keep });
  await deleteUnit(teacher, course, keep);
  const [n] = await db.query("SELECT unit_id, unit_position, archived FROM class_resources WHERE id = $1", [m.id]);
  assert.deepEqual([n.unit_id, n.unit_position, n.archived], [null, null, false]);
});

test("copy: a copied folder brings its materials, hidden, in their places", async () => {
  const r = await copyContent(teacher, course, copyTo, { units: [unit] });
  assert.equal(r.units, 1);
  const [u] = await listUnits(teacher, copyTo);
  const copied = (await listResources(teacher, copyTo)).filter((x) => x.unitId === u.id).map((x) => [x.title, x.visible]);
  assert.deepEqual(copied.sort(), [["Acts slides", false], ["Pentecost video", false]]);
});
