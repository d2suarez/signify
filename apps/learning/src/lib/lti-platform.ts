import crypto from "node:crypto";
import { getDb } from "./db";
import { CLAIM, DL_CLAIM, LTI_VERSION, b64json, jwksKey, signAsTool, toolKey } from "./lti";
import { createAssignment } from "./assignments";

/**
 * LTI 1.3 platform mode: Signify Learning launches outside tools.
 *
 *   1. A school admin registers a tool at /school/tools (client id, the
 *      tool's login, launch and JWKS addresses, redirect URIs) and gives the
 *      vendor our issuer, auth, token and JWKS addresses.
 *   2. A person presses a placed tool (a lesson block or an assignment):
 *      `startToolLaunch` keeps the claims to sign, with only the personal
 *      data the school allows that tool, behind a one-time login hint, and
 *      the browser posts the third-party login to the tool.
 *   3. The tool sends the browser to /lti/platform/auth; `authorize` spends
 *      the hint (once, minutes) and signs the id_token with the school's key,
 *      posted to one of the tool's registered redirect URIs only.
 *   4. Deep Linking: a teacher's pick launch carries a return address with a
 *      one-time pick id as `data`; `acceptDeepLink` checks the tool's signed
 *      answer (its JWKS, iss, aud, exp, nonce, deployment, data) and places
 *      the chosen links as lesson blocks or new draft assignments.
 *
 * A tool knows a person by a random id of its own (`lti_tool_users`).
 * Scores come back through lti-platform-ags.ts.
 */

export type DataShare = "none" | "name" | "name_email";
const SHARES: DataShare[] = ["none", "name", "name_email"];

export type Tool = {
  id: string; tenantId: string; name: string; clientId: string;
  loginUrl: string; launchUrl: string; deepLinkUrl: string; jwksUrl: string; redirectUris: string[];
  teacherData: DataShare; studentData: DataShare;
};

export type ToolLink = {
  id: string; tenantId: string; toolId: string; courseId: string;
  lessonId: string | null; assignmentId: string | null;
  title: string; url: string; custom: Record<string, string>;
  lineItem: { label?: string; resourceId?: string; tag?: string } | null;
};

export const ROLE_URI = {
  teacher: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor", "http://purl.imsglobal.org/vocab/lis/v2/institution/person#Faculty"],
  student: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Learner", "http://purl.imsglobal.org/vocab/lis/v2/institution/person#Student"],
};
export const AGS_CLAIM = "https://purl.imsglobal.org/spec/lti-ags/claim/endpoint";
export const SCOPE = {
  lineitemRead: "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem.readonly",
  score: "https://purl.imsglobal.org/spec/lti-ags/scope/score",
};
const LOGIN_TTL_MS = 5 * 60_000;
const PICK_TTL_MS = 30 * 60_000;
const SKEW_S = 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ITEMS = 20;

/** Our platform addresses, for the tool vendor. One issuer for every school; the client id says which. */
export function platformInfo(origin: string) {
  return {
    issuer: origin,
    authUrl: `${origin}/lti/platform/auth`,
    tokenUrl: `${origin}/lti/platform/token`,
    jwksUrl: `${origin}/.well-known/jwks.json`,
  };
}

// ---------- registering tools ----------

/** https, or http://localhost while not on Railway (a tool on this machine, for trying things). */
export function toolUrl(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s || s.length > 500) return null;
  try {
    const u = new URL(s);
    if (u.protocol === "https:") return u.href;
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    return u.protocol === "http:" && local && !process.env.RAILWAY_ENVIRONMENT ? u.href : null;
  } catch {
    return null;
  }
}

function toTool(r: Record<string, unknown>): Tool {
  return {
    id: String(r.id), tenantId: String(r.tenant_id), name: String(r.name), clientId: String(r.client_id),
    loginUrl: String(r.login_url), launchUrl: String(r.launch_url), deepLinkUrl: String(r.deep_link_url || ""),
    jwksUrl: String(r.jwks_url), redirectUris: (r.redirect_uris as string[]) || [],
    teacherData: String(r.teacher_data) as DataShare, studentData: String(r.student_data) as DataShare,
  };
}

/** Every origin the tool's pages live on: what a tool frame may show and forms may post to. */
export function toolOrigins(t: Pick<Tool, "loginUrl" | "launchUrl" | "deepLinkUrl" | "redirectUris">): string[] {
  const out = new Set<string>();
  for (const u of [t.loginUrl, t.launchUrl, t.deepLinkUrl, ...t.redirectUris]) {
    try { if (u) out.add(new URL(u).origin); } catch { /* not kept */ }
  }
  return [...out];
}

export type ToolInput = {
  name?: unknown; clientId?: unknown; loginUrl?: unknown; launchUrl?: unknown; deepLinkUrl?: unknown;
  jwksUrl?: unknown; redirectUris?: unknown; teacherData?: unknown; studentData?: unknown;
};

function share(v: unknown, dflt: DataShare): DataShare {
  return SHARES.includes(v as DataShare) ? (v as DataShare) : dflt;
}

export async function registerTool(tenantId: string, userId: string, input: ToolInput):
  Promise<{ ok: true; tool: Tool } | { ok: false; error: string }> {
  const name = String(input.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!name) return { ok: false, error: "toolNoName" };
  const loginUrl = toolUrl(input.loginUrl), launchUrl = toolUrl(input.launchUrl), jwksUrl = toolUrl(input.jwksUrl);
  const rawDl = String(input.deepLinkUrl ?? "").trim();
  const deepLinkUrl = rawDl ? toolUrl(rawDl) : "";
  const rawRedirects = String(input.redirectUris ?? "").split(/[\s,]+/).filter(Boolean).slice(0, 10);
  const redirectUris = rawRedirects.map(toolUrl);
  if (!loginUrl || !launchUrl || !jwksUrl || deepLinkUrl === null || redirectUris.some((u) => !u)) return { ok: false, error: "toolBadUrl" };
  // A tool that names no redirect URI is sent back to its launch URL.
  const redirects = redirectUris.length ? (redirectUris as string[]) : [launchUrl];
  let clientId = String(input.clientId ?? "").trim().slice(0, 200);
  if (clientId && !/^[A-Za-z0-9._:-]+$/.test(clientId)) return { ok: false, error: "toolBadClient" };
  if (!clientId) clientId = `sl-${crypto.randomBytes(12).toString("hex")}`;
  const db = await getDb();
  const taken = await db.query("SELECT 1 FROM lti_tools WHERE client_id = $1", [clientId]);
  if (taken[0]) return { ok: false, error: "toolClientTaken" };
  const [row] = await db.query(
    `INSERT INTO lti_tools (tenant_id, name, client_id, login_url, launch_url, deep_link_url, jwks_url, redirect_uris,
       teacher_data, student_data, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [tenantId, name, clientId, loginUrl, launchUrl, deepLinkUrl, jwksUrl, redirects,
      share(input.teacherData, "name_email"), share(input.studentData, "none"), userId],
  );
  await toolKey(tenantId);
  return { ok: true, tool: toTool(row) };
}

export async function listTools(tenantId: string): Promise<Tool[]> {
  const db = await getDb();
  return (await db.query("SELECT * FROM lti_tools WHERE tenant_id = $1 ORDER BY name", [tenantId])).map(toTool);
}

/** What a teacher may add: the school's tools, and whether each has a picker. */
export async function toolChoices(tenantId: string): Promise<{ id: string; name: string; picker: boolean }[]> {
  return (await listTools(tenantId)).map((t) => ({ id: t.id, name: t.name, picker: !!t.deepLinkUrl }));
}

export async function getTool(tenantId: string, id: string): Promise<Tool | null> {
  if (!UUID.test(id)) return null;
  const db = await getDb();
  const [r] = await db.query("SELECT * FROM lti_tools WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
  return r ? toTool(r) : null;
}

/** The tool a client id names. The client id alone says which school. */
export async function toolByClient(clientId: string): Promise<Tool | null> {
  if (!clientId) return null;
  const db = await getDb();
  const [r] = await db.query("SELECT * FROM lti_tools WHERE client_id = $1", [clientId]);
  return r ? toTool(r) : null;
}

export async function setToolPrivacy(tenantId: string, id: string, teacherData: unknown, studentData: unknown): Promise<void> {
  if (!UUID.test(id)) return;
  const db = await getDb();
  await db.query("UPDATE lti_tools SET teacher_data = $3, student_data = $4 WHERE tenant_id = $1 AND id = $2",
    [tenantId, id, share(teacherData, "name_email"), share(studentData, "none")]);
}

export async function removeTool(tenantId: string, id: string): Promise<void> {
  if (!UUID.test(id)) return;
  const db = await getDb();
  await db.query("DELETE FROM lti_tools WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
}

// ---------- who a tool thinks someone is ----------

/** This person's id at this tool: random, made once, never the Signify id. */
export async function subFor(tool: Tool, userId: string): Promise<string> {
  const db = await getDb();
  const fresh = crypto.randomBytes(16).toString("hex");
  await db.query(
    "INSERT INTO lti_tool_users (tenant_id, tool_id, user_id, sub) VALUES ($1, $2, $3, $4) ON CONFLICT (tool_id, user_id) DO NOTHING",
    [tool.tenantId, tool.id, userId, fresh]);
  const [r] = await db.query("SELECT sub FROM lti_tool_users WHERE tool_id = $1 AND user_id = $2", [tool.id, userId]);
  return String(r.sub);
}

export async function userForSub(tool: Tool, sub: string): Promise<string | null> {
  const db = await getDb();
  const [r] = await db.query("SELECT user_id FROM lti_tool_users WHERE tool_id = $1 AND sub = $2", [tool.id, String(sub || "")]);
  return r ? String(r.user_id) : null;
}

// ---------- placed tools ----------

function toLink(r: Record<string, unknown>): ToolLink {
  const parse = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);
  return {
    id: String(r.id), tenantId: String(r.tenant_id), toolId: String(r.tool_id), courseId: String(r.course_id),
    lessonId: r.lesson_id ? String(r.lesson_id) : null, assignmentId: r.assignment_id ? String(r.assignment_id) : null,
    title: String(r.title), url: String(r.url), custom: (parse(r.custom) as Record<string, string>) || {},
    lineItem: (parse(r.line_item) as ToolLink["lineItem"]) ?? null,
  };
}

export async function getLink(tenantId: string, id: string): Promise<ToolLink | null> {
  if (!UUID.test(id)) return null;
  const db = await getDb();
  const [r] = await db.query("SELECT * FROM lti_tool_links WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
  return r ? toLink(r) : null;
}

export async function linkForAssignment(tenantId: string, assignmentId: string): Promise<ToolLink | null> {
  const db = await getDb();
  const [r] = await db.query("SELECT * FROM lti_tool_links WHERE tenant_id = $1 AND assignment_id = $2 ORDER BY created_at LIMIT 1",
    [tenantId, assignmentId]);
  return r ? toLink(r) : null;
}

async function insertLink(l: Omit<ToolLink, "id">, by: string): Promise<ToolLink> {
  const db = await getDb();
  const [r] = await db.query(
    `INSERT INTO lti_tool_links (tenant_id, tool_id, course_id, lesson_id, assignment_id, title, url, custom, line_item, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10) RETURNING *`,
    [l.tenantId, l.toolId, l.courseId, l.lessonId, l.assignmentId, l.title, l.url, JSON.stringify(l.custom),
      l.lineItem ? JSON.stringify(l.lineItem) : null, by]);
  return toLink(r);
}

/** The tool's own launch page as a lesson block (a tool without Deep Linking). */
export async function placeToolPage(tool: Tool, by: string, courseId: string, lessonId: string): Promise<ToolLink> {
  return insertLink({
    tenantId: tool.tenantId, toolId: tool.id, courseId, lessonId, assignmentId: null,
    title: tool.name, url: "", custom: {}, lineItem: null,
  }, by);
}

// ---------- launching ----------

export type Launcher = { id: string; name: string; email: string; tenantId: string };
export type Presentation = "iframe" | "window";

type LaunchFor =
  | { kind: "link"; link: ToolLink }
  | { kind: "pick"; pick: { id: string; place: "lesson" | "assignment" } };

/**
 * Keeps the claims for one launch behind a one-time login hint and returns
 * the third-party login to send the browser to. Only the personal data the
 * school allows this tool goes in; the role is the course's, from Signify ID.
 */
export async function startToolLaunch(o: {
  me: Launcher; role: "teacher" | "student"; tool: Tool; course: { id: string; name: string };
  what: LaunchFor; presentation: Presentation; lang: string; origin: string;
}): Promise<{ loginUrl: string; params: Record<string, string> }> {
  const { me, role, tool, course, what, origin } = o;
  const sub = await subFor(tool, me.id);
  const allowed = role === "teacher" ? tool.teacherData : tool.studentData;
  const ags = `${origin}/lti/platform/ags/${course.id}/lineitems`;
  const claims: Record<string, unknown> = {
    iss: origin, aud: tool.clientId, azp: tool.clientId, sub,
    ...(allowed !== "none" && me.name ? { name: me.name.slice(0, 200) } : {}),
    ...(allowed === "name_email" && me.email ? { email: me.email.slice(0, 320) } : {}),
    [`${CLAIM}version`]: LTI_VERSION,
    [`${CLAIM}deployment_id`]: tool.id,
    [`${CLAIM}roles`]: ROLE_URI[role],
    [`${CLAIM}context`]: {
      id: course.id, label: course.name.slice(0, 60), title: course.name.slice(0, 200),
      type: ["http://purl.imsglobal.org/vocab/lis/v2/course#CourseOffering"],
    },
    [`${CLAIM}tool_platform`]: {
      guid: crypto.createHash("sha256").update(`${tool.tenantId}:${tool.id}`).digest("hex").slice(0, 32),
      name: "Signify Learning", product_family_code: "signify-learning", version: "1",
    },
    [`${CLAIM}launch_presentation`]: { document_target: o.presentation, locale: o.lang === "es" ? "es" : "en" },
  };
  let target = tool.launchUrl;
  if (what.kind === "link") {
    const l = what.link;
    target = l.url || tool.launchUrl;
    claims[`${CLAIM}message_type`] = "LtiResourceLinkRequest";
    claims[`${CLAIM}resource_link`] = { id: l.id, title: l.title };
    if (Object.keys(l.custom).length) claims[`${CLAIM}custom`] = l.custom;
    claims[AGS_CLAIM] = {
      scope: [SCOPE.lineitemRead, SCOPE.score], lineitems: ags,
      ...(l.assignmentId ? { lineitem: `${ags}/${l.id}` } : {}),
    };
  } else {
    target = tool.deepLinkUrl || tool.launchUrl;
    claims[`${CLAIM}message_type`] = "LtiDeepLinkingRequest";
    claims[`${DL_CLAIM}deep_linking_settings`] = {
      deep_link_return_url: `${origin}/lti/platform/deep/${what.pick.id}`,
      accept_types: ["ltiResourceLink"],
      accept_presentation_document_targets: ["iframe", "window"],
      accept_multiple: true,
      accept_lineitem: what.pick.place === "assignment",
      auto_create: false,
      data: what.pick.id,
    };
  }
  claims[`${CLAIM}target_link_uri`] = target;

  const id = crypto.randomBytes(18).toString("base64url");
  const hint = crypto.randomBytes(24).toString("base64url");
  const db = await getDb();
  await db.query("DELETE FROM lti_tool_logins WHERE expires_at < now()");
  await db.query(
    `INSERT INTO lti_tool_logins (id, login_hint, tenant_id, tool_id, user_id, claims, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [id, hint, tool.tenantId, tool.id, me.id, JSON.stringify(claims), new Date(Date.now() + LOGIN_TTL_MS)]);
  return {
    loginUrl: tool.loginUrl,
    params: {
      iss: origin, login_hint: hint, target_link_uri: target, lti_message_hint: id,
      client_id: tool.clientId, lti_deployment_id: tool.id,
    },
  };
}

export type AuthResult =
  | { ok: true; redirectUri: string; idToken: string; state: string; tool: Tool }
  | { ok: false; error: string; tool?: Tool };

/**
 * The tool's authentication request (OIDC implicit flow, form_post). The
 * redirect URI must be one the school registered; the hint is spent here, so
 * a second request with it finds nothing. `signedIn` is whoever this
 * browser's Signify session is, when the cookie came: it must be the person
 * who pressed the tool.
 */
export async function authorize(p: URLSearchParams, signedIn: string | null, now = Date.now()): Promise<AuthResult> {
  const tool = await toolByClient(p.get("client_id") || "");
  if (!tool) return { ok: false, error: "toolUnknown" };
  const fail = (error: string): AuthResult => ({ ok: false, error, tool });
  const redirectUri = p.get("redirect_uri") || "";
  if (!tool.redirectUris.includes(redirectUri)) return fail("toolBadRedirect");
  const scopes = (p.get("scope") || "").split(/\s+/);
  if (!scopes.includes("openid") || p.get("response_type") !== "id_token" || p.get("response_mode") !== "form_post") return fail("toolBadAuth");
  const nonce = p.get("nonce") || "";
  if (!nonce || nonce.length > 255) return fail("toolBadAuth");
  const state = (p.get("state") || "").slice(0, 2000);
  const db = await getDb();
  const [row] = await db.query(
    "DELETE FROM lti_tool_logins WHERE id = $1 AND tool_id = $2 AND login_hint = $3 RETURNING *",
    [p.get("lti_message_hint") || "", tool.id, p.get("login_hint") || ""]);
  if (!row || new Date(String(row.expires_at)).getTime() < now) return fail("toolLoginGone");
  if (signedIn && signedIn !== String(row.user_id)) return fail("toolWrongPerson");
  const claims = typeof row.claims === "string" ? JSON.parse(row.claims) : row.claims;
  const iat = Math.floor(now / 1000);
  const idToken = await signAsTool(tool.tenantId, { ...claims, nonce, iat, exp: iat + 300 });
  return { ok: true, redirectUri, idToken, state, tool };
}

// ---------- Deep Linking ----------

export type PickItem = { linkId: string; title: string; display: "tab" | "frame"; assignmentId?: string };
export type ToolPick = {
  id: string; tenantId: string; toolId: string; userId: string; courseId: string; lessonId: string | null;
  place: "lesson" | "assignment"; state: "waiting" | "done" | "cancelled"; items: PickItem[];
};

function toPick(r: Record<string, unknown>): ToolPick {
  return {
    id: String(r.id), tenantId: String(r.tenant_id), toolId: String(r.tool_id), userId: String(r.user_id),
    courseId: String(r.course_id), lessonId: r.lesson_id ? String(r.lesson_id) : null,
    place: String(r.place) as ToolPick["place"], state: String(r.state) as ToolPick["state"],
    items: ((typeof r.items === "string" ? JSON.parse(r.items) : r.items) as PickItem[]) || [],
  };
}

/** A teacher starts choosing content in a tool, for a lesson or as new assignments. The caller checked they teach the course. */
export async function startPick(tool: Tool, userId: string, courseId: string, lessonId: string | null): Promise<ToolPick> {
  const db = await getDb();
  await db.query("DELETE FROM lti_tool_picks WHERE expires_at < now() - interval '1 day'");
  const [r] = await db.query(
    `INSERT INTO lti_tool_picks (id, tenant_id, tool_id, user_id, course_id, lesson_id, place, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [crypto.randomBytes(18).toString("base64url"), tool.tenantId, tool.id, userId, courseId, lessonId,
      lessonId ? "lesson" : "assignment", new Date(Date.now() + PICK_TTL_MS)]);
  return toPick(r);
}

/** A pick, only for the teacher who started it. */
export async function getPick(tenantId: string, userId: string, id: string): Promise<ToolPick | null> {
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(id)) return null;
  const db = await getDb();
  const [r] = await db.query("SELECT * FROM lti_tool_picks WHERE id = $1 AND tenant_id = $2 AND user_id = $3", [id, tenantId, userId]);
  return r ? toPick(r) : null;
}

function cleanCustom(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 20)) {
    if (/^[A-Za-z0-9_.-]{1,60}$/.test(k) && (typeof x === "string" || typeof x === "number")) out[k] = String(x).slice(0, 500);
  }
  return out;
}

function oneLine(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

export type DeepLinkResult =
  | { ok: true; pick: ToolPick; msg: string }
  | { ok: false; error: string; tool?: Tool };

/**
 * The tool's signed LtiDeepLinkingResponse, posted (by the teacher's browser)
 * to the return address of one pick. Signature first, then every claim; the
 * pick is spent by the first good answer.
 */
export async function acceptDeepLink(jwt: string, pickId: string, origin: string, now = Date.now()): Promise<DeepLinkResult> {
  const parts = String(jwt || "").split(".");
  if (parts.length !== 3 || jwt.length > 100_000) return { ok: false, error: "toolBadAnswer" };
  const header = b64json(parts[0]), claims = b64json(parts[1]);
  if (!header || !claims || header.alg !== "RS256") return { ok: false, error: "toolBadAnswer" };
  const db = await getDb();
  const [pr] = await db.query("SELECT * FROM lti_tool_picks WHERE id = $1", [String(pickId || "")]);
  if (!pr) return { ok: false, error: "toolPickGone" };
  const pick = toPick(pr);
  const tool = await getTool(pick.tenantId, pick.toolId);
  if (!tool) return { ok: false, error: "toolPickGone" };
  const fail = (error: string): DeepLinkResult => ({ ok: false, error, tool });
  if (claims.iss !== tool.clientId) return fail("toolBadAnswer");

  let key: crypto.KeyObject | null = null;
  try { key = await jwksKey(tool.jwksUrl, typeof header.kid === "string" ? header.kid : undefined); } catch { return fail("ltiKeysUnavailable"); }
  if (!key || !crypto.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url"))) {
    return fail("ltiBadSignature");
  }
  const aud = Array.isArray(claims.aud) ? claims.aud.map(String) : [String(claims.aud ?? "")];
  if (!aud.includes(origin)) return fail("ltiBadAudience");
  const exp = Number(claims.exp), iat = Number(claims.iat), nowS = Math.floor(now / 1000);
  if (!Number.isFinite(exp) || exp + SKEW_S < nowS || !Number.isFinite(iat) || iat - SKEW_S > nowS || nowS - iat > 3600) return fail("ltiExpired");
  if (claims[`${CLAIM}version`] !== LTI_VERSION || claims[`${CLAIM}message_type`] !== "LtiDeepLinkingResponse") return fail("ltiBadMessage");
  if (claims[`${CLAIM}deployment_id`] !== tool.id) return fail("ltiBadDeployment");
  if (claims[`${DL_CLAIM}data`] !== pick.id) return fail("toolBadAnswer");
  const nonce = typeof claims.nonce === "string" ? claims.nonce.slice(0, 255) : "";
  if (!nonce || !(await spendNonce(tool, nonce, exp))) return fail("ltiBadNonce");
  if (pick.state !== "waiting" || new Date(String(pr.expires_at)).getTime() < now) return fail("toolPickGone");

  const raw = Array.isArray(claims[`${DL_CLAIM}content_items`]) ? (claims[`${DL_CLAIM}content_items`] as unknown[]) : [];
  const origins = toolOrigins(tool);
  const chosen: { title: string; url: string; custom: Record<string, string>; display: "tab" | "frame"; lineItem: { label: string; resourceId: string; tag: string; scoreMaximum: number } | null }[] = [];
  for (const it of raw.slice(0, MAX_ITEMS)) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    if (o.type !== "ltiResourceLink") continue;
    let url = "";
    if (o.url !== undefined && o.url !== "") {
      const u = toolUrl(o.url);
      // A link may only point at the tool's own pages.
      if (!u || !origins.includes(new URL(u).origin)) continue;
      url = u;
    }
    const li = o.lineItem && typeof o.lineItem === "object" ? (o.lineItem as Record<string, unknown>) : null;
    const max = Number(li?.scoreMaximum);
    chosen.push({
      title: oneLine(o.title, 200) || tool.name, url, custom: cleanCustom(o.custom),
      display: o.iframe && !o.window ? "frame" : "tab",
      lineItem: li ? {
        label: oneLine(li.label, 200), resourceId: oneLine(li.resourceId, 200), tag: oneLine(li.tag, 200),
        scoreMaximum: Number.isFinite(max) && max > 0 ? Math.min(10_000, Math.round(max * 100) / 100) : 0,
      } : null,
    });
  }

  // Spend the pick before writing anything: a second answer finds it done.
  const spent = await db.query("UPDATE lti_tool_picks SET state = $2 WHERE id = $1 AND state = 'waiting' RETURNING id",
    [pick.id, chosen.length ? "done" : "cancelled"]);
  if (!spent[0]) return fail("toolPickGone");
  const by = pick.userId;
  const items: PickItem[] = [];
  for (const c of chosen) {
    let assignmentId: string | null = null;
    if (pick.place === "assignment") {
      const a = await createAssignment({ tenantId: tool.tenantId, userId: by }, pick.courseId,
        { title: c.lineItem?.label || c.title, kind: "offline" });
      assignmentId = a.id;
      const points = c.lineItem?.scoreMaximum || 10;
      await db.query("UPDATE assignments SET points = $3 WHERE tenant_id = $1 AND id = $2", [tool.tenantId, a.id, points]);
    }
    const link = await insertLink({
      tenantId: tool.tenantId, toolId: tool.id, courseId: pick.courseId,
      lessonId: pick.place === "lesson" ? pick.lessonId : null, assignmentId,
      title: c.title, url: c.url, custom: c.custom,
      lineItem: c.lineItem ? { label: c.lineItem.label, resourceId: c.lineItem.resourceId, tag: c.lineItem.tag } : null,
    }, by);
    items.push({ linkId: link.id, title: c.title, display: c.display, ...(assignmentId ? { assignmentId } : {}) });
  }
  await db.query("UPDATE lti_tool_picks SET items = $2::jsonb WHERE id = $1", [pick.id, JSON.stringify(items)]);
  const msg = oneLine(claims[`${DL_CLAIM}errormsg`], 300) || oneLine(claims[`${DL_CLAIM}msg`], 300);
  return { ok: true, pick: { ...pick, state: items.length ? "done" : "cancelled", items }, msg };
}

/** Records a nonce or jti a tool used; false when it was used before. */
export async function spendNonce(tool: Tool, value: string, expS: number): Promise<boolean> {
  const db = await getDb();
  await db.query("DELETE FROM lti_tool_nonces WHERE expires_at < now()");
  const r = await db.query(
    "INSERT INTO lti_tool_nonces (tool_id, value, expires_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING value",
    [tool.id, value, new Date(Math.max(expS * 1000, Date.now()) + 3600_000)]);
  return !!r[0];
}

// ---------- pages ----------

/** A page that posts a form at once (to a tool's login, or the id_token to its redirect URI). */
export function autoPostPage(o: { lang: string; action: string; fields: Record<string, string>; label: string }): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
  const inputs = Object.entries(o.fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
  return `<!doctype html><html lang="${esc(o.lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signify Learning</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:#f3f2f2;color:#201e1d}button{min-height:44px;padding:0 20px;border-radius:999px;border:0;background:#1f4fd1;color:#fff;font-weight:600}@media(prefers-color-scheme:dark){body{background:#161514;color:#f3f2f2}}</style></head>
<body><form id="f" method="post" action="${esc(o.action)}">${inputs}<noscript><button type="submit">${esc(o.label)}</button></noscript></form>
<script>document.getElementById("f").submit();</script></body></html>`;
}

/** CSP for our pages in a tool's flow: no framing but ours, forms only to the tool's own origins. */
export function toolFlowCsp(postTo: string[], frames: string[] = []): string {
  return [
    "default-src 'none'", "style-src 'unsafe-inline'", "script-src 'unsafe-inline'",
    "base-uri 'none'", `form-action 'self' ${postTo.join(" ")}`.trim(),
    ...(frames.length ? [`frame-src 'self' ${frames.join(" ")}`] : []),
    "frame-ancestors 'self'",
  ].join("; ");
}
