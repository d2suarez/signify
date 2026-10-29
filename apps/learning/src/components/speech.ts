"use client";

import { useSyncExternalStore } from "react";
import { RATES, speechChunks } from "@/lib/read-aloud";

/**
 * One voice per page: starting to read something stops whatever was being
 * read. Uses the browser's own speech synthesis, so no text leaves the
 * device. Components follow it with useSpeech(id).
 */

type Snapshot = { owner: string | null; paused: boolean };
let snap: Snapshot = { owner: null, paused: false };
// Bumped by every speak/stop, so an "end" event from cancelled speech can't
// end the reading that replaced it.
let generation = 0;
const listeners = new Set<() => void>();

function set(next: Snapshot) {
  snap = next;
  for (const l of listeners) l();
}

export function speechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

function voiceFor(lang: string): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices();
  return voices.find((v) => v.lang.toLowerCase().startsWith(lang) && v.localService)
    ?? voices.find((v) => v.lang.toLowerCase().startsWith(lang));
}

export function speak(id: string, text: string) {
  if (!speechSupported()) return;
  const synth = window.speechSynthesis;
  synth.cancel();
  const gen = ++generation;
  const parts = speechChunks(text);
  if (!parts.length) { set({ owner: null, paused: false }); return; }
  const lang = document.documentElement.lang || "en";
  const rate = RATES[document.documentElement.dataset.rate === "slow" ? "slow" : "normal"];
  const voice = voiceFor(lang);
  parts.forEach((part, i) => {
    const u = new SpeechSynthesisUtterance(part);
    u.lang = voice?.lang ?? lang;
    if (voice) u.voice = voice;
    u.rate = rate;
    if (i === parts.length - 1) {
      const done = () => { if (gen === generation) set({ owner: null, paused: false }); };
      u.onend = done;
      u.onerror = done;
    }
    synth.speak(u);
  });
  // Chrome can come back from another tab with the queue paused.
  synth.resume();
  set({ owner: id, paused: false });
}

export function pauseSpeech() {
  if (!speechSupported() || !snap.owner) return;
  window.speechSynthesis.pause();
  set({ ...snap, paused: true });
}

export function resumeSpeech() {
  if (!speechSupported() || !snap.owner) return;
  window.speechSynthesis.resume();
  set({ ...snap, paused: false });
}

export function stopSpeech(id?: string) {
  if (!speechSupported()) return;
  if (id && snap.owner !== id) return;
  generation++;
  window.speechSynthesis.cancel();
  set({ owner: null, paused: false });
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const SERVER: Snapshot = { owner: null, paused: false };

export function useSpeech(id: string) {
  const s = useSyncExternalStore(subscribe, () => snap, () => SERVER);
  return { speaking: s.owner === id, paused: s.owner === id && s.paused };
}

/**
 * Whether one of the person's reading supports is on, following changes made
 * in the supports panel without a reload. The truth is the attribute on
 * <html>, which the server sets from their saved choices.
 */
const subscribePrefs = (l: () => void) => {
  window.addEventListener("sl:prefs", l);
  return () => window.removeEventListener("sl:prefs", l);
};

export function useReadAloud(): boolean {
  return useSyncExternalStore(
    subscribePrefs,
    () => document.documentElement.dataset.readAloud === "on" && speechSupported(),
    () => false,
  );
}
