import { getDb } from "./db";

/**
 * Announcements: a course's teachers post, the class reads them on the course
 * page, newest first. Only the course page's teacher actions write here (they
 * check the person teaches the course); taking one down archives it.
 */

export type Announcement = { id: string; courseId: string; title: string; body: string; createdBy: string; createdAt: string };

type Ctx = { tenantId: string; userId: string };
const UUID = /^[0-9a-f-]{36}$/i;
export const ANNOUNCEMENT_LIMITS = { title: 200, body: 5_000, shown: 20 };

function toAnnouncement(r: Record<string, unknown>): Announcement {
  return {
    id: String(r.id), courseId: String(r.course_id), title: String(r.title), body: String(r.body),
    createdBy: String(r.created_by), createdAt: new Date(r.created_at as string).toISOString(),
  };
}

export async function listAnnouncements(ctx: Ctx, courseId: string, limit = ANNOUNCEMENT_LIMITS.shown): Promise<Announcement[]> {
  const db = await getDb();
  const rows = await db.query(
    `SELECT * FROM announcements WHERE tenant_id = $1 AND course_id = $2 AND archived = false
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
    "INSERT INTO announcements (tenant_id, course_id, title, body, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *",
    [ctx.tenantId, courseId, title, body, ctx.userId],
  );
  return toAnnouncement(rows[0]);
}

export async function archiveAnnouncement(ctx: Ctx, courseId: string, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const db = await getDb();
  const rows = await db.query(
    "UPDATE announcements SET archived = true WHERE tenant_id = $1 AND course_id = $2 AND id = $3 RETURNING id",
    [ctx.tenantId, courseId, id],
  );
  return rows.length > 0;
}
