// ===================================================================
// Signify ID — roster import from CSV
//
// Two passes over the same file. `analyse` decides what would happen and
// explains every refusal; `apply` re-runs that analysis and executes it.
// Nothing is held between the two, so a preview cannot go stale against a
// roster that changed underneath it, and there is no half-applied state to
// clean up if the browser goes away.
//
// The import can never do something the person running it could not do by
// hand: role assignment goes through the same guard as the console's own
// role picker, and a local admin is pinned to their own school no matter
// what the School ID column says.
// ===================================================================

const db = require('./db');
const csv = require('./csv');
const guards = require('./guards');
const identity = require('./identity');

const MAX_ROWS = 2000;

const clean = (v) => String(v == null ? '' : v).trim();
const titleCase = (s) => s.replace(/\S+/g, (w) => w[0].toUpperCase() + w.slice(1));

function displayNameFrom(first, last, email) {
  const name = [first, last].filter(Boolean).join(' ').trim();
  if (name) return name.slice(0, 120);
  return titleCase(email.split('@')[0].replace(/[._-]+/g, ' ')).slice(0, 120);
}

// ---------- reference data ----------

async function loadContext(actor, tenantId) {
  const tenant = await db.one('SELECT id, slug, name, minors_default, kind FROM tenants WHERE id = $1', [tenantId]);

  const roles = await db.many(
    `SELECT id, key, label, is_admin, tenant_id FROM roles
      WHERE tenant_id IS NULL OR tenant_id = $1`, [tenantId]);

  const classes = await db.many(
    'SELECT id, name FROM classes WHERE tenant_id = $1 AND archived = false', [tenantId]);

  // Only apps the school actually has switched on can be granted to a person.
  const apps = await db.many(
    `SELECT a.id, a.client_id, a.name FROM apps a
       JOIN app_tenants at ON at.app_id = a.id
      WHERE at.tenant_id = $1 AND at.enabled AND a.status = 'active'`, [tenantId]);

  return { tenant, roles, classes, apps };
}

// Roles, classes and apps are all matched case-insensitively on either their
// human label or their identifier, because a CSV will contain whichever the
// office happened to type.
const findRole = (roles, value) => {
  const v = clean(value).toLowerCase();
  if (!v) return null;
  return roles.find((r) => r.key.toLowerCase() === v)
    || roles.find((r) => r.label.toLowerCase() === v)
    || roles.find((r) => r.label.toLowerCase().replace(/\s+/g, '') === v.replace(/\s+/g, ''))
    || null;
};

const findClass = (classes, value) => {
  const v = clean(value).toLowerCase();
  return classes.find((c) => c.name.toLowerCase() === v) || null;
};

const findApp = (apps, value) => {
  const v = clean(value).toLowerCase();
  return apps.find((a) => a.client_id.toLowerCase() === v)
    || apps.find((a) => a.name.toLowerCase() === v)
    || apps.find((a) => a.name.toLowerCase().replace(/\s+/g, '') === v.replace(/\s+/g, ''))
    || null;
};

// ---------- analysis ----------

/**
 * Works out what the file would do. Never writes.
 * Returns { ok, error?, headers, unknownColumns, rows, summary, newClasses }
 */
async function analyse({ text, actor, tenantId, createMissingClasses = false }) {
  const parsed = csv.parse(text);
  if (!parsed.length) return { ok: false, error: 'That file has no rows in it.' };

  const { map, unknown } = csv.mapHeaders(parsed[0]);
  if (map.email === undefined) {
    return {
      ok: false,
      error: 'No email column found. The file needs a heading like "Email address" — that is what identifies each person.',
    };
  }

  const body = parsed.slice(1);
  if (body.length > MAX_ROWS) {
    return { ok: false, error: `That file has ${body.length} rows. Split it into files of ${MAX_ROWS} or fewer.` };
  }

  const ctx = await loadContext(actor, tenantId);
  if (!ctx.tenant) return { ok: false, error: 'That school no longer exists.' };
  if (ctx.tenant.kind === 'independent') {
    return { ok: false, error: 'People with no school are added one at a time from People, not by roster import.' };
  }

  // Role assignability is asked once per distinct role rather than per row.
  const roleAllowed = new Map();
  const canUse = async (role) => {
    if (roleAllowed.has(role.id)) return roleAllowed.get(role.id);
    const verdict = await guards.canAssignRole(actor, role.id);
    roleAllowed.set(role.id, verdict);
    return verdict;
  };

  const cell = (row, key) => (map[key] === undefined ? '' : clean(row[map[key]]));
  const seenEmails = new Map();
  const newClassNames = new Set();
  const rows = [];

  for (let i = 0; i < body.length; i += 1) {
    const raw = body[i];
    const line = i + 2; // 1-based, and the header occupies line 1
    const problems = [];

    const email = identity.lower(cell(raw, 'email'));
    const first = cell(raw, 'first_name');
    const last = cell(raw, 'last_name');

    if (!email) {
      rows.push({ line, action: 'error', email: '', problems: ['No email address in this row.'] });
      continue;
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      rows.push({ line, action: 'error', email, problems: [`"${email}" is not a valid email address.`] });
      continue;
    }
    if (seenEmails.has(email)) {
      rows.push({ line, action: 'error', email, problems: [`Repeated in this file — also on line ${seenEmails.get(email)}.`] });
      continue;
    }
    seenEmails.set(email, line);

    // --- school ---
    // A local admin is pinned to their own school. Rather than silently
    // retargeting the row, a mismatch is refused so the file gets fixed.
    const schoolCell = cell(raw, 'tenant');
    if (schoolCell) {
      const matchesTenant = [ctx.tenant.id, ctx.tenant.slug, ctx.tenant.name]
        .some((v) => String(v).toLowerCase() === schoolCell.toLowerCase());
      if (!matchesTenant) {
        problems.push(`School "${schoolCell}" is not the school this import is going into (${ctx.tenant.name}).`);
      }
    }

    // --- role ---
    let role = null;
    const roleCell = cell(raw, 'role');
    if (!roleCell) {
      role = ctx.roles.find((r) => r.key === 'student' && !r.tenant_id) || null;
      if (!role) problems.push('No role given and the built-in student role is missing.');
    } else {
      role = findRole(ctx.roles, roleCell);
      if (!role) problems.push(`Unknown role "${roleCell}".`);
    }
    if (role) {
      const verdict = await canUse(role);
      if (!verdict.ok) problems.push(verdict.reason);
    }

    // --- graduation year ---
    let gradYear = null;
    const gradCell = cell(raw, 'graduation_year');
    if (gradCell) {
      const n = Number(gradCell.replace(/\D/g, ''));
      if (!Number.isInteger(n) || n < 1900 || n > 2200) problems.push(`"${gradCell}" is not a usable graduation year.`);
      else gradYear = n;
    }

    // --- classes ---
    const classNames = csv.splitList(cell(raw, 'classes'));
    const classes = classNames.map((name) => {
      const found = findClass(ctx.classes, name);
      if (!found && !createMissingClasses) {
        problems.push(`No class called "${name}" in this school.`);
      }
      if (!found && createMissingClasses) newClassNames.add(name);
      return { name, id: found ? found.id : null, willCreate: !found && createMissingClasses };
    });

    // --- apps ---
    const appNames = csv.splitList(cell(raw, 'apps'));
    const apps = appNames.map((name) => {
      const found = findApp(ctx.apps, name);
      if (!found) problems.push(`"${name}" is not an app this school has switched on.`);
      return { name, id: found ? found.id : null };
    });

    // --- does this person already exist? ---
    const existing = await db.one(
      `SELECT u.id, u.display_name, u.email,
              m.id AS membership_id, m.status, m.grade_level, m.graduation_year,
              m.role_id, r.key AS role_key, r.is_admin,
              (SELECT 1 FROM platform_admins pa WHERE pa.user_id = u.id) AS is_platform_admin
         FROM users u
         LEFT JOIN memberships m ON m.user_id = u.id AND m.tenant_id = $2
         LEFT JOIN roles r ON r.id = m.role_id
        WHERE u.email = $1 AND u.deleted_at IS NULL`,
      [email, tenantId]);

    if (existing && existing.membership_id) {
      const verdict = await guards.canManageUser(actor, existing.id);
      if (!verdict.ok) problems.push(verdict.reason);
    } else if (existing && existing.is_platform_admin) {
      problems.push('That account is a super admin and cannot be changed by an import.');
    }

    const action = problems.length ? 'error' : (existing && existing.membership_id ? 'update' : 'create');

    // What would visibly change, so the preview can show it rather than just
    // asserting "update".
    const changes = [];
    if (action === 'update') {
      const newName = displayNameFrom(first, last, email);
      if (first || last) {
        if (existing.display_name !== newName) changes.push(`name → ${newName}`);
      }
      if (role && existing.role_id !== role.id) changes.push(`role → ${role.label}`);
      if (gradYear && existing.graduation_year !== gradYear) changes.push(`graduation → ${gradYear}`);
      const addable = classes.filter((c) => c.id || c.willCreate).length;
      if (addable) changes.push(`${addable} class${addable === 1 ? '' : 'es'}`);
      if (apps.length) changes.push(`${apps.length} app grant${apps.length === 1 ? '' : 's'}`);
      if (!changes.length) changes.push('nothing would change');
    }

    rows.push({
      line,
      action,
      email,
      name: displayNameFrom(first, last, email),
      firstName: first || null,
      lastName: last || null,
      role: role ? { id: role.id, key: role.key, label: role.label } : null,
      graduationYear: gradYear,
      gradeLevel: cell(raw, 'grade_level') || null,
      classes,
      apps,
      existingUserId: existing ? existing.id : null,
      changes,
      problems,
    });
  }

  const summary = {
    total: rows.length,
    create: rows.filter((r) => r.action === 'create').length,
    update: rows.filter((r) => r.action === 'update').length,
    error: rows.filter((r) => r.action === 'error').length,
  };

  return {
    ok: true,
    tenant: { id: ctx.tenant.id, name: ctx.tenant.name },
    headers: Object.keys(map),
    unknownColumns: unknown,
    newClasses: [...newClassNames],
    rows,
    summary,
  };
}

// ---------- apply ----------

/**
 * Re-analyses and then performs the create/update rows. Rows with problems are
 * left alone and reported, so one bad line never blocks the other 300.
 */
async function apply({ text, actor, tenantId, createMissingClasses = false, filename = '' }) {
  const analysis = await analyse({ text, actor, tenantId, createMissingClasses });
  if (!analysis.ok) return analysis;

  const tenant = await db.one('SELECT minors_default FROM tenants WHERE id = $1', [tenantId]);
  const classIds = new Map();

  // Everything needed to put the roster back as it was. Captured as the run
  // goes, because after the fact there is no way to tell which of a person's
  // values the import changed and which were already there.
  const undo = {
    createdUsers: [],
    updatedUsers: [],
    createdMemberships: [],
    updatedMemberships: [],
    addedClassMembers: [],
    addedAppGrants: [],
    createdClasses: [],
  };

  const result = await db.tx(async (client) => {
    // Create any missing classes once, up front.
    if (createMissingClasses) {
      for (const name of analysis.newClasses) {
        const existing = await client.query(
          'SELECT id FROM classes WHERE tenant_id = $1 AND lower(name) = lower($2) AND archived = false',
          [tenantId, name]);
        if (existing.rows.length) { classIds.set(name.toLowerCase(), existing.rows[0].id); continue; }
        const created = await client.query(
          `INSERT INTO classes (tenant_id, name, school_year, created_by, grade_levels)
           VALUES ($1,$2,$3,$4,'{}') RETURNING id`,
          [tenantId, name, String(new Date().getFullYear()), actor.userId]);
        classIds.set(name.toLowerCase(), created.rows[0].id);
        undo.createdClasses.push(created.rows[0].id);
      }
    }

    let created = 0;
    let updated = 0;

    for (const row of analysis.rows) {
      if (row.action !== 'create' && row.action !== 'update') continue;

      const isStudent = row.role && row.role.key === 'student';
      let userId = row.existingUserId;

      if (!userId) {
        const u = await client.query(
          `INSERT INTO users (email, display_name, given_name, family_name, status, is_minor, minor_source)
           VALUES ($1,$2,$3,$4,'active',$5,'tenant_default') RETURNING id`,
          [row.email, row.name, row.firstName, row.lastName,
           isStudent ? tenant.minors_default : false]);
        userId = u.rows[0].id;
        undo.createdUsers.push({ id: userId, email: row.email });
      } else if (row.firstName || row.lastName) {
        const before = await client.query(
          'SELECT display_name, given_name, family_name FROM users WHERE id = $1', [userId]);
        undo.updatedUsers.push({ id: userId, before: before.rows[0] });
        await client.query(
          `UPDATE users SET display_name = $2, given_name = COALESCE($3, given_name),
                            family_name = COALESCE($4, family_name)
            WHERE id = $1`,
          [userId, row.name, row.firstName, row.lastName]);
      }

      const priorMembership = await client.query(
        'SELECT role_id, status, grade_level, graduation_year FROM memberships WHERE user_id = $1 AND tenant_id = $2',
        [userId, tenantId]);

      const membership = await client.query(
        `INSERT INTO memberships (user_id, tenant_id, role_id, status, grade_level, graduation_year, added_by)
         VALUES ($1,$2,$3,'active',$4,$5,$6)
         ON CONFLICT (user_id, tenant_id) DO UPDATE SET
           role_id = EXCLUDED.role_id,
           grade_level = COALESCE(EXCLUDED.grade_level, memberships.grade_level),
           graduation_year = COALESCE(EXCLUDED.graduation_year, memberships.graduation_year),
           updated_at = now()
         RETURNING (xmax = 0) AS inserted`,
        [userId, tenantId, row.role.id, row.gradeLevel, row.graduationYear, actor.userId]);

      if (membership.rows[0].inserted) {
        created += 1;
        undo.createdMemberships.push({ userId: userId, tenantId: tenantId });
      } else {
        updated += 1;
        undo.updatedMemberships.push({ userId: userId, before: priorMembership.rows[0] });
      }

      // Classes — additive. An import adds someone to a class; it never
      // silently removes them from one the file happens not to mention.
      for (const c of row.classes) {
        const id = c.id || classIds.get(c.name.toLowerCase());
        if (!id) continue;
        const priorMember = await client.query(
          'SELECT role FROM class_members WHERE class_id = $1 AND user_id = $2', [id, userId]);
        undo.addedClassMembers.push({
          classId: id, userId: userId,
          before: priorMember.rows.length ? priorMember.rows[0].role : null,
        });
        await client.query(
          `INSERT INTO class_members (class_id, user_id, role) VALUES ($1,$2,$3)
           ON CONFLICT (class_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
          [id, userId, isStudent ? 'student' : 'teacher']);
      }

      for (const a of row.apps) {
        if (!a.id) continue;
        const priorGrant = await client.query(
          'SELECT allowed FROM user_app_access WHERE user_id = $1 AND app_id = $2', [userId, a.id]);
        undo.addedAppGrants.push({
          userId: userId, appId: a.id,
          before: priorGrant.rows.length ? priorGrant.rows[0].allowed : null,
        });
        await client.query(
          `INSERT INTO user_app_access (user_id, app_id, tenant_id, allowed, set_by)
           VALUES ($1,$2,$3,true,$4)
           ON CONFLICT (user_id, app_id) DO UPDATE SET allowed = true, set_by = EXCLUDED.set_by`,
          [userId, a.id, tenantId, actor.userId]);
      }
    }

    const record = await client.query(
      `INSERT INTO roster_imports (tenant_id, created_by, filename, row_count, created_n, updated_n, skipped_n, detail, undo_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [tenantId, actor.userId, String(filename).slice(0, 200), analysis.summary.total,
       created, updated, analysis.summary.error,
       JSON.stringify({
         createdClasses: createMissingClasses ? analysis.newClasses : [],
         unknownColumns: analysis.unknownColumns,
       }),
       JSON.stringify(undo)]);

    return { importId: record.rows[0].id, created, updated };
  });

  return {
    ok: true,
    ...result,
    skipped: analysis.summary.error,
    problems: analysis.rows.filter((r) => r.action === 'error'),
    createdClasses: createMissingClasses ? analysis.newClasses : [],
  };
}

// ---------- undo ----------

// An import stays reversible for this long. Past it, too much has usually
// happened on top for putting the old values back to be the kind thing to do.
const UNDO_WINDOW_DAYS = 30;

async function listUndoable(tenantId) {
  return db.many(
    `SELECT ri.id, ri.filename, ri.created_at, ri.row_count, ri.created_n, ri.updated_n,
            ri.skipped_n, ri.undone_at, u.email AS created_by,
            (ri.undo_data IS NOT NULL
              AND ri.undone_at IS NULL
              AND ri.created_at > now() - ($2 || ' days')::interval) AS undoable
       FROM roster_imports ri
       LEFT JOIN users u ON u.id = ri.created_by
      WHERE ri.tenant_id = $1
      ORDER BY ri.created_at DESC LIMIT 25`,
    [tenantId, String(UNDO_WINDOW_DAYS)]);
}

/**
 * Reverses one import: removes the accounts it created, and puts back the
 * prior value of everything it changed.
 *
 * One deliberate refusal: an account created by the import that has since been
 * used to sign in is kept, not deleted. By then it belongs to a real person
 * who has done real work in the apps, and quietly deleting them to tidy up a
 * spreadsheet mistake would be the worse error.
 */
async function undoImport({ importId, actor, tenantId, dryRun = false }) {
  const run = await db.one(
    'SELECT * FROM roster_imports WHERE id = $1 AND tenant_id = $2', [importId, tenantId]);

  if (!run) return { ok: false, error: 'No such import for this school.' };
  if (run.undone_at) return { ok: false, error: 'That import has already been undone.' };
  if (!run.undo_data) return { ok: false, error: 'That import predates undo support, so there is nothing recorded to reverse.' };

  const ageDays = (Date.now() - new Date(run.created_at).getTime()) / 864e5;
  if (ageDays > UNDO_WINDOW_DAYS) {
    return { ok: false, error: `That import is ${Math.floor(ageDays)} days old. Undo is only offered for ${UNDO_WINDOW_DAYS} days.` };
  }

  const undo = run.undo_data;

  // Which of the accounts it created have since been used by a real person?
  const kept = [];
  const removable = [];
  for (const u of undo.createdUsers || []) {
    const signedIn = await db.one(
      'SELECT 1 FROM identities WHERE user_id = $1 LIMIT 1', [u.id]);
    const stillThere = await db.one('SELECT id FROM users WHERE id = $1', [u.id]);
    if (!stillThere) continue;               // already gone by some other route
    if (signedIn) kept.push(u.email);
    else removable.push(u.id);
  }

  const plan = {
    usersToRemove: removable.length,
    usersKeptBecauseTheySignedIn: kept,
    membershipsToRevert: (undo.updatedMemberships || []).length,
    namesToRevert: (undo.updatedUsers || []).length,
    classMembershipsToUndo: (undo.addedClassMembers || []).length,
    appGrantsToUndo: (undo.addedAppGrants || []).length,
    classesToRemoveIfEmpty: (undo.createdClasses || []).length,
  };

  if (dryRun) return { ok: true, plan, filename: run.filename, createdAt: run.created_at };

  const applied = await db.tx(async (client) => {
    // Innermost first, so nothing is left pointing at a deleted row.
    for (const g of undo.addedAppGrants || []) {
      if (g.before === null || g.before === undefined) {
        await client.query('DELETE FROM user_app_access WHERE user_id = $1 AND app_id = $2', [g.userId, g.appId]);
      } else {
        await client.query('UPDATE user_app_access SET allowed = $3 WHERE user_id = $1 AND app_id = $2',
          [g.userId, g.appId, g.before]);
      }
    }

    for (const c of undo.addedClassMembers || []) {
      if (c.before === null || c.before === undefined) {
        await client.query('DELETE FROM class_members WHERE class_id = $1 AND user_id = $2', [c.classId, c.userId]);
      } else {
        await client.query('UPDATE class_members SET role = $3 WHERE class_id = $1 AND user_id = $2',
          [c.classId, c.userId, c.before]);
      }
    }

    for (const m of undo.updatedMemberships || []) {
      if (!m.before) continue;
      await client.query(
        `UPDATE memberships SET role_id = $2, status = $3, grade_level = $4,
                                graduation_year = $5, updated_at = now()
          WHERE user_id = $1 AND tenant_id = $6`,
        [m.userId, m.before.role_id, m.before.status, m.before.grade_level,
         m.before.graduation_year, tenantId]);
    }

    for (const u of undo.updatedUsers || []) {
      if (!u.before) continue;
      await client.query(
        'UPDATE users SET display_name = $2, given_name = $3, family_name = $4 WHERE id = $1',
        [u.id, u.before.display_name, u.before.given_name, u.before.family_name]);
    }

    for (const m of undo.createdMemberships || []) {
      await client.query('DELETE FROM memberships WHERE user_id = $1 AND tenant_id = $2', [m.userId, m.tenantId]);
    }

    let usersRemoved = 0;
    for (const id of removable) {
      await client.query('DELETE FROM users WHERE id = $1', [id]);
      usersRemoved += 1;
    }

    // A class the import created is only removed if nobody is left in it —
    // somebody may have added pupils to it since.
    let classesRemoved = 0;
    for (const classId of undo.createdClasses || []) {
      const inUse = await client.query('SELECT 1 FROM class_members WHERE class_id = $1 LIMIT 1', [classId]);
      if (inUse.rows.length) continue;
      await client.query('DELETE FROM classes WHERE id = $1 AND tenant_id = $2', [classId, tenantId]);
      classesRemoved += 1;
    }

    await client.query(
      'UPDATE roster_imports SET undone_at = now(), undone_by = $2 WHERE id = $1',
      [importId, actor.userId]);

    return { usersRemoved, classesRemoved };
  });

  return { ok: true, ...applied, keptBecauseTheySignedIn: kept, plan };
}

module.exports = { analyse, apply, listUndoable, undoImport, MAX_ROWS, UNDO_WINDOW_DAYS, displayNameFrom };
