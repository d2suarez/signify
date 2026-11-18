import { getDb } from "./db";
import type { CourseKind } from "./courses";

/**
 * Clubs and organizations (migration 020). A club is a `courses` row with
 * kind 'club': its roster is its Signify ID class (teachers = sponsors,
 * students = members), and it has updates, plans and events but no
 * academics. The caller checks with Signify ID that the person is one of
 * its sponsors before any write here.
 */

type Ctx = { tenantId: string; userId: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EVENT_LIMITS = { title: 200, place: 200, notes: 2_000, shown: 50 };

export type ClubEvent = { id: string; courseId: string; title: string; onDay: string; startTime: string; place: string; notes: string };

export async function setKind(ctx: Ctx, courseId: string, kind: CourseKind): Promise<boolean> {
  if (!UUID.test(courseId)) return false;
  const db = await getDb();
  const rows = await db.query("UPDATE courses SET kind = $3 WHERE tenant_id = $1 AND id = $2 RETURNING id",
    [ctx.tenantId, courseId, kind === "club" ? "club" : "class"]);
  return rows.length > 0;
}

export async function courseKind(ctx: Pick<Ctx, "tenantId">, courseId: string): Promise<CourseKind | null> {
  if (!UUID.test(courseId)) return null;
  const db = await getDb();
  const [r] = await db.query("SELECT kind FROM courses WHERE tenant_id = $1 AND id = $2", [ctx.tenantId, courseId]);
  return r ? (r.kind === "club" ? "club" : "class") : null;
}

function toEvent(r: Record<string, unknown>): ClubEvent {
  const day = r.on_day instanceof Date ? r.on_day.toISOString().slice(0, 10) : String(r.on_day).slice(0, 10);
  return {
    id: String(r.id), courseId: String(r.course_id), title: String(r.title), onDay: day,
    startTime: String(r.start_time ?? ""), place: String(r.place ?? ""), notes: String(r.notes ?? ""),
  };
}

/** Upcoming first (from `from`, a YYYY-MM-DD), then the most recent past ones. */
export async function listEvents(ctx: Pick<Ctx, "tenantId">, courseId: string, from: string): Promise<{ upcoming: ClubEvent[]; past: ClubEvent[] }> {
  const db = await getDb();
  const rows = await db.query(
    "SELECT * FROM club_events WHERE tenant_id = $1 AND course_id = $2 AND archived = false ORDER BY on_day, start_time, id LIMIT 500",
    [ctx.tenantId, courseId],
  );
  const all = rows.map(toEvent);
  return {
    upcoming: all.filter((e) => e.onDay >= from).slice(0, EVENT_LIMITS.shown),
    past: all.filter((e) => e.onDay < from).reverse().slice(0, 10),
  };
}

export class EventError extends Error {}

export async function addEvent(ctx: Ctx, courseId: string, input: { title?: unknown; onDay?: unknown; startTime?: unknown; place?: unknown; notes?: unknown }): Promise<ClubEvent> {
  const title = String(input.title ?? "").replace(/\s+/g, " ").trim().slice(0, EVENT_LIMITS.title);
  const onDay = String(input.onDay ?? "");
  if (!title) throw new EventError("title");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(onDay) || Number.isNaN(Date.parse(`${onDay}T00:00:00Z`))) throw new EventError("day");
  const t = String(input.startTime ?? "").trim();
  const startTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? t : "";
  if ((await courseKind(ctx, courseId)) !== "club") throw new EventError("notclub");
  const db = await getDb();
  const [r] = await db.query(
    `INSERT INTO club_events (tenant_id, course_id, title, on_day, start_time, place, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [ctx.tenantId, courseId, title, onDay, startTime, String(input.place ?? "").trim().slice(0, EVENT_LIMITS.place),
      String(input.notes ?? "").replace(/\r\n/g, "\n").trim().slice(0, EVENT_LIMITS.notes), ctx.userId],
  );
  return toEvent(r);
}

export async function archiveEvent(ctx: Ctx, courseId: string, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const db = await getDb();
  const rows = await db.query("UPDATE club_events SET archived = true WHERE tenant_id = $1 AND course_id = $2 AND id = $3 RETURNING id",
    [ctx.tenantId, courseId, id]);
  return rows.length > 0;
}
