import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { isSchoolAdminRole } from "../src/lib/roles";
import { myCourses } from "../src/lib/courses";
import { createPost, moderatePost, addComment, moderateComment, type Viewer } from "../src/lib/updates";
import { requestShare, requestsToAnswer, answerShare, renameCatalog, catalogOf } from "../src/lib/sections";
import { schoolScales, saveScales, schoolLate, saveLate } from "../src/lib/school-grading";
import { DEFAULT_SCALES } from "../src/lib/grade-scale";

/**
 * Signify ID's local_admin is a school admin in Learning (Desmond,
 * 2026-11-17), and only ever at their own school: every admin power is
 * worked out from the claim's role but applied to the claim's tenant.
 */

let db: Db;
const A = "school-a", B = "school-b";
const localAdmin = (tenantId: string, userId: string) => ({ tenantId, userId, admin: isSchoolAdminRole("local_admin") });

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
});
after(() => db.close());

test("local admin: counts as a school admin, like admin and super_admin", () => {
  assert.equal(isSchoolAdminRole("local_admin"), true);
  assert.equal(isSchoolAdminRole("teacher"), false);
  const access = fs.readFileSync(path.join(__dirname, "..", "src", "lib", "access.ts"), "utf8");
  assert.match(access, /return isSchoolAdminRole\(me\.role\);/, "isSchoolAdmin is the one check, used everywhere");
});

test("local admin: answers sharing requests and renames courses at their school only", async () => {
  const [mine] = await myCourses(A, [{ id: "k1", name: "Bible 9", role: "teacher" }], "t-ana");
  const [theirs] = await myCourses(A, [{ id: "k2", name: "Bible 10", role: "teacher" }], "t-ben");
  const req = await requestShare({ tenantId: A, userId: "t-ana", name: "Ana" }, theirs.id, { forCourseId: mine.id });
  const other = localAdmin(B, "admin-b");
  assert.deepEqual(await requestsToAnswer(other), [], "another school's local admin sees nothing");
  assert.equal(await answerShare(other, req!.id, "approve"), false, "and can't answer");
  assert.equal(await renameCatalog(other, (await catalogOf({ tenantId: A, userId: "t-ana" }, mine.id))!.id, "x"), false);
  const here = localAdmin(A, "admin-a");
  assert.equal((await requestsToAnswer(here)).length, 1);
  assert.equal(await answerShare(here, req!.id, "approve"), true);
  assert.equal(await renameCatalog(here, (await catalogOf({ tenantId: A, userId: "t-ana" }, mine.id))!.id, "Bible 9: Foundations"), true);
});

test("local admin: moderates whole-school updates at their school only", async () => {
  const v = (tenantId: string, userId: string, over: Partial<Viewer> = {}): Viewer => ({
    tenantId, userId, name: userId, kind: "staff", schoolAdmin: false, canPostSchool: false, courses: new Map(), childCourses: new Set(), ...over,
  });
  const post = await createPost(v(A, "office", { canPostSchool: true }), { courseId: null, body: "Chapel at 10" });
  const comment = await addComment(v(A, "t1"), post.id, "Thanks");
  const otherAdmin = v(B, "admin-b", { schoolAdmin: isSchoolAdminRole("local_admin") });
  assert.equal(await moderateComment(otherAdmin, comment.id, "hide"), false);
  assert.equal(await moderatePost(otherAdmin, post.id, "hide"), false);
  const hereAdmin = v(A, "admin-a", { schoolAdmin: isSchoolAdminRole("local_admin") });
  assert.equal(await moderateComment(hereAdmin, comment.id, "hide"), true);
  assert.equal(await moderatePost(hereAdmin, post.id, "hide"), true);
});

test("local admin: grade scales and late policies saved by one school's admin never touch another school's", async () => {
  const b = { tenantId: B, userId: "admin-b" };
  const scalesBefore = await schoolScales(A);
  const lateBefore = await schoolLate(A);
  const changed = structuredClone(DEFAULT_SCALES);
  changed.bands[0].name = "School B's own";
  const r = await saveScales(b, changed, (await schoolScales(B)).version);
  assert.equal(r.ok, true);
  await saveLate(b, { rules: [], teachers: "no" }, (await schoolLate(B)).version);
  assert.deepEqual(await schoolScales(A), scalesBefore, "school A's scales untouched");
  assert.deepEqual(await schoolLate(A), lateBefore, "school A's late policies untouched");
});
