"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { setClassPicture } from "@/app/courses/[id]/picture-actions";

export type PictureWords = { cpChange: string; cpAdd: string; cpRemove: string; cpBusy: string; cpFailed: string; cpRefused: string; cpOff: string; cpHint: string };

const SIDE = 512;

/** A photo made small (and a HEIC one readable) before it goes up: a header picture never needs more. */
async function shrink(file: File): Promise<File> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, SIDE / Math.max(bmp.width, bmp.height));
    if (scale === 1 && /\.(png|jpe?g|gif|webp)$/i.test(file.name) && file.size < 600_000) { bmp.close(); return file; }
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(bmp.width * scale));
    c.height = Math.max(1, Math.round(bmp.height * scale));
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, "image/jpeg", 0.88));
    return blob ? new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" }) : file;
  } catch {
    return file; // the server decides by the bytes
  }
}

/**
 * The teacher's way to put up or change the class picture (migration 043):
 * in the class header (`compact`, a small button over the picture) and in
 * class settings (with "Remove"). Uploads to the class's own files, then
 * sets it.
 */
export default function ClassPicture({ courseId, has, w, compact = false }: { courseId: string; has: boolean; w: PictureWords; compact?: boolean }) {
  const router = useRouter();
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const send = async (picked: File | undefined) => {
    if (!picked) return;
    setBusy(true); setNote("");
    try {
      const file = await shrink(picked);
      const res = await fetch(`/api/courses/${courseId}/files`, {
        method: "POST", headers: { "x-file-name": encodeURIComponent(file.name), "content-type": "application/octet-stream" }, body: file,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.file?.kind !== "image") {
        setNote(body.error === "off" ? w.cpOff : res.ok || body.error === "type" ? w.cpRefused : w.cpFailed);
      } else if (await setClassPicture(courseId, body.file.id)) router.refresh();
      else setNote(w.cpRefused);
    } catch { setNote(w.cpFailed); }
    setBusy(false);
  };
  const remove = async () => {
    setBusy(true); setNote("");
    if (await setClassPicture(courseId, null).catch(() => false)) router.refresh(); else setNote(w.cpFailed);
    setBusy(false);
  };

  const input = (
    <input id={id} type="file" accept="image/*,.png,.jpg,.jpeg,.gif,.webp,.heic" disabled={busy} className="visually-hidden-input"
      onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; send(f); }} />
  );
  if (compact) {
    return (
      <>
        <label htmlFor={id} className={`class-pic-edit${busy ? " is-busy" : ""}`} title={has ? w.cpChange : w.cpAdd}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" />
          </svg>
          <span className="sr-only">{busy ? w.cpBusy : has ? w.cpChange : w.cpAdd}</span>
        </label>
        {input}
        {note && <span className="class-pic-note" role="alert">{note}</span>}
      </>
    );
  }
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 8 }}>
        <label htmlFor={id} className={`btn${busy ? " is-busy" : ""}`} style={{ cursor: busy ? "default" : "pointer" }}>{busy ? w.cpBusy : has ? w.cpChange : w.cpAdd}</label>
        {input}
        {has && <button type="button" className="btn" onClick={remove} disabled={busy}>{w.cpRemove}</button>}
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>{w.cpHint}</p>
      {note && <p className="notice" role="alert" style={{ margin: 0 }}>{note}</p>}
    </div>
  );
}
