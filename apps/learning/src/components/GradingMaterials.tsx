"use client";

import { useState } from "react";
import type { Dict } from "@/lib/i18n";
import type { GradingMaterial, MaterialRole } from "@/lib/grading-materials";

const ACCEPT = ".pdf,.png,.jpg,.jpeg,.gif,.webp,.docx,.pptx,.xlsx,.txt,.csv";
const MAX = 25 * 1024 * 1024;
const ROLES: MaterialRole[] = ["key", "reading", "guide", "other"];

/**
 * Answer keys and grading materials (story 01, A11): the teacher's own
 * sources of truth for grading this assignment. Shown on the teacher's
 * assignment page (where they're added) and the grading desk (to open).
 * Never on any page a student, parent or preview gets.
 */
export default function GradingMaterials({ assignmentId, courseId, initial, editable, canUpload, d }: {
  assignmentId: string; courseId: string; initial: GradingMaterial[]; editable: boolean; canUpload: boolean; d: Dict;
}) {
  const [list, setList] = useState(initial);
  const [role, setRole] = useState<MaterialRole>("key");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const roleName = (r: MaterialRole) => ({ key: d.gmKey, reading: d.gmReading, guide: d.gmGuide, other: d.gmOther })[r];

  const attach = async (body: Record<string, unknown>) => {
    const res = await fetch(`/api/assignments/${assignmentId}/materials`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role, title, ...body }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) { setNote(out.error === "bad-link" ? d.gmBadLink : out.error === "too-many" ? d.gmTooMany : d.gmFailed); return false; }
    setList((l) => [...l, out.material]);
    setTitle(""); setUrl(""); setNote(d.gmAdded);
    return true;
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX) { setNote(d.fileTooBig); return; }
    setBusy(true); setNote("");
    try {
      const res = await fetch(`/api/courses/${courseId}/files`, {
        method: "POST", headers: { "x-file-name": encodeURIComponent(file.name), "content-type": "application/octet-stream" }, body: file,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setNote(body.error === "type" ? d.fileRefused : body.error === "too-large" ? d.fileTooBig : body.error === "off" ? d.fileOff : d.fileFailed);
      else await attach({ fileId: body.file.id, title: title || file.name.replace(/\.[^.]+$/, "") });
    } catch { setNote(d.gmFailed); }
    setBusy(false);
  };

  const addLink = async () => {
    if (!url.trim()) return;
    setBusy(true); setNote("");
    try { await attach({ url: url.trim() }); } catch { setNote(d.gmFailed); }
    setBusy(false);
  };

  const remove = async (m: GradingMaterial) => {
    if (!confirm(d.gmRemoveAsk.replace("{title}", m.title || m.fileName || m.url || ""))) return;
    const res = await fetch(`/api/assignments/${assignmentId}/materials?m=${m.id}`, { method: "DELETE" }).catch(() => null);
    if (res?.ok) setList((l) => l.filter((x) => x.id !== m.id)); else setNote(d.gmFailed);
  };

  if (!editable && list.length === 0) return null;
  return (
    <section className="card stack" style={{ marginTop: editable ? 24 : 0, gap: 10 }} aria-labelledby="gm-title">
      <div>
        <h2 id="gm-title" className="label"><span className="shape s-square" style={{ marginRight: 8 }} />{d.gmTitle}</h2>
        <p className="muted" style={{ margin: "4px 0 0", fontSize: 14 }}>{d.gmHint}</p>
      </div>
      {list.length > 0 ? (
        <ul className="stack" style={{ gap: 6, margin: 0, padding: 0, listStyle: "none" }}>
          {list.map((m) => (
            <li key={m.id} className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <span className="chip">{roleName(m.role)}</span>
              <a className="grow" style={{ minWidth: 0, overflowWrap: "anywhere" }} target="_blank" rel="noopener"
                href={m.fileId ? `/files/${m.fileId}` : m.url!}>
                {m.title || m.fileName || m.url}{m.url ? " ↗" : ""}
              </a>
              {editable && <button type="button" className="btn btn-sm" onClick={() => remove(m)} aria-label={`${d.gmRemove}: ${m.title || m.fileName || m.url}`}>{d.gmRemove}</button>}
            </li>
          ))}
        </ul>
      ) : <p className="muted" style={{ margin: 0 }}>{d.gmNone}</p>}
      {editable && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <label className="stack" style={{ gap: 2 }}>
              <span className="label">{d.gmWhat}</span>
              <select className="field" value={role} onChange={(e) => setRole(e.target.value as MaterialRole)}>
                {ROLES.map((r) => <option key={r} value={r}>{roleName(r)}</option>)}
              </select>
            </label>
            <label className="stack grow" style={{ gap: 2, minWidth: 180 }}>
              <span className="label">{d.gmName}</span>
              <input className="field" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder={d.gmNameHint} />
            </label>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <input className="field grow" style={{ minWidth: 180 }} type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)}
              placeholder="https://" aria-label={d.gmLink} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addLink(); } }} />
            <button type="button" className="btn" disabled={busy || !url.trim()} onClick={addLink}>{d.gmAddLink}</button>
            {canUpload && (
              <>
                <label className={`btn${busy ? " is-busy" : ""}`} htmlFor="gm-file" style={{ cursor: busy ? "default" : "pointer" }}>⬆ {d.gmUpload}</label>
                <input id="gm-file" type="file" accept={ACCEPT} disabled={busy} className="visually-hidden-input"
                  onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; upload(f); }} />
              </>
            )}
          </div>
        </div>
      )}
      <p role="status" aria-live="polite" className="muted" style={{ margin: 0, fontSize: 14 }}>{note}</p>
    </section>
  );
}
