import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { courseAccess, ctx, lang } from "@/lib/access";
import { requireMe } from "@/lib/auth";
import { listLessons, createLesson } from "@/lib/lessons";
import { liveLessonId } from "@/lib/live-ticket";
import { t } from "@/lib/i18n";
import { TopBar } from "@/components/TopBar";

export const dynamic = "force-dynamic";

async function newLesson(formData: FormData) {
  "use server";
  const courseId = String(formData.get("courseId") || "");
  const access = await courseAccess(courseId);
  if (!access || access.course.role !== "teacher") return;
  const lesson = await createLesson(ctx(access.me), courseId, String(formData.get("title") || ""));
  redirect(`/lessons/${lesson.id}/edit`);
}

export default async function CoursePage({ params }: { params: Promise<{ id: string }> }) {
  await requireMe();
  const { id } = await params;
  const L = await lang();
  const access = await courseAccess(id);
  if (!access) notFound();
  const { me, course } = access;
  const live = liveLessonId(course.id);

  if (course.role === "student") {
    return (
      <>
        <TopBar crumbs={<Link href="/">{t("myCourses", L)}</Link>} />
        <main className="page stack">
          <h1 style={{ fontSize: 34 }}>{course.name}</h1>
          {live
            ? <Link className="btn btn-primary" style={{ alignSelf: "flex-start" }} href={`/courses/${course.id}/live`}><span className="live-dot" />{t("joinLive", L)}</Link>
            : <p className="empty">{t("noLessonsStudent", L)}</p>}
        </main>
      </>
    );
  }

  const lessons = await listLessons(ctx(me), course.id);
  return (
    <>
      <TopBar crumbs={<Link href="/">{t("myCourses", L)}</Link>} />
      <main className="page stack">
        <div>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>{course.subject}</p>
          <h1 style={{ fontSize: 34 }}>{course.name}</h1>
        </div>

        <form action={newLesson} className="card row" style={{ padding: "14px 16px" }}>
          <input type="hidden" name="courseId" value={course.id} />
          <label htmlFor="new-title" className="label" style={{ flex: "none" }}>{t("newLesson", L)}</label>
          <input id="new-title" name="title" className="field" style={{ flex: "1 1 240px", width: "auto" }} placeholder={t("lessonTitle", L)} maxLength={200} required />
          <button className="btn btn-primary" type="submit">{t("create", L)}</button>
        </form>

        <section className="card">
          {lessons.length === 0 ? (
            <p className="empty">{t("noLessons", L)}</p>
          ) : (
            <ul className="list">
              {lessons.map((l) => (
                <li key={l.id}>
                  <div className="grow">
                    <h3>{l.title}</h3>
                    <span className="muted" style={{ fontSize: 13 }}>
                      {l.plannedFor ? `${l.plannedFor} · ` : ""}{l.durationMin} min · {l.blockCount} {t("blocks", L)}
                      {live === l.id ? " · " : ""}
                    </span>
                    {live === l.id && <span className="pill" style={{ marginLeft: 6 }}><span className="live-dot" />{t("liveNow", L)}</span>}
                  </div>
                  <Link className="btn" href={`/lessons/${l.id}/edit`}>{t("edit", L)}</Link>
                  <Link className="btn btn-primary" href={`/lessons/${l.id}/present`}>{t("present", L)}</Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}
