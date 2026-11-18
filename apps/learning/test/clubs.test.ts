import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses } from "../src/lib/courses";
import { createAssignment } from "../src/lib/assignments";
import { setKind, courseKind, addEvent, listEvents, archiveEvent, EventError } from "../src/lib/clubs";
import { studentWork } from "../src/lib/family";

let db: Db;
const T = { tenantId: "school-a", userId: "t1" };
const B = { tenantId: "school-b", userId: "t1" };
let chess = "";

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
  [chess] = (await myCourses(T.tenantId, [{ id: "k-chess", name: "Chess Club", role: "teacher" }], T.userId)).map((c) => c.id);
});
after(() => db.close());

test("clubs: a class becomes a club and back; another school can't", async () => {
  assert.equal(await courseKind(T, chess), "class", "every class starts as a class");
  assert.equal(await setKind(B, chess, "club"), false);
  assert.equal(await setKind(T, chess, "club"), true);
  const [c] = await myCourses(T.tenantId, [{ id: "k-chess", name: "Chess Club", role: "student" }], "s1");
  assert.equal(c.kind, "club");
});

test("clubs: no assignments in a club, and no work or grades in a student's This week", async () => {
  await assert.rejects(createAssignment(T, chess, { title: "Test" }), /no assignments/);
  const work = await studentWork(T, [{ id: "k-chess", name: "Chess Club", role: "student" }], "s1");
  assert.deepEqual(work, []);
});

test("clubs: dates: upcoming first, then earlier ones; title and day required; only in a club", async () => {
  await assert.rejects(addEvent(T, chess, { title: "", onDay: "2026-12-01" }), EventError);
  await assert.rejects(addEvent(T, chess, { title: "Match", onDay: "Dec 1" }), EventError);
  const a = await addEvent(T, chess, { title: "  Tournament ", onDay: "2026-12-05", startTime: "15:30", place: "Gym" });
  assert.equal(a.title, "Tournament");
  assert.equal(a.startTime, "15:30");
  await addEvent(T, chess, { title: "Practice", onDay: "2026-12-02", startTime: "25:99" });
  await addEvent(T, chess, { title: "Kickoff", onDay: "2026-11-01" });
  const ev = await listEvents(T, chess, "2026-11-17");
  assert.deepEqual(ev.upcoming.map((e) => e.title), ["Practice", "Tournament"]);
  assert.equal(ev.upcoming[0].startTime, "", "a bad time is dropped, not guessed");
  assert.deepEqual(ev.past.map((e) => e.title), ["Kickoff"]);
  assert.deepEqual((await listEvents(B, chess, "2026-01-01")).upcoming, [], "another school sees none");
  assert.equal(await archiveEvent(B, chess, a.id), false);
  assert.equal(await archiveEvent(T, chess, a.id), true);
  assert.deepEqual((await listEvents(T, chess, "2026-11-17")).upcoming.map((e) => e.title), ["Practice"]);
  const [cls] = await myCourses(T.tenantId, [{ id: "k-bio", name: "Biology", role: "teacher" }], T.userId);
  await assert.rejects(addEvent(T, cls.id, { title: "x", onDay: "2026-12-01" }), EventError, "classes don't have club dates");
});

test("clubs: the academic pages and APIs use academicAccess, which refuses clubs", () => {
  const SRC = path.join(__dirname, "..", "src", "app");
  for (const f of ["courses/[id]/gradebook/page.tsx", "courses/[id]/settings/page.tsx", "courses/[id]/import/page.tsx",
    "api/courses/[id]/facts/route.ts", "api/courses/[id]/import/route.ts", "api/courses/[id]/accommodations/route.ts"]) {
    assert.match(fs.readFileSync(path.join(SRC, f), "utf8"), /academicAccess as courseAccess/, f);
  }
  const access = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "access.ts"), "utf8");
  assert.match(access, /access\.course\.kind !== "club"/);
});
