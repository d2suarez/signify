import Link from "next/link";
import { gpaText } from "@/lib/grade-scale";
import { finalScore, type Penalty } from "@/lib/late-policy";
import { listUnits } from "@/lib/units";
import { listAssignments, courseSubmissions, isLate, isOverdue, type Assignment } from "@/lib/assignments";
import { listAnnouncements } from "@/lib/announcements";
import { buildGradebook, standardsView } from "@/lib/gradebook";
import { liveLessonId } from "@/lib/live-ticket";
import { dict, type Dict, type Lang } from "@/lib/i18n";
import type { Course } from "@/lib/courses";
import { When } from "./When";
import { StandardsList } from "./Work";
import { Announcements } from "./Announcements";

type Ctx = { tenantId: string; userId: string };

/**
 * A course as one student sees it: their course grade (released grades only,
 * with the school's scale and late penalties), announcements, and the
 * published work with each one's status.
 *
 * `person` is whose view it is. On the student's own page that is the
 * signed-in student; in a preview (`previewBase`) it is a mock student, and
 * the page only reads: no live join, no calendar, assignment links stay
 * inside the preview.
 */
export async function StudentCourse({ course, c, person, L, previewBase }: {
  course: Course; c: Ctx; person: { id: string; name: string }; L: Lang; previewBase?: string;
}) {
  const d = dict(L);
  const previewing = !!previewBase;
  const live = previewing ? null : liveLessonId(course.id);
  const [units, assignments, subs, announcements] = await Promise.all([
    listUnits(c, course.id),
    listAssignments(c, course.id, { publishedOnly: true }),
    courseSubmissions(c, course.id, person.id),
    listAnnouncements(c, course.id),
  ]);
  const self = { id: person.id, name: person.name, sortKey: "", factsName: person.name };
  const gb = await buildGradebook(c, course.id, [self], null, { releasedOnly: true });
  const row = gb.rows[0];
  const sv = standardsView(gb, row);
  const subBy = new Map(subs.map((s) => [s.assignmentId, s]));
  const href = (a: Assignment) => previewing ? `${previewBase}/assignments/${a.id}` : `/assignments/${a.id}`;

  const groups = [...units.map((u) => ({ title: u.title, id: u.id, items: [] as Assignment[] })), { title: d.noUnit, id: "", items: [] as Assignment[] }];
  for (const a of assignments) (groups.find((g) => g.id && g.id === a.unitId) || groups[groups.length - 1]).items.push(a);

  return (
    <>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div className="grow" style={{ flex: 1 }}>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>{course.subject}</p>
          <h1 style={{ fontSize: 34 }}>{course.name}</h1>
        </div>
        <div className="card grade-badge">
          <span className="label">{d.courseGrade}</span>
          {row.whole === null ? <span className="muted">{d.noGradeYet}</span> : <b>{row.whole}% · {row.letter}{row.gpa === null ? "" : ` · ${d.gpaShort.replace("{n}", gpaText(row.gpa))}`}</b>}
        </div>
      </div>
      {sv && (
        <div className="card">
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>{d.convertedNote}</p>
          <StandardsList view={sv} d={d} id="my-standards" />
        </div>
      )}
      {!previewing && (
        <div className="row">
          {live && <Link className="btn btn-primary" href={`/courses/${course.id}/live`}><span className="live-dot" />{d.joinLive}</Link>}
          <Link className="btn" href={`/courses/${course.id}/calendar`}>{d.calendar}</Link>
        </div>
      )}

      {announcements.length > 0 && (
        <section className="card" aria-labelledby="ann-title">
          <h2 id="ann-title" className="label" style={{ marginBottom: 6 }}>{d.announcements}</h2>
          <Announcements list={announcements} L={L} d={d} courseId={course.id} />
        </section>
      )}

      {assignments.length === 0 && <p className="empty">{d.noAssignmentsStudent}</p>}
      {groups.filter((g) => g.items.length > 0).map((g) => (
        <section key={g.id || "loose"} className="card">
          <div className="unit-head"><h2>{g.title}</h2></div>
          <ul className="list">
            {g.items.map((a) => {
              const s = subBy.get(a.id) || null;
              const cell = row.cells[a.id];
              return (
                <li key={a.id}>
                  <span className="shape s-tri" aria-hidden="true" />
                  <div className="grow">
                    <h3><Link href={href(a)} style={{ color: "inherit" }}>{a.title}</Link></h3>
                    <span className="muted" style={{ fontSize: 13 }}>
                      {a.dueAt ? <>{d.due} <When iso={a.dueAt} lang={L} /></> : d.noDue}
                    </span>
                  </div>
                  <StudentStatus a={a} handedIn={!!s?.submittedAt} started={!!s} late={isLate(a, s) || cell?.flag === "late"}
                    overdue={isOverdue(a, s)} cell={cell} dropped={row.grade.dropped.includes(a.id)} d={d} />
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </>
  );
}

export function StudentStatus({ a, handedIn, started, late, overdue, cell, dropped, d }: {
  a: Assignment; handedIn: boolean; started: boolean; late: boolean; overdue: boolean; dropped: boolean;
  cell: { score: number | null; flag: string | null; leveled?: boolean; penalty?: Penalty | null } | undefined; d: Dict;
}) {
  // Only released grades reach here (cell is undefined otherwise).
  if (cell && cell.flag === "exempt") return <span className="chip chip-exempt">{d.exempt}</span>;
  if (cell && cell.score !== null) {
    const p = cell.penalty && cell.penalty.points > 0 ? cell.penalty : null;
    return (
      <span className="chip chip-done">
        {p ? finalScore(cell.score, p) : cell.score} / {a.points}{late ? ` · ${d.late}` : ""}{p ? ` (${cell.score} − ${p.percent}%)` : ""}{dropped ? ` · ${d.droppedGrade}` : ""}
      </span>
    );
  }
  if (cell?.leveled) return <span className="chip chip-done">{d.graded}{late ? ` · ${d.late}` : ""}</span>;
  if (cell && cell.flag === "missing") return <span className="chip chip-missing">{d.missing}{dropped ? ` · ${d.droppedGrade}` : ""}</span>;
  if (a.kind === "offline") return null;
  if (handedIn) return <span className="chip chip-done">{d.handedIn}{late ? ` · ${d.late}` : ""}</span>;
  if (overdue) return <span className="chip chip-missing">{d.overdue}</span>;
  return <span className="chip">{started ? d.workingOn : d.notStarted}</span>;
}
