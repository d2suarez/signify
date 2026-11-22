import { getDb, type Row } from "./db";
import {
  normalizeDoc, docText, docFileIds, docMaterials, docFromText, filterDoc, docIsEmpty,
  type PostDoc, type MaterialKind,
} from "./post-doc";

/**
 * Updates (migration 018): posts to a class or club, or to the whole school,
 * with comments and unread markers. Pure database rules; the caller builds
 * the `Viewer` from live Signify ID (classes, children, role, the school's
 * Tools by role answer) on every request, so nothing here trusts a request
 * body for who someone is or where they belong.
 *
 * - Course posts: the course's teachers always; its students unless the
 *   teachers turned student posts off. School posts: `canPostSchool`.
 * - Comments: anyone who can see the post except parents; students in a
 *   class only while student comments are on.
 * - Parents read their children's class posts and school posts, never
 *   comments.
 * - Moderation: a course's teachers for its posts and comments; school
 *   admins and the post's author for a school post. Anyone may delete
 *   their own. Hide is reversible; delete keeps the row and shows it to no one.
 */

export type ViewerKind = "staff" | "student" | "parent";
export type Viewer = {
  tenantId: string;
  userId: string;
  name: string;
  kind: ViewerKind;
  schoolAdmin: boolean;
  canPostSchool: boolean;
  /** Courses (classes and clubs) this person is in now, from Signify ID. */
  courses: Map<string, "teacher" | "student">;
  /** A parent's children's courses: read-only. */
  childCourses: Set<string>;
};

export type PostStatus = "visible" | "hidden" | "deleted";
/** Where a link to Learning material leads for this viewer (null = they can't open it). */
export type MaterialView = {
  kind: MaterialKind; title: string; courseName: string; href: string | null;
  dueAt: string | null; draft: boolean; gone: boolean;
};
/** One place an update went to (a post of the same group the viewer can see). */
export type Place = { postId: string; courseId: string | null; courseName: string; unread: boolean; comments: number };
export type Post = {
  id: string; courseId: string | null; courseName: string; title: string; body: string;
  /** The formatted document (older posts: their text as paragraphs). */
  doc: PostDoc;
  groupId: string | null;
  /** Every place this update went that the viewer can see, this one first. */
  places: Place[];
  /** Material links in the document, as this viewer may follow them. */
  materials: Record<string, MaterialView>;
  /** Last changed by its author (null = never). */
  editedAt: string | null;
  /** The author may change it. */
  canEdit: boolean;
  authorId: string; authorName: string; authorKind: "staff" | "student";
  status: PostStatus; createdAt: string; activityAt: string;
  comments: number; unread: boolean;
  /** This viewer may hide or delete it. */
  canModerate: boolean;
  canComment: boolean;
};
export type Comment = {
  id: string; body: string; authorId: string; authorName: string; authorKind: "staff" | "student";
  status: PostStatus; createdAt: string; canModerate: boolean;
};
export type CourseRules = { studentPosts: boolean; studentComments: boolean };

export const UPDATE_LIMITS = { title: 200, body: 5_000, comment: 2_000, feed: 30, name: 200 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (x: unknown): x is string => typeof x === "string" && UUID.test(x);

export class UpdateError extends Error {
  constructor(public code: "forbidden" | "empty" | "notfound" | "off" | "noplace") { super(code); }
}

const iso = (v: unknown) => new Date(v as string).toISOString();
const clean = (v: unknown, max: number) => String(v ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);

/** Courses whose posts this viewer may read. */
function readable(v: Viewer): string[] {
  return [...new Set([...v.courses.keys(), ...v.childCourses])].filter(isId);
}

function moderates(v: Viewer, p: Row): boolean {
  if (p.course_id) return v.courses.get(String(p.course_id)) === "teacher";
  return v.schoolAdmin || p.author_id === v.userId;
}

async function rulesFor(courseIds: string[], tenantId: string): Promise<Map<string, CourseRules>> {
  const out = new Map<string, CourseRules>();
  if (!courseIds.length) return out;
  const db = await getDb();
  const rows = await db.query("SELECT id, student_posts, student_comments FROM courses WHERE tenant_id = $1 AND id = ANY($2::uuid[])", [tenantId, courseIds]);
  for (const r of rows) out.set(String(r.id), { studentPosts: !!r.student_posts, studentComments: !!r.student_comments });
  return out;
}

export async function courseRules(v: Pick<Viewer, "tenantId">, courseId: string): Promise<CourseRules> {
  return (await rulesFor([courseId], v.tenantId)).get(courseId) ?? { studentPosts: true, studentComments: true };
}

function mayComment(v: Viewer, p: Row, rules: Map<string, CourseRules>): boolean {
  if (v.kind === "parent" || p.status !== "visible") return false;
  if (!p.course_id) return true;
  const role = v.courses.get(String(p.course_id));
  if (role === "teacher") return true;
  return role === "student" && (rules.get(String(p.course_id))?.studentComments ?? true);
}

/** Whether this viewer may post here: a course id, or null for the whole school. */
export async function mayPost(v: Viewer, courseId: string | null): Promise<boolean> {
  if (courseId === null) return v.kind === "staff" && v.canPostSchool;
  const role = v.courses.get(courseId);
  if (role === "teacher") return true;
  if (role !== "student") return false;
  return (await courseRules(v, courseId)).studentPosts;
}

function toPost(v: Viewer, r: Row, rules: Map<string, CourseRules>): Post {
  return {
    id: String(r.id), courseId: r.course_id ? String(r.course_id) : null, courseName: String(r.course_name ?? ""),
    title: String(r.title), body: String(r.body),
    doc: r.doc ? normalizeDoc(r.doc) : docFromText(String(r.body)), groupId: r.group_id ? String(r.group_id) : null,
    places: [], materials: {},
    editedAt: r.edited_at ? iso(r.edited_at) : null, canEdit: r.author_id === v.userId && r.status !== "deleted",
    authorId: String(r.author_id), authorName: String(r.author_name ?? ""),
    authorKind: r.author_kind === "student" ? "student" : "staff", status: r.status as PostStatus,
    createdAt: iso(r.created_at), activityAt: iso(r.activity_at), comments: Number(r.comments ?? 0),
    // Never opened: unread unless it's their own. Opened: unread again once someone comments after.
    unread: r.read_at ? new Date(r.read_at as string) < new Date(r.activity_at as string) : r.author_id !== v.userId,
    canModerate: moderates(v, r), canComment: mayComment(v, r, rules),
  };
}

/**
 * Posts this viewer may see, newest activity first. `where`: one course,
 * 'school' (school posts only), or everything they can read (the home feed).
 * Hidden posts show to their moderators and their author, deleted to nobody.
 */
export async function feed(v: Viewer, where: { courseId?: string; school?: boolean } = {}, limit = UPDATE_LIMITS.feed): Promise<Post[]> {
  const db = await getDb();
  let courses = readable(v);
  if (where.courseId) courses = courses.filter((c) => c === where.courseId);
  const school = !where.courseId;
  if (where.school) courses = [];
  const teaches = [...v.courses].filter(([, r]) => r === "teacher").map(([c]) => c);
  const rows = await db.query(
    `SELECT p.*, c.name AS course_name, r.read_at,
            (SELECT count(*)::int FROM post_comments k WHERE k.post_id = p.id AND k.status = 'visible') AS comments
       FROM posts p LEFT JOIN courses c ON c.id = p.course_id
       LEFT JOIN post_reads r ON r.post_id = p.id AND r.user_id = $2
      WHERE p.tenant_id = $1 AND p.status <> 'deleted'
        AND ((p.course_id = ANY($3::uuid[])) OR ($4 AND p.course_id IS NULL))
        AND (p.status = 'visible' OR p.author_id = $2
             OR (p.course_id IS NOT NULL AND p.course_id = ANY($5::uuid[]))
             OR (p.course_id IS NULL AND $6))
      ORDER BY p.activity_at DESC, p.id LIMIT $7`,
    [v.tenantId, v.userId, courses, school, teaches, v.schoolAdmin, Math.min(Math.max(1, limit), 100)],
  );
  const rules = await rulesFor([...new Set(rows.map((r) => r.course_id).filter(Boolean).map(String))], v.tenantId);
  const all = rows.map((r) => {
    const p = toPost(v, r, rules);
    // A parent sees no comments, so no count either.
    return v.kind === "parent" ? { ...p, comments: 0 } : p;
  });
  // One update sent to several places shows once, naming each place it went.
  const out: Post[] = [];
  const byGroup = new Map<string, Post>();
  for (const p of all) {
    const place: Place = { postId: p.id, courseId: p.courseId, courseName: p.courseName, unread: p.unread, comments: p.comments };
    const first = p.groupId ? byGroup.get(p.groupId) : undefined;
    if (first) {
      first.places.push(place);
      first.unread ||= p.unread;
      first.comments += p.comments;
      continue;
    }
    p.places = [place];
    if (p.groupId) byGroup.set(p.groupId, p);
    out.push(p);
  }
  await attachMaterials(v, out);
  return out;
}

/** Fills each post's `materials`: titles, due dates and where a link leads for this viewer, now. */
async function attachMaterials(v: Viewer, posts: Post[]): Promise<void> {
  const refs = posts.flatMap((p) => docMaterials(p.doc));
  if (!refs.length) return;
  const ids = (k: MaterialKind) => [...new Set(refs.filter((r) => r.kind === k).map((r) => r.id))];
  const db = await getDb();
  const [as, ls, rs] = await Promise.all([
    ids("assignment").length ? db.query(
      `SELECT a.id, a.course_id, a.title, a.published, a.archived, a.due_at, c.name AS course_name
         FROM assignments a JOIN courses c ON c.id = a.course_id WHERE a.tenant_id = $1 AND a.id = ANY($2::uuid[])`,
      [v.tenantId, ids("assignment")]) : [],
    ids("lesson").length ? db.query(
      `SELECT l.id, l.course_id, l.title, l.archived, c.name AS course_name
         FROM lessons l JOIN courses c ON c.id = l.course_id WHERE l.tenant_id = $1 AND l.id = ANY($2::uuid[])`,
      [v.tenantId, ids("lesson")]) : [],
    ids("resource").length ? db.query(
      `SELECT r.id, r.course_id, COALESCE(NULLIF(r.title, ''), NULLIF(r.block->>'title', ''), NULLIF(r.block->>'name', ''), '') AS title, r.visible, r.archived, r.kind, r.block->>'type' AS block_type, c.name AS course_name
         FROM class_resources r JOIN courses c ON c.id = r.course_id WHERE r.tenant_id = $1 AND r.id = ANY($2::uuid[])`,
      [v.tenantId, ids("resource")]) : [],
  ]);
  const found = new Map<string, MaterialView>();
  for (const a of as) {
    const role = v.courses.get(String(a.course_id));
    const open = !a.archived && (role === "teacher" || (role === "student" && !!a.published));
    found.set(`assignment:${a.id}`, {
      kind: "assignment", title: String(a.title), courseName: String(a.course_name), href: open ? `/assignments/${a.id}` : null,
      dueAt: a.due_at ? iso(a.due_at) : null, draft: !a.published, gone: !!a.archived,
    });
  }
  for (const l of ls) {
    // Students follow a lesson when it's presented; only its teachers open it from a post.
    const role = v.courses.get(String(l.course_id));
    found.set(`lesson:${l.id}`, {
      kind: "lesson", title: String(l.title), courseName: String(l.course_name),
      href: !l.archived && role === "teacher" ? `/lessons/${l.id}/edit` : null, dueAt: null, draft: false, gone: !!l.archived,
    });
  }
  for (const r of rs) {
    const role = v.courses.get(String(r.course_id));
    const shown = !!r.visible && r.kind === "block" && ["text", "link", "board", "file"].includes(String(r.block_type));
    found.set(`resource:${r.id}`, {
      kind: "resource", title: String(r.title || ""), courseName: String(r.course_name),
      href: !r.archived && (role === "teacher" || (role === "student" && shown)) ? `/courses/${r.course_id}/resources` : null,
      dueAt: null, draft: !shown, gone: !!r.archived,
    });
  }
  for (const p of posts) {
    for (const m of docMaterials(p.doc)) {
      const f = found.get(`${m.kind}:${m.id}`);
      p.materials[m.id] = f ? { ...f, title: f.title || m.title } : { kind: m.kind, title: m.title, courseName: "", href: null, dueAt: null, draft: false, gone: true };
    }
  }
}

export async function unreadCount(v: Viewer): Promise<number> {
  return (await feed(v, {}, 100)).filter((p) => p.unread).length;
}

async function visiblePost(v: Viewer, postId: string): Promise<Row | null> {
  if (!isId(postId)) return null;
  const db = await getDb();
  const [p] = await db.query(
    `SELECT p.*, c.name AS course_name FROM posts p LEFT JOIN courses c ON c.id = p.course_id
      WHERE p.tenant_id = $1 AND p.id = $2 AND p.status <> 'deleted'`,
    [v.tenantId, postId],
  );
  if (!p) return null;
  if (p.course_id && !readable(v).includes(String(p.course_id))) return null;
  if (p.status === "hidden" && !moderates(v, p) && p.author_id !== v.userId) return null;
  return p;
}

/** A post and its comments (none for a parent), or null when this viewer can't see it. */
export async function thread(v: Viewer, postId: string): Promise<{ post: Post; comments: Comment[] } | null> {
  const p = await visiblePost(v, postId);
  if (!p) return null;
  const db = await getDb();
  const [read] = await db.query("SELECT read_at FROM post_reads WHERE post_id = $1 AND user_id = $2", [p.id, v.userId]);
  const [{ n }] = await db.query("SELECT count(*)::int AS n FROM post_comments WHERE post_id = $1 AND status = 'visible'", [p.id]);
  const rules = await rulesFor(p.course_id ? [String(p.course_id)] : [], v.tenantId);
  const post = toPost(v, { ...p, read_at: read?.read_at ?? null, comments: v.kind === "parent" ? 0 : n }, rules);
  post.places = [{ postId: post.id, courseId: post.courseId, courseName: post.courseName, unread: false, comments: post.comments }];
  if (post.groupId) {
    // The same update's other places this viewer can read (each has its own comments).
    const others = await db.query(
      `SELECT p.id, p.course_id, c.name AS course_name FROM posts p LEFT JOIN courses c ON c.id = p.course_id
        WHERE p.tenant_id = $1 AND p.group_id = $2 AND p.id <> $3 AND p.status = 'visible'
          AND (p.course_id IS NULL OR p.course_id = ANY($4::uuid[])) ORDER BY c.name NULLS FIRST`,
      [v.tenantId, post.groupId, post.id, readable(v)],
    );
    for (const o of others) post.places.push({ postId: String(o.id), courseId: o.course_id ? String(o.course_id) : null, courseName: String(o.course_name ?? ""), unread: false, comments: 0 });
  }
  await attachMaterials(v, [post]);
  if (v.kind === "parent") return { post, comments: [] };
  const mod = moderates(v, p);
  const rows = await db.query(
    `SELECT * FROM post_comments WHERE tenant_id = $1 AND post_id = $2 AND status <> 'deleted'
       AND (status = 'visible' OR author_id = $3 OR $4) ORDER BY created_at, id`,
    [v.tenantId, p.id, v.userId, mod],
  );
  return {
    post,
    comments: rows.map((c) => ({
      id: String(c.id), body: String(c.body), authorId: String(c.author_id), authorName: String(c.author_name ?? ""),
      authorKind: c.author_kind === "student" ? "student" : "staff", status: c.status as PostStatus, createdAt: iso(c.created_at),
      canModerate: mod || c.author_id === v.userId,
    })),
  };
}

const authorKind = (v: Viewer): "staff" | "student" => (v.kind === "student" ? "student" : "staff");

export async function createPost(v: Viewer, input: { courseId?: unknown; title?: unknown; body?: unknown; doc?: unknown }): Promise<Post> {
  const [p] = await createPosts(v, { to: [input.courseId], title: input.title, body: input.body, doc: input.doc });
  return p;
}

const placeId = (x: unknown): string | null => (x == null || x === "" || x === "school" ? null : String(x));

/**
 * One update to several places at once (course ids, "school" for the whole
 * school): one post per place, in one transaction, tied by `group_id`. Every
 * place must be allowed or nothing is posted. `doc` (the editor's document)
 * wins over `body`; pictures/files must be the poster's own uploads or from
 * a class they teach, and material links from classes they teach: anything
 * else is dropped, so no one can show a class a file it can't otherwise see.
 */
export async function createPosts(v: Viewer, input: { to: unknown[]; title?: unknown; body?: unknown; doc?: unknown }): Promise<Post[]> {
  const places = [...new Set(input.to.map(placeId))];
  if (!places.length) throw new UpdateError("noplace");
  if (places.length > 60) throw new UpdateError("forbidden");
  for (const courseId of places) {
    if (courseId !== null && !isId(courseId)) throw new UpdateError("forbidden");
    if (!(await mayPost(v, courseId))) {
      throw new UpdateError(courseId && v.courses.get(courseId) === "student" ? "off" : "forbidden");
    }
  }
  const title = clean(input.title, UPDATE_LIMITS.title).replace(/\s+/g, " ");
  const db = await getDb();
  const doc = await cleanDoc(v, input.doc);
  const body = doc ? docText(doc).slice(0, UPDATE_LIMITS.body) : clean(input.body, UPDATE_LIMITS.body);
  if (!body && !doc) throw new UpdateError("empty");

  const courseIds = places.filter((c): c is string => c !== null);
  if (courseIds.length) {
    // The viewer's courses come from Signify ID, but check the courses are this school's anyway.
    const rows = await db.query("SELECT id FROM courses WHERE tenant_id = $1 AND id = ANY($2::uuid[])", [v.tenantId, courseIds]);
    if (rows.length !== courseIds.length) throw new UpdateError("forbidden");
  }
  const groupId = places.length > 1 ? crypto.randomUUID() : null;
  const files = doc ? docFileIds(doc) : [];
  const made = await db.tx(async (q) => {
    const out: Row[] = [];
    for (const courseId of places) {
      const [row] = await q.query(
        `INSERT INTO posts (tenant_id, course_id, title, body, author_id, author_name, author_kind, doc, group_id, file_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid[]) RETURNING *`,
        [v.tenantId, courseId, title, body, v.userId, v.name.slice(0, UPDATE_LIMITS.name), authorKind(v), doc ? JSON.stringify(doc) : null, groupId, files],
      );
      await q.query("INSERT INTO post_reads (tenant_id, user_id, post_id, read_at) VALUES ($1, $2, $3, $4)", [v.tenantId, v.userId, row.id, row.activity_at]);
      out.push(row);
    }
    return out;
  });
  const rules = await rulesFor(courseIds, v.tenantId);
  return made.map((r) => toPost(v, { ...r, read_at: r.created_at, comments: 0 }, rules));
}

/**
 * The editor's document as this viewer may post it: normalised, pictures and
 * files only their own uploads or their classes', material links only from
 * classes they teach. Null when nothing is left (or none was sent).
 */
async function cleanDoc(v: Viewer, input: unknown): Promise<PostDoc | null> {
  if (input == null || input === "") return null;
  let raw: unknown = input;
  if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { raw = null; } }
  let doc = normalizeDoc(raw);
  const db = await getDb();
  const teaches = [...v.courses].filter(([, r]) => r === "teacher").map(([c]) => c);
  const fileIds = docFileIds(doc);
  const okFiles = new Set(fileIds.length ? (await db.query(
    `SELECT id FROM course_files WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND (uploaded_by = $3 OR course_id = ANY($4::uuid[]))`,
    [v.tenantId, fileIds, v.userId, teaches])).map((r) => String(r.id)) : []);
  const mats = docMaterials(doc);
  const okMats = new Set<string>();
  for (const [kind, table] of [["assignment", "assignments"], ["lesson", "lessons"], ["resource", "class_resources"]] as const) {
    const want = mats.filter((m) => m.kind === kind).map((m) => m.id);
    if (!want.length || !teaches.length) continue;
    const rows = await db.query(`SELECT id FROM ${table} WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND course_id = ANY($3::uuid[])`, [v.tenantId, want, teaches]);
    for (const r of rows) okMats.add(`${kind}:${r.id}`);
  }
  doc = filterDoc(doc, (n) => n.type === "file" ? okFiles.has(n.fileId) : n.type === "material" ? okMats.has(`${n.kind}:${n.id}`) : true);
  return docIsEmpty(doc) ? null : doc;
}

/**
 * The author changes an update's title and words. Sent to several places,
 * it changes in every one of them (the author's own posts of that group
 * that aren't deleted). Each post's previous version goes to `post_edits`
 * first. Comments, readers and unread markers stay as they were.
 */
export async function editPost(v: Viewer, postId: string, input: { title?: unknown; doc?: unknown; body?: unknown }): Promise<Post> {
  const p = await visiblePost(v, postId);
  if (!p || p.author_id !== v.userId) throw new UpdateError(p ? "forbidden" : "notfound");
  const db = await getDb();
  const group = p.group_id
    ? await db.query("SELECT * FROM posts WHERE tenant_id = $1 AND group_id = $2 AND author_id = $3 AND status <> 'deleted'", [v.tenantId, p.group_id, v.userId])
    : [p];
  // Still allowed to post there (a student whose teacher turned posts off can't change one).
  for (const g of group) {
    if (!(await mayPost(v, g.course_id ? String(g.course_id) : null))) throw new UpdateError(v.kind === "student" ? "off" : "forbidden");
  }
  const title = clean(input.title, UPDATE_LIMITS.title).replace(/\s+/g, " ");
  const doc = await cleanDoc(v, input.doc);
  const body = doc ? docText(doc).slice(0, UPDATE_LIMITS.body) : clean(input.body, UPDATE_LIMITS.body);
  if (!body && !doc) throw new UpdateError("empty");
  const files = doc ? docFileIds(doc) : [];
  await db.tx(async (q) => {
    for (const g of group) {
      await q.query(
        `INSERT INTO post_edits (tenant_id, post_id, title, body, doc, file_ids, edited_by)
         VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7)`,
        [v.tenantId, g.id, g.title, g.body, g.doc ? JSON.stringify(g.doc) : null, g.file_ids ?? [], v.userId],
      );
      await q.query(
        `UPDATE posts SET title = $3, body = $4, doc = $5, file_ids = $6::uuid[], edited_at = now() WHERE tenant_id = $1 AND id = $2`,
        [v.tenantId, g.id, title, body, doc ? JSON.stringify(doc) : null, files],
      );
    }
  });
  const t = await thread(v, postId);
  return t!.post;
}

/** The places this viewer may post to now: their classes/clubs (as rules allow) and maybe the whole school. */
export async function postablePlaces(v: Viewer): Promise<{ courseIds: string[]; school: boolean }> {
  const ids = [...v.courses.keys()].filter(isId);
  const rules = await rulesFor(ids, v.tenantId);
  return {
    courseIds: ids.filter((c) => v.courses.get(c) === "teacher" || (rules.get(c)?.studentPosts ?? true)),
    school: v.kind === "staff" && v.canPostSchool,
  };
}

export type MaterialChoice = { kind: MaterialKind; id: string; courseId: string; title: string; draft: boolean; dueAt: string | null };

/** What a teacher may link in an update: each taught class's assignments, lessons and resources. */
export async function materialChoices(v: Viewer): Promise<MaterialChoice[]> {
  const teaches = [...v.courses].filter(([, r]) => r === "teacher").map(([c]) => c).filter(isId);
  if (!teaches.length) return [];
  const db = await getDb();
  const [as, ls, rs] = await Promise.all([
    db.query(`SELECT id, course_id, title, published, due_at FROM assignments WHERE tenant_id = $1 AND course_id = ANY($2::uuid[]) AND archived = false ORDER BY due_at DESC NULLS LAST, created_at DESC LIMIT 600`, [v.tenantId, teaches]),
    db.query(`SELECT id, course_id, title, planned_for FROM lessons WHERE tenant_id = $1 AND course_id = ANY($2::uuid[]) AND archived = false ORDER BY planned_for DESC NULLS LAST, created_at DESC LIMIT 600`, [v.tenantId, teaches]),
    db.query(`SELECT r.id, r.course_id, COALESCE(NULLIF(r.title, ''), NULLIF(r.block->>'title', ''), NULLIF(r.block->>'name', ''), l.title, '') AS title, r.visible, r.kind, r.block->>'type' AS block_type, l.title AS lesson_title FROM class_resources r LEFT JOIN lessons l ON l.id = r.lesson_id WHERE r.tenant_id = $1 AND r.course_id = ANY($2::uuid[]) AND r.archived = false ORDER BY r.position LIMIT 600`, [v.tenantId, teaches]),
  ]);
  return [
    ...as.map((a) => ({ kind: "assignment" as const, id: String(a.id), courseId: String(a.course_id), title: String(a.title), draft: !a.published, dueAt: a.due_at ? iso(a.due_at) : null })),
    ...ls.map((l) => ({ kind: "lesson" as const, id: String(l.id), courseId: String(l.course_id), title: String(l.title), draft: false, dueAt: null })),
    ...rs.map((r) => ({ kind: "resource" as const, id: String(r.id), courseId: String(r.course_id), title: String(r.title || r.lesson_title || r.block_type || ""), draft: !r.visible, dueAt: null })),
  ];
}

export async function addComment(v: Viewer, postId: string, body: unknown): Promise<Comment> {
  const p = await visiblePost(v, postId);
  if (!p) throw new UpdateError("notfound");
  const rules = await rulesFor(p.course_id ? [String(p.course_id)] : [], v.tenantId);
  if (!mayComment(v, p, rules)) throw new UpdateError(v.kind === "student" && p.course_id ? "off" : "forbidden");
  const text = clean(body, UPDATE_LIMITS.comment);
  if (!text) throw new UpdateError("empty");
  const db = await getDb();
  return db.tx(async (q) => {
    const [c] = await q.query(
      `INSERT INTO post_comments (tenant_id, post_id, body, author_id, author_name, author_kind)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [v.tenantId, p.id, text, v.userId, v.name.slice(0, UPDATE_LIMITS.name), authorKind(v)],
    );
    await q.query("UPDATE posts SET activity_at = now() WHERE id = $1", [p.id]);
    await q.query(
      `INSERT INTO post_reads (tenant_id, user_id, post_id) VALUES ($1, $2, $3)
       ON CONFLICT (post_id, user_id) DO UPDATE SET read_at = now()`,
      [v.tenantId, v.userId, p.id],
    );
    return {
      id: String(c.id), body: String(c.body), authorId: v.userId, authorName: String(c.author_name), authorKind: authorKind(v),
      status: "visible" as const, createdAt: iso(c.created_at), canModerate: true,
    };
  });
}

export type ModOp = "hide" | "unhide" | "delete";

/** Hide, show again or delete a post. Moderators any; its author only delete. */
export async function moderatePost(v: Viewer, postId: string, op: ModOp): Promise<boolean> {
  const p = await visiblePost(v, postId);
  if (!p) return false;
  const own = p.author_id === v.userId;
  if (!moderates(v, p) && !(own && op === "delete")) return false;
  const status = op === "hide" ? "hidden" : op === "unhide" ? "visible" : "deleted";
  const db = await getDb();
  await db.query("UPDATE posts SET status = $3, moderated_by = $4, moderated_at = now() WHERE tenant_id = $1 AND id = $2",
    [v.tenantId, p.id, status, v.userId]);
  return true;
}

export async function moderateComment(v: Viewer, commentId: string, op: ModOp): Promise<boolean> {
  if (!isId(commentId)) return false;
  const db = await getDb();
  const [c] = await db.query("SELECT * FROM post_comments WHERE tenant_id = $1 AND id = $2 AND status <> 'deleted'", [v.tenantId, commentId]);
  if (!c) return false;
  const p = await visiblePost(v, String(c.post_id));
  if (!p) return false;
  const own = c.author_id === v.userId;
  if (!moderates(v, p) && !(own && op === "delete")) return false;
  const status = op === "hide" ? "hidden" : op === "unhide" ? "visible" : "deleted";
  await db.query("UPDATE post_comments SET status = $3, moderated_by = $4, moderated_at = now() WHERE tenant_id = $1 AND id = $2",
    [v.tenantId, commentId, status, v.userId]);
  return true;
}

/** The course's teachers turn students' posts and comments on or off. */
export async function setCourseRules(v: Viewer, courseId: string, rules: CourseRules): Promise<boolean> {
  if (!isId(courseId) || v.courses.get(courseId) !== "teacher") return false;
  const db = await getDb();
  const rows = await db.query(
    "UPDATE courses SET student_posts = $3, student_comments = $4 WHERE tenant_id = $1 AND id = $2 RETURNING id",
    [v.tenantId, courseId, !!rules.studentPosts, !!rules.studentComments],
  );
  return rows.length > 0;
}

export async function markRead(v: Viewer, postIds: string[]): Promise<void> {
  const ids = postIds.filter(isId);
  if (!ids.length) return;
  const db = await getDb();
  await db.query(
    `INSERT INTO post_reads (tenant_id, user_id, post_id)
       SELECT $1, $2, p.id FROM posts p WHERE p.tenant_id = $1 AND p.id = ANY($3::uuid[])
     ON CONFLICT (post_id, user_id) DO UPDATE SET read_at = now()`,
    [v.tenantId, v.userId, ids],
  );
}
