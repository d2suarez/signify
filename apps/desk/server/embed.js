// ===================================================================
// Teacher's Desk — signed in automatically inside Signify Learning's rail
//
// Learning's left rail frames /embed (the person's own desk cards). With a
// desk sign-in of its own in that browser the frame just works. Without one
// (never signed in to the desk on this computer, or the desk's sign-in has
// lapsed while Learning's has not) it used to show "Sign in to Teacher's
// Desk", which cannot happen inside a frame (Signify ID refuses to be framed).
//
// Instead Learning vouches for the person:
//
//   1. The frame asks its parent (postMessage, to the one origin it trusts).
//   2. Learning's SERVER asks here, POST /api/learning/embed-ticket, with the
//      Signify ID token it holds for them. learning.bearer checks the token
//      was minted for Learning (signed by ID, unexpired); we then ask Signify
//      ID, with that same token, whether this person may open Teacher's Desk
//      at all (/api/v1/my-apps: the same decision ID makes at the desk's own
//      sign-in door). Guardians never get a desk.
//   3. We answer a one-use ticket (60 seconds). Learning hands it to its page,
//      the page to the frame, and the frame trades it (POST /embed/session,
//      same origin only) for a cookie holding a random session id. The ticket
//      and session live in memory only; a restart just means asking again.
//   4. That cookie counts ONLY for requests made by the /embed page itself
//      (Referer is /embed; Referrer-Policy is same-origin). The whole desk
//      opened in its own tab never sees it and signs in the normal way. A
//      real desk sign-in always wins over it.
//
// The session ends when Learning's token does (minutes); the frame asks for
// a fresh ticket shortly before then, and again on any 401.
//
// What it may do: the person's own desk, with the tools Signify ID's Tools by
// role gives their role (policy.attach, as for everybody: a student gets only
// what their school allows students). Desk permissions travel only in a
// desk-minted token, so we cannot see them here: staff get `desk:use` (their
// school has given them the desk app) and never `desk:behaviour`, so
// behaviour notes still need the desk's own sign-in.
// ===================================================================

'use strict';

const crypto = require('crypto');
const signify = require('../signify-auth');

const PRODUCTION = !!process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production';
const COOKIE = 'desk_emb';
const TICKET_TTL_MS = 60 * 1000;
// However long Learning's token says, never more than a school day.
const MAX_SESSION_MS = 12 * 60 * 60 * 1000;
const DESK_CLIENT_IDS = [process.env.SIGNIFY_CLIENT_ID || 'teachers-desk', 'teachers-desk'];
const NO_DESK_ROLES = new Set(['guardian', 'parent']);
const STUDENT_ROLE = 'student';

const tickets = new Map();  // sha256(ticket) -> { user, token, until, ticketUntil }
const sessions = new Map(); // sha256(session id) -> { user, token, until }

const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('base64url');

function prune(now = Date.now()) {
  for (const [k, t] of tickets) if (t.ticketUntil <= now || t.until <= now) tickets.delete(k);
  for (const [k, s] of sessions) if (s.until <= now) sessions.delete(k);
}

/** Does Signify ID let this person open Teacher's Desk? true / false / null (couldn't ask). */
async function deskIsOpenTo(token) {
  try {
    const res = await fetch(`${signify.ISSUER}/api/v1/my-apps`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
    });
    if (res.status === 401) return false;
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.apps) && data.apps.some((a) => a && DESK_CLIENT_IDS.includes(a.id));
  } catch (e) {
    console.warn('desk embed: could not ask Signify ID which apps —', e.message);
    return null;
  }
}

/**
 * POST /api/learning/embed-ticket, Learning's server only (after
 * learning.bearer). Answers { ticket, until }.
 */
async function mintTicket(req, res, { now = Date.now(), isOpen = deskIsOpenTo } = {}) {
  const u = req.user;
  if (!u || !u.vouchedBy || !req.signifyToken) return res.status(401).json({ error: 'Only Signify Learning, for a signed-in person.' });
  if (NO_DESK_ROLES.has(u.role)) return res.status(403).json({ error: 'Teacher’s Desk is for staff and students.' });
  const open = await isOpen(req.signifyToken);
  if (open === null) return res.status(502).json({ error: 'Could not reach Signify ID. Try again.' });
  if (!open) return res.status(403).json({ error: 'Your school hasn’t given you Teacher’s Desk.' });

  let exp = now + MAX_SESSION_MS;
  try {
    const p = JSON.parse(Buffer.from(String(req.signifyToken).split('.')[1], 'base64url').toString());
    if (p && p.exp) exp = Math.min(exp, p.exp * 1000);
  } catch { /* verified already; keep the cap */ }
  if (exp <= now) return res.status(401).json({ error: 'That sign-in has ended.' });

  const user = {
    ...u,
    vouchedBy: undefined, // that means "Learning's server, for /api/learning"; this is a browser
    perms: u.role === STUDENT_ROLE || u.isSuper ? {} : { 'desk:use': 'own' },
    embed: true,
  };
  prune(now);
  const ticket = crypto.randomBytes(32).toString('base64url');
  tickets.set(hash(ticket), { user, token: req.signifyToken, until: exp, ticketUntil: now + TICKET_TTL_MS });
  res.set('Cache-Control', 'no-store');
  res.json({ ticket, until: exp });
}

function sameOrigin(req) {
  const site = req.get('sec-fetch-site');
  if (site) return site === 'same-origin';
  const origin = req.get('origin');
  return !!origin && origin === `${req.protocol}://${req.get('host')}`;
}

/** POST /embed/session { ticket }: the frame trades its ticket for the cookie. */
function redeem(req, res, { now = Date.now() } = {}) {
  if (!sameOrigin(req)) return res.status(403).json({ error: 'Not from this desk.' });
  const ticket = req.body && typeof req.body.ticket === 'string' ? req.body.ticket : '';
  const key = hash(ticket);
  const t = ticket && tickets.get(key);
  tickets.delete(key);
  if (!t || t.ticketUntil <= now || t.until <= now) return res.status(401).json({ error: 'That ticket has expired.' });
  const sid = crypto.randomBytes(32).toString('base64url');
  sessions.set(hash(sid), { user: t.user, token: t.token, until: t.until });
  const maxAge = Math.max(1, Math.floor((t.until - now) / 1000));
  res.append('Set-Cookie', `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${PRODUCTION ? '; Secure' : ''}`);
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, until: t.until });
}

/** Made by the /embed page (its fetches, its pictures), not by a desk tab. */
function fromEmbedPage(req) {
  const ref = req.get('referer');
  if (!ref) return false;
  try {
    const u = new URL(ref);
    return u.host === req.get('host') && u.pathname === '/embed';
  } catch { return false; }
}

function cookieValue(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]+)`).exec(req.headers.cookie || '');
  return m ? m[1] : null;
}

/**
 * Middleware, after signify.middleware and the LTI header: a request from
 * the /embed page with no desk sign-in of its own, but a live embed session,
 * is that person.
 */
function identify(req, res, next) {
  if (req.user || req.lti || req.path.startsWith('/api/learning') || req.path.startsWith('/auth')) return next();
  const sid = cookieValue(req);
  if (!sid || !fromEmbedPage(req)) return next();
  const s = sessions.get(hash(sid));
  if (!s || s.until <= Date.now()) return next();
  req.user = s.user;
  req.signifyToken = s.token;
  req.embedSession = true;
  next();
}

module.exports = {
  mintTicket, redeem, identify, deskIsOpenTo, COOKIE,
  _internal: { tickets, sessions, prune, fromEmbedPage, hash },
};
