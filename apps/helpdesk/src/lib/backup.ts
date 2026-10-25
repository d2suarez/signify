import path from "path";
import fs from "fs/promises";
import { gzipSync } from "zlib";
import { prisma } from "./db";

// The daily backup is offsite-backup.js, run by server.js: encrypted, off
// Railway, database plus attachments. What is left here is the admin's
// "Download backup now" in Settings. The local rotating copy this used to
// keep sat inside the container, so every deploy wiped it, and the emailed
// copy would have mailed the whole database unencrypted had SMTP ever been
// switched on. Both are gone.
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(process.cwd(), "data", "backups");

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
