import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import {
  DEFAULT_SCHOOL_WIDGETS, ROSTER_KINDS, WIDGET_KINDS, classStudentDefaults, fillSeats, forViewer, makeGroups,
  normalizeSchoolWidgets, normalizeSeating, resolveWidgets, type SchoolWidgets,
} from "../src/lib/widgets";
import { restoreSetting, saveWidgets, schoolWidgets, settingHistory } from "../src/lib/school-grading";
import {
  classStudentWidgets, getSeating, railWidgets, saveOwnWidgets, saveSeating, setClassStudentWidgets,
} from "../src/lib/widget-store";
import { dict } from "../src/lib/i18n";

let db: Db;
before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
});
after(() => db.close());

let n = 0;
const school = () => `school-wg${++n}`;
async function course(tenantId: string): Promise<string> {
  const [r] = await db.query("INSERT INTO courses (tenant_id, id_class_id, name) VALUES ($1, $2, 'Class') RETURNING id", [tenantId, `cls-${++n}`]);
  return String(r.id);
}
const rosterless = (kinds: string[]) => kinds.every((k) => !ROSTER_KINDS.has(k as never));

// ---------- the layers, pure ----------

test("widgets: Desmond's starting defaults", () => {
  const s = DEFAULT_SCHOOL_WIDGETS;
  assert.deepEqual(resolveWidgets({ school: s, audience: "staff", place: "class" }).widgets, ["picker", "groups", "timer", "seating"]);
  assert.deepEqual(resolveWidgets({ school: s, audience: "staff", place: "home" }).widgets, ["clock", "timer", "noise"]);
  assert.deepEqual(resolveWidgets({ school: s, audience: "student", place: "home" }).widgets, ["clock"]);
  assert.deepEqual(resolveWidgets({ school: s, audience: "student", place: "class" }).widgets, ["clock"]);
  assert.equal(resolveWidgets({ school: s, audience: "staff", place: "home" }).from, "school");
});

test("widgets: school → class (students) → own, in that order", () => {
  const s: SchoolWidgets = { ...DEFAULT_SCHOOL_WIDGETS, studentAllowed: ["clock", "timer", "noise"] };
  const cls = resolveWidgets({ school: s, audience: "student", place: "class", classStudents: ["timer", "clock"] });
  assert.deepEqual(cls.widgets, ["timer", "clock"]);
  assert.equal(cls.from, "class");
  const own = resolveWidgets({ school: s, audience: "student", place: "class", classStudents: ["timer"], own: ["noise"] });
  assert.deepEqual(own.widgets, ["noise"]);
  assert.equal(own.from, "own");
  assert.deepEqual(own.defaults, ["timer"], "back to the defaults = the teacher's choice");
  // A teacher's choice for students never changes the teacher's own tools, nor a student's at home.
  assert.deepEqual(resolveWidgets({ school: s, audience: "staff", place: "class", classStudents: ["clock"] }).widgets, s.staffClass);
  assert.deepEqual(resolveWidgets({ school: s, audience: "student", place: "home", classStudents: ["timer"] }).widgets, ["clock"]);
  // An empty own list is a choice too (no tools), not "use the defaults".
  assert.deepEqual(resolveWidgets({ school: s, audience: "staff", place: "home", own: [] }).widgets, []);
});

test("widgets: the school's policy limits what teachers choose and what students keep", () => {
  const s: SchoolWidgets = { ...DEFAULT_SCHOOL_WIDGETS, studentAllowed: ["clock"] };
  // Outside what students may have: dropped from the class choice and from a student's own list.
  assert.deepEqual(classStudentDefaults(s, ["timer", "clock", "noise"]), ["clock"]);
  assert.deepEqual(resolveWidgets({ school: s, audience: "student", place: "home", own: ["timer", "clock"] }).widgets, ["clock"]);
  assert.deepEqual(resolveWidgets({ school: s, audience: "student", place: "home" }).addable, []);
  // Teachers not allowed to choose: the class's stored choice is ignored.
  const closed = { ...s, studentAllowed: ["clock", "timer"] as SchoolWidgets["studentAllowed"], teachersChoose: false };
  assert.equal(classStudentDefaults(closed, ["timer"]), null);
  assert.deepEqual(resolveWidgets({ school: closed, audience: "student", place: "class", classStudents: ["timer"] }).widgets, closed.studentClass);
  // Taking a tool away from students later takes it out of every student's list at once.
  const later = normalizeSchoolWidgets({ ...DEFAULT_SCHOOL_WIDGETS, studentAllowed: ["timer"] });
  assert.deepEqual(later.studentHome, [], "clock no longer allowed, so it isn't a student default either");
  assert.deepEqual(resolveWidgets({ school: later, audience: "student", place: "home", own: ["clock", "timer"] }).widgets, ["timer"]);
});

test("widgets: students never get a tool that shows other students' names", () => {
  // Even a school setting written by hand with roster tools for students.
  const s = normalizeSchoolWidgets({
    staffHome: [], staffClass: [], studentHome: ["picker", "clock"], studentClass: ["seating", "groups", "clock"],
    studentAllowed: [...WIDGET_KINDS], teachersChoose: true,
  });
  assert.ok(rosterless(s.studentAllowed) && rosterless(s.studentHome) && rosterless(s.studentClass));
  for (const place of ["home", "class"] as const) {
    const r = resolveWidgets({ school: s, audience: "student", place, classStudents: ["picker", "groups", "seating"], own: ["seating", "picker", "groups", "clock"] });
    assert.ok(rosterless(r.widgets), place);
    assert.ok(rosterless(r.addable), place);
    assert.ok(rosterless(r.defaults), place);
  }
  assert.equal(classStudentDefaults(s, ["picker"])?.length, 0);
  assert.deepEqual(forViewer(["picker", "groups", "seating", "clock"], { ...s, studentAllowed: [...WIDGET_KINDS] as never }, "student"), ["clock"]);
  // Staff have every tool.
  assert.deepEqual(resolveWidgets({ school: s, audience: "staff", place: "home", own: [] }).addable, [...WIDGET_KINDS]);
});

test("widgets: unknown kinds and repeats are dropped", () => {
  const s = normalizeSchoolWidgets({ staffHome: ["clock", "clock", "rocket", 5, "timer"] });
  assert.deepEqual(s.staffHome, ["clock", "timer"]);
  assert.deepEqual(s.staffClass, DEFAULT_SCHOOL_WIDGETS.staffClass, "missing = the default");
  assert.deepEqual(normalizeSchoolWidgets("nonsense"), DEFAULT_SCHOOL_WIDGETS);
});

// ---------- groups and seats, pure ----------

test("widgets: groups are balanced and hold everyone once", () => {
  const people = Array.from({ length: 10 }, (_, i) => `s${i}`);
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const byCount = makeGroups(people, { count: 3 }, rand);
  assert.deepEqual(byCount.map((g) => g.length).sort(), [3, 3, 4]);
  const bySize = makeGroups(people, { size: 4 }, rand);
  assert.deepEqual(bySize.map((g) => g.length).sort(), [3, 3, 4]);
  assert.deepEqual(bySize.flat().sort(), people.slice().sort());
  assert.equal(makeGroups(people, { count: 50 }, rand).length, 10, "never more groups than people");
  assert.deepEqual(makeGroups([], { count: 3 }, rand), []);
});

test("widgets: seating keeps seats inside the room, one per person, ids only", () => {
  const s = normalizeSeating({ rows: 2, cols: 2, seats: { "0-0": "a", "0-1": "a", "1-1": "b", "5-5": "c", "x": "d", "1-0": { name: "Eve" } } });
  assert.deepEqual(s, { rows: 2, cols: 2, seats: { "0-0": "a", "1-1": "b" } });
  assert.deepEqual(normalizeSeating({ rows: 99, cols: 0 }), { rows: 10, cols: 1, seats: {} });
  assert.deepEqual(normalizeSeating({ rows: "x" }), { rows: 5, cols: 6, seats: {} });
  const known = normalizeSeating({ rows: 2, cols: 2, seats: { "0-0": "a", "1-1": "gone" } }, new Set(["a"]));
  assert.deepEqual(known.seats, { "0-0": "a" });
  const filled = fillSeats({ rows: 2, cols: 2, seats: { "1-1": "a" } }, ["a", "b", "c", "d", "e"], Math.random);
  assert.equal(filled.seats["1-1"], "a", "already seated stays");
  assert.equal(new Set(Object.values(filled.seats)).size, 4, "four desks, four people");
});

// ---------- stored ----------

test("widgets: the school's setting is versioned, stale saves refused, restore is a new save", async () => {
  const t = school();
  const me = { tenantId: t, userId: "admin-1" };
  assert.deepEqual((await schoolWidgets(t)).value, DEFAULT_SCHOOL_WIDGETS);
  const a = await saveWidgets(me, { ...DEFAULT_SCHOOL_WIDGETS, staffHome: ["clock"] }, 0);
  assert.ok(a.ok);
  const stale = await saveWidgets(me, { ...DEFAULT_SCHOOL_WIDGETS, staffHome: ["timer"] }, 0);
  assert.ok(!stale.ok && stale.reason === "stale");
  const b = await saveWidgets(me, { ...DEFAULT_SCHOOL_WIDGETS, staffHome: ["noise"] }, 1);
  assert.ok(b.ok);
  const hist = await settingHistory(t, "widgets");
  assert.equal(hist.length, 1);
  assert.deepEqual(hist[0].value.staffHome, ["clock"]);
  assert.ok(await restoreSetting(me, "widgets", hist[0].id, 2));
  const now = await schoolWidgets(t);
  assert.equal(now.version, 3);
  assert.deepEqual(now.value.staffHome, ["clock"]);
});

test("widgets: one school's setting, lists and charts never reach another", async () => {
  const a = school(), b = school();
  await saveWidgets({ tenantId: a, userId: "admin-a" }, { ...DEFAULT_SCHOOL_WIDGETS, staffHome: ["noise"] }, 0);
  assert.deepEqual((await schoolWidgets(b)).value, DEFAULT_SCHOOL_WIDGETS, "school B untouched");
  // The same Signify id in two schools keeps two lists.
  await saveOwnWidgets({ tenantId: a, userId: "u1" }, "staff", { courseId: null }, ["timer"]);
  assert.deepEqual((await railWidgets({ tenantId: b, userId: "u1" }, "staff", { courseId: null })).widgets, ["clock", "timer", "noise"]);
  assert.deepEqual((await railWidgets({ tenantId: a, userId: "u1" }, "staff", { courseId: null })).widgets, ["timer"]);
  // Another school's class: nothing set, nothing read.
  const ca = await course(a);
  assert.ok((await setClassStudentWidgets({ tenantId: a, userId: "t" }, ca, "teacher", ["timer"])).ok);
  assert.equal((await classStudentWidgets({ tenantId: b, userId: "t" }, ca)).chosen, null);
  await setClassStudentWidgets({ tenantId: b, userId: "t" }, ca, "teacher", ["clock"]);
  assert.deepEqual((await classStudentWidgets({ tenantId: a, userId: "t" }, ca)).chosen, ["timer"], "B's write didn't touch A's class");
  await saveSeating({ tenantId: a, userId: "t" }, ca, "teacher", { rows: 2, cols: 2, seats: { "0-0": "s1" } }, 0, new Set(["s1"]));
  assert.deepEqual((await getSeating({ tenantId: b, userId: "t" }, ca, "teacher"))?.layout.seats, {});
  const fromB = await saveSeating({ tenantId: b, userId: "t" }, ca, "teacher", { rows: 1, cols: 1, seats: {} }, 0, new Set());
  assert.ok(!fromB.ok, "no chart written into another school's class");
  assert.deepEqual((await getSeating({ tenantId: a, userId: "t" }, ca, "teacher"))?.layout.seats, { "0-0": "s1" });
});

test("widgets: a person's own list per context, back to the defaults, and students' saves filtered", async () => {
  const t = school();
  const c = await course(t);
  const me = { tenantId: t, userId: "teach" };
  await saveOwnWidgets(me, "staff", { courseId: c, role: "teacher" }, ["seating", "clock"]);
  assert.deepEqual((await railWidgets(me, "staff", { courseId: c, role: "teacher" })).widgets, ["seating", "clock"]);
  assert.deepEqual((await railWidgets(me, "staff", { courseId: null })).widgets, ["clock", "timer", "noise"], "home separate");
  const reset = await saveOwnWidgets(me, "staff", { courseId: c, role: "teacher" }, null);
  assert.deepEqual(reset.widgets, DEFAULT_SCHOOL_WIDGETS.staffClass);
  // A student asking for roster tools gets only what students may have.
  const kid = { tenantId: t, userId: "kid" };
  const r = await saveOwnWidgets(kid, "student", { courseId: c, role: "student" }, ["picker", "seating", "groups", "timer", "noise"]);
  assert.deepEqual(r.widgets, ["timer"]);
  const [row] = await db.query("SELECT widgets FROM widget_layouts WHERE tenant_id = $1 AND user_id = 'kid'", [t]);
  assert.deepEqual(row.widgets, ["timer"], "never even stored");
  // In a class, the class's role decides: a staff member who is a student there gets student tools.
  const s2 = await railWidgets({ tenantId: t, userId: "office" }, "staff", { courseId: c, role: "student" });
  assert.ok(rosterless(s2.widgets) && rosterless(s2.addable));
});

test("widgets: teachers set their students' defaults only within the school's policy", async () => {
  const t = school();
  const c = await course(t);
  const teacher = { tenantId: t, userId: "teach" };
  assert.deepEqual(await setClassStudentWidgets({ tenantId: t, userId: "kid" }, c, "student", ["timer"]), { ok: false, reason: "notTeacher" });
  const r = await setClassStudentWidgets(teacher, c, "teacher", ["picker", "timer", "noise", "clock"]);
  assert.deepEqual(r, { ok: true, chosen: ["timer", "clock"] }, "only what students may have");
  assert.deepEqual((await railWidgets({ tenantId: t, userId: "kid" }, "student", { courseId: c, role: "student" })).widgets, ["timer", "clock"]);
  // The school stops teachers choosing: refused, and the stored choice no longer applies.
  await saveWidgets({ tenantId: t, userId: "admin" }, { ...DEFAULT_SCHOOL_WIDGETS, teachersChoose: false }, 0);
  assert.deepEqual(await setClassStudentWidgets(teacher, c, "teacher", ["clock"]), { ok: false, reason: "notAllowed" });
  assert.deepEqual((await railWidgets({ tenantId: t, userId: "kid" }, "student", { courseId: c, role: "student" })).widgets, ["clock"]);
  assert.equal((await classStudentWidgets(teacher, c)).chosen, null);
});

test("widgets: seating charts are teachers' only, version-checked, live roster ids only", async () => {
  const t = school();
  const c = await course(t);
  const me = { tenantId: t, userId: "teach" };
  assert.equal(await getSeating({ tenantId: t, userId: "kid" }, c, "student"), null);
  assert.deepEqual(await saveSeating({ tenantId: t, userId: "kid" }, c, "student", { rows: 1, cols: 1, seats: {} }, 0, new Set()), { ok: false, reason: "notTeacher" });
  const first = await saveSeating(me, c, "teacher", { rows: 2, cols: 3, seats: { "0-0": "s1", "0-1": "left-school" } }, 0, new Set(["s1", "s2"]));
  assert.ok(first.ok);
  assert.deepEqual(first.ok && first.chart, { layout: { rows: 2, cols: 3, seats: { "0-0": "s1" } }, version: 1 });
  const stale = await saveSeating(me, c, "teacher", { rows: 1, cols: 1, seats: {} }, 0, new Set(["s1"]));
  assert.ok(!stale.ok && stale.reason === "stale" && stale.current.version === 1);
  assert.deepEqual((await getSeating(me, c, "teacher"))?.layout.seats, { "0-0": "s1" }, "never written over");
  // Only ids are stored, never a name.
  const [row] = await db.query("SELECT layout FROM seating_charts WHERE tenant_id = $1", [t]);
  assert.deepEqual(Object.keys(row.layout as object).sort(), ["cols", "rows", "seats"]);
});

test("widgets: every rail word has Spanish", () => {
  const en = dict("en"), es = dict("es");
  const missing = Object.keys(en).filter((k) => k.startsWith("wg") && es[k as keyof typeof es] === en[k as keyof typeof en] && !["wgMin"].includes(k));
  assert.deepEqual(missing, []);
});
