import { getDb, type Row } from "./db";

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
export type Post = {
  id: string; courseId: string | null; courseName: string; title: string; body: string;
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
  constructor(public code: "forbidden" | "empty" | "notfound" | "off") { super(code); }
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
    title: String(r.title), body: String(r.body), authorId: String(r.author_id), authorName: String(r.author_name ?? ""),
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
  return rows.map((r) => {
    const p = toPost(v, r, rules);
    // A parent sees no comments, so no count either.
    return v.kind === "parent" ? { ...p, comments: 0 } : p;
  });
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

export async function createPost(v: Viewer, input: { courseId?: unknown; title?: unknown; body?: unknown }): Promise<Post> {
  const courseId = input.courseId == null || input.courseId === "" || input.courseId === "school" ? null : String(input.courseId);
  if (courseId !== null && !isId(courseId)) throw new UpdateError("forbidden");
  if (!(await mayPost(v, courseId))) {
    throw new UpdateError(courseId && v.courses.get(courseId) === "student" ? "off" : "forbidden");
  }
  const title = clean(input.title, UPDATE_LIMITS.title).replace(/\s+/g, " ");
  const body = clean(input.body, UPDATE_LIMITS.body);
  if (!body) throw new UpdateError("empty");
  const db = await getDb();
  if (courseId) {
    // The viewer's courses come from Signify ID, but check the course is this school's anyway.
    const [c] = await db.query("SELECT 1 FROM courses WHERE tenant_id = $1 AND id = $2", [v.tenantId, courseId]);
    if (!c) throw new UpdateError("forbidden");
  }
  const r = await db.tx(async (q) => {
    const [row] = await q.query(
      `INSERT INTO posts (tenant_id, course_id, title, body, author_id, author_name, author_kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [v.tenantId, courseId, title, body, v.userId, v.name.slice(0, UPDATE_LIMITS.name), authorKind(v)],
    );
    await q.query("INSERT INTO post_reads (tenant_id, user_id, post_id, read_at) VALUES ($1, $2, $3, $4)", [v.tenantId, v.userId, row.id, row.activity_at]);
    return row;
  });
  return toPost(v, { ...r, read_at: r.created_at, comments: 0 }, await rulesFor(courseId ? [courseId] : [], v.tenantId));
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
