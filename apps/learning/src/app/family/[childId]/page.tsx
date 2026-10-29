import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMe, myChildren } from "@/lib/auth";
import { ctx, lang } from "@/lib/access";
import { studentWork } from "@/lib/family";
import { dict } from "@/lib/i18n";
import { TopBar } from "@/components/TopBar";
import { CourseWorkCard } from "@/components/Work";

export const dynamic = "force-dynamic";

/**
 * A parent's view of one child: each course, its published work with due
 * dates and status, and released grades only. Which children this person has
 * is asked of Signify ID on every visit (verified links only); a child id in
 * the address that ID didn't name is simply not found.
 */
export default async function ChildPage({ params }: { params: Promise<{ childId: string }> }) {
  const me = await requireMe();
  const { childId } = await params;
  const L = await lang();
  const d = dict(L);
  const { ok, children } = await myChildren();
  if (!ok) {
    return (
      <>
        <TopBar crumbs={<Link href="/">{d.myCourses}</Link>} />
        <main className="page stack">
          <div className="notice notice-bad" role="alert">{d.childrenFailed} <a href={`/family/${childId}`}>{d.tryAgain}</a></div>
        </main>
      </>
    );
  }
  const child = children.find((c) => c.id === childId);
  if (!child) notFound();
  const work = await studentWork(ctx(me), child.classes, child.id);

  return (
    <>
      <TopBar crumbs={<><Link href="/">{d.yourChildren}</Link><span aria-hidden="true"> / </span><span>{child.display_name}</span></>} />
      <main className="page stack">
        <div className="row" style={{ alignItems: "flex-end" }}>
          <h1 style={{ fontSize: 34 }} className="grow">{child.display_name}</h1>
          <Link className="btn" href="/week">{d.thisWeek}</Link>
        </div>
        <p className="muted" style={{ margin: 0 }}>{d.parentNote}</p>
        {work.length === 0 && <p className="empty">{d.noCoursesChild}</p>}
        {work.map((w) => <CourseWorkCard key={w.course.id} w={w} d={d} L={L} />)}
      </main>
    </>
  );
}
