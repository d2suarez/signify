import crypto from "node:crypto";
import { getDb, type Queryable } from "./db";
import { signAsTool, type Platform } from "./lti";
import type { Flag } from "./grade-math";

/**
 * LTI Assignment and Grade Services: released Learning grades go to the
 * Schoology line item of each placed assignment.
 *
 * A grade save only writes a row to `lti_scores` (in Learning's own database)
 * and nudges the sender; the save never waits on Schoology. The sender asks
 * the platform for a token (client credentials, a JWT signed with our key),
 * finds the student's platform user id (their own launches, else the
 * platform's class list by email) and the line item, then posts the score.
 * A failure is retried with backoff and stays visible; after the last try
 * the row is "failed" until a teacher presses Retry.
 *
 * What is sent follows the gradebook: a score counts as given (late is only a
 * mark), missing without a score is 0, exempt and ungraded send nothing.
 * Grades a student can't see yet (not released) aren't sent either.
 */

const SCOPE_SCORE = "https://purl.imsglobal.org/spec/lti-ags/scope/score";
const SCOPE_LINEITEM_RO = "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem.readonly";
const SCOPE_LINEITEM = "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem";
const SCOPE_NRPS = "https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly";
/** Wait before try n+1 (minutes). After the last, the row is failed. */
export const BACKOFF_MIN = [1, 5, 30, 120, 480];
const BATCH = 25;

export type ScoreStatus = "pending" | "sent" | "failed" | "skipped";
export type SkipReason = "exempt" | "ungraded" | "notReleased";

// ---------- what the gradebook says to send ----------

/** The score to send, or why nothing is sent. Mirrors grade-math's `contribution`. */
export function scoreToSend(g: { score: number | null; flag: Flag | null } | null, released: boolean):
  { score: number } | { skip: SkipReason } {
  if (!released) return { skip: "notReleased" };
  if (!g || g.flag === "exempt") return { skip: g ? "exempt" : "ungraded" };
  if (g.score !== null) return { score: g.score };
  if (g.flag === "missing") return { score: 0 };
  return { skip: "ungraded" };
}

// ---------- outside calls (swappable in tests) ----------

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
let doFetch: Fetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
/** For tests: where platform requests go. */
export function setAgsFetch(f: Fetch | null) {
  doFetch = f || ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }));
  tokens.clear();
  rosters.clear();
}

class SendError extends Error {}

// ---------- queueing (inside the teacher's request) ----------

export type QueueGrade = {
  studentId: string;
  /** From Signify ID's class list (teachers get emails); kept only until the platform user is found. */
  email?: string | null;
  grade: { score: number | null; flag: Flag | null; comment?: string } | null;
};

/**
 * Records what each placed copy of this assignment should now hold for these
 * students. Rows already sent with the same score are left alone. Returns how
 * many rows now wait to be sent.
 */
export async function queueGrades(
  tenantId: string, a: { id: string; points: number; gradesReleased: boolean }, grades: QueueGrade[],
): Promise<number> {
  const db = await getDb();
  const items = await db.query(
    "SELECT platform_id, context_id FROM lti_items WHERE tenant_id = $1 AND kind = 'assignment' AND item_id = $2", [tenantId, a.id]);
  if (!items.length || !grades.length) return 0;
  let waiting = 0;
  await db.tx(async (t) => {
    for (const it of items) for (const g of grades) {
      const want = scoreToSend(g.grade, a.gradesReleased);
      const score = "score" in want ? want.score : null;
      const comment = "score" in want ? String(g.grade?.comment ?? "").slice(0, 1000) : "";
      const [cur] = await t.query(
        `SELECT status, score, score_max, comment FROM lti_scores WHERE platform_id = $1 AND context_id = $2 AND assignment_id = $3 AND student_id = $4`,
        [it.platform_id, it.context_id, a.id, g.studentId]);
      // Nothing to send and nothing sent before: no row (a class of ungraded students stays quiet).
      if ("skip" in want && !cur && (want.skip === "ungraded" || (want.skip === "notReleased" && !g.grade))) continue;
      const same = cur && (cur.score == null ? null : Number(cur.score)) === score && Number(cur.score_max) === a.points && String(cur.comment) === comment;
      if (same && (cur.status === "sent" || cur.status === "skipped" || cur.status === "pending")) {
        if (cur.status === "pending") waiting++;
        continue;
      }
      const status: ScoreStatus = "score" in want ? "pending" : "skipped";
      if (status === "pending") waiting++;
      await t.query(
        `INSERT INTO lti_scores (tenant_id, platform_id, context_id, assignment_id, student_id, status, score, score_max, comment,
           email, attempts, next_at, last_error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, now(), $11)
         ON CONFLICT (platform_id, context_id, assignment_id, student_id) DO UPDATE SET
           status = EXCLUDED.status, score = EXCLUDED.score, score_max = EXCLUDED.score_max, comment = EXCLUDED.comment,
           email = CASE WHEN lti_scores.platform_user_id = '' THEN EXCLUDED.email ELSE '' END,
           attempts = 0, next_at = now(), last_error = EXCLUDED.last_error, rev = lti_scores.rev + 1, updated_at = now()`,
        [tenantId, it.platform_id, it.context_id, a.id, g.studentId, status, score, a.points, comment,
          status === "pending" ? String(g.email || "").trim().toLowerCase().slice(0, 320) : "",
          "skip" in want ? want.skip : ""]);
    }
  });
  return waiting;
}

/** A teacher's Retry: failed (or waiting) rows of this assignment go again now. */
export async function retryScores(tenantId: string, assignmentId: string, studentId?: string): Promise<number> {
  const db = await getDb();
  const rows = await db.query(
    `UPDATE lti_scores SET status = 'pending', attempts = 0, next_at = now(), rev = rev + 1, updated_at = now()
     WHERE tenant_id = $1 AND assignment_id = $2 AND status IN ('failed', 'pending') ${studentId ? "AND student_id = $3" : ""}
     RETURNING id`, studentId ? [tenantId, assignmentId, studentId] : [tenantId, assignmentId]);
  return rows.length;
}

export type ScoreRow = {
  studentId: string; contextId: string; status: ScoreStatus; score: number | null; attempts: number;
  error: string; sentAt: string | null; nextAt: string;
};

export async function scoreStatuses(tenantId: string, assignmentId: string): Promise<ScoreRow[]> {
  const db = await getDb();
  const rows = await db.query(
    `SELECT student_id, context_id, status, score, attempts, last_error, sent_at, next_at FROM lti_scores
     WHERE tenant_id = $1 AND assignment_id = $2 ORDER BY student_id, context_id`, [tenantId, assignmentId]);
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v ? String(v) : null);
  return rows.map((r) => ({
    studentId: String(r.student_id), contextId: String(r.context_id), status: String(r.status) as ScoreStatus,
    score: r.score == null ? null : Number(r.score), attempts: Number(r.attempts), error: String(r.last_error),
    sentAt: iso(r.sent_at), nextAt: iso(r.next_at) || "",
  }));
}

// ---------- sending (in the background) ----------

type Claimed = {
  id: string; tenant_id: string; platform_id: string; context_id: string; assignment_id: string; student_id: string;
  score: string | number; score_max: string | number; comment: string; email: string; platform_user_id: string;
  attempts: number; rev: number;
};

/**
 * Sends every row that is due. Each row is claimed first (pushed 5 minutes
 * on), so two senders never post the same row; the result is written only
 * if the row wasn't changed by a newer save meanwhile.
 */
export async function sendDue(now = Date.now()): Promise<{ sent: number; failed: number }> {
  const db = await getDb();
  const claimed = await db.tx(async (t) => t.query<Claimed>(
    `UPDATE lti_scores SET next_at = $1 WHERE id IN (
       SELECT id FROM lti_scores WHERE status = 'pending' AND next_at <= $2 ORDER BY next_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
     RETURNING *`, [new Date(now + 5 * 60_000), new Date(now)]));
  let sent = 0, failed = 0;
  for (const row of claimed) {
    try {
      await sendOne(db, row);
      const done = await db.query(
        `UPDATE lti_scores SET status = 'sent', sent_at = $3, attempts = attempts + 1, last_error = '', email = ''
         WHERE id = $1 AND rev = $2 AND status = 'pending' RETURNING id`, [row.id, row.rev, new Date(now)]);
      if (done[0]) sent++;
    } catch (e) {
      const error = (e instanceof SendError ? e.message : `network: ${(e as Error).message}`).slice(0, 300);
      const attempts = Number(row.attempts) + 1;
      const last = attempts > BACKOFF_MIN.length;
      await db.query(
        `UPDATE lti_scores SET status = $3, attempts = $4, next_at = $5, last_error = $6
         WHERE id = $1 AND rev = $2 AND status = 'pending'`,
        [row.id, row.rev, last ? "failed" : "pending", attempts,
          new Date(now + (last ? 0 : BACKOFF_MIN[attempts - 1] * 60_000)), error]);
      failed++;
    }
  }
  return { sent, failed };
}

async function sendOne(db: Queryable, row: Claimed): Promise<void> {
  const [p] = await db.query("SELECT * FROM lti_platforms WHERE id = $1 AND tenant_id = $2", [row.platform_id, row.tenant_id]);
  if (!p) throw new SendError("platformGone");
  const platform: Pick<Platform, "id" | "tenantId" | "clientId" | "tokenUrl"> = {
    id: String(p.id), tenantId: String(p.tenant_id), clientId: String(p.client_id), tokenUrl: String(p.token_url || ""),
  };
  if (!platform.tokenUrl) throw new SendError("noTokenUrl");
  const [svc] = await db.query("SELECT * FROM lti_context_services WHERE platform_id = $1 AND context_id = $2", [row.platform_id, row.context_id]);
  const scopes = (svc?.ags_scopes as string[]) || [];
  if (!svc || !scopes.includes(SCOPE_SCORE)) throw new SendError("noGradeService");

  const userId = await platformUser(db, platform, row, svc);
  const lineitem = await lineItem(db, platform, row, svc, scopes);
  const token = await accessToken(platform, [SCOPE_SCORE]);
  const res = await doFetch(scoresUrl(lineitem), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/vnd.ims.lis.v1.score+json" },
    body: JSON.stringify({
      userId,
      scoreGiven: Number(row.score),
      scoreMaximum: Number(row.score_max) > 0 ? Number(row.score_max) : 100,
      ...(row.comment ? { comment: row.comment } : {}),
      timestamp: new Date().toISOString(),
      activityProgress: "Completed",
      gradingProgress: "FullyGraded",
    }),
  });
  if (res.status === 401) tokens.delete(tokenKey(platform, [SCOPE_SCORE]));
  if (!res.ok) throw new SendError(`scorePost ${res.status}`);
}

/** The line item's /scores address (before any query string). */
export function scoresUrl(lineitem: string): string {
  const u = new URL(lineitem);
  u.pathname = `${u.pathname.replace(/\/$/, "")}/scores`;
  return u.toString();
}

async function lineItem(db: Queryable, platform: Pick<Platform, "id" | "tenantId" | "clientId" | "tokenUrl">, row: Claimed,
  svc: Record<string, unknown>, scopes: string[]): Promise<string> {
  const [it] = await db.query(
    "SELECT lineitem_url FROM lti_items WHERE platform_id = $1 AND context_id = $2 AND kind = 'assignment' AND item_id = $3",
    [row.platform_id, row.context_id, row.assignment_id]);
  if (it?.lineitem_url) return String(it.lineitem_url);
  // Nobody has launched the link yet: look the column up by the resource id we gave it.
  const container = String(svc.lineitems_url || "");
  const readScope = scopes.includes(SCOPE_LINEITEM_RO) ? SCOPE_LINEITEM_RO : scopes.includes(SCOPE_LINEITEM) ? SCOPE_LINEITEM : null;
  if (!container || !readScope) throw new SendError("noLineItem");
  const u = new URL(container);
  u.searchParams.set("resource_id", `assignment:${row.assignment_id}`);
  const token = await accessToken(platform, [readScope]);
  const res = await doFetch(u.toString(), { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.ims.lis.v2.lineitemcontainer+json" } });
  if (!res.ok) throw new SendError(`lineItems ${res.status}`);
  const list = (await res.json()) as { id?: string; resourceId?: string }[];
  const found = Array.isArray(list) ? list.find((l) => l.resourceId === `assignment:${row.assignment_id}` && typeof l.id === "string") : undefined;
  if (!found?.id || !/^https:\/\//.test(found.id)) throw new SendError("noLineItem");
  await db.query("UPDATE lti_items SET lineitem_url = $4 WHERE platform_id = $1 AND context_id = $2 AND kind = 'assignment' AND item_id = $3",
    [row.platform_id, row.context_id, row.assignment_id, found.id]);
  return found.id;
}

const ROSTER_MS = 5 * 60_000;
const rosters = new Map<string, { at: number; byEmail: Map<string, string> }>();

async function platformUser(db: Queryable, platform: Pick<Platform, "id" | "tenantId" | "clientId" | "tokenUrl">, row: Claimed,
  svc: Record<string, unknown>): Promise<string> {
  if (row.platform_user_id) return row.platform_user_id;
  const [known] = await db.query("SELECT sub FROM lti_users WHERE platform_id = $1 AND user_id = $2", [row.platform_id, row.student_id]);
  let sub = known ? String(known.sub) : "";
  if (!sub) {
    const url = String(svc.nrps_url || "");
    if (!url) throw new SendError("noRoster");
    if (!row.email) throw new SendError("noEmail");
    sub = (await rosterByEmail(platform, url)).get(row.email) || "";
    if (!sub) throw new SendError("notInPlatformClass");
    await db.query(
      `INSERT INTO lti_users (tenant_id, platform_id, user_id, sub) VALUES ($1, $2, $3, $4)
       ON CONFLICT (platform_id, user_id) DO UPDATE SET sub = EXCLUDED.sub, updated_at = now()`,
      [row.tenant_id, row.platform_id, row.student_id, sub]);
  }
  await db.query("UPDATE lti_scores SET platform_user_id = $2, email = '' WHERE id = $1", [row.id, sub]);
  return sub;
}

/** The platform's class list (Names and Roles), email to user id; a few pages at most. */
async function rosterByEmail(platform: Pick<Platform, "id" | "tenantId" | "clientId" | "tokenUrl">, url: string): Promise<Map<string, string>> {
  const hit = rosters.get(url);
  if (hit && Date.now() - hit.at < ROSTER_MS) return hit.byEmail;
  const token = await accessToken(platform, [SCOPE_NRPS]);
  const byEmail = new Map<string, string>();
  let next: string | null = url;
  for (let page = 0; next && page < 20; page++) {
    const res: Response = await doFetch(next, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.ims.lti-nrps.v2.membershipcontainer+json" } });
    if (!res.ok) throw new SendError(`roster ${res.status}`);
    const body = (await res.json()) as { members?: { user_id?: string; email?: string }[] };
    for (const m of body.members || []) if (m.user_id && m.email) byEmail.set(m.email.trim().toLowerCase(), m.user_id);
    const link = /<([^>]+)>;\s*rel="?next"?/.exec(res.headers.get("link") || "");
    next = link && /^https:\/\//.test(link[1]) ? link[1] : null;
  }
  rosters.set(url, { at: Date.now(), byEmail });
  return byEmail;
}

// ---------- the platform's access token ----------

const tokens = new Map<string, { token: string; until: number }>();
const tokenKey = (p: { id: string }, scopes: string[]) => `${p.id} ${[...scopes].sort().join(" ")}`;

/** OAuth 2 client credentials with a signed JWT (RFC 7523), as LTI 1.3 requires. Cached until a minute before expiry. */
async function accessToken(platform: Pick<Platform, "id" | "tenantId" | "clientId" | "tokenUrl">, scopes: string[]): Promise<string> {
  const key = tokenKey(platform, scopes);
  const hit = tokens.get(key);
  if (hit && hit.until > Date.now()) return hit.token;
  const nowS = Math.floor(Date.now() / 1000);
  const assertion = await signAsTool(platform.tenantId, {
    iss: platform.clientId, sub: platform.clientId, aud: platform.tokenUrl,
    iat: nowS, exp: nowS + 300, jti: crypto.randomBytes(16).toString("hex"),
  });
  const res = await doFetch(platform.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: assertion,
      scope: scopes.join(" "),
    }).toString(),
  });
  if (!res.ok) throw new SendError(`token ${res.status}`);
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new SendError("token");
  tokens.set(key, { token: body.access_token, until: Date.now() + Math.max(60, Number(body.expires_in) || 3600) * 1000 - 60_000 });
  return body.access_token;
}

// ---------- the background sender ----------

type Worker = { timer?: ReturnType<typeof setInterval>; running?: boolean };
const worker: Worker = ((globalThis as unknown as { __learningAgs?: Worker }).__learningAgs ??= {});

/** Sends now (not awaited by the caller) and keeps a one-minute retry loop going. Never throws. */
export function kickScores(): void {
  if (!worker.timer) {
    worker.timer = setInterval(() => kickScores(), 60_000);
    worker.timer.unref?.();
  }
  if (worker.running) return;
  worker.running = true;
  sendDue().catch((e) => console.warn(`learning: grade passback: ${(e as Error).message}`)).finally(() => { worker.running = false; });
}
