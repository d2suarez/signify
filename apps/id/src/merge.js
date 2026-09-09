// ===================================================================
// Signify ID — merging two accounts
//
// The case this exists for: somebody signed in with a personal address before
// their school account existed, and now has two records with work under each.
//
// Merging is the one operation here that genuinely cannot be undone — two
// rows become one and the original split is gone. So it previews first, says
// plainly what it will move, and refuses the combinations that would be a
// mistake rather than a merge.
// ===================================================================

const db = require('./db');
const guards = require('./guards');

// Everything that points at a user. Ordered so that rows which can collide on
// a primary key are handled explicitly rather than by hoping.
const SIMPLE_REFS = [
  ['identities', 'user_id'],
  ['classes', 'created_by'],
  ['guardian_links', 'guardian_id'],
  ['guardian_links', 'student_id'],
  ['consents', 'subject_user_id'],
  ['backups', 'created_by'],
  ['roster_imports', 'created_by'],
  ['roster_imports', 'undone_by'],
  ['memberships', 'added_by'],
  ['roles', 'customised_by'],
  ['user_app_access', 'set_by'],
  ['audit_log', 'actor_user_id'],
  ['platform_admins', 'granted_by'],
];

async function load(id) {
  return db.one(
    `SELECT u.*,
            (SELECT 1 FROM platform_admins p WHERE p.user_id = u.id) AS is_platform_admin,
            (SELECT COUNT(*) FROM identities i WHERE i.user_id = u.id) AS identities,
            (SELECT COUNT(*) FROM memberships m WHERE m.user_id = u.id) AS memberships,
            (SELECT COUNT(*) FROM class_members c WHERE c.user_id = u.id) AS classes
       FROM users u WHERE u.id = $1`, [id]);
}

/**
 * What merging `fromId` into `keepId` would do. Never writes.
 */
async function preview({ keepId, fromId, actor }) {
  if (keepId === fromId) return { ok: false, error: 'Those are the same account.' };

  const keep = await load(keepId);
  const from = await load(fromId);
  if (!keep || !from) return { ok: false, error: 'One of those accounts no longer exists.' };

  // A merge rewrites who somebody is. Neither side may be a platform admin,
  // and an ordinary administrator may only merge people they could already
  // manage — which the existing guard already answers correctly.
  if (keep.is_platform_admin || from.is_platform_admin) {
    return { ok: false, error: 'Super admin accounts cannot be merged. Remove the platform role first if this is really intended.' };
  }
  for (const id of [keepId, fromId]) {
    const can = await guards.canManageUser(actor, id);
    if (!can.ok) return { ok: false, error: can.reason };
  }
  if (from.deleted_at) {
    return { ok: false, error: 'That account has been erased. Restore it first if its records should be kept.' };
  }

  // What would actually move.
  const moving = {};
  for (const [table, column] of SIMPLE_REFS) {
    const row = await db.one(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = $1`, [fromId]);
    if (Number(row.n)) moving[`${table}.${column}`] = Number(row.n);
  }

  // Memberships and class places can collide: the keeper may already be in
  // the same school or class. Those are dropped rather than duplicated.
  const membershipsMoved = await db.many(
    `SELECT t.name FROM memberships m JOIN tenants t ON t.id = m.tenant_id
      WHERE m.user_id = $1 AND m.tenant_id NOT IN (SELECT tenant_id FROM memberships WHERE user_id = $2)`,
    [fromId, keepId]);
  const membershipsDropped = await db.many(
    `SELECT t.name FROM memberships m JOIN tenants t ON t.id = m.tenant_id
      WHERE m.user_id = $1 AND m.tenant_id IN (SELECT tenant_id FROM memberships WHERE user_id = $2)`,
    [fromId, keepId]);
  const classesMoved = await db.one(
    `SELECT COUNT(*) AS n FROM class_members
      WHERE user_id = $1 AND class_id NOT IN (SELECT class_id FROM class_members WHERE user_id = $2)`,
    [fromId, keepId]);

  return {
    ok: true,
    keep: { id: keep.id, email: keep.email, name: keep.display_name, identities: Number(keep.identities) },
    from: { id: from.id, email: from.email, name: from.display_name, identities: Number(from.identities) },
    moving,
    membershipsMoved: membershipsMoved.map((r) => r.name),
    membershipsDropped: membershipsDropped.map((r) => r.name),
    classesMoved: Number(classesMoved.n),
    warnings: [
      'This cannot be undone. The two records become one, and which was which is not recoverable.',
      `Sign-ins from ${from.email} will land on the kept account from now on.`,
      Number(from.identities) && Number(keep.identities)
        ? 'Both accounts have been signed in to. Afterwards either address reaches the same records.'
        : null,
    ].filter(Boolean),
  };
}

/**
 * Performs the merge. Everything moves to the keeper; the other record is
 * deleted. One transaction, so a failure leaves both accounts untouched.
 */
async function merge({ keepId, fromId, actor, confirmEmail = '' }) {
  const pre = await preview({ keepId, fromId, actor });
  if (!pre.ok) return pre;

  // Deliberate friction, enforced here rather than only in the browser.
  if (String(confirmEmail).trim().toLowerCase() !== pre.from.email.toLowerCase()) {
    return { ok: false, error: `To confirm, type the address of the account being merged away: ${pre.from.email}` };
  }

  const result = await db.tx(async (client) => {
    // Places the keeper already occupies — drop the duplicate rather than
    // violating the primary key.
    await client.query(
      `DELETE FROM memberships WHERE user_id = $1
        AND tenant_id IN (SELECT tenant_id FROM memberships WHERE user_id = $2)`, [fromId, keepId]);
    await client.query(
      `DELETE FROM class_members WHERE user_id = $1
        AND class_id IN (SELECT class_id FROM class_members WHERE user_id = $2)`, [fromId, keepId]);
    await client.query(
      `DELETE FROM user_app_access WHERE user_id = $1
        AND app_id IN (SELECT app_id FROM user_app_access WHERE user_id = $2)`, [fromId, keepId]);
    await client.query(
      `DELETE FROM guardian_links WHERE (guardian_id = $1 AND student_id IN (SELECT student_id FROM guardian_links WHERE guardian_id = $2))
                                     OR (student_id = $1 AND guardian_id IN (SELECT guardian_id FROM guardian_links WHERE student_id = $2))`,
      [fromId, keepId]);
    // An open request on the losing account is meaningless once merged.
    await client.query('DELETE FROM access_requests WHERE user_id = $1', [fromId]);

    let moved = 0;
    for (const [table, column] of [...SIMPLE_REFS, ['memberships', 'user_id'], ['class_members', 'user_id'], ['user_app_access', 'user_id']]) {
      const r = await client.query(`UPDATE ${table} SET ${column} = $2 WHERE ${column} = $1`, [fromId, keepId]);
      moved += r.rowCount || 0;
    }

    // Sessions and tokens are not moved — they belong to a sign-in that no
    // longer means anything. Deleting the row takes them with it.
    await client.query('DELETE FROM users WHERE id = $1', [fromId]);

    return { moved };
  });

  return {
    ok: true,
    ...result,
    keptEmail: pre.keep.email,
    mergedEmail: pre.from.email,
  };
}

module.exports = { preview, merge };
