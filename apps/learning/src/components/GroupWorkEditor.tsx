"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GroupState, GroupWork } from "@/lib/group-work";
import type { Dict } from "@/lib/i18n";
import ReadAloud from "./ReadAloud";
import WorkFilesBox from "./WorkFilesBox";
import type { WorkFile } from "@/lib/hand-in-files";

type Status = "saved" | "dirty" | "saving" | "error" | "behind";
const SAVE_DELAY = 1000;
const LOOK_EVERY = 5000;

/**
 * A group's ONE shared writing box (story 01, A10). Saves as the member
 * types, with the group text's version; while nobody here is typing it
 * looks every few seconds for what the others saved. When someone else
 * saved first, this member's unsaved words are kept beside the group's
 * newest text to copy in: nothing is ever written over. (Typing together
 * live is the Google Docs step.)
 */
export default function GroupWorkEditor({ assignmentId, initial, myId, locked, d, text = true, files = null }: {
  assignmentId: string; initial: GroupState; myId: string; locked: boolean; d: Dict;
  /** Story 01 A7: whether the shared text shows, and the files (the group's in "one" mode, own in "each"). */
  text?: boolean; files?: WorkFile[] | null;
}) {
  const [fileCount, setFileCount] = useState(files?.length ?? 0);
  const [state, setState] = useState(initial);
  const [body, setBody] = useState(initial.work.body);
  const [status, setStatus] = useState<Status>("saved");
  const [mineLeft, setMineLeft] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const pastes = useRef<{ at: number; chars: number; text: string }[]>([]);
  const latest = useRef({ body, version: initial.work.version, status });
  latest.current = { body, version: latest.current.version, status };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<boolean> | null>(null);

  const { work, mode, submitterBy, mine, group } = state;
  const one = mode === "one";
  const handedIn = one ? !!work.submittedAt : !!mine.submittedAt;
  const iSubmit = work.submitter === myId;
  const nameOf = (id: string | null) => group.members.find((m) => m.id === id)?.name ?? "";
  const readOnly = handedIn || locked || status === "behind";

  const take = (w: GroupWork) => { latest.current.version = w.version; setState((s) => ({ ...s, work: w })); };

  const save = useCallback(async (): Promise<boolean> => {
    if (inFlight.current) return inFlight.current;
    const run = (async () => {
      setStatus("saving");
      const s = latest.current;
      const sending = pastes.current;
      try {
        const now = Date.now();
        const res = await fetch(`/api/assignments/${assignmentId}/group-work`, {
          method: "PUT", headers: { "content-type": "application/json" },
          body: JSON.stringify({ baseVersion: s.version, body: s.body, pastes: sending.map((p) => ({ ago: now - p.at, chars: p.chars, text: p.text })) }),
        });
        const out = await res.json().catch(() => ({}));
        if (res.status === 409 && out.error === "conflict") {
          // Someone in the group saved first: keep these words, show theirs.
          setMineLeft(s.body); take(out.work); setBody(out.work.body); setStatus("behind");
          return false;
        }
        if (res.status === 409) { setNote(d.gaLocked); setStatus("saved"); return false; }
        if (!res.ok) throw new Error(String(res.status));
        pastes.current = pastes.current.filter((p) => !sending.includes(p));
        take(out.work);
        setStatus(latest.current.body === s.body ? "saved" : "dirty");
        if (latest.current.body !== s.body) timer.current = setTimeout(save, SAVE_DELAY);
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
    return ok;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignmentId]);

  // The others' saves, and who hands in, while this member isn't typing.
  useEffect(() => {
    const look = async () => {
      if (latest.current.status !== "saved" || document.hidden) return;
      try {
        const res = await fetch(`/api/assignments/${assignmentId}/group-work`, { cache: "no-store" });
        if (!res.ok) return;
        const next = await res.json() as GroupState;
        if (latest.current.status !== "saved") return;
        latest.current.version = next.work.version;
        setState(next);
        setBody(next.work.body);
      } catch { /* the next look tries again */ }
    };
    const id = setInterval(look, LOOK_EVERY);
    return () => clearInterval(id);
  }, [assignmentId]);

  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => { if (status === "dirty" || status === "saving" || status === "error") e.preventDefault(); };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [status]);

  const onType = (v: string) => {
    setBody(v);
    setStatus("dirty");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(save, SAVE_DELAY);
  };

  const act = async (action: "hand-in" | "take-back" | "claim") => {
    if (action === "hand-in" && !confirm(one ? d.gaHandInConfirm : d.handInConfirm)) return;
    if (timer.current) clearTimeout(timer.current);
    if (action === "hand-in" && status !== "saved") { if (!(await save())) return; }
    const res = await fetch(`/api/assignments/${assignmentId}/group-work`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) {
      setNote(out.error === "graded" ? d.cantTakeBack : out.error === "not-submitter" ? d.gaNotSubmitter : out.error === "no-submitter" ? d.gaNoSubmitter : d.saveFailed);
      return;
    }
    setNote("");
    // My own hand-in is my row; read the whole state again.
    const again = await fetch(`/api/assignments/${assignmentId}/group-work`, { cache: "no-store" });
    if (again.ok) { const next = await again.json() as GroupState; latest.current.version = next.work.version; setState(next); setBody(next.work.body); }
  };

  const stateText = { saved: work.version ? d.saved : "", dirty: d.unsaved, saving: d.saving, error: d.saveFailed, behind: "" }[status];
  const when = one ? work.submittedAt : mine.submittedAt;

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div>
        <p className="label" style={{ margin: 0 }}>{d.gaYourGroup}: {group.name}</p>
        <p className="muted" style={{ margin: "2px 0 0", fontSize: 14 }}>{group.members.map((m) => m.name).join(", ")}</p>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>
        {one
          ? work.submitter
            ? (iSubmit ? d.gaYouHandIn : d.gaTheyHandIn.replace("{name}", nameOf(work.submitter)))
            : submitterBy === "teacher" ? d.gaTeacherWillChoose : d.gaNobodyChosen
          : d.gaEachHandsIn}
      </p>
      <div className="row">
        {text ? <label htmlFor="gwork" className="label">{d.gaGroupText}</label> : <span className="label">{d.yourWork}</span>}
        <span className="spacer" style={{ flex: 1 }} />
        {!handedIn && <span className="save-state" role="status" aria-live="polite">{stateText}</span>}
        {handedIn && when && <span className="chip chip-done">{d.handedIn} · <time suppressHydrationWarning>{new Date(when).toLocaleString()}</time></span>}
      </div>
      {status === "behind" && mineLeft !== null && (
        <div className="notice" role="alert">
          <p style={{ margin: "0 0 6px" }}>{d.gaBehind}</p>
          <label htmlFor="gwork-mine" className="label">{d.gaYourWords}</label>
          <textarea id="gwork-mine" className="field" rows={5} readOnly value={mineLeft} />
          <div className="row" style={{ marginTop: 6 }}>
            <button type="button" className="btn btn-sm" onClick={() => { setMineLeft(null); setStatus("saved"); }}>{d.gaGoOn}</button>
          </div>
        </div>
      )}
      {text && <><textarea id="gwork" className="field writing" rows={16} value={body} maxLength={100000}
        readOnly={readOnly} onChange={(e) => onType(e.target.value)} spellCheck aria-describedby="gwork-note"
        onPaste={(e) => {
          const text = e.clipboardData.getData("text/plain");
          if (text && !readOnly) pastes.current.push({ at: Date.now(), chars: text.length, text: text.slice(0, 5000) });
        }} />
      <p id="gwork-note" className="muted" style={{ margin: 0, fontSize: 13 }}>{d.gaWritingNote}</p>
      <ReadAloud text={body} d={d} label={d.readMyWriting} /></>}
      {files && <WorkFilesBox assignmentId={assignmentId} initial={files} locked={handedIn || locked} group={one} d={d} onCount={setFileCount} />}
      {note && <p className="notice" role="alert">{note}</p>}
      {!locked && (
        <div className="row">
          {one && !handedIn && submitterBy === "group" && !iSubmit && work.submitterBy !== "teacher" && (
            <button type="button" className="btn" onClick={() => act("claim")}>{d.gaClaim}</button>
          )}
          {(!one || iSubmit) && (handedIn
            ? <button type="button" className="btn" onClick={() => act("take-back")}>{d.takeBack}</button>
            : <button type="button" className="btn btn-primary" disabled={status === "behind" || ((!text || body.trim() === "") && fileCount === 0)} onClick={() => act("hand-in")}>
                {one ? d.gaHandInGroup : d.handIn}
              </button>)}
        </div>
      )}
    </div>
  );
}
