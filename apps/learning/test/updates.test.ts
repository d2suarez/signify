import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses } from "../src/lib/courses";
import {
  feed, thread, createPost, addComment, moderatePost, moderateComment, setCourseRules, markRead, unreadCount,
  UpdateError, type Viewer,
} from "../src/lib/updates";
import { listAnnouncements, postAnnouncement } from "../src/lib/announcements";
import { byDefault } from "../src/lib/features";

let db: Db;
const T = "school-a";
let bio = "", chess = "", art = "";

function viewer(over: Partial<Viewer> & Pick<Viewer, "userId" | "kind">): Viewer {
  return { tenantId: T, name: over.userId, schoolAdmin: false, canPostSchool: false, courses: new Map(), childCourses: new Set(), ...over };
}
let teacher: Viewer, student: Viewer, other: Viewer, parent: Viewer, admin: Viewer, office: Viewer, stranger: Viewer;

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
  [bio] = (await myCourses(T, [{ id: "k-bio", name: "Biology", role: "teacher" }], "t1")).map((c) => c.id);
  [chess] = (await myCourses(T, [{ id: "k-chess", name: "Chess Club", role: "teacher" }], "t1")).map((c) => c.id);
  [art] = (await myCourses(T, [{ id: "k-art", name: "Art", role: "teacher" }], "t2")).map((c) => c.id);
  teacher = viewer({ userId: "t1", kind: "staff", name: "Ms Teach", courses: new Map([[bio, "teacher"], [chess, "teacher"]]) });
  student = viewer({ userId: "s1", kind: "student", name: "Sam", courses: new Map([[bio, "student"], [chess, "student"]]) });
  other = viewer({ userId: "s2", kind: "student", courses: new Map([[art, "student"]]) });
  parent = viewer({ userId: "g1", kind: "parent", childCourses: new Set([bio]) });
  admin = viewer({ userId: "a1", kind: "staff", schoolAdmin: true, canPostSchool: true });
  office = viewer({ userId: "o1", kind: "staff", canPostSchool: true, name: "Office" });
  stranger = { ...teacher, tenantId: "school-b" };
});
after(() => db.close());

test("updates: migration 018 turns every announcement into a post, taken-down ones kept but unseen", async () => {
  const fresh = await openPglite("memory://");
  const dir = path.join(__dirname, "..", "migrations");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
  for (const f of fs.readdirSync(dir).filter((f) => f < "018")) fs.copyFileSync(path.join(dir, f), path.join(tmp, f));
  await migrate(fresh, tmp);
  const [c] = await fresh.query("INSERT INTO courses (tenant_id, id_class_id, name) VALUES ('s', 'k', 'C') RETURNING id");
  const [a] = await fresh.query("INSERT INTO announcements (tenant_id, course_id, title, body, created_by, created_at) VALUES ('s', $1, 'Trip', 'Bring lunch', 't', '2026-10-01T12:00:00Z') RETURNING id", [c.id]);
  await fresh.query("INSERT INTO announcements (tenant_id, course_id, body, created_by, archived) VALUES ('s', $1, 'Old', 't', true)", [c.id]);
  fs.copyFileSync(path.join(dir, "018_updates.sql"), path.join(tmp, "018_updates.sql"));
  await migrate(fresh, tmp);
  const posts = await fresh.query("SELECT * FROM posts ORDER BY created_at");
  assert.equal(posts.length, 2);
  const trip = posts.find((p) => p.id === a.id)!;
  assert.equal(trip.title, "Trip");
  assert.equal(trip.body, "Bring lunch");
  assert.equal(trip.author_id, "t");
  assert.equal(trip.status, "visible");
  assert.equal(new Date(trip.created_at as string).toISOString(), "2026-10-01T12:00:00.000Z");
  assert.equal(posts.find((p) => p.body === "Old")!.status, "deleted");
  const [{ n }] = await fresh.query("SELECT count(*)::int AS n FROM announcements_pre_018");
  assert.equal(n, 2, "the old table is kept, untouched");
  await fresh.close();
  fs.rmSync(tmp, { recursive: true });
});

test("updates: announcements still work, as the class's staff posts", async () => {
  const a = await postAnnouncement({ tenantId: T, userId: "t1", name: "Ms Teach" }, bio, { title: "Lab", body: "Goggles on" });
  assert.deepEqual((await listAnnouncements({ tenantId: T, userId: "x" }, bio)).map((x) => x.id), [a!.id]);
  const seen = await feed(student, { courseId: bio });
  assert.ok(seen.some((p) => p.id === a!.id && p.authorName === "Ms Teach"));
});

test("updates: teachers post to their class, students to theirs; strangers, other schools and other classes can't", async () => {
  const p = await createPost(teacher, { courseId: bio, title: "  Quiz  Friday ", body: "Chapter 4" });
  assert.equal(p.title, "Quiz Friday");
  const s = await createPost(student, { courseId: chess, body: "Anyone up for a match?" });
  assert.equal(s.authorKind, "student");
  await assert.rejects(createPost(student, { courseId: art, body: "x" }), (e: UpdateError) => e.code === "forbidden");
  await assert.rejects(createPost(other, { courseId: bio, body: "x" }), UpdateError);
  await assert.rejects(createPost(stranger, { courseId: bio, body: "x" }), UpdateError, "same ids, another school");
  await assert.rejects(createPost(parent, { courseId: bio, body: "x" }), UpdateError);
  await assert.rejects(createPost(teacher, { courseId: bio, body: "   " }), (e: UpdateError) => e.code === "empty");
  assert.equal((await feed(other)).some((x) => x.id === p.id), false, "another class's student doesn't see it");
  assert.equal(await thread(other, p.id), null);
  assert.equal(await thread(stranger, p.id), null);
});

test("updates: whole-school posts need the school's permission and a staff role; everyone at the school reads them", async () => {
  await assert.rejects(createPost(teacher, { courseId: "school", body: "x" }), UpdateError, "no permission from the school");
  await assert.rejects(createPost({ ...student, canPostSchool: true }, { courseId: null, body: "x" }), UpdateError, "students never");
  await assert.rejects(createPost({ ...parent, canPostSchool: true }, { courseId: null, body: "x" }), UpdateError, "parents never");
  const p = await createPost(office, { courseId: null, title: "Chapel", body: "Chapel at 10" });
  for (const v of [teacher, student, other, parent, admin]) assert.ok((await feed(v)).some((x) => x.id === p.id), v.userId);
  assert.ok((await feed(student, { school: true })).every((x) => x.courseId === null));
  assert.equal((await feed(stranger)).some((x) => x.id === p.id), false);
  // ID's default: every role but student gets a feature, so Learning's own staff check matters.
  assert.equal(byDefault("post_school_updates", "student"), false);
  assert.equal(byDefault("post_school_updates", "guardian"), true);
});

test("updates: students comment; parents read posts but never comments; unread markers", async () => {
  const p = await createPost(teacher, { courseId: bio, body: "Read 4.2" });
  assert.equal((await feed(student, { courseId: bio })).find((x) => x.id === p.id)!.unread, true);
  assert.equal((await feed(teacher, { courseId: bio })).find((x) => x.id === p.id)!.unread, false, "your own post isn't unread");
  await markRead(student, [p.id]);
  assert.equal((await feed(student, { courseId: bio })).find((x) => x.id === p.id)!.unread, false);
  const c = await addComment(student, p.id, "Done!");
  assert.equal(c.authorKind, "student");
  assert.equal((await feed(teacher, { courseId: bio })).find((x) => x.id === p.id)!.unread, true, "a new comment makes it unread again");
  const pv = await thread(parent, p.id);
  assert.ok(pv, "a parent sees the child's class post");
  assert.deepEqual(pv!.comments, [], "but no comments");
  assert.equal(pv!.post.comments, 0);
  assert.equal((await feed(parent)).find((x) => x.id === p.id)!.comments, 0);
  await assert.rejects(addComment(parent, p.id, "hi"), UpdateError);
  await assert.rejects(addComment(other, p.id, "hi"), UpdateError);
  const school = await createPost(admin, { courseId: null, body: "Spirit week" });
  assert.ok(await addComment(student, school.id, "Yay"), "students comment on school posts");
  assert.ok((await unreadCount(student)) >= 1);
});

test("updates: teachers turn student posts and comments off for a class", async () => {
  assert.equal(await setCourseRules(student, chess, { studentPosts: false, studentComments: false }), false, "a student can't");
  assert.equal(await setCourseRules({ ...teacher, tenantId: "school-b" }, chess, { studentPosts: false, studentComments: false }), false);
  assert.equal(await setCourseRules(teacher, chess, { studentPosts: false, studentComments: true }), true);
  await assert.rejects(createPost(student, { courseId: chess, body: "x" }), (e: UpdateError) => e.code === "off");
  const p = await createPost(teacher, { courseId: chess, body: "Tournament Tuesday" });
  assert.ok(await addComment(student, p.id, "I'm in"));
  await setCourseRules(teacher, chess, { studentPosts: false, studentComments: false });
  await assert.rejects(addComment(student, p.id, "x"), (e: UpdateError) => e.code === "off");
  assert.equal((await thread(student, p.id))!.post.canComment, false);
  assert.ok(await addComment(teacher, p.id, "Bring boards"), "teachers still can");
  await setCourseRules(teacher, chess, { studentPosts: true, studentComments: true });
});

test("updates: moderation: teachers hide and delete in their class; students only their own; school posts by admins and authors", async () => {
  const s = await createPost(student, { courseId: bio, body: "off topic" });
  assert.equal(await moderatePost(student, s.id, "hide"), false, "an author can't hide, only delete");
  assert.equal(await moderatePost(other, s.id, "delete"), false);
  assert.equal(await moderatePost(teacher, s.id, "hide"), true);
  assert.equal((await feed(other)).some((x) => x.id === s.id), false);
  assert.ok((await thread(student, s.id))?.post.status === "hidden", "the author still sees it, marked hidden");
  assert.equal(await thread(parent, s.id), null, "a parent doesn't");
  assert.ok((await feed(teacher, { courseId: bio })).find((x) => x.id === s.id)?.status === "hidden");
  assert.equal(await moderatePost(teacher, s.id, "unhide"), true);
  assert.equal(await moderatePost(student, s.id, "delete"), true, "anyone deletes their own");
  assert.equal(await thread(teacher, s.id), null, "deleted shows to no one");
  const [{ n }] = await db.query("SELECT count(*)::int AS n FROM posts WHERE id = $1", [s.id]);
  assert.equal(n, 1, "but is kept");

  const p = await createPost(teacher, { courseId: bio, body: "Homework" });
  const c = await addComment(student, p.id, "rude");
  assert.equal(await moderateComment(other, c.id, "hide"), false);
  assert.equal(await moderateComment(teacher, c.id, "hide"), true);
  assert.deepEqual((await thread(other, p.id))?.comments ?? [], []);
  assert.equal((await thread(student, p.id))!.comments[0].status, "hidden");
  assert.equal((await thread(teacher, p.id))!.comments.length, 1);

  const school = await createPost(office, { courseId: null, body: "Lost and found" });
  const sc = await addComment(student, school.id, "My hat!");
  assert.equal(await moderatePost(teacher, school.id, "hide"), false, "a teacher doesn't moderate school posts");
  assert.equal(await moderateComment(office, sc.id, "hide"), true, "the post's author moderates its comments");
  assert.equal(await moderatePost(admin, school.id, "hide"), true, "a school admin does");
  assert.equal(await moderatePost({ ...admin, tenantId: "school-b" }, school.id, "delete"), false);
});
