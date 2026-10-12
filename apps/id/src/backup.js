// ===================================================================
// Signify ID — backup and restore
//
// A backup here is one school's roster and configuration, not a database
// dump. It deliberately carries no credentials: no sessions, no refresh
// tokens, no signing keys, no client secrets, no platform admins.
//
// Restore is the dangerous half. Left unguarded it is an arbitrary-write
// primitive against the identity store — hand-edit a JSON file, hand it back,
// and grant yourself an administrative role. Four things stop that:
//
//   1. every backup is HMAC-signed, and an unsigned or altered file is
//      refused outright rather than partially applied;
//   2. the file's school and issuer must match where it is being restored;
//   3. role assignment goes through the same guard as the console's role
//      picker, so a restore cannot grant what its operator could not;
//   4. an erasure always wins — a person erased after the backup was taken is
//      never resurrected by restoring it.
//
// Restore is also merge-only. It creates and updates; it never deletes. A
// "make the school look exactly like this file" option would turn a stale
// backup into a mass deletion, so it does not exist.
// ===================================================================

const crypto = require('crypto');
const db = require('./db');
const guards = require('./guards');
const { config } = require('./config');

const FORMAT = 'signify-id-backup/1';
const PRE_RESTORE_KEEP_DAYS = 30;

// One export a day is routine. A run of them is what exfiltration looks like.
const MAX_BACKUPS_PER_DAY = 3;

// A restore older than this is almost never what somebody means to do, so it
// has to be acknowledged explicitly rather than clicked past.
const STALE_WARN_DAYS = 14;
const STALE_ACK_DAYS = 30;

// ---------- signing ----------

// Canonical JSON so key order can never change the signature.
//
// The signature has to survive the round trip the file actually makes:
// signed here, serialised by res.json(), parsed by the browser, sent back,
// parsed again. Two things must therefore match what JSON.stringify does —
// values carrying a toJSON() (Postgres hands back Date objects for every
// timestamp, and a Date has no own enumerable keys, so treating it as a plain
// object would sign "{}" and then verify against its ISO string), and keys
// whose value is undefined, which res.json() drops entirely.
function canonical(value) {
  if (value === undefined || value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (typeof value.toJSON === 'function') return canonical(value.toJSON());
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort()
    .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
    .join(',') + '}';
}

function sign(payload) {
  return crypto.createHmac('sha256', config.cookieSecret).update(canonical(payload)).digest('base64url');
}

function checksum(payload) {
  return crypto.createHash('sha256').update(canonical(payload)).digest('hex');
}

function verify(file) {
  if (!file || typeof file !== 'object') return { ok: false, reason: 'That is not a backup file.' };
  if (file.format !== FORMAT) return { ok: false, reason: 'That file is not a Signify ID backup.' };
  if (!file.signature || !file.payload) return { ok: false, reason: 'That backup is missing its signature.' };

  const expected = sign(file.payload);
  const a = Buffer.from(String(file.signature));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return {
      ok: false,
      reason: 'That backup has been altered since it was created, or it came from a different Signify ID. It has not been restored.',
    };
  }
  if (file.payload.issuer !== config.issuer) {
    return { ok: false, reason: `That backup was taken from ${file.payload.issuer}, not this service.` };
  }
  return { ok: true };
}

// ---------- export ----------

async function collect(tenantId, takenBy) {
  const q = (text, params) => db.many(text, params);

  const [tenant, domains, roles, rolePerms, users, identities, memberships,
         classes, classMembers, guardianLinks, consents, appAccess, disclosures] = await Promise.all([
    db.one('SELECT id, slug, name, status, timezone, year_start_month, minors_default, retention_days, settings FROM tenants WHERE id = $1', [tenantId]),
    q('SELECT domain, auto_role, require_hd FROM tenant_domains WHERE tenant_id = $1', [tenantId]),
    q('SELECT id, key, label, description, is_admin, sort_order FROM roles WHERE tenant_id = $1', [tenantId]),
    q(`SELECT rp.role_id, rp.permission, rp.scope FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id WHERE r.tenant_id = $1`, [tenantId]),
    q(`SELECT u.id, u.email, u.display_name, u.given_name, u.family_name,
              u.status, u.is_minor, u.minor_source, u.created_at
         FROM users u JOIN memberships m ON m.user_id = u.id
        WHERE m.tenant_id = $1 AND u.deleted_at IS NULL`, [tenantId]),
    q(`SELECT i.user_id, i.provider, i.subject, i.email_at_link, i.hosted_domain
         FROM identities i JOIN memberships m ON m.user_id = i.user_id
        WHERE m.tenant_id = $1`, [tenantId]),
    q(`SELECT m.user_id, m.role_id, r.key AS role_key, m.status, m.grade_level,
              m.graduation_year, m.school_year, m.created_at
         FROM memberships m JOIN roles r ON r.id = m.role_id WHERE m.tenant_id = $1`, [tenantId]),
    q('SELECT id, name, subject, grade_levels, school_year, google_course_id, archived FROM classes WHERE tenant_id = $1', [tenantId]),
    q(`SELECT cm.class_id, cm.user_id, cm.role FROM class_members cm
         JOIN classes c ON c.id = cm.class_id WHERE c.tenant_id = $1`, [tenantId]),
    q('SELECT guardian_id, student_id, relationship, verified_at FROM guardian_links WHERE tenant_id = $1', [tenantId]),
    q('SELECT kind, policy_version, signer_name, signer_email, signer_title, method, document, signed_at, revoked_at FROM consents WHERE tenant_id = $1', [tenantId]),
    q('SELECT user_id, app_id, allowed FROM user_app_access WHERE tenant_id = $1', [tenantId]),
    // Included so a school keeps its record of disclosures, but never restored
    // — the audit trail of the live system is the authoritative one.
    q(`SELECT ts, actor_email, action, target_type, target_id, detail
         FROM audit_log WHERE tenant_id = $1 AND is_disclosure ORDER BY ts DESC LIMIT 5000`, [tenantId]),
  ]);

  return {
    format_note: 'Roster and configuration for one school. Contains no credentials, sessions or tokens.',
    issuer: config.issuer,
    taken_at: new Date().toISOString(),
    // Watermark. A roster that turns up somewhere it should not be can be
    // traced to the sign-in that produced it, not merely to the school.
    taken_by: takenBy ? {
      email: takenBy.email,
      user_id: takenBy.userId,
      session_id: takenBy.sessionId || null,
    } : null,
    tenant,
    domains,
    roles,
    role_permissions: rolePerms,
    users,
    identities,
    memberships,
    classes,
    class_members: classMembers,
    guardian_links: guardianLinks,
    consents,
    user_app_access: appAccess,
    // Read-only section. Restore ignores it.
    disclosure_log: disclosures,
  };
}

function countRows(payload) {
  const counts = {};
  for (const [k, v] of Object.entries(payload)) {
    if (Array.isArray(v)) counts[k] = v.length;
  }
  return counts;
}

async function recentBackupCount(tenantId) {
  const row = await db.one(
    `SELECT COUNT(*) AS n FROM backups
      WHERE tenant_id = $1 AND kind = 'manual' AND created_at > now() - interval '24 hours'`,
    [tenantId]);
  return Number(row.n);
}

async function create({ tenantId, actor, kind = 'manual' }) {
  if (kind === 'manual') {
    const recent = await recentBackupCount(tenantId);
    if (recent >= MAX_BACKUPS_PER_DAY) {
      return {
        ok: false,
        error: `${MAX_BACKUPS_PER_DAY} backups have already been taken for this school in the last day. Wait, or ask a super admin if you genuinely need another.`,
      };
    }
  }

  const payload = await collect(tenantId, actor);
  const file = { format: FORMAT, payload, signature: sign(payload) };
  const counts = countRows(payload);

  const row = await db.one(
    `INSERT INTO backups (tenant_id, kind, created_by, checksum, row_counts, payload, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
    [tenantId, kind, actor.userId, checksum(payload), JSON.stringify(counts),
     // Only the automatic pre-restore snapshot is retained; a manual backup
     // leaves with the person who downloaded it.
     kind === 'pre_restore' ? JSON.stringify(file) : null,
     kind === 'pre_restore' ? new Date(Date.now() + PRE_RESTORE_KEEP_DAYS * 864e5) : null]
  );

  return { ok: true, file, id: row.id, createdAt: row.created_at, counts, checksum: checksum(payload) };
}

// ---------- restore ----------

/**
 * Works out what a backup would change. Never writes.
 */
async function preview({ file, actor, tenantId }) {
  const check = verify(file);
  if (!check.ok) return { ok: false, error: check.reason };

  const p = file.payload;
  if (!p.tenant || p.tenant.id !== tenantId) {
    return {
      ok: false,
      error: `That backup is for ${p.tenant ? p.tenant.name : 'another school'}, not the school you are restoring into.`,
    };
  }

  const takenAt = new Date(p.taken_at);
  const ageDays = Math.floor((Date.now() - takenAt.getTime()) / 864e5);
  const roleAllowed = new Map();
  const notes = [];
  const refusals = [];

  const plan = { usersCreate: [], usersUpdate: [], classesCreate: [], classesUpdate: [], memberships: 0, classMembers: 0, appGrants: 0 };

  // Roles first — a membership pointing at a role the operator cannot assign
  // is the main escalation path, so it is resolved before anything else.
  const roleById = new Map();
  for (const r of p.roles || []) roleById.set(r.id, r);

  const membershipByUser = new Map();
  for (const m of p.memberships || []) membershipByUser.set(m.user_id, m);

  for (const u of p.users || []) {
    const m = membershipByUser.get(u.id);
    if (!m) continue;

    // Resolve the role by key against what exists now, not by the id in the
    // file — ids may not survive, keys do.
    const live = await db.one(
      `SELECT id, is_admin FROM roles
        WHERE key = $1 AND (tenant_id = $2 OR tenant_id IS NULL)
        ORDER BY tenant_id NULLS LAST LIMIT 1`, [m.role_key, tenantId]);

    if (!live) { refusals.push(`${u.email}: role "${m.role_key}" no longer exists.`); continue; }

    if (!roleAllowed.has(live.id)) roleAllowed.set(live.id, await guards.canAssignRole(actor, live.id));
    const verdict = roleAllowed.get(live.id);
    if (!verdict.ok) { refusals.push(`${u.email}: ${verdict.reason}`); continue; }

    const existing = await db.one(
      `SELECT id, deleted_at, display_name,
              (SELECT 1 FROM platform_admins pa WHERE pa.user_id = users.id) AS is_platform_admin
         FROM users WHERE email = $1 OR id = $2`, [u.email, u.id]);

    // An erasure always wins. Somebody asked for this record to be removed
    // after the backup was taken; putting it back would undo a rights request.
    if (existing && existing.deleted_at && new Date(existing.deleted_at) > takenAt) {
      refusals.push(`${u.email}: erased after this backup was taken — not restored.`);
      continue;
    }
    if (existing && existing.is_platform_admin) {
      refusals.push(`${u.email}: super admin accounts are never changed by a restore.`);
      continue;
    }
    if (existing && !existing.deleted_at) plan.usersUpdate.push(u.email);
    else if (!existing) plan.usersCreate.push(u.email);
    else { refusals.push(`${u.email}: currently erased — restore it from the People page first if that is intended.`); continue; }

    plan.memberships += 1;
  }

  for (const c of p.classes || []) {
    const existing = await db.one('SELECT id FROM classes WHERE tenant_id = $1 AND lower(name) = lower($2)', [tenantId, c.name]);
    if (existing) plan.classesUpdate.push(c.name); else plan.classesCreate.push(c.name);
  }

  plan.classMembers = (p.class_members || []).length;
  plan.appGrants = (p.user_app_access || []).length;

  if ((p.disclosure_log || []).length) {
    const n = p.disclosure_log.length;
    notes.push(`The file also carries ${n} disclosure record${n === 1 ? '' : 's'} for your reference. ${n === 1 ? 'It is' : 'Those are'} not restored — the live audit trail stays authoritative.`);
  }
  notes.push('Restore only creates and updates. Nobody is removed, and no class is deleted, even if this backup predates them.');

  return {
    ok: true,
    takenAt: p.taken_at,
    takenBy: p.taken_by || null,
    ageDays,
    stale: ageDays >= STALE_WARN_DAYS,
    needsStaleAcknowledgement: ageDays >= STALE_ACK_DAYS,
    tenantName: p.tenant.name,
    counts: countRows(p),
    plan,
    refusals,
    notes,
  };
}

/**
 * Applies a verified backup, after snapshotting the current state.
 */
async function restore({ file, actor, tenantId, confirmName = '', acknowledgeStale = false }) {
  const pre = await preview({ file, actor, tenantId });
  if (!pre.ok) return pre;

  // Deliberate friction on the one operation that can silently revert good
  // work. Enforced here rather than only in the browser, because a check that
  // lives in the console is not a check.
  const typed = String(confirmName || '').trim().toLowerCase();
  if (typed !== String(pre.tenantName).trim().toLowerCase()) {
    return {
      ok: false,
      error: `To confirm, the school's name has to be typed exactly: "${pre.tenantName}".`,
    };
  }

  if (pre.needsStaleAcknowledgement && !acknowledgeStale) {
    return {
      ok: false,
      error: `That backup is ${pre.ageDays} days old. Anything done since would be overwritten with what it contains. Confirm that you mean to, or take a fresh one.`,
      code: 'stale_backup',
      ageDays: pre.ageDays,
    };
  }

  // The undo. Taken before anything is touched, and never rate-limited.
  const snapshot = await create({ tenantId, actor, kind: 'pre_restore' });
  if (!snapshot.ok) return { ok: false, error: 'Could not take a safety snapshot, so nothing was restored.' };

  const p = file.payload;
  const takenAt = new Date(p.taken_at);
  const userIdMap = new Map();

  const applied = await db.tx(async (client) => {
    let usersCreated = 0;
    let usersUpdated = 0;
    let classesCreated = 0;

    const membershipByUser = new Map();
    for (const m of p.memberships || []) membershipByUser.set(m.user_id, m);

    for (const u of p.users || []) {
      const m = membershipByUser.get(u.id);
      if (!m) continue;

      const roleRow = await client.query(
        `SELECT id FROM roles WHERE key = $1 AND (tenant_id = $2 OR tenant_id IS NULL)
          ORDER BY tenant_id NULLS LAST LIMIT 1`, [m.role_key, tenantId]);
      if (!roleRow.rows.length) continue;
      const roleId = roleRow.rows[0].id;
      if (!(await guards.canAssignRole(actor, roleId)).ok) continue;

      const found = await client.query(
        `SELECT id, deleted_at, (SELECT 1 FROM platform_admins pa WHERE pa.user_id = users.id) AS is_platform_admin
           FROM users WHERE email = $1 OR id = $2`, [u.email, u.id]);
      const existing = found.rows[0];

      if (existing && existing.is_platform_admin) continue;
      if (existing && existing.deleted_at) continue; // erased; never resurrected here

      let userId;
      if (existing) {
        await client.query(
          `UPDATE users SET display_name = $2, given_name = $3, family_name = $4,
                            is_minor = $5, minor_source = $6 WHERE id = $1`,
          [existing.id, u.display_name, u.given_name, u.family_name, u.is_minor, u.minor_source]);
        userId = existing.id;
        usersUpdated += 1;
      } else {
        const created = await client.query(
          `INSERT INTO users (id, email, display_name, given_name, family_name, status, is_minor, minor_source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (id) DO NOTHING RETURNING id`,
          [u.id, u.email, u.display_name, u.given_name, u.family_name, u.status, u.is_minor, u.minor_source]);
        userId = created.rows.length ? created.rows[0].id : u.id;
        usersCreated += 1;
      }
      userIdMap.set(u.id, userId);

      await client.query(
        `INSERT INTO memberships (user_id, tenant_id, role_id, status, grade_level, graduation_year, school_year, added_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (user_id, tenant_id) DO UPDATE SET
           role_id = EXCLUDED.role_id, status = EXCLUDED.status,
           grade_level = EXCLUDED.grade_level, graduation_year = EXCLUDED.graduation_year,
           school_year = EXCLUDED.school_year, updated_at = now()`,
        [userId, tenantId, roleId, m.status, m.grade_level, m.graduation_year, m.school_year, actor.userId]);
    }

    // Identities: restoring the provider subject keeps a rebuilt account
    // linked to the same real person rather than waiting to be claimed.
    for (const i of p.identities || []) {
      const userId = userIdMap.get(i.user_id);
      if (!userId) continue;
      await client.query(
        `INSERT INTO identities (user_id, provider, subject, email_at_link, hosted_domain)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (provider, subject) DO NOTHING`,
        [userId, i.provider, i.subject, i.email_at_link, i.hosted_domain]);
    }

    const classIdMap = new Map();
    for (const c of p.classes || []) {
      const existing = await client.query(
        'SELECT id FROM classes WHERE tenant_id = $1 AND lower(name) = lower($2)', [tenantId, c.name]);
      if (existing.rows.length) {
        await client.query(
          'UPDATE classes SET subject = $2, grade_levels = $3, school_year = $4 WHERE id = $1',
          [existing.rows[0].id, c.subject, c.grade_levels || [], c.school_year]);
        classIdMap.set(c.id, existing.rows[0].id);
      } else {
        const created = await client.query(
          `INSERT INTO classes (id, tenant_id, name, subject, grade_levels, school_year, google_course_id, archived, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING RETURNING id`,
          [c.id, tenantId, c.name, c.subject, c.grade_levels || [], c.school_year, c.google_course_id, c.archived, actor.userId]);
        classIdMap.set(c.id, created.rows.length ? created.rows[0].id : c.id);
        classesCreated += 1;
      }
    }

    for (const cm of p.class_members || []) {
      const classId = classIdMap.get(cm.class_id);
      const userId = userIdMap.get(cm.user_id);
      if (!classId || !userId) continue;
      await client.query(
        `INSERT INTO class_members (class_id, user_id, role) VALUES ($1,$2,$3)
         ON CONFLICT (class_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [classId, userId, cm.role]);
    }

    for (const a of p.user_app_access || []) {
      const userId = userIdMap.get(a.user_id);
      if (!userId) continue;
      await client.query(
        `INSERT INTO user_app_access (user_id, app_id, tenant_id, allowed, set_by)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id, app_id) DO UPDATE SET allowed = EXCLUDED.allowed`,
        [userId, a.app_id, tenantId, a.allowed, actor.userId]);
    }

    return { usersCreated, usersUpdated, classesCreated };
  });

  return {
    ok: true,
    ...applied,
    refusals: pre.refusals,
    snapshotId: snapshot.id,
    snapshotExpiresDays: PRE_RESTORE_KEEP_DAYS,
  };
}

module.exports = {
  create, preview, restore, verify, sign, checksum, canonical, collect,
  recentBackupCount,
  FORMAT, PRE_RESTORE_KEEP_DAYS, MAX_BACKUPS_PER_DAY, STALE_WARN_DAYS, STALE_ACK_DAYS,
};
