// ===================================================================
// Signify ID — audit trail
// Two jobs in one table. Ordinary rows record administrative actions so a
// school can see who changed what. Rows flagged `is_disclosure` are the record
// of disclosures of education records that FERPA 34 CFR 99.32 requires a
// school to keep; they are never trimmed.
// ===================================================================

const db = require('./db');

// Never let an audit failure break the operation being audited — but do make
// the failure loud, because a silently broken audit log is worse than none.
async function record(entry) {
  const {
    actorUserId = null, actorEmail = null, tenantId = null, appId = null,
    action, targetType = null, targetId = null, detail = {},
    ip = null, userAgent = null, disclosure = false,
  } = entry;

  try {
    await db.query(
      `INSERT INTO audit_log
         (actor_user_id, actor_email, tenant_id, app_id, action,
          target_type, target_id, detail, ip, user_agent, is_disclosure)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [actorUserId, actorEmail, tenantId, appId, action,
       targetType, targetId, JSON.stringify(detail), ip, String(userAgent || '').slice(0, 400), disclosure]
    );
  } catch (e) {
    // Field names only. An audit detail can carry an email address, and the
    // application log is not a place education records belong.
    console.error(`AUDIT WRITE FAILED [${action}] fields=[${Object.keys(detail || {}).join(',')}]:`, e.message);
  }
}

// Pulls actor and request metadata off an express request so call sites stay
// to a single line.
function from(req, entry) {
  const actor = req.actor || null;
  return record({
    actorUserId: actor ? actor.userId : null,
    actorEmail: actor ? actor.email : null,
    tenantId: entry.tenantId !== undefined ? entry.tenantId : (actor ? actor.tenantId : null),
    ip: req.ip || null,
    userAgent: req.get('user-agent') || null,
    ...entry,
  });
}

async function list({ tenantId = null, limit = 200, before = null, disclosuresOnly = false, targetId = null }) {
  const where = [];
  const params = [];
  if (tenantId) { params.push(tenantId); where.push(`tenant_id = $${params.length}`); }
  if (before) { params.push(before); where.push(`ts < $${params.length}`); }
  if (disclosuresOnly) where.push('is_disclosure');
  if (targetId) { params.push(targetId); where.push(`target_id = $${params.length}`); }
  params.push(Math.min(Number(limit) || 200, 1000));

  return db.many(
    `SELECT id, ts, actor_email, tenant_id, action, target_type, target_id,
            detail, host(ip) AS ip, is_disclosure
       FROM audit_log
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ts DESC
      LIMIT $${params.length}`,
    params
  );
}

module.exports = { record, from, list };
