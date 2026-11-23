import "server-only";
import { DESK_ORIGIN } from "./desk";
import { cleanChart, cleanPupils, type DeskChart, type Pupil } from "./seating";

/**
 * Asks Teacher's Desk for the teacher's seating plan for one class, and moves
 * a seat on it (teacher story 01, D5; see seating.ts). Server to server, with
 * the Signify ID token Learning holds for this teacher: Desk checks it was
 * minted for Learning, asks Signify ID whether they teach the class, and only
 * ever reads or changes their own desk (apps/desk/server/learning.js).
 * Nothing is kept here.
 *
 * Locally (the made-up teacher has no token) a made-up chart stands in, in
 * memory, so the slide can be tried without Desk or Signify ID.
 */

export type SeatingAnswer =
  | { ok: true; chart: DeskChart | null; pupils: Pupil[] }
  | { ok: false; reason: "desk" | "denied" | "signin" | "stale" | "bad"; chart?: DeskChart | null; pupils?: Pupil[] };

type Who = { dev: boolean };
export type Move = { widgetId: string; rev: number; pupil: string; seat: string | null };

async function ask(token: string, idClassId: string, init?: { method: "PUT"; body: string }): Promise<SeatingAnswer> {
  if (!token) return { ok: false, reason: "signin" };
  let res: Response;
  try {
    res = await fetch(`${DESK_ORIGIN}/api/learning/seating/${encodeURIComponent(idClassId)}`, {
      method: init?.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, ...(init ? { "content-type": "application/json" } : {}) },
      body: init?.body,
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    console.warn("learning: Teacher's Desk unreachable —", (e as Error).message);
    return { ok: false, reason: "desk" };
  }
  const body = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (res.ok && body) return { ok: true, chart: cleanChart(body.chart), pupils: cleanPupils(body.pupils) };
  if (res.status === 409 && body) return { ok: false, reason: "stale", chart: cleanChart(body.chart), pupils: cleanPupils(body.pupils) };
  console.warn(`learning: Teacher's Desk seating refused (${res.status})`, body && body.error);
  if (res.status === 401) return { ok: false, reason: "signin" };
  if (res.status === 403) return { ok: false, reason: "denied" };
  if (res.status === 400 || res.status === 404) return { ok: false, reason: "bad" };
  return { ok: false, reason: "desk" };
}

export async function deskSeating(who: Who, token: string, idClassId: string): Promise<SeatingAnswer> {
  if (who.dev) return devSeating(idClassId);
  return ask(token, idClassId);
}

export async function moveDeskSeat(who: Who, token: string, idClassId: string, move: Move): Promise<SeatingAnswer> {
  if (who.dev) return devMove(idClassId, move);
  return ask(token, idClassId, { method: "PUT", body: JSON.stringify(move) });
}

// ---------------- local development ----------------

const DEV_PUPILS: Pupil[] = [
  { id: "dev-student-0000", name: "Dev Student", short: "Dev" },
  { id: "dev-student-0001", name: "Sample Student A", short: "Sample A." },
  { id: "dev-student-0002", name: "Sample Student B", short: "Sample B." },
];
/** Rows of pairs facing the board, drawn as Desk's widget draws a 2-seat row (8×5 cells). */
function devChart(): DeskChart {
  const pair = (id: string, x: number, y: number, a: string | null, b: string | null) => ({
    id, x, y, w: 8, h: 5, surface: { x: 0, y: 0, w: 8, h: 2 }, circle: null,
    seats: [{ id: `${id}#0`, x: 0, y: 2, w: 4, h: 3, pupil: a }, { id: `${id}#1`, x: 4, y: 2, w: 4, h: 3, pupil: b }],
  });
  return {
    widgetId: "wdev", rev: 1, cols: 34, rows: 23, front: "top", flipped: false,
    desks: [pair("d1", 3, 6, "dev-student-0000", "dev-student-0001"), pair("d2", 13, 6, null, null), pair("d3", 23, 6, "dev-student-0002", null),
      pair("d4", 3, 14, null, null), pair("d5", 13, 14, null, null), pair("d6", 23, 14, null, null)],
    objects: [{ id: "o1", shape: "strip", x: 11, y: 0, w: 12, h: 2, label: "Board" }, { id: "o2", shape: "rect", x: 26, y: 1, w: 7, h: 4, label: "Teacher" }],
  };
}
const devCharts = ((globalThis as unknown as { __learningDevSeating?: Map<string, DeskChart> }).__learningDevSeating ??= new Map());
function devSeating(idClassId: string): SeatingAnswer {
  if (!devCharts.has(idClassId)) devCharts.set(idClassId, devChart());
  return { ok: true, chart: structuredClone(devCharts.get(idClassId)!), pupils: DEV_PUPILS };
}
function devMove(idClassId: string, m: Move): SeatingAnswer {
  const now = devSeating(idClassId);
  const chart = now.ok ? now.chart! : devChart();
  if (m.rev !== chart.rev) return { ok: false, reason: "stale", chart, pupils: DEV_PUPILS };
  if (!DEV_PUPILS.some((p) => p.id === m.pupil)) return { ok: false, reason: "bad" };
  const seats = chart.desks.flatMap((d) => d.seats);
  const from = seats.find((s) => s.pupil === m.pupil) ?? null;
  const to = m.seat === null ? null : seats.find((s) => s.id === m.seat);
  if (m.seat !== null && !to) return { ok: false, reason: "bad" };
  // As tapping a name then a seat does on the desk: swap seat to seat, else whoever sat there is unseated.
  if (!to) { if (from) from.pupil = null; }
  else if (from !== to) { const displaced = to.pupil; if (from) from.pupil = displaced; to.pupil = m.pupil; }
  chart.rev += 1;
  devCharts.set(idClassId, chart);
  return { ok: true, chart: structuredClone(chart), pupils: DEV_PUPILS };
}
