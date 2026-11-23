"use client";

import type { ShownChart } from "@/lib/seating";
import type { Dict } from "@/lib/i18n";

/** One seat as drawn: what the chair says, and, on the teacher's screen only, a mark and a tap. */
export type ViewSeat = { label: string; full?: string; mark?: "present" | "absent" | "tardy" | "excused" | null; picked?: boolean; key?: string };
const GLYPH = { present: "✓", absent: "✕", tardy: "◷", excused: "E" } as const;

/**
 * A seating chart drawn as Teacher's Desk draws it (seating.ts): desks,
 * chairs and furniture placed in room cells, scaled to the space it has.
 * Students and the projector get only `chart`; the teacher's screen passes
 * `seatInfo` (names, marks) and `onSeat`.
 */
export default function SeatingView({ chart, seatInfo, onSeat, seatWord, d }: {
  chart: ShownChart;
  /** The teacher's view of each seat, by desk and seat index. */
  seatInfo?: (desk: number, seat: number) => ViewSeat;
  onSeat?: (key: string) => void;
  /** What a seat's mark is called, for screen readers (the teacher's screen). */
  seatWord?: (s: ViewSeat) => string;
  d: Dict;
}) {
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  const box = (r: { x: number; y: number; w: number; h: number }, cols: number, rows: number) =>
    ({ left: pct(r.x, cols), top: pct(r.y, rows), width: pct(r.w, cols), height: pct(r.h, rows) });
  return (
    <div className="seat-wrap">
      <div className={`seat-room front-${chart.front}`} role="group" aria-label={d.seatChartLabel}
        style={{ ["--ratio" as string]: String(chart.cols / Math.max(1, chart.rows)) }}>
        <span className="seat-front" aria-hidden="true">{d.seatFront}</span>
        {chart.objects.map((o, i) => (
          <div key={`o${i}`} className={`seat-object seat-object-${o.shape}`} style={box(o, chart.cols, chart.rows)} aria-hidden="true">
            <span>{o.label}</span>
          </div>
        ))}
        {chart.desks.map((desk, di) => (
          <div key={`d${di}`} className="seat-desk" style={box(desk, chart.cols, chart.rows)}>
            {desk.surface && <div className="seat-surface" style={box(desk.surface, desk.w, desk.h)} aria-hidden="true" />}
            {desk.circle && (
              <div className="seat-surface seat-surface-round" aria-hidden="true" style={box(
                { x: desk.circle.cx - desk.circle.r, y: desk.circle.cy - desk.circle.r, w: desk.circle.r * 2, h: desk.circle.r * 2 }, desk.w, desk.h)} />
            )}
            {desk.seats.map((seat, si) => {
              const info = seatInfo ? seatInfo(di, si) : { label: seat.label };
              const cls = `seat${info.label ? " is-taken" : ""}${info.mark ? ` is-${info.mark}` : ""}${info.picked ? " is-picked" : ""}`;
              const inner = (
                <>
                  {info.mark && <b className="seat-mark" aria-hidden="true">{GLYPH[info.mark]}</b>}
                  <span className="seat-name">{info.label}</span>
                </>
              );
              const style = box(seat, desk.w, desk.h);
              if (onSeat && info.key) {
                return (
                  <button key={si} type="button" className={cls} style={style} onClick={() => onSeat(info.key!)} aria-pressed={info.picked || info.mark === "present"}
                    aria-label={info.label ? [info.full || info.label, seatWord?.(info)].filter(Boolean).join(", ") : d.seatEmpty} title={info.full || undefined}>
                    {inner}
                  </button>
                );
              }
              return <div key={si} className={cls} style={style} title={info.full || undefined}>{inner}</div>;
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
