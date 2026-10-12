// ===================================================================
// Signify ID — import a roster from the command line
//
//   railway ssh --service signify-id "node src/import-roster.js --school 'Richmond Academy' --file /tmp/r.csv"
//   cat r.csv | railway ssh --service signify-id "node src/import-roster.js --school 'Richmond Academy' --stdin"
//
// The console does this too, behind a session. This exists for the migration
// case, where the roster is being lifted out of another app by a script and
// there is nobody sitting at a browser.
//
// Runs as a platform admin, so it can assign administrative roles — which the
// console deliberately will not let a school-level admin do.
// ===================================================================

const fs = require('fs');
const db = require('./db');
const roster = require('./roster');
const audit = require('./audit');

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

(async () => {
  const schoolName = arg('school');
  const file = arg('file');
  const asEmail = arg('as');
  const dryRun = process.argv.includes('--dry-run');

  if (!schoolName || (!file && !process.argv.includes('--stdin'))) {
    console.error('Usage: node src/import-roster.js --school "School Name" (--file path.csv | --stdin) [--as admin@example] [--dry-run]');
    process.exit(1);
  }

  const tenant = await db.one(
    'SELECT id, name FROM tenants WHERE lower(name) = lower($1) OR slug = lower($1)', [schoolName]);
  if (!tenant) { console.error(`No school called "${schoolName}".`); process.exit(1); }

  // Attribute the run to a real platform admin so the audit trail names a
  // person rather than "the server".
  const admin = asEmail
    ? await db.one(`SELECT u.id, u.email FROM users u JOIN platform_admins p ON p.user_id = u.id WHERE u.email = $1`, [asEmail.toLowerCase()])
    : await db.one(`SELECT u.id, u.email FROM users u JOIN platform_admins p ON p.user_id = u.id ORDER BY p.created_at LIMIT 1`);
  if (!admin) { console.error('No platform admin to attribute this to. Sign in once first.'); process.exit(1); }

  const text = file ? fs.readFileSync(file, 'utf8') : await readStdin();
  const actor = { userId: admin.id, email: admin.email, isSuper: true, tenantId: tenant.id, perms: {} };

  const analysis = await roster.analyse({ text, actor, tenantId: tenant.id });
  if (!analysis.ok) { console.error(analysis.error); process.exit(1); }

  console.log(`Into ${tenant.name}, as ${admin.email}`);
  console.log(`  ${analysis.summary.create} to add, ${analysis.summary.update} to update, ${analysis.summary.error} to skip`);
  for (const row of analysis.rows) {
    if (row.action === 'error') console.log(`  line ${row.line}: SKIP ${row.email} — ${row.problems.join(' ')}`);
  }

  if (dryRun) { console.log('\nDry run — nothing was written.'); await db.pool.end(); return; }

  const result = await roster.apply({ text, actor, tenantId: tenant.id, filename: file || 'stdin' });
  if (!result.ok) { console.error(result.error); process.exit(1); }

  await audit.record({
    actorUserId: admin.id, actorEmail: admin.email, tenantId: tenant.id,
    action: 'roster.imported', targetType: 'tenant', targetId: tenant.id,
    detail: { created: result.created, updated: result.updated, skipped: result.skipped, via: 'cli' },
    disclosure: true,
  });

  console.log(`\nDone: ${result.created} added, ${result.updated} updated, ${result.skipped} skipped.`);
  console.log("Reversible for 30 days: console -> Backups -> Roster imports -> Undo.");
  await db.pool.end();
})().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
