import Link from "next/link";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { prisma } from "@/lib/db";
import { requireAgent } from "@/lib/auth";
import { deleteDevice } from "@/lib/actions";
import { APP_URL } from "@/lib/mail";
import { timeAgo } from "@/lib/labels";
import { StatusBadge } from "@/components/badges";
import { DeviceForm } from "@/components/device-form";
import { SubmitButton } from "@/components/submit-button";

export const dynamic = "force-dynamic";
export const metadata = { title: "Device" };

export default async function DevicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAgent();
  const { id } = await params;
  const device = await prisma.device.findUnique({
    where: { id },
    include: {
      tickets: { orderBy: { createdAt: "desc" }, take: 20 },
    },
  });
  if (!device) notFound();

  const qrSvg = await QRCode.toString(
    `${APP_URL}/?device=${encodeURIComponent(device.tag)}`,
    { type: "svg", margin: 1, width: 140 }
  );

  return (
    <div className="max-w-4xl space-y-4">
      <Link href="/dashboard/devices" className="text-sm font-medium text-blue-700 hover:underline">
        ← All devices
      </Link>
      <h1 className="text-xl font-bold">{device.tag}</h1>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="card p-5 lg:col-span-2">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-400">
            Details
          </h2>
          <DeviceForm
            initial={{
              id: device.id,
              tag: device.tag,
              type: device.type,
              model: device.model,
              location: device.location,
              assignedTo: device.assignedTo,
              status: device.status,
              notes: device.notes,
            }}
          />
          <details className="mt-4 border-t border-slate-100 pt-3">
            <summary className="cursor-pointer text-sm font-medium text-red-600 hover:underline">
              Delete device
            </summary>
            <form action={deleteDevice.bind(null, device.id)} className="mt-2">
              <SubmitButton className="btn-secondary text-red-600" pendingText="Deleting…">
                Yes, delete {device.tag}
              </SubmitButton>
            </form>
          </details>
        </section>

        <section className="card p-5 text-center">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
            QR label
          </h2>
          <div
            className="mx-auto w-[140px] [&_svg]:h-auto [&_svg]:w-full"
            dangerouslySetInnerHTML={{ __html: qrSvg }}
          />
          <p className="mt-2 text-xs text-slate-500">
            Scanning opens the request form with this device prefilled. Stick it on the device or
            the cart.
          </p>
        </section>
      </div>

      <section className="card p-5">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
          Repair history · {device.tickets.length}
        </h2>
        {device.tickets.length === 0 ? (
          <p className="text-sm text-slate-500">No tickets for this device yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {device.tickets.map((ticket) => (
              <li key={ticket.id}>
                <Link
                  href={`/dashboard/tickets/${ticket.id}`}
                  className="flex items-center justify-between gap-3 py-2.5 hover:bg-slate-50"
                >
                  <span className="text-sm font-medium">
                    <span className="mr-1.5 text-slate-400">#{ticket.id}</span>
                    {ticket.title}
                  </span>
                  <span className="flex items-center gap-2 whitespace-nowrap text-xs text-slate-400">
                    <StatusBadge status={ticket.status} />
                    {timeAgo(ticket.createdAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
