import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { COLOR_SHAPE, PROJECT_STATUSES, dueLabel, memberRole, projectsFor, shortDate } from "@/lib/projects";
import { SiteHeader } from "@/components/site-header";

export const dynamic = "force-dynamic";
export const metadata = { title: "Projects" };

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string; msg?: string }>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const all = await projectsFor(user);

  const showArchived = sp.show === "archived";
  const visible = all.filter((p) => p.archived === showArchived);
  const mine = visible.filter((p) => memberRole(p, user));
  const others = visible.filter((p) => !memberRole(p, user));
  const archivedCount = all.filter((p) => p.archived).length;

  return (
    <div className="min-h-screen">
      <SiteHeader />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight">Projects</h1>
            <p className="mt-1 text-slate-600">Plan an event, a trip, a rollout — anything you do with other people.</p>
          </div>
          <Link href="/projects/new" className="btn-primary">
            <span aria-hidden className="text-lg leading-none">+</span> New project
          </Link>
        </div>

        {sp.msg && (
          <p className="mb-4 rounded-[var(--radius-md)] bg-green-50 px-4 py-3 text-sm text-green-800">{sp.msg}</p>
        )}

        <div className="mb-6 flex gap-2">
          <Link href="/projects" className={`chip ${!showArchived ? "is-on" : ""}`}>Current</Link>
          <Link href="/projects?show=archived" className={`chip ${showArchived ? "is-on" : ""}`}>
            Archived{archivedCount ? ` · ${archivedCount}` : ""}
          </Link>
        </div>

        {visible.length === 0 ? (
          <div className="card px-6 py-14 text-center">
            <p className="font-display text-xl font-bold">
              {showArchived ? "Nothing archived." : "No projects yet."}
            </p>
            {!showArchived && (
              <p className="mt-2 text-slate-600">
                Start one, add the people helping, and break the work into tasks with dates.
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-10">
            <ProjectGrid title={user.role === "ADMIN" && others.length ? "Yours" : null} projects={mine} />
            {others.length > 0 && (
              <ProjectGrid
                title={user.role === "ADMIN" ? "Everyone else's (you can see these as a help desk admin)" : "Open to everyone at school"}
                projects={others}
              />
            )}
          </div>
        )}
      </main>
    </div>
  );
}

type ListProject = Awaited<ReturnType<typeof projectsFor>>[number];

function ProjectGrid({ title, projects }: { title: string | null; projects: ListProject[] }) {
  if (!projects.length) return null;
  return (
    <section>
      {title && <h2 className="eyebrow mb-3">{title}</h2>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {projects.map((p) => {
          const tasks = p.tasks.filter((t) => t.kind === "TASK");
          const done = tasks.filter((t) => t.status === "DONE").length;
          const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
          const due = dueLabel(p.dueDate, p.status === "DONE");
          const late = p.tasks.filter((t) => t.status !== "DONE" && t.dueDate && t.dueDate.getTime() < Date.now() - 864e5).length;
          const st = PROJECT_STATUSES[p.status] ?? PROJECT_STATUSES.PLANNING;
          return (
            <Link
              key={p.id}
              href={`/projects/${p.id}`}
              className="card group flex flex-col overflow-hidden no-underline transition hover:shadow-[var(--shadow-4)]"
            >
              <div className="flex items-center gap-2 px-5 pt-4" style={{ color: `var(--${p.color})` }}>
                <span aria-hidden className={`shape shape-${COLOR_SHAPE[p.color] || "square"}`} style={{ width: 14, height: 14 }} />
                <span className={`ml-auto rounded-full px-2.5 py-0.5 text-xs font-semibold ${st.badge}`}>{st.label}</span>
              </div>
              <div className="flex flex-1 flex-col px-5 pb-5 pt-3">
                <p className="font-display text-xl font-bold leading-tight text-slate-900">{p.title}</p>
                {p.description && <p className="mt-1 line-clamp-2 text-sm text-slate-600">{p.description}</p>}
                <div className="mt-auto pt-5">
                  <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
                    <span>
                      {tasks.length ? `${done} of ${tasks.length} done` : "No tasks yet"}
                      {late > 0 && <span className="ml-2 font-semibold text-red-700">{late} late</span>}
                    </span>
                    {due && <span className={due.tone}>{p.dueDate ? `Due ${shortDate(p.dueDate)}` : ""}</span>}
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full rounded-full" style={{ width: `${pct}%`, background: `var(--${p.color})` }} />
                  </div>
                  <p className="mt-3 text-xs text-slate-500">
                    {p.owner.name} · {p.members.length} {p.members.length === 1 ? "person" : "people"}
                  </p>
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
