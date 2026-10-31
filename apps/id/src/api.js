// ===================================================================
// Signify ID — service API for the relying apps
// Read-only roster questions an app needs in order to decide whether an adult
// may see a particular child's work. Authenticated with the same tokens the
// app already holds, and scoped so an app never learns about people outside
// its own school.
// ===================================================================

const express = require('express');
const { createLocalJWKSet, jwtVerify } = require('jose');
const db = require('./db');
const oidc = require('./oidc');
const sessions = require('./sessions');
const keys = require('./keys');
const audit = require('./audit');
const catalog = require('./catalog');
const rbac = require('./rbac');
const reports = require('./reports');
const features = require('./features');
const guardians = require('./guardians');
const names = require('./names');
const { config } = require('./config');

const router = express.Router();

// Accepts either the access token or the ID token: both are audience-bound,
// short-lived and tied to a session row that is checked here every time.
async function caller(req, res) {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  let payload = null;
  try { payload = await oidc.verifyAccessToken(token); }
  catch { payload = null; }

  if (!payload) {
    // Fall back to the ID token, which is what the browser-facing client holds.
    try {
      const set = createLocalJWKSet(await keys.jwks());
      const { payload: p } = await jwtVerify(token, set, { issuer: config.issuer });
      if (p.typ === 'id') payload = p;
    } catch { /* falls through to the 401 below */ }
  }
  if (!payload) {
    res.set('WWW-Authenticate', 'Bearer error="invalid_token"');
    res.status(401).json({ error: 'invalid_token' });
    return null;
  }

  // Checked against a live row every time, and — just as importantly — the
  // idle window is slid forward. An app's API call is somebody using their
  // session; a teacher who works in Teacher's Desk all morning without ever
  // opening this service must not be timed out behind their own back.
  const live = await sessions.slide(payload.sid);
  if (!live) {
    res.status(401).json({ error: 'invalid_token', error_description: 'That sign-in has ended.' });
    return null;
  }

  const app = await db.one('SELECT * FROM apps WHERE client_id = $1 AND status = $2', [String(payload.aud), 'active']);
  if (!app) { res.status(401).json({ error: 'invalid_client' }); return null; }

  return {
    userId: payload.sub, tenantId: payload.tenant_id || null,
    perms: payload.perms || {}, isSuper: !!payload.is_super,
    app, sid: payload.sid,
  };
}

router.get('/me', async (req, res) => {
  const c = await caller(req, res);
  if (!c) return;
  const claims = await oidc.buildClaims(c.app, c.userId, c.tenantId, c.sid);
  res.set('Cache-Control', 'no-store');
  res.json(claims);
});

// Do these two people share a class? The question an app asks before letting
// a teacher open a pupil's work.
router.get('/shares-class', async (req, res) => {
  const c = await caller(req, res);
  if (!c) return;
  const a = String(req.query.a || '');
  const b = String(req.query.b || '');
  // An app may only ask about the person who is actually signed in.
  if (a !== c.userId) return res.status(403).json({ error: 'You can only ask about the signed-in person.' });

  const row = await db.one(
    `SELECT 1 FROM class_access m1
       JOIN class_access m2 ON m2.class_id = m1.class_id
       JOIN classes c ON c.id = m1.class_id
      WHERE m1.user_id = $1 AND m2.user_id = $2 AND c.archived = false
      LIMIT 1`, [a, b]);
  res.json({ shares: !!row });
});

// The caller's own classes, with rosters. This is what lets every app show
// the same class list without each one keeping its own copy.
/**
 * The apps this person may open, for the switcher.
 *
 * Exactly the same decision the authorize endpoint makes at sign-in: the app
 * must be active, switched on for their school, and not excluded for them
 * individually. So the grid can never offer something that would then refuse
 * them at the door.
 */
router.get('/my-apps', async (req, res) => {
  const c = await caller(req, res);
  if (!c) return;

  const rows = c.tenantId
    ? await db.many(
        `SELECT a.client_id, a.name, a.short_name, a.launch_url, a.tile_initials,
                a.tile_color, a.sort_order, a.description
           FROM apps a
           JOIN app_tenants at ON at.app_id = a.id AND at.enabled
          WHERE a.status = 'active'
            AND a.launch_url IS NOT NULL
            AND at.tenant_id = $1
            AND NOT EXISTS (
              SELECT 1 FROM user_app_access ua
               WHERE ua.user_id = $2 AND ua.app_id = a.id AND ua.allowed = false)
          ORDER BY a.sort_order, a.name`,
        [c.tenantId, c.userId])
    // A platform admin belongs to no school, so they see everything live.
    : await db.many(
        `SELECT client_id, name, short_name, launch_url, tile_initials,
                tile_color, sort_order, description
           FROM apps
          WHERE status = 'active' AND launch_url IS NOT NULL
          ORDER BY sort_order, name`);

  const monogram = (a) => a.tile_initials
    || String(a.short_name || a.name).trim().slice(0, 2).toUpperCase();

  res.set('Cache-Control', 'private, max-age=60');
  res.json({
    current: c.app.client_id,
    apps: rows.map((a) => ({
      id: a.client_id,
      name: a.short_name || a.name,
      fullName: a.name,
      description: a.description || '',
      url: a.launch_url,
      initials: monogram(a),
      color: a.tile_color || 'blue',
      current: a.client_id === c.app.client_id,
    })),
  });
});

router.get('/classes', async (req, res) => {
  const c = await caller(req, res);
  if (!c) return;
  const rows = await db.many(
    `SELECT c.id, c.name, c.subject, c.grade_levels, c.school_year, cm.role,
            (cm.coverage_id IS NOT NULL) AS covering
       FROM class_access cm JOIN classes c ON c.id = cm.class_id
      WHERE cm.user_id = $1 AND c.archived = false
      ORDER BY c.name`, [c.userId]);
  res.json({ classes: rows });
});

router.get('/classes/:id/members', async (req, res) => {
  const c = await caller(req, res);
  if (!c) return;

  // The class has to be found before anything is decided about it, because
  // which school it belongs to is half the answer.
  const cls = await db.one('SELECT id, tenant_id FROM classes WHERE id = $1', [req.params.id]);
  if (!cls) return res.status(404).json({ error: 'No such class.' });

  const membership = await db.one(
    'SELECT role FROM class_access WHERE class_id = $1 AND user_id = $2', [req.params.id, c.userId]);

  // Reach beyond one's own classes is a property of a school, not of the
  // platform. This used to test the permission alone, so anyone holding
  // core:view_directory — every teacher does — could read the full roster of
  // any class anywhere, in any school, given only its id. It also compared the
  // scope with === 'tenant', which quietly excluded a platform admin holding
  // the same permission at 'global'.
  const wideReach = c.isSuper
    || rbac.allows(c.perms, 'core:view_directory', 'tenant')
    || rbac.allows(c.perms, 'core:manage_classes', 'tenant');
  const sameSchool = c.isSuper || (!!c.tenantId && c.tenantId === cls.tenant_id);

  if (!membership && !(wideReach && sameSchool)) {
    return res.status(403).json({ error: 'You are not in that class.' });
  }

  // A pupil sees who is in the class; only staff get email addresses.
  // Email addresses need the same pairing the access check uses: reach that
  // actually applies to this school, or being staff in the class itself.
  const staff = (wideReach && sameSchool) || (membership && ['teacher', 'aide'].includes(membership.role));
  // Staff also get the school's official name (null where there is none),
  // for lists that must match the school's records, such as a grade list in
  // last-name order. Classmates see the display name only.
  const rows = await db.many(
    `SELECT u.id, u.display_name, u.picture_url, cm.role,
            (cm.coverage_id IS NOT NULL) AS covering${staff ? `, u.email,
            u.official_given_name, u.official_middle_name, u.official_family_name, u.official_suffix` : ''}
       FROM class_access cm JOIN users u ON u.id = cm.user_id
      WHERE cm.class_id = $1 AND u.deleted_at IS NULL
      ORDER BY cm.role, u.display_name`, [req.params.id]);
  const members = rows.map((r) => {
    if (!staff) return r;
    const { official_given_name, official_middle_name, official_family_name, official_suffix, ...rest } = r;
    return {
      ...rest,
      official_name: names.officialOf({ official_given_name, official_middle_name, official_family_name, official_suffix }),
    };
  });

  if (staff) {
    await audit.record({
      actorUserId: c.userId, tenantId: c.tenantId, appId: c.app.id,
      action: 'roster.read', targetType: 'class', targetId: req.params.id,
      detail: { count: rows.length }, ip: req.ip, disclosure: true,
    });
  }
  res.json({ members });
});

/**
 * The signed-in parent's children at this school, with each child's classes.
 *
 * Only links the school has verified count, and only at the school the token
 * is for, so a parent with children at two schools sees one school's at a
 * time. An app may ask only about the person signed in: there is no way to
 * name somebody else, so an app cannot use this to map a family.
 */
router.get('/my-children', async (req, res) => {
  const c = await caller(req, res);
  if (!c) return;
  const children = await guardians.childrenOf(c.userId, c.tenantId);
  res.set('Cache-Control', 'no-store');
  res.json({ children });
});

// ---------- preview: what a mock person sees ----------
// A mock person (users.is_mock, migration 015: the practice class's made-up
// students and parent) has no login, so an app cannot ask as them. Staff ask
// instead, with their OWN token, and get exactly what /classes and
// /my-children would give the mock. Nothing here signs anyone in or acts as
// anyone: the caller stays the caller.
//
// Only mocks, only at the caller's school, and only for someone who teaches
// one of the mock's classes (or one of a mock parent's children's classes)
// or is a school admin (core:manage_users at school scope). Previewing real
// students is an open question for the school, so it is refused. Every call,
// allowed or refused, is audited.

const PREVIEW_ADMIN = (c) => c.isSuper || rbac.allows(c.perms, 'core:manage_users', 'tenant');

/** The mock people at the caller's school that the caller may preview. */
async function previewable(c) {
  if (!c.tenantId) return [];
  const admin = PREVIEW_ADMIN(c);
  return db.many(
    `SELECT u.id, u.display_name, r.key AS role_key
       FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.tenant_id = $1 AND m.status = 'active'
       JOIN roles r ON r.id = m.role_id
      WHERE u.is_mock AND u.deleted_at IS NULL
        AND ($3 OR EXISTS (
              -- a class the caller teaches, with this mock (or a child of
              -- this mock) in it as a student
              SELECT 1 FROM class_access me
                JOIN class_access them ON them.class_id = me.class_id AND them.role = 'student'
                JOIN classes k ON k.id = me.class_id AND k.archived = false
               WHERE me.user_id = $2 AND me.role = 'teacher'
                 AND (them.user_id = u.id OR them.user_id IN (
                       SELECT g.student_id FROM guardian_links g
                        WHERE g.guardian_id = u.id AND g.tenant_id = $1 AND g.verified_at IS NOT NULL))))
      ORDER BY (r.key = 'guardian'), u.display_name`, [c.tenantId, c.userId, admin]);
}

/** The mock the path names, if the caller may preview it; else answers. */
async function previewTarget(req, res, c, what) {
  const id = String(req.params.userId || '');
  const target = /^[0-9a-f-]{36}$/i.test(id) ? await db.one('SELECT id, is_mock FROM users WHERE id = $1 AND deleted_at IS NULL', [id]) : null;
  const allowed = target && target.is_mock && (await previewable(c)).find((p) => p.id === target.id);
  await audit.record({
    actorUserId: c.userId, tenantId: c.tenantId, appId: c.app.id,
    action: allowed ? 'preview.read' : 'preview.refused', targetType: 'user', targetId: target ? target.id : null,
    detail: { what, ...(allowed ? {} : { reason: !target ? 'not_found' : !target.is_mock ? 'not_mock' : 'not_allowed' }) },
    ip: req.ip, disclosure: false,
  });
  if (!target) { res.status(404).json({ error: 'No such person.' }); return null; }
  if (!target.is_mock) { res.status(403).json({ error: 'Only practice people can be previewed.' }); return null; }
  if (!allowed) { res.status(403).json({ error: 'You may not preview that person.' }); return null; }
  return allowed;
}

router.get('/preview/people', async (req, res) => {
  const c = await caller(req, res);
  if (!c) return;
  const people = await previewable(c);
  await audit.record({
    actorUserId: c.userId, tenantId: c.tenantId, appId: c.app.id,
    action: 'preview.list', detail: { count: people.length }, ip: req.ip, disclosure: false,
  });
  res.set('Cache-Control', 'no-store');
  res.json({ people: people.map((p) => ({ id: p.id, display_name: p.display_name, kind: p.role_key === 'guardian' ? 'parent' : 'student' })) });
});

// The same rows /classes gives the person themself.
router.get('/preview/:userId/classes', async (req, res) => {
  const c = await caller(req, res);
  if (!c) return;
  const target = await previewTarget(req, res, c, 'classes');
  if (!target) return;
  const rows = await db.many(
    `SELECT c.id, c.name, c.subject, c.grade_levels, c.school_year, cm.role,
            (cm.coverage_id IS NOT NULL) AS covering
       FROM class_access cm JOIN classes c ON c.id = cm.class_id
      WHERE cm.user_id = $1 AND c.archived = false AND c.tenant_id = $2
      ORDER BY c.name`, [target.id, c.tenantId]);
  res.set('Cache-Control', 'no-store');
  res.json({ person: { id: target.id, display_name: target.display_name }, classes: rows });
});

// The same answer /my-children gives the parent themself.
router.get('/preview/:userId/children', async (req, res) => {
  const c = await caller(req, res);
  if (!c) return;
  const target = await previewTarget(req, res, c, 'children');
  if (!target) return;
  const children = await guardians.childrenOf(target.id, c.tenantId);
  res.set('Cache-Control', 'no-store');
  res.json({ person: { id: target.id, display_name: target.display_name }, children });
});

/**
 * "Report a problem", from inside any app.
 *
 * Who sent it is read off the verified token — person, school and app — and
 * never off the body, so a report cannot be filed in somebody else's name or
 * against an app it did not come from. The app forwards this on the person's
 * behalf from its own origin (/auth/report in signify-auth.js), the same way
 * it proxies the switcher's app list.
 */
router.post('/reports', express.json({ limit: '32kb' }), async (req, res) => {
  const c = await caller(req, res);
  if (!c) return;

  const result = await reports.create(
    { userId: c.userId, tenantId: c.tenantId, appId: c.app.id, appName: c.app.name },
    req.body);
  if (!result.ok) return res.status(result.status).json({ error: result.error });

  res.set('Cache-Control', 'no-store');
  res.status(201).json({ ok: true, ref: result.report.ref });
});

/**
 * An app declares what permissions it has.
 *
 * Authenticated with the app's own client credentials, not a user's session,
 * because this runs at boot before anybody has signed in. The namespace lock
 * in catalog.declare() is what makes it safe to let a client write here at
 * all: an app can only ever describe its own permissions, and declaring one
 * grants it to nobody until an administrator puts it in a role.
 */
router.post('/declare', express.json({ limit: '64kb' }), async (req, res) => {
  const app = await oidc.authenticateClient(req);
  if (!app) {
    res.set('WWW-Authenticate', 'Basic realm="signify-id"');
    return res.status(401).json({ error: 'invalid_client' });
  }

  const result = await catalog.declare(app, (req.body || {}).permissions);
  if (!result.ok) return res.status(400).json({ error: result.error });

  await audit.record({
    appId: app.id,
    action: 'app.permissions_declared',
    targetType: 'app', targetId: app.client_id,
    detail: { declared: result.declared, retired: result.retired },
    ip: req.ip,
  });

  res.json({
    ok: true,
    declared: result.declared,
    retired: result.retired,
    note: result.retired.length
      ? 'Permissions no longer declared are retired, not deleted, because roles may still hold them.'
      : undefined,
  });
});

/**
 * A school's rooms and places, for an app's own pickers (the Help Desk's
 * "Where is it?"). Asked with the app's client credentials rather than a
 * person's token, because it is a list of rooms, not anything about a person,
 * and an app needs it when nobody is signed in to ask for it. An app sees only
 * schools it is turned on for.
 */
router.get('/tenants/:id/locations', async (req, res) => {
  req.body = req.body || {};
  const app = await oidc.authenticateClient(req);
  if (!app) {
    res.set('WWW-Authenticate', 'Basic realm="signify-id"');
    return res.status(401).json({ error: 'invalid_client' });
  }
  const row = await db.one(
    `SELECT t.settings FROM tenants t
       JOIN app_tenants at ON at.tenant_id = t.id AND at.app_id = $2 AND at.enabled = true
      WHERE t.id = $1 AND t.kind <> 'independent'`,
    [req.params.id, app.id]
  ).catch(() => null);
  if (!row) return res.status(404).json({ error: 'No such school for this app.' });
  const list = row.settings && Array.isArray(row.settings.locations) ? row.settings.locations : [];
  res.set('Cache-Control', 'no-store');
  res.json({ locations: list.filter((v) => typeof v === 'string') });
});

/**
 * An app declares its features: the parts of it a school may turn on or off
 * by role (Teacher's Desk's tools). Client credentials, at boot, like
 * /declare. Each feature says whether students get it by default; anything
 * not marked stays away from students until a school turns it on.
 */
router.post('/declare-features', express.json({ limit: '64kb' }), async (req, res) => {
  const app = await oidc.authenticateClient(req);
  if (!app) {
    res.set('WWW-Authenticate', 'Basic realm="signify-id"');
    return res.status(401).json({ error: 'invalid_client' });
  }
  const before = (Array.isArray(app.features) ? app.features : []).map((f) => f.key).sort().join();
  const result = await features.declare(app, (req.body || {}).features);
  if (!result.ok) return res.status(400).json({ error: result.error });
  // Only audited when the list changed, or every boot of every app would be
  // an entry.
  if (result.declared.slice().sort().join() !== before) {
    await audit.record({
      appId: app.id,
      action: 'app.features_declared',
      targetType: 'app', targetId: app.client_id,
      detail: { declared: result.declared },
      ip: req.ip,
    });
  }
  res.json({ ok: true, declared: result.declared });
});

/**
 * Which of an app's features each role gets at one school. Client
 * credentials, like the school's places: it is a school's settings, nothing
 * about a person, and the app resolves it against the `role` in a person's
 * token itself. Only for schools the app is turned on for.
 */
router.get('/tenants/:id/features', async (req, res) => {
  req.body = req.body || {};
  const app = await oidc.authenticateClient(req);
  if (!app) {
    res.set('WWW-Authenticate', 'Basic realm="signify-id"');
    return res.status(401).json({ error: 'invalid_client' });
  }
  const row = await db.one(
    `SELECT t.id FROM tenants t
       JOIN app_tenants at ON at.tenant_id = t.id AND at.app_id = $2 AND at.enabled = true
      WHERE t.id = $1`,
    [req.params.id, app.id]
  ).catch(() => null);
  if (!row) return res.status(404).json({ error: 'No such school for this app.' });
  res.set('Cache-Control', 'no-store');
  res.json(await features.forTenant(row.id, app));
});

module.exports = router;
