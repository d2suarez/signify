// ===================================================================
// Signify ID — authorisation guards for the admin API
// One place for the "may this person do this to that person" questions, so
// the route handlers stay short and the rules stay auditable.
// ===================================================================

const db = require('./db');
const rbac = require('./rbac');

function requireActor(req, res) {
  if (!req.actor) { res.status(401).json({ error: 'Please sign in.' }); return null; }
  return req.actor;
}

// `needed` is the reach the action requires: acting on one person in your own
// school is 'tenant'; editing your own class is 'own'.
function requirePerm(req, res, permission, needed = 'tenant') {
  const actor = requireActor(req, res);
  if (!actor) return null;
  if (actor.isSuper) return actor;
  if (!rbac.allows(actor.perms, permission, needed)) {
    res.status(403).json({
      error: `Your role does not allow this (${rbac.PERMISSION_LABELS[permission] || permission}).`,
    });
    return null;
  }
  return actor;
}

// Which school is this request about? A super admin may name any tenant; a
// local admin is pinned to their own, whatever they ask for.
function tenantScope(actor, requestedTenantId) {
  if (actor.isSuper) return requestedTenantId || null; // null means "all"
  return actor.tenantId;
}

/**
 * May `actor` administer `targetUserId`?
 *
 * Three refusals, in order of severity:
 *   - platform admins are untouchable from inside a school
 *   - an administrator may not act on another administrator
 *   - a local admin may only act inside their own school
 */
async function canManageUser(actor, targetUserId) {
  if (actor.userId === targetUserId) {
    return { ok: false, reason: 'You cannot change your own access from here.' };
  }

  const target = await db.one(
    `SELECT u.id, u.email, u.deleted_at,
            (SELECT 1 FROM platform_admins pa WHERE pa.user_id = u.id) AS is_platform_admin
       FROM users u WHERE u.id = $1`,
    [targetUserId]
  );
  if (!target) return { ok: false, reason: 'That account no longer exists.' };
  if (target.is_platform_admin) {
    return { ok: false, reason: 'Super admin accounts can only be changed by another super admin, from the platform settings.' };
  }
  if (actor.isSuper) return { ok: true, target };

  const membership = await db.one(
    `SELECT m.*, r.is_admin, r.key AS role_key
       FROM memberships m JOIN roles r ON r.id = m.role_id
      WHERE m.user_id = $1 AND m.tenant_id = $2`,
    [targetUserId, actor.tenantId]
  );
  if (!membership) {
    return { ok: false, reason: 'That person is not in your school.' };
  }
  if (membership.is_admin) {
    return { ok: false, reason: 'Another administrator’s account can only be changed by a super admin.' };
  }
  return { ok: true, target, membership };
}

// A role may only be assigned by someone who could have created it — which
// keeps a teacher from handing out administrative roles.
async function canAssignRole(actor, roleId) {
  const role = await db.one('SELECT * FROM roles WHERE id = $1', [roleId]);
  if (!role) return { ok: false, reason: 'That role does not exist.' };
  if (role.tenant_id && !actor.isSuper && role.tenant_id !== actor.tenantId) {
    return { ok: false, reason: 'That role belongs to a different school.' };
  }
  if (actor.isSuper) return { ok: true, role };
  if (role.is_admin) {
    return { ok: false, reason: 'Only a super admin can assign an administrative role.' };
  }
  const grants = await db.many('SELECT permission, scope FROM role_permissions WHERE role_id = $1', [role.id]);
  const check = rbac.canGrant(actor.perms, actor.isSuper, grants);
  if (!check.ok) return { ok: false, reason: check.reason };
  return { ok: true, role };
}

/**
 * Some operations move a whole school's records at once. For those, being
 * signed in is not enough — the sign-in has to be recent.
 *
 * The realistic attack on an administrator is a stolen session, not a guessed
 * password. A cookie lifted from a shared staff laptop stays valid for hours;
 * requiring a fresh sign-in means it cannot be spent on a bulk export.
 *
 * Responds 403 with `code: 'reauth_required'` so the console can send the
 * person through Google again rather than showing a dead end.
 */
async function requireFreshSession(req, res, minutes = 30) {
  const actor = req.actor;
  if (!actor) { res.status(401).json({ error: 'Please sign in.' }); return false; }

  const row = await db.one(
    `SELECT created_at < now() - ($2 || ' minutes')::interval AS stale
       FROM sessions WHERE id = $1`,
    [actor.sessionId, String(minutes)]);

  if (!row || row.stale) {
    res.status(403).json({
      error: 'This needs a fresh sign-in. Sign in again and it will carry straight on.',
      code: 'reauth_required',
    });
    return false;
  }
  return true;
}

// Restore is not a permission any school-level role can carry. It lives with
// the platform admins, alongside the ability to grant platform admin itself.
function requirePlatformAdmin(req, res, what = 'This') {
  const actor = requireActor(req, res);
  if (!actor) return null;
  if (!actor.isSuper) {
    res.status(403).json({
      error: `${what} is reserved to super admins. A local admin can download a backup and undo a roster import, but not apply an uploaded file to the school.`,
    });
    return null;
  }
  return actor;
}

module.exports = {
  requireActor, requirePerm, tenantScope, canManageUser, canAssignRole,
  requireFreshSession, requirePlatformAdmin,
};
