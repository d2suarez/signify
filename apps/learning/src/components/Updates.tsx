import Link from "next/link";
import type { Dict, Lang } from "@/lib/i18n";
import type { Post, CourseRules } from "@/lib/updates";
import { UPDATE_LIMITS } from "@/lib/updates";
import { When } from "./When";
import { postUpdate, moderate, courseRulesAction, markAllRead } from "@/app/updates/actions";

/** "Who · where · when" under a post or comment. */
export function Byline({ name, kind, iso, where, L, d }: { name: string; kind: "staff" | "student"; iso: string; where?: string; L: Lang; d: Dict }) {
  return (
    <span className="muted" style={{ fontSize: 13 }}>
      {name || (kind === "student" ? d.updStudent : d.updStaff)}
      {where ? ` · ${where}` : ""} · <When iso={iso} lang={L} />
    </span>
  );
}

/** Writing a post: to `courseId`, or to the whole school when it is null. */
export function Composer({ courseId, back, d, label }: { courseId: string | null; back: string; d: Dict; label: string }) {
  const id = `upd-${courseId || "school"}`;
  return (
    <form action={postUpdate} className="stack" style={{ gap: 8 }}>
      <input type="hidden" name="courseId" value={courseId || "school"} />
      <input type="hidden" name="back" value={back} />
      <label htmlFor={`${id}-title`} className="sr-only">{d.title}</label>
      <input id={`${id}-title`} name="title" className="field" placeholder={`${d.title} (${d.optional})`} maxLength={UPDATE_LIMITS.title} />
      <label htmlFor={`${id}-body`} className="sr-only">{label}</label>
      <textarea id={`${id}-body`} name="body" className="field" rows={2} placeholder={label} maxLength={UPDATE_LIMITS.body} required />
      <button className="btn btn-primary" type="submit" style={{ alignSelf: "flex-start" }}>{d.updPost}</button>
    </form>
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

/** A list of posts: unread marked with a word, not colour alone; each opens its thread. */
export function Feed({ posts, back, L, d, showWhere = true, empty }: {
  posts: Post[]; back: string; L: Lang; d: Dict; showWhere?: boolean; empty?: string;
}) {
  if (!posts.length) return <p className="empty" style={{ margin: 0 }}>{empty ?? d.updNone}</p>;
  const unread = posts.filter((p) => p.unread);
  return (
    <div className="stack" style={{ gap: 6 }}>
      {unread.length > 0 && (
        <form action={markAllRead} className="row" style={{ gap: 8 }}>
          <input type="hidden" name="back" value={back} />
          {unread.map((p) => <input key={p.id} type="hidden" name="postId" value={p.id} />)}
          <span className="muted grow" style={{ fontSize: 14 }}>{unread.length} {unread.length === 1 ? d.updNewOne : d.updNewMany}</span>
          <button className="btn btn-sm" type="submit">{d.updMarkRead}</button>
        </form>
      )}
      <ul className="list announcements">
        {posts.map((p) => (
          <li key={p.id} style={{ alignItems: "flex-start" }} className={p.unread ? "is-unread" : undefined}>
            <span className={`shape ${p.courseId ? "s-square" : "s-circle"}`} aria-hidden="true" style={{ marginTop: 6 }} />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="row" style={{ gap: 6 }}>
                {p.unread && <span className="pill pill-new">{d.updNew}</span>}
                {p.status === "hidden" && <span className="pill">{d.updHidden}</span>}
                <Link href={`/updates/${p.id}`} style={{ fontWeight: 600 }}>{p.title || p.body.slice(0, 80) + (p.body.length > 80 ? "…" : "")}</Link>
              </div>
              {p.title && <p style={{ whiteSpace: "pre-wrap", margin: "4px 0 0" }}>{p.body.length > 400 ? p.body.slice(0, 400) + "…" : p.body}</p>}
              <Byline name={p.authorName} kind={p.authorKind} iso={p.createdAt} where={showWhere ? (p.courseId ? p.courseName : d.updWholeSchool) : undefined} L={L} d={d} />
              {p.comments > 0 && <span className="muted" style={{ fontSize: 13 }}> · <Link href={`/updates/${p.id}`}>{p.comments} {p.comments === 1 ? d.updComment : d.updComments}</Link></span>}
            </div>
            {p.canModerate && (
              <form action={moderate} className="row" style={{ gap: 4 }}>
                <input type="hidden" name="postId" value={p.id} />
                <input type="hidden" name="back" value={back} />
                <button className="btn btn-sm" name="op" value={p.status === "hidden" ? "unhide" : "hide"} aria-label={`${p.status === "hidden" ? d.updUnhide : d.updHide}: ${p.title || p.body.slice(0, 40)}`}>
                  {p.status === "hidden" ? d.updUnhide : d.updHide}
                </button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
