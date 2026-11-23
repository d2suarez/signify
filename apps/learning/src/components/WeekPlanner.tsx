"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type DragEvent } from "react";
import { addSchoolDays, pushBack, spreadLessons } from "@/lib/planner";
import { onSabbath, type Day } from "@/lib/calendar";
import type { Dict, Lang } from "@/lib/i18n";
import { localTime } from "./CourseCalendar";
import type { PlanMaterial, PlanStandard } from "@/lib/week-plan";

export type PlannerLesson = { id: string; title: string; plannedFor: Day | null; version: number; unitId: string | null };
export type PlannerCourse = {
  id: string;
  name: string;
  lessons: PlannerLesson[];
  due: { id: string; title: string; dueOn: Day; dueAt: string | null; draft: boolean }[];
  /** Folders in tree order; `within` = the folder and every folder inside it. */
  units: { id: string; title: string; within?: string[] }[];
  /** The class's resources, for "Start from" in quick-add (optional so older callers still fit). */
  resources?: { id: string; title: string }[];
  /** Story 01 B1/B2: materials picked onto each day and the day's standards. */
  plan?: Record<Day, { materials: PlanMaterial[]; standards: PlanStandard[]; presentation?: { id: string; title: string } | null; lessons?: number }>;
  /** What can be picked onto a day ("assignment:id" / "resource:id"), with its folder path. */
  pickable?: { key: string; title: string; sub: string; kind: "assignment" | "resource"; folder: string }[];
  /** The course's standards, to add to a day by hand. */
  standards?: { id: string; code: string; description: string }[];
};

export type PlanAction = (formData: FormData) => Promise<{ error?: string }>;

const NONE = "none";

/**
 * The week grid, one course per band. Every change is a lesson save naming
 * the version it started from (PUT /api/lessons/[id]); if a lesson was changed
 * elsewhere in the meantime the save is refused, the page says so and reloads.
 */
export default function WeekPlanner({ courses, days, today, L, d, addLesson, planAction, presentAction, back = "/planner", single = false }: {
  courses: PlannerCourse[]; days: Day[]; today: Day; L: Lang; d: Dict;
  /** The page to come back to when a day can't be presented. */
  back?: string;
  /** A class's own Planner tab: one class, so no heading linking to it. */
  single?: boolean;
  addLesson: (formData: FormData) => Promise<void>;
  planAction?: PlanAction;
  /** "Present this day": redirects to the presenter (B3). */
  presentAction?: (formData: FormData) => Promise<void>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [dragging, setDragging] = useState<{ courseId: string; lessonId: string } | null>(null);

  const locale = L === "es" ? "es" : "en-US";
  const dayName = (day: Day, style: "long" | "short") =>
    new Date(`${day}T12:00:00Z`).toLocaleDateString(locale, { weekday: style, month: style === "long" ? "long" : "numeric", day: "numeric", timeZone: "UTC" });
  const nextMonday = addSchoolDays(days[4], 1);

  /** Saves each move in turn; stops at the first refusal. */
  async function moves(list: { lesson: PlannerLesson; plannedFor: Day | null }[]) {
    const todo = list.filter((m) => m.lesson.plannedFor !== m.plannedFor);
    if (!todo.length || busy) return;
    setBusy(true);
    setNote({ text: d.saving });
    try {
      for (const { lesson, plannedFor } of todo) {
        const res = await fetch(`/api/lessons/${lesson.id}`, {
          method: "PUT", headers: { "content-type": "application/json" },
          body: JSON.stringify({ baseVersion: lesson.version, plannedFor }),
        });
        if (res.status === 409) { setNote({ text: d.plannerConflict, bad: true }); return; }
        if (!res.ok) throw new Error(String(res.status));
      }
      setNote({ text: todo.length === 1 ? d.plannerMoved : `${d.plannerMovedMany} ${todo.length}` });
    } catch {
      setNote({ text: d.plannerFailed, bad: true });
    } finally {
      setBusy(false);
      router.refresh();
    }
  }

  const find = (courseId: string, lessonId: string) =>
    courses.find((c) => c.id === courseId)?.lessons.find((l) => l.id === lessonId);

  const dropProps = (courseId: string, target: Day | null) => ({
    onDragOver: (e: DragEvent) => { if (dragging?.courseId === courseId) e.preventDefault(); },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      const l = dragging && dragging.courseId === courseId ? find(courseId, dragging.lessonId) : null;
      setDragging(null);
      if (l) moves([{ lesson: l, plannedFor: target }]);
    },
  });

  const LessonCard = ({ course, lesson }: { course: PlannerCourse; lesson: PlannerLesson }) => (
    <div className={`plan-lesson${dragging?.lessonId === lesson.id ? " is-dragging" : ""}`} draggable={!busy}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", lesson.id); setDragging({ courseId: course.id, lessonId: lesson.id }); }}
      onDragEnd={() => setDragging(null)}>
      <span className="shape s-arch" aria-hidden="true" />
      <Link href={`/lessons/${lesson.id}/edit`} className="plan-title">{lesson.title}</Link>
      <select aria-label={`${d.moveTo}: ${lesson.title}`} value={lesson.plannedFor && days.includes(lesson.plannedFor) ? lesson.plannedFor : ""}
        disabled={busy} onChange={(e) => {
          const v = e.target.value;
          if (v) moves([{ lesson, plannedFor: v === NONE ? null : v }]);
        }}>
        <option value="" disabled>{d.moveTo}…</option>
        {days.map((day) => <option key={day} value={day}>{dayName(day, "long")}</option>)}
        <option value={nextMonday}>{d.nextWeek}: {dayName(nextMonday, "long")}</option>
        <option value={NONE}>{d.notScheduled}</option>
      </select>
    </div>
  );

  return (
    <div className="stack">
      <p className="muted" style={{ margin: 0 }}>{d.plannerHint}</p>
      <p role="status" aria-live="polite" className={note?.bad ? "notice notice-bad" : "save-state"} style={{ margin: 0, minHeight: "1.5em" }}>
        {note?.text}
        {note?.bad && <> <button type="button" className="btn btn-sm" onClick={() => { setNote(null); router.refresh(); }}>{d.reload}</button></>}
      </p>

      {courses.map((course) => {
        const unplanned = course.lessons.filter((l) => !l.plannedFor);
        return (
          <section key={course.id} className="card plan-course" aria-labelledby={`pc-${course.id}`}>
            <div className="row">
              <h2 id={`pc-${course.id}`} className={single ? "grow sr-only" : "grow"} style={{ fontSize: 22 }}>
                <Link href={`/courses/${course.id}`}>{course.name}</Link>
              </h2>
              {single && <span className="grow" />}
              <PlanUnit course={course} days={days} d={d} busy={busy} dayName={(x) => dayName(x, "long")}
                onPlan={(unitId, start) => {
                  const within = new Set(course.units.find((u) => u.id === unitId)?.within ?? [unitId]);
                  const inUnit = course.lessons.filter((l) => !!l.unitId && within.has(l.unitId));
                  const plan = spreadLessons(inUnit, start);
                  if (!plan.length) { setNote({ text: d.planUnitEmpty, bad: true }); return; }
                  if (!window.confirm(`${d.planUnitConfirm} ${plan.length}`)) return;
                  moves(plan.map((p) => ({ lesson: inUnit.find((l) => l.id === p.id)!, plannedFor: p.plannedFor })));
                }} />
            </div>

            <div className="plan-week">
              {days.map((day) => {
                const lessons = course.lessons.filter((l) => l.plannedFor === day);
                const due = course.due.filter((a) => a.dueOn === day);
                const key = `${course.id}:${day}`;
                return (
                  <div key={day} className={`plan-day${day === today ? " is-today" : ""}${dragging?.courseId === course.id ? " is-target" : ""}`}
                    {...dropProps(course.id, day)} aria-current={day === today ? "date" : undefined}>
                    <div className="plan-day-head">
                      <b>{dayName(day, "short")}</b>
                      <button type="button" className="link-btn" disabled={busy} title={d.pushBackHint}
                        aria-label={`${d.pushBack}: ${course.name}, ${dayName(day, "long")}`}
                        onClick={() => {
                          const plan = pushBack(course.lessons, day);
                          if (!plan.length) { setNote({ text: d.pushBackNone }); return; }
                          if (!window.confirm(`${d.pushBackConfirm} ${plan.length}`)) return;
                          moves(plan.map((p) => ({ lesson: course.lessons.find((l) => l.id === p.id)!, plannedFor: p.plannedFor })));
                        }}>{d.pushBack}</button>
                    </div>
                    {lessons.map((l) => <LessonCard key={l.id} course={course} lesson={l} />)}
                    {due.map((a) => (
                      <Link key={a.id} href={`/assignments/${a.id}`} className="plan-due">
                        <span className="shape s-tri" aria-hidden="true" />
                        <span className="grow">{d.due}: {a.title}</span>
                        {a.draft && <span className="pill pill-draft">{d.draft}</span>}
                        {onSabbath(a.dueOn, localTime(a.dueAt)) && <span className="chip chip-late">⚠ {d.sabbath}</span>}
                      </Link>
                    ))}
                    {planAction && course.plan && (
                      <DayPlan course={course} day={day} days={days} d={d} busy={busy} dayName={(x) => dayName(x, "long")} presentAction={presentAction} back={back}
                        act={async (fd) => {
                          setBusy(true);
                          try {
                            const r = await planAction(fd);
                            setNote(r.error ? { text: r.error === "full" ? d.planFull : d.plannerFailed, bad: true } : null);
                          } catch { setNote({ text: d.plannerFailed, bad: true }); }
                          finally { setBusy(false); router.refresh(); }
                        }} />
                    )}
                    {adding === key ? (
                      <form action={async (fd) => { await addLesson(fd); setAdding(null); }} className="plan-add">
                        <input type="hidden" name="courseId" value={course.id} />
                        <input type="hidden" name="day" value={day} />
                        <input name="title" required maxLength={200} autoFocus aria-label={`${d.lessonTitle}, ${dayName(day, "long")}`} placeholder={d.lessonTitle} />
                        {!!course.resources?.length && (
                          <select name="resource" aria-label={`${d.resStartFrom}, ${dayName(day, "long")}`} defaultValue="">
                            <option value="">{d.resStartEmpty}</option>
                            {course.resources.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
                          </select>
                        )}
                        <div className="row" style={{ gap: 6 }}>
                          <button className="btn btn-sm btn-primary">{d.add}</button>
                          <button type="button" className="btn btn-sm" onClick={() => setAdding(null)}>{d.cancel}</button>
                        </div>
                      </form>
                    ) : (
                      <button type="button" className="link-btn plan-add-btn" onClick={() => setAdding(key)}
                        aria-label={`${d.newLesson}: ${course.name}, ${dayName(day, "long")}`}>+ {d.lesson}</button>
                    )}
                  </div>
                );
              })}
            </div>

            <details className="plan-unplanned" {...dropProps(course.id, null)} open={dragging?.courseId === course.id || undefined}>
              <summary>{d.notScheduled} ({unplanned.length})</summary>
              {unplanned.length === 0
                ? <p className="empty" style={{ margin: 0 }}>{d.notScheduledEmpty}</p>
                : <div className="plan-unplanned-list">{unplanned.map((l) => <LessonCard key={l.id} course={course} lesson={l} />)}</div>}
            </details>
          </section>
        );
      })}
    </div>
  );
}

/** "Plan a unit": its lessons one school day apart, in order, from a chosen day. */
function PlanUnit({ course, days, d, busy, dayName, onPlan }: {
  course: PlannerCourse; days: Day[]; d: Dict; busy: boolean; dayName: (day: Day) => string;
  onPlan: (unitId: string, start: Day) => void;
}) {
  const [open, setOpen] = useState(false);
  const [unit, setUnit] = useState(course.units[0]?.id ?? "");
  const [start, setStart] = useState(days[0]);
  if (!course.units.length) return null;
  if (!open) return <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>{d.planUnit}</button>;
  return (
    <form className="row plan-unit" onSubmit={(e) => { e.preventDefault(); onPlan(unit, start); setOpen(false); }}>
      <label>{d.unit} <select value={unit} onChange={(e) => setUnit(e.target.value)}>
        {course.units.map((u) => <option key={u.id} value={u.id}>{u.title}</option>)}
      </select></label>
      <label>{d.planUnitStart} <select value={start} onChange={(e) => setStart(e.target.value)}>
        {days.map((day) => <option key={day} value={day}>{dayName(day)}</option>)}
      </select></label>
      <button className="btn btn-sm btn-primary" disabled={busy}>{d.planUnitGo}</button>
      <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>{d.cancel}</button>
    </form>
  );
}

const SUB_ICON: Record<string, string> = { quiz: "?", lesson: "◗", link: "↗", file: "📎", video: "▶", board: "▦", text: "¶" };

/**
 * One day's picked materials and standards (story 01, B1/B2). Materials are
 * pointers to the folder tree; a standard comes from what's on the day, or by
 * hand. Every change is one small form posted to the page's planAction.
 */
function DayPlan({ course, day, days, d, busy, dayName, act, presentAction, back }: {
  course: PlannerCourse; day: Day; days: Day[]; d: Dict; busy: boolean; dayName: (day: Day) => string; back: string;
  act: (fd: FormData) => Promise<void>;
  presentAction?: (formData: FormData) => Promise<void>;
}) {
  const [picking, setPicking] = useState(false);
  const plan = course.plan?.[day] ?? { materials: [], standards: [] };
  const send = (fields: Record<string, string>) => {
    const fd = new FormData();
    fd.set("courseId", course.id);
    fd.set("day", day);
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return act(fd);
  };
  const groups = new Map<string, NonNullable<PlannerCourse["pickable"]>>();
  for (const m of course.pickable ?? []) {
    const g = m.folder || d.notInFolder;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(m);
  }
  const onDay = new Set(plan.materials.map((m) => `${m.kind}:${m.id}`));
  const unused = (course.standards ?? []).filter((s) => !plan.standards.some((x) => x.id === s.id));
  const label = `${course.name}, ${dayName(day)}`;

  const show = plan.presentation ?? null;
  const hasSomething = (plan.lessons ?? 0) + plan.materials.length > 0;
  const presentTitle = `${course.name} · ${dayName(day)}`;

  return (
    <>
      {presentAction && (show || hasSomething) && (
        <form action={presentAction} className="plan-present">
          <input type="hidden" name="courseId" value={course.id} />
          <input type="hidden" name="back" value={back} />
          <input type="hidden" name="day" value={day} />
          <input type="hidden" name="title" value={presentTitle} />
          <button className="btn btn-sm btn-primary" name="op" value="present" disabled={busy}
            aria-label={`${d.planPresentDay}: ${label}`}>▶ {show ? d.present : d.planPresentDay}</button>
          {show && (
            <span className="plan-present-more">
              <button className="link-btn" name="op" value="edit" disabled={busy} aria-label={`${d.edit}: ${show.title}`}>{d.edit}</button>
              {hasSomething && (
                <button className="link-btn" name="again" value="1" disabled={busy} title={d.planPresentAgainHint}
                  onClick={(e) => { if (!window.confirm(d.planPresentAgainConfirm)) e.preventDefault(); }}>{d.planPresentAgain}</button>
              )}
            </span>
          )}
        </form>
      )}
      {plan.materials.map((m) => (
        <div key={m.itemId} className="plan-mat">
          <span className={`shape ${m.kind === "assignment" ? "s-tri" : "s-square"}`} aria-hidden="true" />
          <Link href={m.href} className="plan-title">
            {SUB_ICON[m.sub] && m.sub !== "online" && m.sub !== "offline" ? <span aria-hidden="true">{SUB_ICON[m.sub]} </span> : null}
            {m.title || d.untitled}
          </Link>
          {m.hidden && <span className="pill pill-draft">{m.kind === "assignment" ? d.draft : d.pcHiddenFromStudents}</span>}
          <select aria-label={`${d.moveTo}: ${m.title}`} value="" disabled={busy}
            onChange={(e) => { const v = e.target.value; if (v === "off") send({ op: "unpick", item: m.itemId }); else if (v) { const fd = new FormData(); fd.set("courseId", course.id); fd.set("day", v); fd.set("op", "move"); fd.set("item", m.itemId); act(fd); } }}>
            <option value="" disabled>{d.moveTo}…</option>
            {days.filter((x) => x !== day).map((x) => <option key={x} value={x}>{dayName(x)}</option>)}
            <option value="off">{d.planTakeOff}</option>
          </select>
        </div>
      ))}

      {picking ? (
        <form className="plan-add" onSubmit={(e) => { e.preventDefault(); const v = new FormData(e.currentTarget).get("pick"); if (v) send({ op: "pick", pick: String(v) }).then(() => setPicking(false)); }}>
          <select name="pick" required autoFocus aria-label={`${d.planPickMaterial}: ${label}`} defaultValue="">
            <option value="" disabled>{d.planPickMaterial}…</option>
            {[...groups.entries()].map(([g, list]) => (
              <optgroup key={g} label={g}>
                {list.map((m) => (
                  <option key={m.key} value={m.key} disabled={onDay.has(m.key)}>
                    {m.kind === "assignment" ? (m.sub === "quiz" ? `${d.kindQuiz}: ` : `${d.pcKindAssignment}: `) : ""}{m.title || d.untitled}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn btn-sm btn-primary" disabled={busy}>{d.add}</button>
            <button type="button" className="btn btn-sm" onClick={() => setPicking(false)}>{d.cancel}</button>
          </div>
        </form>
      ) : !!course.pickable?.length && (
        <button type="button" className="link-btn plan-pick-btn" onClick={() => setPicking(true)} aria-label={`${d.planPickMaterial}: ${label}`}>+ {d.matMaterial}</button>
      )}

      {(plan.standards.length > 0 || unused.length > 0) && (
        <details className="plan-std">
          <summary>{d.planStandards} ({plan.standards.length})</summary>
          {plan.standards.length === 0 && <p className="muted" style={{ margin: "4px 0", fontSize: 12 }}>{d.planNoStandards}</p>}
          <ul>
            {plan.standards.map((s) => (
              <li key={s.id} title={`${s.description}${s.from.length ? `\n${d.planFrom}: ${s.from.join(", ")}` : ""}`}>
                <b>{s.code}</b> <span className="muted">{s.description}</span>
                {s.byHand && (
                  <button type="button" className="link-btn" disabled={busy} aria-label={`${d.remove}: ${s.code}, ${dayName(day)}`}
                    onClick={() => send({ op: "unstd", standard: s.id })}>×</button>
                )}
              </li>
            ))}
          </ul>
          {unused.length > 0 && (
            <form className="plan-add" onSubmit={(e) => { e.preventDefault(); const v = new FormData(e.currentTarget).get("standard"); if (v) send({ op: "std", standard: String(v) }); }}>
              <select name="standard" required aria-label={`${d.planAddStandard}: ${label}`} defaultValue="">
                <option value="" disabled>{d.planAddStandard}…</option>
                {unused.map((s) => <option key={s.id} value={s.id}>{s.code} {s.description.slice(0, 80)}</option>)}
              </select>
              <button className="btn btn-sm" disabled={busy}>{d.add}</button>
            </form>
          )}
        </details>
      )}
    </>
  );
}
