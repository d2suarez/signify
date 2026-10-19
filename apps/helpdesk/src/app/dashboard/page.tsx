import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireAgent } from "@/lib/auth";
import { CATEGORIES, PRIORITIES, ROLES, timeAgo } from "@/lib/labels";
import { STALE_DAYS, staleCutoff } from "@/lib/digest";
import { CategoryLabel, PriorityBadge, StatusBadge } from "@/components/badges";
import { AutoSelect } from "@/components/auto-select";

export const dynamic = "force-dynamic";

const ACTIVE_STATUSES = ["OPEN", "IN_PROGRESS", "WAITING"];

type Search = { view?: string; cat?: string; assignee?: string; q?: string };

function query(params: Search): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) qs.set(key, value);
  const s = qs.toString();
  return s ? `?${s}` : "";
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  // Checked here as well as in the layout: a layout does not run on every
  // request that renders this page.
  const user = await requireAgent();
  const sp = await searchParams;
  const view = sp.view || "active";

  const cutoff = staleCutoff();
  const viewWhere: Record<string, Prisma.TicketWhereInput> = {
    active: { status: { in: ACTIVE_STATUSES } },
    unassigned: { status: { in: ACTIVE_STATUSES }, assignedToId: null },
    mine: { status: { in: ACTIVE_STATUSES }, assignedToId: user.id },
    stale: { status: { in: ACTIVE_STATUSES }, updatedAt: { lt: cutoff } },
    resolved: { status: "RESOLVED" },
    closed: { status: "CLOSED" },
    all: {},
  };

  const where: Prisma.TicketWhereInput = { ...(viewWhere[view] ?? viewWhere.active) };
  if (sp.cat && CATEGORIES[sp.cat]) where.category = sp.cat;
  if (sp.assignee) where.assignedToId = sp.assignee === "none" ? null : sp.assignee;
  if (sp.q) {
    where.OR = [
      { title: { contains: sp.q } },
      { description: { contains: sp.q } },
      { requesterName: { contains: sp.q } },
    ];
  }

  const [tickets, staff, activeCount, unassignedCount, mineCount, staleCount, resolvedCount, closedCount] =
    await Promise.all([
      prisma.ticket.findMany({
        where,
        include: { assignedTo: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
      prisma.user.findMany({
        where: { active: true, role: { in: ["ADMIN", "TECH"] } },
        orderBy: { name: "asc" },
      }),
      prisma.ticket.count({ where: viewWhere.active }),
      prisma.ticket.count({ where: viewWhere.unassigned }),
      prisma.ticket.count({ where: viewWhere.mine }),
      prisma.ticket.count({ where: viewWhere.stale }),
      prisma.ticket.count({ where: viewWhere.resolved }),
      prisma.ticket.count({ where: viewWhere.closed }),
    ]);

  tickets.sort((a, b) => {
    const rank =
      (PRIORITIES[b.priority]?.rank ?? 0) - (PRIORITIES[a.priority]?.rank ?? 0);
    return rank !== 0 ? rank : b.createdAt.getTime() - a.createdAt.getTime();
  });

  const tabs = [
    { key: "active", label: "Active", count: activeCount },
    { key: "unassigned", label: "Unassigned", count: unassignedCount },
    { key: "mine", label: "Mine", count: mineCount },
    { key: "stale", label: `Stale ${STALE_DAYS}d+`, count: staleCount },
    { key: "resolved", label: "Resolved", count: resolvedCount },
    { key: "closed", label: "Closed", count: closedCount },
    { key: "all", label: "All", count: null },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Tickets</h1>
        <div className="flex flex-wrap items-center gap-4 text-sm font-medium">
          <a href="/api/export/tickets" className="text-blue-700 hover:underline">Export CSV</a>
          <Link href="/dashboard/snippets" className="text-blue-700 hover:underline">Saved replies</Link>
          <Link href="/dashboard/recurring" className="text-blue-700 hover:underline">Recurring</Link>
          <Link href="/" className="text-blue-700 hover:underline">New request →</Link>
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto pb-1">
        {tabs.map((tab) => (
          <Link
            key={tab.key}
            href={`/dashboard${query({ ...sp, view: tab.key })}`}
            className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition ${
              view === tab.key
                ? "bg-blue-600 text-white"
                : "bg-surface text-slate-600 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
            }`}
          >
            {tab.label}
            {tab.count !== null && (
              <span className={view === tab.key ? "ml-1.5 opacity-80" : "ml-1.5 text-slate-400"}>
                {tab.count}
              </span>
            )}
          </Link>
        ))}
      </div>

      <form method="GET" className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="view" value={view} />
        <input
          type="search"
          name="q"
          defaultValue={sp.q ?? ""}
          placeholder="Search title, details, or name…"
          className="input w-full sm:w-64"
        />
        <AutoSelect name="cat" defaultValue={sp.cat ?? ""} className="input w-auto">
          <option value="">All categories</option>
          {Object.entries(CATEGORIES).map(([value, c]) => (
            <option key={value} value={value}>{c.label}</option>
          ))}
        </AutoSelect>
        <AutoSelect name="assignee" defaultValue={sp.assignee ?? ""} className="input w-auto">
          <option value="">Any assignee</option>
          <option value="none">Unassigned</option>
          {staff.map((member) => (
            <option key={member.id} value={member.id}>{member.name}</option>
          ))}
        </AutoSelect>
        <button type="submit" className="btn-secondary">Search</button>
      </form>

      {tickets.length === 0 ? (
        <div className="card px-6 py-12 text-center text-sm text-slate-500">
          No tickets here.
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="card hidden overflow-x-auto md:block">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-4 py-3">#</th>
                  <th className="px-4 py-3">Request</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3">Priority</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Assigned</th>
                  <th className="px-4 py-3">Age</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {tickets.map((ticket) => (
                  <tr key={ticket.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-medium text-slate-400">{ticket.id}</td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/dashboard/tickets/${ticket.id}`}
                        className="font-semibold text-slate-900 hover:text-blue-700"
                      >
                        {ticket.title}
                      </Link>
                      <p className="text-xs text-slate-500">
                        {ticket.requesterName} · {ROLES[ticket.requesterRole] ?? ticket.requesterRole}
                        {ticket.location ? ` · ${ticket.location}` : ""}
                      </p>
                    </td>
                    <td className="px-4 py-3"><CategoryLabel category={ticket.category} className="text-xs text-slate-600" /></td>
                    <td className="px-4 py-3"><PriorityBadge priority={ticket.priority} /></td>
                    <td className="px-4 py-3"><StatusBadge status={ticket.status} /></td>
                    <td className="px-4 py-3 text-slate-600">{ticket.assignedTo?.name ?? "—"}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-slate-500">
                      {timeAgo(ticket.createdAt)}
                      {ACTIVE_STATUSES.includes(ticket.status) && ticket.updatedAt < cutoff && (
                        <span
                          className="ml-1.5 rounded bg-red-50 px-1.5 py-0.5 text-[11px] font-medium text-red-600"
                          title={`No activity in ${STALE_DAYS}+ days`}
                        >
                          stale
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <ul className="space-y-3 md:hidden">
            {tickets.map((ticket) => (
              <li key={ticket.id}>
                <Link href={`/dashboard/tickets/${ticket.id}`} className="card block p-4">
                  <div className="flex items-start justify-between gap-3">
                    <p className="font-semibold">
                      <span className="mr-1.5 text-slate-400">#{ticket.id}</span>
                      {ticket.title}
                    </p>
                    <span className="whitespace-nowrap text-xs text-slate-400">
                      {timeAgo(ticket.createdAt)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {ticket.requesterName}
                    {ticket.location ? ` · ${ticket.location}` : ""}
                    {ticket.assignedTo ? ` · → ${ticket.assignedTo.name}` : " · unassigned"}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <StatusBadge status={ticket.status} />
                    <PriorityBadge priority={ticket.priority} />
                    <CategoryLabel category={ticket.category} className="text-xs text-slate-500" />
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          {tickets.length === 200 && (
            <p className="text-center text-xs text-slate-400">
              Showing the 200 most recent tickets — narrow your search to see older ones.
            </p>
          )}
        </>
      )}
    </div>
  );
}
