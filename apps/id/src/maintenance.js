// ===================================================================
// Signify ID — scheduled housekeeping
// Retention is a compliance obligation, not a nice-to-have: COPPA's 2025
// amendments require a stated limit and actually honouring it. This is the
// job that does the honouring.
// ===================================================================

const db = require('./db');
const keys = require('./keys');
const audit = require('./audit');
const { config } = require('./config');
const dbbackup = require('./dbbackup');

async function purgeExpiredSessions() {
  const { rowCount } = await db.query(
    `DELETE FROM sessions WHERE expires_at < now() - interval '7 days'`);
  await db.query(`DELETE FROM auth_codes WHERE expires_at < now() - interval '1 day'`);
  await db.query(`DELETE FROM refresh_tokens WHERE expires_at < now() - interval '7 days'`);
  return rowCount;
}

// Hard-erase accounts whose grace period has run out. The audit rows survive,
// with the person's id but not their name — a school still has to be able to
// show that an erasure happened and when.
async function purgeDueUsers() {
  const due = await db.many(
    `SELECT id, email FROM users
      WHERE deleted_at IS NOT NULL AND purge_after IS NOT NULL AND purge_after <= now()
      LIMIT 200`);

  for (const u of due) {
    await db.tx(async (client) => {
      await client.query('UPDATE audit_log SET actor_email = NULL WHERE actor_user_id = $1', [u.id]);
      await client.query('DELETE FROM users WHERE id = $1', [u.id]);
      // Same transaction: an erasure without its tombstone could be undone by
      // restoring yesterday's backup, which the privacy policy rules out.
      await dbbackup.recordErasure(client, u.id);
    });
    await audit.record({
      action: 'record.purged', targetType: 'user', targetId: u.id,
      detail: { note: 'Retention period elapsed; personal data erased.' },
      disclosure: true,
    });
  }
  return due.length;
}

// Accounts nobody has touched for the retention window get queued for erasure
// with a grace period, rather than vanishing without warning.
async function flagDormantAccounts() {
  const { rowCount } = await db.query(
    `UPDATE users u
        SET deleted_at = now(),
            status = 'blocked',
            purge_after = now() + interval '30 days'
      WHERE u.deleted_at IS NULL
        AND u.last_seen_at IS NOT NULL
        AND u.last_seen_at < now() - (COALESCE(
              (SELECT t.retention_days FROM memberships m JOIN tenants t ON t.id = m.tenant_id
                WHERE m.user_id = u.id ORDER BY m.created_at LIMIT 1),
              $1) || ' days')::interval
        AND NOT EXISTS (SELECT 1 FROM platform_admins pa WHERE pa.user_id = u.id)`,
    [config.retentionDays]);
  if (rowCount) {
    await audit.record({
      action: 'retention.dormant_flagged',
      detail: { count: rowCount, note: 'Inactive beyond the retention window; queued for erasure in 30 days.' },
    });
  }
  return rowCount;
}

// The undo snapshot taken before a restore is a full copy of a school's
// roster. It earns its keep for a month; after that it is only a liability.
async function purgeExpiredBackups() {
  const { rowCount } = await db.query(
    'DELETE FROM backups WHERE expires_at IS NOT NULL AND expires_at <= now()');
  if (rowCount) {
    await audit.record({
      action: 'backup.snapshot_expired',
      detail: { count: rowCount, note: 'Pre-restore snapshots past their retention window were deleted.' },
    });
  }
  return rowCount;
}

// What someone said about themselves when asking for an account is only
// needed to decide the request. The privacy policy says those answers are
// cleared 90 days after the decision; this is what makes that sentence true.
async function clearDecidedRequestAnswers() {
  const cleared = await require('./access-survey').clearDecidedAnswers();
  if (cleared) {
    await audit.record({
      action: 'retention.request_answers_cleared',
      detail: { count: cleared, note: 'Answers given when asking for an account, cleared 90 days after the request was decided.' },
    });
  }
  return cleared;
}

// Problem reports: 180 days after closing, or at the retention limit if
// nobody ever closed them. See reports.purgeExpired for why both.
async function purgeExpiredReports() {
  const n = await require('./reports').purgeExpired();
  if (n) {
    await audit.record({
      action: 'retention.reports_purged',
      detail: { count: n, note: 'Problem reports past their retention window were deleted.' },
    });
  }
  return n;
}

async function runOnce() {
  try {
    const [sess, purged, dormant, snapshots, rotated, answers, reportsGone] = await Promise.all([
      purgeExpiredSessions(),
      purgeDueUsers(),
      flagDormantAccounts(),
      purgeExpiredBackups(),
      keys.rotateIfDue(),
      clearDecidedRequestAnswers(),
      purgeExpiredReports(),
    ]);
    if (sess || purged || dormant || snapshots || rotated || answers || reportsGone) {
      console.log(`Maintenance: ${sess} sessions cleared, ${purged} records purged, ${dormant} flagged dormant, ${snapshots} snapshots expired, ${answers} request answers cleared, ${reportsGone} reports expired${rotated ? ', signing key rotated' : ''}.`);
    }
  } catch (e) {
    console.error('Maintenance sweep failed:', e.message);
  }

  // After the purges above, so tonight's backup and tombstones already
  // reflect anybody erased this hour. Each fails on its own and retries next
  // hour; neither may take the sweep down with it.
  try {
    const sent = await dbbackup.sendTombstones();
    if (sent) console.log(`Maintenance: ${sent} erasure tombstone(s) sent to the backup bucket.`);
  } catch (e) {
    console.error('Sending erasure tombstones failed (will retry):', e.message);
  }
  await dbbackup.maybeBackup();
}

function start() {
  // Once at boot (after a short delay so migrations settle), then hourly.
  setTimeout(runOnce, 30_000).unref?.();
  const timer = setInterval(runOnce, 3600_000);
  timer.unref?.();
  return timer;
}

module.exports = { start, runOnce, purgeDueUsers, flagDormantAccounts, purgeExpiredSessions, purgeExpiredBackups, clearDecidedRequestAnswers, purgeExpiredReports };
