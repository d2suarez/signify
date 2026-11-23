"use client";

import { useId, useState } from "react";
import type { Dict } from "@/lib/i18n";

/**
 * "Make new groups" inside an assignment's group settings (no Groups tab
 * since 2026-11-23): at random by number of groups or students per group,
 * or empty groups to fill by hand. The new set is saved for the class (so it
 * can be picked again, and shown on a group slide) and chosen at once.
 */
export default function GroupSetMaker({ courseId, d, onMade }: { courseId: string; d: Dict; onMade: (set: { id: string; name: string }) => void }) {
  const id = useId();
  const [name, setName] = useState("");
  const [how, setHow] = useState<"count" | "size" | "hand">("count");
  const [n, setN] = useState(4);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const make = async () => {
    setBusy(true); setNote("");
    try {
      const res = await fetch(`/api/courses/${courseId}/groups`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, how, n }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 503) setNote(d.grpRosterFailed);
      else if (!res.ok || !body.set) setNote(d.gsMakeFailed);
      else { onMade(body.set); setName(""); setNote(""); }
    } catch { setNote(d.gsMakeFailed); }
    setBusy(false);
  };
  return (
    <details className="group-maker" style={{ marginTop: 8 }}>
      <summary className="link-btn">+ {d.gsMakeNew}</summary>
      <div className="stack" style={{ gap: 8, marginTop: 8 }}>
        <div className="fieldset" style={{ marginTop: 0 }}>
          <label htmlFor={`${id}-name`}>{d.grpSetName}</label>
          <input id={`${id}-name`} className="field" maxLength={80} placeholder={d.grpSetNameHint} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <fieldset className="choice">
          <legend>{d.grpHow}</legend>
          <div className="choice-opts">
            <label><input type="radio" name={`${id}-how`} checked={how === "count"} onChange={() => setHow("count")} /> <span>{d.grpHowCount}</span></label>
            <label><input type="radio" name={`${id}-how`} checked={how === "size"} onChange={() => setHow("size")} /> <span>{d.grpHowSize}</span></label>
            <label><input type="radio" name={`${id}-how`} checked={how === "hand"} onChange={() => setHow("hand")} /> <span>{d.grpHowHand}</span></label>
          </div>
        </fieldset>
        <div className="fieldset" style={{ maxWidth: 200 }}>
          <label htmlFor={`${id}-n`}>{d.grpHowN}</label>
          <input id={`${id}-n`} type="number" min={1} max={40} className="field" value={n} onChange={(e) => setN(Number(e.target.value) || 1)} />
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="btn btn-sm" onClick={make} disabled={busy}>{busy ? d.saving : d.grpMake}</button>
          {note && <span className="notice notice-bad" role="alert">{note}</span>}
        </div>
      </div>
    </details>
  );
}
