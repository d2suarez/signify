"use client";

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

export type Tally = { blockId: string; counts: Record<string, number>; answered: number };
export type TimerState = { endsAt: number | null; remaining: number | null } | null;

export type LiveState = {
  live: boolean;
  lessonId?: string;
  lessonVersion?: number;
  index?: number;
  count?: number;
  revealed?: boolean;
  tally?: Tally | null;
  timer?: TimerState;
  serverNow?: number;
};

export type TeacherState = LiveState & {
  students: { id: string; name: string }[];
  answers: Record<string, string>;
  tallyAll: Tally | null;
};

/**
 * One socket to this course's live lesson. Reconnects on its own (Wi-Fi on a
 * Chromebook drops; an iPad suspends the tab when a student switches apps),
 * and the server sends the whole current state on every connect, so a
 * reconnecting screen is never left on the wrong slide.
 */
export function useLive(ticket: string) {
  const [state, setState] = useState<LiveState>({ live: false });
  const [teacher, setTeacher] = useState<TeacherState | null>(null);
  const [connected, setConnected] = useState(false);
  const [refused, setRefused] = useState(false);
  const [clockSkew, setClockSkew] = useState(0);
  const socket = useRef<Socket | null>(null);

  useEffect(() => {
    const s = io({ path: "/live", auth: { ticket }, transports: ["websocket", "polling"] });
    socket.current = s;
    s.on("connect", () => { setConnected(true); setRefused(false); });
    s.on("disconnect", () => setConnected(false));
    s.on("connect_error", (e) => { setConnected(false); if (e.message === "not allowed") setRefused(true); });
    s.on("live:state", (st: LiveState) => {
      if (st.serverNow) setClockSkew(st.serverNow - Date.now());
      setState(st);
    });
    s.on("live:teacher", (st: TeacherState) => setTeacher(st));
    return () => { s.disconnect(); socket.current = null; };
  }, [ticket]);

  const emit = (event: string, msg?: unknown) => socket.current?.emit(event, msg);
  return { state, teacher, connected, refused, clockSkew, emit };
}

/** Seconds left on a live timer, ticking. */
export function useTimerLeft(timer: TimerState | undefined, skew: number): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!timer || timer.endsAt == null) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [timer]);
  if (!timer) return null;
  if (timer.endsAt == null) return timer.remaining ?? 0;
  return Math.max(0, Math.ceil((timer.endsAt - (now + skew)) / 1000));
}
