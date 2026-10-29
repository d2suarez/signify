import crypto from "node:crypto";
import { getDb } from "./db";
import { b64json, jwksKey } from "./lti";
import { SCOPE, getLink, spendNonce, toolByClient, userForSub, type Tool, type ToolLink } from "./lti-platform";
import { getAssignment, type Assignment } from "./assignments";
import { gradesFor, setGrade } from "./grades";

/**
 * LTI Assignment and Grade Services, Learning as the platform: a tool posts
 * scores for a placed assignment.
 *
 *   POST /lti/platform/token  client credentials with a JWT assertion signed
 *        by the tool's key (iss = sub = client id, aud = this URL, one-time
 *        jti). Scopes: line items read-only and score; nothing else.
 *   GET  /lti/platform/ags/<course>/lineitems[/<link>]  this tool's placed
 *        assignments in that course (only courses it is placed in).
 *   POST /lti/platform/ags/<course>/lineitems/<link>/scores
 *
 * A score is kept in `lti_tool_scores` (latest by the tool's timestamp) and
 * written to the gradebook by setGrade, with history and the roster check,
 * when Signify ID can say who is in the class: a teacher's page for the
 * assignment or gradebook, or the student's own assignment page. A tool has
 * no Signify token, so it can never be the one that asks.
 */

export const GRANTABLE = [SCOPE.lineitemRead, SCOPE.score];
const TOKEN_TTL_S = 3600;
const SKEW_S = 60;
const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- rate limit (one process) ----------

const hits: Map<string, number[]> = ((globalThis as unknown as { __learningTokenHits?: Map<string, number[]> }).__learningTokenHits ??= new Map());
/** At most `max` token requests a minute per key (the caller's address). */
export function tokenRateOk(key: string, now = Date.now(), max = 30): boolean {
  const recent = (hits.get(key) || []).filter((t) => now - t < 60_000);
  if (recent.length >= max) { hits.set(key, recent); return false; }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < 60_000)) hits.delete(k);
  return true;
}
export function resetTokenRate() { hits.clear(); }

// ---------- tokens ----------

export type TokenResult =
  | { ok: true; body: { access_token: string; token_type: "Bearer"; expires_in: number; scope: string } }
  | { ok: false; status: number; error: string };

const hash = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

export async function issueToken(form: URLSearchParams, tokenUrl: string, now = Date.now()): Promise<TokenResult> {
  const bad = (error: string, status = 400): TokenResult => ({ ok: false, status, error });
  if (form.get("grant_type") !== "client_credentials") return bad("unsupported_grant_type");
  if (form.get("client_assertion_type") !== ASSERTION_TYPE) return bad("invalid_request");
  const jwt = form.get("client_assertion") || "";
  const parts = jwt.split(".");
  if (parts.length !== 3 || jwt.length > 20_000) return bad("invalid_client", 401);
  const header = b64json(parts[0]), claims = b64json(parts[1]);
  if (!header || !claims || header.alg !== "RS256") return bad("invalid_client", 401);
  const tool = await toolByClient(typeof claims.iss === "string" ? claims.iss : "");
  if (!tool || claims.sub !== tool.clientId) return bad("invalid_client", 401);
  let key: crypto.KeyObject | null = null;
  try { key = await jwksKey(tool.jwksUrl, typeof header.kid === "string" ? header.kid : undefined); } catch { return bad("invalid_client", 401); }
  if (!key || !crypto.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url"))) {
    return bad("invalid_client", 401);
  }
  const aud = Array.isArray(claims.aud) ? claims.aud.map(String) : [String(claims.aud ?? "")];
  if (!aud.includes(tokenUrl)) return bad("invalid_client", 401);
  const exp = Number(claims.exp), iat = Number(claims.iat), nowS = Math.floor(now / 1000);
  if (!Number.isFinite(exp) || exp + SKEW_S < nowS || exp - nowS > 3600) return bad("invalid_client", 401);
  if (Number.isFinite(iat) && iat - SKEW_S > nowS) return bad("invalid_client", 401);
  const jti = typeof claims.jti === "string" ? claims.jti.slice(0, 255) : "";
  if (!jti || !(await spendNonce(tool, `jti:${jti}`, exp))) return bad("invalid_client", 401);
  const scopes = (form.get("scope") || "").split(/\s+/).filter((s) => GRANTABLE.includes(s));
  if (!scopes.length) return bad("invalid_scope");
  const token = crypto.randomBytes(32).toString("base64url");
  const db = await getDb();
  await db.query("DELETE FROM lti_tool_tokens WHERE expires_at < now()");
  await db.query("INSERT INTO lti_tool_tokens (hash, tenant_id, tool_id, scopes, expires_at) VALUES ($1, $2, $3, $4, $5)",
    [hash(token), tool.tenantId, tool.id, scopes, new Date(now + TOKEN_TTL_S * 1000)]);
  return { ok: true, body: { access_token: token, token_type: "Bearer", expires_in: TOKEN_TTL_S, scope: scopes.join(" ") } };
}

/**
 * Which tool a service request is, if its token is good and has `scope`,
 * and the course is one of that tool's school's courses the tool is placed in.
 */
export async function serviceAuth(authorization: string | null, scope: string, courseId: string, now = Date.now()):
  Promise<{ ok: true; tool: Tool } | { ok: false; status: number }> {
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,100})$/.exec(authorization || "");
  if (!m) return { ok: false, status: 401 };
  const db = await getDb();
  const [t] = await db.query("SELECT * FROM lti_tool_tokens WHERE hash = $1", [hash(m[1])]);
  if (!t || new Date(String(t.expires_at)).getTime() < now) return { ok: false, status: 401 };
  const scopes = (t.scopes as string[]) || [];
  if (!scopes.includes(scope)) return { ok: false, status: 403 };
  const [tr] = await db.query("SELECT client_id FROM lti_tools WHERE id = $1", [t.tool_id]);
  const tool = tr ? await toolByClient(String(tr.client_id)) : null;
  if (!tool || tool.tenantId !== String(t.tenant_id)) return { ok: false, status: 401 };
  if (!UUID.test(courseId)) return { ok: false, status: 404 };
  const [placed] = await db.query("SELECT 1 FROM lti_tool_links WHERE tenant_id = $1 AND tool_id = $2 AND course_id = $3 LIMIT 1",
    [tool.tenantId, tool.id, courseId]);
  return placed ? { ok: true, tool } : { ok: false, status: 404 };
}

// ---------- line items ----------

export type LineItem = {
  id: string; label: string; scoreMaximum: number; resourceLinkId: string;
  resourceId?: string; tag?: string; endDateTime?: string;
};

function lineItemOf(origin: string, link: ToolLink, a: Assignment): LineItem {
  return {
    id: `${origin}/lti/platform/ags/${link.courseId}/lineitems/${link.id}`,
    label: a.title, scoreMaximum: a.points, resourceLinkId: link.id,
    ...(link.lineItem?.resourceId ? { resourceId: link.lineItem.resourceId } : {}),
    ...(link.lineItem?.tag ? { tag: link.lineItem.tag } : {}),
    ...(a.dueAt ? { endDateTime: a.dueAt } : {}),
  };
}

/** This tool's placed assignments in the course, as line items (archived ones left out). */
export async function lineItems(tool: Tool, courseId: string, origin: string,
  filter: { resourceLinkId?: string | null; resourceId?: string | null; tag?: string | null } = {}): Promise<LineItem[]> {
  const db = await getDb();
  const rows = await db.query(
    `SELECT id FROM lti_tool_links WHERE tenant_id = $1 AND tool_id = $2 AND course_id = $3 AND assignment_id IS NOT NULL ORDER BY created_at`,
    [tool.tenantId, tool.id, courseId]);
  const out: LineItem[] = [];
  for (const r of rows.slice(0, 200)) {
    const li = await lineItem(tool, courseId, String(r.id), origin);
    if (!li) continue;
    if (filter.resourceLinkId && li.resourceLinkId !== filter.resourceLinkId) continue;
    if (filter.resourceId && li.resourceId !== filter.resourceId) continue;
    if (filter.tag && li.tag !== filter.tag) continue;
    out.push(li);
  }
  return out;
}

async function linkAndAssignment(tool: Tool, courseId: string, linkId: string) {
  const link = await getLink(tool.tenantId, linkId);
  if (!link || link.toolId !== tool.id || link.courseId !== courseId || !link.assignmentId) return null;
  const a = await getAssignment({ tenantId: tool.tenantId, userId: `lti-tool:${tool.id}` }, link.assignmentId);
  if (!a || a.courseId !== courseId) return null;
  return { link, a };
}

export async function lineItem(tool: Tool, courseId: string, linkId: string, origin: string): Promise<LineItem | null> {
  const la = await linkAndAssignment(tool, courseId, linkId);
  return la ? lineItemOf(origin, la.link, la.a) : null;
}

// ---------- scores ----------

const ACTIVITY = ["Initialized", "Started", "InProgress", "Submitted", "Completed"];
const GRADING = ["FullyGraded", "Pending", "PendingManual", "Failed", "NotReady"];

/** A tool's score post. 200 when kept, 400 bad body, 404 unknown line item or user, 409 older than what we have. */
export async function postScore(tool: Tool, courseId: string, linkId: string, body: unknown): Promise<{ status: number; error?: string }> {
  const la = await linkAndAssignment(tool, courseId, linkId);
  if (!la) return { status: 404, error: "unknown line item" };
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const studentId = await userForSub(tool, String(b.userId ?? ""));
  if (!studentId) return { status: 404, error: "unknown user" };
  const activity = String(b.activityProgress ?? ""), grading = String(b.gradingProgress ?? "");
  if (!ACTIVITY.includes(activity) || !GRADING.includes(grading)) return { status: 400, error: "bad progress" };
  const time = new Date(String(b.timestamp ?? ""));
  if (Number.isNaN(time.getTime())) return { status: 400, error: "bad timestamp" };
  let given: number | null = null, max: number | null = null;
  if (b.scoreGiven !== undefined && b.scoreGiven !== null) {
    given = Number(b.scoreGiven); max = Number(b.scoreMaximum);
    if (!Number.isFinite(given) || given < 0 || !Number.isFinite(max) || max <= 0 || given > max * 10) return { status: 400, error: "bad score" };
  }
  const comment = typeof b.comment === "string" ? b.comment.slice(0, 2000) : "";
  const status = grading === "FullyGraded" && given !== null ? "waiting" : "recorded";
  const db = await getDb();
  const rows = await db.query(
    `INSERT INTO lti_tool_scores (tenant_id, tool_id, link_id, assignment_id, student_id, score_given, score_maximum, activity, grading, comment, tool_time, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (link_id, student_id) DO UPDATE SET score_given = EXCLUDED.score_given, score_maximum = EXCLUDED.score_maximum,
       activity = EXCLUDED.activity, grading = EXCLUDED.grading, comment = EXCLUDED.comment, tool_time = EXCLUDED.tool_time,
       status = EXCLUDED.status, received_at = now(), written_at = NULL
     WHERE lti_tool_scores.tool_time < EXCLUDED.tool_time
     RETURNING id`,
    [tool.tenantId, tool.id, la.link.id, la.a.id, studentId, given, max, activity, grading, comment, time, status]);
  // Same or older timestamp than the score we hold: refused, ours stands.
  return rows[0] ? { status: 200 } : { status: 409, error: "older than the last score" };
}

/** The tool's score in this assignment's points (2 decimals). */
export function scaled(given: number, max: number, points: number): number {
  return Math.round((given / max) * points * 100) / 100;
}

/**
 * Writes waiting tool scores for this assignment through setGrade. `students`
 * are the class's students per Signify ID now; anyone else is refused (and
 * stays visible as refused). Returns the students whose grade changed.
 */
export async function applyToolScores(tenantId: string, a: Assignment, students: Set<string>, only?: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db.query(
    `SELECT s.*, t.name AS tool_name FROM lti_tool_scores s JOIN lti_tools t ON t.id = s.tool_id
     WHERE s.tenant_id = $1 AND s.assignment_id = $2 AND s.status = 'waiting'${only ? " AND s.student_id = $3" : ""}`,
    only ? [tenantId, a.id, only] : [tenantId, a.id]);
  if (!rows.length) return [];
  const current = await gradesFor({ tenantId, userId: "" }, a.id);
  const changed: string[] = [];
  for (const r of rows) {
    const sid = String(r.student_id);
    if (!students.has(sid) || a.points <= 0) {
      if (!students.has(sid) && !only) await db.query("UPDATE lti_tool_scores SET status = 'refused' WHERE id = $1", [r.id]);
      continue;
    }
    const cur = current.find((g) => g.studentId === sid) ?? null;
    const save = await setGrade({ tenantId, userId: `lti-tool:${r.tool_id}` }, a, sid, students, {
      score: scaled(Number(r.score_given), Number(r.score_maximum), a.points),
      flag: cur?.flag === "missing" ? null : cur?.flag ?? null, comment: cur?.comment ?? "",
    });
    if (!save.ok) continue;
    await db.query("UPDATE lti_tool_scores SET status = 'written', written_at = now() WHERE id = $1 AND status = 'waiting'", [r.id]);
    if (save.changed) changed.push(sid);
  }
  return changed;
}

export type ToolScoreRow = { studentId: string; status: string; scoreGiven: number | null; scoreMaximum: number | null; receivedAt: string };

/** What the tool has sent for this assignment, for the teacher. */
export async function toolScores(tenantId: string, assignmentId: string): Promise<ToolScoreRow[]> {
  const db = await getDb();
  const rows = await db.query("SELECT * FROM lti_tool_scores WHERE tenant_id = $1 AND assignment_id = $2 ORDER BY received_at DESC",
    [tenantId, assignmentId]);
  return rows.map((r) => ({
    studentId: String(r.student_id), status: String(r.status),
    scoreGiven: r.score_given == null ? null : Number(r.score_given),
    scoreMaximum: r.score_maximum == null ? null : Number(r.score_maximum),
    receivedAt: new Date(String(r.received_at)).toISOString(),
  }));
}
