"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dict } from "@/lib/i18n";
import { videoFromUrl, safeHref, type DocNode } from "@/lib/post-doc";
import { Tool, Icon, nodeEl, embedEl, serialize } from "./PostComposer";

const IMAGE_ACCEPT = ".png,.jpg,.jpeg,.gif,.webp";
const FILE_ACCEPT = ".pdf,.png,.jpg,.jpeg,.gif,.webp,.docx,.pptx,.xlsx,.txt,.csv,.mp3,.m4a,.mp4";
const MAX = 25 * 1024 * 1024;

/**
 * The Updates editor (same toolbar, same document, same DOM ↔ document code
 * from PostComposer) for writing that belongs to something else: an
 * assignment's instructions (story 01, A12). Formatting, links, pictures and
 * files uploaded to the course, YouTube/Vimeo. No "post to" and no links to
 * other Learning materials. It never sends HTML: every change is the
 * document's nodes, handed to `onChange`; the server normalises them again.
 */
export default function DocEditor({ initial, onChange, uploadUrl, canUpload, label, d }: {
  initial: DocNode[]; onChange: (nodes: DocNode[]) => void;
  /** Where a picture or file is uploaded (the course's own files). */
  uploadUrl: string; canUpload: boolean; label: string; d: Dict;
}) {
  const ed = useRef<HTMLDivElement>(null);
  const range = useRef<Range | null>(null);
  const [nodes, setNodes] = useState<DocNode[]>(initial);
  const [panel, setPanel] = useState<null | "link" | "video">(null);
  const [url, setUrl] = useState("");
  const [note, setNote] = useState<{ bad: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [marks, setMarks] = useState<Record<string, boolean>>({});
  const idBase = useMemo(() => `de-${Math.random().toString(36).slice(2, 8)}`, []);

  const last = useRef<string>("");
  const sync = useCallback(() => {
    if (!ed.current) return;
    const n = serialize(ed.current);
    const key = JSON.stringify(n);
    if (key === last.current) return;
    last.current = key;
    setNodes(n);
    onChange(n);
  }, [onChange]);

  useEffect(() => {
    if (!ed.current) return;
    ed.current.replaceChildren(...initial.map((n) => nodeEl(n, d)));
    last.current = JSON.stringify(serialize(ed.current));
    // Only once: what's typed after this is the teacher's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onSel = () => {
      const sel = document.getSelection();
      if (!sel || !sel.rangeCount || !ed.current?.contains(sel.anchorNode)) return;
      range.current = sel.getRangeAt(0).cloneRange();
      try { document.execCommand("styleWithCSS", false, "false"); document.execCommand("defaultParagraphSeparator", false, "p"); } catch { /* old browser */ }
      const q = (c: string) => { try { return document.queryCommandState(c); } catch { return false; } };
      let block = "";
      try { block = String(document.queryCommandValue("formatBlock") || "").toLowerCase(); } catch { /* ignore */ }
      setMarks({ bold: q("bold"), italic: q("italic"), underline: q("underline"), ul: q("insertUnorderedList"), ol: q("insertOrderedList"), h: block === "h3", quote: block === "blockquote" });
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, []);

  const focusBack = () => {
    const el = ed.current;
    if (!el) return;
    el.focus();
    const sel = document.getSelection();
    if (range.current && el.contains(range.current.startContainer)) { sel?.removeAllRanges(); sel?.addRange(range.current); }
  };
  const cmd = (c: string, v?: string) => { focusBack(); document.execCommand(c, false, v); sync(); };
  const toggleBlock = (tag: "h3" | "blockquote", on: boolean) => cmd("formatBlock", on ? "p" : tag);

  const insertEmbed = (node: DocNode) => {
    const el = ed.current;
    if (!el) return;
    const box = embedEl(node, d);
    let at: Node | null = range.current && el.contains(range.current.startContainer) ? range.current.startContainer : null;
    while (at && at.parentNode !== el) at = at.parentNode;
    if (at && at.nextSibling) el.insertBefore(box, at.nextSibling);
    else el.appendChild(box);
    const after = document.createElement("p");
    after.appendChild(document.createElement("br"));
    el.insertBefore(after, box.nextSibling);
    const r = document.createRange();
    r.setStart(after, 0);
    range.current = r;
    focusBack();
    sync();
  };

  const upload = async (files: File[], asImage: boolean) => {
    for (const file of files) {
      if (file.size > MAX) { setNote({ bad: true, text: `${file.name}: ${d.fileTooBig}` }); continue; }
      setBusy(true);
      try {
        const res = await fetch(uploadUrl, {
          method: "POST", headers: { "x-file-name": encodeURIComponent(file.name), "content-type": "application/octet-stream" }, body: file,
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          setNote({ bad: true, text: `${file.name}: ${body.error === "type" ? d.fileRefused : body.error === "too-large" ? d.fileTooBig : body.error === "off" ? d.fileOff : d.fileFailed}` });
          continue;
        }
        const f = body.file as { id: string; name: string; kind: "image" | "pdf" | "audio" | "video" | "doc" };
        if (asImage && f.kind !== "image") setNote({ bad: false, text: `${f.name}: ${d.pcNotPicture}` });
        insertEmbed({ type: "file", fileId: f.id, name: f.name, kind: f.kind, alt: "" });
      } catch {
        setNote({ bad: true, text: `${file.name}: ${d.fileFailed}` });
      } finally {
        setBusy(false);
      }
    }
  };

  const addLink = () => {
    const href = safeHref(url);
    if (!href) { setNote({ bad: true, text: d.pcBadLink }); return; }
    focusBack();
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed && ed.current?.contains(sel.anchorNode)) document.execCommand("createLink", false, href);
    else {
      const a = document.createElement("a");
      a.href = href; a.textContent = url.trim();
      const r = range.current && ed.current?.contains(range.current.startContainer) ? range.current : null;
      if (r) { r.insertNode(a); r.setStartAfter(a); r.collapse(true); sel?.removeAllRanges(); sel?.addRange(r); }
      else ed.current?.appendChild(document.createElement("p")).appendChild(a);
    }
    setUrl(""); setPanel(null); setNote(null); sync();
  };
  const addVideo = () => {
    const v = videoFromUrl(url);
    if (!v) { setNote({ bad: true, text: d.pcBadVideo }); return; }
    insertEmbed({ type: "video", ...v });
    setUrl(""); setPanel(null); setNote(null);
  };

  return (
    <div className="composer is-open doc-editor">
      <div className="rt-toolbar" role="toolbar" aria-label={d.pcFormatting}>
        <Tool on={!!marks.bold} label={d.pcBold} onClick={() => cmd("bold")}><b>B</b></Tool>
        <Tool on={!!marks.italic} label={d.pcItalic} onClick={() => cmd("italic")}><i style={{ fontFamily: "Georgia, serif" }}>I</i></Tool>
        <Tool on={!!marks.underline} label={d.pcUnderline} onClick={() => cmd("underline")}><u>U</u></Tool>
        <span className="rt-sep" aria-hidden="true" />
        <Tool on={!!marks.h} label={d.pcHeading} onClick={() => toggleBlock("h3", !!marks.h)}><span style={{ fontWeight: 800 }}>H</span></Tool>
        <Tool on={!!marks.quote} label={d.pcQuote} onClick={() => toggleBlock("blockquote", !!marks.quote)}><Icon d="M7 7h4v4H8c0 2 1 3 3 3v2c-3 0-5-2-5-5V7zm7 0h4v4h-3c0 2 1 3 3 3v2c-3 0-5-2-5-5V7z" /></Tool>
        <Tool on={!!marks.ul} label={d.pcBullets} onClick={() => cmd("insertUnorderedList")}><Icon d="M5 6.5a1.5 1.5 0 110 3 1.5 1.5 0 010-3zm0 6a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM9 7h11v2H9zm0 6h11v2H9z" /></Tool>
        <Tool on={!!marks.ol} label={d.pcNumbers} onClick={() => cmd("insertOrderedList")}><Icon d="M4 6h2v4H5V7H4zm0 7h3v1H5v.5h2V16H4v-1.5h2V14H4zM9 7h11v2H9zm0 6h11v2H9z" /></Tool>
        <span className="rt-sep" aria-hidden="true" />
        <Tool on={panel === "link"} label={d.pcLink} onClick={() => { setPanel(panel === "link" ? null : "link"); setUrl(""); }}><Icon d="M10.6 13.4a1 1 0 001.4 1.4l3.5-3.5a3 3 0 00-4.2-4.2l-1.2 1.2 1.4 1.4 1.2-1.2a1 1 0 011.4 1.4zm2.8-2.8a1 1 0 00-1.4-1.4l-3.5 3.5a3 3 0 004.2 4.2l1.2-1.2-1.4-1.4-1.2 1.2a1 1 0 01-1.4-1.4z" /></Tool>
        {canUpload && (
          <label className="rt-tool" title={d.pcPicture} aria-label={d.pcPicture} onMouseDown={(e) => e.preventDefault()}>
            <Icon d="M4 5h16v14H4zm2 2v8l3-3 3 3 3-4 3 4V7zm3 1.5a1.5 1.5 0 110 3 1.5 1.5 0 010-3z" />
            <input type="file" accept={IMAGE_ACCEPT} multiple className="visually-hidden-input" disabled={busy}
              onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ""; upload(fs, true); }} />
          </label>
        )}
        <Tool on={panel === "video"} label={d.pcVideo} onClick={() => { setPanel(panel === "video" ? null : "video"); setUrl(""); }}><Icon d="M4 6h12v12H4zm13 4l4-2.5v9L17 14z" /></Tool>
        {canUpload && (
          <label className="rt-tool" title={d.pcFile} aria-label={d.pcFile} onMouseDown={(e) => e.preventDefault()}>
            <Icon d="M14.5 4a3.5 3.5 0 013.5 3.5V15a6 6 0 01-12 0V8h2v7a4 4 0 008 0V7.5a1.5 1.5 0 00-3 0V15a1 1 0 01-2 0V7.5A3.5 3.5 0 0114.5 4z" />
            <input type="file" accept={FILE_ACCEPT} multiple className="visually-hidden-input" disabled={busy}
              onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ""; upload(fs, false); }} />
          </label>
        )}
      </div>

      {(panel === "link" || panel === "video") && (
        <div className="rt-panel row">
          <label htmlFor={`${idBase}-url`} className="sr-only">{panel === "link" ? d.pcLinkAddress : d.pcVideoAddress}</label>
          <input id={`${idBase}-url`} className="field grow" autoFocus value={url} onChange={(e) => setUrl(e.target.value)}
            placeholder={panel === "link" ? d.pcLinkAddress : d.pcVideoAddress} inputMode="url"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (panel === "link") addLink(); else addVideo(); } if (e.key === "Escape") setPanel(null); }} />
          <button type="button" className="btn btn-sm btn-primary" onClick={panel === "link" ? addLink : addVideo}>{d.pcAdd}</button>
          <button type="button" className="btn btn-sm" onClick={() => setPanel(null)}>{d.cancel}</button>
        </div>
      )}

      <div
        ref={ed}
        className="rt-editor"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        data-placeholder={label}
        data-empty={nodes.length === 0 ? "1" : undefined}
        onInput={sync}
        onKeyUp={(e) => { if (e.key === "Enter" || e.key === "Backspace") sync(); }}
        onClick={(e) => {
          const rm = (e.target as HTMLElement).closest("[data-remove]");
          if (rm) { rm.closest(".rt-embed")?.remove(); sync(); }
        }}
        onBlur={sync}
        onPaste={(e) => {
          const files = [...e.clipboardData.files];
          e.preventDefault();
          if (files.length && canUpload) { upload(files, true); return; }
          const text = e.clipboardData.getData("text/plain");
          if (text) document.execCommand("insertText", false, text);
          sync();
        }}
      />
      {busy && <p className="muted" style={{ margin: 0, fontSize: 13 }} role="status">{d.fileUploading}</p>}
      {note && <p className={`composer-note${note.bad ? " is-bad" : ""}`} role={note.bad ? "alert" : "status"}>{note.text}</p>}
    </div>
  );
}
