import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { io as connect, type Socket } from "socket.io-client";
import { normalizeBlocks, newBlock, forStudent } from "../src/lib/blocks";
import { cleanChart, cleanPupils, shownChart, unseated, seatOf, type DeskChart } from "../src/lib/seating";
import { signTicket } from "../src/lib/live-ticket";
import { openPglite, migrate, useDb, type Db } from "../src/lib/db";
import { myCourses } from "../src/lib/courses";
import { classDay, clearMark, takeAttendance } from "../src/lib/attendance";

// The seating chart slide (teacher story 01, D4/D5/D6): Teacher's Desk's own
// chart for the class, attendance by tapping seats, students see the room
// and chairs' names only.

// desk-seating.ts is server-only; outside Next that marker throws, so stand it down here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
require.cache[require.resolve("server-only")] = { exports: {} } as NodeJS.Module;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { deskSeating, moveDeskSeat } = require("../src/lib/desk-seating") as typeof import("../src/lib/desk-seating");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const live = require("../live.js");

const desk = (over: Partial<DeskChart> = {}): unknown => ({
  widgetId: "wS", rev: 4, cols: 34, rows: 23, front: "top", flipped: false,
  desks: [{ id: "dA", x: 3, y: 6, w: 8, h: 5, surface: { x: 0, y: 0, w: 8, h: 2 }, circle: null,
    seats: [{ id: "dA#0", x: 0, y: 2, w: 4, h: 3, pupil: "p1" }, { id: "dA#1", x: 4, y: 2, w: 4, h: 3, pupil: null }] }],
  objects: [{ id: "o1", shape: "strip", x: 11, y: 0, w: 12, h: 2, label: "Board" }],
  ...over,
});
const pupils = [{ id: "p1", name: "Ana Ruiz", short: "Ana" }, { id: "p2", name: "Ben Ode", short: "Ben" }];

test("seating block: one title, nothing else kept; students get it as is", () => {
  const [b] = normalizeBlocks([{ type: "seating", title: "  Seats  ", widgetId: "x", chart: { evil: 1 } }]);
  assert.deepEqual({ ...b, id: "" }, { id: "", type: "seating", title: "Seats" });
  assert.equal(newBlock("seating").type, "seating");
  assert.deepEqual(forStudent(b), b);
});

test("seating: Desk's answer is checked, and students' copy has no ids and no one unseated", () => {
  const c = cleanChart(desk({ front: "sideways" as never, objects: [{ id: "o", shape: "<script>" as never, x: 1e9, y: 0, w: 2, h: 2, label: "x".repeat(99) }] }))!;
  assert.equal(c.front, "top");
  assert.equal(c.objects[0].shape, "rect");
  assert.equal(c.objects[0].x, 200, "numbers are capped");
  assert.equal(c.objects[0].label.length, 40);
  assert.equal(cleanChart(null), null);
  const shown = shownChart(cleanChart(desk())!, pupils);
  assert.deepEqual(shown.desks[0].seats.map((s) => s.label), ["Ana", ""]);
  const json = JSON.stringify(shown);
  assert.ok(!json.includes("p1") && !json.includes("dA") && !json.includes("wS"), "no pupil, seat or card ids reach students");
  assert.ok(!json.includes("Ruiz"), "only the chair's short name");
  assert.deepEqual(unseated(cleanChart(desk())!, pupils).map((p) => p.id), ["p2"]);
  assert.equal(seatOf(cleanChart(desk())!, "p1"), "dA#0");
  assert.deepEqual(cleanPupils([{ id: "p1", name: "Ana Ruiz" }, { name: "no id" }]), [{ id: "p1", name: "Ana Ruiz", short: "Ana" }]);
});

test("seating: Learning asks Desk server to server with the teacher's token, and says why when it can't", async () => {
  const real = global.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  let answer: { status: number; body: unknown } = { status: 200, body: { chart: desk(), pupils } };
  global.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;
  try {
    const r = await deskSeating({ dev: false }, "tok-1", "class 1");
    assert.ok(r.ok && r.chart && r.chart.desks.length === 1);
    assert.match(calls[0].url, /\/api\/learning\/seating\/class%201$/);
    assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer tok-1");
    assert.equal((await deskSeating({ dev: false }, "", "c1")).ok, false, "no token, no question");
    assert.equal(calls.length, 1);
    answer = { status: 403, body: { error: "no" } };
    assert.deepEqual(await deskSeating({ dev: false }, "t", "c1"), { ok: false, reason: "denied" });
    answer = { status: 502, body: { error: "ID down" } };
    assert.deepEqual(await deskSeating({ dev: false }, "t", "c1"), { ok: false, reason: "desk" });
    answer = { status: 409, body: { chart: desk({ rev: 9 }), pupils } };
    const stale = await moveDeskSeat({ dev: false }, "t", "c1", { widgetId: "wS", rev: 4, pupil: "p2", seat: "dA#1" });
    assert.equal(stale.ok, false);
    assert.equal(!stale.ok && stale.reason, "stale");
    assert.equal(stale.chart?.rev, 9, "with the latest chart to show");
    assert.equal(calls.at(-1)!.init.method, "PUT");
    assert.deepEqual(JSON.parse(String(calls.at(-1)!.init.body)), { widgetId: "wS", rev: 4, pupil: "p2", seat: "dA#1" });
  } finally { global.fetch = real; }
});

test("seating: the local made-up chart moves seats as the desk does", async () => {
  const a = await deskSeating({ dev: true }, "", "dev-test-class");
  assert.ok(a.ok && a.chart);
  const rev = a.chart!.rev;
  // Sample B (seated alone at d3) into d1#1, where Sample A sits: seat to seat swaps.
  const b = await moveDeskSeat({ dev: true }, "", "dev-test-class", { widgetId: "wdev", rev, pupil: "dev-student-0002", seat: "d1#1" });
  assert.ok(b.ok);
  assert.equal(seatOf(b.chart!, "dev-student-0002"), "d1#1");
  assert.equal(seatOf(b.chart!, "dev-student-0001"), "d3#0");
  const stale = await moveDeskSeat({ dev: true }, "", "dev-test-class", { widgetId: "wdev", rev, pupil: "dev-student-0002", seat: "d2#0" });
  assert.equal(!stale.ok && stale.reason, "stale");
  const out = await moveDeskSeat({ dev: true }, "", "dev-test-class", { widgetId: "wdev", rev: rev + 1, pupil: "dev-student-0002", seat: null });
  assert.equal(seatOf(out.chart!, "dev-student-0002"), null);
});

// ---------- attendance from the seats ----------
let db: Db;
before(async () => {
  db = await openPglite("memory://");
  await migrate(db, path.join(__dirname, "..", "migrations"));
  useDb(db);
});

test("seating attendance: a tap is the Attendance tab's record; a second tap takes it back", async () => {
  const T = { tenantId: "school-a", userId: "t1" };
  const [course] = await myCourses("school-a", [{ id: "s-1", name: "Bible 9", role: "teacher" }], "t1");
  const MON = "2026-11-23";
  const roster = new Map([["p1", "Ana Ruiz"], ["p2", "Ben Ode"]]);
  await takeAttendance(T, course.id, MON, MON, [{ studentId: "p1", status: "present" }], roster);
  assert.equal((await classDay(T, course.id, MON)).get("p1")?.status, "present");
  await clearMark(T, course.id, MON, MON, "p1");
  assert.equal((await classDay(T, course.id, MON)).size, 0);
  await takeAttendance(T, course.id, MON, MON, [{ studentId: "p2", status: "absent" }], roster);
  await clearMark({ tenantId: "school-b", userId: "x" }, course.id, MON, MON, "p2");
  assert.equal((await classDay(T, course.id, MON)).get("p2")?.status, "absent", "another school can't take a mark back");
  await assert.rejects(clearMark(T, course.id, "2026-11-21", MON, "p2"), "never on a Sabbath");
});

// ---------- the live lesson ----------
const SECRET = "seat-secret";
let server: http.Server;
let url = "";
const sockets: Socket[] = [];
before(async () => {
  server = http.createServer();
  live.attach(server, { secret: SECRET, whoIs: async (cookie: string) => (cookie ? { id: cookie } : null) });
  await new Promise<void>((r) => server.listen(0, r));
  url = `http://localhost:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  for (const s of sockets) s.disconnect();
  await new Promise((r) => server.close(r));
  await db.close();
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

test("seating live: students get the room and labels the teacher's screen sends, cleaned; never from a student", async () => {
  const C = "course-seat";
  const teacher = await join("ts", signTicket({ sub: "ts", name: "T", course: C, role: "teacher", lesson: "lesson-s" }, SECRET));
  const student = await join("ss", signTicket({ sub: "ss", name: "S", course: C, role: "student" }, SECRET));
  const started = next<{ live: boolean }>(student, "live:state", (m) => m.live);
  teacher.emit("live:start", { count: 1, blockId: "seat1", blockIds: ["seat1"] });
  await started;
  type St = { seating: { blockId: string; chart: { desks: { seats: Record<string, unknown>[] }[]; objects: Record<string, unknown>[] } } | null };
  const got = next<St>(student, "live:state", (m) => !!m.seating);
  const chart = shownChart(cleanChart(desk())!, pupils) as unknown as Record<string, unknown>;
  teacher.emit("live:seating", { blockId: "seat1", chart: { ...chart, marks: { p1: "present" }, desks: [{ ...(chart.desks as object[])[0], seats: [{ x: 0, y: 2, w: 4, h: 3, label: "Ana", pupil: "p1", mark: "present" }] }] } });
  const m = await got;
  assert.equal(m.seating!.blockId, "seat1");
  assert.deepEqual(m.seating!.chart.desks[0].seats[0], { x: 0, y: 2, w: 4, h: 3, label: "Ana" }, "no id or mark gets through");
  assert.ok(!JSON.stringify(m).includes("present"));
  assert.ok(!JSON.stringify(m).includes("p1"));

  student.emit("live:seating", { blockId: "seat1", chart: { cols: 1, rows: 1, desks: [], objects: [] } });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(live.sessions.get(C).seating.chart.desks.length, 1, "a student can't change it");

  // The teacher's laptop reconnects: the chart is still there for late joiners.
  teacher.emit("live:start", { count: 1, blockId: "seat1", blockIds: ["seat1"] });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(live.sessions.get(C).seating.blockId, "seat1");
});
