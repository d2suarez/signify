import Link from "next/link";
import { Fragment } from "react";
import { videoSrc, type Inline } from "@/lib/post-doc";
import type { Dict, Lang } from "@/lib/i18n";
import type { Post } from "@/lib/updates";
import { When } from "./When";
import { Lightbox } from "./Lightbox";

/**
 * A post document (post-doc.ts) as React, for Updates and anywhere else the
 * same document is shown (an assignment's rich instructions). Reads only.
 */

function Runs({ runs }: { runs: Inline[] }) {
  return (
    <>
      {runs.map((r, i) => {
        let el: React.ReactNode = r.text;
        if (r.b) el = <strong>{el}</strong>;
        if (r.i) el = <em>{el}</em>;
        if (r.u) el = <u>{el}</u>;
        if (r.href) el = <a href={r.href} target="_blank" rel="noopener noreferrer">{el}</a>;
        return <Fragment key={i}>{el}</Fragment>;
      })}
    </>
  );
}

/** A post's document, as React: no HTML from the post ever reaches the page. */
export function PostBody({ post, d, L }: { post: Pick<Post, "doc" | "materials">; d: Dict; L: Lang }) {
  const body = (
    <div className="post-body">
      {post.doc.nodes.map((n, i) => {
        switch (n.type) {
          case "p": return <p key={i}><Runs runs={n.content} /></p>;
          case "h": return <h4 key={i} className="post-h"><Runs runs={n.content} /></h4>;
          case "quote": return <blockquote key={i}><Runs runs={n.content} /></blockquote>;
          case "ul": return <ul key={i}>{n.items.map((it, j) => <li key={j}><Runs runs={it} /></li>)}</ul>;
          case "ol": return <ol key={i}>{n.items.map((it, j) => <li key={j}><Runs runs={it} /></li>)}</ol>;
          case "file":
            return n.kind === "image"
              ? <figure key={i} className="post-figure"><a className="post-figure-link" href={`/files/${n.fileId}`} target="_blank" rel="noopener"><img src={`/files/${n.fileId}`} alt={n.alt || n.name} loading="lazy" /></a></figure>
              : <a key={i} className="post-attach" href={`/files/${n.fileId}${n.kind === "doc" ? "" : ""}`} target="_blank" rel="noopener"><span aria-hidden="true">📎</span> {n.name || d.pcFile}</a>;
          case "video":
            return (
              <div key={i} className="post-video">
                <iframe src={videoSrc(n)} title={`${d.pcVideo} (${n.provider === "youtube" ? "YouTube" : "Vimeo"})`} loading="lazy"
                  allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                  referrerPolicy="strict-origin-when-cross-origin"
                  sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox" />
              </div>
            );
          case "material": {
            const m = post.materials[n.id];
            const kindWord = n.kind === "assignment" ? d.pcKindAssignment : n.kind === "lesson" ? d.pcKindLesson : n.kind === "folder" ? d.pcKindFolder : d.pcKindResource;
            const shape = n.kind === "assignment" ? "s-tri" : n.kind === "lesson" ? "s-arch" : "s-square";
            const inner = (
              <>
                <span className={`shape ${shape}`} aria-hidden="true" />
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="post-mat-title">{m?.elsewhere ? m.title || kindWord : m?.title || n.title || d.untitled}</span>
                  <span className="muted post-mat-sub">
                    {kindWord}{m?.courseName ? ` · ${m.courseName}` : ""}
                    {m?.dueAt && <> · {d.due} <When iso={m.dueAt} lang={L} /></>}
                    {m?.elsewhere ? ` · ${d.pcElsewhere}` : m?.gone ? ` · ${d.pcGone}` : m && !m.href ? ` · ${d.pcNotOpen}` : m?.draft ? ` · ${n.kind === "assignment" ? d.pcDraft : d.pcHiddenFromStudents}` : ""}
                  </span>
                </span>
                {m?.href && <span aria-hidden="true">→</span>}
              </>
            );
            return m?.href
              ? <Link key={i} href={m.href} className="post-mat">{inner}</Link>
              : <div key={i} className="post-mat is-off">{inner}</div>;
          }
        }
      })}
    </div>
  );
  // Pictures open over the page, paging through this post's pictures only.
  if (!post.doc.nodes.some((n) => n.type === "file" && n.kind === "image")) return body;
  return <Lightbox labels={{ title: d.lbTitle, close: d.close, prev: d.lbPrev, next: d.lbNext, count: d.lbCount, original: d.lbOriginal, zoomIn: d.lbZoomIn, zoomOut: d.lbZoomOut, hintOne: d.lbHintOne, hintMany: d.lbHintMany, hintHold: d.lbHintHold }}>{body}</Lightbox>;
}
