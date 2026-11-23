import Link from "next/link";
import { Fragment } from "react";
import { videoSrc, type Inline } from "@/lib/post-doc";
import type { Dict, Lang } from "@/lib/i18n";
import type { Post, CourseRules } from "@/lib/updates";
import { When } from "./When";
import { Lightbox } from "./Lightbox";
import { moderate, courseRulesAction, markAllRead } from "@/app/updates/actions";

/** "Who · where · when" under a post or comment. */
export function Byline({ name, kind, iso, where, L, d }: { name: string; kind: "staff" | "student"; iso: string; where?: string; L: Lang; d: Dict }) {
  return (
    <span className="muted" style={{ fontSize: 13 }}>
      {name || (kind === "student" ? d.updStudent : d.updStaff)}
      {where ? ` · ${where}` : ""} · <When iso={iso} lang={L} />
    </span>
  );
}

/** The student posting switches a class's teachers see. */
export function CourseRulesForm({ courseId, rules, d }: { courseId: string; rules: CourseRules; d: Dict }) {
  return (
    <details>
      <summary className="label" style={{ cursor: "pointer", minHeight: 44, display: "flex", alignItems: "center" }}>{d.updStudentRules}</summary>
      <form action={courseRulesAction} className="stack" style={{ gap: 4 }}>
        <input type="hidden" name="courseId" value={courseId} />
        <label className="check-row"><input type="checkbox" name="studentPosts" defaultChecked={rules.studentPosts} /> {d.updStudentPosts}</label>
        <label className="check-row"><input type="checkbox" name="studentComments" defaultChecked={rules.studentComments} /> {d.updStudentComments}</label>
        <button className="btn btn-sm" type="submit" style={{ alignSelf: "flex-start" }}>{d.save}</button>
      </form>
    </details>
  );
}

const ERRORS: Record<string, keyof Dict> = { off: "updErrOff", empty: "updErrEmpty", forbidden: "updErrForbidden", notfound: "updErrForbidden" };
export function UpdateErrorNote({ code, d }: { code?: string; d: Dict }) {
  if (!code || !ERRORS[code]) return null;
  return <div className="notice notice-bad" role="alert">{d[ERRORS[code]]}</div>;
}

/**
 * A list of posts, newest activity first: each one whole (pictures, videos,
 * Learning links), unread marked with a word, not colour alone. `cards`:
 * each post its own card (the home page and /updates); otherwise rows
 * inside the caller's card (a class page).
 */
export function Feed({ posts, back, L, d, showWhere = true, empty, cards = false }: {
  posts: Post[]; back: string; L: Lang; d: Dict; showWhere?: boolean; empty?: string; cards?: boolean;
}) {
  if (!posts.length) return <p className={cards ? "card empty" : "empty"} style={{ margin: 0 }}>{empty ?? d.updNone}</p>;
  const unread = posts.filter((p) => p.unread);
  return (
    <div className={`stack feed${cards ? " feed-cards" : ""}`} style={{ gap: cards ? 14 : 6 }}>
      {unread.length > 0 && (
        <form action={markAllRead} className="row feed-unread" style={{ gap: 8 }}>
          <input type="hidden" name="back" value={back} />
          {unread.flatMap((p) => p.places.map((pl) => <input key={pl.postId} type="hidden" name="postId" value={pl.postId} />))}
          <span className="muted grow" style={{ fontSize: 14 }}>{unread.length} {unread.length === 1 ? d.updNewOne : d.updNewMany}</span>
          <button className="btn btn-sm" type="submit">{d.updMarkRead}</button>
        </form>
      )}
      {posts.map((p) => <PostCard key={p.id} p={p} back={back} L={L} d={d} showWhere={showWhere} card={cards} />)}
    </div>
  );
}

function PostCard({ p, back, L, d, showWhere, card }: { p: Post; back: string; L: Lang; d: Dict; showWhere: boolean; card: boolean }) {
  const long = p.doc.nodes.length > 8 || p.body.length > 900;
  return (
    <article className={`post${card ? " card" : ""}${p.unread ? " is-unread" : ""}`} aria-labelledby={`post-${p.id}`}>
      <header className="post-head">
        <span className={`post-avatar${p.authorKind === "student" ? " is-student" : ""}`} aria-hidden="true">{initials(p.authorName)}</span>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="post-who">
            <strong>{p.authorName || (p.authorKind === "student" ? d.updStudent : d.updStaff)}</strong>
            {showWhere && (
              <span className="post-where">
                <span aria-hidden="true"> ▸ </span><span className="sr-only">{d.pcPostedIn} </span>
                {p.places.map((pl, i) => (
                  <span key={pl.postId}>{i > 0 && ", "}<Link href={`/updates/${pl.postId}`}>{pl.courseId ? pl.courseName : d.updWholeSchool}</Link></span>
                ))}
              </span>
            )}
          </div>
          <span className="muted" style={{ fontSize: 13 }}><When iso={p.createdAt} lang={L} />{p.editedAt && <> · {d.pcEdited}</>}</span>
        </div>
        {p.unread && <span className="pill pill-new">{d.updNew}</span>}
        {p.status === "hidden" && <span className="pill">{d.updHidden}</span>}
      </header>
      {p.title
        ? <h3 id={`post-${p.id}`} className="post-title"><Link href={`/updates/${p.id}`}>{p.title}</Link></h3>
        : <span id={`post-${p.id}`} className="sr-only">{p.body.slice(0, 80)}</span>}
      <div className={long ? "post-clamp" : undefined}>
        <PostBody post={p} d={d} L={L} />
      </div>
      {long && <Link href={`/updates/${p.id}`} className="post-more">{d.pcReadMore}</Link>}
      <footer className="post-foot row">
        <Link href={`/updates/${p.id}`} className="btn btn-sm">
          {p.comments > 0 ? `${p.comments} ${p.comments === 1 ? d.updComment : d.updComments}` : p.canComment ? d.updCommentGo : d.pcOpen}
        </Link>
        <span className="grow" />
        {p.canEdit && <Link href={`/updates/${p.id}?edit=1&back=${encodeURIComponent(back)}`} className="btn btn-sm">{d.pcEdit}</Link>}
        {p.canModerate && (
          <form action={moderate} className="row" style={{ gap: 4 }}>
            <input type="hidden" name="postId" value={p.id} />
            <input type="hidden" name="back" value={back} />
            <button className="btn btn-sm" name="op" value={p.status === "hidden" ? "unhide" : "hide"} aria-label={`${p.status === "hidden" ? d.updUnhide : d.updHide}: ${p.title || p.body.slice(0, 40)}`}>
              {p.status === "hidden" ? d.updUnhide : d.updHide}
            </button>
          </form>
        )}
      </footer>
    </article>
  );
}

function initials(name: string): string {
  const w = name.trim().split(/\s+/).filter(Boolean);
  return ((w[0]?.[0] ?? "") + (w.length > 1 ? w[w.length - 1][0] : "")).toUpperCase() || "·";
}

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
            const kindWord = n.kind === "assignment" ? d.pcKindAssignment : n.kind === "lesson" ? d.pcKindLesson : d.pcKindResource;
            const shape = n.kind === "assignment" ? "s-tri" : n.kind === "lesson" ? "s-arch" : "s-square";
            const inner = (
              <>
                <span className={`shape ${shape}`} aria-hidden="true" />
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="post-mat-title">{m?.title || n.title || d.untitled}</span>
                  <span className="muted post-mat-sub">
                    {kindWord}{m?.courseName ? ` · ${m.courseName}` : ""}
                    {m?.dueAt && <> · {d.due} <When iso={m.dueAt} lang={L} /></>}
                    {m?.gone ? ` · ${d.pcGone}` : m && !m.href ? ` · ${d.pcNotOpen}` : m?.draft ? ` · ${n.kind === "resource" ? d.pcHiddenFromStudents : d.pcDraft}` : ""}
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
