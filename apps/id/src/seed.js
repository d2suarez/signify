// ===================================================================
// Signify ID — built-in roles
// Run at every boot so a new app's permissions appear in existing roles
// without anyone having to remember. Custom roles are never touched.
// ===================================================================

const db = require('./db');
const rbac = require('./rbac');

async function ensureBuiltins() {
  let added = 0;
  let skipped = [];
  for (const def of rbac.BUILTIN_ROLES) {
    const existing = await db.one(
      'SELECT id, customised FROM roles WHERE key = $1 AND tenant_id IS NULL', [def.key]);

    if (!existing) {
      await db.tx(async (client) => {
        const r = await client.query(
          `INSERT INTO roles (tenant_id, key, label, description, builtin, is_admin, sort_order)
           VALUES (NULL,$1,$2,$3,true,$4,$5) RETURNING id`,
          [def.key, def.label, def.description, def.is_admin, def.sort_order]);
        for (const g of def.permissions) {
          await client.query('INSERT INTO role_permissions (role_id, permission, scope) VALUES ($1,$2,$3)', [r.rows[0].id, g.permission, g.scope]);
        }
      });
      added += 1;
      continue;
    }

    // A super admin has deliberately changed this one. Leave it exactly as
    // they left it — silently reverting an administrator's decision on the
    // next deploy would be far worse than the role missing a new permission,
    // and the console shows which roles are in this state.
    if (existing.customised) { skipped.push(def.key); continue; }

    // Otherwise keep the label and grants in step with the code, so an added
    // app's permissions reach every school's teachers on the next deploy.
    await db.tx(async (client) => {
      await client.query(
        'UPDATE roles SET label = $2, description = $3, is_admin = $4, sort_order = $5 WHERE id = $1',
        [existing.id, def.label, def.description, def.is_admin, def.sort_order]);
      await client.query('DELETE FROM role_permissions WHERE role_id = $1', [existing.id]);
      for (const g of def.permissions) {
        await client.query('INSERT INTO role_permissions (role_id, permission, scope) VALUES ($1,$2,$3)', [existing.id, g.permission, g.scope]);
      }
    });
  }
  if (added) console.log(`Seeded ${added} built-in role(s).`);
  if (skipped.length) {
    console.log(`Left ${skipped.length} customised built-in role(s) alone: ${skipped.join(', ')}.`);
  }
  return added;
}

/**
 * Puts one built-in role back to its definition in code and clears the
 * customised mark, so it starts receiving new permissions again.
 */
async function resetBuiltin(key) {
  const def = rbac.BUILTIN_ROLES.find((r) => r.key === key);
  if (!def) return { ok: false, error: 'That is not a built-in role.' };

  const role = await db.one('SELECT id FROM roles WHERE key = $1 AND tenant_id IS NULL', [key]);
  if (!role) return { ok: false, error: 'That role no longer exists.' };

  await db.tx(async (client) => {
    await client.query(
      `UPDATE roles SET label = $2, description = $3, is_admin = $4, sort_order = $5,
                        customised = false, customised_at = NULL, customised_by = NULL
        WHERE id = $1`,
      [role.id, def.label, def.description, def.is_admin, def.sort_order]);
    await client.query('DELETE FROM role_permissions WHERE role_id = $1', [role.id]);
    for (const g of def.permissions) {
      await client.query('INSERT INTO role_permissions (role_id, permission, scope) VALUES ($1,$2,$3)',
        [role.id, g.permission, g.scope]);
    }
  });

  return { ok: true, roleId: role.id, permissions: def.permissions };
}

// What the code says a built-in should hold, for showing a school how its
// edited role differs from the default.
function defaultsFor(key) {
  const def = rbac.BUILTIN_ROLES.find((r) => r.key === key);
  return def ? { label: def.label, description: def.description, permissions: def.permissions } : null;
}

if (require.main === module) {
  ensureBuiltins()
    .then(() => db.pool.end())
    .catch((e) => { console.error('Seed failed:', e.message); process.exit(1); });
}

module.exports = { ensureBuiltins, resetBuiltin, defaultsFor };
