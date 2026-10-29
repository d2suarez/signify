"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { rmsToLevel, smooth } from "@/lib/noise";

/**
 * The teacher's microphone for the noise meter, as in Teacher's Desk:
 *   - NOTHING IS RECORDED. The audio goes to an analyser and nowhere else (no
 *     speakers, no recorder); one number a frame survives: how loud it was.
 *   - Off until the teacher turns it on, every time. Never on by itself.
 *   - Off releases the track, so the browser's recording light goes out, and
 *     leaving the block or the page turns it off.
 * `onLevel` gets the level (0-100) up to four times a second, and null when it stops.
 */
export function useNoiseMeter(onLevel: (level: number | null) => void) {
  const [listening, setListening] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<"blocked" | "missing" | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const raf = useRef(0);
  const sent = useRef(0);
  const report = useRef(onLevel);
  report.current = onLevel;

  const stop = useCallback(() => {
    cancelAnimationFrame(raf.current);
    if (stream.current) for (const t of stream.current.getTracks()) t.stop();
    stream.current = null;
    audio.current?.close().catch(() => {});
    audio.current = null;
    setListening(false);
    setLevel(0);
    report.current(null);
  }, []);

  const start = useCallback(async () => {
    if (stream.current) return;
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) { setError("missing"); return; }
    try {
      // Anything that "helps" a voice call fights exactly the loudness we want to show.
      stream.current = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (e) {
      const name = (e as DOMException)?.name;
      setError(name === "NotAllowedError" || name === "SecurityError" ? "blocked" : "missing");
      return;
    }
    const ctx = new AudioContext();
    audio.current = ctx;
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.6;
    const buf = new Float32Array(analyser.fftSize);
    ctx.createMediaStreamSource(stream.current).connect(analyser); // and NOWHERE else
    setListening(true);
    let smoothed = 0;
    const frame = () => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      smoothed = smooth(smoothed, rmsToLevel(Math.sqrt(sum / buf.length)));
      setLevel(smoothed);
      const now = performance.now();
      if (now - sent.current > 250) { sent.current = now; report.current(Math.round(smoothed)); }
      raf.current = requestAnimationFrame(frame);
    };
    raf.current = requestAnimationFrame(frame);
  }, []);

  useEffect(() => stop, [stop]);

  return { listening, level, error, start, stop };
}
