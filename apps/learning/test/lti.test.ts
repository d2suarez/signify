import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import crypto from "node:crypto";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses } from "../src/lib/courses";
import {
  registerPlatform, startLogin, checkLaunch, resolveLaunch, linkLaunch, publicJwks, setJwksFetcher, launchCsp,
  frameOrigin, listPlatforms, type Platform,
} from "../src/lib/lti";
import { dict } from "../src/lib/i18n";

// A fake Schoology: its own key pair, its JWKS, and tokens it signs.
const ORIGIN = "https://learn.example.test";
const ISS = "https://platform.example.test";
const CLIENT = "client-123";
const DEPLOY = "dep-1";
const platformKeys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const strangerKeys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "platform-key-1";
const C = "https://purl.imsglobal.org/spec/lti/claim/";

let db: Db;
let platform: Platform;

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
  setJwksFetcher(async (url) => {
    assert.equal(url, `${ISS}/jwks`);
    return { keys: [{ ...platformKeys.publicKey.export({ format: "jwk" }), kid: KID }] };
  });
  const r = await registerPlatform("school-a", "admin-1", {
    name: "Schoology", issuer: ISS, clientId: CLIENT, deploymentIds: DEPLOY,
    authUrl: `${ISS}/auth`, tokenUrl: `${ISS}/token`, jwksUrl: `${ISS}/jwks`, frameOrigins: "https://school.schoology.com",
  });
  assert.ok(r.ok);
  platform = r.platform;
});
after(async () => { setJwksFetcher(null); await db.close(); });

function sign(claims: Record<string, unknown>, key = platformKeys.privateKey, kid = KID): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "RS256", typ: "JWT", kid });
  const body = enc(claims);
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key).toString("base64url");
  return `${head}.${body}.${sig}`;
}

/** Login, then a token for that login's state and nonce. */
async function login(extra: Record<string, unknown> = {}) {
  const r = await startLogin({ iss: ISS, login_hint: "u1", client_id: CLIENT, target_link_uri: `${ORIGIN}/lti/launch` }, ORIGIN);
  assert.ok(r.ok);
  const u = new URL(r.redirect);
  assert.equal(u.origin + u.pathname, `${ISS}/auth`);
  assert.equal(u.searchParams.get("redirect_uri"), `${ORIGIN}/lti/launch`);
  const state = u.searchParams.get("state")!;
  const nonce = u.searchParams.get("nonce")!;
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: ISS, aud: CLIENT, sub: "sgy-user-1", exp: now + 300, iat: now, nonce,
    email: "Teacher@School.test",
    [`${C}version`]: "1.3.0",
    [`${C}message_type`]: "LtiResourceLinkRequest",
    [`${C}deployment_id`]: DEPLOY,
    [`${C}target_link_uri`]: `${ORIGIN}/lti/launch`,
    [`${C}resource_link`]: { id: "link-1" },
    [`${C}context`]: { id: "sgy-course-9", title: "Biology 9" },
    [`${C}roles`]: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor"],
    ...extra,
  };
  return { state, nonce, claims, token: sign(claims) };
}

const TEACHER = { id: "t1", email: "teacher@school.test", tenantId: "school-a" };
const STUDENT = { id: "s1", email: "student@school.test", tenantId: "school-a" };
const CLASS = { id: "bio9", name: "Biology 9" };

test("lti: a signed, valid launch is kept; the teacher links it once and it opens the course", async () => {
  const [course] = await myCourses("school-a", [{ ...CLASS, role: "teacher" }]);
  const { token, state } = await login();
  const r = await checkLaunch(token, state, [state], ORIGIN);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.launch.email, "teacher@school.test");
  assert.equal(r.launch.tenantId, "school-a");

  const first = await resolveLaunch(r.launch.id, TEACHER, [{ ...CLASS, role: "teacher" }]);
  assert.equal(first.kind, "pick");
  const linked = await linkLaunch(r.launch.id, TEACHER, [{ ...CLASS, role: "teacher" }], course.id);
  assert.deepEqual(linked, { ok: true, courseId: course.id });
  const again = await resolveLaunch(r.launch.id, TEACHER, [{ ...CLASS, role: "teacher" }]);
  assert.deepEqual(again, { kind: "course", courseId: course.id });
});

test("lti: a student opens the linked course by Signify ID's class, whatever role the launch claims", async () => {
  const { token, state } = await login({ email: "student@school.test", [`${C}roles`]: ["http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor"] });
  const r = await checkLaunch(token, state, [], ORIGIN);
  assert.ok(r.ok);
  const inClass = await resolveLaunch(r.launch.id, STUDENT, [{ ...CLASS, role: "student" }]);
  assert.equal(inClass.kind, "course");
  // "Instructor" in the token gives nothing: not in the ID class, no course.
  assert.deepEqual(await resolveLaunch(r.launch.id, STUDENT, []), { kind: "error", error: "ltiNotInClass" });
  // And a student can't link a platform course to anything.
  assert.deepEqual(await linkLaunch(r.launch.id, STUDENT, [{ ...CLASS, role: "student" }], "x"), { ok: false, error: "ltiNotTeacher" });
});

test("lti: the launch opens only for the same email at the same school", async () => {
  const { token, state } = await login();
  const r = await checkLaunch(token, state, [state], ORIGIN);
  assert.ok(r.ok);
  const cls = [{ ...CLASS, role: "teacher" }];
  assert.deepEqual(await resolveLaunch(r.launch.id, { ...TEACHER, email: "other@school.test" }, cls), { kind: "error", error: "ltiWrongPerson" });
  assert.deepEqual(await resolveLaunch(r.launch.id, { ...TEACHER, tenantId: "school-b" }, cls), { kind: "error", error: "ltiOtherSchool" });
  assert.deepEqual(await resolveLaunch("not-a-real-launch-id-xxxxx", TEACHER, cls), { kind: "error", error: "ltiLaunchGone" });
  const later = Date.now() + 31 * 60_000;
  assert.deepEqual(await resolveLaunch(r.launch.id, TEACHER, cls, later), { kind: "error", error: "ltiLaunchGone" });

  const noEmail = await login({ email: undefined });
  const r2 = await checkLaunch(noEmail.token, noEmail.state, [], ORIGIN);
  assert.ok(r2.ok);
  assert.deepEqual(await resolveLaunch(r2.launch.id, TEACHER, cls), { kind: "error", error: "ltiNoEmail" });
});

async function refused(p: Promise<{ ok: boolean; error?: string }>, error: string) {
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.error, error);
}

test("lti: forged, replayed and stale launches are refused", async () => {
  // Signed by a key that isn't the platform's.
  let l = await login();
  await refused(checkLaunch(sign(l.claims, strangerKeys.privateKey), l.state, [], ORIGIN), "ltiBadSignature");
  // Claims changed after signing.
  l = await login();
  const [h, , s] = l.token.split(".");
  const tampered = `${h}.${Buffer.from(JSON.stringify({ ...l.claims, email: "admin@school.test" })).toString("base64url")}.${s}`;
  await refused(checkLaunch(tampered, l.state, [], ORIGIN), "ltiBadSignature");
  // Unknown kid.
  l = await login();
  await refused(checkLaunch(sign(l.claims, platformKeys.privateKey, "nope"), l.state, [], ORIGIN), "ltiBadSignature");
  // alg none.
  l = await login();
  const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${l.token.split(".")[1]}.`;
  await refused(checkLaunch(none, l.state, [], ORIGIN), "ltiBadToken");

  // Replayed: the same token and state a second time.
  l = await login();
  assert.ok((await checkLaunch(l.token, l.state, [], ORIGIN)).ok);
  await refused(checkLaunch(l.token, l.state, [], ORIGIN), "ltiBadState");
  // Replayed token under a fresh login's state: the nonce doesn't match.
  const fresh = await login();
  await refused(checkLaunch(l.token, fresh.state, [], ORIGIN), "ltiBadNonce");

  // Wrong audience (signed by the platform, but for another client).
  l = await login();
  await refused(checkLaunch(sign({ ...l.claims, aud: "someone-else" }), l.state, [], ORIGIN), "ltiUnknownPlatform");
  l = await login();
  await refused(checkLaunch(sign({ ...l.claims, aud: [CLIENT, "x"], azp: "x" }), l.state, [], ORIGIN), "ltiBadAudience");
  // Expired, and issued in the future.
  const now = Math.floor(Date.now() / 1000);
  l = await login();
  await refused(checkLaunch(sign({ ...l.claims, exp: now - 120 }), l.state, [], ORIGIN), "ltiExpired");
  l = await login();
  await refused(checkLaunch(sign({ ...l.claims, iat: now + 600 }), l.state, [], ORIGIN), "ltiExpired");
  // A state cookie that names another state.
  l = await login();
  await refused(checkLaunch(l.token, l.state, ["someone-elses-state"], ORIGIN), "ltiBadState");
  // An expired state.
  l = await login();
  await refused(checkLaunch(l.token, l.state, [], ORIGIN, Date.now() + 11 * 60_000), "ltiExpired");
  // Wrong version, message type, deployment, target.
  l = await login();
  await refused(checkLaunch(sign({ ...l.claims, [`${C}version`]: "1.1" }), l.state, [], ORIGIN), "ltiBadVersion");
  l = await login();
  await refused(checkLaunch(sign({ ...l.claims, [`${C}message_type`]: "Whatever" }), l.state, [], ORIGIN), "ltiBadMessage");
  l = await login();
  await refused(checkLaunch(sign({ ...l.claims, [`${C}deployment_id`]: "dep-2" }), l.state, [], ORIGIN), "ltiBadDeployment");
  l = await login();
  await refused(checkLaunch(sign({ ...l.claims, [`${C}target_link_uri`]: "https://evil.test/lti/launch" }), l.state, [], ORIGIN), "ltiBadTarget");
  l = await login();
  await refused(checkLaunch(sign({ ...l.claims, [`${C}context`]: undefined }), l.state, [], ORIGIN), "ltiNoContext");
});

test("lti: login refuses unknown platforms and foreign targets", async () => {
  await refused(startLogin({ iss: "https://nobody.test", login_hint: "x" }, ORIGIN), "ltiUnknownPlatform");
  await refused(startLogin({ iss: ISS, login_hint: "x", client_id: CLIENT, target_link_uri: "https://evil.test/" }, ORIGIN), "ltiBadTarget");
  await refused(startLogin({ iss: ISS }, ORIGIN), "ltiBadLogin");
});

test("lti: registration checks addresses and keeps one issuer+client in one school", async () => {
  const base = { issuer: ISS, clientId: "c2", authUrl: `${ISS}/auth`, jwksUrl: `${ISS}/jwks` };
  assert.deepEqual(await registerPlatform("school-b", "a", { ...base, authUrl: "http://plain.test/auth" }), { ok: false, error: "ltiBadUrl" });
  assert.deepEqual(await registerPlatform("school-b", "a", { ...base, frameOrigins: "javascript:alert(1)" }), { ok: false, error: "ltiBadOrigin" });
  assert.deepEqual(await registerPlatform("school-b", "a", { ...base, clientId: CLIENT }), { ok: false, error: "ltiTaken" });
  assert.equal((await listPlatforms("school-b")).length, 0);
  assert.equal(frameOrigin("https://*.schoology.com"), "https://*.schoology.com");
  assert.equal(frameOrigin("https://a.test/path"), null);
});

test("lti: our JWKS has public keys only; launch pages may be framed only by the platform", async () => {
  const { keys } = await publicJwks();
  assert.equal(keys.length, 1);
  assert.deepEqual(Object.keys(keys[0]).sort(), ["alg", "e", "kid", "kty", "n", "use"]);
  assert.match(launchCsp(platform), /frame-ancestors https:\/\/school\.schoology\.com(;|$)/);
  assert.match(launchCsp(undefined), /frame-ancestors 'none'/);
});

test("i18n: every LTI string has Spanish", () => {
  const en = dict("en") as Record<string, string>;
  const es = dict("es") as Record<string, string>;
  const keys = Object.keys(en).filter((k) => k.startsWith("lti"));
  assert.ok(keys.length > 50);
  for (const k of keys) assert.notEqual(es[k], en[k], `${k} has no Spanish`);
});
