import "server-only";
import { prisma } from "./db";
import { notifyNewTicket } from "./mail";
import { notifyUsers } from "./notify";

type Requester = { id: string; name: string; email: string; role: string };

/**
 * Files a ticket and tells the people who need to know. Shared by the
 * request form and the ticket box on Teacher's Desk.
 */
export async function createTicketFor(
  user: Requester,
  data: {
    category: string;
    title: string;
    description: string;
    priority: string;
    location?: string;
    device?: string;
    deviceId?: string | null;
    source?: string;
  }
) {
  const ticket = await prisma.ticket.create({
    data: {
      title: data.title,
      description: data.description,
      category: data.category,
      priority: data.priority,
      source: data.source ?? "WEB",
      requesterId: user.id,
      requesterName: user.name,
      requesterEmail: user.email,
      requesterRole: user.role === "STUDENT" ? "STUDENT" : "STAFF",
      location: data.location || null,
      device: data.device || null,
      deviceId: data.deviceId ?? null,
    },
  });
  await announceTicket(ticket, user.name);
  return ticket;
}

export async function announceTicket(ticket: Parameters<typeof notifyNewTicket>[0] & { id: number; title: string }, who: string) {
  await notifyNewTicket(ticket);
  const agents = await prisma.user.findMany({ where: { active: true, role: { in: ["ADMIN", "TECH"] } } });
  await notifyUsers(agents, "new_ticket", {
    title: `New request #${ticket.id}`,
    body: `${who}: ${ticket.title}`,
    url: `/dashboard/tickets/${ticket.id}`,
  });
}
