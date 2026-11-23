// ===================================================================
// Teacher's Desk — seating plans for Signify Learning
//
// A seating chart is the desk's own (one plan per class, on the teacher's
// seating card). Signify Learning shows it on a lesson slide, on the
// teacher's screen and on the screens of the class following along, and
// takes attendance by tapping seats. It never keeps a copy: it asks here
// each time, and a seat it moves is moved here, through the same
// rev-checked board save every desk tab uses (server/board.js), so an open
// desk tab is told the board changed and reloads rather than overwriting it.
//
// Learning's SERVER asks, on the teacher's behalf, with the Signify ID token
// it holds for them. It is checked exactly as signify-auth checks the desk's
// own — signed by Signify ID, unexpired, an ID token — except that its
// audience is Learning (LEARNING_CLIENT_IDS), not the desk. Then Signify ID
// is asked, with that same token, whether this person teaches the class:
// only a class they stand in front of is ever served, and only their own
// desk is ever read or written. Same pattern as the help desk's
// desk-bearer.js, the other way round.
//
// The routes are only for that server: a browser's own desk cookie is not
// enough here (nothing on /api/learning is meant for a browser).
// ===================================================================

'use strict';

const crypto = require('crypto');
const signify = require('../signify-auth');
const store = require('./store');
const board = require('./board');
const roster = require('./roster');
const tools = require('./tools');
const auth = require('./auth');

const LEARNING_CLIENT_IDS = (process.env.LEARNING_CLIENT_IDS || 'signify-learning')
  .split(',').map((s) => s.trim()).filter(Boolean);

let jwks = { keys: [], fetchedAt: 0 };
async function keys(kid) {
  const fresh = Date.now() - jwks.fetchedAt < 10 * 60 * 1000;
  if (fresh && jwks.keys.some((k) => k.kid === kid)) return jwks.keys;
  try {
    const res = await fetch(`${signify.ISSUER}/.well-known/jwks.json`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) jwks = { keys: (await res.json()).keys || [], fetchedAt: Date.now() };
  } catch (e) {
    console.warn('desk learning: could not refresh JWKS —', e.message);
  }
  return jwks.keys;
}

/** The claims of a Signify ID token minted for Learning, or null. */
async function verify(token, { now = Date.now(), getKeys = keys } = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch { return null; }
  if (header.alg !== 'RS256') return null;
  const jwk = (await getKeys(header.kid)).find((k) => k.kid === header.kid);
  if (!jwk) return null;
  try {
    const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`),
      crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
    if (!ok) return null;
  } catch { return null; }
  if (payload.iss !== signify.ISSUER) return null;
  if (!LEARNING_CLIENT_IDS.includes(payload.aud)) return null;
  if (!payload.exp || payload.exp * 1000 <= now) return null;
  if (payload.typ !== 'id') return null;
  return payload;
}

/**
 * Express middleware for /api/learning only: req.user from Learning's bearer
 * token. Its permissions are Learning's (Signify ID scopes them to the app a
 * token was minted for), so perms stay empty and the routes below decide
 * from the role and Signify ID's class list instead.
 */
async function bearer(req, res, next) {
  try {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    if (m && signify.ENABLED) {
      const c = await verify(m[1]);
      if (c) {
        req.user = {
          id: c.sub, email: c.email, name: c.name, picture: c.picture,
          role: c.role, roleLabel: c.role_label,
          isSuper: !!c.is_super, isMinor: !!c.is_minor,
          tenant: c.tenant, tenantId: c.tenant_id, tenantName: c.tenant_name,
          perms: {}, sessionId: c.sid,
          vouchedBy: c.aud,
        };
        // What roster.js asks Signify ID with: the same token, as this person.
        req.signifyToken = m[1];
      } else {
        req.user = null;
      }
    }
  } catch (e) {
    console.error('desk learning:', e.message);
  }
  next();
}

// ---------------- the plan ----------------

const seatingDef = () => tools.RAW.get('seating');

/** The seating card holding this class's plan (the first with any desks), or null. */
function findPlan(items, key) {
  for (const it of items || []) {
    if (it.type !== 'seating' || !it.state || !it.state.plans) continue;
    const p = it.state.plans[key];
    if (p && Array.isArray(p.desks) && p.desks.length) return { item: it, plan: p };
  }
  return null;
}

/**
 * What Learning draws: the plan as the card draws it (room size, flipped or
 * not), each seat naming its pupil only when Signify ID still lists them in
 * the class, and the class with the short names the chairs show. Pure.
 */
function chartOf(boardDoc, key, students) {
  const def = seatingDef();
  const found = findPlan(boardDoc && boardDoc.items, key);
  const short = def._shortNames(students);
  const pupils = students.map((s) => ({ id: s.id, name: s.name, short: short.get(s.id) || s.name }));
  if (!found) return { chart: null, pupils };
  const here = new Set(students.map((s) => s.id));
  const drawn = def._drawPlan(found.plan, { room: found.item.state.room, flipped: found.item.state.flipped });
  for (const d of drawn.desks) for (const seat of d.seats) if (!here.has(seat.pupil)) seat.pupil = null;
  return { chart: { ...drawn, widgetId: found.item.id, rev: boardDoc.rev }, pupils };
}

/**
 * Moves one pupil, as tapping a name and then a seat does on the card:
 * into an empty seat, or swapping with whoever sat there when the pupil
 * came from a seat (otherwise the one displaced is simply unseated). `seat`
 * null unseats them. Returns the new items, or a reason. Pure.
 */
function moveIn(items, { widgetId, key, pupil, seat }, students) {
  if (!students.some((s) => s.id === pupil)) return { error: 'pupil' };
  const copy = JSON.parse(JSON.stringify(items || []));
  const it = copy.find((i) => i.id === widgetId && i.type === 'seating');
  const p = it && it.state && it.state.plans && it.state.plans[key];
  if (!p || !Array.isArray(p.desks) || !p.desks.length) return { error: 'plan' };
  if (!p.seats || typeof p.seats !== 'object') p.seats = {};
  if (seat != null) {
    const real = p.desks.some((d) => { const m = /^(.+)#(\d+)$/.exec(String(seat)); return m && m[1] === d.id && Number(m[2]) < (d.seats | 0); });
    if (!real) return { error: 'seat' };
  }
  const cameFrom = Object.keys(p.seats).find((k) => p.seats[k] === pupil) || null;
  if (seat == null) {
    if (cameFrom) delete p.seats[cameFrom];
    return { items: copy };
  }
  if (cameFrom === seat) return { items: copy, unchanged: true };
  const displaced = p.seats[seat] || null;
  if (cameFrom) delete p.seats[cameFrom];
  p.seats[seat] = pupil;
  if (displaced && cameFrom) p.seats[cameFrom] = displaced;
  return { items: copy };
}

const CLASS_ID = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * Who is asking, and the class's pupils, or an answer already sent. Signify
 * ID decides both: a teacher (or aide) of this class now, never someone it
 * could not be asked about.
 */
async function classFor(req, res) {
  if (!req.user || !req.user.vouchedBy) { res.status(401).json({ error: 'Only Signify Learning asks here.' }); return null; }
  if (req.user.role === 'student') { res.status(403).json({ error: 'Not for students.' }); return null; }
  if (!req.deskTools || !req.deskTools.has('seating')) { res.status(403).json({ error: 'Your school has not given your role the seating plan.' }); return null; }
  const classId = String(req.params.classId || '');
  if (!CLASS_ID.test(classId)) { res.status(404).json({ error: 'No such class.' }); return null; }
  const user = auth.userFromReq(req);
  const key = `signify:${classId}`;
  const { classes, signifyOk } = await roster.classesFor(req, user);
  if (!signifyOk) { res.status(502).json({ error: 'Signify ID could not be asked about this class.' }); return null; }
  if (!classes.some((c) => c.key === key)) { res.status(403).json({ error: 'You do not teach this class.' }); return null; }
  const members = await roster.membersOf(req, user, key);
  // Silence is not an empty class: never draw or change a plan against it.
  if (!members) { res.status(502).json({ error: 'Signify ID could not list this class.' }); return null; }
  return { user, key, students: members.students };
}

async function getSeating(req, res) {
  const c = await classFor(req, res); if (!c) return;
  res.set('Cache-Control', 'no-store');
  res.json(chartOf(store.load().boards[c.user.uid], c.key, c.students));
}

async function putSeating(req, res) {
  const c = await classFor(req, res); if (!c) return;
  res.set('Cache-Control', 'no-store');
  const body = req.body || {};
  const current = store.load().boards[c.user.uid];
  if (!current) return res.status(404).json({ error: 'There is no desk to change.' });
  if (Number(body.rev) !== current.rev) {
    return res.status(409).json({ error: 'The desk changed since.', ...chartOf(current, c.key, c.students) });
  }
  const pupil = typeof body.pupil === 'string' ? body.pupil.slice(0, 80) : '';
  const seat = body.seat == null ? null : String(body.seat).slice(0, 80);
  const moved = moveIn(current.items, { widgetId: String(body.widgetId || ''), key: c.key, pupil, seat }, c.students);
  if (moved.error) return res.status(400).json({ error: `That ${moved.error} is not on this plan.` });
  if (!moved.unchanged) {
    const result = board.saveBoard(c.user, { rev: current.rev, items: moved.items }, req.deskTools);
    if (result.conflict) return res.status(409).json({ error: 'The desk changed since.', ...chartOf(result.board, c.key, c.students) });
    if (result.tooBig) return res.status(413).json({ error: 'This desk is holding too much to save.' });
    console.log(`desk: board ${c.user.uid} rev ${result.rev} — seat moved from Signify Learning`);
  }
  res.json(chartOf(store.load().boards[c.user.uid], c.key, c.students));
}

module.exports = { bearer, verify, getSeating, putSeating, LEARNING_CLIENT_IDS, _chartOf: chartOf, _moveIn: moveIn, _findPlan: findPlan };
