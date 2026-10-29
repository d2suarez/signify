"use client";

import { useEffect, useRef, useState } from "react";
import { normalizePrefs, prefsAttrs, type Prefs } from "@/lib/prefs";
import type { Dict } from "@/lib/i18n";
import { speechSupported, stopSpeech } from "./speech";

const ATTRS = ["data-read-aloud", "data-rate", "data-font", "data-size", "data-spacing", "data-contrast"];

/** Puts the choices on <html> now (globals.css does the rest) and tells read-aloud buttons. */
function apply(p: Prefs) {
  const html = document.documentElement;
  for (const a of ATTRS) html.removeAttribute(a);
  for (const [k, v] of Object.entries(prefsAttrs(p))) html.setAttribute(k, v);
  window.dispatchEvent(new Event("sl:prefs"));
}

/**
 * The reading supports panel: each person's own read-aloud, font, size,
 * spacing and contrast. Every change shows at once and is saved for next
 * time; if saving fails the choice still applies on this page.
 */
export default function Supports({ initial, d }: { initial: Prefs; d: Dict }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [prefs, setPrefs] = useState(initial);
  const [note, setNote] = useState("");
  const seq = useRef(0);

  const change = async (patch: Partial<Prefs>) => {
    const next = normalizePrefs({ ...prefs, ...patch });
    setPrefs(next);
    apply(next);
    if (!next.readAloud) stopSpeech();
    const mine = ++seq.current;
    setNote(d.saving);
    try {
      const res = await fetch("/api/prefs", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) });
      if (!res.ok) throw new Error(String(res.status));
      if (mine === seq.current) setNote(d.prefsSaved);
    } catch {
      if (mine === seq.current) setNote(d.prefsFailed);
    }
  };

  // Known only in the browser; assumed until then so the first paint matches the server's.
  const [canSpeak, setCanSpeak] = useState(true);
  useEffect(() => setCanSpeak(speechSupported()), []);

  return (
    <>
      <button type="button" className="btn btn-sm supports-btn" aria-haspopup="dialog" onClick={() => { setNote(""); dialog.current?.showModal(); }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
          <path d="M4 7V5h12v2M10 5v14M7 19h6M15 12v-1h6v1M18 11v8M16.5 19h3" />
        </svg>
        {d.supports}
      </button>
      <dialog ref={dialog} className="dialog" aria-labelledby="supports-title" aria-describedby="supports-hint"
        onClick={(e) => { if (e.target === dialog.current) dialog.current?.close(); }}>
        <div className="dialog-in">
          <div className="row">
            <h2 id="supports-title" style={{ fontSize: 24 }}>{d.supports}</h2>
            <span style={{ flex: 1 }} />
            <button type="button" className="btn btn-sm" onClick={() => dialog.current?.close()}>{d.close}</button>
          </div>
          <p id="supports-hint" className="muted" style={{ margin: 0 }}>{d.supportsHint}</p>

          <Choice legend={d.readAloud} name="readAloud" value={prefs.readAloud ? "on" : "off"}
            options={[["off", d.off], ["on", d.on]]} onChange={(v) => change({ readAloud: v === "on" })}
            hint={canSpeak ? d.readAloudHint : d.readAloudUnsupported} disabled={!canSpeak} />
          {prefs.readAloud && canSpeak && (
            <Choice legend={d.speed} name="rate" value={prefs.rate}
              options={[["slow", d.slower], ["normal", d.normalWord]]} onChange={(v) => change({ rate: v as Prefs["rate"] })} />
          )}
          <Choice legend={d.font} name="font" value={prefs.font}
            options={[["standard", d.fontStandard], ["dyslexia", d.fontDyslexia]]} onChange={(v) => change({ font: v as Prefs["font"] })} />
          <Choice legend={d.textSize} name="size" value={prefs.size}
            options={[["normal", d.normalWord], ["large", d.sizeLarge], ["larger", d.sizeLarger]]} onChange={(v) => change({ size: v as Prefs["size"] })} />
          <Choice legend={d.lineSpacing} name="spacing" value={prefs.spacing}
            options={[["normal", d.normalWord], ["wide", d.spacingWide]]} onChange={(v) => change({ spacing: v as Prefs["spacing"] })} />
          <Choice legend={d.contrast} name="contrast" value={prefs.contrast}
            options={[["standard", d.contrastStandard], ["high", d.contrastHigh]]} onChange={(v) => change({ contrast: v as Prefs["contrast"] })} />

          <p className="supports-sample">{d.supportsSample}</p>
          <p className="save-state" role="status" aria-live="polite" style={{ margin: 0, minHeight: "1.5em" }}>{note}</p>
        </div>
      </dialog>
    </>
  );
}

function Choice({ legend, name, value, options, onChange, hint, disabled }: {
  legend: string; name: string; value: string; options: [string, string][];
  onChange: (v: string) => void; hint?: string; disabled?: boolean;
}) {
  return (
    <fieldset className="choice" disabled={disabled} aria-describedby={hint ? `${name}-hint` : undefined}>
      <legend>{legend}</legend>
      <div className="choice-opts">
        {options.map(([v, text]) => (
          <label key={v}>
            <input type="radio" name={name} value={v} checked={value === v} onChange={() => onChange(v)} />
            <span>{text}</span>
          </label>
        ))}
      </div>
      {hint && <p id={`${name}-hint`} className="muted" style={{ margin: "6px 0 0", fontSize: 13 }}>{hint}</p>}
    </fieldset>
  );
}
