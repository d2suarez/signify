import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { io as connect, type Socket } from "socket.io-client";
import { signTicket } from "../src/lib/live-ticket";

// live.js is the plain-JS server half; tsx loads it as CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const live = require("../live.js");

const SECRET = "test-secret";
let server: http.Server;
let url = "";
const sockets: Socket[] = [];

before(async () => {
  server = http.createServer();
  // The "cookie" in these tests is just the user id.
  live.attach(server, { secret: SECRET, whoIs: async (cookie: string) => (cookie ? { id: cookie } : null) });
  await new Promise<void>((r) => server.listen(0, r));
  url = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  for (const s of sockets) s.disconnect();
  await new Promise((r) => server.close(r));
});

function join(user: string, ticket: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connect(url, { path: "/live", auth: { ticket }, extraHeaders: { cookie: user }, transports: ["websocket"], reconnection: false });
    sockets.push(s);
    s.on("connect", () => resolve(s));
    s.on("connect_error", (e) => reject(e));
  });
}

function next<T>(s: Socket, event: string, until: (m: T) => boolean = () => true): Promise<T> {
  return new Promise((resolve) => {
    const on = (m: T) => { if (until(m)) { s.off(event, on); resolve(m); } };
    s.on(event, on);
  });
}

const ticket = (sub: string, role: "teacher" | "student", course = "course-1", lesson?: string) =>
  signTicket({ sub, name: sub, course, role, lesson }, SECRET);

test("tickets: a forged, tampered or expired ticket is refused", () => {
  const good = ticket("t1", "teacher");
  assert.equal(live.verifyTicket(good, SECRET).sub, "t1");
  assert.equal(live.verifyTicket(good, "other-secret"), null);
  const [body, sig] = good.split(".");
  const evil = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), role: "teacher", sub: "s1" })).toString("base64url");
  assert.equal(live.verifyTicket(`${evil}.${sig}`, SECRET), null);
  const old = Buffer.from(JSON.stringify({ sub: "t1", exp: Date.now() - 1 })).toString("base64url");
  const crypto = require("node:crypto");
  const oldSig = crypto.createHmac("sha256", SECRET).update(old).digest("base64url");
  assert.equal(live.verifyTicket(`${old}.${oldSig}`, SECRET), null);
  assert.equal(live.verifyTicket(undefined, SECRET), null);
});

test("sockets: a ticket only works for the person it was issued to", async () => {
  await assert.rejects(join("someone-else", ticket("s1", "student")), /not allowed/);
  await assert.rejects(join("s1", "garbage"), /not allowed/);
});

test("live: students follow the teacher; only the teacher sees who answered what", async () => {
  const teacher = await join("t1", ticket("t1", "teacher", "course-1", "lesson-1"));
  const student = await join("s1", ticket("s1", "student"));

  const started = next<{ live: boolean; index: number }>(student, "live:state", (m) => m.live);
  teacher.emit("live:start", { count: 3, version: 4, blockId: "b0" });
  assert.equal((await started).index, 0);

  const moved = next<{ index: number }>(student, "live:state", (m) => m.index === 1);
  teacher.emit("live:goto", { index: 1, blockId: "poll1" });
  await moved;

  const seen = next<{ answers: Record<string, string> }>(teacher, "live:teacher", (m) => !!m.answers?.s1);
  student.emit("live:answer", { blockId: "poll1", choiceId: "A" });
  assert.equal((await seen).answers.s1, "A");

  // Revealed: students get counts, never names or the per-student answers.
  const revealed = next<Record<string, unknown>>(student, "live:state", (m) => m.revealed === true);
  teacher.emit("live:reveal", { revealed: true });
  const st = await revealed;
  assert.deepEqual((st.tally as { counts: Record<string, number> }).counts, { A: 1 });
  assert.equal("answers" in st, false);
  assert.equal("students" in st, false);
});

test("live: a student cannot move the lesson, and a teacher cannot start a lesson their ticket doesn't name", async () => {
  const teacher = await join("t2", ticket("t2", "teacher", "course-2")); // no lesson on the ticket
  const student = await join("s2", ticket("s2", "student", "course-2"));
  teacher.emit("live:start", { count: 5 });
  student.emit("live:goto", { index: 3 });
  student.emit("live:start", { count: 9 });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(live.sessions.has("course-2"), false);
});

test("live: answers to a block that is not on screen are ignored", async () => {
  const teacher = await join("t3", ticket("t3", "teacher", "course-3", "lesson-3"));
  const student = await join("s3", ticket("s3", "student", "course-3"));
  const started = next(teacher, "live:teacher", (m: { live: boolean }) => m.live);
  teacher.emit("live:start", { count: 2, blockId: "x" });
  await started;
  student.emit("live:answer", { blockId: "not-x", choiceId: "A" });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(live.sessions.get("course-3").answers.size, 0);
});

test("picker: the class learns a name was picked, never whose; only that student is told", async () => {
  const teacher = await join("t4", ticket("t4", "teacher", "course-4", "lesson-4"));
  const picked = await join("s4", ticket("s4", "student", "course-4"));
  const other = await join("s5", ticket("s5", "student", "course-4"));
  const started = next(teacher, "live:teacher", (m: { live: boolean }) => m.live);
  teacher.emit("live:start", { count: 2, blockId: "pick" });
  await started;

  const toPicked = next<{ blockId: string; at: number }>(picked, "live:picked");
  let otherTold = false;
  other.on("live:picked", () => { otherTold = true; });
  const otherState = next<Record<string, unknown>>(other, "live:state", (m) => !!m.pick);
  const teacherSees = next<{ picked: string[]; lastPick: { studentId: string } | null }>(teacher, "live:teacher", (m) => m.picked?.length === 1);
  teacher.emit("live:pick", { blockId: "pick", studentId: "s4" });

  const you = await toPicked;
  const st = await otherState;
  assert.equal(you.blockId, "pick");
  assert.deepEqual(Object.keys(st.pick as object).sort(), ["at", "blockId"]);
  assert.equal(JSON.stringify(st).includes("s4"), false, "no student id in what the class receives");
  const t = await teacherSees;
  assert.deepEqual(t.picked, ["s4"]);
  assert.equal(t.lastPick?.studentId, "s4");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(otherTold, false);

  // A student can't pick, and turns can be started again by the teacher only.
  other.emit("live:pick", { blockId: "pick", studentId: "s5" });
  other.emit("live:pick-reset", { blockId: "pick" });
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual([...live.sessions.get("course-4").picks.get("pick")], ["s4"]);
  const cleared = next<{ picked: string[] }>(teacher, "live:teacher", (m) => m.picked?.length === 0);
  teacher.emit("live:pick-reset", { blockId: "pick" });
  await cleared;
});

test("noise: the teacher's level reaches students as a number 0-100, nothing else; students can't send one", async () => {
  const teacher = await join("t6", ticket("t6", "teacher", "course-6", "lesson-6"));
  const student = await join("s6", ticket("s6", "student", "course-6"));
  const started = next(teacher, "live:teacher", (m: { live: boolean }) => m.live);
  teacher.emit("live:start", { count: 1, blockId: "noise" });
  await started;

  const heard = next<{ level: number | null }>(student, "live:noise");
  teacher.emit("live:noise", { level: 250.7, audio: "secret" });
  assert.deepEqual(await heard, { level: 100 });

  student.emit("live:noise", { level: 3 });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(live.sessions.get("course-6").noise, 100);

  const off = next<{ level: number | null }>(student, "live:noise", (m) => m.level === null);
  teacher.emit("live:noise", { level: null });
  await off;
});

test("pacing: students look back only in review, move freely in self; answers only for blocks they may see", async () => {
  const C = "course-pace";
  const teacher = await join("tp", ticket("tp", "teacher", C, "lesson-p"));
  const student = await join("sp", ticket("sp", "student", C));
  const started = next<{ live: boolean; pace: string }>(student, "live:state", (m) => m.live);
  teacher.emit("live:start", { count: 4, version: 1, blockId: "p0", blockIds: ["p0", "p1", "p2", "p3"] });
  assert.equal((await started).pace, "teacher");
  teacher.emit("live:goto", { index: 1, blockId: "p1" });
  await next(student, "live:state", (m: { index: number }) => m.index === 1);

  // Follow me: no positions, an answer to an earlier poll is ignored.
  student.emit("live:at", { index: 0 });
  student.emit("live:answer", { blockId: "p0", choiceId: "A" });
  student.emit("live:answer", { blockId: "p1", choiceId: "B" });
  type TS = { index: number; pace: string; answers: Record<string, string>; positions: Record<string, number> };
  let ts = await next<TS>(teacher, "live:teacher", (m) => !!m.answers?.sp);
  assert.deepEqual(ts.positions, {});

  // Review: back is fine, ahead is held at the teacher's block.
  teacher.emit("live:pace", { pace: "review" });
  await next(student, "live:state", (m: { pace: string }) => m.pace === "review");
  student.emit("live:at", { index: 3 });
  ts = await next<TS>(teacher, "live:teacher", (m: { positions: Record<string, number> }) => m.positions?.sp === 1);
  student.emit("live:at", { index: 0 });
  await next(teacher, "live:teacher", (m: { positions: Record<string, number> }) => m.positions?.sp === 0);
  student.emit("live:answer", { blockId: "p3", choiceId: "X" }); // ahead: ignored
  student.emit("live:answer", { blockId: "p0", choiceId: "A" }); // behind: kept
  teacher.emit("live:goto", { index: 0, blockId: "p0" });
  ts = await next<TS>(teacher, "live:teacher", (m: { index: number; answers: Record<string, string> }) => m.index === 0);
  assert.equal(ts.answers.sp, "A");

  // Own pace: anywhere in the lesson.
  teacher.emit("live:pace", { pace: "self" });
  student.emit("live:at", { index: 3 });
  await next(teacher, "live:teacher", (m: { positions: Record<string, number> }) => m.positions?.sp === 3);
  student.emit("live:answer", { blockId: "p3", choiceId: "C" });
  teacher.emit("live:goto", { index: 3, blockId: "p3" });
  ts = await next<TS>(teacher, "live:teacher", (m: { index: number; answers: Record<string, string> }) => m.index === 3 && !!m.answers.sp);
  assert.equal(ts.answers.sp, "C");

  // Students can't change the pace; an unknown pace is ignored.
  student.emit("live:pace", { pace: "teacher" });
  teacher.emit("live:pace", { pace: "chaos" });
  teacher.emit("live:pace", { pace: "teacher" });
  ts = await next<TS>(teacher, "live:teacher", (m: { pace: string }) => m.pace === "teacher");
  assert.deepEqual(ts.positions, {});
  teacher.emit("live:end");
});
