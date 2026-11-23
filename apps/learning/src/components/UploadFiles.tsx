"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Dict } from "@/lib/i18n";

const ACCEPT = ".pdf,.png,.jpg,.jpeg,.gif,.webp,.docx,.pptx,.xlsx,.txt,.csv,.mp3,.m4a,.mp4";
const MAX = 25 * 1024 * 1024;

/**
 * The quick way in: pick one or more files and each becomes a class
 * resource (teachers only; hidden from students until shown). Same upload
 * route as a lesson's File block.
 */
export default function UploadFiles({ courseId, d, unitId }: { courseId: string; d: Dict; unitId?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);

  const send = async (files: File[]) => {
    if (!files.length) return;
    setBusy(true);
    const out: string[] = [];
    for (const file of files) {
      if (file.size > MAX) { out.push(`${file.name}: ${d.fileTooBig}`); continue; }
      try {
        const res = await fetch(`/api/courses/${courseId}/files`, {
          method: "POST", headers: { "x-file-name": encodeURIComponent(file.name), "content-type": "application/octet-stream" }, body: file,
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          out.push(`${file.name}: ${body.error === "type" ? d.fileRefused : body.error === "too-large" ? d.fileTooBig : body.error === "off" ? d.fileOff : d.fileFailed}`);
          continue;
        }
        const f = body.file;
        const title = f.name.replace(/\.[^.]+$/, "");
        const made = await fetch(`/api/courses/${courseId}/resources`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ block: { type: "file", title, fileId: f.id, name: f.name, kind: f.kind }, unitId }),
        });
        out.push(made.ok ? `${file.name}: ${d.fileAdded}` : `${file.name}: ${d.fileFailed}`);
      } catch {
        out.push(`${file.name}: ${d.fileFailed}`);
      }
    }
    setNotes(out);
    setBusy(false);
    router.refresh();
  };

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row">
        <label className={`btn btn-primary${busy ? " is-busy" : ""}`} htmlFor="upload-files" style={{ cursor: busy ? "default" : "pointer" }}>
          ⬆ {busy ? d.fileUploading : d.fileUploadBtn}
        </label>
        <input id="upload-files" type="file" multiple accept={ACCEPT} disabled={busy} className="visually-hidden-input"
          aria-describedby="upload-files-hint" onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ""; send(fs); }} />
      </div>
      <p id="upload-files-hint" className="muted" style={{ margin: 0, fontSize: 13 }}>{d.fileHint} {d.fileUploadHint}</p>
      <ul role="status" aria-live="polite" style={{ margin: 0, paddingLeft: 18, fontSize: 14 }}>
        {notes.map((n, i) => <li key={i}>{n}</li>)}
      </ul>
    </div>
  );
}
