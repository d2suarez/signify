import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { courseAccess, ctx, lang } from "@/lib/access";
import { requireMe } from "@/lib/auth";
import { listLessons, createLesson, type LessonSummary } from "@/lib/lessons";
import { listUnits, createUnit, renameUnit, moveUnit, deleteUnit } from "@/lib/units";
import { listAssignments, createAssignment, courseSubmissions, isLate, isOverdue, type Assignment } from "@/lib/assignments";
import { buildGradebook, standardsView } from "@/lib/gradebook";
import { liveLessonId } from "@/lib/live-ticket";
import { listAnnouncements, postAnnouncement, archiveAnnouncement, ANNOUNCEMENT_LIMITS, type Announcement } from "@/lib/announcements";
import { dict, type Dict, type Lang } from "@/lib/i18n";
import { TopBar } from "@/components/TopBar";
import { CourseNav } from "@/components/CourseNav";
import { When } from "@/components/When";
import { StandardsList } from "@/components/Work";

export const dynamic = "force-dynamic";

async function teacherAccess(formData: FormData) {
  const access = await courseAccess(String(formData.get("courseId") || ""));
  return access && access.course.role === "teacher" ? access : null;
}

async function newLesson(formData: FormData) {
  "use server";
  const access = await teacherAccess(formData);
  if (!access) return;
  const lesson = await createLesson(ctx(access.me), access.course.id, String(formData.get("title") || ""), [], formData.get("unitId"));
  redirect(`/lessons/${lesson.id}/edit`);
}

async function newAssignment(formData: FormData) {
  "use server";
  const access = await teacherAccess(formData);
  if (!access) return;
  const a = await createAssignment(ctx(access.me), access.course.id, {
    title: formData.get("title"), unitId: formData.get("unitId"), kind: formData.get("kind"),
  });
  redirect(`/assignments/${a.id}`);
}

async function newUnit(formData: FormData) {
  "use server";
  const access = await teacherAccess(formData);
  if (!access) return;
  await createUnit(ctx(access.me), access.course.id, String(formData.get("title") || ""));
  revalidatePath(`/courses/${access.course.id}`);
}

async function unitAction(formData: FormData) {
  "use server";
  const access = await teacherAccess(formData);
  if (!access) return;
  const c = ctx(access.me), courseId = access.course.id, unitId = String(formData.get("unitId") || "");
  const op = String(formData.get("op") || "");
  if (op === "up" || op === "down") await moveUnit(c, courseId, unitId, op === "up" ? -1 : 1);
  if (op === "rename") await renameUnit(c, courseId, unitId, String(formData.get("title") || ""));
  if (op === "delete") await deleteUnit(c, courseId, unitId);
  revalidatePath(`/courses/${courseId}`);
}

async function announce(formData: FormData) {
  "use server";
  const access = await teacherAccess(formData);
  if (!access) return;
  const c = ctx(access.me), courseId = access.course.id;
  if (formData.get("op") === "archive") await archiveAnnouncement(c, courseId, String(formData.get("announcementId") || ""));
  else await postAnnouncement(c, courseId, { title: formData.get("title"), body: formData.get("body") });
  revalidatePath(`/courses/${courseId}`);
}

type Item = { kind: "lesson"; lesson: LessonSummary } | { kind: "assignment"; assignment: Assignment };

function itemDate(i: Item): string {
  return (i.kind === "lesson" ? i.lesson.plannedFor : i.assignment.dueOn) || "9999";
}

export default async function CoursePage({ params }: { params: Promise<{ id: string }> }) {
  await requireMe();
  const { id } = await params;
  const L = await lang();
  const access = await courseAccess(id);
  if (!access) notFound();
  if (access.course.role === "student") return <StudentCourse access={access} L={L} />;

  const { me, course } = access;
  const d = dict(L);
  const c = ctx(me);
  const live = liveLessonId(course.id);
  const [units, lessons, assignments, announcements] = await Promise.all([
    listUnits(c, course.id), listLessons(c, course.id), listAssignments(c, course.id), listAnnouncements(c, course.id),
  ]);

  const groups = [...units.map((u) => ({ unit: u, items: [] as Item[] })), { unit: null, items: [] as Item[] }];
  const byId = new Map(units.map((u, i) => [u.id, groups[i]]));
  const loose = groups[groups.length - 1];
  for (const lesson of lessons) (byId.get(lesson.unitId || "") || loose).items.push({ kind: "lesson", lesson });
  for (const assignment of assignments) (byId.get(assignment.unitId || "") || loose).items.push({ kind: "assignment", assignment });
  for (const g of groups) g.items.sort((a, b) => itemDate(a).localeCompare(itemDate(b)));

  const unitSelect = (idFor: string) => (
    // Keyed by the newest unit so a unit just made becomes the choice.
    <select key={units.at(-1)?.id || "none"} id={idFor} name="unitId" className="field" style={{ width: "auto", flex: "0 1 200px" }} aria-label={d.unit} defaultValue={units.at(-1)?.id || ""}>
      <option value="">{d.noUnit}</option>
      {units.map((u) => <option key={u.id} value={u.id}>{u.title}</option>)}
    </select>
  );

  return (
    <>
      <TopBar crumbs={<Link href="/">{d.myCourses}</Link>} />
      <main className="page stack">
        <div>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>{course.subject}</p>
          <h1 style={{ fontSize: 34 }}>{course.name}</h1>
        </div>
        <CourseNav courseId={course.id} current="plan" d={d} />

        <div className="card stack" style={{ padding: "14px 16px", gap: 10 }}>
          <form action={newLesson} className="row">
            <input type="hidden" name="courseId" value={course.id} />
            <label htmlFor="new-title" className="label" style={{ flex: "0 0 130px" }}><span className="shape s-arch" style={{ marginRight: 8 }} />{d.newLesson}</label>
            <input id="new-title" name="title" className="field" style={{ flex: "1 1 220px", width: "auto" }} placeholder={d.lessonTitle} maxLength={200} required />
            {unitSelect("new-lesson-unit")}
            <button className="btn btn-primary" type="submit">{d.create}</button>
          </form>
          <form action={newAssignment} className="row">
            <input type="hidden" name="courseId" value={course.id} />
            <label htmlFor="new-assignment" className="label" style={{ flex: "0 0 130px" }}><span className="shape s-tri" style={{ marginRight: 8 }} />{d.newAssignment}</label>
            <input id="new-assignment" name="title" className="field" style={{ flex: "1 1 220px", width: "auto" }} placeholder={d.assignmentTitle} maxLength={200} required />
            {unitSelect("new-assignment-unit")}
            <select name="kind" className="field" style={{ width: "auto", flex: "0 1 200px" }} aria-label={d.kind} defaultValue="online">
              <option value="online">{d.kindOnline}</option>
              <option value="offline">{d.kindOffline}</option>
            </select>
            <button className="btn btn-primary" type="submit">{d.create}</button>
          </form>
          <form action={newUnit} className="row">
            <input type="hidden" name="courseId" value={course.id} />
            <label htmlFor="new-unit" className="label" style={{ flex: "0 0 130px" }}><span className="shape s-square" style={{ marginRight: 8 }} />{d.newUnit}</label>
            <input id="new-unit" name="title" className="field" style={{ flex: "1 1 220px", width: "auto" }} placeholder={d.unitTitle} maxLength={200} required />
            <button className="btn" type="submit">{d.create}</button>
          </form>
          <p style={{ margin: 0, fontSize: 14 }}><Link href={`/courses/${course.id}/import`}>{d.importCourse}</Link> <span className="muted">{d.importCourseHint}</span></p>
        </div>

        <section className="card stack" aria-labelledby="ann-title" style={{ gap: 10 }}>
          <h2 id="ann-title" className="label">{d.announcements}</h2>
          <form action={announce} className="stack" style={{ gap: 8 }}>
            <input type="hidden" name="courseId" value={course.id} />
            <label htmlFor="ann-new-title" className="sr-only">{d.title}</label>
            <input id="ann-new-title" name="title" className="field" placeholder={`${d.title} (${d.optional})`} maxLength={ANNOUNCEMENT_LIMITS.title} />
            <label htmlFor="ann-new-body" className="sr-only">{d.announcementText}</label>
            <textarea id="ann-new-body" name="body" className="field" rows={2} placeholder={d.announcementText} maxLength={ANNOUNCEMENT_LIMITS.body} required />
            <button className="btn btn-primary" type="submit" style={{ alignSelf: "flex-start" }}>{d.postAnnouncement}</button>
          </form>
          <Announcements list={announcements} L={L} d={d} courseId={course.id} teacher />
        </section>

        {lessons.length === 0 && assignments.length === 0 && units.length === 0 && <p className="empty">{d.noLessons}</p>}

        {groups.map(({ unit, items }, gi) => {
          if (!unit && items.length === 0) return null;
          return (
            <section key={unit?.id || "loose"} className="card" aria-labelledby={`unit-${gi}`}>
              <div className="unit-head">
                <h2 id={`unit-${gi}`}>{unit ? unit.title : d.noUnit}</h2>
                <span className="spacer" />
                {unit && (
                  <form action={unitAction} className="row" style={{ gap: 6 }}>
                    <input type="hidden" name="courseId" value={course.id} />
                    <input type="hidden" name="unitId" value={unit.id} />
                    <button className="icon-btn" name="op" value="up" aria-label={d.moveUp} disabled={gi === 0}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M6 15l6-6 6 6" /></svg>
                    </button>
                    <button className="icon-btn" name="op" value="down" aria-label={d.moveDown} disabled={gi === units.length - 1}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
                    </button>
                  </form>
                )}
                {unit && (
                  <details className="menu">
                    <summary className="btn btn-sm">{d.rename}…</summary>
                    <div className="menu-pop card">
                      <form action={unitAction} className="stack" style={{ gap: 8 }}>
                        <input type="hidden" name="courseId" value={course.id} />
                        <input type="hidden" name="unitId" value={unit.id} />
                        <label className="label" htmlFor={`rn-${unit.id}`}>{d.unitTitle}</label>
                        <input id={`rn-${unit.id}`} name="title" className="field" defaultValue={unit.title} maxLength={200} required />
                        <button className="btn btn-primary btn-sm" name="op" value="rename">{d.save}</button>
                      </form>
                      <form action={unitAction} className="stack" style={{ gap: 6, marginTop: 14 }}>
                        <input type="hidden" name="courseId" value={course.id} />
                        <input type="hidden" name="unitId" value={unit.id} />
                        <button className="btn btn-sm" name="op" value="delete">{d.deleteUnit}</button>
                        <span className="muted" style={{ fontSize: 12 }}>{d.deleteUnitHint}</span>
                      </form>
                    </div>
                  </details>
                )}
              </div>
              {items.length === 0 ? <p className="empty">{d.emptyUnit}</p> : (
                <ul className="list">
                  {items.map((i) => i.kind === "lesson"
                    ? <LessonRow key={i.lesson.id} l={i.lesson} live={live === i.lesson.id} d={d} />
                    : <AssignmentRow key={i.assignment.id} a={i.assignment} d={d} L={L} />)}
                </ul>
              )}
            </section>
          );
        })}
      </main>
    </>
  );
}

function Announcements({ list, L, d, courseId, teacher }: { list: Announcement[]; L: Lang; d: Dict; courseId: string; teacher?: boolean }) {
  if (!list.length) return teacher ? <p className="empty" style={{ margin: 0 }}>{d.noAnnouncements}</p> : null;
  return (
    <ul className="list announcements">
      {list.map((a) => (
        <li key={a.id} style={{ alignItems: "flex-start" }}>
          <span className="shape s-square" aria-hidden="true" style={{ marginTop: 6 }} />
          <div className="grow">
            {a.title && <h3>{a.title}</h3>}
            <p style={{ whiteSpace: "pre-wrap", margin: a.title ? "4px 0 0" : 0 }}>{a.body}</p>
            <span className="muted" style={{ fontSize: 13 }}><When iso={a.createdAt} lang={L} /></span>
          </div>
          {teacher && (
            <form action={announce}>
              <input type="hidden" name="courseId" value={courseId} />
              <input type="hidden" name="announcementId" value={a.id} />
              <button className="btn btn-sm" name="op" value="archive" aria-label={`${d.takeDown}: ${a.title || a.body.slice(0, 40)}`}>{d.takeDown}</button>
            </form>
          )}
        </li>
      ))}
    </ul>
  );
}

function LessonRow({ l, live, d }: { l: LessonSummary; live: boolean; d: Dict }) {
  return (
    <li>
      <span className="shape s-arch" aria-hidden="true" />
      <div className="grow">
        <h3>{l.title}</h3>
        <span className="muted" style={{ fontSize: 13 }}>
          {l.plannedFor ? `${l.plannedFor} · ` : ""}{l.durationMin} min · {l.blockCount} {d.blocks}
        </span>
        {live && <span className="pill" style={{ marginLeft: 6 }}><span className="live-dot" />{d.liveNow}</span>}
      </div>
      <Link className="btn" href={`/lessons/${l.id}/edit`}>{d.edit}</Link>
      <Link className="btn btn-primary" href={`/lessons/${l.id}/present`}>{d.present}</Link>
    </li>
  );
}

function AssignmentRow({ a, d, L }: { a: Assignment; d: Dict; L: Lang }) {
  return (
    <li>
      <span className="shape s-tri" aria-hidden="true" />
      <div className="grow">
        <h3>{a.title}</h3>
        <span className="muted" style={{ fontSize: 13 }}>
          {a.dueAt ? <>{d.due} <When iso={a.dueAt} lang={L} /> · </> : `${d.noDue} · `}{a.points} {d.pts}
          {a.kind === "offline" ? ` · ${d.kindOffline}` : ""}
        </span>
        {!a.published && <span className="pill pill-draft" style={{ marginLeft: 6 }}>{d.draft}</span>}
      </div>
      <Link className="btn" href={`/assignments/${a.id}`}>{d.edit}</Link>
      <Link className="btn btn-primary" href={`/assignments/${a.id}/grade`}>{d.openGrading}</Link>
    </li>
  );
}

// ---------- a student's view ----------

async function StudentCourse({ access, L }: { access: NonNullable<Awaited<ReturnType<typeof courseAccess>>>; L: Lang }) {
  const { me, course } = access;
  const d = dict(L);
  const c = ctx(me);
  const live = liveLessonId(course.id);
  const [units, assignments, subs, announcements] = await Promise.all([
    listUnits(c, course.id),
    listAssignments(c, course.id, { publishedOnly: true }),
    courseSubmissions(c, course.id, me.id),
    listAnnouncements(c, course.id),
  ]);
  const self = { id: me.id, name: me.name, sortKey: "", factsName: me.name };
  const gb = await buildGradebook(c, course.id, [self], null, { releasedOnly: true });
  const row = gb.rows[0];
  const sv = standardsView(gb, row);
  const subBy = new Map(subs.map((s) => [s.assignmentId, s]));

  const groups = [...units.map((u) => ({ title: u.title, id: u.id, items: [] as Assignment[] })), { title: d.noUnit, id: "", items: [] as Assignment[] }];
  for (const a of assignments) (groups.find((g) => g.id && g.id === a.unitId) || groups[groups.length - 1]).items.push(a);

  return (
    <>
      <TopBar crumbs={<Link href="/">{d.myCourses}</Link>} />
      <main className="page stack">
        <div className="row" style={{ alignItems: "flex-end" }}>
          <div className="grow" style={{ flex: 1 }}>
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>{course.subject}</p>
            <h1 style={{ fontSize: 34 }}>{course.name}</h1>
          </div>
          <div className="card grade-badge">
            <span className="label">{d.courseGrade}</span>
            {row.whole === null ? <span className="muted">{d.noGradeYet}</span> : <b>{row.whole}% · {row.letter}</b>}
          </div>
        </div>
        {sv && (
          <div className="card">
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>{d.convertedNote}</p>
            <StandardsList view={sv} d={d} id="my-standards" />
          </div>
        )}
        <div className="row">
          {live && <Link className="btn btn-primary" href={`/courses/${course.id}/live`}><span className="live-dot" />{d.joinLive}</Link>}
          <Link className="btn" href={`/courses/${course.id}/calendar`}>{d.calendar}</Link>
        </div>

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
                      <h3><Link href={`/assignments/${a.id}`} style={{ color: "inherit" }}>{a.title}</Link></h3>
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
      </main>
    </>
  );
}

function StudentStatus({ a, handedIn, started, late, overdue, cell, dropped, d }: {
  a: Assignment; handedIn: boolean; started: boolean; late: boolean; overdue: boolean; dropped: boolean;
  cell: { score: number | null; flag: string | null; leveled?: boolean } | undefined; d: Dict;
}) {
  // Only released grades reach here (cell is undefined otherwise).
  if (cell && cell.flag === "exempt") return <span className="chip chip-exempt">{d.exempt}</span>;
  if (cell && cell.score !== null) return <span className="chip chip-done">{cell.score} / {a.points}{late ? ` · ${d.late}` : ""}{dropped ? ` · ${d.droppedGrade}` : ""}</span>;
  if (cell?.leveled) return <span className="chip chip-done">{d.graded}{late ? ` · ${d.late}` : ""}</span>;
  if (cell && cell.flag === "missing") return <span className="chip chip-missing">{d.missing}{dropped ? ` · ${d.droppedGrade}` : ""}</span>;
  if (a.kind === "offline") return null;
  if (handedIn) return <span className="chip chip-done">{d.handedIn}{late ? ` · ${d.late}` : ""}</span>;
  if (overdue) return <span className="chip chip-missing">{d.overdue}</span>;
  return <span className="chip">{started ? d.workingOn : d.notStarted}</span>;
}
