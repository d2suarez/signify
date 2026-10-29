import type { Dict, Lang } from "@/lib/i18n";
import type { CourseWork, WorkItem, WeekSummary } from "@/lib/family";
import { When } from "./When";

/**
 * A student's work as the student's family sees it (the parent view and the
 * "This week" page). Status always carries a word, never colour alone; scores
 * appear only for released grades (family.ts decides that).
 */

export function WorkChip({ item, d }: { item: WorkItem; d: Dict }) {
  const late = item.late ? ` · ${d.late}` : "";
  switch (item.status) {
    case "graded": return <span className="chip chip-done">{item.score} / {item.points}{late}</span>;
    case "exempt": return <span className="chip chip-exempt">{d.exempt}</span>;
    case "missing": return <span className="chip chip-missing">{d.missing}</span>;
    case "handedIn": return <span className="chip chip-done">{d.handedIn}{late}</span>;
    case "overdue": return <span className="chip chip-missing">{d.overdue}</span>;
    case "working": return <span className="chip">{d.workingOn}</span>;
    case "inClass": return <span className="chip">{d.inClassWork}</span>;
    default: return <span className="chip">{d.notStarted}</span>;
  }
}

export function WorkList({ items, d, L, showCourse, level = 3 }: { items: WorkItem[]; d: Dict; L: Lang; showCourse?: boolean; level?: 3 | 4 }) {
  const H = level === 4 ? "h4" : "h3";
  return (
    <ul className="list">
      {items.map((i) => (
        <li key={i.id}>
          <span className="shape s-tri" aria-hidden="true" />
          <div className="grow">
            <H style={{ fontSize: 18, margin: 0 }}>{i.title}</H>
            <span className="muted" style={{ fontSize: 13 }}>
              {showCourse && <>{i.courseName} · </>}
              {i.dueAt ? <>{d.due} <When iso={i.dueAt} lang={L} /></> : d.noDue}
            </span>
          </div>
          <WorkChip item={i} d={d} />
        </li>
      ))}
    </ul>
  );
}

export function CourseWorkCard({ w, d, L }: { w: CourseWork; d: Dict; L: Lang }) {
  const headId = `course-${w.course.id}`;
  return (
    <section className="card" aria-labelledby={headId}>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div className="grow" style={{ flex: 1 }}>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>{w.course.subject}</p>
          <h2 id={headId} style={{ fontSize: 22 }}>{w.course.name}</h2>
        </div>
        <div className="grade-badge" style={{ padding: 0, textAlign: "right" }}>
          <span className="label">{d.courseGrade}</span>
          {w.whole === null ? <span className="muted">{d.noGradeYet}</span> : <b>{w.whole}% · {w.letter}</b>}
        </div>
      </div>
      {w.items.length === 0
        ? <p className="empty">{d.noAssignmentsStudent}</p>
        : <WorkList items={w.items} d={d} L={L} />}
    </section>
  );
}

function Part({ title, items, empty, d, L, id }: { title: string; items: WorkItem[]; empty: string; d: Dict; L: Lang; id: string }) {
  return (
    <section aria-labelledby={id}>
      <h3 id={id} className="label" style={{ margin: "10px 0 2px" }}>{title}</h3>
      {items.length === 0 ? <p className="muted" style={{ margin: "4px 0 8px" }}>{empty}</p> : <WorkList items={items} d={d} L={L} showCourse level={4} />}
    </section>
  );
}

/** One student's week. `id` keeps headings unique when several are on a page. */
export function WeekCard({ week, d, L, id }: { week: WeekSummary; d: Dict; L: Lang; id: string }) {
  return (
    <div className="stack" style={{ gap: 4 }}>
      <Part id={`${id}-attn`} title={d.needsAttention} items={week.needsAttention} empty={d.allCaughtUp} d={d} L={L} />
      <Part id={`${id}-due`} title={d.dueThisWeek} items={week.dueThisWeek} empty={d.nothingDueWeek} d={d} L={L} />
      <Part id={`${id}-grades`} title={d.newGrades} items={week.newGrades} empty={d.noNewGrades} d={d} L={L} />
      <Part id={`${id}-next`} title={d.comingNextWeek} items={week.nextWeek} empty={d.nothingNextWeek} d={d} L={L} />
      {week.news.length > 0 && (
        <section aria-labelledby={`${id}-news`}>
          <h3 id={`${id}-news`} className="label" style={{ margin: "10px 0 2px" }}>{d.announcements}</h3>
          <ul className="list">
            {week.news.map((n, k) => (
              <li key={k}>
                <span className="shape s-arch" aria-hidden="true" />
                <div className="grow">
                  <h4 style={{ fontSize: 18, margin: 0 }}>{n.title}</h4>
                  <span className="muted" style={{ fontSize: 13 }}>{n.courseName} · <When iso={n.createdAt} lang={L} withTime={false} /></span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
