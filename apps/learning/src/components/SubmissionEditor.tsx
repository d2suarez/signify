"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Submission } from "@/lib/assignments";
import type { Dict } from "@/lib/i18n";
import ReadAloud from "./ReadAloud";

type Status = "saved" | "dirty" | "saving" | "error" | "conflict";
const SAVE_DELAY = 1000;

/**
 * A student's writing box: saves as they type (version-checked, so a second
 * Chromebook can't overwrite the first), then hands in.
 */
export default function SubmissionEditor({ assignmentId, initial, locked, d }: {
  assignmentId: string; initial: Submission | null; locked: boolean; d: Dict;
}) {
  const [body, setBody] = useState(initial?.body ?? "");
  const [version, setVersion] = useState(initial?.version ?? 0);
  const [submittedAt, setSubmittedAt] = useState<string | null>(initial?.submittedAt ?? null);
  const [status, setStatus] = useState<Status>("saved");
  const [note, setNote] = useState("");

  // Pastes since the last save, sent with it (writing-process evidence, src/lib/writing.ts).
  const pastes = useRef<{ at: number; chars: number; text: string }[]>([]);
  const latest = useRef({ body, version });
  latest.current = { body, version };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const again = useRef(false);
  const stopped = useRef(false);

  const save = useCallback(async (): Promise<boolean> => {
    if (stopped.current) return false;
    if (inFlight.current) { again.current = true; return inFlight.current; }
    const run = (async () => {
      setStatus("saving");
      const s = latest.current;
      const sending = pastes.current;
      try {
        const now = Date.now();
        const res = await fetch(`/api/assignments/${assignmentId}/submission`, {
          method: "PUT", headers: { "content-type": "application/json" },
          body: JSON.stringify({ baseVersion: s.version, body: s.body, pastes: sending.map((p) => ({ ago: now - p.at, chars: p.chars, text: p.text })) }),
        });
        if (res.status === 409) { stopped.current = true; setStatus("conflict"); return false; }
        if (!res.ok) throw new Error(String(res.status));
        const { submission } = await res.json();
        pastes.current = pastes.current.filter((p) => !sending.includes(p));
        latest.current.version = submission.version;
        setVersion(submission.version);
        setStatus(again.current ? "dirty" : "saved");
        return true;
      } catch {
        setStatus("error");
        timer.current = setTimeout(save, 4000);
        return false;
      }
    })();
    inFlight.current = run;
    const ok = await run;
    inFlight.current = null;
    if (again.current) { again.current = false; return save(); }
    return ok;
  }, [assignmentId]);

  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => { if (status === "dirty" || status === "saving" || status === "error") e.preventDefault(); };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [status]);

  const onType = (v: string) => {
    setBody(v);
    if (stopped.current) return;
    setStatus("dirty");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(save, SAVE_DELAY);
  };

  const handIn = async (action: "hand-in" | "take-back") => {
    if (action === "hand-in" && !confirm(d.handInConfirm)) return;
    if (timer.current) clearTimeout(timer.current);
    // Work typed since the last save goes first, so what is handed in is what's on screen.
    if (action === "hand-in" && (status !== "saved" || version === 0)) {
      if (!(await save())) return;
    }
    const res = await fetch(`/api/assignments/${assignmentId}/submission`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, baseVersion: latest.current.version }),
    });
    const out = await res.json().catch(() => ({}));
    if (res.ok) {
      setSubmittedAt(out.submission.submittedAt);
      setVersion(out.submission.version);
      latest.current.version = out.submission.version;
      setNote("");
    } else if (out.error === "graded") {
      setNote(d.cantTakeBack);
    } else if (out.error === "conflict") {
      stopped.current = true;
      setStatus("conflict");
    }
  };

  const handedIn = !!submittedAt;
  const stateText = { saved: version ? d.saved : "", dirty: d.unsaved, saving: d.saving, error: d.saveFailed, conflict: "" }[status];

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row">
        <label htmlFor="work" className="label">{d.yourWork}</label>
        <span className="spacer" style={{ flex: 1 }} />
        {!handedIn && <span className="save-state" role="status" aria-live="polite">{stateText}</span>}
        {handedIn && <span className="chip chip-done">{d.handedIn} · <time suppressHydrationWarning>{new Date(submittedAt).toLocaleString()}</time></span>}
      </div>
      {status === "conflict" && (
        <div className="notice notice-bad" role="alert">
          {d.conflict} <button className="btn btn-sm" type="button" onClick={() => location.reload()}>{d.reload}</button>
        </div>
      )}
      <textarea id="work" className="field writing" rows={16} value={body} maxLength={100000}
        readOnly={handedIn || locked} onChange={(e) => onType(e.target.value)} spellCheck aria-describedby="work-note"
        onPaste={(e) => {
          const text = e.clipboardData.getData("text/plain");
          if (text && !handedIn && !locked) pastes.current.push({ at: Date.now(), chars: text.length, text: text.slice(0, 5000) });
        }} />
      <p id="work-note" className="muted" style={{ margin: 0, fontSize: 13 }}>{d.writingStudentNote}</p>
      {/* Hearing your own writing back is how many students catch what they meant to write. */}
      <ReadAloud text={body} d={d} label={d.readMyWriting} />
      {note && <p className="notice" role="alert">{note}</p>}
      {!locked && (
        <div className="row">
          {handedIn
            ? <button type="button" className="btn" onClick={() => handIn("take-back")}>{d.takeBack}</button>
            : <button type="button" className="btn btn-primary" disabled={status === "conflict" || body.trim() === ""} onClick={() => handIn("hand-in")}>{d.handIn}</button>}
        </div>
      )}
    </div>
  );
}
