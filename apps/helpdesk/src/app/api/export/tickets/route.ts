import { prisma } from "@/lib/db";
import { getCurrentUser, isAgent } from "@/lib/auth";
import { csvResponse, toCsv } from "@/lib/csv";
import { getAllCategories } from "@/lib/categories";
import { PRIORITIES, ROLES, STATUSES } from "@/lib/labels";

export async function GET() {
  const user = await getCurrentUser();
  if (!user || !isAgent(user)) return new Response("Forbidden", { status: 403 });

  const tickets = await prisma.ticket.findMany({
    include: { assignedTo: { select: { name: true } }, linkedDevice: { select: { tag: true } } },
    orderBy: { id: "asc" },
  });
  const categoryNames = new Map((await getAllCategories()).map((c) => [c.key, c.name]));

  const csv = toCsv(
    [
      "id", "title", "status", "priority", "category", "requester", "requesterEmail",
      "requesterRole", "assignedTo", "location", "device", "inventoryTag", "source",
      "form", "duplicateOf", "createdAt", "updatedAt", "resolvedAt",
    ],
    tickets.map((t) => [
      t.id,
      t.title,
      STATUSES[t.status]?.label ?? t.status,
      PRIORITIES[t.priority]?.label ?? t.priority,
      categoryNames.get(t.category) ?? t.category,
      t.requesterName,
      t.requesterEmail,
      ROLES[t.requesterRole] ?? t.requesterRole,
      t.assignedTo?.name ?? "",
      t.location ?? "",
      t.device ?? "",
      t.linkedDevice?.tag ?? "",
      t.source,
      t.formName ?? "",
      t.duplicateOfId ?? "",
      t.createdAt.toISOString(),
      t.updatedAt.toISOString(),
      t.resolvedAt?.toISOString() ?? "",
    ])
  );

  return csvResponse(`tickets-${new Date().toISOString().slice(0, 10)}.csv`, csv);
}
