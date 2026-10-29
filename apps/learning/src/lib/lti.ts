import crypto from "node:crypto";
import { getDb } from "./db";
import { roleInClass } from "./courses";
import type { IdClass } from "./roster";

/**
 * LTI 1.3 tool mode: a platform (Schoology, for the spring beta) launches
 * Signify Learning from inside one of its courses.
 *
 *   1. /lti/login   the platform starts an OIDC login; we store a state and
 *                   a nonce and send the browser to the platform's auth URL.
 *   2. /lti/launch  the platform posts back a signed id_token and the state.
 *                   `checkLaunch` verifies it against the platform's JWKS and
 *                   keeps it as a pending launch.
 *   3. /launch/[id] opened with the person's own Signify ID sign-in (a new
 *                   tab: Signify's Lax cookie isn't sent inside a frame).
 *                   `resolveLaunch` matches the email, same school only, and
 *                   opens the course a teacher linked to that LTI context.
 *
 * The launch is trusted for two things only: which platform course the
 * person came from, and the email they have there. Who they are is their
 * Signify sign-in; what they may do in a course is Signify ID's class role,
 * never the LTI role.
 */

export const LTI_VERSION = "1.3.0";
const CLAIM = "https://purl.imsglobal.org/spec/lti/claim/";
const STATE_TTL_MS = 10 * 60_000;
const LAUNCH_TTL_MS = 30 * 60_000;
const SKEW_S = 60;

export type Platform = {
  id: string;
  tenantId: string;
  name: string;
  issuer: string;
  clientId: string;
  deploymentIds: string[];
  authUrl: string;
  tokenUrl: string;
  jwksUrl: string;
  frameOrigins: string[];
};

function toPlatform(r: Record<string, unknown>): Platform {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    name: String(r.name),
    issuer: String(r.issuer),
    clientId: String(r.client_id),
    deploymentIds: (r.deployment_ids as string[]) || [],
    authUrl: String(r.auth_url),
    tokenUrl: String(r.token_url || ""),
    jwksUrl: String(r.jwks_url),
    frameOrigins: (r.frame_origins as string[]) || [],
  };
}

/** What a school admin types into the registration form. */
export type PlatformInput = {
  name?: unknown; issuer?: unknown; clientId?: unknown; deploymentIds?: unknown;
  authUrl?: unknown; tokenUrl?: unknown; jwksUrl?: unknown; frameOrigins?: unknown;
};

/** Schoology's usual LTI 1.3 endpoints, offered as the form's defaults. */
export const SCHOOLOGY = {
  name: "Schoology",
  issuer: "https://schoology.schoology.com",
  authUrl: "https://lti-service.svc.schoology.com/lti-service/authorize-redirect",
  tokenUrl: "https://lti-service.svc.schoology.com/lti-service/access-token",
  jwksUrl: "https://lti-service.svc.schoology.com/lti-service/.well-known/jwks",
};

function httpsUrl(v: unknown, required = true): string | null {
  const s = String(v ?? "").trim();
  if (!s) return required ? null : "";
  try {
    const u = new URL(s);
    return u.protocol === "https:" && s.length <= 500 ? s : null;
  } catch {
    return null;
  }
}

/** An https origin, or `https://*.example.com`, as CSP frame-ancestors takes them. */
export function frameOrigin(v: string): string | null {
  const m = /^https:\/\/(\*\.)?([a-z0-9-]+(\.[a-z0-9-]+)+)(:\d{1,5})?\/?$/i.exec(v.trim());
  return m ? `https://${m[1] || ""}${m[2].toLowerCase()}${m[4] || ""}` : null;
}

function list(v: unknown): string[] {
  return String(v ?? "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
}

export type RegisterResult = { ok: true; platform: Platform } | { ok: false; error: string };

export async function registerPlatform(tenantId: string, userId: string, input: PlatformInput): Promise<RegisterResult> {
  const name = String(input.name ?? "").trim().slice(0, 80) || "Schoology";
  const issuer = httpsUrl(input.issuer);
  const clientId = String(input.clientId ?? "").trim().slice(0, 200);
  const authUrl = httpsUrl(input.authUrl);
  const tokenUrl = httpsUrl(input.tokenUrl, false);
  const jwksUrl = httpsUrl(input.jwksUrl);
  const deploymentIds = list(input.deploymentIds).map((s) => s.slice(0, 200));
  const rawOrigins = list(input.frameOrigins);
  const frameOrigins = rawOrigins.map(frameOrigin);
  if (!issuer || !authUrl || !jwksUrl || tokenUrl === null) return { ok: false, error: "ltiBadUrl" };
  if (!clientId) return { ok: false, error: "ltiNoClient" };
  if (frameOrigins.some((o) => !o)) return { ok: false, error: "ltiBadOrigin" };
  const db = await getDb();
  const taken = await db.query("SELECT tenant_id FROM lti_platforms WHERE issuer = $1 AND client_id = $2", [issuer, clientId]);
  if (taken[0]) return { ok: false, error: "ltiTaken" };
  const [row] = await db.query(
    `INSERT INTO lti_platforms (tenant_id, name, issuer, client_id, deployment_ids, auth_url, token_url, jwks_url, frame_origins, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [tenantId, name, issuer, clientId, deploymentIds, authUrl, tokenUrl, jwksUrl, frameOrigins, userId],
  );
  await toolKey(tenantId);
  return { ok: true, platform: toPlatform(row) };
}

export async function listPlatforms(tenantId: string): Promise<Platform[]> {
  const db = await getDb();
  const rows = await db.query("SELECT * FROM lti_platforms WHERE tenant_id = $1 ORDER BY created_at", [tenantId]);
  return rows.map(toPlatform);
}

export async function removePlatform(tenantId: string, platformId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(platformId)) return;
  const db = await getDb();
  await db.query("DELETE FROM lti_platforms WHERE tenant_id = $1 AND id = $2", [tenantId, platformId]);
}

/** The platform a launch names. Issuer + client id say which school, so no tenant is asked for. */
async function platformFor(issuer: string, clientId: string | null): Promise<Platform | null> {
  const db = await getDb();
  const rows = clientId
    ? await db.query("SELECT * FROM lti_platforms WHERE issuer = $1 AND client_id = $2", [issuer, clientId])
    : await db.query("SELECT * FROM lti_platforms WHERE issuer = $1", [issuer]);
  // Without a client id the issuer alone must be unambiguous.
  return rows.length === 1 ? toPlatform(rows[0]) : null;
}

// ---------- our own key ----------

/** This school's signing key, made on first use. */
export async function toolKey(tenantId: string): Promise<{ kid: string; privatePem: string; publicJwk: crypto.JsonWebKey }> {
  const db = await getDb();
  const [row] = await db.query("SELECT * FROM lti_keys WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1", [tenantId]);
  if (row) return { kid: String(row.kid), privatePem: String(row.private_pem), publicJwk: row.public_jwk as crypto.JsonWebKey };
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = crypto.randomBytes(12).toString("hex");
  const jwk = publicKey.export({ format: "jwk" });
  const publicJwk = { kty: jwk.kty, n: jwk.n, e: jwk.e, kid, alg: "RS256", use: "sig" };
  const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  await db.query("INSERT INTO lti_keys (kid, tenant_id, private_pem, public_jwk) VALUES ($1, $2, $3, $4)",
    [kid, tenantId, privatePem, JSON.stringify(publicJwk)]);
  return { kid, privatePem, publicJwk };
}

/** The public keys, for /.well-known/jwks.json. Never anything private. */
export async function publicJwks(): Promise<{ keys: crypto.JsonWebKey[] }> {
  const db = await getDb();
  const rows = await db.query("SELECT public_jwk FROM lti_keys ORDER BY created_at");
  return { keys: rows.map((r) => {
    const k = r.public_jwk as Record<string, string>;
    return { kty: k.kty, n: k.n, e: k.e, kid: k.kid, alg: k.alg, use: k.use };
  }) };
}

// ---------- the platform's keys ----------

type Jwks = { keys: (crypto.JsonWebKey & { kid?: string })[] };
type JwksFetcher = (url: string) => Promise<Jwks>;

const defaultFetcher: JwksFetcher = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`jwks ${r.status}`);
  return (await r.json()) as Jwks;
};
let fetcher = defaultFetcher;
const jwksCache = new Map<string, { at: number; jwks: Jwks }>();

/** For tests: where platform keys come from. */
export function setJwksFetcher(f: JwksFetcher | null) {
  fetcher = f || defaultFetcher;
  jwksCache.clear();
}

async function platformKey(url: string, kid: string | undefined): Promise<crypto.KeyObject | null> {
  for (const fresh of [false, true]) {
    let hit = jwksCache.get(url);
    if (fresh || !hit || Date.now() - hit.at > 10 * 60_000) {
      // A kid we haven't seen may be a rotated key: fetch again, once.
      hit = { at: Date.now(), jwks: await fetcher(url) };
      jwksCache.set(url, hit);
    }
    const keys = (hit.jwks.keys || []).filter((k) => k.kty === "RSA");
    const k = kid ? keys.find((x) => x.kid === kid) : keys.length === 1 ? keys[0] : undefined;
    if (k) return crypto.createPublicKey({ key: { kty: k.kty, n: k.n, e: k.e }, format: "jwk" });
    if (fresh) break;
  }
  return null;
}

// ---------- step 1: login initiation ----------

export type LoginParams = {
  iss?: string | null; login_hint?: string | null; target_link_uri?: string | null;
  lti_message_hint?: string | null; client_id?: string | null; lti_deployment_id?: string | null;
};

export type LoginResult =
  | { ok: true; redirect: string; state: string; platform: Platform }
  | { ok: false; error: string; platform?: Platform };

/** `origin` is this app's own, e.g. https://learn.signify.one. */
export async function startLogin(p: LoginParams, origin: string): Promise<LoginResult> {
  if (!p.iss || !p.login_hint) return { ok: false, error: "ltiBadLogin" };
  const platform = await platformFor(p.iss, p.client_id || null);
  if (!platform) return { ok: false, error: "ltiUnknownPlatform" };
  if (p.target_link_uri && !sameOrigin(p.target_link_uri, origin)) return { ok: false, error: "ltiBadTarget", platform };
  if (p.lti_deployment_id && !deploymentOk(platform, p.lti_deployment_id)) return { ok: false, error: "ltiBadDeployment", platform };
  const state = crypto.randomBytes(24).toString("base64url");
  const nonce = crypto.randomBytes(24).toString("base64url");
  const db = await getDb();
  await db.query("DELETE FROM lti_states WHERE expires_at < now()");
  await db.query("INSERT INTO lti_states (state, tenant_id, platform_id, nonce, expires_at) VALUES ($1, $2, $3, $4, $5)",
    [state, platform.tenantId, platform.id, nonce, new Date(Date.now() + STATE_TTL_MS)]);
  const u = new URL(platform.authUrl);
  const q: Record<string, string> = {
    scope: "openid", response_type: "id_token", response_mode: "form_post", prompt: "none",
    client_id: platform.clientId, redirect_uri: `${origin}/lti/launch`,
    login_hint: p.login_hint, state, nonce,
  };
  if (p.lti_message_hint) q.lti_message_hint = p.lti_message_hint;
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return { ok: true, redirect: u.toString(), state, platform };
}

function sameOrigin(url: string, origin: string): boolean {
  try { return new URL(url).origin === new URL(origin).origin; } catch { return false; }
}

function deploymentOk(p: Platform, id: string): boolean {
  return p.deploymentIds.length === 0 || p.deploymentIds.includes(id);
}

// ---------- step 2: the launch ----------

export type Launch = {
  id: string; tenantId: string; platformId: string; email: string;
  contextId: string; contextTitle: string; resourceLinkId: string;
};

export type LaunchResult = { ok: true; launch: Launch; platform: Platform } | { ok: false; error: string; platform?: Platform };

function b64json(part: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Checks a posted id_token and its state. `cookieStates` are the states the
 * login step put in this browser's cookie (the last few, for two launches on
 * one page). Browsers that block third-party cookies inside a frame send none,
 * which is allowed: the state is still single-use server-side, and the person
 * still has to sign in to Signify as the launch's email. A cookie that is
 * sent must name this state.
 */
export async function checkLaunch(
  idToken: string, state: string, cookieStates: string[], origin: string, now = Date.now(),
): Promise<LaunchResult> {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3 || idToken.length > 20_000) return { ok: false, error: "ltiBadToken" };
  const header = b64json(parts[0]);
  const claims = b64json(parts[1]);
  if (!header || !claims || header.alg !== "RS256") return { ok: false, error: "ltiBadToken" };

  const iss = typeof claims.iss === "string" ? claims.iss : "";
  const aud = Array.isArray(claims.aud) ? claims.aud.map(String) : typeof claims.aud === "string" ? [claims.aud] : [];
  const azp = typeof claims.azp === "string" ? claims.azp : null;
  // The platform is the one registered for this issuer and one of the audiences.
  let platform: Platform | null = null;
  for (const a of aud.slice(0, 5)) if (!platform) platform = await platformFor(iss, a);
  if (!platform) return { ok: false, error: "ltiUnknownPlatform" };
  const fail = (error: string): LaunchResult => ({ ok: false, error, platform });

  // The signature, before believing anything else in the token.
  let key: crypto.KeyObject | null = null;
  try { key = await platformKey(platform.jwksUrl, typeof header.kid === "string" ? header.kid : undefined); } catch { return fail("ltiKeysUnavailable"); }
  if (!key) return fail("ltiBadSignature");
  const signed = crypto.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url"));
  if (!signed) return fail("ltiBadSignature");

  if (!aud.includes(platform.clientId) || (aud.length > 1 && azp !== platform.clientId)) return fail("ltiBadAudience");
  const exp = Number(claims.exp), iat = Number(claims.iat), nowS = Math.floor(now / 1000);
  if (!Number.isFinite(exp) || exp + SKEW_S < nowS) return fail("ltiExpired");
  if (!Number.isFinite(iat) || iat - SKEW_S > nowS || nowS - iat > 3600) return fail("ltiExpired");

  if (cookieStates.length && !cookieStates.includes(state)) return fail("ltiBadState");
  const db = await getDb();
  // Spending the state is the first write: a second use finds nothing.
  const [st] = await db.query("DELETE FROM lti_states WHERE state = $1 AND platform_id = $2 RETURNING nonce, expires_at",
    [String(state || ""), platform.id]);
  if (!st || new Date(String(st.expires_at)).getTime() < now) return fail("ltiBadState");
  const nonce = typeof claims.nonce === "string" ? claims.nonce : "";
  if (!nonce || nonce !== st.nonce) return fail("ltiBadNonce");
  await db.query("DELETE FROM lti_nonces WHERE expires_at < now()");
  const used = await db.query(
    "INSERT INTO lti_nonces (tenant_id, platform_id, nonce, expires_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING nonce",
    [platform.tenantId, platform.id, nonce, new Date(exp * 1000 + 3600_000)]);
  if (!used[0]) return fail("ltiBadNonce");

  if (claims[`${CLAIM}version`] !== LTI_VERSION) return fail("ltiBadVersion");
  const type = claims[`${CLAIM}message_type`];
  if (type === "LtiDeepLinkingRequest") return fail("ltiNoDeepLinking");
  if (type !== "LtiResourceLinkRequest") return fail("ltiBadMessage");
  const deployment = claims[`${CLAIM}deployment_id`];
  if (typeof deployment !== "string" || !deploymentOk(platform, deployment)) return fail("ltiBadDeployment");
  const target = claims[`${CLAIM}target_link_uri`];
  if (typeof target !== "string" || !sameOrigin(target, origin)) return fail("ltiBadTarget");
  const link = claims[`${CLAIM}resource_link`] as { id?: unknown } | undefined;
  const context = claims[`${CLAIM}context`] as { id?: unknown; title?: unknown } | undefined;
  if (typeof claims.sub !== "string" || !link || typeof link.id !== "string") return fail("ltiBadMessage");
  if (!context || typeof context.id !== "string" || !context.id) return fail("ltiNoContext");

  const launch: Launch = {
    id: crypto.randomBytes(18).toString("base64url"),
    tenantId: platform.tenantId,
    platformId: platform.id,
    email: typeof claims.email === "string" ? claims.email.trim().toLowerCase().slice(0, 320) : "",
    contextId: context.id.slice(0, 255),
    contextTitle: String(context.title ?? "").slice(0, 200),
    resourceLinkId: link.id.slice(0, 255),
  };
  await db.query("DELETE FROM lti_launches WHERE expires_at < now()");
  await db.query(
    `INSERT INTO lti_launches (id, tenant_id, platform_id, email, context_id, context_title, resource_link_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [launch.id, launch.tenantId, launch.platformId, launch.email, launch.contextId, launch.contextTitle, launch.resourceLinkId,
      new Date(now + LAUNCH_TTL_MS)],
  );
  return { ok: true, launch, platform };
}

// ---------- step 3: who, and which course ----------

export type Person = { id: string; email: string; tenantId: string };

export type Resolved =
  | { kind: "course"; courseId: string }
  | { kind: "pick"; launch: Launch; courses: { id: string; name: string }[] }
  | { kind: "notLinked"; launch: Launch }
  | { kind: "error"; error: string };

async function getLaunch(id: string, now: number): Promise<Launch | null> {
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(id)) return null;
  const db = await getDb();
  const [r] = await db.query("SELECT * FROM lti_launches WHERE id = $1", [id]);
  if (!r || new Date(String(r.expires_at)).getTime() < now) return null;
  return {
    id: String(r.id), tenantId: String(r.tenant_id), platformId: String(r.platform_id), email: String(r.email),
    contextId: String(r.context_id), contextTitle: String(r.context_title), resourceLinkId: String(r.resource_link_id),
  };
}

/** The launch, if it belongs to this signed-in person: same school, same email. */
async function launchFor(id: string, me: Person, now: number): Promise<Launch | { error: string }> {
  const launch = await getLaunch(id, now);
  if (!launch) return { error: "ltiLaunchGone" };
  if (launch.tenantId !== me.tenantId) return { error: "ltiOtherSchool" };
  if (!launch.email) return { error: "ltiNoEmail" };
  if (launch.email !== String(me.email || "").trim().toLowerCase()) return { error: "ltiWrongPerson" };
  return launch;
}

/**
 * Where an opened launch goes. `classes` are the person's live Signify ID
 * classes: the course opens only if ID says they're in it, as whatever ID
 * says they are.
 */
export async function resolveLaunch(id: string, me: Person, classes: IdClass[], now = Date.now()): Promise<Resolved> {
  const launch = await launchFor(id, me, now);
  if ("error" in launch) return { kind: "error", error: launch.error };
  const db = await getDb();
  const [link] = await db.query(
    `SELECT c.id, c.id_class_id FROM lti_contexts l JOIN courses c ON c.id = l.course_id AND c.tenant_id = l.tenant_id
     WHERE l.tenant_id = $1 AND l.platform_id = $2 AND l.context_id = $3`,
    [launch.tenantId, launch.platformId, launch.contextId]);
  if (link) {
    const cls = classes.find((c) => c.id === link.id_class_id);
    if (cls && roleInClass(cls)) return { kind: "course", courseId: String(link.id) };
    return { kind: "error", error: "ltiNotInClass" };
  }
  const taught = await teacherCourses(me.tenantId, classes);
  return taught.length ? { kind: "pick", launch, courses: taught } : { kind: "notLinked", launch };
}

async function teacherCourses(tenantId: string, classes: IdClass[]): Promise<{ id: string; name: string; idClassId: string }[]> {
  const ids = classes.filter((c) => roleInClass(c) === "teacher").map((c) => c.id);
  if (!ids.length) return [];
  const db = await getDb();
  const rows = await db.query("SELECT id, name, id_class_id FROM courses WHERE tenant_id = $1 AND id_class_id = ANY($2) ORDER BY name",
    [tenantId, ids]);
  return rows.map((r) => ({ id: String(r.id), name: String(r.name), idClassId: String(r.id_class_id) }));
}

/** A teacher confirms which of their courses this platform course opens. Once; later launches go straight there. */
export async function linkLaunch(id: string, me: Person, classes: IdClass[], courseId: string, now = Date.now()):
  Promise<{ ok: true; courseId: string } | { ok: false; error: string }> {
  const launch = await launchFor(id, me, now);
  if ("error" in launch) return { ok: false, error: launch.error };
  const course = (await teacherCourses(me.tenantId, classes)).find((c) => c.id === courseId);
  if (!course) return { ok: false, error: "ltiNotTeacher" };
  const db = await getDb();
  const rows = await db.query(
    `INSERT INTO lti_contexts (tenant_id, platform_id, context_id, title, course_id, linked_by)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (platform_id, context_id) DO NOTHING RETURNING course_id`,
    [launch.tenantId, launch.platformId, launch.contextId, launch.contextTitle, course.id, me.id]);
  // Already linked by someone else meanwhile: that link stands.
  if (!rows[0]) return { ok: false, error: "ltiAlreadyLinked" };
  return { ok: true, courseId: course.id };
}

/** The platform courses linked to this school's courses, for the admin page. */
export async function listLinks(tenantId: string): Promise<{ platformId: string; title: string; contextId: string; courseName: string }[]> {
  const db = await getDb();
  const rows = await db.query(
    `SELECT l.platform_id, l.title, l.context_id, c.name FROM lti_contexts l JOIN courses c ON c.id = l.course_id
     WHERE l.tenant_id = $1 ORDER BY l.linked_at`, [tenantId]);
  return rows.map((r) => ({ platformId: String(r.platform_id), title: String(r.title), contextId: String(r.context_id), courseName: String(r.name) }));
}

export async function unlinkContext(tenantId: string, platformId: string, contextId: string): Promise<void> {
  const db = await getDb();
  await db.query("DELETE FROM lti_contexts WHERE tenant_id = $1 AND platform_id = $2 AND context_id = $3", [tenantId, platformId, contextId]);
}

// ---------- framing ----------

/** The Content-Security-Policy for a launch page: framed only by the platform's own origins. */
export function launchCsp(platform: Platform | undefined): string {
  const ancestors = platform?.frameOrigins.length ? platform.frameOrigins.join(" ") : "'none'";
  return [
    "default-src 'none'", "style-src 'unsafe-inline'", "script-src 'unsafe-inline'", "img-src 'self'",
    "base-uri 'none'", "form-action 'self'", `frame-ancestors ${ancestors}`,
  ].join("; ");
}
