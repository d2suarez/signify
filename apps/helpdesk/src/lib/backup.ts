import path from "path";
import fs from "fs/promises";
import { gzipSync } from "zlib";
import { prisma } from "./db";
import { isEmailEnabled, sendMailWithAttachment } from "./mail";

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(process.cwd(), "data", "backups");
const KEEP = 14;
const BACKUP_EMAIL = process.env.BACKUP_EMAIL || process.env.HELPDESK_NOTIFY_EMAIL;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function getMeta(key: string): Promise<string | null> {
  const row = await prisma.meta.findUnique({ where: { key } });
  return row?.value ?? null;
}

async function setMeta(key: string, value: string) {
  await prisma.meta.upsert({ where: { key }, update: { value }, create: { key, value } });
}

/** Consistent SQLite snapshot via VACUUM INTO, gzipped. */
export async function createBackupGzip(): Promise<{ filename: string; content: Buffer }> {
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
  const rawPath = path.join(BACKUP_DIR, `snapshot-${stamp}-${process.pid}.db`);
  await prisma.$executeRawUnsafe(`VACUUM INTO '${rawPath.replace(/'/g, "''")}'`);
  const raw = await fs.readFile(rawPath);
  await fs.unlink(rawPath).catch(() => {});
  return { filename: `helpdesk-backup-${stamp}.db.gz`, content: gzipSync(raw) };
}

/** Runs at most once per day: rotating snapshot on the volume + emailed copy. */
export async function runDailyBackup() {
  const last = await getMeta("lastBackupDate");
  if (last === today()) return;

  const { filename, content } = await createBackupGzip();
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  await fs.writeFile(path.join(BACKUP_DIR, filename), content);

  // Rotate: keep the newest KEEP files
  const entries = (await fs.readdir(BACKUP_DIR)).filter((f) => f.endsWith(".db.gz")).sort();
  for (const old of entries.slice(0, Math.max(0, entries.length - KEEP))) {
    await fs.unlink(path.join(BACKUP_DIR, old)).catch(() => {});
  }

  if (BACKUP_EMAIL && (await isEmailEnabled())) {
    const emailed = await sendMailWithAttachment(
      BACKUP_EMAIL,
      `Help desk backup ${today()}`,
      "Automatic daily database backup. Keep a few of these around — restoring is just gunzip + replacing the database file.",
      filename,
      content
    );
    console.log(
      emailed.ok
        ? `Backup: emailed ${filename} to ${BACKUP_EMAIL}`
        : `Backup: email to ${BACKUP_EMAIL} failed — ${emailed.error}`
    );
  }

  await setMeta("lastBackupDate", today());
  console.log(`Backup: wrote ${filename} (${Math.round(content.length / 1024)} KB)`);
}
