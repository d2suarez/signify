"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import type { Dict, Lang } from "@/lib/i18n";
import type { RailData } from "@/lib/rail";
import type { WidgetKind } from "@/lib/widgets";
import { TodoPanel } from "../Todo";
import { KindList } from "./KindList";
import { ClassChoice, ClockTool, GroupsTool, NoiseTool, PickerTool, SeatingTool, TimerTool } from "./tools";

/**
 * Pages that need the whole screen or have a layout of their own get no
 * rail: presenting, the projector view, the live student view, the lesson
 * editor, the gradebook grid, grading one student at a time, the week
 * planner's five days, previews (they show someone else's view), LTI and
 * launch pages. A quiz being taken hides it too (QuizTaker marks the page
 * with data-no-rail).
 */
const NO_RAIL = [
  /^\/lessons\/[^/]+\/(present|project|edit)(\/|$)/,
  /^\/courses\/[^/]+\/(live|gradebook)(\/|$)/,
  /^\/assignments\/[^/]+\/grade(\/|$)/,
  /^\/planner(\/|$)/,
  /^\/(preview|lti|launch|files|dev)(\/|$)/,
];
export const hasRail = (path: string) => !NO_RAIL.some((re) => re.test(path));

/** Wraps every page: the page, then the rail (shown on the left on wide screens, below the page on narrow ones). */
export function RailShell({ children, d, lang, signedIn }: { children: ReactNode; d: Dict; lang: Lang; signedIn: boolean }) {
  const path = usePathname() || "/";
  const on = signedIn && hasRail(path);
  return (
    <div className={`shell ${on ? "has-rail" : ""}`}>
      {children}
      {on && <Rail d={d} lang={lang} path={path} />}
    </div>
  );
}

const CLASS_KEY = "sl-wg-class";

function Rail({ d, lang, path }: { d: Dict; lang: Lang; path: string }) {
  const [data, setData] = useState<RailData | null>(null);
  const [todo, setTodo] = useState<RailData["todo"]>(undefined);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saveBad, setSaveBad] = useState(false);
  const [big, setBig] = useState<WidgetKind | null>(null);
  const [chosenClass, setChosenClass] = useState<string | null>(null);
  const todoAt = useRef(0);
  const opener = useRef<HTMLElement | null>(null);

  const load = useCallback(async (p: string) => {
    // To do is the same on every page; ask for it again at most once a minute (and always on home).
    const wantTodo = p === "/" || Date.now() - todoAt.current > 60_000;
    try {
      const res = await fetch(`/api/rail?path=${encodeURIComponent(p)}${wantTodo ? "&todo=1" : ""}`, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const j = (await res.json()) as RailData;
      setData(j);
      if (j.todo) { setTodo(j.todo); todoAt.current = Date.now(); }
      setFailed(false);
    } catch { setFailed(true); }
  }, []);

  useEffect(() => { load(path); setEditing(false); setBig(null); }, [path, load]);
  useEffect(() => { try { setChosenClass(localStorage.getItem(CLASS_KEY)); } catch { /* private mode */ } }, []);

  const context = data?.context;
  const save = async (widgets: WidgetKind[] | null) => {
    if (!data) return;
    const before = data;
    if (widgets) setData({ ...data, widgets, from: "own" });
    setSaveBad(false);
    const res = await fetch("/api/rail", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, widgets }),
    }).catch(() => null);
    if (!res?.ok) { setData(before); setSaveBad(true); return; }
    const j = await res.json();
    // Only if the rail is still showing the same place.
    setData((cur) => (cur && cur.context === before.context ? { ...cur, ...j } : cur));
  };

  const closeBig = useCallback(() => { setBig(null); requestAnimationFrame(() => opener.current?.focus()); }, []);
  useEffect(() => {
    if (!big) return;
    requestAnimationFrame(() => document.querySelector<HTMLElement>(".wg-big .wg-head button")?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { closeBig(); return; }
      // Keep the keyboard inside the large view while it is open.
      if (e.key !== "Tab") return;
      const box = document.querySelector<HTMLElement>(".wg-big");
      const els = box ? Array.from(box.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href]")).filter((x) => !x.hasAttribute("disabled")) : [];
      if (!els.length) return;
      const first = els[0], last = els[els.length - 1];
      if (e.shiftKey && (document.activeElement === first || !box!.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !box!.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [big, closeBig]);

  const isHome = path === "/";
  const teacherHere = data?.course?.role === "teacher";
  const rosterCourse = data?.course ? (teacherHere ? data.course.id : null)
    : data && chosenClass && data.teaching.some((c) => c.id === chosenClass) ? chosenClass : null;
  const props = { d, lang, courseId: rosterCourse };
  const className = data?.course?.name ?? data?.teaching.find((c) => c.id === rosterCourse)?.name ?? "";

  return (
    <aside className="rail" id="rail" aria-label={d.wgRail} data-home={isHome ? "" : undefined}>
      {todo ? <TodoPanel teacher={todo.teacher} student={todo.student} d={d} L={lang} headingId="rail-todo-title" /> : (
        <section className="card side-card todo" aria-labelledby="rail-todo-wait">
          <h2 id="rail-todo-wait" className="label">{d.todoTitle}</h2>
          <p className="muted todo-empty">{failed ? <>{d.wgFailed} <button type="button" className="btn btn-sm" onClick={() => load(path)}>{d.tryAgain}</button></> : d.wgLoading}</p>
        </section>
      )}

      <section className="card side-card rail-tools" aria-labelledby="rail-tools-title">
        <div className="row" style={{ gap: 8 }}>
          <h2 id="rail-tools-title" className="label grow">{d.wgTools}</h2>
          {data && (
            <button type="button" className="btn btn-sm" aria-pressed={editing} onClick={() => setEditing(!editing)}>
              {editing ? d.wgDone : d.wgChange}
            </button>
          )}
        </div>
        {data && (
          <p className="muted wg-small" style={{ margin: 0 }}>
            {data.course ? `${d.wgCtxClass}: ${data.course.name}` : d.wgCtxHome} · {data.from === "own" ? d.wgFromOwn : data.from === "class" ? d.wgFromClass : d.wgFromSchool}
          </p>
        )}
        {!data && !failed && <p className="muted wg-small" style={{ margin: 0 }}>{d.wgLoading}</p>}
        {!data && failed && <p className="notice notice-bad wg-small" role="alert" style={{ margin: 0 }}>{d.wgFailed}</p>}
        {saveBad && <p className="notice notice-bad wg-small" role="alert" style={{ margin: 0 }}>{d.wgSaveFailed}</p>}

        {data && editing && (
          <div className="stack" style={{ gap: 14 }}>
            <KindList kinds={data.widgets} candidates={[...data.widgets, ...data.addable]} onChange={(k) => save(k)} d={d} label={d.wgKindList} />
            {data.addable.length === 0 && <p className="muted wg-small" style={{ margin: 0 }}>{d.wgNothingToAdd}</p>}
            {data.from === "own" && <button type="button" className="btn btn-sm" onClick={() => save(null)}>{d.wgReset}</button>}
            {teacherHere && data.students && data.course && (
              <StudentDefaults key={context} d={d} courseId={data.course.id} initial={data.students} />
            )}
          </div>
        )}

        {data && !editing && data.widgets.length === 0 && <p className="muted wg-small" style={{ margin: 0 }}>{d.wgNone}</p>}
        {data && !editing && data.widgets.map((k) => {
          const isBig = big === k;
          const roster = k === "picker" || k === "groups" || k === "seating";
          return (
            <section key={k} className={`wg ${isBig ? "wg-big" : ""}`} aria-labelledby={`wg-${k}-t`}
              role={isBig ? "dialog" : undefined} aria-modal={isBig ? true : undefined}>
              <div className="wg-head">
                <span className={`shape ${k === "clock" || k === "timer" ? "s-circle" : "s-square"}`} aria-hidden="true" />
                <h3 id={`wg-${k}-t`} className="grow">{d[`wg_${k}`]}{isBig && roster && className ? ` · ${className}` : ""}</h3>
                {isBig ? (
                  <button type="button" className="btn btn-sm" onClick={closeBig}>{d.close}</button>
                ) : (
                  <button type="button" className="btn btn-sm" aria-label={`${d.wgBig}: ${d[`wg_${k}`]}`}
                    onClick={(e) => { opener.current = e.currentTarget; setBig(k); }}>{d.wgBig}</button>
                )}
              </div>
              {roster && !data.course && (
                <ClassChoice d={d} teaching={data.teaching} value={rosterCourse}
                  onChange={(id) => { setChosenClass(id); try { if (id) localStorage.setItem(CLASS_KEY, id); else localStorage.removeItem(CLASS_KEY); } catch { /* */ } }} />
              )}
              {k === "clock" && <ClockTool {...props} big={isBig} />}
              {k === "timer" && <TimerTool {...props} big={isBig} />}
              {k === "noise" && <NoiseTool {...props} big={isBig} />}
              {k === "picker" && <PickerTool {...props} big={isBig} />}
              {k === "groups" && <GroupsTool {...props} big={isBig} />}
              {k === "seating" && <SeatingTool {...props} big={isBig} onArrange={() => setBig("seating")} />}
            </section>
          );
        })}
      </section>
      {big && <div className="wg-scrim" aria-hidden="true" onClick={closeBig} />}
    </aside>
  );
}

/** A class's teacher: what students start with here, within what the school allows. */
function StudentDefaults({ d, courseId, initial }: { d: Dict; courseId: string; initial: NonNullable<RailData["students"]> }) {
  const [chosen, setChosen] = useState<WidgetKind[] | null>(initial.chosen);
  const [msg, setMsg] = useState<"" | "saved" | "bad">("");
  const put = async (widgets: WidgetKind[] | null) => {
    const before = chosen;
    setChosen(widgets);
    const res = await fetch(`/api/courses/${courseId}/student-widgets`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ widgets }),
    }).catch(() => null);
    if (res?.ok) { setChosen((await res.json()).chosen); setMsg("saved"); } else { setChosen(before); setMsg("bad"); }
  };
  return (
    <div className="stack wg-students" style={{ gap: 8 }}>
      <h3 className="todo-head">{d.wgStudentsTitle}</h3>
      <p className="muted wg-small" style={{ margin: 0 }}>{d.wgStudentsHint}</p>
      {initial.allowed.length === 0 ? <p className="muted wg-small" style={{ margin: 0 }}>{d.wgStudentsNoneAllowed}</p> : (
        <>
          <KindList kinds={chosen ?? initial.schoolDefault} candidates={initial.allowed} onChange={(k) => put(k)} d={d} label={d.wgKindList} />
          {chosen ? <button type="button" className="btn btn-sm" onClick={() => put(null)}>{d.wgStudentsSchool}</button>
            : <p className="muted wg-small" style={{ margin: 0 }}>{d.wgStudentsFollowing}</p>}
        </>
      )}
      <p className="wg-small" role="status" style={{ margin: 0 }}>{msg === "saved" ? d.wgStudentsSaved : msg === "bad" ? d.wgSaveFailed : ""}</p>
    </div>
  );
}
