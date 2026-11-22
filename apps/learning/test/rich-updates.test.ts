import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses } from "../src/lib/courses";
import { createAssignment } from "../src/lib/assignments";
import { createLesson } from "../src/lib/lessons";
import { feed, thread, createPosts, createPost, editPost, addComment, materialChoices, postablePlaces, setCourseRules, UpdateError, type Viewer } from "../src/lib/updates";
import { normalizeDoc, docText, safeHref, videoFromUrl, videoSrc, docFromText } from "../src/lib/post-doc";
import { memoryStore, useFileStore, saveFile, canOpen } from "../src/lib/files";
import { teacherTasks, studentTasks } from "../src/lib/tasks";
import type { CourseWork } from "../src/lib/family";

let db: Db;
const T = "school-a";
let p1 = "", p3 = "", art = "", chess = "";
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

function viewer(over: Partial<Viewer> & Pick<Viewer, "userId" | "kind">): Viewer {
  return { tenantId: T, name: over.userId, schoolAdmin: false, canPostSchool: false, courses: new Map(), childCourses: new Set(), ...over };
}
let teacher: Viewer, s1: Viewer, s3: Viewer, artTeacher: Viewer, parent: Viewer, office: Viewer;

before(async () => {
  process.env.BACKUP_ENCRYPTION_KEY = "a".repeat(64);
  useFileStore(memoryStore());
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
  [p1] = (await myCourses(T, [{ id: "k-p1", name: "Biology P1", role: "teacher" }], "t1")).map((c) => c.id);
  [p3] = (await myCourses(T, [{ id: "k-p3", name: "Biology P3", role: "teacher" }], "t1")).map((c) => c.id);
  [chess] = (await myCourses(T, [{ id: "k-chess", name: "Chess Club", role: "teacher" }], "t1")).map((c) => c.id);
  [art] = (await myCourses(T, [{ id: "k-art", name: "Art", role: "teacher" }], "t2")).map((c) => c.id);
  teacher = viewer({ userId: "t1", kind: "staff", name: "Ms Teach", courses: new Map([[p1, "teacher"], [p3, "teacher"], [chess, "teacher"]]) });
  s1 = viewer({ userId: "s1", kind: "student", courses: new Map([[p1, "student"]]) });
  s3 = viewer({ userId: "s3", kind: "student", courses: new Map([[p3, "student"]]) });
  artTeacher = viewer({ userId: "t2", kind: "staff", courses: new Map([[art, "teacher"]]) });
  parent = viewer({ userId: "g1", kind: "parent", childCourses: new Set([p1]) });
  office = viewer({ userId: "o1", kind: "staff", canPostSchool: true, name: "Office" });
});
after(() => { delete process.env.BACKUP_ENCRYPTION_KEY; useFileStore(undefined as never); db.close(); });

test("post doc: only known shapes, safe links, YouTube/Vimeo by id; text for the plain body", () => {
  const doc = normalizeDoc({
    nodes: [
      { type: "p", content: [{ text: "Read ", b: 1 }, { text: "this", href: "javascript:alert(1)" }, { text: " site", href: "example.com/x" }] },
      { type: "script", content: [{ text: "x" }] },
      { type: "h", content: [{ text: "  Due Friday  " }] },
      { type: "ul", items: [[{ text: "one" }], [{ text: "" }], [{ text: "two", i: true }]] },
      { type: "video", provider: "youtube", id: "dQw4w9WgXcQ" },
      { type: "video", provider: "youtube", id: "bad\"><x" },
      { type: "video", provider: "evil", id: "1" },
      { type: "file", fileId: "not-an-id" },
      { type: "material", kind: "assignment", id: "00000000-0000-4000-8000-000000000001", title: " Lab   report " },
      { type: "material", kind: "grades", id: "00000000-0000-4000-8000-000000000001" },
    ],
  });
  assert.deepEqual(doc.nodes.map((n) => n.type), ["p", "h", "ul", "video", "material"]);
  const p = doc.nodes[0] as { content: { text: string; href?: string; b?: true }[] };
  assert.equal(p.content[0].b, true);
  assert.equal(p.content[1].href, undefined, "javascript: links are dropped");
  assert.equal(p.content[2].href, "https://example.com/x");
  assert.equal((doc.nodes[1] as { content: { text: string }[] }).content[0].text, "Due Friday");
  assert.equal((doc.nodes[2] as { items: unknown[] }).items.length, 2, "empty list items go");
  assert.equal((doc.nodes[4] as { title: string }).title, "Lab report");
  const text = docText(doc);
  assert.match(text, /Read this site \(https:\/\/example.com\/x\)/);
  assert.match(text, /• one\n• two/);
  assert.match(text, /youtu\.be\/dQw4w9WgXcQ/);
  assert.deepEqual(normalizeDoc("<b>html</b>"), { v: 1, nodes: [] });
  assert.deepEqual(normalizeDoc(null), { v: 1, nodes: [] });
  assert.equal(normalizeDoc({ nodes: Array.from({ length: 500 }, () => ({ type: "p", content: [{ text: "x" }] })) }).nodes.length, 120);
  assert.equal(docFromText("a\n\nb\nc").nodes.length, 2);
});

test("post doc: links and video addresses", () => {
  assert.equal(safeHref("data:text/html,<script>"), null);
  assert.equal(safeHref("vbscript:x"), null);
  assert.equal(safeHref("mailto:office@school.org"), "mailto:office@school.org");
  assert.equal(safeHref("intranet"), null, "a bare word isn't a link");
  for (const u of ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3", "https://youtu.be/dQw4w9WgXcQ", "https://youtube.com/shorts/dQw4w9WgXcQ", "https://m.youtube.com/embed/dQw4w9WgXcQ"]) {
    assert.deepEqual(videoFromUrl(u), { provider: "youtube", id: "dQw4w9WgXcQ" }, u);
  }
  assert.deepEqual(videoFromUrl("https://vimeo.com/76979871"), { provider: "vimeo", id: "76979871" });
  assert.equal(videoFromUrl("https://evil.com/watch?v=dQw4w9WgXcQ"), null);
  assert.equal(videoFromUrl("javascript:alert(1)"), null);
  assert.equal(videoSrc({ provider: "youtube", id: "dQw4w9WgXcQ" }), "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
});

test("rich updates: one update to several classes is one post each, shown once to the teacher, once per class to students", async () => {
  const made = await createPosts(teacher, {
    to: [p1, p3, chess], title: "Lab Friday",
    doc: JSON.stringify({ v: 1, nodes: [{ type: "p", content: [{ text: "Bring goggles", b: true }] }] }),
  });
  assert.equal(made.length, 3);
  assert.ok(made[0].groupId && made.every((m) => m.groupId === made[0].groupId));
  assert.equal(made[0].body, "Bring goggles");
  const mine = (await feed(teacher)).filter((p) => p.groupId === made[0].groupId);
  assert.equal(mine.length, 1, "the teacher sees it once");
  assert.deepEqual(mine[0].places.map((pl) => pl.courseName).sort(), ["Biology P1", "Biology P3", "Chess Club"]);
  const a = (await feed(s1)).filter((p) => p.groupId === made[0].groupId);
  assert.equal(a.length, 1);
  assert.deepEqual(a[0].places.map((pl) => pl.courseId), [p1], "a student sees only their own class's place");
  const t = await thread(s3, (await feed(s3)).find((p) => p.groupId === made[0].groupId)!.id);
  assert.deepEqual(t!.post.places.map((pl) => pl.courseId), [p3]);
  const tt = await thread(teacher, made[0].id);
  assert.equal(tt!.post.places.length, 3, "the teacher's thread lists every place");
  assert.equal(tt!.post.doc.nodes[0].type, "p");
});

test("rich updates: all places allowed or nothing is posted; at least one place", async () => {
  const before = (await db.query("SELECT count(*)::int AS n FROM posts"))[0].n;
  await assert.rejects(createPosts(teacher, { to: [p1, art], body: "x" }), (e: UpdateError) => e.code === "forbidden");
  await assert.rejects(createPosts(teacher, { to: [p1, "school"], body: "x" }), (e: UpdateError) => e.code === "forbidden");
  await assert.rejects(createPosts(teacher, { to: [], body: "x" }), (e: UpdateError) => e.code === "noplace");
  await setCourseRules(teacher, p1, { studentPosts: false, studentComments: true });
  await assert.rejects(createPosts(s1, { to: [p1], body: "x" }), (e: UpdateError) => e.code === "off");
  assert.deepEqual((await postablePlaces(s1)).courseIds, []);
  await setCourseRules(teacher, p1, { studentPosts: true, studentComments: true });
  assert.equal((await db.query("SELECT count(*)::int AS n FROM posts"))[0].n, before);
  const both = await createPosts(office, { to: ["school"], body: "Assembly at 10" });
  assert.equal(both[0].groupId, null, "a single place needs no group");
  assert.deepEqual(await postablePlaces(office), { courseIds: [], school: true });
});

test("rich updates: links to Learning material: only the poster's own classes; students follow only what's open to them", async () => {
  const pub = await createAssignment(teacher, p1, { title: "Lab report" });
  await db.query("UPDATE assignments SET published = true, due_at = now() + interval '2 days' WHERE id = $1", [pub.id]);
  const draft = await createAssignment(teacher, p1, { title: "Quiz draft" });
  const lesson = await createLesson(teacher, p1, "Cells");
  const theirs = await createAssignment(artTeacher, art, { title: "Portrait" });
  const choices = await materialChoices(teacher);
  assert.ok(choices.some((c) => c.id === pub.id && !c.draft) && choices.some((c) => c.id === draft.id && c.draft));
  assert.ok(!choices.some((c) => c.id === theirs.id), "another teacher's class isn't offered");
  assert.deepEqual(await materialChoices(s1), [], "students link nothing");
  const node = (kind: string, id: string, title: string) => ({ type: "material", kind, id, title });
  const [post] = await createPosts(teacher, {
    to: [p1], doc: { nodes: [{ type: "p", content: [{ text: "See:" }] }, node("assignment", pub.id, "Lab report"), node("assignment", draft.id, "Quiz draft"), node("lesson", lesson.id, "Cells"), node("assignment", theirs.id, "Portrait")] },
  });
  assert.equal(post.doc.nodes.filter((n) => n.type === "material").length, 3, "another class's assignment is dropped");
  const forTeacher = (await feed(teacher, { courseId: p1 })).find((p) => p.id === post.id)!;
  assert.equal(forTeacher.materials[pub.id].href, `/assignments/${pub.id}`);
  assert.equal(forTeacher.materials[lesson.id].href, `/lessons/${lesson.id}/edit`);
  assert.equal(forTeacher.materials[draft.id].draft, true);
  const forStudent = (await feed(s1, { courseId: p1 })).find((p) => p.id === post.id)!;
  assert.equal(forStudent.materials[pub.id].href, `/assignments/${pub.id}`);
  assert.ok(forStudent.materials[pub.id].dueAt);
  assert.equal(forStudent.materials[draft.id].href, null, "a draft isn't open to students");
  assert.equal(forStudent.materials[lesson.id].href, null, "students don't open lessons from a post");
  const forParent = (await feed(parent)).find((p) => p.id === post.id)!;
  assert.equal(forParent.materials[pub.id].href, null);
  await db.query("UPDATE assignments SET archived = true WHERE id = $1", [pub.id]);
  const after = (await feed(s1, { courseId: p1 })).find((p) => p.id === post.id)!;
  assert.equal(after.materials[pub.id].gone, true);
  assert.equal(after.materials[pub.id].href, null);
});

test("rich updates: pictures: only the poster's own uploads or their classes' files; readers of the post may open them", async () => {
  const mine = await saveFile({ tenantId: T, userId: "t1", role: "teacher" }, p1, "goggles.png", PNG);
  const artFile = await saveFile({ tenantId: T, userId: "t2", role: "teacher" }, art, "secret.png", PNG);
  const school = await saveFile({ tenantId: T, userId: "o1", role: "teacher" }, null, "assembly.png", PNG);
  assert.equal(school.courseId, null);
  const img = (id: string) => ({ type: "file", fileId: id, name: "x.png", kind: "image", alt: "Goggles" });
  const [post] = await createPosts(teacher, { to: [p3], doc: { nodes: [img(mine.id), img(artFile.id)] } });
  assert.deepEqual(post.doc.nodes.map((n) => n.type === "file" && n.fileId), [mine.id], "another class's file is dropped");
  const [row] = await db.query("SELECT file_ids FROM posts WHERE id = $1", [post.id]);
  assert.deepEqual(row.file_ids, [mine.id]);

  const roleOf = (v: Viewer) => async (c: string) => v.courses.get(c) ?? null;
  const reader = (v: Viewer) => ({ userId: v.userId, reads: (c: string | null) => c === null || v.courses.has(c) || v.childCourses.has(c) });
  const fileRow = async (id: string) => {
    const [f] = await db.query("SELECT id, course_id, uploaded_by FROM course_files WHERE id = $1", [id]);
    return { id: String(f.id), courseId: f.course_id ? String(f.course_id) : null, uploadedBy: String(f.uploaded_by) };
  };
  const f = await fileRow(mine.id);
  assert.equal(await canOpen(T, f, roleOf(s3), reader(s3)), true, "a P3 student reads the post, so opens its picture");
  assert.equal(await canOpen(T, f, roleOf(s1), reader(s1)), false, "a P1 student never saw it");
  assert.equal(await canOpen(T, f, roleOf(s3)), false, "without the post check it stays closed, as before");
  await db.query("UPDATE posts SET status = 'hidden' WHERE id = $1", [post.id]);
  assert.equal(await canOpen(T, f, roleOf(s3), reader(s3)), false, "a hidden post opens nothing");
  await db.query("UPDATE posts SET status = 'visible' WHERE id = $1", [post.id]);

  const sf = await fileRow(school.id);
  assert.equal(await canOpen(T, sf, roleOf(office), reader(office)), true, "its uploader, before it is posted");
  assert.equal(await canOpen(T, sf, roleOf(parent), reader(parent)), false, "not posted yet");
  await createPosts(office, { to: ["school"], doc: { nodes: [img(school.id)] } });
  assert.equal(await canOpen(T, sf, roleOf(parent), reader(parent)), true, "a whole-school post's picture: everyone at the school");
  assert.equal(await canOpen("school-b", sf, roleOf(parent), reader(parent)), false, "another school never");
});

test("rich updates: plain posts still work and read as one paragraph per block", async () => {
  const p = await createPost(teacher, { courseId: p1, body: "Line one\n\nLine two" });
  assert.equal(p.doc.nodes.length, 2);
  await assert.rejects(createPosts(teacher, { to: [p1], doc: { nodes: [{ type: "p", content: [{ text: "   " }] }] } }), (e: UpdateError) => e.code === "empty");
});

test("to do: teachers see work to grade, due soon, drafts due soon and today's lessons; students overdue and upcoming", async () => {
  const now = new Date("2026-11-23T15:00:00Z");
  const essay = await createAssignment(teacher, p3, { title: "Essay" });
  await db.query("UPDATE assignments SET published = true, due_at = '2026-11-20T20:00:00Z' WHERE id = $1", [essay.id]);
  await db.query("INSERT INTO submissions (tenant_id, assignment_id, student_id, submitted_at) VALUES ($1, $2, 's3', now()), ($1, $2, 's4', now()), ($1, $2, 's5', null)", [T, essay.id]);
  await db.query("INSERT INTO grades (tenant_id, assignment_id, student_id, score, graded_by) VALUES ($1, $2, 's4', 8, 't1')", [T, essay.id]);
  const soon = await createAssignment(teacher, p3, { title: "Worksheet" });
  await db.query("UPDATE assignments SET published = true, due_at = '2026-11-25T20:00:00Z' WHERE id = $1", [soon.id]);
  const draft = await createAssignment(teacher, p3, { title: "Unpublished test" });
  await db.query("UPDATE assignments SET due_at = '2026-11-24T20:00:00Z' WHERE id = $1", [draft.id]);
  const lesson = await createLesson(teacher, p3, "Mitosis");
  await db.query("UPDATE lessons SET planned_for = '2026-11-23' WHERE id = $1", [lesson.id]);
  const theirs = await createAssignment(artTeacher, art, { title: "Portrait" });
  await db.query("UPDATE assignments SET published = true, due_at = '2026-11-25T20:00:00Z' WHERE id = $1", [theirs.id]);

  const t = await teacherTasks({ tenantId: T }, [p3], "2026-11-23", now);
  const g = t.grade.find((x) => x.id === essay.id);
  assert.ok(g && g.kind === "grade" && g.count === 1, "handed in and ungraded: s3 only");
  assert.deepEqual(t.due.map((x) => x.id), [soon.id]);
  assert.deepEqual(t.drafts.map((x) => x.id), [draft.id]);
  assert.deepEqual(t.lessons.map((x) => x.id), [lesson.id]);
  assert.equal((await teacherTasks({ tenantId: "school-b" }, [p3], "2026-11-23", now)).grade.length, 0, "another school sees nothing");
  assert.deepEqual(await teacherTasks({ tenantId: T }, [], "2026-11-23", now), { grade: [], due: [], drafts: [], lessons: [] });

  const item = (id: string, status: string, dueAt: string | null) => ({ id, title: id, courseId: p1, courseName: "Bio", kind: "online", points: 10, dueOn: null, dueAt, status, late: false, score: null, gradedAt: null });
  const work = [{ course: {} as never, whole: null, letter: null, items: [
    item("late", "overdue", "2026-11-20T20:00:00Z"), item("miss", "missing", "2026-11-10T20:00:00Z"), item("next", "notStarted", "2026-11-26T20:00:00Z"),
    item("far", "notStarted", "2027-01-20T20:00:00Z"), item("done", "handedIn", "2026-11-24T20:00:00Z"), item("graded", "graded", "2026-11-24T20:00:00Z"),
  ] }] as unknown as CourseWork[];
  const s = studentTasks(work, now);
  assert.deepEqual(s.overdue.map((x) => x.id), ["miss", "late"]);
  assert.deepEqual(s.upcoming.map((x) => x.id), ["next"]);
  assert.equal(studentTasks(work, now, 14, { id: "c1", name: "Kid" }).overdue[0].who?.name, "Kid");
});

test("editing: only the author; every place changes; old versions kept; comments and unread untouched", async () => {
  const para = (t: string) => ({ v: 1, nodes: [{ type: "p", content: [{ text: t }] }] });
  const made = await createPosts(teacher, { to: [p1, p3], title: "Trip", doc: para("Bus at 8") });
  await addComment(s1, made[0].id, "Got it");
  const unreadBefore = (await feed(s3)).find((p) => p.groupId === made[0].groupId)!.unread;
  await assert.rejects(editPost(s1, made[0].id, { doc: para("hacked") }), (e: UpdateError) => e.code === "forbidden");
  await assert.rejects(editPost(artTeacher, made[0].id, { doc: para("x") }), (e: UpdateError) => e.code === "notfound");
  await assert.rejects(editPost(teacher, made[0].id, { doc: para("   ") }), (e: UpdateError) => e.code === "empty");
  const e = await editPost(teacher, made[0].id, { title: "Field trip", doc: para("Bus at 7:30") });
  assert.ok(e.editedAt);
  for (const m of made) {
    const [row] = await db.query("SELECT title, body, edited_at FROM posts WHERE id = $1", [m.id]);
    assert.equal(row.title, "Field trip");
    assert.equal(row.body, "Bus at 7:30", "every place of the update changed");
    assert.ok(row.edited_at);
  }
  const hist = await db.query("SELECT post_id, body, edited_by FROM post_edits WHERE post_id = ANY($1::uuid[])", [made.map((m) => m.id)]);
  assert.equal(hist.length, 2);
  assert.ok(hist.every((h) => h.body === "Bus at 8" && h.edited_by === "t1"), "the earlier words are kept");
  assert.equal((await thread(s1, made[0].id))!.comments.length, 1, "comments stay");
  assert.equal((await feed(s3)).find((p) => p.groupId === made[0].groupId)!.unread, unreadBefore, "an edit doesn't mark it unread");
  assert.equal((await feed(s1, { courseId: p1 })).find((p) => p.id === made[0].id)!.canEdit, false);
  assert.equal((await feed(teacher, { courseId: p1 })).find((p) => p.id === made[0].id)!.canEdit, true);
});

test("editing: a student's own post, only while posts are on; another class's file can't be slipped in", async () => {
  const [mine] = await createPosts(s1, { to: [p1], body: "Study group?" });
  const edited = await editPost(s1, mine.id, { doc: { v: 1, nodes: [{ type: "p", content: [{ text: "Study group at lunch?" }] }] } });
  assert.equal(edited.body, "Study group at lunch?");
  const artFile = await saveFile({ tenantId: T, userId: "t2", role: "teacher" }, art, "secret2.png", PNG);
  const [tp] = await createPosts(teacher, { to: [p1], body: "Pic soon" });
  const after = await editPost(teacher, tp.id, { doc: { nodes: [{ type: "p", content: [{ text: "Here" }] }, { type: "file", fileId: artFile.id, name: "x", kind: "image", alt: "" }] } });
  assert.deepEqual(after.doc.nodes.map((n) => n.type), ["p"]);
  await setCourseRules(teacher, p1, { studentPosts: false, studentComments: true });
  await assert.rejects(editPost(s1, mine.id, { body: "again" }), (e: UpdateError) => e.code === "off");
  await setCourseRules(teacher, p1, { studentPosts: true, studentComments: true });
});
