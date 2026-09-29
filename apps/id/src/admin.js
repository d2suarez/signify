// ===================================================================
// Signify ID — admin API
// Everything the console does. Each handler names the permission it needs and
// the reach it needs it at; the guards module answers "may they".
// ===================================================================

const express = require('express');
const db = require('./db');
const rbac = require('./rbac');
const audit = require('./audit');
const secrets = require('./secrets');
const csv = require('./csv');
const roster = require('./roster');
const backup = require('./backup');
const seed = require('./seed');
const catalog = require('./catalog');
const merge = require('./merge');
const sessions = require('./sessions');
const identity = require('./identity');
const guards = require('./guards');
const directory = require('./directory');
const reports = require('./reports');
const survey = require('./access-survey');
const appAdmin = require('./app-admin');
const { config } = require('./config');

const router = express.Router();

const fail = (res, code, msg) => res.status(code).json({ error: msg });
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

// A class may span several year groups — mixed-age and split classes are
// normal. Values are free text so a school can use its own nomenclature, but
// they are de-duplicated and capped so the column stays sane.
function cleanYearGroups(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[;,]/);
  const out = [];
  for (const v of list) {
    const t = String(v).trim().slice(0, 24);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= 12) break;
  }
  return out;
}

// The year groups a school offers in its class editor.
function yearGroupsFor(tenant) {
  const custom = tenant && tenant.settings && Array.isArray(tenant.settings.yearGroups)
    ? tenant.settings.yearGroups.filter((v) => typeof v === 'string' && v.trim()).slice(0, 40)
    : null;
  return custom && custom.length ? custom : rbac.DEFAULT_YEAR_GROUPS;
}

// Every mutating call carries the double-submit CSRF token.
router.use((req, res, next) => {
  if (!sessions.checkCsrf(req)) return fail(res, 403, 'Your page is out of date. Reload and try again.');
  next();
});

// ---------- bootstrap ----------

router.get('/bootstrap', async (req, res) => {
  const actor = guards.requireActor(req, res);
  if (!actor) return;

  const tenants = actor.isSuper
    ? await db.many('SELECT id, slug, name, status FROM tenants ORDER BY name')
    : await db.many('SELECT id, slug, name, status FROM tenants WHERE id = $1', [actor.tenantId]);

  const tenantRow = actor.tenantId
    ? await db.one('SELECT settings FROM tenants WHERE id = $1', [actor.tenantId])
    : null;

  const liveCatalog = await catalog.full();

  res.json({
    yearGroups: yearGroupsFor(tenantRow),
    actor: {
      name: actor.name, email: actor.email, picture: actor.picture,
      role: actor.role, roleLabel: actor.roleLabel, isSuper: actor.isSuper,
      tenantId: actor.tenantId, tenantName: actor.tenantName,
      perms: actor.perms,
    },
    catalog: liveCatalog,
    scopes: rbac.SCOPES,
    tenants,
    policyVersion: config.policyVersion,
    retentionDays: config.retentionDays,
    // For a super admin: requests that arrived, or were answered, since they
    // last opened the Requests page. The console turns this into a notice.
    newRequests: actor.isSuper ? await survey.newRequestsFor(actor.userId) : null,
    // Apps whose own admin tools this person can run from the console.
    appAdmin: await appAdmin.listFor(actor),
  });
});

// ---------- overview ----------

router.get('/overview', async (req, res) => {
  const actor = guards.requireActor(req, res);
  if (!actor) return;
  const tenantId = guards.tenantScope(actor, req.query.tenant_id);
  const p = tenantId ? [tenantId] : [];
  const w = tenantId ? 'WHERE m.tenant_id = $1' : '';

  const counts = await db.one(
    `SELECT
       COUNT(*) FILTER (WHERE m.status = 'active')  AS active,
       COUNT(*) FILTER (WHERE m.status = 'pending') AS pending,
       COUNT(*) FILTER (WHERE m.status IN ('blocked','suspended')) AS restricted,
       COUNT(*) FILTER (WHERE r.key = 'student' AND m.status = 'active') AS students,
       COUNT(*) FILTER (WHERE r.key <> 'student' AND m.status = 'active') AS staff
     FROM memberships m JOIN roles r ON r.id = m.role_id ${w}`, p);

  const classes = await db.one(
    `SELECT COUNT(*) AS n FROM classes ${tenantId ? 'WHERE tenant_id = $1 AND' : 'WHERE'} archived = false`, p);

  const recent = await audit.list({ tenantId, limit: 12 });

  // Operations that move a whole school's records at once. An audit log
  // nobody opens is not a control; surfacing these where administrators
  // actually look is what turns the record into oversight.
  const SENSITIVE = [
    'backup.downloaded', 'backup.snapshot_downloaded', 'backup.rate_limited',
    'restore.applied', 'restore.rejected',
    'roster.imported', 'roster.import_undone',
    'record.exported', 'record.erase_requested', 'record.purged',
    'platform_admin.granted', 'platform_admin.revoked',
    'user.bulk_block',
  ];
  const sensitive = await db.many(
    `SELECT id, ts, actor_email, action, detail
       FROM audit_log
      WHERE action = ANY($1)
        AND ts > now() - interval '7 days'
        AND ($2::uuid IS NULL OR tenant_id = $2)
      ORDER BY ts DESC LIMIT 10`,
    [SENSITIVE, tenantId || null]);

  // Things a school ought to notice, computed rather than hard-coded, so the
  // console nags about real gaps instead of a static checklist.
  const alerts = [];
  if (actor.isSuper) {
    const open = await db.one("SELECT COUNT(*) AS n FROM access_requests WHERE status = 'pending'");
    if (Number(open.n) > 0) {
      alerts.push({
        level: 'warn',
        text: `${open.n} ${Number(open.n) === 1 ? 'person has' : 'people have'} asked for an account and are waiting on a decision.`,
        go: 'requests',
      });
    }
  }

  const pending = Number(counts.pending);
  if (pending > 0) {
    alerts.push({ level: 'warn', text: `${pending} account${pending === 1 ? '' : 's'} waiting for approval.`, go: 'users' });
  }
  // The privacy policy states a minimum age. A school configured as having
  // younger pupils contradicts it — and that contradiction decides whether
  // children's privacy law applies at all, so it is not a detail.
  const policy = require('./policy');
  if (policy.POSTURE === 'school-staff') {
    const youngSchools = await db.many(
      `SELECT id, name FROM tenants
        WHERE status = 'active' AND minors_default
          AND ($1::uuid IS NULL OR id = $1)`, [tenantId || null]);
    for (const t of youngSchools) {
      alerts.push({
        level: 'danger',
        text: `${t.name} is set as having students under 13, but the privacy policy says accounts are for ${policy.MINIMUM_AGE} and over. Either change the school's setting or the policy — as written they disagree, and that decides whether COPPA applies.`,
        go: 'tenants',
      });
    }
  }

  if (actor.isSuper) {
    const supers = await db.one('SELECT COUNT(*) AS n FROM platform_admins');
    if (Number(supers.n) < 2) {
      alerts.push({ level: 'danger', text: 'Only one super admin exists. Add a second so a lost account cannot lock you out of every app.', go: 'platform' });
    }
    const noConsent = await db.many(
      `SELECT t.id, t.name FROM tenants t
        WHERE t.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM consents c
                           WHERE c.tenant_id = t.id AND c.kind = 'school_authorization' AND c.revoked_at IS NULL)`);
    for (const t of noConsent) {
      alerts.push({ level: 'danger', text: `${t.name} has no recorded school authorization. Under COPPA the school-consent exception needs that record on file.`, go: 'compliance' });
    }
  }

  res.json({ counts, classes: Number(classes.n), recent, alerts, sensitive });
});

// ---------- users ----------

router.get('/users', async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:view_directory', 'tenant');
  if (!actor) return;
  const tenantId = guards.tenantScope(actor, req.query.tenant_id);

  const where = ['u.deleted_at IS NULL'];
  const params = [];
  if (tenantId) { params.push(tenantId); where.push(`m.tenant_id = $${params.length}`); }
  if (req.query.status) { params.push(String(req.query.status)); where.push(`m.status = $${params.length}`); }
  if (req.query.role) { params.push(String(req.query.role)); where.push(`r.key = $${params.length}`); }
  if (req.query.q) {
    params.push('%' + String(req.query.q).toLowerCase() + '%');
    where.push(`(lower(u.display_name) LIKE $${params.length} OR u.email LIKE $${params.length})`);
  }
  params.push(Math.min(Number(req.query.limit) || 200, 500));

  const rows = await db.many(
    `SELECT u.id, u.email, u.display_name, u.picture_url, u.status AS user_status,
            u.is_minor, u.created_at, u.last_seen_at,
            m.id AS membership_id, m.status, m.grade_level, m.graduation_year,
            m.suspend_until, m.tenant_id,
            r.id AS role_id, r.key AS role_key, r.label AS role_label, r.is_admin,
            t.name AS tenant_name,
            (SELECT 1 FROM platform_admins pa WHERE pa.user_id = u.id) AS is_super,
            (SELECT COUNT(*) FROM identities i WHERE i.user_id = u.id) AS identity_count
       FROM users u
       LEFT JOIN memberships m ON m.user_id = u.id
       LEFT JOIN roles r ON r.id = m.role_id
       LEFT JOIN tenants t ON t.id = m.tenant_id
      WHERE ${where.join(' AND ')}
      ORDER BY (m.status = 'pending') DESC, u.display_name
      LIMIT $${params.length}`,
    params
  );
  res.json({ users: rows });
});

// Pre-create an account so a roster can be loaded before anyone signs in. The
// person is linked to their real Google identity on first sign-in.
router.post('/users', async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:manage_users', 'tenant');
  if (!actor) return;
  const body = req.body || {};
  const email = identity.lower(body.email);
  const tenantId = guards.tenantScope(actor, body.tenant_id) || actor.tenantId;

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(res, 400, 'Enter a valid email address.');
  if (!tenantId) return fail(res, 400, 'Choose which school this account belongs to.');

  const roleId = body.role_id;
  const check = await guards.canAssignRole(actor, roleId);
  if (!check.ok) return fail(res, 403, check.reason);

  const existing = await db.one('SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL', [email]);
  if (existing) {
    const has = await db.one('SELECT 1 FROM memberships WHERE user_id = $1 AND tenant_id = $2', [existing.id, tenantId]);
    if (has) return fail(res, 409, 'That person already has an account here.');
  }

  const tenant = await db.one('SELECT minors_default FROM tenants WHERE id = $1', [tenantId]);

  const result = await db.tx(async (client) => {
    let userId = existing ? existing.id : null;
    if (!userId) {
      const created = await client.query(
        `INSERT INTO users (email, display_name, status, is_minor, minor_source)
         VALUES ($1,$2,'active',$3,'tenant_default') RETURNING id`,
        [email, String(body.name || email.split('@')[0]).slice(0, 120),
         check.role.key === 'student' ? tenant.minors_default : false]
      );
      userId = created.rows[0].id;
    }
    const m = await client.query(
      `INSERT INTO memberships (user_id, tenant_id, role_id, status, grade_level, added_by)
       VALUES ($1,$2,$3,'active',$4,$5) RETURNING id`,
      [userId, tenantId, roleId, body.grade_level || null, actor.userId]
    );
    return { userId, membershipId: m.rows[0].id };
  });

  await audit.from(req, {
    tenantId, action: 'user.created', targetType: 'user', targetId: result.userId,
    detail: { email, role: check.role.key, preCreated: true },
  });
  res.json({ ok: true, id: result.userId });
});

router.patch('/users/:id', async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:manage_users', 'tenant');
  if (!actor) return;
  const can = await guards.canManageUser(actor, req.params.id);
  if (!can.ok) return fail(res, 403, can.reason);

  const body = req.body || {};
  const changes = {};

  if (body.role_id) {
    const check = await guards.canAssignRole(actor, body.role_id);
    if (!check.ok) return fail(res, 403, check.reason);
    changes.role = check.role.key;
  }
  if (body.status && !['active', 'pending', 'suspended', 'blocked'].includes(body.status)) {
    return fail(res, 400, 'Unknown status.');
  }

  const tenantId = actor.isSuper ? (body.tenant_id || null) : actor.tenantId;
  const sets = [];
  const params = [req.params.id];
  const push = (frag, val) => { params.push(val); sets.push(frag.replace('$?', '$' + params.length)); };

  if (body.role_id) push('role_id = $?', body.role_id);
  if (body.status) { push('status = $?', body.status); changes.status = body.status; }
  if ('grade_level' in body) { push('grade_level = $?', body.grade_level || null); changes.grade_level = body.grade_level; }
  if ('graduation_year' in body) {
    const gy = body.graduation_year === '' || body.graduation_year == null ? null : Number(body.graduation_year);
    if (gy !== null && (!Number.isInteger(gy) || gy < 1900 || gy > 2200)) return fail(res, 400, 'That is not a usable graduation year.');
    push('graduation_year = $?', gy); changes.graduation_year = gy;
  }
  if ('suspend_until' in body) push('suspend_until = $?', body.suspend_until || null);
  if (!sets.length) return fail(res, 400, 'Nothing to change.');

  const scope = tenantId ? ' AND tenant_id = $' + (params.push(tenantId)) : '';
  const updated = await db.one(
    `UPDATE memberships SET ${sets.join(', ')}, updated_at = now()
      WHERE user_id = $1${scope} RETURNING id, tenant_id`,
    params
  );
  if (!updated) return fail(res, 404, 'No membership to change.');

  // Turning access off has to end live sessions, not just future ones.
  if (body.status === 'blocked' || body.status === 'suspended') {
    await sessions.revokeAllForUser(req.params.id);
  }

  await audit.from(req, {
    tenantId: updated.tenant_id, action: 'user.updated',
    targetType: 'user', targetId: req.params.id, detail: changes,
  });
  res.json({ ok: true });
});

// Bulk approve / block, which is how a real term actually starts.
router.post('/users/bulk', async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:manage_users', 'tenant');
  if (!actor) return;
  const { ids = [], action } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) return fail(res, 400, 'Select at least one person.');
  if (!['approve', 'block', 'unblock'].includes(action)) return fail(res, 400, 'Unknown action.');

  const status = action === 'block' ? 'blocked' : 'active';
  const done = [];
  const skipped = [];

  for (const id of ids.slice(0, 500)) {
    const can = await guards.canManageUser(actor, id);
    if (!can.ok) { skipped.push({ id, reason: can.reason }); continue; }
    const scope = actor.isSuper ? '' : ' AND tenant_id = $3';
    const params = actor.isSuper ? [id, status] : [id, status, actor.tenantId];
    await db.query(
      `UPDATE memberships SET status = $2, suspend_until = NULL, updated_at = now()
        WHERE user_id = $1${scope}`, params);
    if (status === 'blocked') await sessions.revokeAllForUser(id);
    done.push(id);
  }

  await audit.from(req, {
    action: 'user.bulk_' + action, targetType: 'user', targetId: null,
    detail: { count: done.length, skipped: skipped.length },
  });
  res.json({ ok: true, changed: done.length, skipped });
});

// A recycled address: release it from the old account so the new person can
// sign in. The old record is archived, never merged into the new one.
router.post('/users/:id/release-email', async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:manage_users', 'tenant');
  if (!actor) return;
  const can = await guards.canManageUser(actor, req.params.id);
  if (!can.ok) return fail(res, 403, can.reason);

  const user = await db.one('SELECT id, email FROM users WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
  if (!user) return fail(res, 404, 'That account no longer exists.');

  // Archive rather than delete: the previous pupil's records still belong to
  // them and to the school, and may be needed for a records request.
  const archived = `${user.email}#released-${Date.now()}`;
  await db.query(
    `UPDATE users SET email = $2, status = 'blocked', deleted_at = now(),
                      purge_after = now() + ($3 || ' days')::interval
      WHERE id = $1`,
    [user.id, archived, String(config.retentionDays)]
  );
  await sessions.revokeAllForUser(user.id);

  await audit.from(req, {
    action: 'user.email_released', targetType: 'user', targetId: user.id,
    detail: { released: user.email, archivedAs: archived }, disclosure: false,
  });
  res.json({ ok: true, released: user.email });
});

// ---------- FERPA: inspect, export, erase ----------

// The record of everything held about one person, in one call. This is what a
// school hands a parent who asks under FERPA 34 CFR 99.10.
router.get('/users/:id/export', async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:export_student_data', 'class');
  if (!actor) return;
  if (!actor.isSuper) {
    const inTenant = await db.one('SELECT 1 FROM memberships WHERE user_id = $1 AND tenant_id = $2', [req.params.id, actor.tenantId]);
    if (!inTenant) return fail(res, 403, 'That person is not in your school.');
  }

  const user = await db.one('SELECT * FROM users WHERE id = $1', [req.params.id]);
  if (!user) return fail(res, 404, 'No such person.');

  const [identities, memberships, classes, guardiansOf, childrenOf, sessionRows, disclosures, reported] = await Promise.all([
    db.many('SELECT provider, subject, email_at_link, hosted_domain, linked_at, last_login_at FROM identities WHERE user_id = $1', [user.id]),
    db.many(`SELECT m.status, m.grade_level, m.graduation_year, m.school_year, m.created_at, r.key AS role, t.name AS school
               FROM memberships m JOIN roles r ON r.id = m.role_id JOIN tenants t ON t.id = m.tenant_id
              WHERE m.user_id = $1`, [user.id]),
    db.many(`SELECT c.name, c.subject, c.grade_levels, c.school_year, cm.role
               FROM class_members cm JOIN classes c ON c.id = cm.class_id WHERE cm.user_id = $1`, [user.id]),
    db.many(`SELECT u.display_name, u.email, g.relationship, g.verified_at
               FROM guardian_links g JOIN users u ON u.id = g.guardian_id WHERE g.student_id = $1`, [user.id]),
    db.many(`SELECT u.display_name, u.email, g.relationship, g.verified_at
               FROM guardian_links g JOIN users u ON u.id = g.student_id WHERE g.guardian_id = $1`, [user.id]),
    sessions.listForUser(user.id),
    audit.list({ targetId: user.id, limit: 500 }),
    reports.forUser(user.id),
  ]);

  await audit.from(req, {
    action: 'record.exported', targetType: 'user', targetId: user.id,
    detail: { by: actor.email, purpose: String((req.query.purpose || 'administrative request')).slice(0, 120) },
    // This IS the FERPA disclosure record.
    disclosure: true,
  });

  res.set('Content-Disposition', `attachment; filename="signify-record-${user.id}.json"`);
  res.json({
    generated_at: new Date().toISOString(),
    generated_by: actor.email,
    notice: 'Complete record held by Signify ID. App-specific work (boards, maps, quiz results) is exported from each app separately.',
    person: {
      id: user.id, email: user.email, name: user.display_name,
      given_name: user.given_name, family_name: user.family_name,
      status: user.status, is_minor: user.is_minor, minor_source: user.minor_source,
      created_at: user.created_at, last_seen_at: user.last_seen_at,
    },
    sign_in_methods: identities,
    schools: memberships,
    classes,
    guardians: guardiansOf,
    children: childrenOf,
    sessions: sessionRows,
    activity_and_disclosures: disclosures,
    problem_reports: reported,
  });
});

// Soft delete, then a dated purge. Reversible for a window, because an
// accidental erase of a child's record is its own kind of incident.
router.delete('/users/:id', async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:delete_student_data', 'tenant');
  if (!actor) return;
  const can = await guards.canManageUser(actor, req.params.id);
  if (!can.ok) return fail(res, 403, can.reason);

  const days = Number(req.query.grace_days) >= 0 ? Number(req.query.grace_days) : 30;
  const user = await db.one(
    `UPDATE users SET deleted_at = now(), status = 'blocked',
                      email = email || '#deleted-' || extract(epoch from now())::bigint,
                      purge_after = now() + ($2 || ' days')::interval
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING id, email`,
    [req.params.id, String(days)]
  );
  if (!user) return fail(res, 404, 'That account is already removed.');
  await sessions.revokeAllForUser(req.params.id);

  await audit.from(req, {
    action: 'record.erase_requested', targetType: 'user', targetId: req.params.id,
    detail: { purge_in_days: days, requested_by: actor.email }, disclosure: true,
  });
  res.json({ ok: true, purge_in_days: days });
});

// ---------- roles ----------

router.get('/roles', async (req, res) => {
  const actor = guards.requireActor(req, res);
  if (!actor) return;
  const tenantId = guards.tenantScope(actor, req.query.tenant_id);

  const roles = await db.many(
    `SELECT r.*, (SELECT COUNT(*) FROM memberships m WHERE m.role_id = r.id) AS in_use,
            u.email AS customised_by_email
       FROM roles r
       LEFT JOIN users u ON u.id = r.customised_by
      WHERE r.tenant_id IS NULL ${tenantId ? 'OR r.tenant_id = $1' : 'OR r.tenant_id IS NOT NULL'}
      ORDER BY r.sort_order, r.label`,
    tenantId ? [tenantId] : []
  );
  const perms = await db.many('SELECT role_id, permission, scope FROM role_permissions');
  const byRole = {};
  for (const p of perms) (byRole[p.role_id] = byRole[p.role_id] || []).push({ permission: p.permission, scope: p.scope });

  res.json({
    roles: roles.map((r) => ({
      ...r,
      permissions: byRole[r.id] || [],
      // What the code says this built-in should hold, so a customised one can
      // be shown against its default rather than just labelled "changed".
      defaults: r.builtin ? seed.defaultsFor(r.key) : null,
    })),
    // The catalogue travels with the roles so a read-only viewer can be shown
    // proper labels rather than raw permission strings.
    catalog: await catalog.full(),
  });
});

router.post('/roles', async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:manage_roles', 'tenant');
  if (!actor) return;
  const body = req.body || {};
  const tenantId = guards.tenantScope(actor, body.tenant_id) || actor.tenantId;
  if (!tenantId) return fail(res, 400, 'Custom roles belong to a school. Choose one.');

  const label = String(body.label || '').trim();
  if (label.length < 2) return fail(res, 400, 'Give the role a name.');
  const key = slugify(body.key || label);
  if (!key) return fail(res, 400, 'That name cannot be turned into an identifier.');

  const known = await catalog.knownKeys();
  const adminSet = await catalog.adminKeys();
  const liveLabels = await catalog.labels();

  const grants = (Array.isArray(body.permissions) ? body.permissions : [])
    .filter((g) => g && known.has(g.permission) && rbac.SCOPES.includes(g.scope));
  const check = rbac.canGrant(actor.perms, actor.isSuper, grants, { known, labels: liveLabels });
  if (!check.ok) return fail(res, 403, check.reason);

  const isAdmin = rbac.roleIsAdministrative(grants, adminSet);
  if (isAdmin && !actor.isSuper) return fail(res, 403, 'Only a super admin can create a role with administrative permissions.');

  const clash = await db.one('SELECT 1 FROM roles WHERE key = $1 AND (tenant_id = $2 OR tenant_id IS NULL)', [key, tenantId]);
  if (clash) return fail(res, 409, 'A role with that name already exists here.');

  const role = await db.tx(async (client) => {
    const r = await client.query(
      `INSERT INTO roles (tenant_id, key, label, description, builtin, is_admin, sort_order)
       VALUES ($1,$2,$3,$4,false,$5,60) RETURNING *`,
      [tenantId, key, label, String(body.description || '').slice(0, 300), isAdmin]
    );
    for (const g of grants) {
      await client.query('INSERT INTO role_permissions (role_id, permission, scope) VALUES ($1,$2,$3)', [r.rows[0].id, g.permission, g.scope]);
    }
    return r.rows[0];
  });

  await audit.from(req, {
    tenantId, action: 'role.created', targetType: 'role', targetId: role.id,
    detail: { key, label, permissions: grants },
  });
  res.json({ ok: true, role });
});

router.patch('/roles/:id', async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:manage_roles', 'tenant');
  if (!actor) return;
  const role = await db.one('SELECT * FROM roles WHERE id = $1', [req.params.id]);
  if (!role) return fail(res, 404, 'No such role.');

  // A built-in belongs to the whole platform, so only a super admin may change
  // one — and doing so stops it tracking the code definition from then on.
  if (role.builtin && !actor.isSuper) {
    return fail(res, 403, 'Built-in roles can only be changed by a super admin. Duplicate it and change the copy.');
  }
  if (!actor.isSuper && role.tenant_id !== actor.tenantId) return fail(res, 403, 'That role belongs to a different school.');

  const body = req.body || {};
  const known = await catalog.knownKeys();
  const adminSet = await catalog.adminKeys();
  const liveLabels = await catalog.labels();

  const grants = (Array.isArray(body.permissions) ? body.permissions : [])
    .filter((g) => g && known.has(g.permission) && rbac.SCOPES.includes(g.scope));
  const check = rbac.canGrant(actor.perms, actor.isSuper, grants, { known, labels: liveLabels });
  if (!check.ok) return fail(res, 403, check.reason);

  const isAdmin = rbac.roleIsAdministrative(grants, adminSet);
  if (isAdmin && !actor.isSuper) return fail(res, 403, 'Only a super admin can give a role administrative permissions.');

  await db.tx(async (client) => {
    await client.query(
      `UPDATE roles SET label = COALESCE(NULLIF($2, ''), label), description = $3, is_admin = $4,
                        customised = CASE WHEN builtin THEN true ELSE customised END,
                        customised_at = CASE WHEN builtin THEN now() ELSE customised_at END,
                        customised_by = CASE WHEN builtin THEN $5::uuid ELSE customised_by END
        WHERE id = $1`,
      [role.id, String(body.label || '').trim(), String(body.description || '').slice(0, 300), isAdmin, actor.userId]
    );
    await client.query('DELETE FROM role_permissions WHERE role_id = $1', [role.id]);
    for (const g of grants) {
      await client.query('INSERT INTO role_permissions (role_id, permission, scope) VALUES ($1,$2,$3)', [role.id, g.permission, g.scope]);
    }
  });

  await audit.from(req, {
    tenantId: role.tenant_id,
    action: role.builtin ? 'role.builtin_customised' : 'role.updated',
    targetType: 'role', targetId: role.id,
    detail: { key: role.key, permissions: grants, isAdmin },
  });
  res.json({ ok: true, customised: !!role.builtin });
});

router.post('/roles/:id/reset', async (req, res) => {
  const actor = guards.requireActor(req, res);
  if (!actor) return;
  if (!actor.isSuper) return fail(res, 403, 'Only a super admin can reset a built-in role.');

  const role = await db.one('SELECT * FROM roles WHERE id = $1', [req.params.id]);
  if (!role) return fail(res, 404, 'No such role.');
  if (!role.builtin) return fail(res, 400, 'Only built-in roles have a default to go back to.');

  const result = await seed.resetBuiltin(role.key);
  if (!result.ok) return fail(res, 400, result.error);

  await audit.from(req, {
    action: 'role.builtin_reset', targetType: 'role', targetId: role.id,
    detail: { key: role.key, permissions: result.permissions },
  });
  res.json({ ok: true });
});

router.delete('/roles/:id', async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:manage_roles', 'tenant');
  if (!actor) return;
  const role = await db.one('SELECT * FROM roles WHERE id = $1', [req.params.id]);
  if (!role) return fail(res, 404, 'No such role.');
  if (role.builtin) return fail(res, 400, 'Built-in roles cannot be removed.');
  if (!actor.isSuper && role.tenant_id !== actor.tenantId) return fail(res, 403, 'That role belongs to a different school.');

  const inUse = Number((await db.one('SELECT COUNT(*) AS n FROM memberships WHERE role_id = $1', [role.id])).n);
  if (inUse > 0) return fail(res, 409, `${inUse} account${inUse === 1 ? ' is' : 's are'} still using this role. Move them to another role first.`);

  await db.query('DELETE FROM roles WHERE id = $1', [role.id]);
  await audit.from(req, { tenantId: role.tenant_id, action: 'role.deleted', targetType: 'role', targetId: role.id, detail: { key: role.key } });
  res.json({ ok: true });
});

// ---------- tenants ----------

router.get('/tenants', async (req, res) => {
  const actor = guards.requireActor(req, res);
  if (!actor) return;
  const rows = actor.isSuper
    ? await db.many(`SELECT t.*,
                            (SELECT COUNT(*) FROM memberships m WHERE m.tenant_id = t.id) AS people,
                            (SELECT array_agg(d.domain) FROM tenant_domains d WHERE d.tenant_id = t.id) AS domains
                       FROM tenants t ORDER BY t.name`)
    : await db.many(`SELECT t.*,
                            (SELECT COUNT(*) FROM memberships m WHERE m.tenant_id = t.id) AS people,
                            (SELECT array_agg(d.domain) FROM tenant_domains d WHERE d.tenant_id = t.id) AS domains
                       FROM tenants t WHERE t.id = $1`, [actor.tenantId]);
  res.json({ tenants: rows });
});

router.post('/tenants', async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:manage_tenants', 'global');
  if (!actor) return;
  const body = req.body || {};
  const name = String(body.name || '').trim();
  if (name.length < 2) return fail(res, 400, 'Give the school a name.');
  const slug = slugify(body.slug || name);

  const clash = await db.one('SELECT 1 FROM tenants WHERE slug = $1', [slug]);
  if (clash) return fail(res, 409, 'A school with that short name already exists.');

  const t = await db.one(
    `INSERT INTO tenants (slug, name, timezone, minors_default, retention_days)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [slug, name, body.timezone || 'America/New_York',
     body.minors_default !== false, body.retention_days || null]
  );
  await audit.from(req, { tenantId: t.id, action: 'tenant.created', targetType: 'tenant', targetId: t.id, detail: { name, slug } });
  res.json({ ok: true, tenant: t });
});

router.patch('/tenants/:id', async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:manage_tenants', 'tenant');
  if (!actor) return;
  if (!actor.isSuper && req.params.id !== actor.tenantId) return fail(res, 403, 'That is not your school.');
  const b = req.body || {};
  const t = await db.one(
    `UPDATE tenants SET
        name = COALESCE(NULLIF($2,''), name),
        status = COALESCE(NULLIF($3,''), status),
        timezone = COALESCE(NULLIF($4,''), timezone),
        minors_default = COALESCE($5, minors_default),
        retention_days = $6,
        updated_at = now()
      WHERE id = $1 RETURNING *`,
    [req.params.id, String(b.name || ''), actor.isSuper ? String(b.status || '') : '',
     String(b.timezone || ''), typeof b.minors_default === 'boolean' ? b.minors_default : null,
     b.retention_days === '' || b.retention_days == null ? null : Number(b.retention_days)]
  );
  if (!t) return fail(res, 404, 'No such school.');
  await audit.from(req, { tenantId: t.id, action: 'tenant.updated', targetType: 'tenant', targetId: t.id, detail: b });
  res.json({ ok: true, tenant: t });
});

router.post('/tenants/:id/domains', async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:manage_tenants', 'tenant');
  if (!actor) return;
  if (!actor.isSuper && req.params.id !== actor.tenantId) return fail(res, 403, 'That is not your school.');

  const domain = identity.lower((req.body || {}).domain).replace(/^@/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return fail(res, 400, 'Enter a domain like "school.edu".');

  const autoRole = (req.body || {}).auto_role || null;
  if (autoRole) {
    const role = await db.one('SELECT id, is_admin FROM roles WHERE key = $1 AND (tenant_id = $2 OR tenant_id IS NULL) LIMIT 1', [autoRole, req.params.id]);
    if (!role) return fail(res, 400, 'That role does not exist.');
    // Auto-joining straight into an administrative role would mean anyone who
    // ever gets an address on this domain becomes an administrator.
    if (role.is_admin) return fail(res, 400, 'An administrative role cannot be granted automatically by domain. Assign it person by person.');
  }

  const taken = await db.one('SELECT tenant_id FROM tenant_domains WHERE domain = $1', [domain]);
  if (taken && taken.tenant_id !== req.params.id) return fail(res, 409, 'That domain is already claimed by another school.');

  await db.query(
    `INSERT INTO tenant_domains (domain, tenant_id, auto_role, require_hd)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (domain) DO UPDATE SET auto_role = EXCLUDED.auto_role, require_hd = EXCLUDED.require_hd`,
    [domain, req.params.id, autoRole, (req.body || {}).require_hd !== false]
  );
  await audit.from(req, { tenantId: req.params.id, action: 'tenant.domain_added', targetType: 'tenant', targetId: req.params.id, detail: { domain, autoRole } });
  res.json({ ok: true });
});

router.delete('/tenants/:id/domains/:domain', async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:manage_tenants', 'tenant');
  if (!actor) return;
  if (!actor.isSuper && req.params.id !== actor.tenantId) return fail(res, 403, 'That is not your school.');
  await db.query('DELETE FROM tenant_domains WHERE domain = $1 AND tenant_id = $2', [identity.lower(req.params.domain), req.params.id]);
  await audit.from(req, { tenantId: req.params.id, action: 'tenant.domain_removed', targetType: 'tenant', targetId: req.params.id, detail: { domain: req.params.domain } });
  res.json({ ok: true });
});

// ---------- apps (OAuth clients) ----------

router.get('/apps', async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:manage_apps', 'tenant');
  if (!actor) return;
  const apps = await db.many(
    `SELECT a.id, a.client_id, a.name, a.description, a.namespace, a.redirect_uris,
            a.post_logout_uris, a.scopes, a.status, a.access_token_ttl, a.created_at,
            (a.client_secret_hash IS NOT NULL) AS has_secret,
            (SELECT array_agg(t.name) FROM app_tenants at JOIN tenants t ON t.id = at.tenant_id
              WHERE at.app_id = a.id AND at.enabled) AS tenants,
            (SELECT COUNT(*) FROM app_permissions ap WHERE ap.app_id = a.id AND NOT ap.deprecated) AS declared_permissions
       FROM apps a ORDER BY a.name`);
  res.json({ apps, issuer: config.issuer });
});

router.post('/apps', async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:manage_apps', 'global');
  if (!actor) return;
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (name.length < 2) return fail(res, 400, 'Give the app a name.');

  const namespace = slugify(b.namespace || name).replace(/-/g, '');
  if (!namespace) return fail(res, 400, 'The app needs a permission namespace, such as "atlas".');

  const uris = (Array.isArray(b.redirect_uris) ? b.redirect_uris : String(b.redirect_uris || '').split(/\s*[\n,]\s*/))
    .map((s) => String(s).trim()).filter(Boolean);
  if (!uris.length) return fail(res, 400, 'At least one redirect address is required.');
  for (const u of uris) {
    try {
      const parsed = new URL(u);
      // http is fine on localhost during development and nowhere else: an
      // authorization code travelling in clear text is a handed-over session.
      if (parsed.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(parsed.hostname)) {
        return fail(res, 400, `Redirect addresses must use https (except on localhost): ${u}`);
      }
    } catch { return fail(res, 400, `That is not a valid address: ${u}`); }
  }

  const clientId = slugify(b.client_id || name);
  const clash = await db.one('SELECT 1 FROM apps WHERE client_id = $1', [clientId]);
  if (clash) return fail(res, 409, 'An app with that client id already exists.');

  const secret = secrets.generate();
  const app = await db.one(
    `INSERT INTO apps (client_id, name, description, client_secret_hash, redirect_uris,
                       post_logout_uris, namespace, scopes, access_token_ttl)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [clientId, name, String(b.description || '').slice(0, 300), secrets.hash(secret), uris,
     (Array.isArray(b.post_logout_uris) ? b.post_logout_uris : String(b.post_logout_uris || '').split(/\s*[\n,]\s*/)).map((s) => String(s).trim()).filter(Boolean),
     namespace, ['openid', 'profile', 'email', 'roles'], Number(b.access_token_ttl) || 10]
  );

  await audit.from(req, { action: 'app.created', targetType: 'app', targetId: app.id, detail: { clientId, namespace } });
  // Shown once, never retrievable again.
  res.json({ ok: true, app, client_secret: secret });
});

router.post('/apps/:id/rotate-secret', async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:manage_apps', 'global');
  if (!actor) return;
  const secret = secrets.generate();
  const app = await db.one('UPDATE apps SET client_secret_hash = $2 WHERE id = $1 RETURNING client_id, name', [req.params.id, secrets.hash(secret)]);
  if (!app) return fail(res, 404, 'No such app.');
  await audit.from(req, { action: 'app.secret_rotated', targetType: 'app', targetId: req.params.id, detail: { clientId: app.client_id } });
  res.json({ ok: true, client_secret: secret, note: 'Update the app’s SIGNIFY_CLIENT_SECRET now. The previous secret stopped working immediately.' });
});

router.patch('/apps/:id', async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:manage_apps', 'global');
  if (!actor) return;
  const b = req.body || {};
  const app = await db.one(
    `UPDATE apps SET
       name = COALESCE(NULLIF($2,''), name),
       description = COALESCE($3, description),
       status = COALESCE(NULLIF($4,''), status),
       access_token_ttl = COALESCE($5, access_token_ttl)
     WHERE id = $1 RETURNING *`,
    [req.params.id, String(b.name || ''), b.description, String(b.status || ''), b.access_token_ttl ? Number(b.access_token_ttl) : null]
  );
  if (!app) return fail(res, 404, 'No such app.');
  await audit.from(req, { action: 'app.updated', targetType: 'app', targetId: app.id, detail: b });
  res.json({ ok: true, app });
});

router.post('/apps/:id/tenants', async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:manage_apps', 'tenant');
  if (!actor) return;
  const tenantId = guards.tenantScope(actor, (req.body || {}).tenant_id) || actor.tenantId;
  const enabled = (req.body || {}).enabled !== false;
  if (!tenantId) return fail(res, 400, 'Choose a school.');

  await db.query(
    `INSERT INTO app_tenants (app_id, tenant_id, enabled) VALUES ($1,$2,$3)
     ON CONFLICT (app_id, tenant_id) DO UPDATE SET enabled = EXCLUDED.enabled`,
    [req.params.id, tenantId, enabled]
  );
  await audit.from(req, { tenantId, action: enabled ? 'app.enabled_for_school' : 'app.disabled_for_school', targetType: 'app', targetId: req.params.id, detail: { tenantId } });
  res.json({ ok: true });
});

// ---------- classes ----------

router.get('/classes', async (req, res) => {
  const actor = guards.requireActor(req, res);
  if (!actor) return;
  const tenantId = guards.tenantScope(actor, req.query.tenant_id);
  const params = [];
  const where = ['c.archived = false'];
  if (tenantId) { params.push(tenantId); where.push(`c.tenant_id = $${params.length}`); }
  // A teacher without tenant-wide reach sees only their own classes.
  if (!actor.isSuper && !rbac.allows(actor.perms, 'core:manage_classes', 'tenant')) {
    params.push(actor.userId);
    where.push(`EXISTS (SELECT 1 FROM class_members cm WHERE cm.class_id = c.id AND cm.user_id = $${params.length} AND cm.role IN ('teacher','aide'))`);
  }
  const rows = await db.many(
    `SELECT c.*, (SELECT COUNT(*) FROM class_members cm WHERE cm.class_id = c.id AND cm.role = 'student') AS students,
            (SELECT string_agg(u.display_name, ', ') FROM class_members cm JOIN users u ON u.id = cm.user_id
              WHERE cm.class_id = c.id AND cm.role = 'teacher') AS teachers
       FROM classes c WHERE ${where.join(' AND ')} ORDER BY c.name`, params);
  res.json({ classes: rows });
});

router.post('/classes', async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:manage_classes', 'own');
  if (!actor) return;
  const b = req.body || {};
  const tenantId = guards.tenantScope(actor, b.tenant_id) || actor.tenantId;
  if (!tenantId) return fail(res, 400, 'Choose a school.');
  const name = String(b.name || '').trim();
  if (name.length < 2) return fail(res, 400, 'Give the class a name.');

  const year = String(b.school_year || new Date().getFullYear());
  // grade_levels, plural: migration 002 replaced the single grade_level column
  // with an array for mixed-age and split classes. This INSERT was still
  // naming the old column, so every attempt to create a class from the console
  // failed on a column that no longer exists.
  const cls = await db.one(
    `INSERT INTO classes (tenant_id, name, subject, grade_levels, school_year, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [tenantId, name, b.subject || null, cleanYearGroups(b.grade_levels), year, actor.userId]
  );
  // The creator teaches it unless somebody says otherwise.
  await db.query("INSERT INTO class_members (class_id, user_id, role) VALUES ($1,$2,'teacher') ON CONFLICT DO NOTHING", [cls.id, actor.userId]);

  await audit.from(req, { tenantId, action: 'class.created', targetType: 'class', targetId: cls.id, detail: { name } });
  res.json({ ok: true, class: cls });
});

router.patch('/classes/:id', async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:manage_classes', 'own');
  if (!actor) return;
  const cls = await db.one('SELECT * FROM classes WHERE id = $1', [req.params.id]);
  if (!cls) return fail(res, 404, 'No such class.');
  if (!actor.isSuper && cls.tenant_id !== actor.tenantId) return fail(res, 403, 'That class is in a different school.');

  const b = req.body || {};
  const updated = await db.one(
    `UPDATE classes SET
       name = COALESCE(NULLIF($2,''), name),
       subject = $3,
       grade_levels = $4,
       school_year = COALESCE(NULLIF($5,''), school_year),
       archived = COALESCE($6, archived)
     WHERE id = $1 RETURNING *`,
    [cls.id, String(b.name || '').trim(), b.subject || null,
     cleanYearGroups(b.grade_levels), String(b.school_year || ''),
     typeof b.archived === 'boolean' ? b.archived : null]);

  await audit.from(req, {
    tenantId: cls.tenant_id, action: 'class.updated', targetType: 'class', targetId: cls.id,
    detail: { name: updated.name, grade_levels: updated.grade_levels },
  });
  res.json({ ok: true, class: updated });
});

router.get('/classes/:id/members', async (req, res) => {
  const actor = guards.requireActor(req, res);
  if (!actor) return;
  const cls = await db.one('SELECT * FROM classes WHERE id = $1', [req.params.id]);
  if (!cls) return fail(res, 404, 'No such class.');
  if (!actor.isSuper && cls.tenant_id !== actor.tenantId) return fail(res, 403, 'That class is in a different school.');

  const members = await db.many(
    `SELECT u.id, u.display_name, u.email, u.picture_url, cm.role, cm.added_at
       FROM class_members cm JOIN users u ON u.id = cm.user_id
      WHERE cm.class_id = $1 AND u.deleted_at IS NULL
      ORDER BY cm.role, u.display_name`, [req.params.id]);
  res.json({ class: cls, members });
});

// Who could be added to this class? Gated on the same permission as adding
// them, and scoped to the class's own school, so the search can never reach
// further than the button beside it already can.
router.get('/classes/:id/candidates', async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:manage_classes', 'own');
  if (!actor) return;
  const cls = await db.one('SELECT * FROM classes WHERE id = $1', [req.params.id]);
  if (!cls) return fail(res, 404, 'No such class.');
  if (!actor.isSuper && cls.tenant_id !== actor.tenantId) return fail(res, 403, 'That class is in a different school.');

  const people = await directory.classCandidates({
    tenantId: cls.tenant_id, classId: cls.id, q: req.query.q,
  });
  res.json({ people });
});

router.post('/classes/:id/members', async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:manage_classes', 'own');
  if (!actor) return;
  const cls = await db.one('SELECT * FROM classes WHERE id = $1', [req.params.id]);
  if (!cls) return fail(res, 404, 'No such class.');
  if (!actor.isSuper && cls.tenant_id !== actor.tenantId) return fail(res, 403, 'That class is in a different school.');

  const role = ['teacher', 'student', 'aide', 'observer'].includes((req.body || {}).role) ? req.body.role : 'student';
  const emails = (Array.isArray((req.body || {}).emails) ? req.body.emails : String((req.body || {}).emails || '').split(/[\s,;]+/))
    .map((e) => identity.lower(e)).filter(Boolean);
  if (!emails.length) return fail(res, 400, 'List at least one email address.');

  const added = [];
  const missing = [];
  for (const email of emails.slice(0, 300)) {
    const u = await db.one(
      `SELECT u.id FROM users u JOIN memberships m ON m.user_id = u.id
        WHERE u.email = $1 AND u.deleted_at IS NULL AND m.tenant_id = $2`,
      [email, cls.tenant_id]);
    if (!u) { missing.push(email); continue; }
    await db.query('INSERT INTO class_members (class_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (class_id, user_id) DO UPDATE SET role = EXCLUDED.role', [cls.id, u.id, role]);
    added.push(email);
  }

  await audit.from(req, { tenantId: cls.tenant_id, action: 'class.members_added', targetType: 'class', targetId: cls.id, detail: { added: added.length, role, missing } });
  res.json({ ok: true, added: added.length, missing });
});

router.delete('/classes/:id/members/:userId', async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:manage_classes', 'own');
  if (!actor) return;
  const cls = await db.one('SELECT * FROM classes WHERE id = $1', [req.params.id]);
  if (!cls) return fail(res, 404, 'No such class.');
  if (!actor.isSuper && cls.tenant_id !== actor.tenantId) return fail(res, 403, 'That class is in a different school.');
  await db.query('DELETE FROM class_members WHERE class_id = $1 AND user_id = $2', [cls.id, req.params.userId]);
  await audit.from(req, { tenantId: cls.tenant_id, action: 'class.member_removed', targetType: 'class', targetId: cls.id, detail: { userId: req.params.userId } });
  res.json({ ok: true });
});

// ---------- sessions ----------

router.get('/users/:id/sessions', async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:manage_users', 'tenant');
  if (!actor) return;
  // The same question the revoke route below already asks. Without it a local
  // admin could read the sign-in history — addresses, devices, times — of
  // anybody on the platform, including staff at another school, just by
  // knowing their user id.
  const can = await guards.canManageUser(actor, req.params.id);
  if (!can.ok) return fail(res, 403, can.reason);
  res.json({ sessions: await sessions.listForUser(req.params.id) });
});

router.delete('/users/:id/sessions', async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:manage_users', 'tenant');
  if (!actor) return;
  const can = await guards.canManageUser(actor, req.params.id);
  if (!can.ok) return fail(res, 403, can.reason);
  const n = await sessions.revokeAllForUser(req.params.id);
  await audit.from(req, { action: 'user.sessions_revoked', targetType: 'user', targetId: req.params.id, detail: { count: n } });
  res.json({ ok: true, revoked: n });
});

// ---------- audit ----------

router.get('/audit', async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:view_audit', 'tenant');
  if (!actor) return;
  const tenantId = guards.tenantScope(actor, req.query.tenant_id);
  res.json({
    entries: await audit.list({
      tenantId,
      limit: Number(req.query.limit) || 200,
      before: req.query.before || null,
      disclosuresOnly: req.query.disclosures === '1',
    }),
  });
});

// ---------- compliance ----------

router.get('/compliance', async (req, res) => {
  const actor = guards.requireActor(req, res);
  if (!actor) return;
  const tenantId = guards.tenantScope(actor, req.query.tenant_id) || actor.tenantId;

  const consents = tenantId
    ? await db.many('SELECT * FROM consents WHERE tenant_id = $1 ORDER BY signed_at DESC', [tenantId])
    : await db.many('SELECT c.*, t.name AS tenant_name FROM consents c LEFT JOIN tenants t ON t.id = c.tenant_id ORDER BY c.signed_at DESC LIMIT 100');

  const tenant = tenantId ? await db.one('SELECT * FROM tenants WHERE id = $1', [tenantId]) : null;

  const pendingPurge = await db.many(
    `SELECT id, display_name, purge_after FROM users
      WHERE purge_after IS NOT NULL AND deleted_at IS NOT NULL
      ORDER BY purge_after LIMIT 50`);

  const disclosures = await audit.list({ tenantId, disclosuresOnly: true, limit: 25 });

  const policyMod = require('./policy');

  res.json({
    tenant,
    consents,
    pendingPurge,
    disclosures,
    posture: policyMod.POSTURE,
    minimumAge: policyMod.MINIMUM_AGE,
    policyUnfilled: policyMod.unfilled(),
    policyVersion: config.policyVersion,
    platformRetentionDays: config.retentionDays,
    effectiveRetentionDays: tenant && tenant.retention_days ? tenant.retention_days : config.retentionDays,
    // How long a sign-in lasts, so the page states it rather than leaving it
    // to be discovered by being signed out.
    sessionWindows: {
      staffIdleMinutes: config.sessionIdleMinutesStaff,
      studentIdleMinutes: config.sessionIdleMinutes,
      absoluteHours: config.sessionAbsoluteHours,
    },
  });
});

// Recording the school's authorization is the artefact that makes the COPPA
// school-consent exception real rather than assumed.
router.post('/compliance/authorization', async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:manage_tenants', 'tenant');
  if (!actor) return;
  const b = req.body || {};
  const tenantId = guards.tenantScope(actor, b.tenant_id) || actor.tenantId;
  if (!tenantId) return fail(res, 400, 'Choose a school.');

  const signerName = String(b.signer_name || '').trim();
  const signerEmail = identity.lower(b.signer_email);
  const signerTitle = String(b.signer_title || '').trim();
  if (!signerName || !signerEmail || !signerTitle) {
    return fail(res, 400, 'Record who authorized this: their name, role at the school, and email address.');
  }

  const row = await db.one(
    `INSERT INTO consents (tenant_id, kind, policy_version, signer_name, signer_email,
                           signer_title, method, document, ip)
     VALUES ($1,'school_authorization',$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [tenantId, config.policyVersion, signerName, signerEmail, signerTitle,
     String(b.method || 'recorded in console'),
     JSON.stringify({
       note: String(b.note || '').slice(0, 1000),
       dataCategories: ['name', 'school email address', 'profile picture', 'role', 'class membership', 'sign-in records'],
       purpose: 'Authentication and roster for the school’s own classroom applications. No advertising, no profiling, no sale.',
       recordedBy: actor.email,
     }),
     req.ip]
  );

  await audit.from(req, {
    tenantId, action: 'compliance.authorization_recorded', targetType: 'tenant', targetId: tenantId,
    detail: { signerName, signerEmail, signerTitle, policyVersion: config.policyVersion },
  });
  res.json({ ok: true, consent: row });
});

// ---------- requests for an account ----------
// Somebody whose address matches no school. Only a platform admin can act on
// these, because deciding which school a stranger belongs to is not a
// question a single school's administrator should answer.

router.get('/requests', async (req, res) => {
  const actor = guards.requirePlatformAdmin(req, res, 'Reviewing account requests');
  if (!actor) return;
  // Taken before the list is read: anything answered after this moment was
  // not on the page, and must still count as new next time.
  const { at: lookedAt } = await db.one('SELECT now() AS at');
  const rows = await survey.listRequests();

  // Opening this page is looking at them, so the "new" count starts again
  // from here — for this admin only.
  await survey.markRequestsSeen(actor.userId, lookedAt);

  // The answers leave here already put into words, so the console never has
  // to know what a stored key stands for.
  const apps = await db.many('SELECT client_id, name FROM apps');
  res.json({
    requests: rows.map((r) => ({
      id: r.id, email: r.email, requested_at: r.requested_at, attempts: r.attempts,
      last_seen_at: r.last_seen_at, status: r.status, decided_at: r.decided_at, note: r.note,
      display_name: r.display_name, picture_url: r.picture_url, user_id: r.user_id,
      decided_by_email: r.decided_by_email, tenant_name: r.tenant_name,
      answers: survey.describe(r, apps),
    })),
  });
});

router.post('/requests/:id/approve', async (req, res) => {
  const actor = guards.requirePlatformAdmin(req, res, 'Approving an account request');
  if (!actor) return;

  const body = req.body || {};
  const request = await db.one("SELECT * FROM access_requests WHERE id = $1 AND status = 'pending'", [req.params.id]);
  if (!request) return fail(res, 404, 'That request is no longer open.');

  const tenantId = body.tenant_id;
  if (!tenantId) return fail(res, 400, 'Choose which school to admit them to.');
  const role = await db.one(
    `SELECT id, key FROM roles WHERE id = $1 AND (tenant_id IS NULL OR tenant_id = $2)`,
    [body.role_id, tenantId]);
  if (!role) return fail(res, 400, 'Choose a role that exists in that school.');

  await db.tx(async (client) => {
    await client.query(
      `INSERT INTO memberships (user_id, tenant_id, role_id, status, added_by)
       VALUES ($1,$2,$3,'active',$4)
       ON CONFLICT (user_id, tenant_id) DO UPDATE SET role_id = EXCLUDED.role_id, status = 'active', updated_at = now()`,
      [request.user_id, tenantId, role.id, actor.userId]);
    await client.query(
      `UPDATE access_requests SET status = 'approved', decided_at = now(), decided_by = $2,
                                  tenant_id = $3, role_id = $4, note = $5
        WHERE id = $1`,
      [request.id, actor.userId, tenantId, role.id, String(body.note || '').slice(0, 300)]);
  });

  await audit.from(req, {
    tenantId, action: 'access.approved', targetType: 'user', targetId: request.user_id,
    detail: { email: request.email, role: role.key }, disclosure: true,
  });
  res.json({ ok: true });
});

router.post('/requests/:id/decline', async (req, res) => {
  const actor = guards.requirePlatformAdmin(req, res, 'Declining an account request');
  if (!actor) return;
  const request = await db.one("SELECT * FROM access_requests WHERE id = $1 AND status = 'pending'", [req.params.id]);
  if (!request) return fail(res, 404, 'That request is no longer open.');

  await db.query(
    `UPDATE access_requests SET status = 'declined', decided_at = now(), decided_by = $2, note = $3 WHERE id = $1`,
    [request.id, actor.userId, String((req.body || {}).note || '').slice(0, 300)]);

  await audit.from(req, {
    action: 'access.declined', targetType: 'user', targetId: request.user_id,
    detail: { email: request.email },
  });
  res.json({ ok: true });
});

// Everyone in the directory who belongs to no school at all.
router.get('/unassigned', async (req, res) => {
  const actor = guards.requirePlatformAdmin(req, res, 'Listing unassigned accounts');
  if (!actor) return;
  const rows = await db.many(
    `SELECT u.id, u.email, u.display_name, u.picture_url, u.created_at, u.last_seen_at,
            (SELECT COUNT(*) FROM identities i WHERE i.user_id = u.id) AS identities,
            (SELECT 1 FROM platform_admins p WHERE p.user_id = u.id) AS is_super,
            (SELECT r.status FROM access_requests r WHERE r.user_id = u.id ORDER BY r.requested_at DESC LIMIT 1) AS request_status
       FROM users u
      WHERE u.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id)
      ORDER BY u.last_seen_at DESC NULLS LAST`);
  res.json({ users: rows });
});

// ---------- merging two accounts ----------

router.post('/users/:id/merge-preview', async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:manage_users', 'tenant');
  if (!actor) return;
  const result = await merge.preview({ keepId: req.params.id, fromId: (req.body || {}).from_id, actor });
  if (!result.ok) return fail(res, 400, result.error);
  res.json(result);
});

router.post('/users/:id/merge', async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:manage_users', 'tenant');
  if (!actor) return;
  if (!(await guards.requireFreshSession(req, res, 30))) return;

  const result = await merge.merge({
    keepId: req.params.id,
    fromId: (req.body || {}).from_id,
    actor,
    confirmEmail: (req.body || {}).confirm_email,
  });
  if (!result.ok) return fail(res, 400, result.error);

  await audit.from(req, {
    action: 'user.merged', targetType: 'user', targetId: req.params.id,
    detail: { kept: result.keptEmail, mergedAway: result.mergedEmail, rowsMoved: result.moved },
    disclosure: true,
  });
  res.json(result);
});

// ---------- roster import ----------

// A roster file is large enough to need its own body limit, and small enough
// that it never belongs in the general one.
const rosterBody = express.json({ limit: '6mb' });

router.post('/roster/preview', rosterBody, async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:import_roster', 'tenant');
  if (!actor) return;
  const tenantId = guards.tenantScope(actor, (req.body || {}).tenant_id) || actor.tenantId;
  if (!tenantId) return fail(res, 400, 'Choose which school this roster is for.');

  const text = String((req.body || {}).text || '');
  if (!text.trim()) return fail(res, 400, 'That file is empty.');

  const analysis = await roster.analyse({
    text, actor, tenantId,
    createMissingClasses: !!(req.body || {}).create_missing_classes,
  });
  if (!analysis.ok) return fail(res, 400, analysis.error);
  res.json(analysis);
});

router.post('/roster/apply', rosterBody, async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:import_roster', 'tenant');
  if (!actor) return;
  const tenantId = guards.tenantScope(actor, (req.body || {}).tenant_id) || actor.tenantId;
  if (!tenantId) return fail(res, 400, 'Choose which school this roster is for.');

  const text = String((req.body || {}).text || '');
  if (!text.trim()) return fail(res, 400, 'That file is empty.');

  const result = await roster.apply({
    text, actor, tenantId,
    createMissingClasses: !!(req.body || {}).create_missing_classes,
    filename: (req.body || {}).filename || '',
  });
  if (!result.ok) return fail(res, 400, result.error);

  await audit.from(req, {
    tenantId, action: 'roster.imported', targetType: 'tenant', targetId: tenantId,
    detail: {
      created: result.created, updated: result.updated, skipped: result.skipped,
      filename: String((req.body || {}).filename || '').slice(0, 200),
      createdClasses: result.createdClasses,
    },
    // New accounts for children, created in bulk, from a file somebody
    // uploaded. That belongs in the FERPA-visible record.
    disclosure: true,
  });
  res.json(result);
});

// Everything the import dialog needs to tell somebody what a column will
// accept: the school it is going into, the roles that exist, the classes it
// can match against and the apps it can grant. Guessing at exact spellings
// was the whole difficulty.
router.get('/roster/reference', async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:import_roster', 'tenant');
  if (!actor) return;
  const tenantId = guards.tenantScope(actor, req.query.tenant_id) || actor.tenantId;
  if (!tenantId) return fail(res, 400, 'Choose a school first.');

  const [tenant, roles, classes, apps] = await Promise.all([
    db.one('SELECT id, name, slug FROM tenants WHERE id = $1', [tenantId]),
    db.many(`SELECT key, label, is_admin FROM roles
              WHERE tenant_id IS NULL OR tenant_id = $1 ORDER BY sort_order, label`, [tenantId]),
    db.many('SELECT name FROM classes WHERE tenant_id = $1 AND archived = false ORDER BY name', [tenantId]),
    db.many(`SELECT a.client_id, a.name FROM apps a
               JOIN app_tenants at ON at.app_id = a.id AND at.enabled
              WHERE at.tenant_id = $1 AND a.status = 'active' ORDER BY a.name`, [tenantId]),
  ]);
  if (!tenant) return fail(res, 404, 'No such school.');

  res.json({
    tenant,
    // A non-super admin can only ever import into their own school, so the
    // School ID column is not something they need to fill in.
    schoolColumnNeeded: !!actor.isSuper,
    roles: roles.map((r) => ({ key: r.key, label: r.label, admin: r.is_admin })),
    classes: classes.map((c) => c.name),
    apps: apps.map((a) => ({ id: a.client_id, name: a.name })),
    separators: '; , |',
  });
});

router.get('/roster/template.csv', (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:import_roster', 'tenant');
  if (!actor) return;
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="signify-roster-template.csv"');
  res.send(csv.template());
});

router.get('/roster/imports', async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:undo_import', 'tenant');
  if (!actor) return;
  const tenantId = guards.tenantScope(actor, req.query.tenant_id) || actor.tenantId;
  if (!tenantId) return fail(res, 400, 'Choose a school.');
  res.json({ imports: await roster.listUndoable(tenantId), windowDays: roster.UNDO_WINDOW_DAYS });
});

router.post('/roster/imports/:id/undo-preview', async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:undo_import', 'tenant');
  if (!actor) return;
  const tenantId = guards.tenantScope(actor, (req.body || {}).tenant_id) || actor.tenantId;
  const result = await roster.undoImport({ importId: req.params.id, actor, tenantId, dryRun: true });
  if (!result.ok) return fail(res, 400, result.error);
  res.json(result);
});

router.post('/roster/imports/:id/undo', async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:undo_import', 'tenant');
  if (!actor) return;
  if (!(await guards.requireFreshSession(req, res, 30))) return;

  const tenantId = guards.tenantScope(actor, (req.body || {}).tenant_id) || actor.tenantId;
  const result = await roster.undoImport({ importId: req.params.id, actor, tenantId });
  if (!result.ok) return fail(res, 400, result.error);

  await audit.from(req, {
    tenantId, action: 'roster.import_undone', targetType: 'roster_import', targetId: req.params.id,
    detail: {
      usersRemoved: result.usersRemoved,
      classesRemoved: result.classesRemoved,
      keptBecauseTheySignedIn: result.keptBecauseTheySignedIn,
    },
    disclosure: true,
  });
  res.json(result);
});

// ---------- backup and restore ----------

const backupBody = express.json({ limit: '24mb' });

router.get('/backups', async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:manage_backups', 'tenant');
  if (!actor) return;
  const tenantId = guards.tenantScope(actor, req.query.tenant_id) || actor.tenantId;

  const rows = await db.many(
    `SELECT b.id, b.kind, b.created_at, b.checksum, b.row_counts, b.note, b.expires_at,
            u.email AS created_by
       FROM backups b LEFT JOIN users u ON u.id = b.created_by
      WHERE ($1::uuid IS NULL OR b.tenant_id = $1)
      ORDER BY b.created_at DESC LIMIT 50`, [tenantId || null]);
  res.json({ backups: rows, keepDays: backup.PRE_RESTORE_KEEP_DAYS });
});

router.post('/backups', async (req, res) => {
  const actor = guards.requirePerm(req, res, 'core:manage_backups', 'tenant');
  if (!actor) return;
  // A whole school's roster in one file — the sign-in has to be recent.
  if (!(await guards.requireFreshSession(req, res, 30))) return;

  const tenantId = guards.tenantScope(actor, (req.body || {}).tenant_id) || actor.tenantId;
  if (!tenantId) return fail(res, 400, 'Choose which school to back up.');

  const made = await backup.create({ tenantId, actor });
  if (!made.ok) {
    await audit.from(req, {
      tenantId, action: 'backup.rate_limited', targetType: 'tenant', targetId: tenantId,
      detail: { reason: made.error },
    });
    return fail(res, 429, made.error);
  }

  await audit.from(req, {
    tenantId, action: 'backup.downloaded', targetType: 'tenant', targetId: tenantId,
    detail: { backupId: made.id, counts: made.counts, checksum: made.checksum },
    // A backup is every pupil's record leaving the building at once.
    disclosure: true,
  });

  const stamp = new Date().toISOString().slice(0, 10);
  res.set('Content-Disposition', `attachment; filename="signify-backup-${stamp}.json"`);
  res.json(made.file);
});

router.post('/restore/preview', backupBody, async (req, res) => {
  const actor = guards.requirePlatformAdmin(req, res, 'Restoring from a backup');
  if (!actor) return;
  const tenantId = guards.tenantScope(actor, (req.body || {}).tenant_id) || actor.tenantId;
  if (!tenantId) return fail(res, 400, 'Choose which school to restore into.');

  const result = await backup.preview({ file: (req.body || {}).file, actor, tenantId });
  if (!result.ok) {
    await audit.from(req, {
      tenantId, action: 'restore.rejected', targetType: 'tenant', targetId: tenantId,
      detail: { reason: result.error },
    });
    return fail(res, 400, result.error);
  }
  res.json(result);
});

router.post('/restore/apply', backupBody, async (req, res) => {
  const actor = guards.requirePlatformAdmin(req, res, 'Restoring from a backup');
  if (!actor) return;
  if (!(await guards.requireFreshSession(req, res, 15))) return;

  const tenantId = guards.tenantScope(actor, (req.body || {}).tenant_id) || actor.tenantId;
  if (!tenantId) return fail(res, 400, 'Choose which school to restore into.');

  const result = await backup.restore({
    file: (req.body || {}).file,
    actor,
    tenantId,
    confirmName: (req.body || {}).confirm_name,
    acknowledgeStale: !!(req.body || {}).acknowledge_stale,
  });
  if (!result.ok) {
    await audit.from(req, {
      tenantId, action: 'restore.rejected', targetType: 'tenant', targetId: tenantId,
      detail: { reason: result.error },
    });
    return fail(res, 400, result.error);
  }

  await audit.from(req, {
    tenantId, action: 'restore.applied', targetType: 'tenant', targetId: tenantId,
    detail: {
      usersCreated: result.usersCreated, usersUpdated: result.usersUpdated,
      classesCreated: result.classesCreated, refused: result.refusals.length,
      snapshotId: result.snapshotId,
    },
    disclosure: true,
  });
  res.json(result);
});

// The automatic snapshot taken just before a restore — the undo.
router.get('/backups/:id/download', async (req, res) => {
  // A pre-restore snapshot only exists because a super admin restored, and
  // only they can act on it.
  const actor = guards.requirePlatformAdmin(req, res, 'Downloading a restore snapshot');
  if (!actor) return;
  const row = await db.one('SELECT * FROM backups WHERE id = $1', [req.params.id]);
  if (!row || !row.payload) return fail(res, 404, 'That snapshot is no longer held.');
  if (!actor.isSuper && row.tenant_id !== actor.tenantId) return fail(res, 403, 'That backup belongs to a different school.');

  await audit.from(req, {
    tenantId: row.tenant_id, action: 'backup.snapshot_downloaded',
    targetType: 'backup', targetId: row.id, detail: {}, disclosure: true,
  });
  res.set('Content-Disposition', `attachment; filename="signify-snapshot-${row.id}.json"`);
  res.json(row.payload);
});

// ---------- platform admins ----------

router.get('/platform', async (req, res) => {
  const actor = guards.requireActor(req, res);
  if (!actor || !actor.isSuper) return fail(res, 403, 'This page is for super admins.');
  const admins = await db.many(
    `SELECT u.id, u.email, u.display_name, u.last_seen_at, pa.note, pa.created_at
       FROM platform_admins pa JOIN users u ON u.id = pa.user_id ORDER BY u.email`);
  res.json({ admins, configuredSuperAdmins: config.superAdmins, issuer: config.issuer });
});

router.post('/platform/admins', async (req, res) => {
  const actor = guards.requireActor(req, res);
  if (!actor || !actor.isSuper) return fail(res, 403, 'This page is for super admins.');
  const email = identity.lower((req.body || {}).email);
  const user = await db.one('SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL', [email]);
  if (!user) return fail(res, 404, 'That person has to sign in once before they can be made a super admin.');

  await db.query(
    'INSERT INTO platform_admins (user_id, granted_by, note) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO NOTHING',
    [user.id, actor.userId, String((req.body || {}).note || '').slice(0, 200)]);
  await db.query("UPDATE users SET is_minor = false, minor_source = 'admin_set' WHERE id = $1", [user.id]);

  await audit.from(req, { action: 'platform_admin.granted', targetType: 'user', targetId: user.id, detail: { email } });
  res.json({ ok: true });
});

router.delete('/platform/admins/:id', async (req, res) => {
  const actor = guards.requireActor(req, res);
  if (!actor || !actor.isSuper) return fail(res, 403, 'This page is for super admins.');
  if (req.params.id === actor.userId) return fail(res, 400, 'You cannot remove your own super admin access.');

  const remaining = await db.one('SELECT COUNT(*) AS n FROM platform_admins');
  if (Number(remaining.n) <= 2) {
    return fail(res, 400, 'At least two super admins must remain, so a lost account cannot lock everyone out.');
  }
  await db.query('DELETE FROM platform_admins WHERE user_id = $1', [req.params.id]);
  await audit.from(req, { action: 'platform_admin.revoked', targetType: 'user', targetId: req.params.id, detail: {} });
  res.json({ ok: true });
});

// ---------- problem reports ----------
// What people have flagged from inside the apps. A platform admin sees every
// school's; a local admin holding core:triage_reports sees their own. The
// scoping lives in reports.scopeFor so the list, the count and the update can
// never disagree about who may see what.

router.get('/reports', async (req, res) => {
  const actor = guards.requireActor(req, res);
  if (!actor) return;
  const result = await reports.list(actor, {
    tenantId: req.query.tenant_id, status: req.query.status,
    kind: req.query.kind, app: req.query.app, limit: req.query.limit,
  });
  if (!result.ok) return fail(res, 403, result.error);
  res.set('Cache-Control', 'no-store');
  res.json({ reports: result.reports, apps: result.apps });
});

// For the nav badge. Answers 0 rather than 403 to someone without the
// permission, so the console can ask on every load without special-casing.
router.get('/reports/summary', async (req, res) => {
  const actor = guards.requireActor(req, res);
  if (!actor) return;
  res.set('Cache-Control', 'no-store');
  res.json({ new: await reports.newCount(actor) });
});

router.patch('/reports/:id', async (req, res) => {
  const actor = guards.requireActor(req, res);
  if (!actor) return;
  const b = req.body || {};
  const result = await reports.update(actor, req.params.id, { status: b.status, resolution: b.resolution });
  if (!result.ok) return fail(res, result.status || 400, result.error);

  await audit.from(req, {
    tenantId: result.report.tenant_id, action: 'report.updated',
    targetType: 'report', targetId: result.report.id,
    detail: { ref: result.report.ref, from: result.from, to: result.report.status },
  });
  res.json({ ok: true, report: result.report });
});

// The console is an app too, and has problems of its own. It files through
// the session rather than a token, so it gets its own door.
router.post('/reports/new', async (req, res) => {
  const actor = guards.requireActor(req, res);
  if (!actor) return;
  const result = await reports.create(
    { userId: actor.userId, tenantId: actor.tenantId, appId: null, appName: 'Signify ID console' },
    req.body);
  if (!result.ok) return fail(res, result.status, result.error);
  res.status(201).json({ ok: true, ref: result.report.ref });
});

// ---------- app admin tools ----------
// An app's own admin tools, run from here — see src/app-admin.js.

router.all('/app-admin/:clientId/*', (req, res) => {
  appAdmin.handle(req, res).catch((e) => {
    console.error('app-admin:', e.message);
    if (!res.headersSent) fail(res, 500, 'Something went wrong reaching that app.');
  });
});

module.exports = router;
