import Link from "next/link";
import { requireMe, myClasses, myChildren } from "@/lib/auth";
import { ctx, lang } from "@/lib/access";
import { studentWork, studentCourses, weekSummary, recentNews } from "@/lib/family";
import { todayIn } from "@/lib/planner";
import { dict } from "@/lib/i18n";
import { TopBar } from "@/components/TopBar";
import { WeekCard } from "@/components/Work";
import { When } from "@/components/When";

export const dynamic = "force-dynamic";

const SCHOOL_TZ = "America/New_York";

/**
 * "This week": for a student, their own week; for a parent, each child's.
 * What needs attention, what is due, grades released in the last seven days,
 * what's next, and recent announcements. In the app only: production has no
 * mail (Railway's plan blocks SMTP), so nothing is emailed.
 */
export default async function WeekPage() {
  const me = await requireMe();
  const L = await lang();
  const d = dict(L);
  const c = ctx(me);
  const today = todayIn(SCHOOL_TZ);
  const now = new Date();

  const [{ ok: classesOk, classes }, { ok: childrenOk, children }] = await Promise.all([myClasses(), myChildren()]);
  const ownClasses = classes.filter((k) => k.role === "student");
  const people: { id: string; name: string; classes: typeof classes }[] = [
    ...(ownClasses.length ? [{ id: me.id, name: me.name, classes: ownClasses }] : []),
    ...children.map((k) => ({ id: k.id, name: k.display_name, classes: k.classes })),
  ];
  const weeks = await Promise.all(people.map(async (p) => {
    const [work, courses] = await Promise.all([studentWork(c, p.classes, p.id, now), studentCourses(me.tenantId, p.classes)]);
    return { person: p, week: weekSummary(work, today, now, await recentNews(c, courses)) };
  }));
  const from = weeks[0]?.week.from;
  const failed = (!classesOk) || (me.role === "guardian" && !childrenOk);

  return (
    <>
      <TopBar crumbs={<Link href="/">{d.myCourses}</Link>} />
      <main className="page stack">
        <div>
          <h1 style={{ fontSize: 34 }}>{d.thisWeek}</h1>
          {from && <p className="muted" style={{ margin: 0 }}>{d.weekOf} <When iso={`${from}T12:00:00Z`} withTime={false} lang={L} /></p>}
        </div>
        {failed && (
          <div className="notice notice-bad" role="alert">
            {me.role === "guardian" ? d.childrenFailed : d.classesFailed} <a href="/week">{d.tryAgain}</a>
          </div>
        )}
        {!failed && people.length === 0 && (
          <p className="empty">
            {me.role === "guardian" ? d.noChildren
              : <>{d.weekTeacher} <Link href="/planner">{d.planner}</Link></>}
          </p>
        )}
        {weeks.map(({ person, week }, i) => (
          <section key={person.id} className="card" aria-labelledby={`wk-${i}`}>
            <div className="row">
              <h2 id={`wk-${i}`} className="grow" style={{ fontSize: 22 }}>{person.name}</h2>
              {person.id !== me.id && <Link className="btn" href={`/family/${person.id}`}>{d.seeAllWork}</Link>}
            </div>
            <WeekCard week={week} d={d} L={L} id={`wk-${i}`} />
          </section>
        ))}
        {people.length > 0 && <p className="muted" style={{ fontSize: 13 }}>{d.weekNoEmail}</p>}
      </main>
    </>
  );
}
