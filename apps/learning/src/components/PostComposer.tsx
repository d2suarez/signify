"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Dict } from "@/lib/i18n";
import type { MaterialChoice } from "@/lib/updates";
import { videoFromUrl, safeHref, type DocNode, type Inline } from "@/lib/post-doc";
import { postRichUpdate, editRichUpdate } from "@/app/updates/actions";

export type ComposerPlace = { id: string; name: string; kind: "school" | "class" | "club"; teach: boolean };

const IMAGE_ACCEPT = ".png,.jpg,.jpeg,.gif,.webp";
const FILE_ACCEPT = ".pdf,.png,.jpg,.jpeg,.gif,.webp,.docx,.pptx,.xlsx,.txt,.csv,.mp3,.m4a,.mp4";
const MAX = 25 * 1024 * 1024;

/**
 * Writing an update. A one-line box until it's clicked; then it opens into a
 * small rich-text editor (bold, italic, underline, heading, quote, lists,
 * links), with pictures and files (uploaded here), YouTube/Vimeo videos and
 * links to the class's own assignments, lessons and resources, and a choice
 * of every class, club (and maybe the whole school) to post it to.
 *
 * The editor never sends HTML: what's on screen is turned into the post
 * document (post-doc.ts) on every change, and the server normalises it again.
 */
export default function PostComposer({ places, preselected = [], materials = [], canUpload, uploadFallback, d, placeholder, back, editing }: {
  places: ComposerPlace[]; preselected?: string[]; materials?: MaterialChoice[];
  canUpload: boolean; uploadFallback?: string | null; d: Dict; placeholder: string; back: string;
  /** Changing an existing update: its id, title and document; the places stay as they are ("school" = the whole school). */
  editing?: { postId: string; title: string; nodes: DocNode[]; placeNames: string[]; placeIds: string[] };
}) {
  const router = useRouter();
  const ed = useRef<HTMLDivElement>(null);
  const range = useRef<Range | null>(null);
  const [open, setOpen] = useState(!!editing);
  const [title, setTitle] = useState(editing?.title ?? "");
  const [to, setTo] = useState<Set<string>>(() => new Set(preselected.length ? preselected : places.length === 1 ? [places[0].id] : []));
  const [nodes, setNodes] = useState<DocNode[]>([]);
  const [panel, setPanel] = useState<null | "link" | "video" | "material">(null);
  const [url, setUrl] = useState("");
  const [query, setQuery] = useState("");
  const [note, setNote] = useState<{ bad: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<"" | "upload" | "post">("");
  const [marks, setMarks] = useState<Record<string, boolean>>({});
  const idBase = useMemo(() => `pc-${Math.random().toString(36).slice(2, 8)}`, []);

  const names = useMemo(() => new Map(places.map((p) => [p.id, p.name])), [places]);
  const classes = places.filter((p) => p.kind !== "school");
  // "Link from Learning" needs exactly one class the person teaches, and lists
  // only that class's materials; once one is linked, the places are locked to
  // that class until it's removed (Desmond, 2026-11-23; the server refuses too).
  const chosen = editing ? editing.placeIds : [...to];
  const matClass = chosen.length === 1 && places.some((p) => p.id === chosen[0] && p.teach && p.kind !== "school") ? chosen[0] : null;
  const hasMat = nodes.some((n) => n.type === "material");

  const sync = useCallback(() => { if (ed.current) setNodes(serialize(ed.current)); }, []);

  useEffect(() => {
    if (!editing || !ed.current) return;
    ed.current.replaceChildren(...editing.nodes.map((n) => nodeEl(n, d)));
    setNodes(serialize(ed.current));
    ed.current.focus();
    // Only once: what's typed after this is the person's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    try { document.execCommand("styleWithCSS", false, "false"); document.execCommand("defaultParagraphSeparator", false, "p"); } catch { /* old browser */ }
    const onSel = () => {
      const sel = document.getSelection();
      if (!sel || !sel.rangeCount || !ed.current?.contains(sel.anchorNode)) return;
      range.current = sel.getRangeAt(0).cloneRange();
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

  /** Puts an embed after the block the caret is in (or at the end), with an empty line after it. */
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

  const uploadTo = () => {
    const firstTaught = places.find((p) => to.has(p.id) && p.teach && p.kind !== "school");
    return firstTaught ? firstTaught.id : to.has("school") ? "" : uploadFallback || "";
  };
  const upload = async (files: File[], asImage: boolean) => {
    for (const file of files) {
      if (file.size > MAX) { setNote({ bad: true, text: `${file.name}: ${d.fileTooBig}` }); continue; }
      setBusy("upload");
      try {
        const c = uploadTo();
        const res = await fetch(`/api/updates/files${c ? `?course=${encodeURIComponent(c)}` : ""}`, {
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
        setBusy("");
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
      else ed.current?.appendChild(Object.assign(document.createElement("p"), { innerHTML: "" })).appendChild(a);
    }
    setUrl(""); setPanel(null); setNote(null); sync();
  };
  const addVideo = () => {
    const v = videoFromUrl(url);
    if (!v) { setNote({ bad: true, text: d.pcBadVideo }); return; }
    insertEmbed({ type: "video", ...v });
    setUrl(""); setPanel(null); setNote(null);
  };
  const addMaterial = (m: MaterialChoice) => {
    insertEmbed({ type: "material", kind: m.kind, id: m.id, title: m.title });
    setPanel(null); setQuery("");
  };

  const reset = () => {
    if (editing) { router.push(back); return; }
    if (ed.current) ed.current.innerHTML = "";
    setNodes([]); setTitle(""); setPanel(null); setUrl(""); setNote(null); setOpen(false);
    setTo(new Set(preselected.length ? preselected : places.length === 1 ? [places[0].id] : []));
  };

  const empty = nodes.length === 0;
  const submit = async () => {
    if (!editing && !to.size) { setNote({ bad: true, text: d.pcPickPlace }); return; }
    const doc = ed.current ? serialize(ed.current) : [];
    if (!doc.length) { setNote({ bad: true, text: d.updErrEmpty }); return; }
    setBusy("post");
    const fd = new FormData();
    if (editing) fd.set("postId", editing.postId);
    else for (const id of to) fd.append("to", id);
    fd.set("title", title);
    fd.set("doc", JSON.stringify({ v: 1, nodes: doc }));
    fd.set("back", back);
    const r = await (editing ? editRichUpdate(fd) : postRichUpdate(fd)).catch(() => ({ error: "failed" as const }));
    setBusy("");
    if ("error" in r) { setNote({ bad: true, text: ({ off: d.updErrOff, empty: d.updErrEmpty, forbidden: d.updErrForbidden, noplace: d.pcPickPlace, notfound: d.updErrForbidden, material: d.pcErrMaterial } as Record<string, string>)[r.error] ?? d.fileFailed }); return; }
    if (editing) { router.push(back); router.refresh(); return; }
    reset();
    setNote({ bad: false, text: r.count > 1 ? d.pcPostedMany.replace("{n}", String(r.count)) : d.pcPosted });
    router.refresh();
  };

  const toggle = (id: string) => { if (hasMat) return; setTo((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }); };
  const allOn = classes.length > 0 && classes.every((c) => to.has(c.id));

  const shownMaterials = useMemo(() => {
    if (!matClass) return [];
    const q = query.trim().toLowerCase();
    return materials
      .filter((m) => m.courseId === matClass)
      .filter((m) => !q || m.title.toLowerCase().includes(q))
      .slice(0, 80);
  }, [materials, matClass, query]);

  return (
    <div className={`composer${open ? " is-open" : ""}`}>
      {open && (
        <>
          <label htmlFor={`${idBase}-title`} className="sr-only">{d.title}</label>
          <input id={`${idBase}-title`} className="composer-title" placeholder={`${d.title} (${d.optional})`} maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        </>
      )}
      {open && (
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
              <input type="file" accept={IMAGE_ACCEPT} multiple className="visually-hidden-input" disabled={!!busy}
                onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ""; upload(fs, true); }} />
            </label>
          )}
          <Tool on={panel === "video"} label={d.pcVideo} onClick={() => { setPanel(panel === "video" ? null : "video"); setUrl(""); }}><Icon d="M4 6h12v12H4zm13 4l4-2.5v9L17 14z" /></Tool>
          {canUpload && (
            <label className="rt-tool" title={d.pcFile} aria-label={d.pcFile} onMouseDown={(e) => e.preventDefault()}>
              <Icon d="M14.5 4a3.5 3.5 0 013.5 3.5V15a6 6 0 01-12 0V8h2v7a4 4 0 008 0V7.5a1.5 1.5 0 00-3 0V15a1 1 0 01-2 0V7.5A3.5 3.5 0 0114.5 4z" />
              <input type="file" accept={FILE_ACCEPT} multiple className="visually-hidden-input" disabled={!!busy}
                onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ""; upload(fs, false); }} />
            </label>
          )}
          {materials.length > 0 && (
            <button type="button" className={`rt-tool rt-tool-wide${panel === "material" ? " is-on" : ""}`} aria-pressed={panel === "material"}
              aria-disabled={!matClass} title={matClass ? undefined : d.pcOneClassFirst}
              onMouseDown={(e) => e.preventDefault()} onClick={() => {
                if (!matClass) { setPanel(null); setNote({ bad: false, text: d.pcOneClassFirst }); return; }
                setPanel(panel === "material" ? null : "material"); setQuery("");
              }}>
              <span className="shape s-tri" aria-hidden="true" /> {d.pcFromLearning}
            </button>
          )}
        </div>
      )}

      {open && (panel === "link" || panel === "video") && (
        <div className="rt-panel row">
          <label htmlFor={`${idBase}-url`} className="sr-only">{panel === "link" ? d.pcLinkAddress : d.pcVideoAddress}</label>
          <input id={`${idBase}-url`} className="field grow" autoFocus value={url} onChange={(e) => setUrl(e.target.value)}
            placeholder={panel === "link" ? d.pcLinkAddress : d.pcVideoAddress} inputMode="url"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (panel === "link") addLink(); else addVideo(); } if (e.key === "Escape") setPanel(null); }} />
          <button type="button" className="btn btn-sm btn-primary" onClick={panel === "link" ? addLink : addVideo}>{d.pcAdd}</button>
          <button type="button" className="btn btn-sm" onClick={() => setPanel(null)}>{d.cancel}</button>
        </div>
      )}

      {open && panel === "material" && matClass && (
        <div className="rt-panel stack" style={{ gap: 8 }}>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.pcMaterialsOf.replace("{c}", names.get(matClass) || "")}</p>
          <label htmlFor={`${idBase}-mq`} className="sr-only">{d.pcFindMaterial}</label>
          <input id={`${idBase}-mq`} className="field" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={d.pcFindMaterial}
            onKeyDown={(e) => { if (e.key === "Escape") setPanel(null); }} />
          {shownMaterials.length === 0 ? <p className="muted" style={{ margin: 0, fontSize: 14 }}>{d.pcNoMaterial}</p> : (
            <ul className="rt-materials">
              {shownMaterials.map((m) => (
                <li key={`${m.kind}:${m.id}`}>
                  <button type="button" onClick={() => addMaterial(m)}>
                    <span className={`shape ${m.kind === "assignment" ? "s-tri" : m.kind === "lesson" ? "s-arch" : "s-square"}`} aria-hidden="true" />
                    <span className="grow" style={{ minWidth: 0 }}>
                      <span className="rt-mat-title">{m.title || d.untitled}</span>
                      <span className="muted rt-mat-sub">
                        {m.kind === "assignment" ? d.pcKindAssignment : m.kind === "lesson" ? d.pcKindLesson : m.kind === "folder" ? d.pcKindFolder : d.pcKindResource}
                        {m.draft && ` · ${m.kind === "resource" ? d.pcHiddenFromStudents : d.pcDraft}`}
                        {m.dueAt && <> · {d.due} {new Date(m.dueAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</>}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div
        ref={ed}
        className="rt-editor"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={placeholder}
        data-placeholder={placeholder}
        data-empty={empty ? "1" : undefined}
        onFocus={() => setOpen(true)}
        onInput={sync}
        onClick={(e) => {
          const rm = (e.target as HTMLElement).closest("[data-remove]");
          if (rm) { rm.closest(".rt-embed")?.remove(); sync(); }
        }}
        onPaste={(e) => {
          const files = [...e.clipboardData.files];
          e.preventDefault();
          if (files.length && canUpload) { upload(files, true); return; }
          const text = e.clipboardData.getData("text/plain");
          if (text) document.execCommand("insertText", false, text);
          sync();
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submit(); }
        }}
      />

      {editing && (
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          {d.pcEditingIn} {editing.placeNames.join(", ")}{editing.placeNames.length > 1 ? ` · ${d.pcEditAll}` : ""}
        </p>
      )}
      {open && !editing && (
        <fieldset className="composer-to">
          <legend className="label">{d.pcPostTo}</legend>
          <div className="row" style={{ gap: 6 }}>
            {places.map((p) => (
              <label key={p.id} className={`to-chip${to.has(p.id) ? " is-on" : ""}${hasMat ? " is-locked" : ""}`}>
                <input type="checkbox" checked={to.has(p.id)} onChange={() => toggle(p.id)} disabled={hasMat} />
                <span className={`shape ${p.kind === "school" ? "s-circle" : p.kind === "club" ? "s-arch" : "s-square"}`} aria-hidden="true" />
                {p.name}
              </label>
            ))}
            {classes.length > 1 && !hasMat && (
              <button type="button" className="btn btn-sm" onClick={() => setTo((s) => {
                const n = new Set(s);
                for (const c of classes) { if (allOn) n.delete(c.id); else n.add(c.id); }
                return n;
              })}>{allOn ? d.pcNone : d.pcAllClasses}</button>
            )}
          </div>
          {hasMat && <p className="muted" style={{ margin: "6px 0 0", fontSize: 13 }}>{d.pcPlacesLocked.replace("{c}", [...to].map((id) => names.get(id)).filter(Boolean).join(", "))}</p>}
        </fieldset>
      )}

      {note && <p className={`composer-note${note.bad ? " is-bad" : ""}`} role={note.bad ? "alert" : "status"}>{note.text}</p>}

      {open && (
        <div className="row composer-actions">
          <span className="muted grow" style={{ fontSize: 13 }}>
            {busy === "upload" ? d.fileUploading : editing ? "" : to.size ? `${d.pcGoingTo} ${[...to].map((id) => names.get(id)).filter(Boolean).join(", ")}` : d.pcPickPlace}
          </span>
          <button type="button" className="btn btn-sm" onClick={reset} disabled={busy === "post"}>{d.cancel}</button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={!!busy || empty || (!editing && !to.size)}>
            {busy === "post" ? d.saving : editing ? d.pcSaveChanges : d.updPost}
          </button>
        </div>
      )}
    </div>
  );
}

/** A toolbar button. Pressing it never takes the caret out of the editor. */
export function Tool({ on, label, onClick, children }: { on?: boolean; label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className={`rt-tool${on ? " is-on" : ""}`} aria-label={label} title={label} aria-pressed={on === undefined ? undefined : on}
      onMouseDown={(e) => e.preventDefault()} onClick={onClick}>{children}</button>
  );
}

export function Icon({ d }: { d: string }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d={d} fill="currentColor" /></svg>;
}

/** A saved node back into the editor, so an update can be changed. */
export function nodeEl(n: DocNode, d: Dict): HTMLElement {
  const runs = (parent: HTMLElement, rs: Inline[]) => {
    for (const r of rs) {
      let el: Node = document.createDocumentFragment();
      r.text.split("\n").forEach((part, i) => {
        if (i > 0) el.appendChild(document.createElement("br"));
        if (part) el.appendChild(document.createTextNode(part));
      });
      for (const [on, tag] of [[r.u, "u"], [r.i, "i"], [r.b, "b"]] as const) {
        if (!on) continue;
        const w = document.createElement(tag); w.appendChild(el); el = w;
      }
      if (r.href) { const a = document.createElement("a"); a.href = r.href; a.appendChild(el); el = a; }
      parent.appendChild(el);
    }
    return parent;
  };
  switch (n.type) {
    case "p": return runs(document.createElement("p"), n.content);
    case "h": return runs(document.createElement("h3"), n.content);
    case "quote": return runs(document.createElement("blockquote"), n.content);
    case "ul": case "ol": {
      const list = document.createElement(n.type);
      for (const it of n.items) list.appendChild(runs(document.createElement("li"), it));
      return list;
    }
    default: {
      const box = embedEl(n, d);
      if (n.type === "file") { const alt = box.querySelector<HTMLInputElement>("[data-alt]"); if (alt) alt.value = n.alt; }
      return box;
    }
  }
}

/** The non-editable box for a picture, file, video or Learning link inside the editor. */
export function embedEl(node: DocNode, d: Dict): HTMLElement {
  const box = document.createElement("div");
  box.className = `rt-embed rt-embed-${node.type}`;
  box.contentEditable = "false";
  box.dataset.node = JSON.stringify(node);
  const main = document.createElement("div");
  main.className = "rt-embed-main";
  if (node.type === "file" && node.kind === "image") {
    const img = document.createElement("img");
    img.src = `/files/${node.fileId}`; img.alt = "";
    main.appendChild(img);
    const alt = document.createElement("input");
    alt.className = "field rt-alt"; alt.dataset.alt = "1"; alt.maxLength = 300;
    alt.placeholder = d.pcDescribe; alt.setAttribute("aria-label", d.pcDescribe);
    main.appendChild(alt);
  } else {
    const label = document.createElement("span");
    label.className = "rt-embed-label";
    const icon = node.type === "video" ? "▶" : node.type === "material" ? (node.kind === "assignment" ? "▲" : node.kind === "lesson" ? "◗" : node.kind === "folder" ? "▤" : "■") : "📎";
    const what = node.type === "video" ? `${d.pcVideo} · ${node.provider === "youtube" ? "YouTube" : "Vimeo"}`
      : node.type === "material" ? node.title || d.untitled
      : node.type === "file" ? node.name : "";
    label.textContent = `${icon}  ${what}`;
    main.appendChild(label);
    if (node.type === "video") {
      const thumb = document.createElement("span");
      thumb.className = "muted rt-embed-sub";
      thumb.textContent = node.provider === "youtube" ? `youtu.be/${node.id}` : `vimeo.com/${node.id}`;
      main.appendChild(thumb);
    }
  }
  box.appendChild(main);
  const rm = document.createElement("button");
  rm.type = "button"; rm.className = "rt-remove"; rm.dataset.remove = "1";
  rm.setAttribute("aria-label", d.pcRemove); rm.title = d.pcRemove; rm.textContent = "×";
  box.appendChild(rm);
  return box;
}

const BLOCKS = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "BLOCKQUOTE", "PRE"]);

/** What's in the editor → the post document's nodes. Only known shapes come out. */
export function serialize(root: HTMLElement): DocNode[] {
  const out: DocNode[] = [];
  let loose: Inline[] | null = null;
  const flush = () => { if (loose && loose.some((r) => r.text.trim())) out.push({ type: "p", content: trim(loose) }); loose = null; };
  const walk = (parent: Node) => {
    for (const n of [...parent.childNodes]) {
      if (n.nodeType === Node.ELEMENT_NODE) {
        const el = n as HTMLElement;
        if (el.dataset.node) {
          flush();
          try {
            const node = JSON.parse(el.dataset.node) as DocNode;
            if (node.type === "file") node.alt = (el.querySelector<HTMLInputElement>("[data-alt]")?.value || "").trim();
            out.push(node);
          } catch { /* skip */ }
          continue;
        }
        const tag = el.tagName;
        if (tag === "BR" && parent === root) { flush(); continue; }
        if (BLOCKS.has(tag)) {
          flush();
          if (tag === "UL" || tag === "OL") {
            const items = [...el.children].filter((c) => c.tagName === "LI").map((li) => trim(inline(li))).filter((it) => it.some((r) => r.text.trim()));
            if (items.length) out.push({ type: tag === "UL" ? "ul" : "ol", items });
          } else if ([...el.children].some((c) => BLOCKS.has(c.tagName) || (c as HTMLElement).dataset?.node)) {
            walk(el);
          } else {
            const content = trim(inline(el));
            if (content.some((r) => r.text.trim())) out.push({ type: /^H\d$/.test(tag) ? "h" : tag === "BLOCKQUOTE" ? "quote" : "p", content });
          }
          continue;
        }
      }
      loose ??= [];
      loose.push(...inline(n));
    }
  };
  walk(root);
  flush();
  return out;
}

function inline(n: Node, m: Omit<Inline, "text"> = {}): Inline[] {
  if (n.nodeType === Node.TEXT_NODE) return n.textContent ? [{ text: n.textContent.replace(/ /g, " "), ...m }] : [];
  if (n.nodeType !== Node.ELEMENT_NODE) return [];
  const el = n as HTMLElement;
  if (el.dataset.node) return [];
  const tag = el.tagName;
  if (tag === "BR") return [{ text: "\n", ...m }];
  const next = { ...m };
  if (tag === "B" || tag === "STRONG" || /bold|[6-9]00/.test(el.style?.fontWeight || "")) next.b = true;
  if (tag === "I" || tag === "EM" || el.style?.fontStyle === "italic") next.i = true;
  if (tag === "U" || /underline/.test(el.style?.textDecoration || "")) next.u = true;
  if (tag === "A") { const h = safeHref(el.getAttribute("href")); if (h) next.href = h; }
  const runs = [...el.childNodes].flatMap((c) => inline(c, next));
  // A block inside a line (a pasted div) still breaks the line.
  if (BLOCKS.has(tag) || tag === "LI") runs.push({ text: "\n", ...m });
  return runs;
}

function trim(rs: Inline[]): Inline[] {
  const out = rs.map((r) => ({ ...r }));
  while (out.length && !out[0].text.replace(/^[\s\n]+/, "")) out.shift();
  while (out.length && !out[out.length - 1].text.replace(/[\s\n]+$/, "")) out.pop();
  if (out.length) { out[0].text = out[0].text.replace(/^[\s\n]+/, ""); out[out.length - 1].text = out[out.length - 1].text.replace(/[\s\n]+$/, ""); }
  return out;
}
