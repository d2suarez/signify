import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireAgent } from "@/lib/auth";
import { linkTicketDevice, markDuplicate, updateTicket } from "@/lib/actions";
import { linkTicketToProject } from "@/lib/project-actions";
import { canEdit, projectsFor } from "@/lib/projects";
import { parseTicketFields } from "@/lib/forms";
import { DEVICE_TYPES } from "@/lib/labels";
import { CommentBox } from "@/components/comment-box";
import { formatDateTime, PRIORITIES, ROLES, STATUSES, timeAgo } from "@/lib/labels";
import { CategoryLabel, PriorityBadge, StatusBadge } from "@/components/badges";
import { AutoSelect } from "@/components/auto-select";
import { SubmitButton } from "@/components/submit-button";

export const dynamic = "force-dynamic";

export default async function TicketDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ err?: string }>;
}) {
  const agent = await requireAgent();
  const { id } = await params;
  const { err } = await searchParams;
  const ticketId = Number(id);
  if (!Number.isInteger(ticketId)) notFound();

  const [ticket, staff, snippets, duplicates] = await Promise.all([
    prisma.ticket.findUnique({
      where: { id: ticketId },
      include: {
        comments: { orderBy: { createdAt: "asc" } },
        attachments: true,
        assignedTo: true,
        linkedDevice: true,
        project: { select: { id: true, title: true } },
      },
    }),
    prisma.user.findMany({
      where: { active: true, role: { in: ["ADMIN", "TECH"] } },
      orderBy: { name: "asc" },
    }),
    prisma.snippet.findMany({ orderBy: { title: "asc" } }),
    prisma.ticket.findMany({
      where: { duplicateOfId: ticketId },
      select: { id: true, title: true },
    }),
  ]);
  if (!ticket) notFound();
  const projects = (await projectsFor(agent)).filter((p) => !p.archived && canEdit(p, agent));
  const fieldValues = parseTicketFields(ticket.formData);

  const update = updateTicket.bind(null, ticket.id);

  return (
    <div className="space-y-4">
      <Link href="/dashboard" className="text-sm font-medium text-blue-700 hover:underline">
        All tickets
      </Link>

      {err && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {err}
        </div>
      )}

      {ticket.duplicateOfId && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Closed as a duplicate of{" "}
          <Link
            href={`/dashboard/tickets/${ticket.duplicateOfId}`}
            className="font-semibold underline"
          >
            #{ticket.duplicateOfId}
          </Link>
          . Public updates there are copied here automatically.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold">
          <span className="mr-1.5 text-slate-400">#{ticket.id}</span>
          {ticket.title}
        </h1>
        <StatusBadge status={ticket.status} />
        <PriorityBadge priority={ticket.priority} />
        {ticket.source === "EMAIL" && (
          <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
            via email
          </span>
        )}
        {ticket.source === "DESK" && (
          <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
            from Teacher&apos;s Desk
          </span>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <section className="card p-5">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
              Request{ticket.formName ? ` · via "${ticket.formName}"` : ""}
            </h2>
            {fieldValues.length > 0 && (
              <dl className="mb-4 space-y-3 text-sm">
                {fieldValues.map((value) => (
                  <div key={value.label}>
                    <dt className="text-slate-500">{value.label}</dt>
                    <dd className="whitespace-pre-wrap font-medium">{value.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {ticket.description ? (
              <p className="whitespace-pre-wrap text-sm text-slate-700">{ticket.description}</p>
            ) : fieldValues.length === 0 ? (
              <p className="text-sm italic text-slate-400">No details provided.</p>
            ) : null}
            {ticket.attachments.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-3 border-t border-slate-100 pt-4">
                {ticket.attachments.map((file) =>
                  file.mimetype.startsWith("image/") ? (
                    <a key={file.id} href={`/api/files/${file.id}`} target="_blank" rel="noreferrer">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`/api/files/${file.id}`}
                        alt={file.filename}
                        className="h-28 w-28 rounded-lg border border-slate-200 object-cover"
                      />
                    </a>
                  ) : (
                    <a
                      key={file.id}
                      href={`/api/files/${file.id}`}
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
          </section>

          <section className="card p-5">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
              Activity
            </h2>
            {ticket.comments.length === 0 ? (
              <p className="mb-4 text-sm text-slate-500">Nothing yet.</p>
            ) : (
              <ul className="mb-5 space-y-3">
                {ticket.comments.map((entry) => (
                  <li
                    key={entry.id}
                    className={`rounded-lg border px-4 py-3 text-sm ${
                      entry.internal
                        ? "border-amber-200 bg-amber-50"
                        : entry.authorId
                          ? "border-blue-100 bg-blue-50"
                          : "border-slate-200 bg-slate-50"
                    }`}
                  >
                    <p className="mb-1 flex items-baseline justify-between gap-3">
                      <span className="font-semibold">
                        {entry.authorName}
                        {entry.internal && (
                          <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-700">
                            Internal
                          </span>
                        )}
                        {!entry.authorId && (
                          <span className="ml-1.5 rounded bg-slate-200 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">
                            Requester
                          </span>
                        )}
                      </span>
                      <span className="whitespace-nowrap text-xs text-slate-400" title={formatDateTime(entry.createdAt)}>
                        {timeAgo(entry.createdAt)}
                      </span>
                    </p>
                    <p className="whitespace-pre-wrap text-slate-700">{entry.body}</p>
                  </li>
                ))}
              </ul>
            )}

            <CommentBox
              ticketId={ticket.id}
              snippets={snippets.map((s) => ({ id: s.id, title: s.title, body: s.body }))}
            />
          </section>
        </div>

        <div className="space-y-4">
          <section className="card p-5">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
              Manage
            </h2>
            <div className="space-y-3">
              <form action={update}>
                <label className="label" htmlFor="status">Status</label>
                <AutoSelect key={ticket.status} id="status" name="status" defaultValue={ticket.status} className="input">
                  {Object.entries(STATUSES).map(([value, s]) => (
                    <option key={value} value={value}>{s.label}</option>
                  ))}
                </AutoSelect>
              </form>
              <form action={update}>
                <label className="label" htmlFor="priority">Priority</label>
                <AutoSelect key={ticket.priority} id="priority" name="priority" defaultValue={ticket.priority} className="input">
                  {Object.entries(PRIORITIES).map(([value, p]) => (
                    <option key={value} value={value}>{p.label}</option>
                  ))}
                </AutoSelect>
              </form>
              {duplicates.length > 0 && (
                <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  <span className="font-semibold">{duplicates.length} duplicate{duplicates.length === 1 ? "" : "s"}:</span>{" "}
                  {duplicates.map((dup, i) => (
                    <span key={dup.id}>
                      {i > 0 && ", "}
                      <Link href={`/dashboard/tickets/${dup.id}`} className="text-blue-700 hover:underline">
                        #{dup.id}
                      </Link>
                    </span>
                  ))}
                  <span className="mt-1 block text-slate-400">
                    Public updates here are copied to all duplicates.
                  </span>
                </div>
              )}
              {!ticket.duplicateOfId && (
                <details>
                  <summary className="cursor-pointer text-sm font-medium text-slate-600 hover:underline">
                    Mark as duplicate…
                  </summary>
                  <form action={markDuplicate.bind(null, ticket.id)} className="mt-2 flex gap-1.5">
                    <input
                      name="parent"
                      required
                      inputMode="numeric"
                      className="input w-28 py-1.5 text-sm"
                      placeholder="Ticket #"
                    />
                    <SubmitButton className="btn-secondary px-2.5 py-1.5 text-sm" pendingText="…">
                      Mark
                    </SubmitButton>
                  </form>
                  <p className="mt-1 text-xs text-slate-400">
                    Closes this ticket and tells the requester where it&apos;s tracked.
                  </p>
                </details>
              )}
              <form action={update}>
                <label className="label" htmlFor="assignedToId">Assigned to</label>
                <AutoSelect key={ticket.assignedToId ?? "none"} id="assignedToId" name="assignedToId" defaultValue={ticket.assignedToId ?? ""} className="input">
                  <option value="">Unassigned</option>
                  {staff.map((member) => (
                    <option key={member.id} value={member.id}>{member.name}</option>
                  ))}
                </AutoSelect>
              </form>
            </div>
          </section>

          <section className="card p-5">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
              Requester
            </h2>
            <dl className="space-y-2 text-sm">
              <div>
                <dt className="text-slate-500">Name</dt>
                <dd className="font-medium">
                  {ticket.requesterName}
                  <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">
                    {ROLES[ticket.requesterRole] ?? ticket.requesterRole}
                  </span>
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Email</dt>
                <dd>
                  <a href={`mailto:${ticket.requesterEmail}`} className="font-medium text-blue-700 hover:underline">
                    {ticket.requesterEmail}
                  </a>
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Category</dt>
                <dd><CategoryLabel category={ticket.category} /></dd>
              </div>
              {ticket.location && (
                <div>
                  <dt className="text-slate-500">Location</dt>
                  <dd>{ticket.location}</dd>
                </div>
              )}
              {ticket.device && (
                <div>
                  <dt className="text-slate-500">Device</dt>
                  <dd>{ticket.device}</dd>
                </div>
              )}
              <div>
                <dt className="text-slate-500">Inventory device</dt>
                <dd>
                  {ticket.linkedDevice ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/dashboard/devices/${ticket.linkedDevice.id}`}
                        className="font-medium text-blue-700 hover:underline"
                      >
                        {ticket.linkedDevice.tag}
                      </Link>
                      <span className="text-xs text-slate-400">
                        {DEVICE_TYPES[ticket.linkedDevice.type] ?? ticket.linkedDevice.type}
                      </span>
                      <form action={linkTicketDevice.bind(null, ticket.id)}>
                        <button type="submit" className="cursor-pointer text-xs text-red-600 hover:underline">
                          Unlink
                        </button>
                      </form>
                    </span>
                  ) : (
                    <form action={linkTicketDevice.bind(null, ticket.id)} className="flex gap-1.5">
                      <input
                        name="tag"
                        className="input w-28 py-1 text-xs"
                        placeholder="Tag, e.g. C-104"
                        aria-label="Link device by tag"
                      />
                      <button type="submit" className="btn-secondary px-2.5 py-1 text-xs">Link</button>
                    </form>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Project</dt>
                <dd>
                  {ticket.project && (
                    <Link href={`/projects/${ticket.project.id}`} className="mb-1.5 block font-medium text-blue-700 hover:underline">
                      {ticket.project.title}
                    </Link>
                  )}
                  <form action={linkTicketToProject.bind(null, ticket.id)}>
                    <AutoSelect
                      key={ticket.projectId ?? ""}
                      name="projectId"
                      defaultValue={ticket.projectId ?? ""}
                      className="input py-1 text-xs"
                      aria-label="Part of a project"
                    >
                      <option value="">Not part of a project</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>{p.title}</option>
                      ))}
                    </AutoSelect>
                  </form>
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">Submitted</dt>
                <dd>{formatDateTime(ticket.createdAt)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Last activity</dt>
                <dd>{formatDateTime(ticket.updatedAt)}</dd>
              </div>
            </dl>
            <Link
              href={`/t/${ticket.token}`}
              target="_blank"
              className="mt-4 inline-block text-sm font-medium text-blue-700 hover:underline"
            >
              View as requester
            </Link>
          </section>
        </div>
      </div>
    </div>
  );
}
