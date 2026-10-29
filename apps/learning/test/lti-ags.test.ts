import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import crypto from "node:crypto";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses } from "../src/lib/courses";
import { createLesson } from "../src/lib/lessons";
import { createAssignment, saveAssignment } from "../src/lib/assignments";
import {
  registerPlatform, startLogin, checkLaunch, resolveLaunch, linkLaunch, publicJwks, setJwksFetcher, launchCsp, type Platform,
} from "../src/lib/lti";
import { pickables, placeItems, takeResponse, placements } from "../src/lib/lti-dl";
import { queueGrades, sendDue, retryScores, scoreStatuses, scoreToSend, scoresUrl, setAgsFetch, BACKOFF_MIN } from "../src/lib/lti-ags";

// A fake Schoology: its own keys, an OAuth token endpoint that checks our
// signed client assertion against our published JWKS, a Names and Roles
// list, a line items list, and a scores endpoint that records what it got.
const ORIGIN = "https://learn.example.test";
const ISS = "https://platform.example.test";
const CLIENT = "client-dl";
const DEPLOY = "dep-1";
const KID = "platform-key-1";
const C = "https://purl.imsglobal.org/spec/lti/claim/";
const DL = "https://purl.imsglobal.org/spec/lti-dl/claim/";
const AGS = "https://purl.imsglobal.org/spec/lti-ags/claim/endpoint";
const NRPS = "https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice";
const SCOPE_SCORE = "https://purl.imsglobal.org/spec/lti-ags/scope/score";
const SCOPE_LI_RO = "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem.readonly";
const platformKeys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

const LINEITEMS = `${ISS}/api/courses/sgy-course-9/lineitems`;
const MEMBERS = `${ISS}/api/courses/sgy-course-9/members`;

type Call = { url: string; method: string; headers: Record<string, string>; body: string };
const fake = {
  calls: [] as Call[],
  down: false,
  scoreStatus: 200,
  lineItems: [] as { id: string; resourceId: string; scoreMaximum: number }[],
  members: [
    { user_id: "sgy-s1", email: "student1@school.test", roles: ["Learner"] },
    { user_id: "sgy-s2", email: "student2@school.test", roles: ["Learner"] },
  ],
  scores: [] as { url: string; body: Record<string, unknown> }[],
};

async function verifyOurJwt(jwt: string): Promise<Record<string, unknown>> {
  const [h, b, s] = jwt.split(".");
  const head = JSON.parse(Buffer.from(h, "base64url").toString());
  assert.equal(head.alg, "RS256");
  const { keys } = await publicJwks();
  const jwk = keys.find((k) => (k as { kid?: string }).kid === head.kid);
  assert.ok(jwk, "signed with a key we publish");
  const key = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: "jwk" });
  assert.ok(crypto.verify("RSA-SHA256", Buffer.from(`${h}.${b}`), key, Buffer.from(s, "base64url")), "our signature checks out");
  return JSON.parse(Buffer.from(b, "base64url").toString());
}

const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });

async function platformFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  const call = { url, method: init.method || "GET", headers, body: String(init.body ?? "") };
  fake.calls.push(call);
  if (fake.down) throw new Error("connect ECONNREFUSED");
  const bearer = headers.authorization?.replace(/^Bearer /, "");
  if (url === `${ISS}/token`) {
    const form = new URLSearchParams(call.body);
    assert.equal(form.get("grant_type"), "client_credentials");
    assert.equal(form.get("client_assertion_type"), "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
    const claims = await verifyOurJwt(form.get("client_assertion")!);
    assert.equal(claims.iss, CLIENT);
    assert.equal(claims.sub, CLIENT);
    assert.equal(claims.aud, `${ISS}/token`);
    assert.ok(typeof claims.jti === "string");
    return json({ access_token: `tok:${form.get("scope")}`, token_type: "Bearer", expires_in: 3600 });
  }
  if (url.startsWith(MEMBERS)) {
    assert.match(bearer || "", /contextmembership\.readonly/);
    return json({ id: MEMBERS, members: fake.members });
  }
  if (url.startsWith(LINEITEMS) && call.method === "GET" && !url.includes("/scores")) {
    assert.match(bearer || "", /lineitem/);
    const rid = new URL(url).searchParams.get("resource_id");
    return json(fake.lineItems.filter((l) => !rid || l.resourceId === rid));
  }
  if (url.includes("/scores") && call.method === "POST") {
    assert.match(bearer || "", /scope\/score/);
    assert.equal(headers["content-type"], "application/vnd.ims.lis.v1.score+json");
    if (fake.scoreStatus !== 200) return json({ error: "nope" }, fake.scoreStatus);
    fake.scores.push({ url, body: JSON.parse(call.body) });
    return json({});
  }
  return json({ error: "not found" }, 404);
}

let db: Db;
let platform: Platform;
let courseId: string;
let otherCourseId: string;
const T = { tenantId: "school-a", userId: "t1" };
const TEACHER = { id: "t1", email: "teacher@school.test", tenantId: "school-a" };
const STUDENT = { id: "s1", email: "student1@school.test", tenantId: "school-a" };
const TCLASSES = [{ id: "bio9", name: "Biology 9", role: "teacher" }, { id: "chem", name: "Chemistry", role: "teacher" }];

before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
  setJwksFetcher(async () => ({ keys: [{ ...platformKeys.publicKey.export({ format: "jwk" }), kid: KID }] }));
  setAgsFetch(platformFetch);
  const r = await registerPlatform("school-a", "admin-1", {
    name: "Schoology", issuer: ISS, clientId: CLIENT, deploymentIds: DEPLOY,
    authUrl: `${ISS}/auth`, tokenUrl: `${ISS}/token`, jwksUrl: `${ISS}/jwks`, frameOrigins: "https://school.schoology.com",
  });
  assert.ok(r.ok);
  platform = r.platform;
  const courses = await myCourses("school-a", TCLASSES);
  courseId = courses.find((c) => c.name === "Biology 9")!.id;
  otherCourseId = courses.find((c) => c.name === "Chemistry")!.id;
});
after(async () => { setJwksFetcher(null); setAgsFetch(null); await db.close(); });

function sign(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "RS256", typ: "JWT", kid: KID });
  const body = enc(claims);
  return `${head}.${body}.${crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), platformKeys.privateKey).toString("base64url")}`;
}

async function launch(extra: Record<string, unknown>, email = "teacher@school.test") {
  const l = await startLogin({ iss: ISS, login_hint: "u", client_id: CLIENT }, ORIGIN);
  assert.ok(l.ok);
  const u = new URL(l.redirect);
  const state = u.searchParams.get("state")!;
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    iss: ISS, aud: CLIENT, sub: email === "teacher@school.test" ? "sgy-t1" : "sgy-s1", exp: now + 300, iat: now,
    nonce: u.searchParams.get("nonce"), email,
    [`${C}version`]: "1.3.0",
    [`${C}deployment_id`]: DEPLOY,
    [`${C}target_link_uri`]: `${ORIGIN}/lti/launch`,
    [`${C}context`]: { id: "sgy-course-9", title: "Biology 9 (Schoology)" },
    [NRPS]: { context_memberships_url: MEMBERS, service_versions: ["2.0"] },
    [AGS]: { scope: [SCORE_SCOPES].flat(), lineitems: LINEITEMS },
    ...extra,
  };
  for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
  return checkLaunch(sign(claims), state, [state], ORIGIN);
}
const SCORE_SCOPES = [SCOPE_SCORE, SCOPE_LI_RO];

const deepLinkRequest = (settings: Record<string, unknown> = {}) => ({
  [`${C}message_type`]: "LtiDeepLinkingRequest",
  [`${DL}deep_linking_settings`]: {
    deep_link_return_url: `${ISS}/deep_link_return`, accept_types: ["ltiResourceLink"],
    accept_presentation_document_targets: ["iframe", "window"], accept_multiple: true, data: "opaque-123", ...settings,
  },
});

let essayId: string;
let lessonId: string;

test("deep linking: a teacher picks lessons and assignments; the signed answer carries line items and is taken once", async () => {
  const essay = await createAssignment(T, courseId, { title: "Cell essay" });
  const saved = await saveAssignment(T, essay.id, { baseVersion: essay.version, points: 20, published: true });
  assert.ok(saved.ok);
  essayId = essay.id;
  lessonId = (await createLesson(T, courseId, "Cells, day 1")).id;
  const foreign = await createAssignment(T, otherCourseId, { title: "Not this course" });

  const r = await launch(deepLinkRequest());
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.launch.messageType, "LtiDeepLinkingRequest");
  // The frame may post the answer to the platform, and only there.
  assert.match(launchCsp(r.platform, { connect: true, postTo: r.launch.deepLink!.returnUrl }), /form-action 'self' https:\/\/platform\.example\.test;/);

  // Not linked yet: the teacher links the course first, then picks.
  assert.equal((await resolveLaunch(r.launch.id, TEACHER, TCLASSES)).kind, "pick");
  assert.deepEqual(await linkLaunch(r.launch.id, TEACHER, TCLASSES, courseId), { ok: true, courseId });
  const res = await resolveLaunch(r.launch.id, TEACHER, TCLASSES);
  assert.equal(res.kind, "deepLink");

  const list = await pickables("school-a", courseId);
  assert.deepEqual(list.map((p) => p.title), ["Cell essay", "Cells, day 1"]);
  assert.equal(await takeResponse(r.launch.id).then((x) => x.state), "waiting");

  const placed = await placeItems(r.launch.id, TEACHER, TCLASSES, courseId,
    [`assignment:${essayId}`, `lesson:${lessonId}`, `assignment:${foreign.id}`, "assignment:junk"], ORIGIN);
  assert.ok(placed.ok, JSON.stringify(placed));
  assert.equal(placed.count, 2, "only this course's items");

  const claims = await verifyOurJwt(placed.jwt);
  assert.equal(claims.iss, CLIENT);
  assert.equal(claims.aud, ISS);
  assert.equal(claims[`${C}message_type`], "LtiDeepLinkingResponse");
  assert.equal(claims[`${C}version`], "1.3.0");
  assert.equal(claims[`${C}deployment_id`], DEPLOY);
  assert.equal(claims[`${DL}data`], "opaque-123");
  const items = claims[`${DL}content_items`] as Record<string, unknown>[];
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    type: "ltiResourceLink", title: "Cell essay",
    url: `${ORIGIN}/lti/launch?item=${encodeURIComponent(`assignment:${essayId}`)}`,
    custom: { signify_item: `assignment:${essayId}` },
    lineItem: { scoreMaximum: 20, label: "Cell essay", resourceId: `assignment:${essayId}`, tag: "signify-learning" },
  });
  assert.equal(items[1].lineItem, undefined, "a lesson has no gradebook column");

  const taken = await takeResponse(r.launch.id);
  assert.equal(taken.state, "ready");
  assert.ok(taken.state === "ready" && taken.jwt === placed.jwt && taken.returnUrl === `${ISS}/deep_link_return`);
  assert.equal((await takeResponse(r.launch.id)).state, "gone", "handed out once");
  assert.deepEqual((await placements("school-a", "assignment", essayId)).map((p) => p.contextId), ["sgy-course-9"]);
});

test("deep linking: one item when the platform takes one; students and other people can't place; bad requests refused", async () => {
  const one = await launch(deepLinkRequest({ accept_multiple: false }));
  assert.ok(one.ok);
  const p = await placeItems(one.launch.id, TEACHER, TCLASSES, courseId, [`assignment:${essayId}`, `lesson:${lessonId}`], ORIGIN);
  assert.ok(p.ok);
  assert.equal(p.count, 1);

  const cancel = await launch(deepLinkRequest());
  assert.ok(cancel.ok);
  const none = await placeItems(cancel.launch.id, TEACHER, TCLASSES, courseId, [], ORIGIN);
  assert.ok(none.ok);
  assert.equal(none.count, 0, "cancelling still answers the platform");
  assert.deepEqual((await verifyOurJwt(none.jwt))[`${DL}content_items`], []);

  const st = await launch(deepLinkRequest(), "student1@school.test");
  assert.ok(st.ok);
  assert.deepEqual(await resolveLaunch(st.launch.id, STUDENT, [{ id: "bio9", name: "Biology 9", role: "student" }]),
    { kind: "error", error: "ltiDlTeachersOnly" });
  const tl = await launch(deepLinkRequest());
  assert.ok(tl.ok);
  assert.deepEqual(await placeItems(tl.launch.id, { ...TEACHER, email: "other@school.test" }, TCLASSES, courseId, [], ORIGIN),
    { ok: false, error: "ltiWrongPerson" });
  assert.deepEqual(await placeItems(tl.launch.id, TEACHER, TCLASSES, otherCourseId, [], ORIGIN), { ok: false, error: "ltiNotTeacher" });

  const noLinks = await launch(deepLinkRequest({ accept_types: ["file"] }));
  assert.deepEqual(noLinks.ok ? null : noLinks.error, "ltiDlNoLinks");
  const noReturn = await launch(deepLinkRequest({ deep_link_return_url: "http://insecure.test/x" }));
  assert.deepEqual(noReturn.ok ? null : noReturn.error, "ltiBadMessage");
  // A resource-link launch still needs its resource link.
  const plain = await launch({ [`${C}message_type`]: "LtiResourceLinkRequest" });
  assert.deepEqual(plain.ok ? null : plain.error, "ltiBadMessage");
});

test("placed links open their item; a link's first launch brings its line item address", async () => {
  const LI = `${LINEITEMS}/77?x=1`;
  const r = await launch({
    [`${C}message_type`]: "LtiResourceLinkRequest",
    [`${C}resource_link`]: { id: "rl-essay" },
    [`${C}custom`]: { signify_item: `assignment:${essayId}` },
    [AGS]: { scope: SCORE_SCOPES, lineitems: LINEITEMS, lineitem: LI },
  }, "student1@school.test");
  assert.ok(r.ok, JSON.stringify(r));
  const res = await resolveLaunch(r.launch.id, STUDENT, [{ id: "bio9", name: "Biology 9", role: "student" }]);
  assert.deepEqual(res, { kind: "open", href: `/assignments/${essayId}` });
  assert.deepEqual((await placements("school-a", "assignment", essayId)).map((p) => p.lineitem), [true]);
  const [u] = await db.query("SELECT sub FROM lti_users WHERE user_id = 's1'");
  assert.equal(u.sub, "sgy-s1", "the student's platform id, from their own launch");

  const lesson = await launch({
    [`${C}message_type`]: "LtiResourceLinkRequest", [`${C}resource_link`]: { id: "rl-lesson" },
    [`${C}target_link_uri`]: `${ORIGIN}/lti/launch?item=lesson:${lessonId}`,
  });
  assert.ok(lesson.ok);
  assert.deepEqual(await resolveLaunch(lesson.launch.id, TEACHER, TCLASSES), { kind: "open", href: `/lessons/${lessonId}/edit` });

  // An item from another course (a tampered custom value) just opens the linked course.
  const other = await createAssignment(T, otherCourseId, { title: "Elsewhere" });
  const odd = await launch({
    [`${C}message_type`]: "LtiResourceLinkRequest", [`${C}resource_link`]: { id: "rl-odd" },
    [`${C}custom`]: { signify_item: `assignment:${other.id}` },
  });
  assert.ok(odd.ok);
  assert.deepEqual(await resolveLaunch(odd.launch.id, TEACHER, TCLASSES), { kind: "course", courseId });
});

test("ags: what the gradebook says is what goes: late counts, missing is 0, exempt and ungraded send nothing, unreleased waits", () => {
  assert.deepEqual(scoreToSend({ score: 18, flag: "late" }, true), { score: 18 });
  assert.deepEqual(scoreToSend({ score: null, flag: "missing" }, true), { score: 0 });
  assert.deepEqual(scoreToSend({ score: 12, flag: "missing" }, true), { score: 12 });
  assert.deepEqual(scoreToSend({ score: 20, flag: "exempt" }, true), { skip: "exempt" });
  assert.deepEqual(scoreToSend({ score: null, flag: null }, true), { skip: "ungraded" });
  assert.deepEqual(scoreToSend(null, true), { skip: "ungraded" });
  assert.deepEqual(scoreToSend({ score: 18, flag: null }, false), { skip: "notReleased" });
  assert.equal(scoresUrl(`${LINEITEMS}/77?x=1`), `${LINEITEMS}/77/scores?x=1`);
});

test("ags: a save only queues (no platform call); the sender posts with a signed token, the right user and line item", async () => {
  const a = { id: essayId, points: 20, gradesReleased: false };
  fake.calls = [];
  await queueGrades("school-a", a, [{ studentId: "s1", email: "student1@school.test", grade: { score: 18, flag: "late", comment: "Good" } }]);
  assert.equal(fake.calls.length, 0, "queueing never calls Schoology");
  let [row] = await scoreStatuses("school-a", essayId);
  assert.equal(row.status, "skipped");
  assert.equal(row.error, "notReleased");
  assert.deepEqual(await sendDue(), { sent: 0, failed: 0 });

  // Released: s1 (known from their launch) and s2 (found in the platform's class list by email).
  a.gradesReleased = true;
  const waiting = await queueGrades("school-a", a, [
    { studentId: "s1", email: "student1@school.test", grade: { score: 18, flag: "late", comment: "Good" } },
    { studentId: "s2", email: "Student2@school.test", grade: { score: null, flag: "missing" } },
    { studentId: "s3", email: "student3@school.test", grade: { score: 20, flag: "exempt" } },
    { studentId: "s4", email: "student4@school.test", grade: null },
  ]);
  assert.equal(waiting, 2);
  assert.equal(fake.calls.length, 0);
  const out = await sendDue();
  assert.deepEqual(out, { sent: 2, failed: 0 });
  assert.equal(fake.scores.length, 2);
  const by = Object.fromEntries(fake.scores.map((s) => [s.body.userId, s]));
  assert.equal(by["sgy-s1"].url, `${LINEITEMS}/77/scores?x=1`);
  assert.equal(by["sgy-s1"].body.scoreGiven, 18);
  assert.equal(by["sgy-s1"].body.scoreMaximum, 20);
  assert.equal(by["sgy-s1"].body.comment, "Good");
  assert.equal(by["sgy-s1"].body.gradingProgress, "FullyGraded");
  assert.equal(by["sgy-s1"].body.activityProgress, "Completed");
  assert.equal(by["sgy-s2"].body.scoreGiven, 0, "missing is 0, as in the gradebook");
  const rows = await scoreStatuses("school-a", essayId);
  assert.deepEqual(rows.map((r) => [r.studentId, r.status]), [["s1", "sent"], ["s2", "sent"], ["s3", "skipped"]],
    "exempt has a row saying so; never-graded has none");
  // Emails are let go once the platform user is known.
  const left = await db.query("SELECT email FROM lti_scores WHERE email <> ''");
  assert.equal(left.length, 0);

  // The same grade again sends nothing new; a changed one goes again.
  assert.equal(await queueGrades("school-a", a, [{ studentId: "s1", email: "x", grade: { score: 18, flag: "late", comment: "Good" } }]), 0);
  assert.equal(await queueGrades("school-a", a, [{ studentId: "s1", email: "x", grade: { score: 19, flag: null, comment: "" } }]), 1);
  await sendDue();
  assert.equal(fake.scores.at(-1)!.body.scoreGiven, 19);
  [row] = await scoreStatuses("school-a", essayId);
  assert.equal(row.status, "sent");
});

test("ags: failures retry with backoff, stay visible, end as failed, and Retry sends again", async () => {
  const a = { id: essayId, points: 20, gradesReleased: true };
  fake.scores = [];
  fake.down = true;
  await queueGrades("school-a", a, [{ studentId: "s1", email: "", grade: { score: 15, flag: null } }]);
  let now = Date.now();
  assert.deepEqual(await sendDue(now), { sent: 0, failed: 1 });
  let [row] = await scoreStatuses("school-a", essayId);
  assert.equal(row.status, "pending");
  assert.equal(row.attempts, 1);
  assert.match(row.error, /^network/);
  assert.ok(new Date(row.nextAt).getTime() >= now + BACKOFF_MIN[0] * 60_000 - 1000, "waits before trying again");
  assert.deepEqual(await sendDue(now), { sent: 0, failed: 0 }, "not due yet");
  for (let i = 0; i < BACKOFF_MIN.length; i++) {
    now += 9 * 60 * 60_000;
    await sendDue(now);
  }
  [row] = await scoreStatuses("school-a", essayId);
  assert.equal(row.status, "failed");
  assert.equal(row.attempts, BACKOFF_MIN.length + 1);

  fake.down = false;
  fake.scoreStatus = 500;
  assert.equal(await retryScores("school-a", essayId), 1);
  await sendDue();
  [row] = await scoreStatuses("school-a", essayId);
  assert.equal(row.error, "scorePost 500");
  fake.scoreStatus = 200;
  await retryScores("school-a", essayId, "s1");
  await sendDue();
  [row] = await scoreStatuses("school-a", essayId);
  assert.equal(row.status, "sent");
  assert.equal(fake.scores.at(-1)!.body.scoreGiven, 15);
});

test("ags: a student not in the platform's class fails visibly; a column nobody launched is found by its resource id", async () => {
  // A second assignment, placed but never launched: its line item is looked up.
  const quiz = await createAssignment(T, courseId, { title: "Quiz" });
  await saveAssignment(T, quiz.id, { baseVersion: quiz.version, points: 10, published: true });
  const dl = await launch(deepLinkRequest());
  assert.ok(dl.ok);
  assert.ok((await placeItems(dl.launch.id, TEACHER, TCLASSES, courseId, [`assignment:${quiz.id}`], ORIGIN)).ok);
  fake.lineItems = [{ id: `${LINEITEMS}/88`, resourceId: `assignment:${quiz.id}`, scoreMaximum: 10 }];
  const a = { id: quiz.id, points: 10, gradesReleased: true };
  await queueGrades("school-a", a, [
    { studentId: "s2", email: "student2@school.test", grade: { score: 7, flag: null } },
    { studentId: "s9", email: "stranger@school.test", grade: { score: 9, flag: null } },
  ]);
  fake.scores = [];
  assert.deepEqual(await sendDue(), { sent: 1, failed: 1 });
  assert.equal(fake.scores[0].url, `${LINEITEMS}/88/scores`);
  const rows = await scoreStatuses("school-a", quiz.id);
  const s9 = rows.find((r) => r.studentId === "s9")!;
  assert.equal(s9.status, "pending");
  assert.equal(s9.error, "notInPlatformClass");
  const [li] = await db.query("SELECT lineitem_url FROM lti_items WHERE item_id = $1", [quiz.id]);
  assert.equal(li.lineitem_url, `${LINEITEMS}/88`, "remembered once found");
});

test("ags: assignments not placed in Schoology queue nothing; another school's rows are never shown", async () => {
  const lone = await createAssignment(T, courseId, { title: "Not placed" });
  assert.equal(await queueGrades("school-a", { id: lone.id, points: 10, gradesReleased: true },
    [{ studentId: "s1", email: "", grade: { score: 5, flag: null } }]), 0);
  assert.deepEqual(await scoreStatuses("school-b", essayId), []);
  assert.equal(await retryScores("school-b", essayId), 0);
  assert.equal(await queueGrades("school-b", { id: essayId, points: 20, gradesReleased: true },
    [{ studentId: "s1", email: "", grade: { score: 5, flag: null } }]), 0);
});
