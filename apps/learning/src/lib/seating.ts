/**
 * Seating charts on a lesson slide (teacher story 01, D4/D5/D6). Pure: no
 * database, no network, used by server and browser alike.
 *
 * The chart is Teacher's Desk's own (Desmond 2026-11-22: "the same charts as
 * Teacher's Desk", shared both ways). Learning never stores it: the server
 * asks Desk for the teacher's plan for this class each time (desk-seating.ts,
 * Desk's /api/learning/seating), already drawn by Desk's seating widget, so
 * the room here is exactly the card's. Moving a seat here moves it there.
 *
 * Who sees what:
 *  - the teacher: the chart with each seat's pupil id, the class with full
 *    and short names, and today's attendance marks (tap a seat = present);
 *  - students following live and the projector: `ShownChart` only — the room
 *    and the short names the chairs show, no ids and never attendance. The
 *    seating chart is the one slide that shows students their classmates'
 *    names, because that is what it is for (it is on the classroom wall).
 */

export type Rect = { x: number; y: number; w: number; h: number };
export type DeskSeat = Rect & { id: string; pupil: string | null };
export type DeskDesk = Rect & { id: string; surface: Rect | null; circle: { cx: number; cy: number; r: number } | null; seats: DeskSeat[] };
export type DeskObject = Rect & { id: string; shape: "rect" | "circle" | "strip"; label: string };
export type Front = "top" | "right" | "bottom" | "left";
/** Desk's drawn plan (server/learning.js chartOf), in room cells. */
export type DeskChart = {
  widgetId: string; rev: number; cols: number; rows: number; front: Front; flipped: boolean;
  desks: DeskDesk[]; objects: DeskObject[];
};
export type Pupil = { id: string; name: string; short: string };

export type ShownSeat = Rect & { label: string };
export type ShownChart = {
  cols: number; rows: number; front: Front;
  desks: (Rect & { surface: Rect | null; circle: { cx: number; cy: number; r: number } | null; seats: ShownSeat[] })[];
  objects: (Rect & { shape: DeskObject["shape"]; label: string })[];
};

export const SEATING_LIMITS = { desks: 80, seats: 12, objects: 40, label: 40, cells: 200 };
const FRONTS: Front[] = ["top", "right", "bottom", "left"];
const SHAPES: DeskObject["shape"][] = ["rect", "circle", "strip"];

const num = (v: unknown, lo = -SEATING_LIMITS.cells, hi = SEATING_LIMITS.cells): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0;
};
const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const obj = (v: unknown) => (v && typeof v === "object" ? v as Record<string, unknown> : {});
const rect = (v: unknown): Rect => { const o = obj(v); return { x: num(o.x), y: num(o.y), w: num(o.w, 0), h: num(o.h, 0) }; };
const circle = (v: unknown) => { if (!v || typeof v !== "object") return null; const o = obj(v); return { cx: num(o.cx), cy: num(o.cy), r: num(o.r, 0) }; };
const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);

/** Desk's answer, checked and capped: only numbers, short strings and the known shapes get through. */
export function cleanChart(input: unknown): DeskChart | null {
  if (!input || typeof input !== "object") return null;
  const c = obj(input);
  return {
    widgetId: str(c.widgetId, 40),
    rev: Math.max(0, Math.round(num(c.rev, 0, 1e9))),
    cols: num(c.cols, 1), rows: num(c.rows, 1),
    front: FRONTS.find((f) => f === c.front) ?? "top",
    flipped: c.flipped === true,
    desks: list(c.desks, SEATING_LIMITS.desks).map((d) => {
      const o = obj(d);
      return {
        id: str(o.id, 40), ...rect(o),
        surface: o.surface ? rect(o.surface) : null,
        circle: circle(o.circle),
        seats: list(o.seats, SEATING_LIMITS.seats).map((s) => {
          const so = obj(s);
          return { id: str(so.id, 60), ...rect(so), pupil: typeof so.pupil === "string" && so.pupil ? so.pupil.slice(0, 80) : null };
        }),
      };
    }),
    objects: list(c.objects, SEATING_LIMITS.objects).map((x) => {
      const o = obj(x);
      return { id: str(o.id, 40), shape: SHAPES.find((s) => s === o.shape) ?? "rect", ...rect(o), label: str(o.label, SEATING_LIMITS.label) };
    }),
  };
}

export function cleanPupils(input: unknown): Pupil[] {
  return list(input, 300).flatMap((p) => {
    const o = obj(p);
    const id = typeof o.id === "string" ? o.id.slice(0, 80) : "";
    if (!id) return [];
    const name = str(o.name, 200) || "?";
    return [{ id, name, short: str(o.short, SEATING_LIMITS.label) || name.split(" ")[0] }];
  });
}

/** What students and the projector see: the room and the chairs' short names. No ids, no marks. */
export function shownChart(chart: DeskChart, pupils: Pupil[]): ShownChart {
  const short = new Map(pupils.map((p) => [p.id, p.short]));
  return {
    cols: chart.cols, rows: chart.rows, front: chart.front,
    desks: chart.desks.map((d) => ({
      x: d.x, y: d.y, w: d.w, h: d.h, surface: d.surface, circle: d.circle,
      seats: d.seats.map((s) => ({ x: s.x, y: s.y, w: s.w, h: s.h, label: (s.pupil && short.get(s.pupil)) || "" })),
    })),
    objects: chart.objects.map((o) => ({ shape: o.shape, x: o.x, y: o.y, w: o.w, h: o.h, label: o.label })),
  };
}

/** The class members with no seat on this chart, in name order. */
export function unseated(chart: DeskChart, pupils: Pupil[]): Pupil[] {
  const seated = new Set(chart.desks.flatMap((d) => d.seats.map((s) => s.pupil).filter(Boolean)));
  return pupils.filter((p) => !seated.has(p.id)).sort((a, b) => a.name.localeCompare(b.name));
}

/** The seat a pupil sits in, or null. */
export function seatOf(chart: DeskChart, pupilId: string): string | null {
  for (const d of chart.desks) for (const s of d.seats) if (s.pupil === pupilId) return s.id;
  return null;
}
