import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireMe } from "@/lib/auth";
import { courseAccess, ctx, lang } from "@/lib/access";
import { dict } from "@/lib/i18n";
import { getResource, updateResource, archiveResource, studentCanSee, type Who } from "@/lib/resources";
import ResourceForm from "@/components/ResourceForm";
import { listUnits } from "@/lib/units";
import { materialKind } from "@/lib/material-kind";
import { TopBar } from "@/components/TopBar";
import { ClassHeader } from "@/components/ClassHeader";
import LessonReader from "@/components/LessonReader";

export const dynamic = "force-dynamic";

async function toggle(formData: FormData) {
  "use server";
  const access = await courseAccess(String(formData.get("courseId") || ""));
  if (!access || access.course.role !== "teacher") return;
  const id = String(formData.get("id") || "");
  if (formData.get("op") === "archive") {
    await archiveResource({ ...ctx(access.me), role: "teacher" }, access.course.id, id, true);
    revalidatePath(`/courses/${access.course.id}`);
    redirect(`/courses/${access.course.id}`);
  }
  await updateResource({ ...ctx(access.me), role: "teacher" }, access.course.id, id, { visible: formData.get("op") === "show" });
  revalidatePath(`/courses/${access.course.id}/materials/${id}`);
  revalidatePath(`/courses/${access.course.id}`);
}

/**
 * One material (a class resource, migration 027) as a page: what a folder's
 * row opens. Videos and Google files play in place, pictures and PDFs show,
 * other files download (LessonReader). Students reach it only when the
 * teacher shows it (getResource answers null otherwise); a material that
 * points at a lesson opens that lesson.
 */
export default async function MaterialPage({ params, searchParams }: { params: Promise<{ id: string; rid: string }>; searchParams: Promise<{ edit?: string }> }) {
  await requireMe();
  const [{ id, rid }, sp] = await Promise.all([params, searchParams]);
  const L = await lang();
  const d = dict(L);
  const access = await courseAccess(id);
  if (!access) notFound();
  const { me, course } = access;
  const who: Who = { ...ctx(me), role: course.role };
  const r = await getResource(who, course.id, rid);
  if (!r || r.archived) notFound();
  if (r.kind === "lesson" && r.lessonId) redirect(`/lessons/${r.lessonId}`);
  if (!r.block) notFound();
  const teacher = course.role === "teacher";
  const folder = r.unitId ? (await listUnits(who, course.id)).find((u) => u.id === r.unitId) : null;
  return (
    <>
      <TopBar crumbs={<Link href="/">{d.myCourses}</Link>} below={<ClassHeader course={course} d={d} />} />
      <main className="page stack" style={{ maxWidth: 900 }}>
        <div className="row" style={{ alignItems: "flex-end", flexWrap: "wrap", gap: 10 }}>
          <div style={{ flex: "1 1 16em", minWidth: 0 }}>
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>{materialKind(r.block, d)}{folder ? ` · ${folder.path}` : ""}</p>
            <h1 style={{ fontSize: "clamp(26px, 7vw, 34px)" }}>{r.title}</h1>
          </div>
          {teacher && (
            <div className="row" style={{ gap: 8 }}>
              {!sp.edit && <Link className="btn" href={`/courses/${course.id}/materials/${r.id}?edit=1`}>{d.edit}</Link>}
              {studentCanSee(r) && (
                <form action={toggle}>
                  <input type="hidden" name="courseId" value={course.id} />
                  <input type="hidden" name="id" value={r.id} />
                  <button className="btn" name="op" value={r.visible ? "hide" : "show"}>{r.visible ? d.resHide : d.resShow}</button>
                </form>
              )}
            </div>
          )}
        </div>
        {teacher && !r.visible && <p className="notice" style={{ margin: 0 }}>{d.matHiddenNote}</p>}
        {teacher && sp.edit && (
          <section className="card stack" aria-labelledby="mat-edit" style={{ gap: 10 }}>
            <h2 id="mat-edit" className="label">{d.edit}</h2>
            <ResourceForm courseId={course.id} d={d} idBase="mat" doneHref={`/courses/${course.id}/materials/${r.id}`}
              initial={{ id: r.id, title: r.title, note: r.note, visible: r.visible, block: r.block }} />
            <form action={toggle} className="row" style={{ gap: 8, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
              <input type="hidden" name="courseId" value={course.id} />
              <input type="hidden" name="id" value={r.id} />
              <button className="btn btn-sm" name="op" value="archive">{d.archive}</button>
              <span className="muted" style={{ fontSize: 13 }}>{d.crArchiveHint}</span>
            </form>
          </section>
        )}
        {r.note && <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{r.note}</p>}
        <LessonReader blocks={[r.block]} d={d} />
        <p style={{ margin: 0 }}><Link href={`/courses/${course.id}`}>← {d.matBack}</Link></p>
      </main>
    </>
  );
}
