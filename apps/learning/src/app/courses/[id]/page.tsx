import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { courseAccess, ctx, lang, studentsOf } from "@/lib/access";
import { isPracticeCourse, fillPractice, clearPractice } from "@/lib/practice";
import { requireMe } from "@/lib/auth";
import { listLessons, createLesson, type LessonSummary } from "@/lib/lessons";
import { listUnits, createUnit, renameUnit, moveUnit, deleteUnit } from "@/lib/units";
import { listAssignments, createAssignment, type Assignment } from "@/lib/assignments";
import { liveLessonId } from "@/lib/live-ticket";
import { listAnnouncements, postAnnouncement, archiveAnnouncement, ANNOUNCEMENT_LIMITS } from "@/lib/announcements";
import { dict, type Dict, type Lang } from "@/lib/i18n";
import { TopBar } from "@/components/TopBar";
import { Announcements } from "@/components/Announcements";
import { StudentCourse } from "@/components/StudentCourse";
import { myPreviewPeople } from "@/lib/preview";
import { CourseNav } from "@/components/CourseNav";
import { When } from "@/components/When";
import ToolPicker from "@/components/ToolPicker";
import { toolChoices } from "@/lib/lti-platform";

export const dynamic = "force-dynamic";

async function teacherAccess(formData: FormData) {
  const access = await courseAccess(String(formData.get("courseId") || ""));
  return access && access.course.role === "teacher" ? access : null;
}

// Sample work, only ever in a course named "Practice …" (src/lib/practice.ts).
async function practiceWork(formData: FormData) {
  "use server";
  const access = await teacherAccess(formData);
  if (!access || !isPracticeCourse(access.course)) return;
  if (formData.get("op") === "clear") await clearPractice(ctx(access.me), access.course.id);
  else {
    const { ok, students } = await studentsOf(access);
    if (!ok) return;
    await fillPractice(ctx(access.me), access.course.id, students.map((s) => s.id));
  }
  revalidatePath(`/courses/${access.course.id}`);
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
  if (access.course.role === "student") {
    return (
      <>
        <TopBar crumbs={<Link href="/">{dict(L).myCourses}</Link>} />
        <main className="page stack">
          <StudentCourse course={access.course} c={ctx(access.me)} person={{ id: access.me.id, name: access.me.name }} L={L} />
        </main>
      </>
    );
  }

  const roster = await studentsOf(access);
  // Mock practice people in this class the teacher may preview (Signify ID decides).
  const previews = await myPreviewPeople();
  const inClass = new Set(roster.students.map((s) => s.id));
  const previewable = previews.people.filter((p) => p.kind === "student" && inClass.has(p.id));

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

  const tools = await toolChoices(me.tenantId);
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
              <option value="quiz">{d.kindQuiz}</option>
            </select>
            <button className="btn btn-primary" type="submit">{d.create}</button>
          </form>
          <form action={newUnit} className="row">
            <input type="hidden" name="courseId" value={course.id} />
            <label htmlFor="new-unit" className="label" style={{ flex: "0 0 130px" }}><span className="shape s-square" style={{ marginRight: 8 }} />{d.newUnit}</label>
            <input id="new-unit" name="title" className="field" style={{ flex: "1 1 220px", width: "auto" }} placeholder={d.unitTitle} maxLength={200} required />
            <button className="btn" type="submit">{d.create}</button>
          </form>
          {tools.length > 0 && (
            <div>
              <p className="label"><span className="shape s-tri" style={{ marginRight: 8 }} />{d.toolAddAssignment}</p>
              <ToolPicker tools={tools} courseId={course.id} d={d} />
            </div>
          )}
          <p style={{ margin: 0, fontSize: 14 }}><Link href={`/courses/${course.id}/import`}>{d.importCourse}</Link> <span className="muted">{d.importCourseHint}</span></p>
        </div>

        {previewable.length > 0 && (
          <section className="card row" style={{ gap: 8 }} aria-labelledby="preview-title">
            <h2 id="preview-title" className="label" style={{ flex: "0 0 auto", margin: 0 }}>{d.previewAs}</h2>
            {previewable.map((p) => (
              <Link key={p.id} className="btn btn-sm" href={`/preview/${p.id}/courses/${course.id}`}>{p.display_name}</Link>
            ))}
            <p className="muted" style={{ margin: 0, fontSize: 13, flexBasis: "100%" }}>{d.previewHint}</p>
          </section>
        )}

        {isPracticeCourse(course) && (
          <section className="card stack" aria-labelledby="practice-title" style={{ gap: 8 }}>
            <h2 id="practice-title" className="label">{d.practiceTitle}</h2>
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>{d.practiceHint}</p>
            <div className="row">
              <form action={practiceWork}>
                <input type="hidden" name="courseId" value={course.id} />
                <input type="hidden" name="op" value="fill" />
                <button className="btn btn-primary" type="submit">{d.practiceFill}</button>
              </form>
              <form action={practiceWork}>
                <input type="hidden" name="courseId" value={course.id} />
                <input type="hidden" name="op" value="clear" />
                <button className="btn" type="submit">{d.practiceClear}</button>
              </form>
            </div>
          </section>
        )}

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
          <Announcements list={announcements} L={L} d={d} courseId={course.id} archive={announce} />
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
          {a.kind === "offline" ? ` · ${d.kindOffline}` : a.kind === "quiz" ? ` · ${d.kindQuiz}` : ""}
        </span>
        {!a.published && <span className="pill pill-draft" style={{ marginLeft: 6 }}>{d.draft}</span>}
      </div>
      <Link className="btn" href={`/assignments/${a.id}`}>{d.edit}</Link>
      <Link className="btn btn-primary" href={`/assignments/${a.id}/grade`}>{d.openGrading}</Link>
    </li>
  );
}

// ---------- a student's view ----------

