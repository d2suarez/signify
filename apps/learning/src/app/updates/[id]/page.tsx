import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMe } from "@/lib/auth";
import { lang, updatesViewer } from "@/lib/access";
import { dict } from "@/lib/i18n";
import { thread, markRead, UPDATE_LIMITS } from "@/lib/updates";
import { TopBar } from "@/components/TopBar";
import { When } from "@/components/When";
import { Byline, UpdateErrorNote, PostBody } from "@/components/Updates";
import { commentOn, moderate } from "../actions";
import PostComposer from "@/components/PostComposer";
import { composerSetup } from "@/lib/composer";
import { myCourses } from "@/lib/courses";
import { myClasses } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** One post and its comments. Opening it marks it read. */
export default async function UpdateThread({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ updateError?: string; edit?: string; back?: string }> }) {
  const me = await requireMe();
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const L = await lang();
  const d = dict(L);
  const v = (await updatesViewer())!;
  const t = await thread(v, id);
  if (!t) notFound();
  await markRead(v, [t.post.id]);
  const { post, comments } = t;
  const here = `/updates/${post.id}`;
  // Where the post lives: its class page, or home for a whole-school post (no separate Updates page).
  const home = post.courseId ? `/courses/${post.courseId}` : "/";
  const where = post.courseId ? post.courseName : d.updWholeSchool;
  // The author changing it: the editor, filled with the post, in place of the post.
  const editing = sp.edit === "1" && post.canEdit;
  const backTo = sp.back && sp.back.startsWith("/") && !sp.back.startsWith("//") ? sp.back : here;
  const setup = editing ? await composerSetup(v, await myCourses(me.tenantId, (await myClasses()).classes, me.id), d.updWholeSchool) : null;
  const ModButtons = ({ commentId, status, label }: { commentId?: string; status: string; label: string }) => (
    <form action={moderate} className="row" style={{ gap: 4 }}>
      <input type="hidden" name="postId" value={post.id} />
      {commentId && <input type="hidden" name="commentId" value={commentId} />}
      <input type="hidden" name="back" value={here} />
      {!commentId && <input type="hidden" name="afterDelete" value={home} />}
      {(post.canModerate) && (
        <button className="btn btn-sm" name="op" value={status === "hidden" ? "unhide" : "hide"} aria-label={`${status === "hidden" ? d.updUnhide : d.updHide}: ${label}`}>
          {status === "hidden" ? d.updUnhide : d.updHide}
        </button>
      )}
      <button className="btn btn-sm" name="op" value="delete" aria-label={`${d.updDelete}: ${label}`}>{d.updDelete}</button>
    </form>
  );
  return (
    <>
      <TopBar crumbs={<><Link href="/">{d.myCourses}</Link>{post.courseId && <> · <Link href={`/courses/${post.courseId}`}>{post.courseName}</Link></>}</>} />
      <main className="page stack updates-page">
        <UpdateErrorNote code={sp.updateError} d={d} />
        {setup && (
          <div className="card composer-card">
            <PostComposer places={setup.places} materials={setup.materials} canUpload={setup.canUpload} uploadFallback={post.courseId && v.courses.get(post.courseId) === "teacher" ? post.courseId : setup.uploadFallback}
              d={d} placeholder={d.pcPlaceholderTeacher} back={backTo}
              editing={{ postId: post.id, title: post.title, nodes: post.doc.nodes, placeNames: post.places.map((pl) => (pl.courseId ? pl.courseName : d.updWholeSchool)), placeIds: post.places.map((pl) => pl.courseId ?? "school") }} />
          </div>
        )}
        {!setup && <article className="card stack post-thread" style={{ gap: 10 }}>
          {post.status === "hidden" && <div className="notice">{d.updHiddenNote}</div>}
          {post.title && <h1 style={{ fontSize: 28 }}>{post.title}</h1>}
          <PostBody post={post} d={d} L={L} />
          <Byline name={post.authorName} kind={post.authorKind} iso={post.createdAt} where={where} L={L} d={d} />
          {post.places.length > 1 && (
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              {d.pcAlsoPosted}{" "}
              {post.places.slice(1).map((pl, i) => (
                <span key={pl.postId}>{i > 0 && ", "}<Link href={`/updates/${pl.postId}`}>{pl.courseId ? pl.courseName : d.updWholeSchool}</Link></span>
              ))}
              {" · "}{d.pcOwnComments}
            </p>
          )}
          {post.editedAt && <span className="muted" style={{ fontSize: 13 }}>{d.pcEdited} · <When iso={post.editedAt} lang={L} /></span>}
          <div className="row" style={{ gap: 4 }}>
            {post.canEdit && <Link className="btn btn-sm" href={`${here}?edit=1`}>{d.pcEdit}</Link>}
            {(post.canModerate || post.authorId === v.userId) && <ModButtons status={post.status} label={post.title || post.body.slice(0, 40)} />}
          </div>
        </article>}

        {v.kind !== "parent" && (
          <section className="stack" aria-labelledby="comments-title" style={{ gap: 8 }}>
            <h2 id="comments-title" className="label">{comments.length} {comments.length === 1 ? d.updComment : d.updComments}</h2>
            <ul className="list">
              {comments.map((c) => (
                <li key={c.id} style={{ alignItems: "flex-start" }}>
                  <div className="grow" style={{ minWidth: 0 }}>
                    {c.status === "hidden" && <span className="pill" style={{ marginRight: 6 }}>{d.updHidden}</span>}
                    <span style={{ whiteSpace: "pre-wrap" }}>{c.body}</span>
                    <div><Byline name={c.authorName} kind={c.authorKind} iso={c.createdAt} L={L} d={d} /></div>
                  </div>
                  {c.canModerate && (post.canModerate
                    ? <ModButtons commentId={c.id} status={c.status} label={c.body.slice(0, 40)} />
                    : (
                      <form action={moderate}>
                        <input type="hidden" name="postId" value={post.id} />
                        <input type="hidden" name="commentId" value={c.id} />
                        <input type="hidden" name="back" value={here} />
                        <button className="btn btn-sm" name="op" value="delete" aria-label={`${d.updDelete}: ${c.body.slice(0, 40)}`}>{d.updDelete}</button>
                      </form>
                    ))}
                </li>
              ))}
            </ul>
            {post.canComment ? (
              <form action={commentOn} className="stack" style={{ gap: 8 }}>
                <input type="hidden" name="postId" value={post.id} />
                <label htmlFor="comment-body" className="label">{d.updAddComment}</label>
                <textarea id="comment-body" name="body" className="field" rows={2} maxLength={UPDATE_LIMITS.comment} required />
                <button className="btn btn-primary" type="submit" style={{ alignSelf: "flex-start" }}>{d.updCommentGo}</button>
              </form>
            ) : post.status === "visible" && <p className="muted" style={{ margin: 0 }}>{d.updCommentsOff}</p>}
          </section>
        )}
      </main>
    </>
  );
}
