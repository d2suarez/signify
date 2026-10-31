import Link from "next/link";
import { ctx, lang } from "@/lib/access";
import { previewFor } from "@/lib/preview";
import { studentWork, studentCourses, weekSummary, recentNews } from "@/lib/family";
import { todayIn } from "@/lib/planner";
import { dict } from "@/lib/i18n";
import { PreviewFrame, PreviewFailed } from "@/components/Preview";
import { WeekCard } from "@/components/Work";
import { When } from "@/components/When";

export const dynamic = "force-dynamic";

const SCHOOL_TZ = "America/New_York";

/** "This week" as the practice student (their own week) or parent (each child's) sees it. */
export default async function PreviewWeek({ params }: { params: Promise<{ personId: string }> }) {
  const { personId } = await params;
  const L = await lang();
  const d = dict(L);
  const p = await previewFor(personId, "week");
  if (p === "failed") return <PreviewFailed d={d} retry={`/preview/${personId}/week`} />;
  const { me, who, base } = p;
  const c = ctx(me);
  const today = todayIn(SCHOOL_TZ);
  const now = new Date();
  const people = who.kind === "student"
    ? [{ id: who.id, name: who.display_name, classes: who.classes.filter((k) => k.role === "student"), child: false }]
    : who.children.map((k) => ({ id: k.id, name: k.display_name, classes: k.classes, child: true }));
  const weeks = await Promise.all(people.map(async (person) => {
    const [work, courses] = await Promise.all([studentWork(c, person.classes, person.id, now), studentCourses(me.tenantId, person.classes)]);
    return { person, week: weekSummary(work, today, now, await recentNews(c, courses)) };
  }));
  const from = weeks[0]?.week.from;

  return (
    <PreviewFrame p={p} d={d}>
      <div>
        <h1 style={{ fontSize: 34 }}>{d.thisWeek}</h1>
        {from && <p className="muted" style={{ margin: 0 }}>{d.weekOf} <When iso={`${from}T12:00:00Z`} withTime={false} lang={L} /></p>}
      </div>
      {people.length === 0 && <p className="empty">{d.noChildren}</p>}
      {weeks.map(({ person, week }, i) => (
        <section key={person.id} className="card" aria-labelledby={`wk-${i}`}>
          <div className="row">
            <h2 id={`wk-${i}`} className="grow" style={{ fontSize: 22 }}>{person.name}</h2>
            {person.child && <Link className="btn" href={`${base}/family/${person.id}`}>{d.seeAllWork}</Link>}
          </div>
          <WeekCard week={week} d={d} L={L} id={`wk-${i}`} />
        </section>
      ))}
    </PreviewFrame>
  );
}
