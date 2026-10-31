// ===================================================================
// Signify ID — a practice class with mock people, so a teacher can see the
// student and parent side of the apps before there is any real data
//
// It lives in the real school, because that is where the apps already are:
// Signify Learning is turned on per school, and a person belongs to one
// school at a time, so a separate demo school would mean moving the teacher
// out of their own school to look at it.
//
// What it makes, all in one place so it can be taken away again:
//   - a class "Practice — Demo class", taught by the named teacher
//   - four mock students and one mock parent (users.is_mock, migration 015)
//     on practice.invalid addresses. A mock has no Google login and can
//     never sign in (identity.resolveUser and sessions.create both refuse
//     it); staff see what it sees through /api/v1/preview with their own
//     sign-in.
//   - the mock parent linked (verified) to two of the mock students
//
// Only the teacher's address is needed: their school is the one they belong
// to. Running it again brings it up to date and makes nothing twice.
//
// Everything made is written down in tenants.settings.practice, so `remove`
// undoes exactly that: the class, the links and the mock people. Nothing
// real is ever changed or removed: only rows that are mocks are deleted.
//
// Run it from the console (super admins: Practice class) or the command
// line:
//   node src/practice.js setup  --teacher t@x [--school "Richmond Academy"]
//   node src/practice.js status --teacher t@x | --school "Richmond Academy"
//   node src/practice.js remove --teacher t@x | --school "Richmond Academy"
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
// Linked to the first two students.
const PARENT = { given: 'Pat', family: 'Example', email: 'pat.example.parent@' + FAKE_DOMAIN };
const fakeEmail = (f) => `${f.given}.${f.family}@${FAKE_DOMAIN}`.toLowerCase();

async function tenantByName(name) {
  return db.one(
    `SELECT * FROM tenants WHERE (lower(name) = lower($1) OR slug = lower($1) OR id::text = $1) AND kind = 'school'`,
    [String(name || '').trim()]);
}

/** The school a teacher belongs to (a person belongs to one school). */
async function tenantOfTeacher(email) {
  return db.one(
    `SELECT t.* FROM users u JOIN memberships m ON m.user_id = u.id JOIN tenants t ON t.id = m.tenant_id
      WHERE u.email = $1 AND u.deleted_at IS NULL AND NOT u.is_mock AND t.kind = 'school'
      ORDER BY m.created_at LIMIT 1`, [identity.lower(email)]);
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
    `SELECT u.id, u.display_name, u.email, u.is_mock, cm.role FROM class_members cm JOIN users u ON u.id = cm.user_id
      WHERE cm.class_id = $1 ORDER BY cm.role DESC, u.display_name`, [cls.id]) : [];
  const parent = p.parentId ? await db.one('SELECT id, display_name FROM users WHERE id = $1 AND is_mock', [p.parentId]) : null;
  const children = parent ? await db.many(
    `SELECT u.display_name FROM guardian_links g JOIN users u ON u.id = g.student_id
      WHERE g.guardian_id = $1 AND g.tenant_id = $2 ORDER BY u.display_name`, [parent.id, tenantId]) : [];
  return {
    tenant: { id: t.id, name: t.name }, active: true, classId: cls ? cls.id : null, className: cls ? cls.name : null,
    members, teacher: p.teacherEmail, parent: parent && { ...parent, children: children.map((c) => c.display_name) },
    createdAt: p.createdAt,
  };
}

/**
 * Makes the practice class and its mock people, or brings them up to date.
 * tenantId is optional: when given, the teacher must belong to that school.
 */
async function setup({ teacherEmail, tenantId = null, actorId = null }) {
  const teacherKey = identity.lower(teacherEmail);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(teacherKey)) return { ok: false, error: 'Give the teacher’s email address.' };
  if (teacherKey.endsWith('@' + FAKE_DOMAIN)) return { ok: false, error: 'The teacher must be a real account, not a practice one.' };

  const teacher = await db.one(
    `SELECT u.id AS user_id, m.tenant_id, r.key AS role_key
       FROM users u JOIN memberships m ON m.user_id = u.id JOIN roles r ON r.id = m.role_id
       JOIN tenants t ON t.id = m.tenant_id AND t.kind = 'school'
      WHERE u.email = $1 AND u.deleted_at IS NULL AND NOT u.is_mock
        AND ($2::uuid IS NULL OR m.tenant_id = $2::uuid)
      ORDER BY m.created_at LIMIT 1`, [teacherKey, tenantId || null]);
  if (!teacher) return { ok: false, error: tenantId ? `${teacherKey} is not a member of that school.` : `${teacherKey} is not a member of any school.` };
  if (teacher.role_key === 'student' || teacher.role_key === 'guardian') return { ok: false, error: `${teacherKey} is a ${teacher.role_key}, so cannot teach the practice class.` };

  const tenant = await db.one('SELECT * FROM tenants WHERE id = $1', [teacher.tenant_id]);
  const schoolId = tenant.id;
  const prev = (tenant.settings && tenant.settings.practice) || {};

  const result = await db.tx(async (q) => {
    const manifest = {
      classId: prev.classId || null,
      mockUserIds: prev.mockUserIds || prev.fakeUserIds || [],
      parentId: prev.parentId || null,
      linkIds: prev.linkIds || [],
      teacherEmail: teacherKey,
      createdAt: prev.createdAt || new Date().toISOString(),
    };
    const studentRole = await roleId(q, 'student');
    const guardianRole = await roleId(q, 'guardian');

    // The class.
    let cls = manifest.classId ? (await q.query('SELECT id FROM classes WHERE id = $1 AND tenant_id = $2', [manifest.classId, schoolId])).rows[0] : null;
    if (!cls) {
      cls = (await q.query(
        `INSERT INTO classes (tenant_id, name, subject, grade_levels, school_year, created_by)
         VALUES ($1,$2,'Practice', ARRAY[]::text[], $3, $4) RETURNING id`,
        [schoolId, CLASS_NAME, String(new Date().getFullYear()), actorId])).rows[0];
      manifest.classId = cls.id;
    }
    const place = (userId, role) => q.query(
      `INSERT INTO class_members (class_id, user_id, role) VALUES ($1,$2,$3)
       ON CONFLICT (class_id, user_id) DO UPDATE SET role = EXCLUDED.role`, [cls.id, userId, role]);

    // One teacher: the one named now.
    await q.query(`DELETE FROM class_members WHERE class_id = $1 AND role = 'teacher' AND user_id <> $2`, [cls.id, teacher.user_id]);
    await place(teacher.user_id, 'teacher');

    // A mock person, found by its practice.invalid address or made.
    const mock = async (email, displayName, roleIdWanted) => {
      let u = (await q.query('SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL', [email])).rows[0];
      if (!u) {
        u = (await q.query(
          `INSERT INTO users (email, display_name, status, is_minor, minor_source, display_name_source, is_mock)
           VALUES ($1,$2,'active', false, 'admin_set', 'school', true) RETURNING id`,
          [email, displayName])).rows[0];
      } else {
        await q.query('UPDATE users SET is_mock = true WHERE id = $1', [u.id]);
      }
      const m = (await q.query('SELECT id FROM memberships WHERE user_id = $1 AND tenant_id = $2', [u.id, schoolId])).rows[0];
      if (!m) {
        await q.query(
          `INSERT INTO memberships (user_id, tenant_id, role_id, status, added_by) VALUES ($1,$2,$3,'active',$4)`,
          [u.id, schoolId, roleIdWanted, actorId]);
      }
      return u.id;
    };

    // Mock students, with official names so the FACTS list has something
    // to sort.
    const studentIds = [];
    for (const f of FAKES) {
      const id = await mock(fakeEmail(f), `${f.given} ${f.family} (practice)`, studentRole);
      await names.writeOfficial(q, { userId: id, tenantId: schoolId, official: { given: f.given, middle: '', family: f.family, suffix: '' }, source: 'admin', actorId });
      await place(id, 'student');
      studentIds.push(id);
    }

    // The mock parent, linked and verified to the first two.
    const parentId = await mock(PARENT.email, `${PARENT.given} ${PARENT.family} (practice parent)`, guardianRole);
    manifest.parentId = parentId;
    manifest.mockUserIds = [...new Set([...manifest.mockUserIds, ...studentIds, parentId])];
    for (const childId of studentIds.slice(0, 2)) {
      const have = (await q.query('SELECT id FROM guardian_links WHERE guardian_id = $1 AND student_id = $2', [parentId, childId])).rows[0];
      if (have) continue;
      const link = (await q.query(
        `INSERT INTO guardian_links (guardian_id, student_id, tenant_id, relationship, verified_at, verified_by)
         VALUES ($1,$2,$3,'parent', now(), $4) RETURNING id`, [parentId, childId, schoolId, actorId])).rows[0];
      manifest.linkIds.push(link.id);
    }

    await q.query(
      `UPDATE tenants SET settings = jsonb_set(settings, '{practice}', $2::jsonb), updated_at = now() WHERE id = $1`,
      [schoolId, JSON.stringify(manifest)]);
    return { classId: cls.id, studentIds, parentId };
  });
  return { ok: true, tenantId: schoolId, tenantName: tenant.name, ...result, className: CLASS_NAME };
}

async function remove({ tenantId }) {
  const tenant = await db.one('SELECT id, settings FROM tenants WHERE id = $1', [tenantId]);
  const p = tenant && tenant.settings && tenant.settings.practice;
  if (!p) return { ok: false, error: 'There is no practice class here.' };
  const out = await db.tx(async (q) => {
    const counts = {};
    counts.links = (await q.query('DELETE FROM guardian_links WHERE id = ANY($1::uuid[]) AND tenant_id = $2', [p.linkIds || [], tenantId])).rowCount;
    counts.classes = p.classId ? (await q.query('DELETE FROM classes WHERE id = $1 AND tenant_id = $2', [p.classId, tenantId])).rowCount : 0;
    // Only ever a mock on a practice.invalid address: nobody real can be
    // deleted here. Their memberships, links and name history go with them.
    counts.mockPeople = (await q.query(
      `DELETE FROM users WHERE id = ANY($1::uuid[]) AND is_mock AND email LIKE $2`,
      [p.mockUserIds || p.fakeUserIds || [], '%@' + FAKE_DOMAIN])).rowCount;
    await q.query(`UPDATE tenants SET settings = settings - 'practice', updated_at = now() WHERE id = $1`, [tenantId]);
    return counts;
  });
  return { ok: true, removed: out };
}

module.exports = { setup, remove, status, tenantByName, tenantOfTeacher, CLASS_NAME, FAKE_DOMAIN, FAKES, PARENT };

// ---------- command line ----------

if (require.main === module) {
  const arg = (name) => {
    const i = process.argv.indexOf('--' + name);
    return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null;
  };
  const cmd = process.argv[2];
  (async () => {
    await db.migrate();
    const audit = require('./audit');
    const school = arg('school') ? await tenantByName(arg('school')) : null;
    if (arg('school') && !school) throw new Error(`No school called "${arg('school')}".`);
    const tenant = school || (arg('teacher') ? await tenantOfTeacher(arg('teacher')) : null);
    let result;
    if (cmd === 'setup') {
      result = await setup({ teacherEmail: arg('teacher'), tenantId: school ? school.id : null });
      if (result.ok) await audit.record({ tenantId: result.tenantId, action: 'practice.setup', targetType: 'class', targetId: result.classId, detail: { via: 'cli', teacher: arg('teacher') } });
    } else if (cmd === 'remove' || cmd === 'status') {
      if (!tenant) throw new Error('Name the teacher with --teacher, or the school with --school "Richmond Academy".');
      if (cmd === 'remove') {
        result = await remove({ tenantId: tenant.id });
        if (result.ok) await audit.record({ tenantId: tenant.id, action: 'practice.removed', targetType: 'tenant', targetId: tenant.id, detail: { via: 'cli', ...result.removed } });
      } else {
        result = await status(tenant.id);
      }
    } else {
      throw new Error('Use: node src/practice.js setup|status|remove --teacher <email> [--school "<name>"]');
    }
    console.log(JSON.stringify(result, null, 2));
    process.exit(result && result.ok === false ? 1 : 0);
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
