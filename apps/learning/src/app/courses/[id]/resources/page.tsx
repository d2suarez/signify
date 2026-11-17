import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { courseAccess, ctx, lang } from "@/lib/access";
import { requireMe } from "@/lib/auth";
import { listLessons, createLesson } from "@/lib/lessons";
import {
  listResources, archiveResource, moveResource, updateResource, createResource, blocksFromResources,
  studentCanSee, type Resource, type Who,
} from "@/lib/resources";
import { blockSummary, webLink } from "@/lib/blocks";
import { boardLink } from "@/lib/boards";
import { dict, type Dict } from "@/lib/i18n";
import { TopBar } from "@/components/TopBar";
import { CourseNav } from "@/components/CourseNav";
import { BLOCK_NAME as NAME, BLOCK_SHAPE as SHAPE } from "@/lib/block-kinds";
import ResourceForm from "@/components/ResourceForm";

export const dynamic = "force-dynamic";

async function teacher(formData: FormData): Promise<{ who: Who; courseId: string } | null> {
  const access = await courseAccess(String(formData.get("courseId") || ""));
  if (!access || access.course.role !== "teacher") return null;
  return { who: { ...ctx(access.me), role: "teacher" }, courseId: access.course.id };
}

async function act(formData: FormData) {
  "use server";
  const t = await teacher(formData);
  if (!t) return;
  const id = String(formData.get("id") || "");
  switch (formData.get("op")) {
    case "up": await moveResource(t.who, t.courseId, id, -1); break;
    case "down": await moveResource(t.who, t.courseId, id, 1); break;
    case "archive": await archiveResource(t.who, t.courseId, id, true); break;
    case "restore": await archiveResource(t.who, t.courseId, id, false); break;
    case "show": await updateResource(t.who, t.courseId, id, { visible: true }); break;
    case "hide": await updateResource(t.who, t.courseId, id, { visible: false }); break;
  }
  revalidatePath(`/courses/${t.courseId}/resources`);
}

async function addLessonResource(formData: FormData) {
  "use server";
  const t = await teacher(formData);
  if (!t) return;
  try { await createResource(t.who, t.courseId, { lessonId: String(formData.get("lessonId") || "") }); } catch { /* not this course's lesson */ }
  revalidatePath(`/courses/${t.courseId}/resources`);
}

/**
 * The ticked resources, in the library's order, become one new unscheduled
 * lesson, which is then presented live (or opened in the editor). A saved
 * lesson is what the presenter, the projector view and students' screens
 * already follow, so there is one presenter, not two.
 */
async function fromSelected(formData: FormData) {
  "use server";
  const t = await teacher(formData);
  if (!t) return;
  const picked = new Set(formData.getAll("pick").map(String));
  const order = (await listResources(t.who, t.courseId)).filter((r) => picked.has(r.id)).map((r) => r.id);
  const blocks = await blocksFromResources(t.who, t.courseId, order);
  if (!blocks.length) redirect(`/courses/${t.courseId}/resources?none=1`);
  const title = String(formData.get("title") || "").trim() || `${String(formData.get("fallback") || "Presentation")}`;
  const lesson = await createLesson(t.who, t.courseId, title, blocks);
  redirect(formData.get("op") === "edit" ? `/lessons/${lesson.id}/edit` : `/lessons/${lesson.id}/present`);
}

function kindWord(r: Resource, d: Dict) {
  return r.kind === "lesson" ? d.lesson : r.block ? d[NAME[r.block.type]] : "";
}

export default async function ResourcesPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ none?: string }>;
}) {
  await requireMe();
  const { id } = await params;
  const { none } = await searchParams;
  const L = await lang();
  const d = dict(L);
  const access = await courseAccess(id);
  if (!access) notFound();
  const { me, course } = access;
  const who: Who = { ...ctx(me), role: course.role };

  if (course.role !== "teacher") {
    const list = await listResources(who, course.id);
    return (
      <>
        <TopBar crumbs={<><Link href="/">{d.myCourses}</Link> · <Link href={`/courses/${course.id}`}>{course.name}</Link></>} />
        <main className="page stack">
          <h1 style={{ fontSize: 34 }}>{d.resTitle}</h1>
          <p className="muted" style={{ margin: 0 }}>{d.resIntroStudent}</p>
          {list.length === 0 ? <p className="empty">{d.resEmptyStudent}</p> : (
            <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {list.map((r) => <li key={r.id} className="card"><StudentResource r={r} d={d} /></li>)}
            </ul>
          )}
        </main>
      </>
    );
  }

  const [list, archived, lessons] = await Promise.all([
    listResources(who, course.id), listResources(who, course.id, { archived: true }), listLessons(who, course.id),
  ]);
  const inLibrary = new Set(list.map((r) => r.lessonId).filter(Boolean));
  const today = new Date().toLocaleDateString(L === "es" ? "es" : "en-US", { month: "short", day: "numeric" });

  return (
    <>
      <TopBar crumbs={<><Link href="/">{d.myCourses}</Link> · <Link href={`/courses/${course.id}`}>{course.name}</Link></>} />
      <main className="page stack">
        <div>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>{course.subject}</p>
          <h1 style={{ fontSize: 34 }}>{course.name}</h1>
        </div>
        <CourseNav courseId={course.id} current="resources" d={d} />

        <section className="card stack" aria-labelledby="res-title" style={{ gap: 12 }}>
          <h2 id="res-title" style={{ fontSize: 24 }}>{d.resTitle}</h2>
          <p className="muted" style={{ margin: 0 }}>{d.resIntro}</p>
          {none && <p className="notice" role="alert" style={{ margin: 0 }}>{d.resNoneTicked}</p>}
          {list.length === 0 ? <p className="empty">{d.resEmpty}</p> : (
            <>
              <form id="present-form" action={fromSelected} className="stack" style={{ gap: 8 }}>
                <input type="hidden" name="courseId" value={course.id} />
                <input type="hidden" name="fallback" value={`${d.resPresentation} · ${today}`} />
                <div className="row">
                  <label htmlFor="present-title" className="label" style={{ flex: "0 0 auto" }}>{d.resPresentTitle}</label>
                  <input id="present-title" name="title" className="field" style={{ flex: "1 1 220px", width: "auto" }} maxLength={200}
                    placeholder={`${d.resPresentation} · ${today}`} />
                  <button className="btn btn-primary" name="op" value="present">{d.resPresentSel}</button>
                  <button className="btn" name="op" value="edit">{d.resLessonSel}</button>
                </div>
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.resPresentHint}</p>
              </form>
              <ul className="list res-list">
                {list.map((r, i) => (
                  <li key={r.id} className="res-row">
                    <label className="check res-pick">
                      <input type="checkbox" name="pick" value={r.id} form="present-form" aria-label={`${d.resChoose}: ${r.title}`} />
                    </label>
                    <span className={`shape ${r.kind === "lesson" ? "s-arch" : SHAPE[r.block!.type]}`} aria-hidden="true" />
                    <div className="grow" style={{ minWidth: 0 }}>
                      <b>{r.title}</b> <span className="muted" style={{ fontSize: 13 }}>· {kindWord(r, d)}
                        {r.kind === "lesson" && (r.lesson ? ` · ${r.lesson.blockCount} ${d.blocks}` : ` · ${d.resLessonGone}`)}</span>
                      {r.block && blockSummary(r.block) && blockSummary(r.block) !== r.title && <div className="muted" style={{ fontSize: 14 }}>{blockSummary(r.block)}</div>}
                      {r.note && <div style={{ fontSize: 14, whiteSpace: "pre-wrap" }}>{r.note}</div>}
                      <div style={{ marginTop: 4 }}>
                        {r.visible
                          ? <span className="pill">{d.resShown}</span>
                          : <span className="pill pill-draft">{d.resHidden}</span>}
                      </div>
                      {r.kind === "block" && (
                        <details style={{ marginTop: 6 }}>
                          <summary className="link-btn">{d.edit}</summary>
                          <div style={{ marginTop: 8 }}>
                            <ResourceForm courseId={course.id} d={d} idBase={`r${i}`}
                              initial={{ id: r.id, title: r.title, note: r.note, visible: r.visible, block: r.block }} />
                          </div>
                        </details>
                      )}
                    </div>
                    <div className="row res-actions" style={{ gap: 6 }}>
                      {r.kind === "lesson" && r.lessonId && r.lesson && (
                        <>
                          <Link className="btn btn-sm" href={`/lessons/${r.lessonId}/present`}>{d.present}</Link>
                          <Link className="btn btn-sm" href={`/lessons/${r.lessonId}/edit`}>{d.resOpenLesson}</Link>
                        </>
                      )}
                      <form action={act} className="row" style={{ gap: 6 }}>
                        <input type="hidden" name="courseId" value={course.id} />
                        <input type="hidden" name="id" value={r.id} />
                        <button className="icon-btn" name="op" value="up" disabled={i === 0} aria-label={`${d.moveUp}: ${r.title}`}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M6 15l6-6 6 6" /></svg>
                        </button>
                        <button className="icon-btn" name="op" value="down" disabled={i === list.length - 1} aria-label={`${d.moveDown}: ${r.title}`}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
                        </button>
                        {studentCanSee(r) && (
                          <button className="btn btn-sm" name="op" value={r.visible ? "hide" : "show"}>{r.visible ? d.resHide : d.resShow}</button>
                        )}
                        <button className="btn btn-sm" name="op" value="archive">{d.archive}</button>
                      </form>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section className="card stack" aria-labelledby="res-add" style={{ gap: 10 }}>
          <h2 id="res-add" className="label">{d.resAdd}</h2>
          <ResourceForm courseId={course.id} d={d} />
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.resFromLessonHint}</p>
        </section>

        {lessons.length > 0 && (
          <section className="card" aria-labelledby="res-add-lesson">
            <form action={addLessonResource} className="row">
              <input type="hidden" name="courseId" value={course.id} />
              <h2 id="res-add-lesson" className="label" style={{ flex: "0 0 auto", margin: 0 }}>
                <label htmlFor="res-lesson">{d.resAddLesson}</label>
              </h2>
              <select id="res-lesson" name="lessonId" className="field" style={{ flex: "1 1 220px", width: "auto" }} required>
                {lessons.map((l) => (
                  <option key={l.id} value={l.id}>{l.title}{inLibrary.has(l.id) ? ` (${d.resAlready})` : ""}</option>
                ))}
              </select>
              <button className="btn">{d.add}</button>
            </form>
          </section>
        )}

        {archived.length > 0 && (
          <details className="card">
            <summary className="label">{d.resArchived} ({archived.length})</summary>
            <ul className="list" style={{ marginTop: 8 }}>
              {archived.map((r) => (
                <li key={r.id}>
                  <span className="grow">{r.title} <span className="muted" style={{ fontSize: 13 }}>· {kindWord(r, d)}</span></span>
                  <form action={act}>
                    <input type="hidden" name="courseId" value={course.id} />
                    <input type="hidden" name="id" value={r.id} />
                    <button className="btn btn-sm" name="op" value="restore">{d.resRestore}</button>
                  </form>
                </li>
              ))}
            </ul>
          </details>
        )}
      </main>
    </>
  );
}

function StudentResource({ r, d }: { r: Resource; d: Dict }) {
  const b = r.block!;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 8 }}>
        <span className={`shape ${SHAPE[b.type]}`} aria-hidden="true" />
        <h2 style={{ fontSize: 20, margin: 0 }} className="grow">{r.title}</h2>
        {b.type === "link" && webLink(b.url) && <a className="btn btn-sm" href={webLink(b.url)} target="_blank" rel="noopener noreferrer">{d.openLink} ↗</a>}
        {b.type === "board" && boardLink(b.url) && <a className="btn btn-sm" href={boardLink(b.url)!.url} target="_blank" rel="noopener noreferrer">{d.openBoard} ↗</a>}
      </div>
      {r.note && <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{r.note}</p>}
      {b.type === "text" && (
        <div>
          {b.title && b.title !== r.title && <h3 style={{ margin: "0 0 4px" }}>{b.title}</h3>}
          <div style={{ whiteSpace: "pre-wrap" }}>{b.body}</div>
        </div>
      )}
    </div>
  );
}
