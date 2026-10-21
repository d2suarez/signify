import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { STATUSES } from "@/lib/labels";
import { APP_URL } from "@/lib/mail";
import { categoriesFor, getLocations } from "@/lib/categories";

export const dynamic = "force-dynamic";

/**
 * For the ticket box on Teacher's Desk: who you are here, and your latest
 * requests. Called cross-origin from desk.signify.one; server.js decides
 * which origins may read it. A 401 tells the box to offer "Connect".
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json(
      { signedIn: false, connectUrl: `${APP_URL}/desk-connect` },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }
  const [categories, locations] = await Promise.all([categoriesFor(user), getLocations(user.tenantId)]);
  const tickets = await prisma.ticket.findMany({
    where: { requesterId: user.id },
    orderBy: { updatedAt: "desc" },
    take: 5,
    select: { id: true, title: true, status: true, token: true, updatedAt: true },
  });
  return Response.json(
    {
      signedIn: true,
      name: user.name,
      helpDeskUrl: APP_URL,
      // What the request form asks, so the box on the Desk asks the same.
      categories: categories.map((c) => ({
        key: c.key,
        name: c.name,
        shape: c.shape,
        color: c.color,
        titlePrompt: c.titlePrompt,
        askLocation: c.askLocation,
        askDevice: c.askDevice,
        fields: c.fields,
      })),
      locations,
      tickets: tickets.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        statusLabel: STATUSES[t.status]?.label ?? t.status,
        url: `${APP_URL}/t/${t.token}`,
        updatedAt: t.updatedAt.toISOString(),
      })),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
