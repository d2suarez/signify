// ===================================================================
// Signify ID — the permission catalogue
//
// Two halves. `core:` is defined in code, because it governs identity itself
// and should be reviewable in git rather than editable at runtime. Everything
// else is declared by the app that owns it, so adding a permission to the
// atlas is a change to the atlas, not to this service.
// ===================================================================

const db = require('./db');
const rbac = require('./rbac');

const CACHE_MS = 30_000;
let cache = null;
let cacheAt = 0;

function invalidate() { cache = null; }

/**
 * The full catalogue, shaped exactly like rbac.CATALOG so the console's role
 * editor did not have to change.
 *
 * Code first, then declarations layered on top:
 *   - `core:` always comes from code and can never be declared by an app.
 *   - An app that has declared permissions replaces its code block entirely,
 *     so the app is the authority on its own permissions.
 *   - An app that has not declared anything keeps whatever the code says,
 *     which is what lets the whiteboard, atlas and times tables keep working
 *     before they have been updated to declare.
 */
async function full() {
  if (cache && Date.now() - cacheAt < CACHE_MS) return cache;

  const rows = await db.many(
    `SELECT ap.key, ap.label, ap.description, ap.is_admin,
            a.namespace, a.name AS app_name
       FROM app_permissions ap
       JOIN apps a ON a.id = ap.app_id
      WHERE NOT ap.deprecated
      ORDER BY a.name, ap.key`);

  const declared = new Map();
  for (const r of rows) {
    if (!declared.has(r.namespace)) {
      declared.set(r.namespace, { namespace: r.namespace, label: r.app_name, permissions: [] });
    }
    declared.get(r.namespace).permissions.push({
      key: r.key, label: r.label, description: r.description, admin: r.is_admin,
    });
  }

  const groups = [];
  for (const codeGroup of rbac.CATALOG) {
    if (codeGroup.namespace === 'core') { groups.push(codeGroup); continue; }
    groups.push(declared.get(codeGroup.namespace) || codeGroup);
    declared.delete(codeGroup.namespace);
  }
  // Apps that exist only as declarations — the whole point of the feature.
  for (const g of declared.values()) groups.push(g);

  cache = groups;
  cacheAt = Date.now();
  return cache;
}

// Flat set of every permission that may currently be put into a role.
async function knownKeys() {
  const groups = await full();
  return new Set(groups.flatMap((g) => g.permissions.map((p) => p.key)));
}

async function adminKeys() {
  const groups = await full();
  return new Set(groups.flatMap((g) => g.permissions.filter((p) => p.admin).map((p) => p.key)));
}

async function labels() {
  const groups = await full();
  const out = {};
  for (const g of groups) for (const p of g.permissions) out[p.key] = p.label;
  return out;
}

/**
 * Records what an app says its permissions are.
 *
 * The namespace lock is the whole safety story, so it is checked per key and
 * the whole declaration is rejected on any violation rather than partially
 * applied.
 */
async function declare(app, permissions) {
  if (!Array.isArray(permissions)) {
    return { ok: false, error: 'Send a permissions array.' };
  }
  if (permissions.length > 50) {
    return { ok: false, error: 'An app may declare at most 50 permissions.' };
  }

  const seen = new Set();
  const clean = [];
  for (const p of permissions) {
    const key = String((p && p.key) || '').trim().toLowerCase();
    const label = String((p && p.label) || '').trim();

    if (!/^[a-z0-9]+:[a-z0-9_]+$/.test(key)) {
      return { ok: false, error: `"${key}" is not a valid permission key. Use the form "${app.namespace}:verb".` };
    }
    if (key.split(':')[0] !== app.namespace) {
      return {
        ok: false,
        error: `"${key}" is outside this app's namespace. ${app.name} may only declare permissions beginning "${app.namespace}:".`,
      };
    }
    if (label.length < 3) {
      return { ok: false, error: `"${key}" needs a label an administrator can understand.` };
    }
    if (seen.has(key)) return { ok: false, error: `"${key}" is declared twice.` };
    seen.add(key);

    clean.push({
      key,
      label: label.slice(0, 120),
      description: String((p && p.description) || '').slice(0, 300),
      admin: !!(p && p.admin),
    });
  }

  const result = await db.tx(async (client) => {
    for (const p of clean) {
      await client.query(
        `INSERT INTO app_permissions (key, app_id, label, description, is_admin, deprecated, updated_at)
         VALUES ($1,$2,$3,$4,$5,false, now())
         ON CONFLICT (key) DO UPDATE SET
           label = EXCLUDED.label,
           description = EXCLUDED.description,
           is_admin = EXCLUDED.is_admin,
           deprecated = false,
           updated_at = now()
          WHERE app_permissions.app_id = EXCLUDED.app_id`,
        [p.key, app.id, p.label, p.description, p.admin]);
    }

    // Anything this app declared before and no longer claims is retired, not
    // removed — a role may still hold it.
    const retired = await client.query(
      `UPDATE app_permissions SET deprecated = true, updated_at = now()
        WHERE app_id = $1 AND NOT deprecated AND NOT (key = ANY($2))
        RETURNING key`,
      [app.id, clean.map((p) => p.key)]);

    return { retired: retired.rows.map((r) => r.key) };
  });

  invalidate();
  return { ok: true, declared: clean.map((p) => p.key), retired: result.retired };
}

// Permissions a role holds that no app claims any more, so the console can
// show an administrator why a role has an entry with no label.
async function orphanedIn(grants) {
  const known = await knownKeys();
  return grants.filter((g) => !known.has(g.permission)).map((g) => g.permission);
}

module.exports = { full, knownKeys, adminKeys, labels, declare, invalidate, orphanedIn };
