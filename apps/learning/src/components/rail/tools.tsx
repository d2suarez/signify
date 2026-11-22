"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { Dict } from "@/lib/i18n";
import { choose, turnsLeft, type Person } from "@/lib/picker";
import { noiseColour, noiseWord } from "@/lib/noise";
import { EMPTY_SEATING, fillSeats, makeGroups, normalizeSeating, type Seating } from "@/lib/widgets";
import { useNoiseMeter } from "../useNoiseMeter";

/**
 * The rail's tools, rebuilt from Teacher's Desk's widgets (self-contained,
 * as the lesson blocks were). Each gets `big` when shown large (the same
 * component, so a running timer keeps running). The roster tools (picker,
 * groups, seating) are for a class's teachers only: the roster comes from
 * /api/courses/<id>/roster, which refuses anyone else.
 */

export type ToolProps = { d: Dict; lang: string; big: boolean; courseId: string | null };

const store = {
  get<T>(k: string, kind: "local" | "session" = "local"): T | null {
    try { const v = (kind === "local" ? localStorage : sessionStorage).getItem(k); return v ? (JSON.parse(v) as T) : null; } catch { return null; }
  },
  set(k: string, v: unknown, kind: "local" | "session" = "local") {
    try { (kind === "local" ? localStorage : sessionStorage).setItem(k, JSON.stringify(v)); } catch { /* private mode: this page only */ }
  },
};

// ---------- clock ----------

export function ClockTool({ d, lang, big }: ToolProps) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const loc = lang === "es" ? "es" : "en-US";
  return (
    <div className={`wg-clock ${big ? "is-big" : ""}`}>
      <time className="wg-clock-time" dateTime={now?.toISOString()} suppressHydrationWarning>
        {now ? now.toLocaleTimeString(loc, { hour: "numeric", minute: "2-digit" }) : " "}
      </time>
      <span className="wg-clock-date muted" suppressHydrationWarning>
        {now ? now.toLocaleDateString(loc, { weekday: "long", month: "long", day: "numeric" }) : " "}
      </span>
      <span className="sr-only">{d.wg_clock}</span>
    </div>
  );
}

// ---------- timer ----------

type TimerState = { durationMs: number; endsAt: number | null; remainingMs: number; sound: boolean };
const TIMER_KEY = "sl-wg-timer";
const PRESETS = [1, 2, 5, 10, 15];

function fmt(ms: number) {
  const s = Math.ceil(Math.abs(ms) / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const mm = h ? String(m % 60).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(s % 60).padStart(2, "0")}`;
}

function beep() {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.9);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 1);
    o.onended = () => ctx.close().catch(() => {});
  } catch { /* no sound on this device */ }
}

export function TimerTool({ d, big }: ToolProps) {
  const id = useId();
  // Keeps an end time, not a number it counts down, so it survives moving
  // between pages, a reload and a sleeping laptop (as Desk's timer does).
  const [s, setS] = useState<TimerState>({ durationMs: 5 * 60_000, endsAt: null, remainingMs: 5 * 60_000, sound: true });
  const [now, setNow] = useState(() => Date.now());
  const [minutes, setMinutes] = useState("5");
  const rang = useRef(false);
  useEffect(() => {
    const saved = store.get<TimerState>(TIMER_KEY);
    if (saved && typeof saved.durationMs === "number") { setS(saved); setMinutes(String(Math.round(saved.durationMs / 60_000) || 1)); rang.current = !!saved.endsAt && saved.endsAt < Date.now(); }
  }, []);
  const save = (next: TimerState) => { setS(next); store.set(TIMER_KEY, next); };
  useEffect(() => {
    if (!s.endsAt) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [s.endsAt]);
  const left = s.endsAt ? s.endsAt - now : s.remainingMs;
  const over = left <= 0 && (s.endsAt !== null || s.remainingMs <= 0);
  useEffect(() => {
    if (s.endsAt && left <= 0 && !rang.current) { rang.current = true; if (s.sound) beep(); }
  }, [left, s.endsAt, s.sound]);
  const startFor = (ms: number) => { rang.current = false; setNow(Date.now()); save({ ...s, durationMs: ms, remainingMs: ms, endsAt: Date.now() + ms }); };
  const typed = Math.min(600, Math.max(0, Number(minutes.replace(",", "."))));
  return (
    <div className={`wg-timer ${big ? "is-big" : ""} ${over ? "is-over" : ""}`}>
      <div className="wg-timer-face" role="timer" aria-live="off">
        <span className="wg-timer-time">{over ? `+${fmt(left)}` : fmt(left)}</span>
        <span className="wg-timer-word">{over ? <strong>{left < -1000 ? `${d.wgTimeUp} · ${d.wgOverBy} ${fmt(left)}` : d.wgTimeUp}</strong> : s.endsAt ? d.wgLeft : d.wgPaused}</span>
      </div>
      {/* Said once when time runs out, not every second. */}
      <span className="sr-only" aria-live="assertive">{over && s.endsAt ? d.wgTimeUp : ""}</span>
      <div className="row wg-actions">
        {s.endsAt ? (
          <button type="button" className="btn" onClick={() => save({ ...s, endsAt: null, remainingMs: Math.max(0, s.endsAt! - Date.now()) })}>{d.pause}</button>
        ) : (
          <button type="button" className="btn btn-primary" onClick={() => {
            if (s.remainingMs > 0) { rang.current = false; setNow(Date.now()); save({ ...s, endsAt: Date.now() + s.remainingMs }); }
            else startFor(s.durationMs);
          }}>{s.remainingMs > 0 && s.remainingMs < s.durationMs ? d.resume : d.start}</button>
        )}
        <button type="button" className="btn" onClick={() => { rang.current = false; save({ ...s, endsAt: null, remainingMs: s.durationMs }); }}>{d.reset}</button>
      </div>
      <div className="wg-presets" role="group" aria-label={d.wgTimerPresets}>
        {PRESETS.map((m) => (
          <button key={m} type="button" className="btn btn-sm" onClick={() => { setMinutes(String(m)); startFor(m * 60_000); }}>{m} {d.wgMin}</button>
        ))}
      </div>
      <form className="row wg-actions" onSubmit={(e) => { e.preventDefault(); if (typed > 0) startFor(Math.round(typed * 60_000)); }}>
        <label htmlFor={`${id}-m`} className="wg-small">{d.wgTimerMinutes}</label>
        <input id={`${id}-m`} className="field wg-num" inputMode="decimal" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
        <button type="submit" className="btn btn-sm" disabled={!(typed > 0)}>{d.start}</button>
      </form>
      <label className="row wg-check">
        <input type="checkbox" checked={s.sound} onChange={(e) => save({ ...s, sound: e.target.checked })} /> {d.wgSound}
      </label>
    </div>
  );
}

// ---------- noise meter ----------

export function NoiseTool({ d, big }: ToolProps) {
  const id = useId();
  const [limit, setLimit] = useState(70);
  useEffect(() => { const v = store.get<number>("sl-wg-noise-line"); if (typeof v === "number") setLimit(v); }, []);
  const mic = useNoiseMeter(() => {});
  const level = Math.round(mic.level);
  const colour = noiseColour(level, limit);
  return (
    <div className={`wg-noise ${big ? "is-big" : ""}`}>
      <div className="wg-noise-stage" style={mic.listening ? { background: colour.background, color: colour.ink } : undefined}>
        <strong className="wg-noise-word">{mic.listening ? d[noiseWord(level)] : d.noiseOff}</strong>
        <div className="wg-noise-bar" aria-hidden="true">
          <span style={{ width: `${mic.listening ? level : 0}%` }} />
          <i style={{ left: `${limit}%` }} />
        </div>
        {mic.listening && <span className="sr-only">{level} / 100</span>}
      </div>
      <button type="button" className={`btn ${mic.listening ? "" : "btn-primary"}`} aria-pressed={mic.listening}
        onClick={() => (mic.listening ? mic.stop() : mic.start())}>
        {mic.listening ? d.micOff : d.micOn}
      </button>
      <p className="muted wg-small" style={{ margin: 0 }}>
        {mic.error === "blocked" ? d.micBlocked : mic.error === "missing" ? d.micMissing : mic.listening ? d.wgMicOn : d.micHintOff}
      </p>
      <label className="stack wg-small" style={{ gap: 2 }} htmlFor={`${id}-l`}>
        {d.noiseLimit}
        <input id={`${id}-l`} type="range" min={20} max={95} value={limit}
          onChange={(e) => { setLimit(Number(e.target.value)); store.set("sl-wg-noise-line", Number(e.target.value)); }} />
      </label>
    </div>
  );
}

// ---------- the class list (teachers only) ----------

type Roster = { state: "none" } | { state: "loading" } | { state: "failed" } | { state: "ok"; students: Person[] };
const rosterCache = new Map<string, { at: number; students: Person[] }>();

export function useRoster(courseId: string | null): Roster {
  const [r, setR] = useState<Roster>({ state: courseId ? "loading" : "none" });
  useEffect(() => {
    if (!courseId) { setR({ state: "none" }); return; }
    const hit = rosterCache.get(courseId);
    if (hit && Date.now() - hit.at < 60_000) { setR({ state: "ok", students: hit.students }); return; }
    let live = true;
    setR({ state: "loading" });
    fetch(`/api/courses/${courseId}/roster`).then((res) => (res.ok ? res.json() : null)).then((j) => {
      if (!live) return;
      // A refused or failed lookup is never "nobody in the class".
      if (!j || !j.ok) { setR({ state: "failed" }); return; }
      rosterCache.set(courseId, { at: Date.now(), students: j.students });
      setR({ state: "ok", students: j.students });
    }).catch(() => live && setR({ state: "failed" }));
    return () => { live = false; };
  }, [courseId]);
  return r;
}

/** The class for a roster tool: the page's class, or (elsewhere) one the teacher picks from the classes they teach. */
export function ClassChoice({ d, teaching, value, onChange }: { d: Dict; teaching: { id: string; name: string }[]; value: string | null; onChange: (id: string | null) => void }) {
  const id = useId();
  if (!teaching.length) return <p className="muted wg-small" style={{ margin: 0 }}>{d.wgNoTeaching}</p>;
  return (
    <div className="row" style={{ gap: 6 }}>
      <label htmlFor={id} className="wg-small">{d.wgPickClass}</label>
      <select id={id} className="field grow" value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">{d.wgChooseClass}</option>
        {teaching.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </div>
  );
}

function RosterState({ r, d }: { r: Roster; d: Dict }) {
  if (r.state === "loading") return <p className="muted wg-small" style={{ margin: 0 }}>{d.wgLoading}</p>;
  if (r.state === "failed") return <p className="notice notice-bad wg-small" role="alert" style={{ margin: 0 }}>{d.wgRosterFailed}</p>;
  if (r.state === "ok" && !r.students.length) return <p className="muted wg-small" style={{ margin: 0 }}>{d.wgNoStudents}</p>;
  return null;
}

// ---------- name picker ----------

export function PickerTool({ d, big, courseId }: ToolProps) {
  const roster = useRoster(courseId);
  const key = `sl-wg-turns-${courseId}`;
  const [picked, setPicked] = useState<string[]>([]);
  const [current, setCurrent] = useState<Person | null>(null);
  const [round, setRound] = useState(false);
  useEffect(() => { setPicked(store.get<string[]>(key, "session") ?? []); setCurrent(null); setRound(false); }, [key]);
  if (!courseId) return null;
  const students = roster.state === "ok" ? roster.students : [];
  const left = turnsLeft(students, picked);
  const pick = () => {
    const r = choose(students, picked, "turns", Math.random());
    if (!r.person) return;
    const next = r.newRound ? [r.person.id] : [...picked, r.person.id];
    setPicked(next); store.set(key, next, "session"); setCurrent(r.person); setRound(r.newRound);
  };
  return (
    <div className={`wg-picker ${big ? "is-big" : ""}`}>
      <RosterState r={roster} d={d} />
      {students.length > 0 && (
        <>
          <p className="wg-picked" aria-live="polite">{current ? current.name : <span className="muted">{d.pickStart}</span>}</p>
          {round && <p className="muted wg-small" style={{ margin: 0 }}>{d.wgNewRound}</p>}
          <div className="row wg-actions">
            <button type="button" className="btn btn-primary" onClick={pick}>{d.pickName}</button>
            <button type="button" className="btn" disabled={!picked.length} onClick={() => { setPicked([]); store.set(key, [], "session"); setCurrent(null); setRound(false); }}>{d.pickReset}</button>
          </div>
          <p className="muted wg-small" style={{ margin: 0 }}>{left} {d.pickTurnsLeft}</p>
        </>
      )}
    </div>
  );
}

// ---------- groups ----------

export function GroupsTool({ d, big, courseId }: ToolProps) {
  const id = useId();
  const roster = useRoster(courseId);
  const key = `sl-wg-groups-${courseId}`;
  const [by, setBy] = useState<"count" | "size">("count");
  const [n, setN] = useState("4");
  const [groups, setGroups] = useState<string[][]>([]);
  useEffect(() => { setGroups(store.get<string[][]>(key, "session") ?? []); }, [key]);
  if (!courseId) return null;
  const students = roster.state === "ok" ? roster.students : [];
  const names = new Map(students.map((s) => [s.id, s.name]));
  const num = Math.max(1, Math.min(40, Math.floor(Number(n)) || 1));
  // Only ids are kept between pages; anyone no longer in the class drops out.
  const shown = groups.map((g) => g.filter((p) => names.has(p))).filter((g) => g.length);
  return (
    <div className={`wg-groups ${big ? "is-big" : ""}`}>
      <RosterState r={roster} d={d} />
      {students.length > 0 && (
        <>
          <div className="wg-group-form">
            <label htmlFor={`${id}-by`} className="wg-small">{d.wgSplitBy}</label>
            <select id={`${id}-by`} className="field" value={by} onChange={(e) => setBy(e.target.value as "count" | "size")}>
              <option value="count">{d.wgByCount}</option>
              <option value="size">{d.wgBySize}</option>
            </select>
            <label htmlFor={`${id}-n`} className="wg-small">{by === "count" ? d.wgGroupsCount : d.wgGroupsSize}</label>
            <input id={`${id}-n`} className="field wg-num" type="number" min={1} max={40} value={n} onChange={(e) => setN(e.target.value)} />
          </div>
          <button type="button" className="btn btn-primary" onClick={() => {
            const g = makeGroups(students.map((s) => s.id), by === "count" ? { count: num } : { size: num }, Math.random);
            setGroups(g); store.set(key, g, "session");
          }}>{d.wgMakeGroups}</button>
          {shown.length > 0 && (
            <ol className="wg-group-list" aria-live="polite">
              {shown.map((g, i) => (
                <li key={i} className="wg-group">
                  <h4>{d.wgGroupN} {i + 1}</h4>
                  <ul>{g.map((p) => <li key={p}>{names.get(p)}</li>)}</ul>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}

// ---------- seating chart ----------

const short = (name: string) => {
  const [first, ...rest] = name.trim().split(/\s+/);
  return rest.length ? `${first} ${rest[rest.length - 1][0]}.` : first;
};

export function SeatingTool({ d, big, courseId, onArrange }: ToolProps & { onArrange: () => void }) {
  const id = useId();
  const roster = useRoster(courseId);
  const [chart, setChart] = useState<{ layout: Seating; version: number } | null>(null);
  const [draft, setDraft] = useState<Seating | null>(null);
  const [sel, setSel] = useState<{ seat?: string; person?: string } | null>(null);
  const [status, setStatus] = useState<"" | "saving" | "saved" | "stale" | "failed">("");
  const load = useCallback(() => {
    if (!courseId) return;
    let live = true;
    fetch(`/api/courses/${courseId}/seating`).then((r) => (r.ok ? r.json() : null)).then((j) => { if (live && j?.chart) setChart(j.chart); });
    return () => { live = false; };
  }, [courseId]);
  useEffect(() => { setChart(null); setDraft(null); setStatus(""); return load(); }, [load]);
  // Leaving the large view drops unsaved arranging.
  useEffect(() => { if (!big) { setDraft(null); setSel(null); } }, [big]);
  if (!courseId) return null;
  const students = roster.state === "ok" ? roster.students : [];
  const names = new Map(students.map((s) => [s.id, s.name]));
  const layout = draft ?? chart?.layout ?? EMPTY_SEATING;
  const editing = big && !!draft;
  const seated = new Set(Object.values(layout.seats).filter((p) => names.has(p)));
  const unseated = students.filter((s) => !seated.has(s.id));
  const change = (next: Seating) => { setDraft(normalizeSeating(next)); setStatus(""); };

  const tapSeat = (key: string) => {
    if (!editing) return;
    const seats = { ...layout.seats };
    if (sel?.person) {
      for (const [k, p] of Object.entries(seats)) if (p === sel.person) delete seats[k];
      const was = seats[key];
      seats[key] = sel.person;
      if (was && sel.seat) seats[sel.seat] = was;
      change({ ...layout, seats }); setSel(null);
    } else if (sel?.seat) {
      if (sel.seat !== key) { const a = seats[sel.seat], b = seats[key]; if (b) seats[sel.seat] = b; else delete seats[sel.seat]; if (a) seats[key] = a; else delete seats[key]; change({ ...layout, seats }); }
      setSel(null);
    } else if (seats[key]) setSel({ seat: key, person: seats[key] });
    else setSel({ seat: key });
  };

  const saveIt = async () => {
    if (!draft) return;
    setStatus("saving");
    const res = await fetch(`/api/courses/${courseId}/seating`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ layout: draft, baseVersion: chart?.version ?? 0 }),
    }).catch(() => null);
    if (res?.ok) { const j = await res.json(); setChart(j.chart); setDraft(null); setStatus("saved"); }
    else setStatus(res?.status === 409 ? "stale" : "failed");
  };

  const grid = (
    <div className="wg-room">
      <div className="wg-front">{d.wgSeatFront}</div>
      <div className="wg-seats" style={{ gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))` }}>
        {Array.from({ length: layout.rows }, (_, r) => Array.from({ length: layout.cols }, (_, c) => {
          const key = `${r}-${c}`;
          const who = layout.seats[key];
          const name = who ? names.get(who) : undefined;
          const label = `${d.wgRow} ${r + 1}, ${d.wgDesk} ${c + 1}: ${name ?? d.wgSeatEmpty}`;
          const on = sel?.seat === key;
          return editing ? (
            <button key={key} type="button" className={`wg-seat ${name ? "is-taken" : ""} ${on ? "is-on" : ""}`} aria-pressed={on}
              aria-label={label + (on ? ` · ${d.wgSelected}` : "")} onClick={() => tapSeat(key)}>
              {name ? short(name) : ""}
            </button>
          ) : (
            <span key={key} className={`wg-seat ${name ? "is-taken" : ""}`} role="img" aria-label={label}>{name ? short(name) : ""}</span>
          );
        }))}
      </div>
    </div>
  );

  return (
    <div className={`wg-seating ${big ? "is-big" : ""}`}>
      <RosterState r={roster} d={d} />
      {roster.state === "ok" && students.length > 0 && (
        <>
          {!chart ? <p className="muted wg-small" style={{ margin: 0 }}>{d.wgLoading}</p> : (
            <>
              {!editing && seated.size === 0 && <p className="muted wg-small" style={{ margin: 0 }}>{d.wgSeatNone}</p>}
              {grid}
              {!big && <button type="button" className="btn btn-sm" onClick={onArrange}>{d.wgSeatArrange}</button>}
              {big && !editing && <button type="button" className="btn" onClick={() => { setDraft(layout); setStatus(""); }}>{d.wgSeatArrange}</button>}
              {editing && (
                <div className="stack" style={{ gap: 10 }}>
                  <p className="muted wg-small" style={{ margin: 0 }}>{d.wgSeatHow}</p>
                  <div className="row">
                    <label htmlFor={`${id}-r`} className="wg-small">{d.wgSeatRows}</label>
                    <input id={`${id}-r`} className="field wg-num" type="number" min={1} max={10} value={layout.rows}
                      onChange={(e) => change({ ...layout, rows: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })} />
                    <label htmlFor={`${id}-c`} className="wg-small">{d.wgSeatCols}</label>
                    <input id={`${id}-c`} className="field wg-num" type="number" min={1} max={10} value={layout.cols}
                      onChange={(e) => change({ ...layout, cols: Math.max(1, Math.min(10, Number(e.target.value) || 1)) })} />
                  </div>
                  <div className="row">
                    <button type="button" className="btn" onClick={() => change(fillSeats(layout, students.map((s) => s.id), Math.random))}>{d.wgSeatFill}</button>
                    <button type="button" className="btn" onClick={() => change(fillSeats(layout, students.map((s) => s.id), Math.random, true))}>{d.wgSeatShuffle}</button>
                    <button type="button" className="btn" onClick={() => change({ ...layout, seats: {} })}>{d.wgSeatClear}</button>
                  </div>
                  {unseated.length > 0 && (
                    <div className="stack" style={{ gap: 6 }}>
                      <h4 className="todo-head">{d.wgSeatUnseated} ({unseated.length})</h4>
                      <div className="row" style={{ gap: 6 }}>
                        {unseated.map((s) => (
                          <button key={s.id} type="button" className={`btn btn-sm wg-person ${sel?.person === s.id && !sel.seat ? "is-on" : ""}`}
                            aria-pressed={sel?.person === s.id && !sel.seat} onClick={() => setSel(sel?.person === s.id ? null : { person: s.id })}>{s.name}</button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="row">
                    <button type="button" className="btn btn-primary" disabled={status === "saving"} onClick={saveIt}>{d.save}</button>
                    <button type="button" className="btn" onClick={() => { setDraft(null); setSel(null); }}>{d.cancel}</button>
                  </div>
                </div>
              )}
              <p className="wg-small" role="status" style={{ margin: 0 }}>
                {status === "saved" ? d.wgSeatSaved : status === "stale" ? d.wgSeatStale : status === "failed" ? d.wgSaveFailed : status === "saving" ? d.saving : ""}
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
