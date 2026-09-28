// ===================================================================
// Signify ID — stand the service back up from an off-site backup
//
//   1. Make a NEW, empty Postgres (never the live one — this refuses a
//      database that already has accounts in it).
//   2. Download the newest id/backup-YYYY-MM-DD.json.gz.enc from the bucket.
//   3. With the decryption key from the password manager, and the same R2_*
//      settings the service uses (so erasures made since can be re-applied):
//
//        read -rs BACKUP_ENCRYPTION_KEY && export BACKUP_ENCRYPTION_KEY
//        DATABASE_URL=<new database> R2_ACCOUNT_ID=… R2_BUCKET=signify-id-backups \
//        R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… \
//          npm run restore-db -- backup-2026-09-28.json.gz.enc
//
//   4. Point the service's DATABASE_URL at the new database and redeploy.
//      Everybody signs in again: sessions and signing keys are never backed
//      up, and a fresh signing key is made on first start.
//
// --no-erasure-check skips re-applying erasures. Only use it if the bucket
// is unreachable AND you are certain nobody was erased after the backup.
// ===================================================================

'use strict';

const fs = require('fs');

(async () => {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const skipErasures = args.includes('--no-erasure-check');
  if (!file) {
    console.error('Usage: npm run restore-db -- <backup.json.gz.enc> [--no-erasure-check]');
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error('Set DATABASE_URL to the NEW, empty database to restore into.');
    process.exit(2);
  }

  const dbbackup = require('./dbbackup');
  const offsite = require('./offsite');
  const db = require('./db');

  try {
    const snapshot = dbbackup.unpack(fs.readFileSync(file));
    const rows = Object.values(snapshot.tables).reduce((n, t) => n + t.rows.length, 0);
    console.log(`Backup taken ${snapshot.dumpedAt} by ${snapshot.issuer}: ${Object.keys(snapshot.tables).length} tables, ${rows} rows.`);

    let tombstones = null;
    if (!skipErasures) {
      if (!offsite.enabled()) {
        throw new Error('Set the R2_* variables so erasures made since this backup can be re-applied — or pass --no-erasure-check if you are certain there were none.');
      }
      tombstones = await dbbackup.listTombstones();
      console.log(`${tombstones.length} erasure tombstone(s) in the bucket will be applied.`);
    } else {
      console.warn('Skipping the erasure check, as asked. Anyone erased after this backup was taken is back.');
    }

    const result = await dbbackup.restore(snapshot, { tombstones });
    for (const [table, n] of Object.entries(result.counts)) console.log(`  ${table.padEnd(22)} ${n}`);
    console.log('Restored. Point the service at this database and redeploy; everyone will sign in again.');
    await db.pool.end();
  } catch (e) {
    console.error('Restore failed:', e.message);
    try { await db.pool.end(); } catch { /* already closed */ }
    process.exit(1);
  }
})();
