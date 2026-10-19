import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { parseTicketFields } from "@/lib/forms";
import { getDict } from "@/lib/lang";
import { formatDateTime, timeAgo } from "@/lib/labels";
import { CategoryLabel, PriorityBadge, StatusBadge } from "@/components/badges";
import { ReplyForm } from "@/components/reply-form";
import { SiteHeader } from "@/components/site-header";

export const dynamic = "force-dynamic";

export default async function PublicTicketPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ new?: string }>;
}) {
  const { token } = await params;
  const { t } = await getDict();
  const isNew = (await searchParams).new === "1";

  const ticket = await prisma.ticket.findUnique({
    where: { token },
    include: {
      comments: { where: { internal: false }, orderBy: { createdAt: "asc" } },
      attachments: true,
      assignedTo: { select: { name: true } },
    },
  });
  if (!ticket) notFound();
  const fieldValues = parseTicketFields(ticket.formData);

  return (
    <div className="min-h-screen">
      <SiteHeader />

      <main className="mx-auto max-w-3xl space-y-6 px-4 py-8">
        {isNew && (
          <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
            <p className="font-semibold">{t.requestIn}</p>
            <p className="mt-1">
              {t.ticketNumberIs} <strong>#{ticket.id}</strong>. {t.findAnytime}{" "}
              <Link href="/my" className="font-medium underline">
                {t.myRequests}
              </Link>
              .
            </p>
          </div>
        )}

        <div className="card p-5 sm:p-6">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-slate-400">#{ticket.id}</span>
            <StatusBadge status={ticket.status} />
            <PriorityBadge priority={ticket.priority} />
          </div>
          <h1 className="mt-2 text-xl font-bold">{ticket.title}</h1>
          <dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div className="flex gap-2">
              <dt className="text-slate-500">{t.categoryLabel}</dt>
              <dd><CategoryLabel category={ticket.category} /></dd>
            </div>
            {ticket.formName && (
              <div className="flex gap-2">
                <dt className="text-slate-500">{t.formLabel}</dt>
                <dd>{ticket.formName}</dd>
              </div>
            )}
            <div className="flex gap-2">
              <dt className="text-slate-500">{t.submittedLabel}</dt>
              <dd title={formatDateTime(ticket.createdAt)}>
                {timeAgo(ticket.createdAt)}
                {ticket.source === "EMAIL" && ` · ${t.byEmail}`}
              </dd>
            </div>
            {ticket.location && (
              <div className="flex gap-2">
                <dt className="text-slate-500">Location:</dt>
                <dd>{ticket.location}</dd>
              </div>
            )}
            {ticket.device && (
              <div className="flex gap-2">
                <dt className="text-slate-500">Device:</dt>
                <dd>{ticket.device}</dd>
              </div>
            )}
            {ticket.assignedTo && (
              <div className="flex gap-2">
                <dt className="text-slate-500">{t.handledBy}</dt>
                <dd>{ticket.assignedTo.name}</dd>
              </div>
            )}
          </dl>
          {fieldValues.length > 0 && (
            <dl className="mt-4 space-y-3 border-t border-slate-100 pt-4 text-sm">
              {fieldValues.map((value) => (
                <div key={value.label}>
                  <dt className="text-slate-500">{value.label}</dt>
                  <dd className="whitespace-pre-wrap font-medium">{value.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {ticket.description && (
            <p className="mt-4 whitespace-pre-wrap border-t border-slate-100 pt-4 text-sm text-slate-700">
              {ticket.description}
            </p>
          )}
          {ticket.attachments.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-3 border-t border-slate-100 pt-4">
              {ticket.attachments.map((file) =>
                file.mimetype.startsWith("image/") ? (
                  <a key={file.id} href={`/api/files/${file.id}?t=${ticket.token}`} target="_blank" rel="noreferrer">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/files/${file.id}?t=${ticket.token}`}
                      alt={file.filename}
                      className="h-24 w-24 rounded-lg border border-slate-200 object-cover"
                    />
                  </a>
                ) : (
                  <a
                    key={file.id}
                    href={`/api/files/${file.id}?t=${ticket.token}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm font-medium text-blue-700 hover:underline"
                  >
                    {file.filename}
                  </a>
                )
              )}
            </div>
          )}
        </div>

        <div className="card p-5 sm:p-6">
          <h2 className="mb-4 text-base font-semibold">{t.updates}</h2>
          {ticket.comments.length === 0 ? (
            <p className="mb-4 text-sm text-slate-500">{t.noUpdates}</p>
          ) : (
            <ul className="mb-6 space-y-3">
              {ticket.comments.map((comment) => (
                <li
                  key={comment.id}
                  className={`rounded-lg px-4 py-3 text-sm ${
                    comment.authorId
                      ? "border border-blue-100 bg-blue-50"
                      : "border border-slate-200 bg-slate-50"
                  }`}
                >
                  <p className="mb-1 flex items-baseline justify-between gap-3">
                    <span className="font-semibold">
                      {comment.authorName}
                      {comment.authorId && (
                        <span className="ml-1.5 rounded bg-blue-100 px-1.5 py-0.5 text-[11px] font-medium text-blue-700">
                          {t.helpDeskTag}
                        </span>
                      )}
                    </span>
                    <span className="whitespace-nowrap text-xs text-slate-400">
                      {timeAgo(comment.createdAt)}
                    </span>
                  </p>
                  <p className="whitespace-pre-wrap text-slate-700">{comment.body}</p>
                </li>
              ))}
            </ul>
          )}
          <ReplyForm
            token={ticket.token}
            placeholder={t.replyPlaceholder}
            sendLabel={t.sendReply}
            sendingLabel={t.sendingReply}
          />
        </div>
      </main>
    </div>
  );
}
