// ===================================================================
// Signify Help Desk — daily off-site backup
//
// The Next side already writes a nightly snapshot (src/lib/backup.ts), but
// into /app/data/backups: inside the container, not on the volume, so every
// deploy wipes it and nothing ever leaves Railway. This is the copy that
// does leave, the same way the rest of the fleet's does: encrypted here by
// offsite.js (shared byte for byte with Desk, Atlas, the Whiteboard and
// Signify ID), then sent to this app's own R2 bucket.
//
// One archive a day, backup-YYYY-MM-DD.tar.gz, holding:
//   helpdesk.db  a consistent snapshot (VACUUM INTO), never the live file,
//                which may be mid-write
//   uploads/     ticket attachments, without which a restored ticket points
//                at files that are gone
//
// Kept 28 days, matching the privacy policy; the bucket's lifecycle rule
// enforces the same while this app sleeps. With no R2 variables or no valid
// BACKUP_ENCRYPTION_KEY it sends nothing and says so once at boot.
//
// To restore: decrypt with `node offsite.js decrypt <file>.enc <file>`,
// untar, put helpdesk.db at DATABASE_URL's path and uploads/ at UPLOAD_DIR.
// ===================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const offsite = require('./offsite').configure({ prefix: 'helpdesk' });

const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_DAYS = 28;

function dbPath() {
  const url = process.env.DATABASE_URL || '';
  return url.startsWith('file:') ? url.slice('file:'.length) : null;
}

function tar(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('tar', args);
    let stderr = '';
    p.stderr.on('data', (c) => { stderr += c; });
    p.on('error', reject);
    // GNU tar answers 1 for "a file changed while I read it": an attachment
    // landing mid-backup. What was read is still whole, so that is a warning.
    p.on('close', (code) => (code <= 1 ? resolve() : reject(new Error(`tar exited ${code}: ${stderr.trim().slice(0, 300)}`))));
  });
}

async function runOnce(prisma) {
  const db = dbPath();
  if (!db) throw new Error('DATABASE_URL is not a file: URL, so there is no SQLite file to back up.');
  const dataDir = path.dirname(db);
  const work = path.join(dataDir, 'offsite-tmp');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  const name = `backup-${new Date().toISOString().slice(0, 10)}.tar.gz`;
  const archive = path.join(work, name);
  try {
    const snapshot = path.join(work, 'helpdesk.db');
    await prisma.$executeRawUnsafe(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);

    const args = ['-czf', archive, '-C', work, 'helpdesk.db'];
    const uploads = process.env.UPLOAD_DIR;
    if (uploads && fs.existsSync(uploads)) args.push('-C', path.dirname(uploads), path.basename(uploads));
    await tar(args);

    await offsite.upload(archive, name);
    const pruned = await offsite.prune(KEEP_DAYS, { maxAgeDays: KEEP_DAYS });
    console.log(`Backup mirrored off-site: ${name} (${Math.round(fs.statSync(archive).size / 1024)} KB)${pruned ? `, ${pruned} older removed` : ''}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** A minute after boot, then daily. Never throws: a failed backup must not take the help desk down. */
function start() {
  if (!offsite.enabled()) {
    console.log('Off-site backups: off (R2 variables not set)');
    return;
  }
  console.log('Off-site backups:', offsite.describe());
  if (!offsite.encrypted()) return;

  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await runOnce(prisma); }
    catch (e) { console.error('Off-site backup failed:', e.message); }
    finally { running = false; }
  };
  setTimeout(run, 60 * 1000).unref();
  setInterval(run, DAY_MS).unref();
}

module.exports = { start, runOnce };
