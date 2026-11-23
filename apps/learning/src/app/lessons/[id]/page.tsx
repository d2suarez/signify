import Link from "next/link";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireMe } from "@/lib/auth";
import { lessonAccess, lang, updatesViewer } from "@/lib/access";
import { dict } from "@/lib/i18n";
import { asView, setStudentView } from "@/lib/organize";
import { TopBar } from "@/components/TopBar";
import { ClassHeader } from "@/components/ClassHeader";
import LessonReader from "@/components/LessonReader";
import { studentBlocks, teacherBlocks } from "@/lib/lesson-assignments";
import { StudentViewSelect } from "@/components/Organize";

export const dynamic = "force-dynamic";

async function changeView(formData: FormData) {
  "use server";
  const access = await lessonAccess(String(formData.get("lessonId") || ""));
  const view = asView(formData.get("view"));
  if (!access || access.course.role !== "teacher" || !view) return;
  const viewer = await updatesViewer();
  if (!viewer) return;
  await setStudentView(viewer, access.course.id, [access.lesson.id], view);
  revalidatePath(`/lessons/${access.lesson.id}`);
  revalidatePath(`/courses/${access.course.id}`);
}

/**
 * A lesson as one page. Students open it when their teacher shows it to them
 * (in their unit list, or in the class's Updates); teachers always may, and
 * choose here what students see.
 */
export default async function ReadLesson({ params }: { params: Promise<{ id: string }> }) {
  await requireMe();
  const { id } = await params;
  const L = await lang();
  const d = dict(L);
  const access = await lessonAccess(id);
  if (!access) notFound();
  const { course, lesson } = access;
  const teacher = course.role === "teacher";
  if (!teacher && (course.role !== "student" || lesson.studentView === "hidden" || !lesson.studentView)) notFound();
  return (
    <>
      <TopBar crumbs={<Link href="/">{d.myCourses}</Link>} below={<ClassHeader course={course} d={d} />} />
      <main className="page stack" style={{ maxWidth: 900 }}>
        <div className="row" style={{ alignItems: "flex-end", flexWrap: "wrap", gap: 10 }}>
          <div style={{ flex: "1 1 16em", minWidth: 0 }}>
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>{d.pcKindLesson} · {course.name}</p>
            <h1 style={{ fontSize: "clamp(26px, 7vw, 34px)" }}>{lesson.title}</h1>
          </div>
          {teacher && (
            <div className="row" style={{ gap: 8 }}>
              <Link className="btn" href={`/lessons/${lesson.id}/edit`}>{d.edit}</Link>
              <Link className="btn btn-primary" href={`/lessons/${lesson.id}/present`}>{d.present}</Link>
            </div>
          )}
        </div>
        {teacher && (
          <form action={changeView} className="card row" style={{ padding: "10px 14px", gap: 10, flexWrap: "wrap" }}>
            <input type="hidden" name="lessonId" value={lesson.id} />
            <label className="label" htmlFor="sv-one">{d.svLabel}</label>
            <StudentViewSelect id="sv-one" name="view" value={lesson.studentView ?? "hidden"} d={d} autoSubmit />
          </form>
        )}
        <LessonReader blocks={teacher ? await teacherBlocks(access.me.tenantId, course.id, lesson.blocks) : await studentBlocks(access.me.tenantId, course.id, lesson.blocks, { studentId: access.me.id, live: false })} d={d} />
      </main>
    </>
  );
}
