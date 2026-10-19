// Adds a handful of sample tickets for trying out the app locally.
// Run with: node scripts/demo-data.mjs   (safe to delete this file)
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const existing = await prisma.ticket.count();
if (existing > 0) {
  console.log(`${existing} tickets already exist; demo data skipped.`);
  process.exit(0);
}

const admin = await prisma.user.findFirst({ where: { role: "ADMIN" } });

const tickets = [
  {
    title: "Chromebook screen is cracked",
    description: "Cart 2, Chromebook #C-114. The screen cracked when it was dropped during 4th period.",
    category: "TECHNOLOGY",
    priority: "NORMAL",
    status: "OPEN",
    requesterName: "Maya Johnson",
    requesterEmail: "maya.j@student.school.org",
    requesterRole: "STUDENT",
    location: "Room 14",
    device: "Chromebook #C-114",
  },
  {
    title: "Projector keeps flickering during lessons",
    description: "It flickers every few minutes and sometimes goes black for a second. Tried a different HDMI cable already.",
    category: "TECHNOLOGY",
    priority: "HIGH",
    status: "IN_PROGRESS",
    requesterName: "Aaron Long",
    requesterEmail: "along@school.org",
    requesterRole: "STAFF",
    location: "Room 3",
    device: "Epson projector",
    assign: true,
  },
  {
    title: "Water fountain by gym is leaking",
    description: "Small puddle forming on the floor — could be a slip hazard.",
    category: "MAINTENANCE",
    priority: "URGENT",
    status: "OPEN",
    requesterName: "Dana Whitfield",
    requesterEmail: "dwhitfield@school.org",
    requesterRole: "STAFF",
    location: "Gym hallway",
  },
  {
    title: "Can't sign in to my school Google account",
    description: "It says my password is wrong but I'm sure it's right.",
    category: "TECHNOLOGY",
    priority: "NORMAL",
    status: "WAITING",
    requesterName: "Eli Torres",
    requesterEmail: "eli.t@student.school.org",
    requesterRole: "STUDENT",
    location: "Library",
    device: "Chromebook",
    comment: "Reset your password at the library desk — let us know if it still doesn't work.",
  },
  {
    title: "Request: extra iPad charging station for PreK",
    description: "We have 8 iPads but only 4 charger slots in the classroom.",
    category: "OTHER",
    priority: "LOW",
    status: "OPEN",
    requesterName: "Grace Kim",
    requesterEmail: "gkim@school.org",
    requesterRole: "STAFF",
    location: "PreK room",
  },
  {
    title: "Smartboard pen not tracking",
    description: "Calibration didn't fix it.",
    category: "TECHNOLOGY",
    priority: "NORMAL",
    status: "RESOLVED",
    requesterName: "Aaron Long",
    requesterEmail: "along@school.org",
    requesterRole: "STAFF",
    location: "Room 7",
    device: "Smartboard",
    comment: "Replaced the pen battery and recalibrated — working now. Ping us if it acts up again!",
  },
];

for (const { assign, comment, ...data } of tickets) {
  const ticket = await prisma.ticket.create({
    data: {
      ...data,
      assignedToId: assign && admin ? admin.id : null,
      resolvedAt: data.status === "RESOLVED" ? new Date() : null,
    },
  });
  if (comment && admin) {
    await prisma.comment.create({
      data: { ticketId: ticket.id, authorId: admin.id, authorName: admin.name, body: comment },
    });
  }
}

console.log(`Created ${tickets.length} demo tickets.`);
await prisma.$disconnect();
