"use client";

import { useEffect, useId } from "react";
import type { Dict } from "@/lib/i18n";
import { pauseSpeech, resumeSpeech, speak, stopSpeech, useReadAloud, useSpeech } from "./speech";

/**
 * Read aloud, pause, carry on, stop. Shown only to someone who turned
 * read-aloud on in their reading supports. When the text changes (the
 * teacher moves the lesson on) reading stops, so it never reads the old slide.
 */
export default function ReadAloud({ text, d, label }: { text: string; d: Dict; label?: string }) {
  const id = useId();
  const on = useReadAloud();
  const { speaking, paused } = useSpeech(id);

  useEffect(() => () => stopSpeech(id), [text, id]);

  if (!on || !text.trim()) return null;
  return (
    <div className="read-aloud" role="group" aria-label={d.readAloud}>
      {!speaking ? (
        <button type="button" className="btn btn-sm" onClick={() => speak(id, text)}>
          <SpeakerIcon />{label ?? d.readAloud}
        </button>
      ) : (
        <>
          {paused
            ? <button type="button" className="btn btn-sm btn-primary" onClick={resumeSpeech}><SpeakerIcon />{d.resume}</button>
            : <button type="button" className="btn btn-sm btn-primary" onClick={pauseSpeech}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
                {d.pause}
              </button>}
          <button type="button" className="btn btn-sm" onClick={() => stopSpeech(id)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5" /></svg>
            {d.stop}
          </button>
        </>
      )}
    </div>
  );
}

function SpeakerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor" stroke="none" />
      <path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />
    </svg>
  );
}
