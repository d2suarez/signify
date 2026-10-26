// ===================================================================
// Teacher's Desk — which tools a person may have, by their school's choice
//
// The desk tells Signify ID what its tools are at boot, each marked with
// whether students get it by default (`students: true` on the widget). The
// school then turns tools on or off per role in Signify ID (Tools by role),
// and the desk asks for that school's answer here.
//
// The answer is cached for a minute per school. If Signify ID cannot be
// reached the desk falls back to the same defaults Signify ID would apply —
// students get only the tools marked for them, everybody else everything —
// so an outage never hands a student a tool their school has not allowed by
// default, and never takes a teacher's tools away.
// ===================================================================

const tools = require('./tools');

const ISSUER = (process.env.SIGNIFY_ISSUER || '').replace(/\/+$/, '');
const CLIENT_ID = process.env.SIGNIFY_CLIENT_ID || '';
const CLIENT_SECRET = process.env.SIGNIFY_CLIENT_SECRET || '';
const ENABLED = !!(ISSUER && CLIENT_ID && CLIENT_SECRET);
const STUDENT_ROLE = 'student';
const CACHE_MS = 60_000;
const FAILED_CACHE_MS = 15_000;

const basic = () => 'Basic ' + Buffer.from(
  `${encodeURIComponent(CLIENT_ID)}:${encodeURIComponent(CLIENT_SECRET)}`).toString('base64');

/** Tells Signify ID what the desk's tools are. Retries while it comes up. */
async function declare({ retries = 3 } = {}) {
  if (!ENABLED) return { ok: false };
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(`${ISSUER}/api/v1/declare-features`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: basic() },
        body: JSON.stringify({ features: tools.FEATURES }),
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { console.error('desk: tool declaration rejected —', res.status, data.error); return { ok: false }; }
      console.log(`desk: declared ${data.declared.length} tool(s) to Signify ID`);
      return data;
    } catch (e) {
      if (attempt === retries) { console.warn('desk: could not declare tools —', e.message); return { ok: false }; }
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
  return { ok: false };
}

/** The same rule Signify ID applies when a school has not decided. */
const byDefault = (tool, role) => (role === STUDENT_ROLE ? tool.students : true);

const cache = new Map(); // tenantId -> { at, ttl, roles }

async function rolesAt(tenantId) {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.roles;
  let roles = null;
  try {
    const res = await fetch(`${ISSUER}/api/v1/tenants/${encodeURIComponent(tenantId)}/features`, {
      headers: { authorization: basic() }, signal: AbortSignal.timeout(5000),
    });
    if (res.ok) roles = (await res.json()).roles || null;
    else console.warn(`desk: tools by role for ${tenantId} refused (${res.status}); using defaults`);
  } catch (e) {
    console.warn(`desk: tools by role for ${tenantId} unavailable (${e.message}); using defaults`);
  }
  cache.set(tenantId, { at: Date.now(), ttl: roles ? CACHE_MS : FAILED_CACHE_MS, roles });
  return roles;
}

/**
 * The tool types this person may have. `school` is the school's answer for
 * their role ({ type: bool }), when there is one; anything it does not
 * mention (a tool newer than the last declaration) takes the default.
 */
function resolve(role, school, perms = {}) {
  const out = new Set();
  for (const t of tools.TOOLS) {
    if (t.permission === 'behaviour' && !perms.behaviour) continue;
    const said = school && typeof school[t.type] === 'boolean' ? school[t.type] : null;
    if (said === null ? byDefault(t, role) : said) out.add(t.type);
  }
  return out;
}

/**
 * Express middleware: puts `req.deskTools` (a Set) on every signed-in
 * request. A super admin is not a member of any school and gets everything.
 */
function attach({ canBehaviour }) {
  return async (req, res, next) => {
    try {
      const u = req.user;
      if (!u) return next();
      const perms = { behaviour: canBehaviour(req) };
      if (u.isSuper) { req.deskTools = resolve('*', null, perms); return next(); }
      const role = u.role || '';
      const roles = ENABLED && u.tenantId ? await rolesAt(u.tenantId) : null;
      req.deskTools = resolve(role, roles && roles[role], perms);
    } catch (e) {
      console.error('desk: could not work out tools —', e.message);
      req.deskTools = resolve(req.user && req.user.role, null, {});
    }
    next();
  };
}

module.exports = { declare, resolve, attach, byDefault, STUDENT_ROLE, _cache: cache };
