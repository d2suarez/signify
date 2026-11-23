import Link from "next/link";
import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { courseAccess, ctx, lang, studentsOf, updatesViewer } from "@/lib/access";
import { isPracticeCourse, fillPractice, clearPractice } from "@/lib/practice";
import { requireMe } from "@/lib/auth";
import { listLessons, createLesson, type LessonSummary } from "@/lib/lessons";
import { listUnits, renameUnit, moveUnit, deleteUnit, setUnitParent, subtreeIds, unitChoices, MAX_DEPTH, type Unit } from "@/lib/units";
import { listAssignments, type Assignment } from "@/lib/assignments";
import { liveLessonId } from "@/lib/live-ticket";
import { feed, mayPost, courseRules } from "@/lib/updates";
import { dict, type Dict, type Lang } from "@/lib/i18n";
import { TopBar } from "@/components/TopBar";
import { Feed, CourseRulesForm, UpdateErrorNote } from "@/components/Updates";
import PostComposer from "@/components/PostComposer";
import { composerSetup } from "@/lib/composer";
import { myCourses } from "@/lib/courses";
import { myClasses } from "@/lib/auth";
import { StudentCourse } from "@/components/StudentCourse";
import { myPreviewPeople } from "@/lib/preview";
import { LiveJoin } from "@/components/LiveJoin";
import { ClassHeader } from "@/components/ClassHeader";
import { CreateMenu } from "@/components/CreateMenu";
import { pickedBlocks } from "@/lib/present-picked";
import { CourseMenu } from "@/components/CourseMenu";
import { When } from "@/components/When";
import { toolChoices } from "@/lib/lti-platform";
import { catalogOf, suggestedCatalog, schoolCatalog, noteTeacher } from "@/lib/sections";
import { moveToCourse } from "./section-actions";
import { listEvents } from "@/lib/clubs";
import { membersOf } from "@/lib/roster";
import { token } from "@/lib/auth";
import { todayIn } from "@/lib/planner";
import { SCHOOL_TZ } from "@/lib/school-grading";
import { ClubEvents, ClubMembers, ClubSwitch } from "@/components/Club";
import { itemPlaces, moveItem, moveItemsToUnit, setStudentView, setAssignmentThread, parseKey, asView, type Place } from "@/lib/organize";
import { SelectAll, SelectedCount } from "@/components/Organize";
import { listResources, updateResource, archiveResource, studentCanSee, type Resource } from "@/lib/resources";
import { BLOCK_SHAPE } from "@/lib/block-kinds";
import { materialKind } from "@/lib/material-kind";

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

/** Archived materials (the Resources page's job until 2026-11-23): bring one back. */
async function restoreMaterial(formData: FormData) {
  "use server";
  const access = await teacherAccess(formData);
  if (!access) return;
  await archiveResource({ ...ctx(access.me), role: "teacher" }, access.course.id, String(formData.get("id") || ""), false);
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
  if (op === "parent") {
    const to = String(formData.get("parentId") || "");
    await setUnitParent(c, courseId, unitId, to && to !== "top" ? to : null);
  }
  revalidatePath(`/courses/${courseId}`);
}

// Organize mode (src/lib/organize.ts): one form, id "org", that every row's checkbox and arrows belong to.
async function organize(formData: FormData) {
  "use server";
  const access = await teacherAccess(formData);
  if (!access) return;
  const c = ctx(access.me), courseId = access.course.id;
  const op = String(formData.get("op") || "");
  const picked = formData.getAll("item").map(String);
  const step = /^(up|down):(.+)$/.exec(op);
  if (step) await moveItem(c, courseId, step[2], step[1] === "up" ? -1 : 1);
  if (op === "move" && picked.length) {
    const to = String(formData.get("toUnit") || "");
    await moveItemsToUnit(c, courseId, picked, to && to !== "none" ? to : null);
  }
  // Present ticked / make a page from ticked (the Resources page's job until 2026-11-23): in the page's order.
  if ((op === "present" || op === "makepage") && picked.length) {
    const { blocks, onlyLesson } = await pickedBlocks(c, courseId, picked);
    if (!blocks.length) redirect(`${`/courses/${courseId}`}?organize=1&none=1`);
    if (onlyLesson && op === "present") redirect(`/lessons/${onlyLesson}/present`);
    const title = String(formData.get("title") || "").trim() || String(formData.get("fallback") || "Presentation");
    const lesson = await createLesson(c, courseId, title, blocks);
    redirect(op === "makepage" ? `/lessons/${lesson.id}/edit` : `/lessons/${lesson.id}/present`);
  }
  const view = asView(formData.get("view"));
  if (op === "view" && view && picked.length) {
    const viewer = await updatesViewer();
    if (viewer) {
      const keys = picked.map(parseKey).filter((k) => !!k);
      await setStudentView(viewer, courseId, keys.filter((k) => k!.kind === "lesson").map((k) => k!.id), view);
      await setAssignmentThread(viewer, courseId, keys.filter((k) => k!.kind === "assignment").map((k) => k!.id), view === "thread");
      // Materials: anything but "hidden" shows them (they have no Updates post of their own).
      const who = { ...c, role: "teacher" as const };
      for (const k of keys) if (k!.kind === "resource") await updateResource(who, courseId, k!.id, { visible: view !== "hidden" });
    }
  }
  revalidatePath(`/courses/${courseId}`);
}

type Item = { kind: "lesson"; lesson: LessonSummary } | { kind: "assignment"; assignment: Assignment } | { kind: "resource"; resource: Resource };

function itemDate(i: Item): string {
  return (i.kind === "lesson" ? i.lesson.plannedFor : i.kind === "assignment" ? i.assignment.dueOn : null) || "9999";
}
const itemKey = (i: Item) => (i.kind === "lesson" ? `lesson:${i.lesson.id}` : i.kind === "assignment" ? `assignment:${i.assignment.id}` : `resource:${i.resource.id}`);

export default async function CoursePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ updateError?: string; eventError?: string; organize?: string; none?: string }> }) {
  await requireMe();
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const L = await lang();
  const access = await courseAccess(id);
  if (!access) notFound();
  const viewer = (await updatesViewer())!;
  const here = `/courses/${access.course.id}`;
  const updatesSection = async (teacher: boolean) => {
    const dd = dict(L);
    const [posts, canPost, rules, mine] = await Promise.all([
      feed(viewer, { courseId: access.course.id }), mayPost(viewer, access.course.id), courseRules(viewer, access.course.id),
      myClasses().then(({ classes }) => myCourses(access.me.tenantId, classes, access.me.id)),
    ]);
    const setup = canPost ? await composerSetup(viewer, mine, dd.updWholeSchool) : null;
    return (
      <section className="card stack" aria-labelledby="upd-title" style={{ gap: 10 }}>
        <div className="row"><h2 id="upd-title" className="label grow">{dd.updTitle}</h2><Link href="/updates" className="btn btn-sm">{dd.updAll}</Link></div>
        <UpdateErrorNote code={sp.updateError} d={dd} />
        {setup && (
          <PostComposer places={setup.places} preselected={[access.course.id]} materials={setup.materials} canUpload={setup.canUpload}
            uploadFallback={access.course.role === "teacher" ? access.course.id : setup.uploadFallback} d={dd} placeholder={teacher ? dd.updWriteClass : dd.updWriteStudent} back={here} />
        )}
        {!canPost && !teacher && <p className="muted" style={{ margin: 0, fontSize: 14 }}>{dd.updPostsOff}</p>}
        {teacher && <CourseRulesForm courseId={access.course.id} rules={rules} d={dd} />}
        <Feed posts={posts} back={here} L={L} d={dd} showWhere={false} />
      </section>
    );
  };
  const isClub = access.course.kind === "club";
  const events = isClub ? await listEvents(access.me, access.course.id, todayIn(SCHOOL_TZ)) : null;
  if (access.course.role === "student" && isClub) {
    // A club as a member sees it: its updates and dates. No grades, no work.
    return (
      <>
        <TopBar crumbs={<Link href="/">{dict(L).myCourses}</Link>} below={<ClassHeader course={access.course} d={dict(L)} tab="plan" heading />} />
        <main className="page stack">
          {await updatesSection(false)}
          <ClubEvents courseId={access.course.id} events={events!} sponsor={false} L={L} d={dict(L)} />
        </main>
      </>
    );
  }
  if (access.course.role === "student") {
    return (
      <>
        <TopBar crumbs={<Link href="/">{dict(L).myCourses}</Link>} below={<ClassHeader course={access.course} d={dict(L)} tab="plan" heading />} />
        <main className="page stack">
          <StudentCourse course={access.course} c={ctx(access.me)} person={{ id: access.me.id, name: access.me.name }} L={L} updates={await updatesSection(false)} />
        </main>
      </>
    );
  }

  const roster = await studentsOf(access);
  // Students in this class the teacher may preview, practice or real (Signify ID decides).
  const previews = await myPreviewPeople();
  const inClass = new Set(roster.students.map((s) => s.id));
  const previewable = previews.people.filter((p) => p.kind === "student" && inClass.has(p.id));

  const { me, course } = access;
  const d = dict(L);
  const c = ctx(me);
  const live = liveLessonId(course.id);
  const [units, lessons, assignments, updates, places, resources] = await Promise.all([
    listUnits(c, course.id), listLessons(c, course.id), listAssignments(c, course.id), updatesSection(true), itemPlaces(c, course.id),
    listResources({ ...c, role: "teacher" }, course.id),
  ]);
  const archivedMaterials = await listResources({ ...c, role: "teacher" }, course.id, { archived: true });
  const organizing = sp.organize === "1";
  const placeOf = (i: Item): Place => places.get(itemKey(i)) ?? { position: null, studentView: "hidden", threadPostId: null };

  const groups = [...units.map((u) => ({ unit: u, items: [] as Item[] })), { unit: null, items: [] as Item[] }];
  const byId = new Map(units.map((u, i) => [u.id, groups[i]]));
  const loose = groups[groups.length - 1];
  for (const lesson of lessons) (byId.get(lesson.unitId || "") || loose).items.push({ kind: "lesson", lesson });
  for (const assignment of assignments) (byId.get(assignment.unitId || "") || loose).items.push({ kind: "assignment", assignment });
  // Materials (migration 027) sit in their folder; with no folder they are "Not in a folder" like anything else (no Resources tab since 2026-11-23).
  for (const resource of resources) (byId.get(resource.unitId || "") || loose).items.push({ kind: "resource", resource });
  // Placed by hand first (organize.ts), then by date, as the course always sorted.
  for (const g of groups) g.items.sort((a, b) => {
    const pa = placeOf(a).position, pb = placeOf(b).position;
    if (pa !== null || pb !== null) return pa === null ? 1 : pb === null ? -1 : pa - pb;
    return itemDate(a).localeCompare(itemDate(b));
  });

  const tools = await toolChoices(me.tenantId);
  const clubRoster = isClub ? await membersOf({ id: me.id, role: me.role, dev: me.dev }, await token(), course.idClassId) : null;
  await noteTeacher(c, course.id);
  const [catalog, suggested, allCourses] = await Promise.all([catalogOf(c, course.id), suggestedCatalog(c, course.id), schoolCatalog(c)]);
  const fillName = (s: string, name: string) => s.replace("{name}", name);
  const today = new Date().toLocaleDateString(L === "es" ? "es" : "en-US", { month: "short", day: "numeric" });
  const choices = unitChoices(units);
  // Folders inside folders (units.ts): a unit is a card; its folders sit inside it, after its own items.
  const kidsOf = (id: string | null) => units.filter((u) => u.parentId === id);
  const heightOf = (u: Unit) => {
    const inside = subtreeIds(units, u.id);
    return Math.max(...units.filter((x) => inside.has(x.id)).map((x) => x.depth)) - u.depth + 1;
  };
  const arrow = (dir: "up" | "down") => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d={dir === "up" ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} /></svg>
  );
  const renderFolder = (unit: Unit | null): ReactNode => {
    const items = (unit ? byId.get(unit.id)! : loose).items;
    if (!unit && items.length === 0) return null;
    const inner = unit ? kidsOf(unit.id) : [];
    const nested = !!unit && unit.depth > 0;
    const sibs = unit ? kidsOf(unit.parentId) : [];
    const si = unit ? sibs.findIndex((x) => x.id === unit.id) : 0;
    const headId = `unit-${unit?.id || "loose"}`;
    const parent = unit?.parentId ? units.find((x) => x.id === unit.parentId) : null;
    // Where this folder may go: not inside itself, and not deeper than MAX_DEPTH.
    const inside = unit ? subtreeIds(units, unit.id) : new Set<string>();
    const targets = unit ? choices.filter((c) => {
      const t = units.find((x) => x.id === c.id)!;
      return !inside.has(t.id) && t.depth + 1 + heightOf(unit) <= MAX_DEPTH;
    }) : [];
    const Heading = nested ? "h3" : "h2";
    return (
      <section key={unit?.id || "loose"} className={nested ? "subfolder" : "card"} aria-labelledby={headId}>
        <div className="unit-head">
          {nested && <span className="shape s-square" aria-hidden="true" />}
          <Heading id={headId} className={nested ? "folder-title" : undefined}>{unit ? unit.title : d.noUnit}</Heading>
          <span className="spacer" />
          {unit && !organizing && <CreateMenu courseId={course.id} unitId={unit.id} club={isClub} tools={tools.length > 0} d={d} here />}
          {unit && (
            <form action={unitAction} className="row" style={{ gap: 6 }}>
              <input type="hidden" name="courseId" value={course.id} />
              <input type="hidden" name="unitId" value={unit.id} />
              <button className="icon-btn" name="op" value="up" aria-label={`${d.moveUp}: ${unit.title}`} disabled={si === 0}>{arrow("up")}</button>
              <button className="icon-btn" name="op" value="down" aria-label={`${d.moveDown}: ${unit.title}`} disabled={si === sibs.length - 1}>{arrow("down")}</button>
            </form>
          )}
          {unit && (
            <details className="menu">
              <summary className="btn btn-sm">{d.folderMenu}…</summary>
              <div className="menu-pop card">
                <form action={unitAction} className="stack" style={{ gap: 8 }}>
                  <input type="hidden" name="courseId" value={course.id} />
                  <input type="hidden" name="unitId" value={unit.id} />
                  <label className="label" htmlFor={`rn-${unit.id}`}>{nested ? d.folderTitle : d.unitTitle}</label>
                  <input id={`rn-${unit.id}`} name="title" className="field" defaultValue={unit.title} maxLength={200} required />
                  <button className="btn btn-primary btn-sm" name="op" value="rename">{d.rename}</button>
                </form>
                <form action={unitAction} className="stack" style={{ gap: 8, marginTop: 14 }}>
                  <input type="hidden" name="courseId" value={course.id} />
                  <input type="hidden" name="unitId" value={unit.id} />
                  <label className="label" htmlFor={`mv-${unit.id}`}>{d.folderMoveInto}</label>
                  <select id={`mv-${unit.id}`} name="parentId" className="field" defaultValue={unit.parentId || "top"}>
                    <option value="top">{d.folderTopLevel}</option>
                    {targets.map((c) => <option key={c.id} value={c.id} title={c.title}>{c.label}</option>)}
                  </select>
                  <button className="btn btn-sm" name="op" value="parent">{d.orgMove}</button>
                </form>
                <form action={unitAction} className="stack" style={{ gap: 6, marginTop: 14 }}>
                  <input type="hidden" name="courseId" value={course.id} />
                  <input type="hidden" name="unitId" value={unit.id} />
                  <button className="btn btn-sm" name="op" value="delete">{nested ? d.deleteFolder : d.deleteUnit}</button>
                  <span className="muted" style={{ fontSize: 12 }}>{parent ? d.deleteFolderHint.replace("{parent}", parent.title) : inner.length ? d.deleteUnitFoldersHint : d.deleteUnitHint}</span>
                </form>
              </div>
            </details>
          )}
        </div>
        {organizing && items.length > 0 && <SelectAll group={unit?.id || "loose"} label={d.orgSelectAll} />}
        {items.length === 0 ? (inner.length ? null : <p className="empty">{nested ? d.emptyFolder : d.emptyUnit}</p>) : (
          <ul className="list">
            {items.map((i, ii) => {
              const org = organizing ? { group: unit?.id || "loose", first: ii === 0, last: ii === items.length - 1 } : null;
              return i.kind === "lesson"
                ? <LessonRow key={i.lesson.id} l={i.lesson} live={live === i.lesson.id} d={d} place={placeOf(i)} org={org} />
                : i.kind === "assignment"
                  ? <AssignmentRow key={i.assignment.id} a={i.assignment} d={d} L={L} place={placeOf(i)} org={org} />
                  : <MaterialRow key={i.resource.id} r={i.resource} courseId={course.id} d={d} org={org} />;
            })}
          </ul>
        )}
        {inner.map((x) => renderFolder(x))}
      </section>
    );
  };

  return (
    <>
      <TopBar crumbs={<Link href="/">{d.myCourses}</Link>} below={<ClassHeader course={course} d={d} tab="plan" heading />} />
      <main className="page stack">
        <div className="row" style={{ alignItems: "center", flexWrap: "wrap", gap: 12 }}>
          <div style={{ flex: "1 1 16em", minWidth: 0 }}>
            {catalog && (
              <p className="row" style={{ margin: 0, gap: 8, fontSize: 14 }}>
                <span className="muted">{d.secOf}</span>
                <Link href={`/catalog/${catalog.id}`}>{catalog.name}</Link>
                <span className="muted">· {course.schoolYear || d.secNoYear}</span>
              </p>
            )}
          </div>          <CourseMenu label={d.courseMore} title={d.courseMoreTitle}>
            {previewable.length > 0 && (
              <section className="stack" style={{ gap: 6 }} aria-labelledby="preview-title">
                <h2 id="preview-title" className="label" style={{ margin: 0 }}>{d.previewAsStudent}</h2>
                {previewable.map((p) => (
                  <Link key={p.id} className="btn" href={`/preview/${p.id}/courses/${course.id}`}>{p.display_name}</Link>
                ))}
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.previewHint}</p>
              </section>
            )}
            {catalog && <Link href={`/courses/${course.id}/copy`} className="btn">{d.secCopy}</Link>}
            {!isClub && (
              <div className="stack" style={{ gap: 4 }}>
                <Link href={`/courses/${course.id}/import`} className="btn">{d.importCourse}</Link>
                <span className="muted" style={{ fontSize: 13 }}>{d.importCourseHint}</span>
              </div>
            )}
            <details>
              <summary className="label" style={{ cursor: "pointer", minHeight: 44, display: "flex", alignItems: "center" }}>{d.secMoveTitle}</summary>
              <form action={moveToCourse} className="stack" style={{ marginTop: 6, gap: 6 }}>
                <input type="hidden" name="courseId" value={course.id} />
                <label className="sr-only" htmlFor="move-course">{d.secMoveTitle}</label>
                <select id="move-course" name="catalogId" className="field" defaultValue={catalog?.id || "new"}>
                  {allCourses.map((k) => <option key={k.id} value={k.id}>{k.name}{k.subject ? ` · ${k.subject}` : ""}</option>)}
                  <option value="new">{d.secMoveNew}</option>
                </select>
                <button className="btn" type="submit" style={{ alignSelf: "flex-start" }}>{d.secMoveGo}</button>
              </form>
              <p className="muted" style={{ margin: "6px 0 0", fontSize: 13 }}>{d.secMoveHint}</p>
            </details>
            <ClubSwitch courseId={course.id} club={isClub} d={d} />
          </CourseMenu>
        </div>
        {suggested && (
          <div className="notice row" role="status" style={{ gap: 10 }}>
            <span className="grow">{fillName(d.secSuggest, suggested.name)}</span>
            <form action={moveToCourse}>
              <input type="hidden" name="courseId" value={course.id} />
              <input type="hidden" name="catalogId" value={suggested.id} />
              <button className="btn btn-sm btn-primary" type="submit">{fillName(d.secSuggestYes, suggested.name)}</button>
            </form>
          </div>
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

        {updates}
        {isClub && <ClubEvents courseId={course.id} events={events!} sponsor L={L} d={d} error={sp.eventError} />}
        {isClub && <ClubMembers ok={clubRoster!.ok} members={clubRoster!.members} d={d} />}

        <div className="row materials-head" style={{ gap: 10, flexWrap: "wrap" }}>
          <h2 className="grow" style={{ margin: 0, fontSize: 22 }}>{d.orgMaterials}</h2>
          {!organizing && <CreateMenu courseId={course.id} club={isClub} tools={tools.length > 0} d={d} />}
          {(lessons.length > 0 || assignments.length > 0 || resources.length > 0) && (
            <Link className={`btn${organizing ? " btn-primary" : ""}`} href={organizing ? here : `${here}?organize=1`} scroll={false}>
              {organizing ? d.orgDone : d.orgStart}
            </Link>
          )}
        </div>
        {lessons.length === 0 && assignments.length === 0 && units.length === 0 && resources.length === 0 && <p className="empty">{d.crEmpty}</p>}
        {organizing && (
          <form id="org" action={organize} className="card org-bar stack" style={{ gap: 8 }} aria-label={d.orgStart}>
            <input type="hidden" name="courseId" value={course.id} />
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>{d.orgHint}</p>
            <SelectedCount template={d.orgSelected} />
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <label className="label" htmlFor="org-unit" style={{ margin: 0 }}>{d.orgMoveTo}</label>
              <select id="org-unit" name="toUnit" className="field" style={{ width: "auto", flex: "0 1 240px" }} defaultValue={units[0]?.id || "none"}>
                {choices.map((u) => <option key={u.id} value={u.id} title={u.title}>{u.label}</option>)}
                <option value="none">{d.noUnit}</option>
              </select>
              <button className="btn btn-sm" name="op" value="move">{d.orgMove}</button>
            </div>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <label className="label" htmlFor="org-view" style={{ margin: 0 }}>{d.svLabel}</label>
              <select id="org-view" name="view" className="field" style={{ width: "auto", flex: "0 1 320px" }} defaultValue="list">
                <option value="hidden">{d.svHidden}</option>
                <option value="list">{d.svList}</option>
                <option value="thread">{d.svThread}</option>
              </select>
              <button className="btn btn-sm" name="op" value="view">{d.orgApply}</button>
            </div>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.orgAssignNote}</p>
            <div className="row" style={{ gap: 8, flexWrap: "wrap", borderTop: "1px solid var(--line)", paddingTop: 8 }}>
              <label className="label" htmlFor="org-ptitle" style={{ margin: 0 }}>{d.resPresentTitle}</label>
              <input id="org-ptitle" name="title" className="field" style={{ flex: "1 1 200px", width: "auto" }} maxLength={200} placeholder={`${d.resPresentation} · ${today}`} />
              <input type="hidden" name="fallback" value={`${d.resPresentation} · ${today}`} />
              <button className="btn btn-sm btn-primary" name="op" value="present">{d.resPresentSel}</button>
              <button className="btn btn-sm" name="op" value="makepage">{d.crMakePageSel}</button>
            </div>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.crPresentHint}</p>
            {sp.none && <p className="notice" role="alert" style={{ margin: 0 }}>{d.resNoneTicked}</p>}
          </form>
        )}

        {[...units.filter((u) => u.depth === 0), null].map((u) => renderFolder(u))}

        {archivedMaterials.length > 0 && (
          <details className="card">
            <summary className="label">{d.resArchived} ({archivedMaterials.length})</summary>
            <ul className="list" style={{ marginTop: 8 }}>
              {archivedMaterials.map((r) => (
                <li key={r.id}>
                  <span className="grow">{r.title} <span className="muted" style={{ fontSize: 13 }}>· {r.kind === "lesson" ? d.lesson : r.block ? materialKind(r.block, d) : d.matMaterial}</span></span>
                  <form action={restoreMaterial}>
                    <input type="hidden" name="courseId" value={course.id} />
                    <input type="hidden" name="id" value={r.id} />
                    <button className="btn btn-sm" name="op" value="restore">{d.resRestore}</button>
                  </form>
                </li>
              ))}
            </ul>
          </details>
        )}
      </main>
    </>
  );
}

type Org = { group: string; first: boolean; last: boolean } | null;

/** Organize mode's checkbox and arrows for one row (all in the "org" form). */
function OrgControls({ k, title, org, d }: { k: string; title: string; org: NonNullable<Org>; d: Dict }) {
  return (
    <>
      <input type="checkbox" name="item" value={k} form="org" data-org-group={org.group} aria-label={d.orgPick.replace("{title}", title)} className="org-check" />
      <span className="row" style={{ gap: 4, flex: "0 0 auto" }}>
        <button className="icon-btn" form="org" name="op" value={`up:${k}`} aria-label={`${d.moveUp}: ${title}`} disabled={org.first}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M6 15l6-6 6 6" /></svg>
        </button>
        <button className="icon-btn" form="org" name="op" value={`down:${k}`} aria-label={`${d.moveDown}: ${title}`} disabled={org.last}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
        </button>
      </span>
    </>
  );
}

function ViewPill({ view, d }: { view: Place["studentView"]; d: Dict }) {
  if (view === "hidden") return <span className="pill pill-draft" style={{ marginLeft: 6 }}>{d.svPillHidden}</span>;
  return <span className="pill" style={{ marginLeft: 6 }}>{view === "thread" ? d.svPillThread : d.svPillList}</span>;
}

function LessonRow({ l, live, d, place, org }: { l: LessonSummary; live: boolean; d: Dict; place: Place; org: Org }) {
  return (
    <li>
      {org ? <OrgControls k={`lesson:${l.id}`} title={l.title} org={org} d={d} /> : <span className="shape s-arch" aria-hidden="true" />}
      <div className="grow">
        <h3><Link href={`/lessons/${l.id}`} style={{ color: "inherit" }}>{l.title}</Link></h3>
        <span className="muted" style={{ fontSize: 13 }}>
          {l.plannedFor ? `${l.plannedFor} · ` : ""}{l.durationMin} min · {l.blockCount} {d.blocks}
        </span>
        <ViewPill view={place.studentView} d={d} />
        {live && <span style={{ marginLeft: 6 }}><LiveJoin href={`/lessons/${l.id}/present`} label={`${d.joinLive}: ${l.title}`} text={d.liveNowJoin} /></span>}
      </div>
      {!org && <Link className="btn" href={`/lessons/${l.id}/edit`}>{d.edit}</Link>}
      {!org && <Link className="btn btn-primary" href={`/lessons/${l.id}/present`}>{d.present}</Link>}
    </li>
  );
}

function AssignmentRow({ a, d, L, place, org }: { a: Assignment; d: Dict; L: Lang; place: Place; org: Org }) {
  return (
    <li>
      {org ? <OrgControls k={`assignment:${a.id}`} title={a.title} org={org} d={d} /> : <span className="shape s-tri" aria-hidden="true" />}
      <div className="grow">
        <h3>{a.title}</h3>
        <span className="muted" style={{ fontSize: 13 }}>
          {a.dueAt ? <>{d.due} <When iso={a.dueAt} lang={L} /> · </> : `${d.noDue} · `}{a.points} {d.pts}
          {a.kind === "offline" ? ` · ${d.kindOffline}` : a.kind === "quiz" ? ` · ${d.kindQuiz}` : ""}
        </span>
        {!a.published && <span className="pill pill-draft" style={{ marginLeft: 6 }}>{d.draft}</span>}
        {a.published && place.threadPostId && <span className="pill" style={{ marginLeft: 6 }}>{d.svPillThread}</span>}
      </div>
      {!org && <Link className="btn" href={`/assignments/${a.id}`}>{d.edit}</Link>}
      {!org && <Link className="btn btn-primary" href={`/assignments/${a.id}/grade`}>{d.openGrading}</Link>}
    </li>
  );
}

/** A class material (migration 027): opens its own page, where the teacher edits, shows/hides or archives it. */
function MaterialRow({ r, courseId, d, org }: { r: Resource; courseId: string; d: Dict; org: Org }) {
  const kind = r.kind === "lesson" ? d.lesson : r.block ? materialKind(r.block, d) : d.matMaterial;
  const shape = r.kind === "lesson" ? "s-arch" : r.block ? BLOCK_SHAPE[r.block.type] : "s-circle";
  return (
    <li>
      {org ? <OrgControls k={`resource:${r.id}`} title={r.title} org={org} d={d} /> : <span className={`shape ${shape}`} aria-hidden="true" />}
      <div className="grow">
        <h3><Link href={`/courses/${courseId}/materials/${r.id}`} style={{ color: "inherit" }}>{r.title}</Link></h3>
        <span className="muted material-kind">{kind}</span>
        {studentCanSee(r)
          ? <span className={`pill${r.visible ? "" : " pill-draft"}`} style={{ marginLeft: 6 }}>{r.visible ? d.resShown : d.resHidden}</span>
          : <span className="pill pill-draft" style={{ marginLeft: 6 }}>{d.svPillHidden}</span>}
      </div>
      {!org && r.kind === "block" && <Link className="btn" href={`/courses/${courseId}/materials/${r.id}?edit=1`}>{d.edit}</Link>}
      {!org && <Link className="btn btn-primary" href={`/courses/${courseId}/materials/${r.id}`}>{d.matOpen}</Link>}
    </li>
  );
}

// ---------- a student's view ----------

