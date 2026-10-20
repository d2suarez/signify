import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireAgent } from "@/lib/auth";
import { deleteRecurringTask, saveRecurringTask, setRecurringActive } from "@/lib/actions";
import { getAllCategories } from "@/lib/categories";
import { CategoryLabel } from "@/components/badges";
import { SubmitButton } from "@/components/submit-button";

export const dynamic = "force-dynamic";
export const metadata = { title: "Recurring tasks" };

export default async function RecurringPage({
  searchParams,
}: {
  searchParams: Promise<{ msg?: string; err?: string }>;
}) {
  await requireAgent();
  const sp = await searchParams;
  const [tasks, agents] = await Promise.all([
    prisma.recurringTask.findMany({ orderBy: { nextRunAt: "asc" } }),
    prisma.user.findMany({
      where: { active: true, role: { in: ["ADMIN", "TECH"] } },
      orderBy: { name: "asc" },
    }),
  ]);
  const categories = (await getAllCategories()).filter((c) => c.active);
  const agentName = (id: string | null) => agents.find((a) => a.id === id)?.name;

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Recurring tasks</h1>
        <Link href="/dashboard" className="text-sm font-medium text-blue-700 hover:underline">
          ← Tickets
        </Link>
      </div>

      {sp.msg && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          {sp.msg}
        </div>
      )}
      {sp.err && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {sp.err}
        </div>
      )}

      <p className="text-sm text-slate-500">
        Maintenance that happens on a schedule — filter changes, safety checks, cart audits. A
        ticket is created automatically each time one comes due.
      </p>

      {tasks.length > 0 && (
        <ul className="space-y-3">
          {tasks.map((task) => (
            <li key={task.id} className={`card p-4 ${task.active ? "" : "opacity-60"}`}>
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-semibold">{task.title}</p>
                {!task.active && (
                  <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                    Paused
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-slate-500">
                <CategoryLabel category={task.category} /> · every {task.everyDays}{" "}
                {task.everyDays === 1 ? "day" : "days"} · next{" "}
                {task.nextRunAt.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                {task.assignedToId && ` · assigned to ${agentName(task.assignedToId) ?? "?"}`}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-4 border-t border-slate-100 pt-3 text-sm">
                <form action={setRecurringActive.bind(null, task.id, !task.active)}>
                  <SubmitButton className="cursor-pointer font-medium text-slate-600 hover:underline" pendingText="…">
                    {task.active ? "Pause" : "Resume"}
                  </SubmitButton>
                </form>
                <form action={deleteRecurringTask.bind(null, task.id)}>
                  <SubmitButton className="cursor-pointer font-medium text-red-600 hover:underline" pendingText="…">
                    Delete
                  </SubmitButton>
                </form>
              </div>
            </li>
          ))}
        </ul>
      )}

      <section className="card p-5">
        <h2 className="mb-4 text-base font-semibold">New recurring task</h2>
        <form action={saveRecurringTask} className="space-y-4">
          <div>
            <label className="label" htmlFor="r-title">Title</label>
            <input id="r-title" name="title" required className="input" placeholder='e.g. "Replace HVAC filters — main building"' />
          </div>
          <div>
            <label className="label" htmlFor="r-description">
              Details <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <textarea id="r-description" name="description" rows={2} className="input" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label className="label" htmlFor="r-category">Category</label>
              <select id="r-category" name="category" defaultValue="MAINTENANCE" className="input">
                {categories.map((c) => (
                  <option key={c.key} value={c.key}>{c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="r-every">Repeat every (days)</label>
              <input id="r-every" name="everyDays" type="number" min={1} max={365} required defaultValue={30} className="input" />
            </div>
            <div>
              <label className="label" htmlFor="r-first">First run</label>
              <input id="r-first" name="firstRun" type="date" className="input" />
            </div>
            <div>
              <label className="label" htmlFor="r-assign">Assign to</label>
              <select id="r-assign" name="assignedToId" defaultValue="" className="input">
                <option value="">Unassigned</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>{agent.name}</option>
                ))}
              </select>
            </div>
          </div>
          <SubmitButton pendingText="Scheduling…">Add recurring task</SubmitButton>
        </form>
      </section>
    </div>
  );
}
