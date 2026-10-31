import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";

// A stand-in for Signify ID's preview API: it answers only for the viewer's
// own token and only about the mock it was told the viewer may preview.
const calls: { path: string; auth: string }[] = [];
let down = false;
const server = http.createServer((req, res) => {
  calls.push({ path: req.url || "", auth: String(req.headers.authorization || "") });
  const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (down) return send(503, { error: "down" });
  if (req.headers.authorization !== "Bearer teacher-token") return send(401, { error: "invalid_token" });
  if (req.url === "/api/v1/preview/people") return send(200, { people: [
    { id: "mock-pip", display_name: "Pip Example (practice)", kind: "student" },
    { id: "mock-pat", display_name: "Pat Example (practice parent)", kind: "parent" },
  ] });
  if (req.url === "/api/v1/preview/mock-pip/classes") return send(200, { classes: [{ id: "cls-1", name: "Practice — Demo class", role: "student" }] });
  if (req.url === "/api/v1/preview/mock-pat/children") return send(200, { children: [{ id: "mock-pip", display_name: "Pip", relationship: "parent", classes: [{ id: "cls-1", name: "Practice — Demo class" }] }] });
  if (req.url === "/api/v1/preview/real-kid/classes") return send(403, { error: "Only practice people can be previewed." });
  send(404, { error: "no" });
});

let roster: typeof import("../src/lib/roster");
before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  process.env.SIGNIFY_ISSUER = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  roster = await import("../src/lib/roster");
});
after(() => server.close());

const T = { id: "teacher-1", role: "teacher" };

test("preview: asks Signify ID with the viewer's own token, about the mock only", async () => {
  const people = await roster.previewPeopleFor(T, "teacher-token");
  assert.deepEqual(people.people.map((p) => [p.id, p.kind]), [["mock-pip", "student"], ["mock-pat", "parent"]]);
  const cls = await roster.previewClassesOf(T, "teacher-token", "mock-pip");
  assert.deepEqual(cls, { ok: true, classes: [{ id: "cls-1", name: "Practice — Demo class", role: "student" }] });
  const kids = await roster.previewChildrenOf(T, "teacher-token", "mock-pat");
  assert.equal(kids.children[0].classes[0].role, "student", "a child's classes read as the child's");
  assert.ok(calls.every((c) => c.auth === "Bearer teacher-token"), "never any token but the viewer's");
});

test("preview: never cached, so every view is one audited question to Signify ID", async () => {
  calls.length = 0;
  await roster.previewClassesOf(T, "teacher-token", "mock-pip");
  await roster.previewClassesOf(T, "teacher-token", "mock-pip");
  assert.equal(calls.length, 2);
});

test("preview: a refusal or an outage is a failure, never an empty view", async () => {
  assert.deepEqual(await roster.previewClassesOf(T, "teacher-token", "real-kid"), { ok: false, classes: [] });
  assert.deepEqual(await roster.previewPeopleFor(T, "someone-else"), { ok: false, people: [] });
  down = true;
  assert.deepEqual(await roster.previewChildrenOf(T, "teacher-token", "mock-pat"), { ok: false, children: [] });
  down = false;
});

test("preview: local development previews the made-up student and parent, for staff only", async () => {
  assert.deepEqual((await roster.previewPeopleFor({ id: "t", role: "teacher", dev: true }, "")).people.map((p) => p.id), ["dev-student-0000", "dev-guardian-0000"]);
  assert.equal((await roster.previewPeopleFor({ id: "s", role: "student", dev: true }, "")).people.length, 0);
  assert.equal((await roster.previewClassesOf({ id: "t", dev: true }, "", "dev-student-0000")).classes.length, 2);
  assert.equal((await roster.previewChildrenOf({ id: "t", dev: true }, "", "dev-guardian-0000")).children.length, 1);
});

// The preview pages only read. Nothing under /preview may hold a form, a
// server action, the quiz taker, the writing box or a live join, and the old
// course-page ?preview= is gone.
function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}
const SRC = path.join(__dirname, "..", "src");

test("preview: the pages are read-only", () => {
  const pages = files(path.join(SRC, "app", "preview"));
  assert.ok(pages.length >= 7, "home, course, assignment, grades, week, family and the list");
  const shared = ["components/Preview.tsx", "components/StudentCourse.tsx", "components/Announcements.tsx", "lib/preview.ts"].map((f) => path.join(SRC, f));
  for (const f of [...pages, ...shared]) {
    const src = fs.readFileSync(f, "utf8");
    const rel = path.relative(SRC, f);
    assert.doesNotMatch(src, /["']use server["']/, `${rel}: no server actions`);
    assert.doesNotMatch(src, /QuizTaker|SubmissionEditor|useLive/, `${rel}: nothing that hands in or saves`);
    // The student's own course page shares StudentCourse; there the live join and calendar are switched off when previewing.
    if (rel.endsWith("StudentCourse.tsx")) assert.match(src, /const live = previewing \? null/);
    else assert.doesNotMatch(src, /\/live["`]/, `${rel}: no live join`);
    assert.doesNotMatch(src, /method:\s*["'](POST|PUT|PATCH|DELETE)/i, `${rel}: no writes`);
    if (!rel.endsWith("Announcements.tsx")) assert.doesNotMatch(src, /<form/, `${rel}: no forms`);
    assert.doesNotMatch(src, /\b(setGrade|saveDraft|setHandedIn|closeExpired|syncGrade|syncMyToolScore|passBack|startAttempt|INSERT|UPDATE)\b/, `${rel}: writes nothing`);
  }
  // A preview never asks Signify ID as anyone but the viewer: the token is always the signed-in person's.
  assert.match(fs.readFileSync(path.join(SRC, "lib", "preview.ts"), "utf8"), /await token\(\)/);
});

test("preview: the course page's ?preview= is gone", () => {
  const src = fs.readFileSync(path.join(SRC, "app", "courses", "[id]", "page.tsx"), "utf8");
  assert.doesNotMatch(src, /searchParams|name="preview"/);
  assert.match(src, /\/preview\/\$\{p\.id\}\/courses\//);
});
