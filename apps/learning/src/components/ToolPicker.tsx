"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Dict } from "@/lib/i18n";

export type ToolChoice = { id: string; name: string; picker: boolean };
export type PlacedItem = { linkId: string; title: string; display: "tab" | "frame"; assignmentId?: string };

/**
 * Adds an outside tool: into a lesson (`lessonId`, items come back as
 * blocks through `onPlaced`) or as new draft assignments (the course page).
 * Choosing in the tool happens in a new tab; this asks every two seconds
 * whether the tool has answered.
 */
export default function ToolPicker({ tools, courseId, lessonId, onPlaced, d }: {
  tools: ToolChoice[]; courseId: string; lessonId?: string; onPlaced?: (items: PlacedItem[]) => void; d: Dict;
}) {
  const router = useRouter();
  const [toolId, setToolId] = useState(tools[0]?.id || "");
  const [state, setState] = useState<"idle" | "waiting" | "error">("idle");
  const [note, setNote] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const tool = tools.find((t) => t.id === toolId);

  const placed = (items: PlacedItem[]) => {
    setState("idle");
    setNote(items.length ? d.toolAdded.replace("{n}", String(items.length)) : d.toolPickedNothing);
    if (onPlaced) onPlaced(items);
    else if (items.length === 1 && items[0].assignmentId) router.push(`/assignments/${items[0].assignmentId}`);
    else router.refresh();
  };

  const poll = (pickId: string, tries = 0) => {
    timer.current = setTimeout(async () => {
      if (tries > 900) { setState("idle"); return; }
      try {
        const r = await fetch(`/api/lti-tools/picks/${pickId}`, { cache: "no-store" });
        const body = await r.json();
        if (body.state === "done" || body.state === "cancelled") return placed(body.items || []);
        if (body.state === "gone") { setState("error"); return; }
      } catch { /* try again */ }
      poll(pickId, tries + 1);
    }, 2000);
  };

  const start = async (direct: boolean) => {
    if (!tool) return;
    setNote("");
    // Opened now, while the click still counts, so no popup blocker stops it.
    const w = direct ? null : window.open("about:blank", "_blank");
    try {
      const r = await fetch("/api/lti-tools/picks", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolId: tool.id, courseId, lessonId, direct }),
      });
      if (!r.ok) throw new Error(String(r.status));
      const body = await r.json();
      if (direct) return placed(body.items);
      if (w) { w.opener = null; w.location.href = body.open; } else window.open(body.open, "_blank", "noopener");
      setState("waiting");
      poll(body.pickId);
    } catch {
      w?.close();
      setState("error");
    }
  };

  if (!tools.length) return null;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div className="fieldset" style={{ flex: "1 1 200px", marginTop: 0 }}>
          <label htmlFor={`tool-${lessonId || courseId}`}>{d.toolChoose}</label>
          <select id={`tool-${lessonId || courseId}`} className="field" value={toolId} onChange={(e) => setToolId(e.target.value)}>
            {tools.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        {tool?.picker && <button type="button" className="btn" disabled={state === "waiting"} onClick={() => start(false)}>{d.toolPickIn} ↗</button>}
        {lessonId && <button type="button" className="btn" onClick={() => start(true)}>{d.toolAddPage}</button>}
      </div>
      <p className="muted" role="status" aria-live="polite" style={{ margin: 0, fontSize: 14 }}>
        {state === "waiting" ? d.toolWaiting : state === "error" ? d.toolPickFailed : note}
      </p>
    </div>
  );
}
