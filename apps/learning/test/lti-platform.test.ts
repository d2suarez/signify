import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import crypto from "node:crypto";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses } from "../src/lib/courses";
import { createLesson } from "../src/lib/lessons";
import { getAssignment, saveAssignment } from "../src/lib/assignments";
import { gradesFor, gradeHistory } from "../src/lib/grades";
import { normalizeBlocks } from "../src/lib/blocks";
import { publicJwks, setJwksFetcher } from "../src/lib/lti";
import {
  registerTool, startToolLaunch, authorize, placeToolPage, startPick, acceptDeepLink, setToolPrivacy, getTool,
  toolOrigins, toolFlowCsp, type Tool,
} from "../src/lib/lti-platform";
import {
  issueToken, serviceAuth, lineItems, postScore, applyToolScores, tokenRateOk, resetTokenRate, toolScores,
} from "../src/lib/lti-platform-ags";
import { dict } from "../src/lib/i18n";

// A fake outside tool: its own key pair (made here), its JWKS, and what it signs.
const ORIGIN = "https://learn.example.test";
const TOOL = "https://tool.example.test";
const C = "https://purl.imsglobal.org/spec/lti/claim/";
const DL = "https://purl.imsglobal.org/spec/lti-dl/claim/";
const AGS = "https://purl.imsglobal.org/spec/lti-ags/claim/endpoint";
const SCORE = "https://purl.imsglobal.org/spec/lti-ags/scope/score";
const LI_RO = "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem.readonly";
const toolKeys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const strangerKeys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "tool-key-1";

let db: Db;
let tool: Tool;
let toolB: Tool;
let courseId: string;
let otherCourseId: string;
let schoolBCourse: string;
const TEACHER = { id: "t1", name: "Ms Teacher", email: "teacher@school.test", tenantId: "school-a" };
const STUDENT = { id: "s1", name: "Sam Student", email: "sam@school.test", tenantId: "school-a" };
const T = { tenantId: "school-a", userId: "t1" };

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
  setJwksFetcher(async (url) => {
    assert.ok(url.startsWith(TOOL) || url.startsWith("https://other-tool.test"));
    return { keys: [{ ...toolKeys.publicKey.export({ format: "jwk" }), kid: KID }] };
  });
  const r = await registerTool("school-a", "admin-1", {
    name: "Quiz Tool", loginUrl: `${TOOL}/login`, launchUrl: `${TOOL}/launch`, deepLinkUrl: `${TOOL}/pick`,
    jwksUrl: `${TOOL}/jwks`, redirectUris: `${TOOL}/launch`,
  });
  assert.ok(r.ok);
  tool = r.tool;
  const rb = await registerTool("school-b", "admin-b", {
    name: "Other", loginUrl: "https://other-tool.test/login", launchUrl: "https://other-tool.test/launch", jwksUrl: "https://other-tool.test/jwks",
  });
  assert.ok(rb.ok);
  toolB = rb.tool;
  const courses = await myCourses("school-a", [{ id: "bio9", name: "Biology 9", role: "teacher" }, { id: "chem", name: "Chemistry", role: "teacher" }]);
  courseId = courses.find((c) => c.name === "Biology 9")!.id;
  otherCourseId = courses.find((c) => c.name === "Chemistry")!.id;
  schoolBCourse = (await myCourses("school-b", [{ id: "bio9", name: "Biology B", role: "teacher" }]))[0].id;
});
after(async () => { setJwksFetcher(null); await db.close(); });

function sign(claims: Record<string, unknown>, key = toolKeys.privateKey, kid = KID): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "RS256", typ: "JWT", kid });
  const body = enc(claims);
  return `${head}.${body}.${crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key).toString("base64url")}`;
}

/** Checks a token we signed against our own published JWKS, as a tool would. */
async function verifyOurs(jwt: string): Promise<Record<string, unknown>> {
  const [h, b, s] = jwt.split(".");
  const head = JSON.parse(Buffer.from(h, "base64url").toString());
  const jwk = (await publicJwks()).keys.find((k) => (k as { kid?: string }).kid === head.kid)!;
  const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
  assert.ok(crypto.verify("RSA-SHA256", Buffer.from(`${h}.${b}`), key, Buffer.from(s, "base64url")), "signed with our published key");
  return JSON.parse(Buffer.from(b, "base64url").toString());
}

/** The tool's side of the login: it sends the browser to our auth endpoint with what we gave it. */
function authParams(params: Record<string, string>, over: Record<string, string> = {}) {
  return new URLSearchParams({
    scope: "openid", response_type: "id_token", response_mode: "form_post", prompt: "none",
    client_id: params.client_id, redirect_uri: `${TOOL}/launch`, login_hint: params.login_hint,
    lti_message_hint: params.lti_message_hint, state: "tool-state", nonce: crypto.randomUUID(), ...over,
  });
}

async function lessonLink() {
  const lesson = await createLesson(T, courseId, "Cells");
  const link = await placeToolPage(tool, "t1", courseId, lesson.id);
  return { lesson, link };
}

test("lti platform: registering a tool checks addresses and makes a unique client id", async () => {
  assert.equal(tool.clientId.startsWith("sl-"), true);
  assert.equal(tool.teacherData, "name_email");
  assert.equal(tool.studentData, "none", "students: an opaque id only by default");
  const bad = await registerTool("school-a", "admin-1", { name: "X", loginUrl: "http://evil.test/login", launchUrl: `${TOOL}/l`, jwksUrl: `${TOOL}/j` });
  assert.deepEqual(bad, { ok: false, error: "toolBadUrl" });
  const js = await registerTool("school-a", "admin-1", { name: "X", loginUrl: "javascript:alert(1)", launchUrl: `${TOOL}/l`, jwksUrl: `${TOOL}/j` });
  assert.equal(js.ok, false);
  const dup = await registerTool("school-b", "admin-b", { name: "Y", clientId: tool.clientId, loginUrl: `${TOOL}/l`, launchUrl: `${TOOL}/l`, jwksUrl: `${TOOL}/j` });
  assert.deepEqual(dup, { ok: false, error: "toolClientTaken" });
  assert.deepEqual(toolOrigins(tool), [TOOL]);
  assert.match(toolFlowCsp([TOOL], [TOOL]), /form-action 'self' https:\/\/tool\.example\.test.*frame-src 'self' https:\/\/tool\.example\.test.*frame-ancestors 'self'/);
});

test("lti platform: a student's launch is signed by us, carries the course and role, and no name or email", async () => {
  const { link } = await lessonLink();
  const r = await startToolLaunch({
    me: STUDENT, role: "student", tool, course: { id: courseId, name: "Biology 9" }, what: { kind: "link", link },
    presentation: "iframe", lang: "es", origin: ORIGIN,
  });
  assert.equal(r.loginUrl, `${TOOL}/login`);
  assert.equal(r.params.iss, ORIGIN);
  assert.equal(r.params.lti_deployment_id, tool.id);
  const p = authParams(r.params);
  const a = await authorize(p, null);
  assert.ok(a.ok);
  assert.equal(a.redirectUri, `${TOOL}/launch`);
  assert.equal(a.state, "tool-state");
  const c = await verifyOurs(a.idToken);
  assert.equal(c.iss, ORIGIN);
  assert.equal(c.aud, tool.clientId);
  assert.equal(c.nonce, p.get("nonce"));
  assert.notEqual(c.sub, "s1", "never the Signify id");
  assert.equal(c.name, undefined);
  assert.equal(c.email, undefined);
  assert.equal(c[`${C}message_type`], "LtiResourceLinkRequest");
  assert.equal(c[`${C}deployment_id`], tool.id);
  assert.deepEqual(c[`${C}roles`], ["http://purl.imsglobal.org/vocab/lis/v2/membership#Learner", "http://purl.imsglobal.org/vocab/lis/v2/institution/person#Student"]);
  assert.equal((c[`${C}context`] as { id: string }).id, courseId);
  assert.equal((c[`${C}resource_link`] as { id: string }).id, link.id);
  assert.equal((c[`${C}launch_presentation`] as { document_target: string; locale: string }).document_target, "iframe");
  assert.equal((c[AGS] as { lineitems: string }).lineitems, `${ORIGIN}/lti/platform/ags/${courseId}/lineitems`);
  assert.equal((c[AGS] as { lineitem?: string }).lineitem, undefined, "a lesson block has no line item");
  assert.ok(Number(c.exp) - Number(c.iat) <= 300);

  // The hint is spent: the same request again finds nothing.
  assert.deepEqual(await authorize(authParams(r.params), null), { ok: false, error: "toolLoginGone", tool });
});

test("lti platform: a teacher's launch carries name and email; the school can turn that off, or turn students' name on", async () => {
  const { link } = await lessonLink();
  const launch = async (me: typeof TEACHER, role: "teacher" | "student") => {
    const fresh = (await getTool("school-a", tool.id))!;
    const r = await startToolLaunch({ me, role, tool: fresh, course: { id: courseId, name: "Biology 9" }, what: { kind: "link", link }, presentation: "window", lang: "en", origin: ORIGIN });
    const a = await authorize(authParams(r.params), null);
    assert.ok(a.ok);
    return verifyOurs(a.idToken);
  };
  const t = await launch(TEACHER, "teacher");
  assert.equal(t.name, "Ms Teacher");
  assert.equal(t.email, "teacher@school.test");
  assert.ok((t[`${C}roles`] as string[]).includes("http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor"));
  const s1 = (await launch(STUDENT, "student")).sub;
  await setToolPrivacy("school-a", tool.id, "none", "name");
  const t2 = await launch(TEACHER, "teacher");
  assert.equal(t2.name, undefined);
  assert.equal(t2.email, undefined);
  const s = await launch(STUDENT, "student");
  assert.equal(s.name, "Sam Student");
  assert.equal(s.email, undefined);
  assert.equal(s.sub, s1, "the same person keeps the same id at one tool");
  await setToolPrivacy("school-a", tool.id, "name_email", "none");
  tool = (await getTool("school-a", tool.id))!;
});

test("lti platform: auth refuses another redirect URI, a wrong client, the wrong person, a bad flow and an old hint", async () => {
  const { link } = await lessonLink();
  const start = () => startToolLaunch({ me: STUDENT, role: "student", tool, course: { id: courseId, name: "B" }, what: { kind: "link", link }, presentation: "window", lang: "en", origin: ORIGIN });
  let r = await start();
  assert.equal((await authorize(authParams(r.params, { redirect_uri: "https://evil.test/catch" }), null) as { error: string }).error, "toolBadRedirect");
  assert.equal((await authorize(authParams(r.params, { client_id: toolB.clientId, redirect_uri: "https://other-tool.test/launch" }), null) as { error: string }).error, "toolLoginGone",
    "another school's tool can't spend this hint");
  assert.equal((await authorize(authParams(r.params, { client_id: "nobody" }), null) as { error: string }).error, "toolUnknown");
  assert.equal((await authorize(authParams(r.params, { response_mode: "query" }), null) as { error: string }).error, "toolBadAuth");
  assert.equal((await authorize(authParams(r.params, { nonce: "" }), null) as { error: string }).error, "toolBadAuth");
  assert.equal((await authorize(authParams(r.params, { login_hint: "guess" }), null) as { error: string }).error, "toolLoginGone");
  assert.equal((await authorize(authParams(r.params), "t1") as { error: string }).error, "toolWrongPerson");
  r = await start();
  assert.equal((await authorize(authParams(r.params), null, Date.now() + 6 * 60_000) as { error: string }).error, "toolLoginGone");
});

/** The tool's Deep Linking answer for a pick. */
function dlAnswer(pickId: string, items: unknown[], over: Record<string, unknown> = {}, key = toolKeys.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return sign({
    iss: tool.clientId, aud: ORIGIN, iat: now, exp: now + 300, nonce: crypto.randomUUID(),
    [`${C}version`]: "1.3.0", [`${C}message_type`]: "LtiDeepLinkingResponse", [`${C}deployment_id`]: tool.id,
    [`${DL}data`]: pickId, [`${DL}content_items`]: items, ...over,
  }, key);
}

test("lti platform: Deep Linking as assignments makes draft assignments worth the line item, once", async () => {
  const pick = await startPick(tool, "t1", courseId, null);
  const r = await startToolLaunch({ me: TEACHER, role: "teacher", tool, course: { id: courseId, name: "Biology 9" }, what: { kind: "pick", pick }, presentation: "window", lang: "en", origin: ORIGIN });
  assert.equal(r.params.target_link_uri, `${TOOL}/pick`);
  const a = await authorize(authParams(r.params), null);
  assert.ok(a.ok);
  const c = await verifyOurs(a.idToken);
  assert.equal(c[`${C}message_type`], "LtiDeepLinkingRequest");
  const s = c[`${DL}deep_linking_settings`] as Record<string, unknown>;
  assert.equal(s.deep_link_return_url, `${ORIGIN}/lti/platform/deep/${pick.id}`);
  assert.equal(s.data, pick.id);
  assert.equal(s.accept_lineitem, true);

  const items = [
    { type: "ltiResourceLink", title: "Cell quiz", url: `${TOOL}/launch?q=7`, custom: { quiz: "7", "bad key!": "x" }, lineItem: { scoreMaximum: 20, label: "Cell quiz", resourceId: "q7", tag: "quiz" } },
    { type: "ltiResourceLink", title: "Elsewhere", url: "https://evil.test/steal" },
    { type: "html", html: "<script>" },
  ];
  // Signature first: a stranger's key, or a token for someone else, changes nothing.
  assert.equal((await acceptDeepLink(dlAnswer(pick.id, items, {}, strangerKeys.privateKey), pick.id, ORIGIN) as { error: string }).error, "ltiBadSignature");
  assert.equal((await acceptDeepLink(dlAnswer(pick.id, items, { aud: "https://other.test" }), pick.id, ORIGIN) as { error: string }).error, "ltiBadAudience");
  assert.equal((await acceptDeepLink(dlAnswer(pick.id, items, { exp: 1, iat: 1 }), pick.id, ORIGIN) as { error: string }).error, "ltiExpired");
  assert.equal((await acceptDeepLink(dlAnswer("someone-elses-pick", items), pick.id, ORIGIN) as { error: string }).error, "toolBadAnswer");
  assert.equal((await acceptDeepLink(dlAnswer(pick.id, items, { [`${C}deployment_id`]: "x" }), pick.id, ORIGIN) as { error: string }).error, "ltiBadDeployment");
  const unsigned = dlAnswer(pick.id, items).split(".");
  assert.equal((await acceptDeepLink(`${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${unsigned[1]}.`, pick.id, ORIGIN) as { error: string }).error, "toolBadAnswer");

  const good = dlAnswer(pick.id, items);
  const done = await acceptDeepLink(good, pick.id, ORIGIN);
  assert.ok(done.ok);
  assert.equal(done.pick.items.length, 1, "only the tool's own pages are placed");
  const made = await getAssignment(T, done.pick.items[0].assignmentId!);
  assert.equal(made!.title, "Cell quiz");
  assert.equal(made!.points, 20);
  assert.equal(made!.published, false, "a draft");
  assert.equal((await acceptDeepLink(good, pick.id, ORIGIN) as { error: string }).error, "ltiBadNonce", "replayed");
  assert.equal((await acceptDeepLink(dlAnswer(pick.id, items), pick.id, ORIGIN) as { error: string }).error, "toolPickGone", "taken once");
});

test("lti platform: Deep Linking into a lesson gives blocks; an empty answer is a cancel", async () => {
  const lesson = await createLesson(T, courseId, "Lab");
  const pick = await startPick(tool, "t1", courseId, lesson.id);
  const done = await acceptDeepLink(dlAnswer(pick.id, [{ type: "ltiResourceLink", title: "Microscope sim", iframe: { height: 600 } }]), pick.id, ORIGIN);
  assert.ok(done.ok);
  assert.equal(done.pick.place, "lesson");
  assert.deepEqual(done.pick.items.map((i) => [i.title, i.display, i.assignmentId]), [["Microscope sim", "frame", undefined]]);
  const pick2 = await startPick(tool, "t1", courseId, lesson.id);
  const none = await acceptDeepLink(dlAnswer(pick2.id, []), pick2.id, ORIGIN);
  assert.ok(none.ok);
  assert.equal(none.pick.state, "cancelled");
  // A tool block keeps only a real link id.
  const [b] = normalizeBlocks([{ type: "tool", title: " Sim ", linkId: "../../x", display: "popup" }]);
  assert.deepEqual({ ...b, id: "" }, { id: "", type: "tool", title: "Sim", linkId: "", display: "tab" });
});

/** The tool's client-credentials request. */
function tokenForm(over: Record<string, unknown> = {}, scope = `${SCORE} ${LI_RO}`, client = tool.clientId) {
  const now = Math.floor(Date.now() / 1000);
  return new URLSearchParams({
    grant_type: "client_credentials", client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: sign({ iss: client, sub: client, aud: `${ORIGIN}/lti/platform/token`, iat: now, exp: now + 300, jti: crypto.randomUUID(), ...over }),
    scope,
  });
}
const TOKEN_URL = `${ORIGIN}/lti/platform/token`;

test("lti platform: tokens need the tool's signed assertion, once, for our token URL; only our scopes", async () => {
  const f = tokenForm({}, `${SCORE} ${LI_RO} https://purl.imsglobal.org/spec/lti-ags/scope/lineitem https://example.test/everything`);
  const r = await issueToken(f, TOKEN_URL);
  assert.ok(r.ok);
  assert.equal(r.body.scope, `${SCORE} ${LI_RO}`, "lineitem (write) and unknown scopes are never granted");
  assert.equal((await issueToken(f, TOKEN_URL) as { error: string }).error, "invalid_client", "the jti is spent");
  assert.equal((await issueToken(tokenForm({ aud: "https://elsewhere.test/token" }), TOKEN_URL) as { error: string }).error, "invalid_client");
  assert.equal((await issueToken(tokenForm({ exp: 1 }), TOKEN_URL) as { error: string }).error, "invalid_client");
  assert.equal((await issueToken(tokenForm({ jti: undefined }), TOKEN_URL) as { error: string }).error, "invalid_client");
  assert.equal((await issueToken(tokenForm({ sub: "someone" }), TOKEN_URL) as { error: string }).error, "invalid_client");
  assert.equal((await issueToken(tokenForm({}, "https://example.test/nothing"), TOKEN_URL) as { error: string }).error, "invalid_scope");
  const forged = tokenForm();
  const parts = forged.get("client_assertion")!.split(".");
  forged.set("client_assertion", `${parts[0]}.${parts[1]}.${crypto.sign("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), strangerKeys.privateKey).toString("base64url")}`);
  assert.equal((await issueToken(forged, TOKEN_URL) as { error: string }).error, "invalid_client");
  const wrongGrant = tokenForm(); wrongGrant.set("grant_type", "password");
  assert.equal((await issueToken(wrongGrant, TOKEN_URL) as { error: string }).error, "unsupported_grant_type");

  resetTokenRate();
  for (let i = 0; i < 30; i++) assert.ok(tokenRateOk("ip:1"));
  assert.equal(tokenRateOk("ip:1"), false, "rate-limited");
  assert.ok(tokenRateOk("ip:2"));
  assert.ok(tokenRateOk("ip:1", Date.now() + 61_000), "a minute later it may ask again");
});

test("lti platform: scores go through the grade path with history and the roster check; other schools see nothing", async () => {
  // A placed assignment and a student who launched it (so the tool knows their id).
  const pick = await startPick(tool, "t1", courseId, null);
  const done = await acceptDeepLink(dlAnswer(pick.id, [{ type: "ltiResourceLink", title: "Sim lab", lineItem: { scoreMaximum: 50 } }]), pick.id, ORIGIN);
  assert.ok(done.ok);
  const { linkId, assignmentId } = done.pick.items[0];
  const a0 = (await getAssignment(T, assignmentId!))!;
  assert.equal(a0.points, 50);
  const link = (await import("../src/lib/lti-platform")).getLink;
  const l = (await link("school-a", linkId))!;
  const r = await startToolLaunch({ me: STUDENT, role: "student", tool, course: { id: courseId, name: "Biology 9" }, what: { kind: "link", link: l }, presentation: "window", lang: "en", origin: ORIGIN });
  const au = await authorize(authParams(r.params), null);
  assert.ok(au.ok);
  const claims = await verifyOurs(au.idToken);
  const sub = String(claims.sub);
  const lineitem = (claims[AGS] as { lineitem: string }).lineitem;
  assert.equal(lineitem, `${ORIGIN}/lti/platform/ags/${courseId}/lineitems/${linkId}`);

  const tok = await issueToken(tokenForm(), TOKEN_URL);
  assert.ok(tok.ok);
  const bearer = `Bearer ${tok.body.access_token}`;
  const auth = await serviceAuth(bearer, SCORE, courseId);
  assert.ok(auth.ok);
  assert.equal((await serviceAuth("Bearer nope-nope-nope-nope-nope", SCORE, courseId) as { status: number }).status, 401);
  assert.equal((await serviceAuth(bearer, SCORE, otherCourseId) as { status: number }).status, 404, "not placed in that course");
  assert.equal((await serviceAuth(bearer, SCORE, schoolBCourse) as { status: number }).status, 404, "another school's course");
  const roTok = await issueToken(tokenForm({}, LI_RO), TOKEN_URL);
  assert.ok(roTok.ok);
  assert.equal((await serviceAuth(`Bearer ${roTok.body.access_token}`, SCORE, courseId) as { status: number }).status, 403, "scope enforced");

  // Another school's tool, with a good token of its own, can't reach this course.
  const bForm = tokenForm({}, SCORE, toolB.clientId);
  const bTok = await issueToken(bForm, TOKEN_URL);
  assert.ok(bTok.ok);
  assert.equal((await serviceAuth(`Bearer ${bTok.body.access_token}`, SCORE, courseId) as { status: number }).status, 404);

  const items = await lineItems(tool, courseId, ORIGIN);
  const li = items.find((x) => x.resourceLinkId === linkId)!;
  assert.equal(li.id, lineitem);
  assert.equal(li.scoreMaximum, 50);
  assert.equal(li.label, "Sim lab");

  const t0 = new Date().toISOString();
  const score = (over: Record<string, unknown> = {}) => ({ userId: sub, scoreGiven: 8, scoreMaximum: 10, activityProgress: "Completed", gradingProgress: "FullyGraded", timestamp: t0, ...over });
  assert.equal((await postScore(tool, courseId, linkId, score({ userId: "s1" }))).status, 404, "Signify ids mean nothing to a tool");
  assert.equal((await postScore(tool, courseId, linkId, score({ scoreGiven: -1 }))).status, 400);
  assert.equal((await postScore(tool, courseId, linkId, score({ gradingProgress: "Done" }))).status, 400);
  assert.equal((await postScore(tool, otherCourseId, linkId, score())).status, 404);
  assert.equal((await postScore(tool, courseId, linkId, score())).status, 200);
  assert.equal((await postScore(tool, courseId, linkId, score({ scoreGiven: 1 }))).status, 409, "same timestamp: ours stands");
  assert.equal((await gradesFor(T, assignmentId!)).length, 0, "nothing in the gradebook until ID can say who's in the class");

  // Not in the class per ID now: refused, nothing written.
  assert.deepEqual(await applyToolScores("school-a", a0, new Set(["s2"])), []);
  assert.equal((await toolScores("school-a", assignmentId!))[0].status, "refused");
  assert.equal((await gradesFor(T, assignmentId!)).length, 0);

  // A newer score; the student is in the class: written, scaled to 50 points, with history.
  const t1 = new Date(Date.now() + 1000).toISOString();
  assert.equal((await postScore(tool, courseId, linkId, score({ scoreGiven: 9, timestamp: t1 }))).status, 200);
  const a = (await saveAssignment(T, assignmentId!, { baseVersion: a0.version, title: a0.title, points: 50, published: true }) as { ok: true; assignment: typeof a0 }).assignment ?? a0;
  assert.deepEqual(await applyToolScores("school-a", a, new Set(["s1"])), ["s1"]);
  const [g] = await gradesFor(T, assignmentId!);
  assert.equal(g.score, 45);
  const h = await gradeHistory(T, assignmentId!, "s1");
  assert.equal(h[0].changedBy, `lti-tool:${tool.id}`);
  assert.equal((await toolScores("school-a", assignmentId!))[0].status, "written");
  assert.deepEqual(await applyToolScores("school-a", a, new Set(["s1"])), [], "written once");

  // Not fully graded: kept, but nothing to write.
  const t2 = new Date(Date.now() + 2000).toISOString();
  assert.equal((await postScore(tool, courseId, linkId, score({ gradingProgress: "PendingManual", scoreGiven: undefined, timestamp: t2 }))).status, 200);
  assert.equal((await toolScores("school-a", assignmentId!))[0].status, "recorded");
});

test("i18n: platform-mode strings have Spanish", () => {
  const en = dict("en"), es = dict("es");
  for (const k of ["blockTool", "toolsTitle", "toolTeacherData", "toolStudentData", "toolShareNone", "toolPrivacyHint", "toolPickIn",
    "toolDisplayFrame", "toolOpen", "toolLoginGone", "toolBadRedirect", "toolPickedLesson", "toolAssignmentHint"] as const) {
    assert.notEqual(es[k], en[k], `${k} has no Spanish`);
  }
});
