import { getDb } from "./db";

/**
 * Announcements are now Updates (migration 018 moved every row into `posts`
 * with the same id): a class's teachers' posts. Kept for the places that
 * want just those (This week, the parent view, practice fill). Only callers
 * that checked the person teaches the course write here.
 */

export type Announcement = { id: string; courseId: string; title: string; body: string; createdBy: string; createdAt: string };

type Ctx = { tenantId: string; userId: string; name?: string };
const UUID = /^[0-9a-f-]{36}$/i;
export const ANNOUNCEMENT_LIMITS = { title: 200, body: 5_000, shown: 20 };

function toAnnouncement(r: Record<string, unknown>): Announcement {
  return {
    id: String(r.id), courseId: String(r.course_id), title: String(r.title), body: String(r.body),
    createdBy: String(r.author_id), createdAt: new Date(r.created_at as string).toISOString(),
  };
}

/** The class's visible posts by staff, newest first. */
export async function listAnnouncements(ctx: Ctx, courseId: string, limit = ANNOUNCEMENT_LIMITS.shown): Promise<Announcement[]> {
  const db = await getDb();
  const rows = await db.query(
    `SELECT * FROM posts WHERE tenant_id = $1 AND course_id = $2 AND status = 'visible' AND author_kind = 'staff'
      ORDER BY created_at DESC, id LIMIT $3`,
    [ctx.tenantId, courseId, limit],
  );
  return rows.map(toAnnouncement);
}

/** Null when there's nothing to post. */
export async function postAnnouncement(ctx: Ctx, courseId: string, input: { title?: unknown; body?: unknown }): Promise<Announcement | null> {
  const title = String(input.title ?? "").replace(/\s+/g, " ").trim().slice(0, ANNOUNCEMENT_LIMITS.title);
  const body = String(input.body ?? "").replace(/\r\n/g, "\n").trim().slice(0, ANNOUNCEMENT_LIMITS.body);
  if (!body) return null;
  const db = await getDb();
  const rows = await db.query(
    `INSERT INTO posts (tenant_id, course_id, title, body, author_id, author_name, author_kind)
     VALUES ($1, $2, $3, $4, $5, $6, 'staff') RETURNING *`,
    [ctx.tenantId, courseId, title, body, ctx.userId, String(ctx.name ?? "").slice(0, 200)],
  );
  return toAnnouncement(rows[0]);
}

/** Taking one down deletes the post (kept, shown to no one). */
export async function archiveAnnouncement(ctx: Ctx, courseId: string, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const db = await getDb();
  const rows = await db.query(
    `UPDATE posts SET status = 'deleted', moderated_by = $4, moderated_at = now()
      WHERE tenant_id = $1 AND course_id = $2 AND id = $3 AND status <> 'deleted' RETURNING id`,
    [ctx.tenantId, courseId, id, ctx.userId],
  );
  return rows.length > 0;
}
