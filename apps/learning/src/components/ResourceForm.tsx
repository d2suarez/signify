"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { type Block, type BlockType, newBlock } from "@/lib/blocks";
import type { Dict } from "@/lib/i18n";
import { BlockFields } from "./LessonEditor";
import { BLOCK_NAME as NAME, BLOCK_SHAPE as SHAPE } from "@/lib/block-kinds";

/** The kinds a teacher can make here; outside tools are saved from a lesson's block. */
const KINDS: BlockType[] = ["link", "board", "text", "timer", "picker", "noise", "poll"];
const STUDENT_KINDS: BlockType[] = ["text", "link", "board"];

/**
 * Adds a resource (no `initial`) or edits one. The block is edited with the
 * lesson editor's own fields, so a resource is exactly a lesson block. Saves
 * through /api/courses/[id]/resources, which runs normalizeBlocks.
 */
export default function ResourceForm({ courseId, initial, d, idBase = "res" }: {
  courseId: string;
  initial?: { id: string; title: string; note: string; visible: boolean; block: Block | null };
  d: Dict; idBase?: string;
}) {
  const router = useRouter();
  const [block, setBlock] = useState<Block | null>(initial?.block ?? null);
  const [title, setTitle] = useState(initial?.title ?? "");
  const [note, setNote] = useState(initial?.note ?? "");
  const [visible, setVisible] = useState(initial?.visible ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const canShow = !!block && STUDENT_KINDS.includes(block.type);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!block && !initial) return;
    setBusy(true); setError("");
    try {
      const res = await fetch(initial ? `/api/courses/${courseId}/resources/${initial.id}` : `/api/courses/${courseId}/resources`, {
        method: initial ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ block, title, note, visible: canShow && visible }),
      });
      if (!res.ok) throw new Error(String(res.status));
      if (!initial) { setBlock(null); setTitle(""); setNote(""); setVisible(false); }
      router.refresh();
    } catch {
      setError(d.resSaveFailed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="stack" style={{ gap: 10 }} onSubmit={save}>
      {!initial && (
        <fieldset className="choice" style={{ margin: 0 }}>
          <legend className="label">{d.resKind}</legend>
          <div className="row" style={{ marginTop: 8 }}>
            {KINDS.map((type) => (
              <button key={type} type="button" className="btn" aria-pressed={block?.type === type}
                onClick={() => setBlock(block?.type === type ? block : newBlock(type))}>
                <span className={`shape ${SHAPE[type]}`} />{d[NAME[type]]}
              </button>
            ))}
          </div>
        </fieldset>
      )}
      {block && (
        <>
          <BlockFields block={block} d={d} idBase={`${idBase}-b`} onChange={(p) => setBlock({ ...block, ...p } as Block)} />
          <div className="fieldset">
            <label htmlFor={`${idBase}-title`}>{d.resListTitle}</label>
            <input id={`${idBase}-title`} className="field" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)}
              aria-describedby={`${idBase}-title-h`} />
            <p id={`${idBase}-title-h`} className="muted" style={{ margin: 0, fontSize: 13 }}>{d.resListTitleHint}</p>
          </div>
        </>
      )}
      {(block || initial) && (
        <>
          <div className="fieldset">
            <label htmlFor={`${idBase}-note`}>{d.resNote}</label>
            <textarea id={`${idBase}-note`} className="field" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          {canShow
            ? <label className="check" style={{ whiteSpace: "normal" }}><input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} />{d.resVisible}</label>
            : block && <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.resVisibleOnly}</p>}
          <div className="row">
            <button type="submit" className="btn btn-primary" disabled={busy}>{initial ? d.save : d.resAdd}</button>
            {error && <span className="notice notice-bad" role="alert">{error}</span>}
          </div>
        </>
      )}
    </form>
  );
}
