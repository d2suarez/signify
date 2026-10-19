import { prisma } from "./db";
import { notifyUsers } from "./notify";

const DIGEST_DOW = Number(process.env.DIGEST_DOW ?? 1); // 1 = Monday (UTC)
const DIGEST_UTC_HOUR = Number(process.env.DIGEST_UTC_HOUR ?? 11); // ~7am ET
export const STALE_DAYS = Math.max(1, Number(process.env.STALE_DAYS ?? 5));

const ACTIVE = ["OPEN", "IN_PROGRESS", "WAITING"];

export function staleCutoff(): Date {
  return new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);
}

function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${week}`;
}

/** Sends the weekly summary once, on the configured day/hour (UTC). */
export async function runDigestIfDue() {
  const now = new Date();
  if (now.getUTCDay() !== DIGEST_DOW || now.getUTCHours() < DIGEST_UTC_HOUR) return;

  const week = isoWeek(now);
  const last = await prisma.meta.findUnique({ where: { key: "lastDigestWeek" } });
  if (last?.value === week) return;

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [open, inProgress, waiting, stale, created7, resolved7, oldestStale] = await Promise.all([
    prisma.ticket.count({ where: { status: "OPEN" } }),
    prisma.ticket.count({ where: { status: "IN_PROGRESS" } }),
    prisma.ticket.count({ where: { status: "WAITING" } }),
    prisma.ticket.count({ where: { status: { in: ACTIVE }, updatedAt: { lt: staleCutoff() } } }),
    prisma.ticket.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
    prisma.ticket.count({ where: { resolvedAt: { gte: sevenDaysAgo } } }),
    prisma.ticket.findMany({
      where: { status: { in: ACTIVE }, updatedAt: { lt: staleCutoff() } },
      orderBy: { updatedAt: "asc" },
      take: 5,
    }),
  ]);

  const lines = [
    `Open ${open} · In progress ${inProgress} · Waiting ${waiting}`,
    `Last 7 days: ${created7} new, ${resolved7} resolved`,
    stale > 0
      ? `${stale} ticket${stale === 1 ? "" : "s"} with no activity in ${STALE_DAYS}+ days:`
      : `No stale tickets.`,
    ...oldestStale.map(
      (t) =>
        `  #${t.id} ${t.title} (${Math.floor((Date.now() - t.updatedAt.getTime()) / 86400000)}d quiet)`
    ),
  ];

  const agents = await prisma.user.findMany({
    where: { active: true, role: { in: ["ADMIN", "TECH"] } },
  });
  await notifyUsers(agents, "digest", {
    title: "Help desk weekly summary",
    body: lines.join("\n"),
    url: "/dashboard?view=stale",
  });

  await prisma.meta.upsert({
    where: { key: "lastDigestWeek" },
    update: { value: week },
    create: { key: "lastDigestWeek", value: week },
  });
  console.log("Digest: sent weekly summary");
}
