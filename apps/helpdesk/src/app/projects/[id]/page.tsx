import Link from "next/link";
import { prisma } from "@/lib/db";
import { isAgent, requireUser } from "@/lib/auth";
import {
  COLOR_SHAPE,
  PROJECT_STATUSES,
  canEdit,
  canManage,
  dateInput,
  dueLabel,
  loadProject,
  shortDate,
} from "@/lib/projects";
import { timeAgo } from "@/lib/labels";
import { StatusBadge } from "@/components/badges";
import { SiteHeader } from "@/components/site-header";
import { TaskBoard, type TaskDTO } from "@/components/projects/task-board";
import { PeoplePanel, type PersonDTO } from "@/components/projects/people-panel";
import { UpdateForm } from "@/components/projects/update-form";

export const dynamic = "force-dynamic";

const VIEWS = [
  { key: "board", label: "Board" },
  { key: "list", label: "List" },
  { key: "timeline", label: "Timeline" },
  { key: "people", label: "People" },
  { key: "updates", label: "Updates" },
] as const;
type View = (typeof VIEWS)[number]["key"];

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await prisma.project.findUnique({ where: { id }, select: { title: true } });
  return { title: p?.title ?? "Project" };
}

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ view?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const access = await loadProject(id, user);
  const view: View = (VIEWS.find((v) => v.key === sp.view)?.key ?? "board") as View;

  const project = await prisma.project.findUniqueOrThrow({
    where: { id },
    include: {
      owner: true,
      members: { include: { user: true }, orderBy: { addedAt: "asc" } },
      tasks: { include: { assignee: { select: { id: true, name: true } } }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      updates: { include: { author: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 100 },
      tickets: { select: { id: true, title: true, status: true, token: true }, orderBy: { id: "desc" } },
    },
  });

  const editable = canEdit(access, user);
  const manage = canManage(access, user);
  const st = PROJECT_STATUSES[project.status] ?? PROJECT_STATUSES.PLANNING;
  const tasks = project.tasks.filter((t) => t.kind === "TASK");
  const done = tasks.filter((t) => t.status === "DONE").length;
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  const due = dueLabel(project.dueDate, project.status === "DONE");

  const taskDTOs: TaskDTO[] = project.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    notes: t.notes,
    kind: t.kind,
    status: t.status,
    section: t.section,
    startDate: dateInput(t.startDate),
    dueDate: dateInput(t.dueDate),
    assigneeId: t.assigneeId ?? "",
    assigneeName: t.assignee?.name ?? "",
  }));
  const members = project.members.map((m) => ({ userId: m.userId, name: m.user.name }));
  if (!members.some((m) => m.userId === project.ownerId)) {
    members.unshift({ userId: project.ownerId, name: project.owner.name });
  }

  const people: PersonDTO[] = project.members.map((m) => ({
    memberId: m.id,
    userId: m.userId,
    name: m.user.name,
    email: m.user.email,
    picture: m.user.picture,
    roleLabel: m.user.roleLabel,
    projectRole: m.role,
    isOwner: m.userId === project.ownerId,
    isMe: m.userId === user.id,
    joined: !!m.user.signifyId,
  }));

  const nextUp = project.tasks
    .filter((t) => t.status !== "DONE" && t.dueDate)
    .sort((a, b) => a.dueDate!.getTime() - b.dueDate!.getTime())
    .slice(0, 3);

  return (
    <div className="min-h-screen">
      <SiteHeader />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Link href="/projects" className="text-sm font-medium text-slate-600 hover:text-slate-900">Projects</Link>

        <div className="mt-2 flex flex-wrap items-start gap-4">
          <span
            aria-hidden
            className={`shape shape-${COLOR_SHAPE[project.color] || "square"} mt-2`}
            style={{ color: `var(--${project.color})`, width: 22, height: 22 }}
          />
          <div className="min-w-0 flex-1">
            <h1 className="text-3xl font-extrabold leading-tight tracking-tight sm:text-4xl" style={{ fontStretch: "112%" }}>
              {project.title}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600">
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${st.badge}`}>{st.label}</span>
              {project.archived && <span className="rounded-full bg-slate-200 px-2.5 py-0.5 text-xs font-semibold text-slate-600">Archived</span>}
              {(project.startDate || project.dueDate) && (
                <span>
                  {project.startDate ? shortDate(project.startDate) : "…"} – {project.dueDate ? shortDate(project.dueDate) : "…"}
                  {due && project.status !== "DONE" && project.dueDate && due.text !== shortDate(project.dueDate) && (
                    <span className={`ml-2 ${due.tone}`}>({due.text})</span>
                  )}
                </span>
              )}
              <span>{project.visibility === "SCHOOL" ? "Everyone at school can look" : "Only the people on it"}</span>
            </div>
          </div>
          {manage && <Link href={`/projects/${id}/edit`} className="btn-secondary">Edit project</Link>}
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-[2fr_1fr]">
          <div className="card p-5">
            {project.description ? (
              <p className="whitespace-pre-wrap text-slate-700">{project.description}</p>
            ) : (
              <p className="text-slate-400">No description.</p>
            )}
            <div className="mt-5">
              <div className="mb-1.5 flex justify-between text-sm">
                <span className="font-semibold">{tasks.length ? `${done} of ${tasks.length} tasks done` : "No tasks yet"}</span>
                <span className="font-mono text-slate-500">{pct}%</span>
              </div>
              <div className="h-2.5 overflow-hidden rounded-full bg-slate-100">
                <div className="h-full rounded-full transition-[width]" style={{ width: `${pct}%`, background: `var(--${project.color})` }} />
              </div>
            </div>
          </div>
          <div className="card p-5">
            <h2 className="eyebrow mb-3">Coming up</h2>
            {nextUp.length === 0 ? (
              <p className="text-sm text-slate-400">Nothing with a date.</p>
            ) : (
              <ul className="space-y-2">
                {nextUp.map((t) => {
                  const d = dueLabel(t.dueDate);
                  return (
                    <li key={t.id} className="flex items-baseline gap-2 text-sm">
                      {t.kind === "MILESTONE" && <span aria-hidden className="shape shape-triangle text-p3" />}
                      <span className="min-w-0 flex-1 truncate">{t.title}</span>
                      <span className={`whitespace-nowrap text-xs ${d?.tone}`}>{d?.text}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        <nav className="mt-8 mb-5 flex gap-2 overflow-x-auto" aria-label="Project views">
          {VIEWS.map((v) => (
            <Link
              key={v.key}
              href={`/projects/${id}${v.key === "board" ? "" : `?view=${v.key}`}`}
              aria-current={view === v.key ? "true" : undefined}
              className="chip"
              scroll={false}
            >
              {v.label}
              {v.key === "people" && <span className="font-mono text-xs opacity-70">{project.members.length}</span>}
            </Link>
          ))}
        </nav>

        {!editable && (view === "board" || view === "list") && (
          <p className="mb-4 text-sm text-slate-500">You can look at this project. Ask a lead to add you if you want to help.</p>
        )}

        {(view === "board" || view === "list") && (
          <TaskBoard projectId={id} tasks={taskDTOs} members={members} editable={editable} view={view} />
        )}

        {view === "timeline" && <Timeline project={project} />}

        {view === "people" && <PeoplePanel projectId={id} people={people} manage={manage} />}

        {view === "updates" && (
          <div className="max-w-2xl space-y-4">
            {editable && <UpdateForm projectId={id} />}
            <ul className="space-y-3">
              {project.updates.map((u) =>
                u.system ? (
                  <li key={u.id} className="flex gap-2 px-1 text-sm text-slate-500">
                    <span className="flex-1">{u.body}</span>
                    <span className="whitespace-nowrap text-xs">{timeAgo(u.createdAt)}</span>
                  </li>
                ) : (
                  <li key={u.id} className="card p-4">
                    <p className="mb-1 flex text-sm">
                      <span className="font-semibold">{u.author?.name ?? "Someone"}</span>
                      <span className="ml-auto text-xs text-slate-500">{timeAgo(u.createdAt)}</span>
                    </p>
                    <p className="whitespace-pre-wrap text-slate-700">{u.body}</p>
                  </li>
                )
              )}
            </ul>
          </div>
        )}

        {project.tickets.length > 0 && (
          <section className="mt-10">
            <h2 className="eyebrow mb-3">Help desk tickets for this project</h2>
            <ul className="card divide-y divide-slate-100">
              {project.tickets.map((t) => (
                <li key={t.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <Link href={isAgent(user) ? `/dashboard/tickets/${t.id}` : `/t/${t.token}`} className="min-w-0 flex-1 truncate font-medium text-slate-900 hover:underline">
                    <span className="mr-1.5 text-slate-400">#{t.id}</span>{t.title}
                  </Link>
                  <StatusBadge status={t.status} />
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </div>
  );
}

/* ---------- Timeline ----------
   A plain Gantt: the project's span across the top, a bar per task from its
   start to its due date (or a dot on the due date when it has no start), and
   a triangle for each milestone. Today is a red line. Server-rendered — it is
   for reading the plan at a glance, and the board is where things move. */

type TimelineProject = {
  startDate: Date | null;
  dueDate: Date | null;
  color: string;
  tasks: { id: string; title: string; kind: string; status: string; section: string; startDate: Date | null; dueDate: Date | null; assignee: { name: string } | null }[];
};

function Timeline({ project }: { project: TimelineProject }) {
  const dated = project.tasks.filter((t) => t.dueDate || t.startDate);
  const undated = project.tasks.length - dated.length;
  if (dated.length === 0) {
    return (
      <div className="card px-6 py-12 text-center text-slate-500">
        Give tasks a start or due date and they will appear here.
      </div>
    );
  }

  const DAY = 864e5;
  const times = dated.flatMap((t) => [t.startDate, t.dueDate]).filter(Boolean).map((d) => d!.getTime());
  if (project.startDate) times.push(project.startDate.getTime());
  if (project.dueDate) times.push(project.dueDate.getTime());
  const today = Date.now();
  const from = Math.min(...times, today) - 2 * DAY;
  let to = Math.max(...times, today) + 2 * DAY;
  if (to - from < 21 * DAY) to = from + 21 * DAY;
  const span = to - from;
  const pos = (t: number) => `${((t - from) / span) * 100}%`;

  const ticks: { at: number; label: string }[] = [];
  const weekly = span < 75 * DAY;
  const cursor = new Date(from);
  cursor.setUTCHours(12, 0, 0, 0);
  if (weekly) {
    while (cursor.getUTCDay() !== 1) cursor.setUTCDate(cursor.getUTCDate() + 1);
    while (cursor.getTime() < to) {
      ticks.push({ at: cursor.getTime(), label: cursor.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) });
      cursor.setUTCDate(cursor.getUTCDate() + 7);
    }
  } else {
    cursor.setUTCDate(1);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    while (cursor.getTime() < to) {
      ticks.push({ at: cursor.getTime(), label: cursor.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }) });
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }

  const rows = [...dated].sort(
    (a, b) => (a.startDate ?? a.dueDate)!.getTime() - (b.startDate ?? b.dueDate)!.getTime()
  );

  return (
    <div className="card overflow-x-auto p-4">
      <div className="min-w-[640px]">
        <div className="relative ml-[34%] h-6 border-b border-slate-200">
          {ticks.map((tk) => (
            <span key={tk.at} className="absolute -translate-x-1/2 text-[11px] font-semibold text-slate-500" style={{ left: pos(tk.at) }}>
              {tk.label}
            </span>
          ))}
        </div>
        <div className="relative">
          <div aria-hidden className="pointer-events-none absolute inset-y-0 left-[34%] right-0">
            {ticks.map((tk) => (
              <span key={tk.at} className="absolute inset-y-0 w-px bg-slate-100" style={{ left: pos(tk.at) }} />
            ))}
            <span className="absolute inset-y-0 w-0.5 bg-[var(--p1)]" style={{ left: pos(today) }} title="Today" />
          </div>
          <ul>
            {rows.map((t) => {
              const s = (t.startDate ?? t.dueDate)!.getTime();
              const e = (t.dueDate ?? t.startDate)!.getTime();
              const done = t.status === "DONE";
              const late = !done && t.dueDate && t.dueDate.getTime() < today - DAY;
              return (
                <li key={t.id} className="flex items-center border-b border-slate-100 py-1.5 last:border-0">
                  <div className="w-[34%] min-w-0 pr-3">
                    <p className={`truncate text-sm font-medium ${done ? "text-slate-400 line-through" : ""}`}>{t.title}</p>
                    <p className="truncate text-[11px] text-slate-500">
                      {[t.section, t.assignee?.name].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  <div className="relative h-6 flex-1">
                    {t.kind === "MILESTONE" ? (
                      <span
                        className="shape shape-triangle absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
                        style={{ left: pos(e), width: 16, height: 14, color: "var(--p3)" }}
                        title={`Milestone: ${t.title}`}
                      />
                    ) : (
                      <span
                        className="absolute top-1/2 h-3.5 -translate-y-1/2 rounded-full"
                        style={{
                          left: pos(s),
                          width: `max(14px, calc(${pos(e + DAY)} - ${pos(s)}))`,
                          background: late ? "var(--p1)" : `var(--${project.color})`,
                          opacity: done ? 0.35 : 1,
                        }}
                        title={`${t.title}${t.startDate ? ` · ${t.startDate.toISOString().slice(0, 10)}` : ""}${t.dueDate ? ` → ${t.dueDate.toISOString().slice(0, 10)}` : ""}`}
                      />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
      <p className="mt-3 text-xs text-slate-500">
        <span className="mr-1 inline-block h-2.5 w-0.5 bg-[var(--p1)] align-middle" /> Today
        {undated > 0 && <> · {undated} task{undated === 1 ? "" : "s"} without dates not shown</>}
      </p>
    </div>
  );
}
