// ===================================================================
// Signify ID — a practice class, so a teacher can see the student and
// parent side of the apps before there is any real data
//
// It lives in the real school, because that is where the apps already are:
// Signify Learning is turned on per school, and a person belongs to one
// school at a time, so a separate demo school would mean moving the teacher
// and the test accounts out of their own school to look at it.
//
// What it makes, all in one place so it can be taken away again:
//   - a class "Practice — Demo class", taught by the named teacher
//   - four made-up students on practice.invalid addresses, which no one can
//     ever sign in with (.invalid is reserved and never resolves)
//   - the named test accounts as one student and one parent in that class,
//     the parent linked (verified) to the test student and one made-up one
//
// Everything made or changed is written down in tenants.settings.practice,
// so `remove` undoes exactly that: made-up students deleted, the class
// deleted, links removed, a test account's earlier role put back, and an
// account made here removed unless it has since been signed in to.
//
// Run it from the console (super admins: Practice class) or the command
// line:
//   node src/practice.js setup --school "Richmond Academy" --teacher t@x \
//        --student s@x --parent p@x [--make-student]
//   node src/practice.js status --school "Richmond Academy"
//   node src/practice.js remove --school "Richmond Academy"
// ===================================================================

const db = require('./db');
const identity = require('./identity');
const names = require('./names');

const CLASS_NAME = 'Practice — Demo class';
const FAKE_DOMAIN = 'practice.invalid';
const FAKES = [
  { given: 'Pip', family: 'Example' },
  { given: 'Quinn', family: 'Sample' },
  { given: 'Rory', family: 'Placeholder' },
  { given: 'Sky', family: 'Testwell' },
];
const fakeEmail = (f) => `${f.given}.${f.family}@${FAKE_DOMAIN}`.toLowerCase();

async function tenantByName(name) {
  return db.one(
    `SELECT * FROM tenants WHERE (lower(name) = lower($1) OR slug = lower($1) OR id::text = $1) AND kind = 'school'`,
    [String(name || '').trim()]);
}

async function roleId(q, key) {
  return (await q.query('SELECT id FROM roles WHERE key = $1 AND tenant_id IS NULL', [key])).rows[0].id;
}

async function status(tenantId) {
  const t = await db.one('SELECT id, name, settings FROM tenants WHERE id = $1', [tenantId]);
  if (!t) return null;
  const p = (t.settings && t.settings.practice) || null;
  if (!p) return { tenant: { id: t.id, name: t.name }, active: false };
  const cls = p.classId ? await db.one('SELECT id, name FROM classes WHERE id = $1', [p.classId]) : null;
  const members = cls ? await db.many(
    `SELECT u.display_name, u.email, cm.role FROM class_members cm JOIN users u ON u.id = cm.user_id
      WHERE cm.class_id = $1 ORDER BY cm.role DESC, u.display_name`, [cls.id]) : [];
  return {
    tenant: { id: t.id, name: t.name }, active: true, classId: cls ? cls.id : null, className: cls ? cls.name : null,
    members, teacher: p.teacherEmail, student: p.studentEmail, parent: p.parentEmail, createdAt: p.createdAt,
  };
}

/**
 * Makes the practice class, or brings it up to date if it is already there.
 * Refuses rather than surprises: the test student must be able to become a
 * student, and a test account that holds another role there only becomes
 * one with makeStudent (and gets its old role back on remove).
 */
async function setup({ tenantId, teacherEmail, studentEmail, parentEmail, makeStudent = false, actorId = null }) {
  const teacherKey = identity.lower(teacherEmail);
  const studentKey = identity.lower(studentEmail);
  const parentKey = identity.lower(parentEmail);
  const valid = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
  if (![teacherKey, studentKey, parentKey].every(valid)) return { ok: false, error: 'Give a teacher, a student and a parent email address.' };
  if (new Set([teacherKey, studentKey, parentKey]).size < 3) return { ok: false, error: 'The teacher, student and parent must be three different accounts.' };
  if ([teacherKey, studentKey, parentKey].some((e) => e.endsWith('@' + FAKE_DOMAIN))) return { ok: false, error: 'Use real test accounts, not practice.invalid ones.' };

  const tenant = await db.one('SELECT * FROM tenants WHERE id = $1', [tenantId]);
  if (!tenant || tenant.kind !== 'school') return { ok: false, error: 'Choose a school.' };
  const prev = (tenant.settings && tenant.settings.practice) || {};

  const memberOf = async (q, email) => (await q.query(
    `SELECT u.id AS user_id, u.email, m.id AS membership_id, r.key AS role_key, m.role_id,
            (SELECT COUNT(*) FROM identities i WHERE i.user_id = u.id) AS identities
       FROM users u LEFT JOIN memberships m ON m.user_id = u.id AND m.tenant_id = $2
       LEFT JOIN roles r ON r.id = m.role_id
      WHERE u.email = $1 AND u.deleted_at IS NULL`, [email, tenantId])).rows[0] || null;

  // Checks before anything is written.
  const teacher = await memberOf(db, teacherKey);
  if (!teacher || !teacher.membership_id) return { ok: false, error: `${teacherKey} is not a member of ${tenant.name}.` };
  const stu = await memberOf(db, studentKey);
  if (stu && !stu.membership_id) {
    const elsewhere = await db.one('SELECT 1 FROM memberships WHERE user_id = $1', [stu.user_id]);
    if (elsewhere) return { ok: false, error: `${studentKey} belongs to another school. Move them first, or use another account.` };
  }
  if (stu && stu.membership_id && stu.role_key !== 'student' && !makeStudent && prev.studentEmail !== studentKey) {
    return { ok: false, error: `${studentKey} is a ${stu.role_key} at ${tenant.name}. Tick "make them a student" to change that for the practice class; removing the class puts the old role back.` };
  }
  const par = await memberOf(db, parentKey);
  if (par && !par.membership_id) {
    const elsewhere = await db.one('SELECT 1 FROM memberships WHERE user_id = $1', [par.user_id]);
    if (elsewhere) return { ok: false, error: `${parentKey} belongs to another school. Move them first, or use another account.` };
  }
  if (par && par.role_key === 'student') return { ok: false, error: `${parentKey} is a student, so it cannot be the practice parent.` };

  const result = await db.tx(async (q) => {
    const manifest = {
      classId: prev.classId || null,
      fakeUserIds: prev.fakeUserIds || [],
      linkIds: prev.linkIds || [],
      createdUserIds: prev.createdUserIds || [],
      createdMembershipIds: prev.createdMembershipIds || [],
      restoreRoles: prev.restoreRoles || [],
      teacherEmail: teacherKey, studentEmail: studentKey, parentEmail: parentKey,
      createdAt: prev.createdAt || new Date().toISOString(),
    };
    const studentRole = await roleId(q, 'student');
    const guardianRole = await roleId(q, 'guardian');

    // The class.
    let cls = manifest.classId ? (await q.query('SELECT id FROM classes WHERE id = $1 AND tenant_id = $2', [manifest.classId, tenantId])).rows[0] : null;
    if (!cls) {
      cls = (await q.query(
        `INSERT INTO classes (tenant_id, name, subject, grade_levels, school_year, created_by)
         VALUES ($1,$2,'Practice', ARRAY[]::text[], $3, $4) RETURNING id`,
        [tenantId, CLASS_NAME, String(new Date().getFullYear()), actorId])).rows[0];
      manifest.classId = cls.id;
    }
    const place = (userId, role) => q.query(
      `INSERT INTO class_members (class_id, user_id, role) VALUES ($1,$2,$3)
       ON CONFLICT (class_id, user_id) DO UPDATE SET role = EXCLUDED.role`, [cls.id, userId, role]);

    await place(teacher.user_id, 'teacher');

    // Made-up students, with official names so the FACTS list has something
    // to sort.
    const fakeIds = [];
    for (const f of FAKES) {
      const email = fakeEmail(f);
      let u = (await q.query('SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL', [email])).rows[0];
      if (!u) {
        u = (await q.query(
          `INSERT INTO users (email, display_name, status, is_minor, minor_source, display_name_source)
           VALUES ($1,$2,'active', false, 'admin_set', 'school') RETURNING id`,
          [email, `${f.given} ${f.family} (practice)`])).rows[0];
        await q.query(
          `INSERT INTO memberships (user_id, tenant_id, role_id, status, added_by) VALUES ($1,$2,$3,'active',$4)`,
          [u.id, tenantId, studentRole, actorId]);
      }
      await names.writeOfficial(q, { userId: u.id, tenantId, official: { given: f.given, middle: '', family: f.family, suffix: '' }, source: 'admin', actorId });
      await place(u.id, 'student');
      fakeIds.push(u.id);
    }
    manifest.fakeUserIds = [...new Set([...manifest.fakeUserIds, ...fakeIds])];

    // An account the test person will sign in to later: made here if it is
    // not there yet, and claimed on their first Google sign-in.
    const ensure = async (email, existing, roleKey, roleIdWanted, label) => {
      let userId = existing && existing.user_id;
      if (!userId) {
        userId = (await q.query(
          `INSERT INTO users (email, display_name, status, is_minor, minor_source) VALUES ($1,$2,'active', false, 'admin_set') RETURNING id`,
          [email, label])).rows[0].id;
        manifest.createdUserIds.push(userId);
      }
      if (!existing || !existing.membership_id) {
        const m = (await q.query(
          `INSERT INTO memberships (user_id, tenant_id, role_id, status, added_by) VALUES ($1,$2,$3,'active',$4) RETURNING id`,
          [userId, tenantId, roleIdWanted, actorId])).rows[0];
        manifest.createdMembershipIds.push(m.id);
      } else if (roleKey && existing.role_key !== roleKey) {
        if (!manifest.restoreRoles.some((r) => r.membershipId === existing.membership_id)) {
          manifest.restoreRoles.push({ membershipId: existing.membership_id, roleId: existing.role_id });
        }
        await q.query('UPDATE memberships SET role_id = $2, updated_at = now() WHERE id = $1', [existing.membership_id, roleIdWanted]);
      }
      return userId;
    };
    const studentId = await ensure(studentKey, stu, 'student', studentRole, 'Practice student');
    await place(studentId, 'student');
    // The parent keeps whatever non-student role they already hold.
    const parentId = await ensure(parentKey, par, null, guardianRole, 'Practice parent');

    for (const childId of [studentId, fakeIds[0]]) {
      const have = (await q.query('SELECT id FROM guardian_links WHERE guardian_id = $1 AND student_id = $2', [parentId, childId])).rows[0];
      if (have) continue;
      const link = (await q.query(
        `INSERT INTO guardian_links (guardian_id, student_id, tenant_id, relationship, verified_at, verified_by)
         VALUES ($1,$2,$3,'parent', now(), $4) RETURNING id`, [parentId, childId, tenantId, actorId])).rows[0];
      manifest.linkIds.push(link.id);
    }

    await q.query(
      `UPDATE tenants SET settings = jsonb_set(settings, '{practice}', $2::jsonb), updated_at = now() WHERE id = $1`,
      [tenantId, JSON.stringify(manifest)]);
    return { classId: cls.id, studentId, parentId, fakeIds };
  });
  return { ok: true, ...result, className: CLASS_NAME };
}

async function remove({ tenantId }) {
  const tenant = await db.one('SELECT id, settings FROM tenants WHERE id = $1', [tenantId]);
  const p = tenant && tenant.settings && tenant.settings.practice;
  if (!p) return { ok: false, error: 'There is no practice class here.' };
  const out = await db.tx(async (q) => {
    const counts = {};
    counts.links = (await q.query('DELETE FROM guardian_links WHERE id = ANY($1::uuid[]) AND tenant_id = $2', [p.linkIds || [], tenantId])).rowCount;
    counts.classes = p.classId ? (await q.query('DELETE FROM classes WHERE id = $1 AND tenant_id = $2', [p.classId, tenantId])).rowCount : 0;
    // Only ever a practice.invalid address: nobody real can be deleted here.
    counts.fakeStudents = (await q.query(
      `DELETE FROM users WHERE id = ANY($1::uuid[]) AND email LIKE $2`, [p.fakeUserIds || [], '%@' + FAKE_DOMAIN])).rowCount;
    for (const r of p.restoreRoles || []) {
      await q.query('UPDATE memberships SET role_id = $2, updated_at = now() WHERE id = $1', [r.membershipId, r.roleId]);
    }
    counts.rolesRestored = (p.restoreRoles || []).length;
    // Accounts made here go, unless someone has signed in to them since;
    // then only the place in the school made here goes.
    counts.accounts = (await q.query(
      `DELETE FROM users u WHERE u.id = ANY($1::uuid[])
          AND NOT EXISTS (SELECT 1 FROM identities i WHERE i.user_id = u.id)`, [p.createdUserIds || []])).rowCount;
    counts.memberships = (await q.query('DELETE FROM memberships WHERE id = ANY($1::uuid[])', [p.createdMembershipIds || []])).rowCount;
    await q.query(`UPDATE tenants SET settings = settings - 'practice', updated_at = now() WHERE id = $1`, [tenantId]);
    return counts;
  });
  return { ok: true, removed: out };
}

module.exports = { setup, remove, status, tenantByName, CLASS_NAME, FAKE_DOMAIN, FAKES };

// ---------- command line ----------

if (require.main === module) {
  const arg = (name) => {
    const i = process.argv.indexOf('--' + name);
    return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null;
  };
  const cmd = process.argv[2];
  (async () => {
    await db.migrate();
    const tenant = await tenantByName(arg('school'));
    if (!tenant) throw new Error('Name the school with --school "Richmond Academy".');
    const audit = require('./audit');
    let result;
    if (cmd === 'setup') {
      result = await setup({ tenantId: tenant.id, teacherEmail: arg('teacher'), studentEmail: arg('student'),
        parentEmail: arg('parent'), makeStudent: process.argv.includes('--make-student') });
      if (result.ok) await audit.record({ tenantId: tenant.id, action: 'practice.setup', targetType: 'class', targetId: result.classId, detail: { via: 'cli' } });
    } else if (cmd === 'remove') {
      result = await remove({ tenantId: tenant.id });
      if (result.ok) await audit.record({ tenantId: tenant.id, action: 'practice.removed', targetType: 'tenant', targetId: tenant.id, detail: { via: 'cli', ...result.removed } });
    } else if (cmd === 'status') {
      result = await status(tenant.id);
    } else {
      throw new Error('Use: node src/practice.js setup|status|remove --school "<name>" [--teacher e --student e --parent e --make-student]');
    }
    console.log(JSON.stringify(result, null, 2));
    process.exit(result && result.ok === false ? 1 : 0);
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
