import { prisma } from "./db";
import { notifyNewTicket } from "./mail";
import { notifyUsers } from "./notify";

/** Creates tickets for recurring tasks that are due, then advances their schedule. */
export async function runRecurringTasks() {
  const due = await prisma.recurringTask.findMany({
    where: { active: true, nextRunAt: { lte: new Date() } },
  });
  if (due.length === 0) return;

  const agents = await prisma.user.findMany({
    where: { active: true, role: { in: ["ADMIN", "TECH"] } },
  });

  for (const task of due) {
    const creator = task.createdById
      ? await prisma.user.findUnique({ where: { id: task.createdById } })
      : null;
    const requester = creator ?? agents.find((a) => a.role === "ADMIN") ?? agents[0];
    if (!requester) continue; // no agents at all — skip until one exists

    const ticket = await prisma.ticket.create({
      data: {
        title: task.title,
        description: task.description,
        category: task.category,
        priority: "NORMAL",
        source: "SCHEDULED",
        assignedToId: task.assignedToId,
        requesterId: requester.id,
        requesterName: requester.name,
        requesterEmail: requester.email,
        requesterRole: "STAFF",
      },
    });

    // Advance past now even if the server was down for several cycles
    let next = new Date(task.nextRunAt);
    while (next <= new Date()) {
      next = new Date(next.getTime() + task.everyDays * 24 * 60 * 60 * 1000);
    }
    await prisma.recurringTask.update({ where: { id: task.id }, data: { nextRunAt: next } });

    await notifyNewTicket(ticket);
    const assignee = task.assignedToId
      ? agents.filter((a) => a.id === task.assignedToId)
      : [];
    if (assignee.length > 0) {
      await notifyUsers(assignee, "assigned", {
        title: `Scheduled task: #${ticket.id}`,
        body: ticket.title,
        url: `/dashboard/tickets/${ticket.id}`,
      });
    } else {
      await notifyUsers(agents, "new_ticket", {
        title: `Scheduled task: #${ticket.id}`,
        body: ticket.title,
        url: `/dashboard/tickets/${ticket.id}`,
      });
    }
    console.log(`Recurring: created ticket #${ticket.id} for "${task.title}"`);
  }
}
