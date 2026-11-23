import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireMe } from "@/lib/auth";
import { courseAccess, ctx, lang } from "@/lib/access";
import { dict } from "@/lib/i18n";
import { getResource, updateResource, studentCanSee, type Who } from "@/lib/resources";
import { listUnits } from "@/lib/units";
import { materialKind } from "@/lib/material-kind";
import { TopBar } from "@/components/TopBar";
import LessonReader from "@/components/LessonReader";

export const dynamic = "force-dynamic";

async function toggle(formData: FormData) {
  "use server";
  const access = await courseAccess(String(formData.get("courseId") || ""));
  if (!access || access.course.role !== "teacher") return;
  const id = String(formData.get("id") || "");
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
export default async function MaterialPage({ params }: { params: Promise<{ id: string; rid: string }> }) {
  await requireMe();
  const { id, rid } = await params;
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
      <TopBar crumbs={<><Link href="/">{d.myCourses}</Link> · <Link href={`/courses/${course.id}`}>{course.name}</Link></>} />
      <main className="page stack" style={{ maxWidth: 900 }}>
        <div className="row" style={{ alignItems: "flex-end", flexWrap: "wrap", gap: 10 }}>
          <div style={{ flex: "1 1 16em", minWidth: 0 }}>
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>{materialKind(r.block, d)}{folder ? ` · ${folder.path}` : ""}</p>
            <h1 style={{ fontSize: "clamp(26px, 7vw, 34px)" }}>{r.title}</h1>
          </div>
          {teacher && (
            <div className="row" style={{ gap: 8 }}>
              <Link className="btn" href={`/courses/${course.id}/resources`}>{d.resTitle}</Link>
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
        {r.note && <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{r.note}</p>}
        <LessonReader blocks={[r.block]} d={d} />
        <p style={{ margin: 0 }}><Link href={`/courses/${course.id}`}>← {d.matBack}</Link></p>
      </main>
    </>
  );
}
