"use client";

import { useActionState, useEffect, useOptimistic, useRef, useState, startTransition } from "react";
import { addTask, deleteTask, moveTask, updateTask } from "@/lib/project-actions";
import type { FormState } from "@/lib/actions";
import { dueLabel } from "@/lib/project-dates";
import { SubmitButton } from "../submit-button";

export type TaskDTO = {
  id: string;
  title: string;
  notes: string;
  kind: string;
  status: string;
  section: string;
  startDate: string;
  dueDate: string;
  assigneeId: string;
  assigneeName: string;
};
export type MemberDTO = { userId: string; name: string };

const COLUMNS = [
  { key: "TODO", label: "To do", shape: "circle", tone: "text-p1" },
  { key: "DOING", label: "Doing", shape: "triangle", tone: "text-p3" },
  { key: "DONE", label: "Done", shape: "square", tone: "text-p4" },
];

const toDate = (s: string) => (s ? new Date(`${s}T12:00:00Z`) : null);

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
}

/**
 * The board: three columns, cards you can drag between them. Dragging is a
 * convenience — every card also opens into a form with a "Where it's at"
 * menu, so the board works by keyboard and on a phone.
 */
export function TaskBoard({
  projectId,
  tasks,
  members,
  editable,
  view,
}: {
  projectId: string;
  tasks: TaskDTO[];
  members: MemberDTO[];
  editable: boolean;
  view: "board" | "list";
}) {
  const [shown, setShown] = useOptimistic(tasks, (state, move: { id: string; status: string }) =>
    state.map((t) => (t.id === move.id ? { ...t, status: move.status } : t))
  );
  const [open, setOpen] = useState<TaskDTO | "new" | null>(null);
  const [newStatus, setNewStatus] = useState("TODO");
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const move = (id: string, status: string) => {
    startTransition(async () => {
      setShown({ id, status });
      await moveTask(projectId, id, status);
    });
  };

  const sections = Array.from(new Set(tasks.map((t) => t.section).filter(Boolean))).sort();

  return (
    <>
      {view === "board" ? (
        <div className="grid gap-4 md:grid-cols-3">
          {COLUMNS.map((col) => {
            const items = shown.filter((t) => t.status === col.key);
            return (
              <section
                key={col.key}
                aria-label={col.label}
                className={`inset flex min-h-40 flex-col gap-2 p-3 transition ${over === col.key ? "ring-2 ring-[var(--p2)]" : ""}`}
                onDragOver={(e) => {
                  if (!editable || !dragging) return;
                  e.preventDefault();
                  setOver(col.key);
                }}
                onDragLeave={() => setOver((o) => (o === col.key ? null : o))}
                onDrop={(e) => {
                  e.preventDefault();
                  setOver(null);
                  if (dragging) move(dragging, col.key);
                  setDragging(null);
                }}
              >
                <h3 className="eyebrow flex items-center gap-2 px-1 pb-1">
                  <span aria-hidden className={`shape shape-${col.shape} ${col.tone}`} />
                  {col.label}
                  <span className="ml-auto font-mono text-xs font-medium normal-case tracking-normal text-slate-500">{items.length}</span>
                </h3>
                {items.map((t) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    editable={editable}
                    onOpen={() => setOpen(t)}
                    onDragStart={() => setDragging(t.id)}
                    onDragEnd={() => { setDragging(null); setOver(null); }}
                  />
                ))}
                {editable && (
                  <button
                    type="button"
                    onClick={() => { setNewStatus(col.key); setOpen("new"); }}
                    className="btn-ghost mt-1 w-full justify-start"
                  >
                    <span aria-hidden className="text-base leading-none">+</span> Add a task
                  </button>
                )}
              </section>
            );
          })}
        </div>
      ) : (
        <TaskList tasks={shown} sections={sections} editable={editable} onOpen={setOpen} onToggle={(t) => move(t.id, t.status === "DONE" ? "TODO" : "DONE")} onAdd={() => { setNewStatus("TODO"); setOpen("new"); }} />
      )}

      {open && (
        <TaskDialog
          key={open === "new" ? `new-${newStatus}` : open.id}
          projectId={projectId}
          task={open === "new" ? null : open}
          status={open === "new" ? newStatus : open.status}
          members={members}
          sections={sections}
          editable={editable}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

function TaskCard({
  task,
  editable,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  task: TaskDTO;
  editable: boolean;
  onOpen: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const due = dueLabel(toDate(task.dueDate), task.status === "DONE");
  const milestone = task.kind === "MILESTONE";
  return (
    <button
      type="button"
      draggable={editable}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; onDragStart(); }}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      className={`w-full cursor-pointer rounded-[var(--radius-md)] bg-surface p-3 text-left shadow-[var(--shadow-2)] transition hover:brightness-[.97] ${
        task.status === "DONE" ? "opacity-70" : ""
      }`}
    >
      {(task.section || milestone) && (
        <p className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[.08em] text-slate-500">
          {milestone && <span aria-hidden className="shape shape-triangle text-p3" />}
          {milestone ? "Milestone" : task.section}
          {milestone && task.section ? ` · ${task.section}` : ""}
        </p>
      )}
      <p className={`text-sm font-semibold leading-snug text-slate-900 ${task.status === "DONE" ? "line-through decoration-1" : ""}`}>
        {task.title}
      </p>
      {(due || task.assigneeName || task.notes) && (
        <div className="mt-2 flex items-center gap-2 text-xs">
          {due && <span className={due.tone}>{due.text}</span>}
          {task.notes && <span className="text-slate-400" title="Has notes">· notes</span>}
          {task.assigneeName && (
            <span
              title={task.assigneeName}
              className="ml-auto grid h-6 min-w-6 place-items-center rounded-full bg-blue-100 px-1 text-[10px] font-bold text-blue-800"
            >
              {initials(task.assigneeName)}
            </span>
          )}
        </div>
      )}
    </button>
  );
}

function TaskList({
  tasks,
  sections,
  editable,
  onOpen,
  onToggle,
  onAdd,
}: {
  tasks: TaskDTO[];
  sections: string[];
  editable: boolean;
  onOpen: (t: TaskDTO) => void;
  onToggle: (t: TaskDTO) => void;
  onAdd: () => void;
}) {
  const groups = [...sections.map((s) => ({ name: s, items: tasks.filter((t) => t.section === s) })), { name: "", items: tasks.filter((t) => !t.section) }]
    .filter((g) => g.items.length);
  const byDate = (a: TaskDTO, b: TaskDTO) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999");
  return (
    <div className="space-y-6">
      {groups.map((g) => (
        <section key={g.name || "_"}>
          {(g.name || sections.length > 0) && <h3 className="eyebrow mb-2">{g.name || "Everything else"}</h3>}
          <ul className="card divide-y divide-slate-100">
            {[...g.items].sort(byDate).map((t) => {
              const due = dueLabel(toDate(t.dueDate), t.status === "DONE");
              return (
                <li key={t.id} className="flex items-center gap-3 px-4 py-2.5">
                  <input
                    type="checkbox"
                    checked={t.status === "DONE"}
                    disabled={!editable}
                    onChange={() => onToggle(t)}
                    aria-label={`Mark ${t.title} ${t.status === "DONE" ? "not done" : "done"}`}
                    className="h-4 w-4 flex-none accent-[var(--p4)]"
                  />
                  <button type="button" onClick={() => onOpen(t)} className="min-w-0 flex-1 cursor-pointer text-left">
                    <span className={`block truncate text-sm font-medium ${t.status === "DONE" ? "text-slate-400 line-through" : "text-slate-900"}`}>
                      {t.kind === "MILESTONE" && <span aria-hidden className="shape shape-triangle text-p3 mr-1.5" />}
                      {t.title}
                    </span>
                  </button>
                  {t.status === "DOING" && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">Doing</span>}
                  {t.assigneeName && <span className="hidden text-xs text-slate-500 sm:inline">{t.assigneeName}</span>}
                  <span className={`w-20 text-right text-xs ${due?.tone ?? ""}`}>{due?.text ?? ""}</span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {tasks.length === 0 && <p className="card px-6 py-10 text-center text-slate-500">No tasks yet.</p>}
      {editable && (
        <button type="button" onClick={onAdd} className="btn-primary">
          <span aria-hidden className="text-lg leading-none">+</span> Add a task
        </button>
      )}
    </div>
  );
}

function TaskDialog({
  projectId,
  task,
  status,
  members,
  sections,
  editable,
  onClose,
}: {
  projectId: string;
  task: TaskDTO | null;
  status: string;
  members: MemberDTO[];
  sections: string[];
  editable: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const action = task ? updateTask.bind(null, projectId, task.id) : addTask.bind(null, projectId);
  const [state, formAction] = useActionState<FormState, FormData>(action, {});

  useEffect(() => {
    ref.current?.showModal();
    if (!task) ref.current?.querySelector<HTMLInputElement>("#t-title")?.focus();
  }, [task]);
  useEffect(() => {
    if (state.message) onClose();
  }, [state, onClose]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) ref.current?.close(); }}
      className="m-auto w-[min(568px,calc(100%-32px))] rounded-[var(--radius-xl)] bg-surface p-0 text-slate-900 shadow-[var(--shadow-4)] backdrop:bg-[rgba(32,30,29,.45)]"
    >
      <form action={formAction} className="max-h-[85vh] space-y-4 overflow-y-auto p-6">
        <div className="flex items-start gap-3">
          <h2 className="flex-1 text-xl font-bold">{task ? (editable ? "Task" : task.title) : "New task"}</h2>
          <button type="button" onClick={() => ref.current?.close()} className="btn-ghost -mr-2 -mt-1" aria-label="Close">
            Close
          </button>
        </div>
        {state.error && <p className="rounded-[var(--radius-md)] bg-red-50 px-4 py-3 text-sm text-red-800">{state.error}</p>}

        <fieldset disabled={!editable} className="space-y-4">
          <div>
            <label className="label" htmlFor="t-title">What needs doing</label>
            <input id="t-title" name="title" required maxLength={200} defaultValue={task?.title} className="input" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="t-status">Where it&apos;s at</label>
              <select id="t-status" name="status" defaultValue={status} className="input">
                {COLUMNS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="t-assignee">Who&apos;s doing it</label>
              <select id="t-assignee" name="assigneeId" defaultValue={task?.assigneeId ?? ""} className="input">
                <option value="">Nobody yet</option>
                {members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="t-start">Start</label>
              <input id="t-start" name="startDate" type="date" defaultValue={task?.startDate} className="input" />
            </div>
            <div>
              <label className="label" htmlFor="t-due">Due</label>
              <input id="t-due" name="dueDate" type="date" defaultValue={task?.dueDate} className="input" />
            </div>
            <div>
              <label className="label" htmlFor="t-section">Group</label>
              <input id="t-section" name="section" list="t-sections" maxLength={60} defaultValue={task?.section} className="input" placeholder="e.g. Food, Venue" />
              <datalist id="t-sections">{sections.map((s) => <option key={s} value={s} />)}</datalist>
            </div>
            <label className="flex items-center gap-2 self-end pb-2.5 text-sm font-medium">
              <input type="checkbox" name="kind" value="MILESTONE" defaultChecked={task?.kind === "MILESTONE"} className="h-4 w-4 accent-[var(--p3)]" />
              It&apos;s a milestone
            </label>
          </div>
          <div>
            <label className="label" htmlFor="t-notes">Notes</label>
            <textarea id="t-notes" name="notes" rows={4} defaultValue={task?.notes} className="input" />
          </div>
        </fieldset>

        {editable && (
          <div className="flex items-center gap-3 pt-2">
            <SubmitButton>{task ? "Save" : "Add task"}</SubmitButton>
            {task && (
              <button
                type="button"
                className="btn-ghost ml-auto text-red-700"
                onClick={() => {
                  if (!confirm(`Delete “${task.title}”?`)) return;
                  startTransition(async () => {
                    await deleteTask(projectId, task.id);
                    onClose();
                  });
                }}
              >
                Delete
              </button>
            )}
          </div>
        )}
      </form>
    </dialog>
  );
}
