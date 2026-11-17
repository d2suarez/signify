import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMe, myClasses } from "@/lib/auth";
import { ctx, lang, isSchoolAdmin } from "@/lib/access";
import { myCourses } from "@/lib/courses";
import { dict } from "@/lib/i18n";
import { getCatalog } from "@/lib/sections";
import { TopBar } from "@/components/TopBar";
import { renameCourse } from "@/app/courses/[id]/section-actions";

export const dynamic = "force-dynamic";

/** One lasting course: its sections by year. Classes open only for whoever Signify ID says is in them now. */
export default async function CatalogCourse({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireMe();
  const { id } = await params;
  const L = await lang();
  const d = dict(L);
  const course = await getCatalog(ctx(me), id);
  const admin = isSchoolAdmin(me);
  if (!course || (!admin && !course.sections.some((s) => s.mine))) notFound();
  const { classes } = await myClasses();
  const open = new Set((await myCourses(me.tenantId, classes, me.id)).map((c) => c.id));
  return (
    <>
      <TopBar crumbs={<><Link href="/">{d.myCourses}</Link> · <Link href="/catalog">{d.secCatalogTitle}</Link></>} />
      <main className="page stack">
        <div>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>{course.subject}</p>
          <h1 style={{ fontSize: 34 }}>{course.name}</h1>
        </div>
        <section className="card stack" aria-labelledby="sections-title" style={{ gap: 8 }}>
          <h2 id="sections-title" className="label">{d.secSections}</h2>
          <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0, gap: 6 }}>
            {course.sections.map((s) => (
              <li key={s.id} className="row" style={{ gap: 8, minHeight: 44 }}>
                <strong style={{ minWidth: 90 }}>{s.schoolYear || d.secNoYear}</strong>
                {open.has(s.id) ? <Link href={`/courses/${s.id}`}>{s.name}</Link> : <span>{s.name}</span>}
                {s.mine && <span className="pill">{d.secYouTaught}</span>}
              </li>
            ))}
          </ul>
        </section>
        <details className="card">
          <summary className="btn btn-sm">{d.secRenameCourse}…</summary>
          <form action={renameCourse} className="row" style={{ marginTop: 10 }}>
            <input type="hidden" name="catalogId" value={course.id} />
            <label className="sr-only" htmlFor="course-name">{d.secCourseName}</label>
            <input id="course-name" name="name" className="field grow" defaultValue={course.name} maxLength={200} required />
            <button className="btn btn-primary" type="submit">{d.save}</button>
          </form>
        </details>
      </main>
    </>
  );
}
