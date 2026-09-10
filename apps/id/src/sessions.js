// ===================================================================
// Signify ID — browser sessions for the identity service itself
//
// Sessions are rows, not signed blobs. That is the whole point: when an
// administrator blocks an account, the block has to take effect now, not
// whenever a self-contained token happens to expire.
//
// Two clocks run on every session. The absolute one caps how long a login can
// last at all; the idle one is the important one for a classroom, where a
// tablet gets handed to the next child without anyone signing out.
// ===================================================================

const crypto = require('crypto');
const db = require('./db');
const keys = require('./keys');
const { config } = require('./config');

const COOKIE = 'sid';
const CSRF_COOKIE = 'csrf';

function cookieOptions(maxAgeMs) {
  return {
    httpOnly: true,
    secure: config.production,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeMs,
  };
}

async function create(userId, { ip, userAgent, isMinor }) {
  const raw = keys.randomToken(32);
  const idleMinutes = isMinor ? config.sessionIdleMinutesMinor : config.sessionIdleMinutes;
  const absoluteMs = config.sessionAbsoluteHours * 3600 * 1000;

  const row = await db.one(
    `INSERT INTO sessions (user_id, token_hash, expires_at, idle_expires_at, ip, user_agent)
     VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval,
                     now() + ($4 || ' minutes')::interval, $5, $6)
     RETURNING id, expires_at, idle_expires_at`,
    [userId, keys.sha256(raw), String(absoluteMs), String(idleMinutes), ip || null, String(userAgent || '').slice(0, 400)]
  );

  return { id: row.id, raw, expiresAt: row.expires_at, idleMinutes, absoluteMs };
}

// Looks up a session and slides the idle window forward. Returns null for
// anything expired, revoked, or belonging to an account that has since been
// blocked or deleted — the check is against live rows every time.
//
// Which idle window applies is read from the account itself, exactly as
// slide() does. It used to come from an argument no caller ever passed, so
// every session touched here — which is every request that reaches this
// service, via attachActor — was slid at the adult rate. A child's tablet got
// the 45-minute window instead of the 20 the policy promises, and the two code
// paths disagreed about the same session depending on which one saw it last.
async function touch(rawToken) {
  if (!rawToken) return null;

  const row = await db.one(
    `UPDATE sessions s
        SET last_seen_at = now(),
            idle_expires_at = now()
              + ((CASE WHEN u.is_minor THEN $2 ELSE $3 END) || ' minutes')::interval
       FROM users u
      WHERE s.token_hash = $1
        AND u.id = s.user_id
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND s.idle_expires_at > now()
        AND u.deleted_at IS NULL
        AND u.status NOT IN ('blocked', 'suspended')
    RETURNING s.id, s.user_id, s.expires_at`,
    [keys.sha256(rawToken), String(config.sessionIdleMinutesMinor), String(config.sessionIdleMinutes)]
  );
  return row;
}

/**
 * Slides a live session's idle window forward, addressed by session id rather
 * than by the browser's session cookie. Returns the row while the session is
 * still good, and null once it is revoked, past either clock, or the account
 * has been blocked or deleted.
 *
 * Same rule as touch(), for the callers that hold a token instead of a cookie:
 * a relying app's service-API call, and a refresh of that app's tokens. Both
 * are somebody using their session, and have to count as such.
 *
 * They did not, and it showed. A teacher working in Teacher's Desk never
 * visits this service directly, so nothing slid their idle window; forty-five
 * minutes in, the API began refusing every roster question with "that sign-in
 * has ended" while the refresh grant — which checked neither clock — happily
 * kept minting them fresh ID tokens. The app believed they were signed in,
 * this service did not, and the teacher watched their class lists disappear
 * until they signed out and back in. Two code paths disagreeing about whether
 * a session was alive; now there is one rule and all of them ask it.
 */
async function slide(sessionId) {
  if (!sessionId) return null;
  return db.one(
    `UPDATE sessions s
        SET last_seen_at = now(),
            idle_expires_at = now()
              + ((CASE WHEN u.is_minor THEN $2 ELSE $3 END) || ' minutes')::interval
       FROM users u
      WHERE s.id = $1
        AND u.id = s.user_id
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND s.idle_expires_at > now()
        AND u.deleted_at IS NULL
        AND u.status NOT IN ('blocked', 'suspended')
    RETURNING s.id, s.user_id`,
    [sessionId, String(config.sessionIdleMinutesMinor), String(config.sessionIdleMinutes)]
  );
}

async function revoke(sessionId, reason = 'logout') {
  await db.query(
    'UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
    [sessionId]
  );
  // Refresh tokens are minted against a session, so they die with it.
  await db.query(
    'UPDATE refresh_tokens SET revoked_at = now() WHERE session_id = $1 AND revoked_at IS NULL',
    [sessionId]
  );
  return reason;
}

// Used when an administrator blocks or deletes somebody: every device, every
// app, immediately.
async function revokeAllForUser(userId) {
  const { rowCount } = await db.query(
    'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
    [userId]
  );
  await db.query(
    'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
    [userId]
  );
  return rowCount;
}

async function listForUser(userId) {
  return db.many(
    `SELECT id, created_at, last_seen_at, expires_at, idle_expires_at,
            host(ip) AS ip, user_agent, revoked_at
       FROM sessions WHERE user_id = $1
      ORDER BY last_seen_at DESC LIMIT 50`,
    [userId]
  );
}

// ---------- cookies ----------

// A minimal parser rather than a dependency; the service only reads two.
function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); }
    catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

// ---------- CSRF ----------
// The session cookie is SameSite=Lax, which already blocks cross-site POSTs
// from forms. The double-submit token below is the belt to that pair of
// braces, and it also covers same-site subdomain surprises.

function issueCsrf(res) {
  const token = keys.randomToken(24);
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false, // the console's JS has to read it back
    secure: config.production,
    sameSite: 'lax',
    path: '/',
    maxAge: config.sessionAbsoluteHours * 3600 * 1000,
  });
  return token;
}

function checkCsrf(req) {
  if (!/^(POST|PUT|PATCH|DELETE)$/i.test(req.method)) return true;
  const cookies = parseCookies(req);
  const sent = req.get('x-csrf-token') || '';
  const held = cookies[CSRF_COOKIE] || '';
  if (!sent || !held) return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(held);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  COOKIE, CSRF_COOKIE, cookieOptions,
  create, touch, slide, revoke, revokeAllForUser, listForUser,
  parseCookies, issueCsrf, checkCsrf,
};
