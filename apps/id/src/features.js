// ===================================================================
// Signify ID — app features, and which roles get them at each school
//
// An app declares its features (Teacher's Desk: its tools) the way it
// declares its permissions, and each one says whether students get it by
// default. A school then turns any feature on or off for any of its roles.
//
// The rule when a school has not decided:
//   - the built-in student role gets only what the app marked `students`
//   - every other role gets everything
// so a new feature reaches staff straight away and never reaches students
// until the app's author, or the school, says it should.
//
// Only a school's departures from those defaults are stored, in
// tenants.settings.app_features[client_id][role_key][feature_key]. A school
// that has never opened the page stores nothing and follows the app.
// ===================================================================

const db = require('./db');

const STUDENT_ROLE = 'student';
const MAX_FEATURES = 100;
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** Checks and tidies an app's declaration. Rejects the whole list on any fault. */
function clean(features) {
  if (!Array.isArray(features)) return { ok: false, error: 'Send a features array.' };
  if (features.length > MAX_FEATURES) return { ok: false, error: `An app may declare at most ${MAX_FEATURES} features.` };
  const seen = new Set();
  const out = [];
  for (const f of features) {
    const key = String((f && f.key) || '').trim().toLowerCase();
    const label = String((f && f.label) || '').trim();
    if (!KEY_RE.test(key)) return { ok: false, error: `"${key}" is not a valid feature key. Use lower-case letters, numbers, - and _.` };
    if (label.length < 2) return { ok: false, error: `"${key}" needs a label an administrator can understand.` };
    if (seen.has(key)) return { ok: false, error: `"${key}" is declared twice.` };
    seen.add(key);
    out.push({
      key,
      label: label.slice(0, 80),
      description: String((f && f.description) || '').trim().slice(0, 200),
      group: String((f && f.group) || '').trim().slice(0, 40),
      // Off unless the app says so. A feature an app forgets to mark stays
      // away from students, which is the safe way to be wrong.
      students: f && f.students === true,
    });
  }
  return { ok: true, features: out };
}

async function declare(app, features) {
  const c = clean(features);
  if (!c.ok) return c;
  await db.query('UPDATE apps SET features = $2::jsonb WHERE id = $1', [app.id, JSON.stringify(c.features)]);
  return { ok: true, declared: c.features.map((f) => f.key) };
}

/** What a role gets when the school has not said: see the header. */
const byDefault = (feature, roleKey) => (roleKey === STUDENT_ROLE ? !!feature.students : true);

/**
 * Every role's effective features for one app at one school.
 * `overrides` is that school's stored map for the app ({ role: { feature: bool } }).
 */
function resolve(features, roleKeys, overrides) {
  const out = {};
  for (const role of roleKeys) {
    const mine = (overrides && overrides[role]) || {};
    out[role] = {};
    for (const f of features) {
      out[role][f.key] = typeof mine[f.key] === 'boolean' ? mine[f.key] : byDefault(f, role);
    }
  }
  return out;
}

/**
 * Turns a role's ticked list into what is stored: only the features that
 * differ from the default, and only features the app still declares.
 */
function diff(features, roleKey, allowed) {
  const out = {};
  for (const f of features) {
    if (!allowed || typeof allowed[f.key] !== 'boolean') continue;
    if (allowed[f.key] !== byDefault(f, roleKey)) out[f.key] = allowed[f.key];
  }
  return out;
}

/** The roles a school can set: the built-ins plus its own. */
async function rolesFor(tenantId) {
  return db.many(
    `SELECT key, label, builtin, sort_order FROM roles
      WHERE tenant_id IS NULL OR tenant_id = $1
      ORDER BY sort_order, label`, [tenantId]);
}

async function overridesFor(tenantId, clientId) {
  const t = await db.one('SELECT settings FROM tenants WHERE id = $1', [tenantId]).catch(() => null);
  const all = (t && t.settings && t.settings.app_features) || {};
  return all[clientId] || {};
}

/**
 * What an app needs at one school: its features, and for each role there
 * which ones it gets. Role keys are the ones tokens carry in `role`.
 */
async function forTenant(tenantId, app) {
  const features = Array.isArray(app.features) ? app.features : [];
  const roles = await rolesFor(tenantId);
  const overrides = await overridesFor(tenantId, app.client_id);
  return {
    features,
    roles: resolve(features, roles.map((r) => r.key), overrides),
    defaults: resolve(features, [STUDENT_ROLE, '*'], {}),
  };
}

/** Saves one role's choices for one app, as differences from the default. */
async function save(tenantId, app, roleKey, allowed) {
  const features = Array.isArray(app.features) ? app.features : [];
  const stored = diff(features, roleKey, allowed);
  await db.query(
    `UPDATE tenants SET settings = jsonb_set(
         jsonb_set(settings, '{app_features}', COALESCE(settings->'app_features', '{}'::jsonb)),
         ARRAY['app_features', $2::text],
         COALESCE(settings->'app_features'->$2::text, '{}'::jsonb) || jsonb_build_object($3::text, $4::jsonb)),
       updated_at = now()
     WHERE id = $1`,
    [tenantId, app.client_id, roleKey, JSON.stringify(stored)]);
  return stored;
}

module.exports = { STUDENT_ROLE, clean, declare, byDefault, resolve, diff, rolesFor, overridesFor, forTenant, save };
