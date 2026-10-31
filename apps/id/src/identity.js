// ===================================================================
// Signify ID — turning a verified external login into a person
//
// The rule that shapes this file: a person is their provider subject, not
// their email address. Schools recycle addresses, and a directory that treats
// jsmith@ as an identity will eventually hand a new pupil the previous
// pupil's work. Every branch below exists to prevent that.
// ===================================================================

const db = require('./db');
const rbac = require('./rbac');
const audit = require('./audit');
const { config } = require('./config');

const lower = (s) => String(s || '').trim().toLowerCase();
const domainOf = (email) => lower(email).split('@')[1] || '';

// ---------- tenant resolution ----------

// Which school does this sign-in belong to? Matched on the email domain, and
// (by default) confirmed against Google's `hd` claim so a personal account
// that merely looks like a school address cannot walk in.
async function tenantForLogin({ email, hostedDomain }) {
  const domain = domainOf(email);
  if (!domain) return null;

  const row = await db.one(
    `SELECT td.domain, td.tenant_id, td.auto_role, td.require_hd,
            t.name AS tenant_name, t.status AS tenant_status, t.minors_default
       FROM tenant_domains td
       JOIN tenants t ON t.id = td.tenant_id
      WHERE td.domain = $1`,
    [domain]
  );
  if (!row) return null;
  if (row.require_hd && lower(hostedDomain) !== domain) {
    return { ...row, hdMismatch: true };
  }
  return row;
}

// ---------- the main resolution ----------

/**
 * Given a verified provider profile, return the user it belongs to, creating
 * or linking as appropriate.
 *
 * Returns { ok: true, user, linked } or { ok: false, code, message }.
 */
async function resolveUser({ provider, subject, email, name, givenName, familyName, picture, hostedDomain }, ctx = {}) {
  const emailKey = lower(email);
  if (!subject) return { ok: false, code: 'no_subject', message: 'That sign-in did not identify an account.' };
  if (!emailKey) return { ok: false, code: 'no_email', message: 'That sign-in did not include an email address.' };

  return db.tx(async (client) => {
    // 1. The normal path: we have seen this exact provider subject before.
    const known = await client.query(
      `SELECT u.*, i.id AS identity_id
         FROM identities i
         JOIN users u ON u.id = i.user_id
        WHERE i.provider = $1 AND i.subject = $2`,
      [provider, subject]
    );

    if (known.rows.length) {
      const user = known.rows[0];
      if (user.deleted_at) {
        return { ok: false, code: 'deleted', message: 'That account has been removed. Ask an administrator to restore it.' };
      }
      // A practice person is never anybody's login (migration 015).
      if (user.is_mock) return { ok: false, code: 'mock', message: 'That is a practice account. Nobody can sign in to it.' };

      // The address on the account can legitimately change — a legal name
      // change, or a school moving domains. Follow it, unless the new address
      // is already spoken for by somebody else.
      if (user.email !== emailKey) {
        const clash = await client.query(
          'SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL AND id <> $2',
          [emailKey, user.id]
        );
        if (clash.rows.length) {
          return {
            ok: false,
            code: 'email_conflict',
            message: 'That email address is already attached to a different account. An administrator needs to sort this out before you can sign in.',
            detail: { existingUserId: clash.rows[0].id, incomingSubject: subject },
          };
        }
      }

      const updated = await client.query(
        `UPDATE users
            SET email = $2,
                -- Google's name is followed only until the school or the
                -- person has chosen one (src/names.js).
                display_name = CASE WHEN display_name_source = 'google'
                                    THEN COALESCE(NULLIF($3, ''), display_name) ELSE display_name END,
                given_name = COALESCE(NULLIF($4, ''), given_name),
                family_name = COALESCE(NULLIF($5, ''), family_name),
                picture_url = COALESCE(NULLIF($6, ''), picture_url),
                last_seen_at = now()
          WHERE id = $1
        RETURNING *`,
        [user.id, emailKey, name || '', givenName || '', familyName || '', picture || '']
      );
      await client.query(
        'UPDATE identities SET last_login_at = now(), email_at_link = $2, hosted_domain = $3 WHERE id = $1',
        [user.identity_id, emailKey, lower(hostedDomain) || null]
      );
      return { ok: true, user: updated.rows[0], linked: false, created: false };
    }

    // 2. An unrecognised subject. Is there already an account on this address?
    const byEmail = await client.query(
      'SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL',
      [emailKey]
    );

    if (byEmail.rows.length) {
      const existing = byEmail.rows[0];
      if (existing.is_mock) return { ok: false, code: 'mock', message: 'That is a practice account. Nobody can sign in to it.' };
      const others = await client.query(
        'SELECT provider, subject FROM identities WHERE user_id = $1 AND provider = $2',
        [existing.id, provider]
      );

      // 2a. The account already has a DIFFERENT subject for this provider.
      // This is the recycled-address case: same email, different human. Refuse.
      // Handing the new person the old record would be a records breach, and
      // guessing which it is would be worse than stopping.
      if (others.rows.length) {
        await audit.record({
          actorEmail: emailKey,
          action: 'identity.subject_conflict',
          targetType: 'user',
          targetId: existing.id,
          detail: { incomingSubject: subject, existingSubject: others.rows[0].subject, provider },
          ip: ctx.ip || null,
        });
        return {
          ok: false,
          code: 'subject_conflict',
          message: 'This email address belongs to an account that was set up by a different person. For safety we have not signed you in — please ask an administrator to release the address.',
        };
      }

      // 2b. No identity yet: the account was pre-created by an administrator
      // (or imported), and this is its first real sign-in. Claim it. Safe
      // because the provider has verified ownership of the address.
      await client.query(
        `INSERT INTO identities (user_id, provider, subject, email_at_link, hosted_domain, last_login_at)
         VALUES ($1,$2,$3,$4,$5, now())`,
        [existing.id, provider, subject, emailKey, lower(hostedDomain) || null]
      );
      const updated = await client.query(
        `UPDATE users
            SET display_name = CASE WHEN display_name_source = 'google'
                                    THEN COALESCE(NULLIF($2, ''), display_name) ELSE display_name END,
                given_name = COALESCE(NULLIF($3, ''), given_name),
                family_name = COALESCE(NULLIF($4, ''), family_name),
                picture_url = COALESCE(NULLIF($5, ''), picture_url),
                last_seen_at = now()
          WHERE id = $1 RETURNING *`,
        [existing.id, name || '', givenName || '', familyName || '', picture || '']
      );
      return { ok: true, user: updated.rows[0], linked: true, created: false };
    }

    // 3. Brand new person.
    const tenant = await tenantForLogin({ email: emailKey, hostedDomain });
    const isSuper = config.superAdmins.includes(emailKey);
    // Minor status is asserted by the school, never asked of the child. Staff
    // roles and platform admins are adults by definition.
    const isMinor = isSuper ? false : (tenant && !tenant.hdMismatch ? tenant.minors_default : true);

    const created = await client.query(
      `INSERT INTO users (email, display_name, given_name, family_name, picture_url,
                          status, is_minor, minor_source, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,'active',$6,$7, now())
       RETURNING *`,
      [emailKey, name || emailKey.split('@')[0], givenName || null, familyName || null,
       picture || null, isMinor, isSuper ? 'admin_set' : 'tenant_default']
    );
    const user = created.rows[0];

    await client.query(
      `INSERT INTO identities (user_id, provider, subject, email_at_link, hosted_domain, last_login_at)
       VALUES ($1,$2,$3,$4,$5, now())`,
      [user.id, provider, subject, emailKey, lower(hostedDomain) || null]
    );

    return { ok: true, user, created: true, linked: false, tenant };
  });
}

// ---------- membership ----------

// Attaches a newly created user to their school. A domain may auto-assign a
// role; without one the membership is pending and an administrator decides.
async function ensureMembership(userId, email, hostedDomain) {
  const existing = await db.one(
    `SELECT m.*, t.name AS tenant_name, t.status AS tenant_status, r.key AS role_key
       FROM memberships m
       JOIN tenants t ON t.id = m.tenant_id
       JOIN roles r ON r.id = m.role_id
      WHERE m.user_id = $1
      ORDER BY m.created_at ASC
      LIMIT 1`,
    [userId]
  );
  if (existing) return existing;

  const tenant = await tenantForLogin({ email, hostedDomain });
  if (!tenant || tenant.hdMismatch) return null;

  // Fall back to the least-privileged role if the domain names one that no
  // longer exists. Failing open to "teacher" here would be a real hole.
  const roleKey = tenant.auto_role || 'student';
  const role = await db.one(
    `SELECT id FROM roles
      WHERE key = $1 AND (tenant_id = $2 OR tenant_id IS NULL)
      ORDER BY tenant_id NULLS LAST LIMIT 1`,
    [roleKey, tenant.tenant_id]
  ) || await db.one("SELECT id FROM roles WHERE key = 'student' AND tenant_id IS NULL");

  const status = tenant.auto_role ? 'active' : 'pending';

  const row = await db.one(
    `INSERT INTO memberships (user_id, tenant_id, role_id, status)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, tenant_id) DO UPDATE SET updated_at = now()
     RETURNING *`,
    [userId, tenant.tenant_id, role.id, status]
  );

  await audit.record({
    actorUserId: userId, actorEmail: email, tenantId: tenant.tenant_id,
    action: 'membership.auto_created',
    targetType: 'membership', targetId: row.id,
    detail: { role: roleKey, status, domain: tenant.domain },
  });

  return db.one(
    `SELECT m.*, t.name AS tenant_name, t.status AS tenant_status, r.key AS role_key
       FROM memberships m JOIN tenants t ON t.id = m.tenant_id JOIN roles r ON r.id = m.role_id
      WHERE m.id = $1`,
    [row.id]
  );
}

// ---------- effective access ----------

async function isPlatformAdmin(userId) {
  const row = await db.one('SELECT 1 FROM platform_admins WHERE user_id = $1', [userId]);
  return !!row;
}

/**
 * The complete access picture for one person in one school: their role, their
 * collapsed permission map, and whether they may sign in at all.
 */
async function accessFor(userId, tenantId = null) {
  const user = await db.one('SELECT * FROM users WHERE id = $1', [userId]);
  if (!user) return null;

  const isSuper = await isPlatformAdmin(userId);

  const memberships = await db.many(
    `SELECT m.id, m.tenant_id, m.status, m.grade_level, m.suspend_until,
            r.id AS role_id, r.key AS role_key, r.label AS role_label, r.is_admin,
            t.name AS tenant_name, t.slug AS tenant_slug, t.status AS tenant_status,
            t.kind AS tenant_kind
       FROM memberships m
       JOIN roles r ON r.id = m.role_id
       JOIN tenants t ON t.id = m.tenant_id
      WHERE m.user_id = $1
      ORDER BY m.created_at ASC`,
    [userId]
  );

  // A timed suspension lifts itself rather than needing an administrator to
  // remember to undo it.
  for (const m of memberships) {
    if (m.status === 'suspended' && m.suspend_until && new Date(m.suspend_until) <= new Date()) {
      await db.query("UPDATE memberships SET status = 'active', suspend_until = NULL, updated_at = now() WHERE id = $1", [m.id]);
      m.status = 'active';
      m.suspend_until = null;
    }
  }

  const active = tenantId
    ? memberships.find((m) => m.tenant_id === tenantId)
    : memberships.find((m) => m.status === 'active') || memberships[0] || null;

  let perms = {};
  if (isSuper) {
    perms = rbac.collapse(rbac.superAdminGrants());
  } else if (active && active.status === 'active' && active.tenant_status === 'active') {
    const grants = await db.many(
      'SELECT permission, scope FROM role_permissions WHERE role_id = $1',
      [active.role_id]
    );
    perms = rbac.collapse(grants);
    // Independent members are strangers to each other: whatever the role says,
    // nothing reaches past the person themselves. A teacher's 'tenant' reach
    // would otherwise be a directory of everyone else with no school.
    if (active.tenant_kind === 'independent') perms = rbac.capScope(perms, 'own');
  }

  // A substitute holds their role every day but may use it only on the days
  // they are covering. Worked out here so loginBlock can stay a plain reading
  // of this object.
  let coverage = null;
  if (!isSuper && active && active.role_key === 'substitute') {
    coverage = await require('./coverage').forSubstitute(userId, active.tenant_id);
  }

  return {
    user: {
      id: user.id, email: user.email, name: user.display_name,
      picture: user.picture_url, status: user.status, isMinor: user.is_minor,
      // The school's official name where it has one, else what Google says.
      givenName: user.official_family_name ? user.official_given_name : user.given_name,
      familyName: user.official_family_name || user.family_name,
      middleName: user.official_family_name ? user.official_middle_name : null,
      officialName: !!user.official_family_name,
    },
    isSuper,
    membership: active,
    memberships,
    perms,
    coverage,
  };
}

// Is this person allowed through the door right now, and if not, why?
function loginBlock(access) {
  if (!access) return { code: 'unknown', message: 'That account could not be found.' };
  if (access.isSuper) return null;

  const u = access.user;
  if (u.status === 'blocked') return { code: 'blocked', message: 'Your access has been turned off by an administrator.' };
  if (u.status === 'suspended') return { code: 'suspended', message: 'Your account is suspended. Please speak to your teacher or administrator.' };

  const m = access.membership;
  if (!m) {
    return {
      code: 'no_tenant',
      message: 'Your account is not attached to a school yet. Ask your administrator to add you.',
    };
  }
  if (m.tenant_status !== 'active') return { code: 'tenant_inactive', message: 'Your school’s access is not currently active.' };
  if (m.status === 'pending') return { code: 'pending', message: 'Your account is waiting for an administrator to approve it.' };
  if (m.status === 'blocked') return { code: 'blocked', message: 'Your access has been turned off by an administrator.' };
  if (m.status === 'suspended') {
    const until = m.suspend_until ? ` until ${new Date(m.suspend_until).toLocaleString()}` : '';
    return { code: 'suspended', message: `Your account is suspended${until}.` };
  }
  // The account stays open all year; the door opens only on covered days.
  if (m.role_key === 'substitute' && !(access.coverage && access.coverage.covering)) {
    return {
      code: 'no_coverage',
      message: access.coverage && access.coverage.nextLabel
        ? `You are not covering any classes today. Your next cover starts on ${access.coverage.nextLabel}.`
        : 'You are not covering any classes today. Your school will let you know when they need you.',
    };
  }
  return null;
}

module.exports = {
  lower, domainOf, tenantForLogin, resolveUser, ensureMembership,
  accessFor, isPlatformAdmin, loginBlock,
};
