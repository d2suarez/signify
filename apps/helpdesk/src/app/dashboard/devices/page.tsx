import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireAgent } from "@/lib/auth";
import { DEVICE_STATUSES, DEVICE_TYPES } from "@/lib/labels";
import { DeviceForm } from "@/components/device-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Devices" };

export default async function DevicesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; msg?: string }>;
}) {
  await requireAgent();
  const sp = await searchParams;
  const q = sp.q?.trim() ?? "";
  const status = sp.status ?? "";

  const devices = await prisma.device.findMany({
    where: {
      ...(status && DEVICE_STATUSES[status] ? { status } : {}),
      ...(q
        ? {
            OR: [
              { tag: { contains: q.toUpperCase() } },
              { model: { contains: q } },
              { location: { contains: q } },
              { assignedTo: { contains: q } },
            ],
          }
        : {}),
    },
    include: { _count: { select: { tickets: true } } },
    orderBy: { tag: "asc" },
    take: 500,
  });

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold">Devices</h1>
        <div className="flex items-center gap-4 text-sm font-medium">
          <a href="/api/export/devices" className="text-blue-700 hover:underline">Export CSV</a>
          <Link href="/dashboard/devices/print" target="_blank" className="text-blue-700 hover:underline">
            Print QR labels ↗
          </Link>
        </div>
      </div>

      {sp.msg && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          {sp.msg}
        </div>
      )}

      <form method="GET" className="flex flex-wrap gap-2">
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search tag, model, location…"
          className="input w-64"
        />
        <select name="status" defaultValue={status} className="input w-auto">
          <option value="">Any status</option>
          {Object.entries(DEVICE_STATUSES).map(([value, s]) => (
            <option key={value} value={value}>{s.label}</option>
          ))}
        </select>
        <button type="submit" className="btn-secondary">Search</button>
      </form>

      {devices.length === 0 ? (
        <div className="card px-6 py-10 text-center text-sm text-slate-500">
          No devices yet — add your first one below. Tip: start with the Chromebook carts.
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-4 py-3">Tag</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Model</th>
                <th className="px-4 py-3">Location</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Tickets</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {devices.map((device) => {
                const s = DEVICE_STATUSES[device.status] ?? DEVICE_STATUSES.ACTIVE;
                return (
                  <tr key={device.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <Link
                        href={`/dashboard/devices/${device.id}`}
                        className="font-semibold text-slate-900 hover:text-blue-700"
                      >
                        {device.tag}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{DEVICE_TYPES[device.type] ?? device.type}</td>
                    <td className="px-4 py-3 text-slate-600">{device.model || "—"}</td>
                    <td className="px-4 py-3 text-slate-600">
                      {device.location || "—"}
                      {device.assignedTo && (
                        <span className="text-xs text-slate-400"> · {device.assignedTo}</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${s.badge}`}>
                        {s.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-500">{device._count.tickets}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <section className="card p-5">
        <h2 className="mb-4 text-base font-semibold">Add a device</h2>
        <DeviceForm initial={null} />
      </section>
    </div>
  );
}
