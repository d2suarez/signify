"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dict } from "@/lib/i18n";
import { type DeskChart, type Pupil, type ShownChart, seatOf, shownChart, unseated } from "@/lib/seating";
import SeatingView, { type ViewSeat } from "./SeatingView";

type Status = "present" | "absent" | "tardy" | "excused";
type Data = {
  ok: boolean; reason: string | null; chart: DeskChart | null; pupils: Pupil[];
  marks: Record<string, Status>; day: string; schoolDay: boolean; deskUrl: string;
};

/**
 * The seating slide on the teacher's screen (story 01, D5/D6): their own
 * chart from Teacher's Desk for this class, with today's attendance. Tap a
 * seat: present; tap again: not marked (the same records as the Attendance
 * tab). "Change seats": tap a student, then a seat; saved on their desk.
 * Every time the chart is drawn, `onShown` hands the room and the chairs'
 * names (no ids, no marks) to the live lesson for students' screens.
 */
export default function SeatingDesk({ courseId, title, onShown, d }: {
  courseId: string; title: string; onShown?: (c: ShownChart | null) => void; d: Dict;
}) {
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState(false);
  const [moving, setMoving] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shownRef = useRef(onShown);
  shownRef.current = onShown;

  const load = useCallback(async () => {
    setFailed(false);
    const r = await fetch(`/api/courses/${courseId}/seating`, { cache: "no-store" }).catch(() => null);
    const body = r && (r.ok || r.status === 409 || r.status === 502) ? await r.json().catch(() => null) : null;
    if (!body) { setFailed(true); return; }
    setData(body);
  }, [courseId]);
  useEffect(() => { load(); }, [load]);

  const chart = data?.chart ?? null;
  const pupils = useMemo(() => data?.pupils ?? [], [data]);
  const byId = useMemo(() => new Map(pupils.map((p) => [p.id, p])), [pupils]);
  useEffect(() => { shownRef.current?.(chart ? shownChart(chart, pupils) : null); }, [chart, pupils]);

  const marks = data?.marks ?? {};
  const present = pupils.filter((p) => marks[p.id] === "present").length;
  const canMark = !!data?.schoolDay;

  const mark = async (pupil: string) => {
    if (!data || !canMark) return;
    const next = marks[pupil] === "present" ? null : "present";
    const shown: Record<string, Status> = { ...marks };
    if (next) shown[pupil] = next; else delete shown[pupil];
    setData({ ...data, marks: shown });
    const r = await fetch(`/api/courses/${courseId}/seating/attendance`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ studentId: pupil, status: next }),
    }).catch(() => null);
    const body = r?.ok ? await r.json().catch(() => null) : null;
    if (body?.marks) setData((dd) => (dd ? { ...dd, marks: body.marks } : dd));
    else { setNote(d.seatSaveFailed); load(); }
  };

  const restAbsent = async () => {
    if (!data || !canMark || busy) return;
    setBusy(true);
    const r = await fetch(`/api/courses/${courseId}/seating/attendance`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rest: "absent" }),
    }).catch(() => null);
    const body = r?.ok ? await r.json().catch(() => null) : null;
    setBusy(false);
    if (body?.marks) setData((dd) => (dd ? { ...dd, marks: body.marks } : dd)); else setNote(d.seatSaveFailed);
  };

  const move = async (pupil: string, seat: string | null) => {
    if (!chart || busy) return;
    setBusy(true);
    setNote(null);
    const r = await fetch(`/api/courses/${courseId}/seating`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ widgetId: chart.widgetId, rev: chart.rev, pupil, seat }),
    }).catch(() => null);
    const body = r ? await r.json().catch(() => null) : null;
    setBusy(false);
    setPicked(null);
    if (body?.chart !== undefined) setData(body);
    if (!r?.ok) setNote(r?.status === 409 ? d.seatStale : d.seatSaveFailed);
  };

  const onSeat = (key: string) => {
    if (!chart) return;
    const [di, si] = key.split(":").map(Number);
    const seat = chart.desks[di]?.seats[si];
    if (!seat) return;
    if (!moving) { if (seat.pupil) mark(seat.pupil); return; }
    if (picked) {
      if (picked === seat.pupil) { setPicked(null); return; }
      move(picked, seat.id);
    } else if (seat.pupil) setPicked(seat.pupil);
  };

  const word = (s: Status | undefined) => (s === "present" ? d.seatMarkPresent : s === "absent" ? d.attAbsent : s === "tardy" ? d.attTardy : s === "excused" ? d.attExcused : d.seatNotMarked);

  if (!data) {
    return (
      <div className="stage stage-center" style={{ background: "var(--p2)" }}>
        <p className="stage-foot" role="status">{failed ? d.seatDeskDown : d.seatLoading}</p>
        {failed && <button type="button" className="btn" onClick={load}>{d.seatRetry}</button>}
      </div>
    );
  }

  const deskLink = <a className="btn btn-sm" href={data.deskUrl} target="_blank" rel="noopener">{d.seatOpenDesk}</a>;
  if (!chart) {
    const why = !data.ok ? (data.reason === "denied" ? d.seatDenied : data.reason === "signin" ? d.seatSignin : d.seatDeskDown) : d.seatNone;
    return (
      <div className="stage stage-center" style={{ background: "var(--p2)" }}>
        <span className="stage-kicker">{title || d.blockSeating}</span>
        <h1 style={{ fontSize: "clamp(20px, 2.6vw, 34px)" }}>{why}</h1>
        {data.ok && <p className="stage-foot">{d.seatNoneHint}</p>}
        <div className="row" style={{ justifyContent: "center" }}>
          {deskLink}
          <button type="button" className="btn btn-sm" onClick={load}>{d.seatRetry}</button>
        </div>
      </div>
    );
  }

  const shown = shownChart(chart, pupils);
  const info = (di: number, si: number): ViewSeat => {
    const seat = chart.desks[di].seats[si];
    const p = seat.pupil ? byId.get(seat.pupil) : undefined;
    return { key: `${di}:${si}`, label: p?.short ?? "", full: p?.name, mark: p && !moving ? marks[p.id] ?? null : null, picked: !!p && picked === p.id };
  };
  const pickedPupil = picked ? byId.get(picked) : undefined;
  const loose = unseated(chart, pupils);

  return (
    <div className="stack" style={{ gap: 10 }}>
    <div className="stage stage-seating" style={{ background: "var(--p2)" }}>
      <div className="row" style={{ gap: 8 }}>
        <span className="shape s-square" style={{ background: "#fff" }} />
        <span className="stage-kicker">{title || d.blockSeating}</span>
        <span style={{ flex: 1 }} />
        {!moving && canMark && <b className="seat-count" aria-live="polite">{d.seatPresentCount.replace("{n}", String(present)).replace("{m}", String(pupils.length))}</b>}
      </div>
      <SeatingView chart={shown} seatInfo={info} onSeat={onSeat} seatWord={(s) => (moving ? (s.picked ? d.seatPicked.replace("{name}", s.full ?? "") : "") : word(s.mark ?? undefined))} d={d} />
      {moving && (
        <div className="seat-tray">
          <p className="stage-foot" role="status">{pickedPupil ? d.seatPicked.replace("{name}", pickedPupil.name) : d.seatMoveHint}</p>
          {pickedPupil && seatOf(chart, pickedPupil.id) && (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => move(pickedPupil.id, null)}>{d.seatUnseat}</button>
          )}
          {loose.length > 0 && (
            <div className="row" style={{ gap: 6 }}>
              <span className="stage-foot">{d.seatUnseated}:</span>
              {loose.map((p) => (
                <button key={p.id} type="button" className={`btn btn-sm${picked === p.id ? " btn-dark" : ""}`} aria-pressed={picked === p.id}
                  onClick={() => setPicked(picked === p.id ? null : p.id)}>{p.name}</button>
              ))}
            </div>
          )}
        </div>
      )}
      {note && <p className="stage-foot" role="status">{note}</p>}
      <div className="row seat-tools">
        {!moving && (canMark
          ? <>
              <span className="stage-foot seat-hint">{d.seatTapHint}</span>
              <span style={{ flex: 1 }} />
              <button type="button" className="btn btn-sm" disabled={busy || present === pupils.length} onClick={restAbsent}>{d.seatRestAbsent}</button>
              <a className="btn btn-sm" href={`/courses/${courseId}/attendance`} target="_blank" rel="noopener">{d.seatAttTab}</a>
            </>
          : <span className="stage-foot">{d.seatNotSchoolDay}</span>)}
        {moving && <span style={{ flex: 1 }} />}
        <button type="button" className="btn btn-sm" aria-pressed={moving} onClick={() => { setMoving(!moving); setPicked(null); setNote(null); }}>
          {moving ? d.seatMoveDone : d.seatMove}
        </button>
        {deskLink}
      </div>
    </div>
      {!moving && canMark && (
        // The same marks as a list: big targets on a phone, and for keyboards and screen readers.
        <details className="seat-list">
          <summary>{d.seatListTitle}</summary>
          <ul>
            {[...pupils].sort((a, b) => a.name.localeCompare(b.name)).map((p) => (
              <li key={p.id}>
                <button type="button" className={`btn btn-sm${marks[p.id] === "present" ? " is-present" : ""}`} aria-pressed={marks[p.id] === "present"} onClick={() => mark(p.id)}>
                  <span aria-hidden="true">{marks[p.id] === "present" ? "✓" : "○"}</span> {p.name}
                  <span className="seat-list-word">{word(marks[p.id])}</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
