"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Assignment } from "@/lib/assignments";
import type { Dict } from "@/lib/i18n";
import { onSabbath } from "@/lib/calendar";

type Option = { id: string; name: string };
type Status = "saved" | "dirty" | "saving" | "error" | "conflict";

/** HH:MM of a moment, in this browser's time zone. */
function localTime(iso: string | null): string {
  if (!iso) return "23:59";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * The teacher's form for one assignment. Saved with an explicit Save (it is
 * a form, not a document), version-checked like lessons.
 */
export default function AssignmentEditor({ initial, units, categories, d }: {
  initial: Assignment; units: Option[]; categories: Option[]; d: Dict;
}) {
  const [a, setA] = useState(initial);
  const [time, setTime] = useState("23:59");
  const [status, setStatus] = useState<Status>("saved");

  useEffect(() => { setTime(localTime(initial.dueAt)); }, [initial.dueAt]);

  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => { if (status === "dirty" || status === "saving") e.preventDefault(); };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [status]);

  const set = (patch: Partial<Assignment>) => { setA((x) => ({ ...x, ...patch })); if (status !== "conflict") setStatus("dirty"); };

  const save = async (extra: Partial<Assignment> = {}) => {
    if (status === "conflict") return;
    const next = { ...a, ...extra };
    setStatus("saving");
    const dueAt = next.dueOn ? new Date(`${next.dueOn}T${time || "23:59"}`).toISOString() : null;
    try {
      const res = await fetch(`/api/assignments/${a.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          baseVersion: a.version, title: next.title, instructions: next.instructions, kind: next.kind,
          points: next.points, dueOn: next.dueOn, dueAt, unitId: next.unitId || null, categoryId: next.categoryId || null,
          published: next.published, gradesReleased: next.gradesReleased,
        }),
      });
      if (res.status === 409) { setStatus("conflict"); return; }
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      setA(body.assignment);
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  };

  const archive = async () => {
    if (!confirm(d.archiveConfirm)) return;
    const res = await fetch(`/api/assignments/${a.id}`, { method: "DELETE" });
    if (res.ok) location.href = `/courses/${a.courseId}`;
  };

  const stateText = { saved: `${d.saved} · ${d.version} ${a.version}`, dirty: d.unsaved, saving: d.saving, error: d.saveFailed, conflict: "" }[status];

  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <div className="row">
        <Link href={`/courses/${a.courseId}`} className="muted" style={{ fontSize: 14 }}>← {d.backToCourse}</Link>
        <span className="spacer" style={{ flex: 1 }} />
        <span className="save-state" role="status" aria-live="polite">{stateText}</span>
        <button className="btn btn-primary" type="submit" disabled={status === "saving" || status === "conflict"}>{d.save}</button>
        <Link className="btn" href={`/assignments/${a.id}/grade`}>{d.openGrading}</Link>
      </div>

      {status === "conflict" && (
        <div className="notice notice-bad" role="alert">
          {d.conflict} <button className="btn btn-sm" type="button" onClick={() => location.reload()}>{d.reload}</button>
        </div>
      )}

      <div className="editor">
        <div className="editor-main">
          <label htmlFor="a-title" className="label">{d.assignmentTitle}</label>
          <input id="a-title" className="title-input" value={a.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} />
          <div className="card">
            <div className="fieldset" style={{ marginTop: 0 }}>
              <label htmlFor="a-instr">{d.instructions}</label>
              <textarea id="a-instr" className="field" rows={10} value={a.instructions} maxLength={20000}
                onChange={(e) => set({ instructions: e.target.value })} />
            </div>
            <div className="fieldset">
              <label htmlFor="a-kind">{d.kind}</label>
              <select id="a-kind" className="field" value={a.kind} onChange={(e) => set({ kind: e.target.value as Assignment["kind"] })}>
                <option value="online">{d.kindOnline}</option>
                <option value="offline">{d.kindOffline}</option>
              </select>
            </div>
          </div>
        </div>

        <aside className="editor-side">
          <div className="card">
            <div className="row" style={{ gap: 8 }}>
              <span className={`pill ${a.published ? "" : "pill-draft"}`}>{a.published ? d.published : d.draft}</span>
              <span className="spacer" style={{ flex: 1 }} />
              <button type="button" className={`btn btn-sm ${a.published ? "" : "btn-primary"}`} disabled={status === "saving" || status === "conflict"}
                onClick={() => save({ published: !a.published })}>{a.published ? d.unpublish : d.publish}</button>
            </div>
            {!a.published && <p className="muted" style={{ fontSize: 13, margin: "8px 0 0" }}>{d.publishHint}</p>}
            <label className="check" style={{ marginTop: 14, whiteSpace: "normal" }}>
              <input type="checkbox" checked={a.gradesReleased} onChange={(e) => set({ gradesReleased: e.target.checked })} />
              {d.releaseGrades}
            </label>
            <p className="muted" style={{ fontSize: 13, margin: "4px 0 0" }}>{a.gradesReleased ? d.gradesReleasedNote : d.gradesHiddenNote}</p>
          </div>

          <div className="card">
            <div className="row" style={{ alignItems: "flex-end" }}>
              <div className="fieldset" style={{ flex: "1 1 120px", marginTop: 0 }}>
                <label htmlFor="a-due">{d.dueDate}</label>
                <input id="a-due" type="date" className="field" value={a.dueOn || ""} onChange={(e) => set({ dueOn: e.target.value || null })} />
              </div>
              <div className="fieldset" style={{ flex: "1 1 100px", marginTop: 0 }}>
                <label htmlFor="a-time">{d.dueTime}</label>
                <input id="a-time" type="time" className="field" value={time} disabled={!a.dueOn}
                  onChange={(e) => { setTime(e.target.value); if (status !== "conflict") setStatus("dirty"); }} />
              </div>
            </div>
            {a.dueOn && onSabbath(a.dueOn, time) && <p className="notice" style={{ marginTop: 10 }}>{d.sabbathWarning}</p>}
            <div className="fieldset">
              <label htmlFor="a-points">{d.points}</label>
              <input id="a-points" type="number" min={0} max={10000} step="any" className="field" value={a.points}
                onChange={(e) => set({ points: Number(e.target.value) })} />
            </div>
            <div className="fieldset">
              <label htmlFor="a-cat">{d.category}</label>
              <select id="a-cat" className="field" value={a.categoryId || ""} onChange={(e) => set({ categoryId: e.target.value || null })}>
                <option value="">{d.noCategory}</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="fieldset">
              <label htmlFor="a-unit">{d.unit}</label>
              <select id="a-unit" className="field" value={a.unitId || ""} onChange={(e) => set({ unitId: e.target.value || null })}>
                <option value="">{d.noUnit}</option>
                {units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
          </div>

          <button type="button" className="btn" style={{ alignSelf: "flex-start" }} onClick={archive}>{d.archive}</button>
        </aside>
      </div>
    </form>
  );
}
