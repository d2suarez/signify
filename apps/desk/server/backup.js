// ===================================================================
// Daily backups of an app's data directory — on the volume, and off it
//
// Once a day (and a minute after every start, because these apps sleep when
// nobody is using them and a start is often the only chance there is), the
// whole data directory is packed into backup-YYYY-MM-DD.tar.gz.
//
// With R2 configured (see offsite.js) the archive is copied off the volume,
// old ones there are pruned, and the volume keeps just one local copy. A
// failed upload keeps the full local set instead: a broken mirror must never
// leave fewer copies than having no mirror at all.
//
// Shared, byte for byte, by Teacher's Desk and Classroom Atlas. The
// Whiteboard has its own older version with disk-space handling it needs and
// these do not.
// ===================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const offsite = require('./offsite');

const NAME = /^backup-(\d{4}-\d{2}-\d{2})\.tar\.gz$/;
const DAY_MS = 864e5;
const day = (t) => new Date(t).toISOString().slice(0, 10);

/**
 * @param {object} o
 * @param {string} o.dataDir      what to back up
 * @param {string} o.prefix       this app's folder in the bucket, e.g. 'desk/'
 * @param {number} [o.keep]       archives to keep off-site
 * @param {number} [o.maxAgeDays] also drop any archive older than this, here
 *                                and off-site — for data promised a deletion date
 * @param {number} [o.keepLocal]  archives kept on the volume when there is no
 *                                off-site copy to lean on
 */
function createBackups({ dataDir, prefix, keep = 30, maxAgeDays = null, keepLocal = 3, now = () => Date.now(), log = console }) {
  offsite.configure({ prefix });
  const dir = path.join(dataDir, 'backups');
  let running = null;

  function localNames() {
    try { return fs.readdirSync(dir).filter((f) => NAME.test(f)).sort(); }
    catch { return []; }
  }

  // Newest last. The newest is never dropped on age alone, for the same reason
  // as off-site: a long quiet spell should end with one copy, not none.
  function pruneLocal(count) {
    const names = localNames();
    const cutoff = maxAgeDays ? day(now() - maxAgeDays * DAY_MS) : null;
    names.forEach((f, i) => {
      const surplus = i < names.length - Math.max(1, count);
      const stale = cutoff && i < names.length - 1 && NAME.exec(f)[1] < cutoff;
      if (surplus || stale) fs.rmSync(path.join(dir, f), { force: true });
    });
    // Leftovers from a run that was interrupted part-way.
    try {
      for (const f of fs.readdirSync(dir)) if (f.endsWith('.tmp')) fs.rmSync(path.join(dir, f), { force: true });
    } catch { /* no directory yet */ }
  }

  function archive(target) {
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(target);
      const tar = spawn('tar', [
        '-czf', '-',
        // Not the backups themselves, not the filesystem's own bookkeeping, and
        // not a store's half-written temp file — the stores write a temp file
        // and rename it into place, so the real file is always whole.
        '--exclude=./backups', '--exclude=./lost+found', '--exclude=*.tmp',
        '-C', dataDir, '.',
      ]);
      let stderr = '';
      let tarCode = null;
      let written = false;
      const settle = () => {
        if (tarCode === null || !written) return;
        // GNU tar answers 1 for "a file changed while I read it". With stores
        // that only ever rename a finished file into place, what was read is
        // still a whole file, so that is a warning; 2 and up are failures.
        if (tarCode <= 1) resolve(stderr.trim());
        else reject(new Error(`tar exited ${tarCode}: ${stderr.trim().slice(0, 300)}`));
      };
      tar.stderr.on('data', (c) => { stderr += c; });
      tar.on('error', (e) => { out.destroy(); reject(e); });
      tar.on('close', (code) => { tarCode = code; settle(); });
      out.on('error', (e) => { try { tar.kill(); } catch { /* already gone */ } reject(e); });
      out.on('finish', () => { written = true; settle(); });
      tar.stdout.pipe(out);
    });
  }

  async function runOnce() {
    fs.mkdirSync(dir, { recursive: true });
    const name = `backup-${day(now())}.tar.gz`;
    const finalPath = path.join(dir, name);
    const tmp = `${finalPath}.tmp`;
    try {
      const warning = await archive(tmp);
      fs.renameSync(tmp, finalPath);
      if (warning) log.warn(`Backup ${name}: ${warning}`);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      log.error('Backup failed:', e.message);
      return { ok: false, error: e.message };
    }

    if (!offsite.enabled()) {
      pruneLocal(keepLocal);
      log.log('Backup written:', name);
      return { ok: true, name, offsite: false };
    }
    try {
      await offsite.upload(finalPath, name);
      const pruned = await offsite.prune(keep, { maxAgeDays, now: now() });
      pruneLocal(1);
      log.log(`Backup mirrored off-site: ${name}${pruned ? ` (${pruned} older removed)` : ''}`);
      return { ok: true, name, offsite: true, pruned };
    } catch (e) {
      pruneLocal(keepLocal);
      log.error('Off-site backup failed (kept local copies):', e.message);
      return { ok: false, name, offsite: true, error: e.message };
    }
  }

  // One at a time: a slow upload must not have a second run start over it.
  function run() {
    if (!running) running = runOnce().finally(() => { running = null; });
    return running;
  }

  function start() {
    if (offsite.enabled()) log.log('Off-site backups:', offsite.describe());
    setTimeout(run, 60 * 1000).unref();
    setInterval(run, DAY_MS).unref();
  }

  return { run, start, dir, localNames };
}

module.exports = createBackups;
