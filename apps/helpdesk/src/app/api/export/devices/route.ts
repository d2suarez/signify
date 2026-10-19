import { prisma } from "@/lib/db";
import { getCurrentUser, isAgent } from "@/lib/auth";
import { csvResponse, toCsv } from "@/lib/csv";
import { DEVICE_STATUSES, DEVICE_TYPES } from "@/lib/labels";

export async function GET() {
  const user = await getCurrentUser();
  if (!user || !isAgent(user)) return new Response("Forbidden", { status: 403 });

  const devices = await prisma.device.findMany({
    include: { _count: { select: { tickets: true } } },
    orderBy: { tag: "asc" },
  });

  const csv = toCsv(
    ["tag", "type", "model", "location", "assignedTo", "status", "tickets", "notes", "createdAt"],
    devices.map((d) => [
      d.tag,
      DEVICE_TYPES[d.type] ?? d.type,
      d.model,
      d.location,
      d.assignedTo,
      DEVICE_STATUSES[d.status]?.label ?? d.status,
      d._count.tickets,
      d.notes,
      d.createdAt.toISOString(),
    ])
  );

  return csvResponse(`devices-${new Date().toISOString().slice(0, 10)}.csv`, csv);
}
