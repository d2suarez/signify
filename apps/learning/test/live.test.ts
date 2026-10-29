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
