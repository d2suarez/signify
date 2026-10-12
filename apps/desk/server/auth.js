// ===================================================================
// Teacher's Desk — identity, via Signify ID
//
// The desk does not talk to Google, verify tokens or mint sessions; Signify
// ID does all of that. This file is the thin adapter between the claims it
// hands back and what the rest of the server wants, plus the two permissions
// the desk declares for itself.
//
// Everything the desk stores is keyed on `req.user.id` — the Signify uuid —
// and never on the email address, because a school can release an address to
// a new pupil and the uuid never changes hands.
// ===================================================================

const signify = require('../signify-auth');
const store = require('./store');

const PRODUCTION = !!process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production';

// Two permissions, deliberately separate. A classroom aide or student teacher
// can be given the board of tools without also being given the power to write
// records about a child's behaviour.
const PERMISSIONS = [
  { key: 'desk:use', label: 'Use the teacher’s desk and its tools' },
  { key: 'desk:behaviour', label: 'Record and read behaviour notes for their own classes' },
];

// ---------- local development ----------
// Signing in needs the identity service, a Google client and https. This is
// how the board gets worked on without any of that. It refuses to exist in a
// hosted environment, the same stance Signify ID's own dev login takes.
const DEV_USER = (() => {
  if (!process.env.DESK_DEV_USER) return null;
  if (PRODUCTION) {
    throw new Error('DESK_DEV_USER is set in a hosted environment. Refusing to start.');
  }
  console.warn('\n  ⚠  DESK_DEV_USER is on: every request is signed in as a made-up teacher.\n');
  return {
    id: 'dev-teacher-0000',
    email: 'dev.teacher@example.school',
    name: 'Dev Teacher',
    picture: '',
    role: 'teacher',
    roleLabel: 'Teacher',
    isSuper: false,
    isMinor: false,
    tenantId: 'dev-school',
    tenantName: 'Development School',
    perms: { 'desk:use': 'class', 'desk:behaviour': 'class', 'core:view_directory': 'tenant' },
    sessionId: 'dev-session',
  };
})();

function devMiddleware(req, res, next) {
  if (DEV_USER && !req.user) req.user = DEV_USER;
  next();
}

// ---------- what the rest of the server calls ----------

/**
 * Records that this person exists, and returns the desk's view of them.
 * Called on every authenticated request, which is also what keeps `lastSeen`
 * honest for the retention sweep.
 */
function userFromReq(req) {
  const claims = req.user;
  if (!claims) return null;

  const db = store.load();
  const now = Date.now();
  const rec = db.users[claims.id] || { uid: claims.id, firstSeen: now };
  rec.email = claims.email;
  rec.name = claims.name || rec.name || (claims.email || '').split('@')[0];
  rec.picture = claims.picture || '';
  rec.tenantId = claims.tenantId || null;
  rec.tenantName = claims.tenantName || null;
  // Only write once a minute; this runs on every API call.
  if (!rec.lastSeen || now - rec.lastSeen > 60_000) { rec.lastSeen = now; db.users[claims.id] = rec; store.save(); }
  else db.users[claims.id] = rec;

  return {
    uid: claims.id,
    email: claims.email,
    name: rec.name,
    picture: rec.picture,
    role: claims.role,
    roleLabel: claims.roleLabel,
    isSuper: !!claims.isSuper,
    tenantId: rec.tenantId,
    tenantName: rec.tenantName,
    perms: claims.perms || {},
    claims,
  };
}

function requireUser(req, res) {
  const u = userFromReq(req);
  if (!u) { res.status(401).json({ error: 'Please sign in.' }); return null; }
  return u;
}

// The desk itself. Anyone who can use it at all holds this.
function requireDesk(req, res) {
  const u = requireUser(req, res);
  if (!u) return null;
  if (!signify.has(req.user, 'desk:use', 'own')) {
    res.status(403).json({ error: 'Your role does not include the teacher’s desk.' });
    return null;
  }
  return u;
}

// Writing down what a child did is a separate decision from using a timer.
function requireBehaviour(req, res) {
  const u = requireDesk(req, res);
  if (!u) return null;
  if (!signify.has(req.user, 'desk:behaviour', 'class')) {
    res.status(403).json({ error: 'Your role does not include behaviour notes.' });
    return null;
  }
  return u;
}

const can = (req, perm, scope = 'own') => signify.has(req.user, perm, scope);

module.exports = {
  PERMISSIONS,
  ENABLED: signify.ENABLED,
  DEV: !!DEV_USER,
  devMiddleware,
  userFromReq, requireUser, requireDesk, requireBehaviour, can,
};
