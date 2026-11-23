"use client";

import { useEffect, useRef, useState } from "react";
import type { WorkFile } from "@/lib/hand-in-files";
import type { Dict } from "@/lib/i18n";

/** For the picker: pictures, PDFs, Office files (work-files.ts WORK_ACCEPT). */
const ACCEPT = ".pdf,.png,.jpg,.jpeg,.gif,.webp,.docx,.pptx,.xlsx,image/*,application/pdf";
const MAX = 25 * 1024 * 1024;
const BIG_SIDE = 2400;

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const icon = (f: WorkFile) => (f.kind === "pdf" ? "📄" : f.contentType.includes("presentation") ? "📊" : f.contentType.includes("sheet") ? "📈" : "📝");

/**
 * A phone photo is often 4–12 MB, and an iPad's may be HEIC, which the
 * server refuses. Any photo the browser can open that is big or not a
 * JPEG/PNG is redrawn as a JPEG no wider than 2400 px (plenty to read a
 * page), so it uploads fast and is a kind the server takes. Anything it
 * can't open goes as it is (the server then decides).
 */
async function shrink(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || file.type === "image/gif") return file;
  const plain = file.type === "image/jpeg" || file.type === "image/png";
  if (plain && file.size < 1.5 * 1024 * 1024) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, BIG_SIDE / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    const g = c.getContext("2d");
    if (!g) return file;
    g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, "image/jpeg", 0.85));
    if (!blob || (plain && blob.size >= file.size)) return file;
    const base = file.name.replace(/\.[^.]+$/, "") || "photo";
    return new File([blob], `${base}.jpg`, { type: "image/jpeg" });
  } catch {
    return file;
  }
}

/**
 * A student's files for an assignment that takes them (story 01 A7): take a
 * photo (the camera on an iPad or Chromebook), or choose files; put them in
 * order; remove. Locked once handed in, like the writing box.
 */
export default function WorkFilesBox({ assignmentId, initial, locked, group, d, onCount }: {
  assignmentId: string; initial: WorkFile[]; locked: boolean; group: boolean; d: Dict; onCount: (n: number) => void;
}) {
  const [files, setFiles] = useState(initial);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const camera = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const url = `/api/assignments/${assignmentId}/work-files`;

  useEffect(() => { onCount(files.length); }, [files.length, onCount]);

  // A group's list may change on another member's screen: look again when this tab comes back.
  useEffect(() => {
    if (!group) return;
    const look = async () => {
      if (document.hidden || busy) return;
      const r = await fetch(url, { cache: "no-store" }).catch(() => null);
      if (r?.ok) setFiles((await r.json()).files);
    };
    document.addEventListener("visibilitychange", look);
    return () => document.removeEventListener("visibilitychange", look);
  }, [group, url, busy]);

  useEffect(() => {
    if (!busy) return;
    const onLeave = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [busy]);

  const why = (code: string, name: string) => (code === "off" ? d.wfOff : code === "too-large" ? d.wfTooBig : code === "type" ? d.wfBadType
    : code === "too-many" ? d.wfTooMany : code === "handed-in" ? d.wfLocked : d.wfFailed).replace("{name}", name);

  const add = async (list: FileList | null) => {
    if (!list?.length) return;
    const chosen = [...list];
    setNote("");
    const problems: string[] = [];
    for (const raw of chosen) {
      setBusy(d.wfUploading.replace("{name}", raw.name));
      const f = await shrink(raw);
      if (f.size > MAX) { problems.push(why("too-large", raw.name)); continue; }
      const r = await fetch(url, { method: "POST", headers: { "x-file-name": encodeURIComponent(f.name) }, body: f }).catch(() => null);
      const out = await r?.json().catch(() => ({})) ?? {};
      if (r?.ok) setFiles((x) => [...x, out.file]);
      else { problems.push(why(out.error ?? "", raw.name)); if (out.error === "too-many" || out.error === "handed-in" || out.error === "off") break; }
    }
    setBusy("");
    setNote(problems.join(" "));
  };

  const move = async (i: number, by: number) => {
    const next = [...files];
    const [f] = next.splice(i, 1);
    next.splice(i + by, 0, f);
    setFiles(next);
    const r = await fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ order: next.map((x) => x.id) }) }).catch(() => null);
    const out = await r?.json().catch(() => ({})) ?? {};
    if (r?.ok) setFiles(out.files); else { setFiles(files); setNote(why(out.error ?? "", f.name)); }
  };

  const remove = async (f: WorkFile) => {
    if (!confirm(d.wfRemoveConfirm)) return;
    const r = await fetch(`${url}?file=${encodeURIComponent(f.id)}`, { method: "DELETE" }).catch(() => null);
    const out = await r?.json().catch(() => ({})) ?? {};
    if (r?.ok) setFiles(out.files); else setNote(why(out.error ?? "", f.name));
  };

  return (
    <div className="stack work-files" style={{ gap: 8 }}>
      <p className="label" id="wf-title" style={{ margin: 0 }}>{group ? d.wfGroupTitle : d.wfTitle}</p>
      {!locked && <p className="muted" id="wf-hint" style={{ margin: 0, fontSize: 13 }}>{d.wfHint}</p>}
      {files.length === 0
        ? <p className="muted" style={{ margin: 0 }}>{d.wfNone}</p>
        : (
          <ol className="wf-list" aria-labelledby="wf-title">
            {files.map((f, i) => (
              <li key={f.id} className="wf-item">
                {f.kind === "image"
                  ? <a href={`/work-files/${f.id}`} target="_blank" rel="noopener" className="wf-thumb"><img src={`/work-files/${f.id}`} alt={d.wfPage.replace("{n}", String(i + 1))} loading="lazy" /></a>
                  : <a href={`/work-files/${f.id}`} target="_blank" rel="noopener" className="wf-thumb wf-icon" aria-hidden="true" tabIndex={-1}>{icon(f)}</a>}
                <span className="wf-name">
                  <a href={`/work-files/${f.id}`} target="_blank" rel="noopener">{i + 1}. {f.name}</a>
                  <span className="muted" style={{ display: "block", fontSize: 13 }}>{kb(f.size)}</span>
                </span>
                {!locked && (
                  <span className="wf-tools">
                    <button type="button" className="btn btn-sm" disabled={i === 0 || !!busy} onClick={() => move(i, -1)} aria-label={`${d.wfUp}: ${f.name}`}>↑</button>
                    <button type="button" className="btn btn-sm" disabled={i === files.length - 1 || !!busy} onClick={() => move(i, 1)} aria-label={`${d.wfDown}: ${f.name}`}>↓</button>
                    <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => remove(f)} aria-label={`${d.wfRemove}: ${f.name}`}>{d.wfRemove}</button>
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
      {!locked && (
        <div className="row" style={{ flexWrap: "wrap" }}>
          <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void add(e.target.files); e.target.value = ""; }} />
          <input ref={picker} type="file" accept={ACCEPT} multiple hidden onChange={(e) => { void add(e.target.files); e.target.value = ""; }} />
          <button type="button" className="btn" disabled={!!busy} onClick={() => camera.current?.click()} aria-describedby="wf-hint">📷 {d.wfPhoto}</button>
          <button type="button" className="btn" disabled={!!busy} onClick={() => picker.current?.click()} aria-describedby="wf-hint">📎 {d.wfChoose}</button>
        </div>
      )}
      {busy && <p className="save-state" role="status" aria-live="polite" style={{ margin: 0 }}>{busy}</p>}
      {note && <p className="notice" role="alert" style={{ margin: 0 }}>{note}</p>}
    </div>
  );
}
