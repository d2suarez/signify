// ===================================================================
// Signify ID — parents and guardians
//
// Which adult is a student's parent or guardian, at which school. A link is
// an access-granting claim (an app that trusts it shows that adult a child's
// work and grades), so it is only ever made by the school, on the console's
// Guardians page, and grants nothing until somebody holding
// core:manage_guardians has verified it. Nothing here lets a parent claim a
// child for themselves.
// ===================================================================

const db = require('./db');

const RELATIONSHIPS = ['parent', 'mother', 'father', 'guardian', 'grandparent', 'carer', 'other'];

const cleanRelationship = (v) => {
  const t = String(v || 'parent').trim().toLowerCase();
  return RELATIONSHIPS.includes(t) ? t : null;
};

// An active member of the school, not deleted, with their role there.
async function member(userId, tenantId) {
  return db.one(
    `SELECT u.id, u.display_name, u.email, r.key AS role_key
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       JOIN roles r ON r.id = m.role_id
      WHERE m.user_id = $1 AND m.tenant_id = $2 AND m.status = 'active' AND u.deleted_at IS NULL`,
    [userId, tenantId]).catch(() => null);
}

/** Everything the console page needs for one school. */
async function overview(tenantId) {
  const [links, guardians, students] = await Promise.all([
    db.many(
      `SELECT g.id, g.relationship, g.created_at, g.verified_at,
              g.guardian_id, gu.display_name AS guardian_name, gu.email AS guardian_email,
              g.student_id, su.display_name AS student_name, su.email AS student_email,
              vu.display_name AS verified_by_name
         FROM guardian_links g
         JOIN users gu ON gu.id = g.guardian_id
         JOIN users su ON su.id = g.student_id
         LEFT JOIN users vu ON vu.id = g.verified_by
        WHERE g.tenant_id = $1 AND gu.deleted_at IS NULL AND su.deleted_at IS NULL
        ORDER BY su.display_name, gu.display_name`, [tenantId]),
    // Anyone at the school except its students may be a parent: a teacher can
    // have a child in the school too.
    db.many(
      `SELECT u.id, u.display_name AS name, u.email, r.key AS role_key, r.label AS role_label
         FROM memberships m JOIN users u ON u.id = m.user_id JOIN roles r ON r.id = m.role_id
        WHERE m.tenant_id = $1 AND m.status = 'active' AND u.deleted_at IS NULL AND r.key <> 'student'
        ORDER BY (r.key = 'guardian') DESC, u.display_name`, [tenantId]),
    db.many(
      `SELECT u.id, u.display_name AS name, u.email, m.grade_level
         FROM memberships m JOIN users u ON u.id = m.user_id JOIN roles r ON r.id = m.role_id
        WHERE m.tenant_id = $1 AND m.status = 'active' AND u.deleted_at IS NULL AND r.key = 'student'
        ORDER BY u.display_name`, [tenantId]),
  ]);
  return { links, guardians, students, relationships: RELATIONSHIPS };
}

/**
 * Record that `guardianId` is `studentId`'s parent at this school. Verified at
 * once when `verify` is set, which is the usual case: the person making the
 * link is the person who checked it.
 */
async function link({ tenantId, guardianId, studentId, relationship, verify, actorId }) {
  const rel = cleanRelationship(relationship);
  if (!rel) return { ok: false, error: 'Choose how they are related.' };
  if (!guardianId || !studentId) return { ok: false, error: 'Choose a parent and a student.' };
  if (guardianId === studentId) return { ok: false, error: 'Someone cannot be their own parent.' };

  const [g, s] = await Promise.all([member(guardianId, tenantId), member(studentId, tenantId)]);
  if (!g) return { ok: false, error: 'That parent does not have an account at this school. Add them on the People page first.' };
  if (g.role_key === 'student') return { ok: false, error: 'A student cannot be linked as a parent.' };
  if (!s || s.role_key !== 'student') return { ok: false, error: 'That person is not a student at this school.' };

  const existing = await db.one(
    'SELECT id, tenant_id FROM guardian_links WHERE guardian_id = $1 AND student_id = $2', [guardianId, studentId]);
  if (existing) return { ok: false, error: 'Those two are already linked.' };

  const row = await db.one(
    `INSERT INTO guardian_links (guardian_id, student_id, tenant_id, relationship, verified_at, verified_by)
     VALUES ($1,$2,$3,$4, CASE WHEN $5::boolean THEN now() END, CASE WHEN $5::boolean THEN $6::uuid END)
     RETURNING id, verified_at`,
    [guardianId, studentId, tenantId, rel, !!verify, actorId]);
  return { ok: true, id: row.id, verified: !!row.verified_at };
}

async function verify(id, tenantId, actorId) {
  const row = await db.one(
    `UPDATE guardian_links SET verified_at = now(), verified_by = $3
      WHERE id = $1 AND tenant_id = $2 AND verified_at IS NULL
      RETURNING id, guardian_id, student_id`, [id, tenantId, actorId]).catch(() => null);
  return row ? { ok: true, ...row } : { ok: false, error: 'No unverified link like that at this school.' };
}

async function remove(id, tenantId) {
  const row = await db.one(
    'DELETE FROM guardian_links WHERE id = $1 AND tenant_id = $2 RETURNING id, guardian_id, student_id',
    [id, tenantId]).catch(() => null);
  return row ? { ok: true, ...row } : { ok: false, error: 'No such link at this school.' };
}

/**
 * A guardian's verified children at one school, each with the classes they
 * are in. What an app asks before showing a parent anything. Unverified links,
 * links at another school, and children who have left or been deleted all
 * count for nothing.
 */
async function childrenOf(guardianId, tenantId) {
  if (!guardianId || !tenantId) return [];
  const kids = await db.many(
    `SELECT u.id, u.display_name, u.picture_url, g.relationship, m.grade_level
       FROM guardian_links g
       JOIN users u ON u.id = g.student_id
       JOIN memberships m ON m.user_id = g.student_id AND m.tenant_id = g.tenant_id AND m.status = 'active'
       JOIN memberships gm ON gm.user_id = g.guardian_id AND gm.tenant_id = g.tenant_id AND gm.status = 'active'
      WHERE g.guardian_id = $1 AND g.tenant_id = $2 AND g.verified_at IS NOT NULL AND u.deleted_at IS NULL
      ORDER BY u.display_name`, [guardianId, tenantId]);
  if (!kids.length) return [];
  const classes = await db.many(
    `SELECT ca.user_id, c.id, c.name, c.subject, c.school_year
       FROM class_access ca JOIN classes c ON c.id = ca.class_id
      WHERE ca.user_id = ANY($1::uuid[]) AND c.tenant_id = $2 AND c.archived = false AND ca.role = 'student'
      ORDER BY c.name`, [kids.map((k) => k.id), tenantId]);
  return kids.map((k) => ({
    ...k,
    classes: classes.filter((c) => c.user_id === k.id)
      .map((c) => ({ id: c.id, name: c.name, subject: c.subject, school_year: c.school_year })),
  }));
}

module.exports = { RELATIONSHIPS, overview, link, verify, remove, childrenOf };
