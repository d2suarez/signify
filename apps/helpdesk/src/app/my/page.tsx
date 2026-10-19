import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getDict } from "@/lib/lang";
import { timeAgo } from "@/lib/labels";
import { CategoryLabel, PriorityBadge, StatusBadge } from "@/components/badges";
import { SiteHeader } from "@/components/site-header";

export const dynamic = "force-dynamic";
export const metadata = { title: "My requests" };

export default async function MyRequestsPage() {
  const user = await requireUser();
  const { t } = await getDict();

  const tickets = await prisma.ticket.findMany({
    where: {
      OR: [{ requesterId: user.id }, { requesterEmail: user.email }],
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return (
    <div className="min-h-screen">
      <SiteHeader />

      <main className="mx-auto max-w-3xl px-4 py-8">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-bold tracking-tight">{t.myTitle}</h1>
          <Link href="/" className="btn-primary">{t.newRequest}</Link>
        </div>

        {tickets.length === 0 ? (
          <div className="card px-6 py-12 text-center text-sm text-slate-500">
            {t.emptyRequests}{" "}
            <Link href="/" className="font-medium text-blue-700 hover:underline">
              {t.submitFirst}
            </Link>
          </div>
        ) : (
          <ul className="space-y-3">
            {tickets.map((ticket) => (
              <li key={ticket.id}>
                <Link href={`/t/${ticket.token}`} className="card block p-4 transition hover:border-blue-300">
                  <div className="flex items-start justify-between gap-3">
                    <p className="font-semibold">
                      <span className="mr-1.5 text-slate-400">#{ticket.id}</span>
                      {ticket.title}
                    </p>
                    <span className="whitespace-nowrap text-xs text-slate-400">
                      {timeAgo(ticket.createdAt)}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <StatusBadge status={ticket.status} />
                    <PriorityBadge priority={ticket.priority} />
                    <CategoryLabel category={ticket.category} className="text-xs text-slate-500" />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
