// ===================================================================
// Signify ID — substitute cover
//
// Which substitute covers which classes, on which days. Cover is by whole
// days in the school's own time zone; "today" is always worked out by the
// database from tenants.timezone, never from the server's clock, which runs
// on UTC and would move the school day by four or five hours.
//
// What a period of cover actually grants comes from the class_access view
// (migration 011), which every app-facing class query reads. This module only
// records cover and answers questions about it.
// ===================================================================

const db = require('./db');

const TODAY = '(now() AT TIME ZONE t.timezone)::date';
// Long enough for a term's leave, short enough that a typo in the year is caught.
const MAX_DAYS = 366;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Today's date at the school, as YYYY-MM-DD. */
async function today(tenantId) {
  const row = await db.one(
    `SELECT to_char(${TODAY}, 'YYYY-MM-DD') AS d FROM tenants t WHERE t.id = $1`, [tenantId]);
  return row ? row.d : null;
}

/**
 * Whether a substitute is covering today, and when their next cover starts.
 * Read by identity.accessFor so loginBlock can stay a plain reading of it.
 */
async function forSubstitute(userId, tenantId) {
  const row = await db.one(
    `SELECT bool_or(${TODAY} BETWEEN c.starts_on AND c.ends_on) AS covering,
            to_char(min(c.starts_on) FILTER (WHERE c.starts_on > ${TODAY}), 'YYYY-MM-DD') AS next_on,
            to_char(min(c.starts_on) FILTER (WHERE c.starts_on > ${TODAY}), 'FMDay FMDD FMMonth') AS next_label
       FROM coverages c JOIN tenants t ON t.id = c.tenant_id
      WHERE c.substitute_id = $1 AND c.tenant_id = $2 AND c.ended_at IS NULL`,
    [userId, tenantId]);
  return {
    covering: !!(row && row.covering),
    nextOn: row ? row.next_on : null,
    nextLabel: row ? row.next_label : null,
  };
}

/**
 * Everything the console's Substitutes page shows for one school: who the
 * substitutes are and whether each is covering, the cover arranged from a
 * fortnight ago onwards, and the teachers and classes to arrange it for.
 */
async function overview(tenantId) {
  const todayIs = await today(tenantId);

  const substitutes = await db.many(
    `SELECT u.id, u.display_name AS name, u.email, m.status
       FROM memberships m
       JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
       JOIN roles r ON r.id = m.role_id
      WHERE m.tenant_id = $1 AND r.key = 'substitute'
      ORDER BY u.display_name`, [tenantId]);

  const coverages = await db.many(
    `SELECT c.id, c.substitute_id, c.covering_for, c.note, c.ended_at,
            to_char(c.starts_on, 'YYYY-MM-DD') AS starts_on,
            to_char(c.ends_on, 'YYYY-MM-DD') AS ends_on,
            s.display_name AS substitute_name, f.display_name AS covering_for_name,
            e.display_name AS ended_by_name,
            (c.ended_at IS NULL AND ${TODAY} BETWEEN c.starts_on AND c.ends_on) AS current,
            (c.ended_at IS NULL AND c.starts_on > ${TODAY}) AS upcoming,
            COALESCE(json_agg(json_build_object('id', cl.id, 'name', cl.name) ORDER BY cl.name)
                     FILTER (WHERE cl.id IS NOT NULL), '[]') AS classes
       FROM coverages c
       JOIN tenants t ON t.id = c.tenant_id
       JOIN users s ON s.id = c.substitute_id
       LEFT JOIN users f ON f.id = c.covering_for
       LEFT JOIN users e ON e.id = c.ended_by
       LEFT JOIN coverage_classes cc ON cc.coverage_id = c.id
       LEFT JOIN classes cl ON cl.id = cc.class_id
      WHERE c.tenant_id = $1 AND c.ends_on >= ${TODAY} - 14
      GROUP BY c.id, t.timezone, s.display_name, f.display_name, e.display_name
      ORDER BY c.starts_on, s.display_name`, [tenantId]);

  const classes = await db.many(
    `SELECT c.id, c.name,
            COALESCE(array_agg(cm.user_id) FILTER (WHERE cm.role = 'teacher'), '{}') AS teacher_ids,
            COALESCE(string_agg(u.display_name, ', ' ORDER BY u.display_name)
                     FILTER (WHERE cm.role = 'teacher'), '') AS teachers
       FROM classes c
       LEFT JOIN class_members cm ON cm.class_id = c.id
       LEFT JOIN users u ON u.id = cm.user_id
      WHERE c.tenant_id = $1 AND c.archived = false
      GROUP BY c.id
      ORDER BY c.name`, [tenantId]);

  // Anyone teaching a class here, so "covering for" can pre-fill their classes.
  const teachers = await db.many(
    `SELECT DISTINCT u.id, u.display_name AS name
       FROM class_members cm
       JOIN classes c ON c.id = cm.class_id AND c.tenant_id = $1 AND c.archived = false
       JOIN users u ON u.id = cm.user_id AND u.deleted_at IS NULL
      WHERE cm.role = 'teacher'
      ORDER BY u.display_name`, [tenantId]);

  const now = coverages.filter((c) => c.current);
  const next = coverages.filter((c) => c.upcoming);
  return {
    today: todayIs,
    substitutes: substitutes.map((s) => ({
      ...s,
      coveringNow: now.filter((c) => c.substitute_id === s.id),
      next: next.find((c) => c.substitute_id === s.id) || null,
    })),
    coverages,
    classes,
    teachers,
  };
}

/**
 * Arrange cover. Refuses anything that would grant access nobody meant to:
 * someone who is not a substitute here, a class from another school, dates
 * that are backwards, already over, or implausibly long.
 */
async function schedule({ tenantId, substituteId, coveringFor, classIds, startsOn, endsOn, note, actorId }) {
  const sub = await db.one(
    `SELECT u.id, m.status FROM memberships m
       JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
       JOIN roles r ON r.id = m.role_id
      WHERE m.user_id = $1 AND m.tenant_id = $2 AND r.key = 'substitute'`, [substituteId, tenantId]);
  if (!sub) return { ok: false, error: 'That person is not a substitute at this school.' };
  if (sub.status === 'blocked') return { ok: false, error: 'That substitute’s access has been turned off. Turn it back on first.' };

  const ids = [...new Set((Array.isArray(classIds) ? classIds : []).map(String))];
  if (!ids.length) return { ok: false, error: 'Choose at least one class to cover.' };
  const found = await db.many(
    'SELECT id FROM classes WHERE id = ANY($1::uuid[]) AND tenant_id = $2 AND archived = false', [ids, tenantId]);
  if (found.length !== ids.length) return { ok: false, error: 'One of those classes is not at this school.' };

  if (!ISO_DATE.test(String(startsOn)) || !ISO_DATE.test(String(endsOn))) {
    return { ok: false, error: 'Give the first and last day of cover.' };
  }
  if (endsOn < startsOn) return { ok: false, error: 'The last day of cover is before the first.' };
  const span = await db.one(
    `SELECT ($2::date - $1::date) + 1 AS days, $2::date < ${TODAY} AS over
       FROM tenants t WHERE t.id = $3`, [startsOn, endsOn, tenantId]);
  if (span.over) return { ok: false, error: 'That cover would already be over.' };
  if (Number(span.days) > MAX_DAYS) return { ok: false, error: 'Cover can be arranged for up to a year at a time.' };

  if (coveringFor) {
    const teacher = await db.one(
      'SELECT 1 FROM memberships WHERE user_id = $1 AND tenant_id = $2', [coveringFor, tenantId]);
    if (!teacher) return { ok: false, error: 'The teacher being covered is not at this school.' };
  }

  const row = await db.tx(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO coverages (tenant_id, substitute_id, covering_for, starts_on, ends_on, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [tenantId, substituteId, coveringFor || null, startsOn, endsOn, String(note || '').slice(0, 300), actorId]);
    for (const classId of ids) {
      await client.query('INSERT INTO coverage_classes (coverage_id, class_id) VALUES ($1,$2)', [rows[0].id, classId]);
    }
    return rows[0];
  });
  return { ok: true, id: row.id, classes: ids.length };
}

/** End cover now — or cancel it, if it has not begun. Nothing is deleted. */
async function end(coverageId, tenantId, actorId) {
  const row = await db.one(
    `UPDATE coverages SET ended_at = now(), ended_by = $3
      WHERE id = $1 AND tenant_id = $2 AND ended_at IS NULL
      RETURNING substitute_id`, [coverageId, tenantId, actorId]);
  return row ? { ok: true, substituteId: row.substitute_id } : { ok: false, error: 'That cover has already ended.' };
}

module.exports = { MAX_DAYS, today, forSubstitute, overview, schedule, end };
