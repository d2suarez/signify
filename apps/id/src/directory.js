// ===================================================================
// Signify ID — looking someone up to put them in a class
//
// Adding a person to a class used to mean typing their address exactly.
// That is fine for a pasted column of addresses and miserable for the one
// case that actually happens — a teacher adding a colleague they know by
// name. This is the narrow search behind that box.
//
// Narrow on purpose. It only ever returns people who already hold a
// membership in the school the class belongs to, it never returns anyone
// already on the roster, and it carries only what the roster dialog puts on
// screen anyway: name, address, school role. A directory search inside your
// own school is not a disclosure, so it is not logged as one — reading the
// roster itself still is.
// ===================================================================

const db = require('./db');

const MAX = 8;

// A blank query returns nothing rather than the whole school. The box is a
// search, not a browse: an accidental focus should not spill 400 children.
//
// Holding a membership in the class's school is the whole test, and it is the
// same one the add applies — a person the search offers is a person the add
// accepts. That deliberately includes pending members, who are exactly the
// people a roster import has just created and nobody has signed in as yet.
//
// Addresses are matched on the part before the @, because every address at a
// school shares its domain — matching the whole thing made "de" return every
// child at demo.edu. A term containing an @ is taken as an address and matched
// whole, so pasting one still finds its owner.
async function classCandidates({ tenantId, classId, q, limit = MAX }) {
  const term = String(q || '').trim().toLowerCase();
  if (term.length < 2) return [];

  const safe = term.replace(/[%_\\]/g, (c) => '\\' + c);
  const like = '%' + safe + '%';
  return db.many(
    `SELECT u.id, u.display_name, u.email, u.picture_url,
            r.label AS role_label, r.key AS role_key
       FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.tenant_id = $1
       LEFT JOIN roles r ON r.id = m.role_id
      WHERE u.deleted_at IS NULL
        AND (lower(u.display_name) LIKE $2 ESCAPE '\\'
             OR (CASE WHEN $7 THEN u.email ELSE split_part(u.email, '@', 1) END)
                LIKE $2 ESCAPE '\\')
        AND NOT EXISTS (
          SELECT 1 FROM class_members cm
           WHERE cm.class_id = $3 AND cm.user_id = u.id)
      ORDER BY
        CASE WHEN u.email = $4 THEN 0
             WHEN lower(u.display_name) LIKE $5 ESCAPE '\\' THEN 1
             WHEN split_part(u.email, '@', 1) LIKE $5 ESCAPE '\\' THEN 2
             ELSE 3 END,
        u.display_name
      LIMIT $6`,
    [tenantId, like, classId, term, safe + '%', Math.min(Number(limit) || MAX, 25), term.includes('@')]
  );
}

module.exports = { classCandidates, MAX };
