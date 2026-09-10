const express = require('express');
const compression = require('compression');
const zlib = require('zlib');
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// Availability safety net: a classroom full of students should never be taken
// down by a single stray error (e.g. an ENOSPC on a background file write, which
// crash-looped the server once). Log and keep serving rather than exiting.
process.on('uncaughtException', (e) => {
  console.error('Uncaught exception (server kept alive):', (e && e.stack) || e);
});
process.on('unhandledRejection', (e) => {
  console.error('Unhandled promise rejection:', (e && e.stack) || e);
});

// ---------- auth ----------
// Identity is Signify ID's job now. The whiteboard neither talks to Google
// nor mints sessions; it reads the claims Signify puts on each request.
//
// store.users survives as a SHADOW: a local copy of who has signed in, used
// for listing people in the admin portal, for per-student feature switches
// and for board ownership. It is authoritative for none of that — every
// authorisation decision comes from the claims on the request, and the shadow
// is refreshed from them on every call.
const signify = require('./signify-auth');
const AUTH_ENABLED = signify.ENABLED;

// Permissions this app owns, declared to Signify ID on boot so they can be
// put into roles there. Adding one is a change here, not there.
const WB_PERMISSIONS = [
  { key: 'whiteboard:teach', label: 'Host and lead a board' },
  { key: 'whiteboard:manage_boards', label: 'Manage every board in the school', admin: true },
  { key: 'whiteboard:view_sessions', label: 'See who is in live sessions', admin: true },
  { key: 'whiteboard:manage_templates', label: 'Publish to the school template library' },
];

// The whiteboard's own permission names, mapped to the Signify ones. Keeping
// the local vocabulary means the 50-odd call sites below did not change.
const PERM_MAP = {
  teach: 'whiteboard:teach',
  manage_boards: 'whiteboard:manage_boards',
  view_sessions: 'whiteboard:view_sessions',
  manage_templates: 'whiteboard:manage_templates',
  // Managing people and school domains moved to Signify ID entirely.
  manage_users: 'core:manage_users',
  manage_domains: 'core:manage_tenants',
};

// Turns Signify claims into the shape this file already speaks.
function permsFromClaims(claims) {
  if (!claims) return [];
  if (claims.isSuper) return [...PERMISSIONS];
  return PERMISSIONS.filter((p) => claims.perms && claims.perms[PERM_MAP[p]]);
}

// Refreshes the local shadow from the claims on this request.
function shadow(claims) {
  if (!claims) return null;
  const email = String(claims.email).toLowerCase();
  const now = Date.now();
  const rec = store.users[email] || { firstSeen: now };

  // A released address is a different person now. Signify issues them a new
  // id, so the shadow must not hand them the previous pupil's boards.
  if (rec.uid && rec.uid !== claims.id) {
    const archived = `${email}#released-${now}`;
    store.users[archived] = { ...rec, releasedAt: now };
    delete store.users[email];
    for (const meta of boardsIndex.values()) if (meta.owner === email) meta.owner = archived;
    console.warn(`whiteboard: ${email} was released to a new person; previous boards archived as ${archived}`);
    return shadow(claims);
  }

  rec.uid = claims.id;
  rec.name = claims.name || rec.name || email;
  rec.role = claims.isSuper ? 'superadmin' : (claims.role || 'student');
  rec.perms = permsFromClaims(claims);
  rec.isSuper = !!claims.isSuper;
  rec.status = 'approved';   // Signify would not have issued a token otherwise
  rec.lastSeen = now;
  store.users[email] = rec;
  saveStore();
  return rec;
}

// ---------- permissions & roles ----------

const PERMISSIONS = ['teach', 'manage_users', 'manage_boards', 'view_sessions', 'manage_domains'];

// ---------- feature switches ----------
// Features can be turned on/off per school domain (admin), per room (teacher),
// or per student in a room (teacher). Most specific setting wins; default is on.

const FEATURES = ['draw', 'text', 'images', 'documents', 'charts', 'newBoards', 'download', 'embed'];

// Apply a tri-state patch {feature: true|false|null} — null clears the override
function applyFeaturePatch(target, patch) {
  if (!patch || typeof patch !== 'object') return;
  for (const f of FEATURES) {
    if (!(f in patch)) continue;
    const v = patch[f];
    if (v === true || v === false) target[f] = v;
    else delete target[f];
  }
}

function effectiveFeatures(room, id) {
  const out = {};
  const domainMap = AUTH_ENABLED ? (store.domainFeatures[domainOf(id)] || null) : null;
  const roomMap = room.data.features || {};
  const studentMap = (room.data.studentFeatures || {})[id] || {};
  for (const f of FEATURES) {
    let v = true;
    if (domainMap && domainMap[f] !== undefined) v = domainMap[f];
    if (roomMap[f] !== undefined) v = roomMap[f];
    if (studentMap[f] !== undefined) v = studentMap[f];
    out[f] = v;
  }
  return out;
}

const DEFAULT_ROLES = {
  student: { label: 'Student', builtin: true, perms: [] },
  teacher: { label: 'Teacher', builtin: true, perms: ['teach'] },
  admin: { label: 'Local admin', builtin: true, perms: ['teach', 'manage_users', 'manage_boards', 'view_sessions'] },
};

// ---------- admin store ----------
// Persistent access control, managed from the admin portal:
//   users:   email -> { name, role, status: approved|pending|blocked, firstSeen, lastSeen, addedBy }
//   domains: approved email domains (accounts on them are auto-approved)
//   roles:   role id -> { label, builtin, perms: [...] }

const STORE_FILE = path.join(DATA_DIR, 'admin.json');
let store = { users: {}, domains: [], roles: {} };
try {
  if (fs.existsSync(STORE_FILE)) store = Object.assign(store, JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')));
} catch (e) {
  console.error('Could not read admin store:', e.message);
}
store.roles = Object.assign({}, DEFAULT_ROLES, store.roles || {});
store.roles.student = { ...store.roles.student, perms: [] }; // the fallback role stays permissionless
store.domainFeatures = store.domainFeatures || {}; // domain -> {feature: bool}
store.templateOpenDomains = store.templateOpenDomains || []; // domains where teachers post to school library without approval

// ---------- audit log (admin actions) ----------
const AUDIT_FILE = path.join(DATA_DIR, 'audit.json');
let auditLog = [];
try { if (fs.existsSync(AUDIT_FILE)) auditLog = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8')); } catch { auditLog = []; }
let auditTimer = null;
function appendAudit(actor, action, detail) {
  auditLog.push({ ts: Date.now(), actor, action, detail: String(detail || '').slice(0, 200) });
  if (auditLog.length > 1000) auditLog = auditLog.slice(-1000);
  if (!auditTimer) auditTimer = setTimeout(() => {
    auditTimer = null;
    fs.writeFile(AUDIT_FILE, JSON.stringify(auditLog), (e) => { if (e) console.error('Audit save failed', e.message); });
  }, 500);
}

let storeTimer = null;
function saveStore() {
  if (storeTimer) return;
  storeTimer = setTimeout(() => {
    storeTimer = null;
    fs.writeFile(STORE_FILE, JSON.stringify(store, null, 2), (err) => {
      if (err) console.error('Admin store save failed:', err.message);
    });
  }, 300);
}

// All three read the shadow, which was written from Signify's claims the last
// time this person made a request. Nothing here is a source of truth.
function isSuperAdmin(email) {
  const rec = store.users[email];
  return !!(rec && rec.isSuper);
}

function effectiveRole(email) {
  const rec = store.users[email];
  if (!rec) return 'student';
  return rec.isSuper ? 'superadmin' : (rec.role || 'student');
}

function permsFor(email) {
  const rec = store.users[email];
  return (rec && rec.perms) || [];
}

function hasPerm(email, perm) {
  return permsFor(email).includes(perm);
}

// Any permission beyond teaching makes an account "admin-like"
function adminPerms(perms) {
  return perms.some((p) => p !== 'teach');
}

function domainOf(email) {
  return email.split('@')[1] || '';
}

// A client-supplied string is about to be used as an object/map key. Reject the
// ones that walk the prototype chain, or they poison Object.prototype globally.
function isSafeKey(k) {
  return k !== '__proto__' && k !== 'constructor' && k !== 'prototype';
}

function domainApproved(email) {
  return store.domains.includes(domainOf(email));
}

// Approval, suspension and blocking all live in Signify ID now — it simply
// will not issue a token to an account in any of those states, so anyone
// reaching this code has already passed. Kept as a function because the call
// sites read better for it, and because an unknown address is still unknown.
function accessStatus(email) {
  return store.users[email] ? 'approved' : 'pending';
}

// Scope rule: a non-super manager may only touch accounts that (a) are not
// super admins, (b) hold no admin-like permissions themselves, and (c) share
// the manager's email domain or were added by the manager.
function canManageTarget(manager, targetEmail) {
  if (isSuperAdmin(targetEmail)) return false;
  if (manager.isSuper) return true;
  if (adminPerms(permsFor(targetEmail))) return false;
  const rec = store.users[targetEmail];
  return domainOf(manager.email) === domainOf(targetEmail) || !!(rec && rec.addedBy === manager.email);
}

// Non-super managers may only hand out roles that carry no admin permissions
function canAssignRole(manager, roleId) {
  const role = store.roles[roleId];
  if (!role) return false;
  if (manager.isSuper) return true;
  return !adminPerms(role.perms);
}

// ---------- sessions ----------

// ---------- http ----------

const app = express();
const server = http.createServer(app);
// perMessageDeflate: board JSON is highly compressible text — this is the
// single biggest egress (cost) saver for live drawing sync
const io = new Server(server, {
  // Boards with imported documents (each PDF page is a data-URL image) can be
  // tens of MB. If a message exceeds this cap socket.io KILLS the connection,
  // which on classroom wifi turned into a silent reconnect/data-loss loop.
  maxHttpBufferSize: 100 * 1024 * 1024,
  // A slow multi-MB board transfer on school wifi can stall pings past the
  // 20s default and get the socket dropped mid-flight — give it headroom.
  pingTimeout: 60000,
  perMessageDeflate: { threshold: 1024 },
});

// Canonical host: send external requests for any other hostname (e.g. the old
// Railway URL) to CANONICAL_HOST. Gated on x-forwarded-proto so internal health
// checks and localhost are never redirected.
const CANONICAL_HOST = (process.env.CANONICAL_HOST || '').toLowerCase();
if (CANONICAL_HOST) {
  app.use((req, res, next) => {
    const host = (req.headers.host || '').toLowerCase().split(':')[0];
    if (req.headers['x-forwarded-proto'] && host && host !== CANONICAL_HOST) {
      return res.redirect(301, `https://${CANONICAL_HOST}${req.originalUrl}`);
    }
    next();
  });
}

app.set('trust proxy', true); // behind Railway's proxy — needed for a correct req.ip

// ---------- security headers ----------
// Scripts allow 'unsafe-inline' (a few inline blocks) but NO arbitrary external
// hosts beyond Google sign-in — that's the meaningful XSS protection. Google
// allowances are deliberately broad so sign-in can't break. The embed page must
// stay iframe-able on other sites, so it alone skips the frame restrictions.
const CSP_BASE = [
  "default-src 'self'",
  // 'unsafe-eval' is required by the Fabric.js canvas engine; 'unsafe-inline'
  // by a few inline blocks. Restricting the HOSTS is still the real protection.
  // Google is allowed broadly (*.google.com et al.) so sign-in can never break.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.google.com https://apis.google.com https://*.gstatic.com https://*.googleapis.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.googleusercontent.com https://*.gstatic.com https://*.google.com",
  "font-src 'self' data:",
  "connect-src 'self' https://*.google.com https://*.googleapis.com",
  "worker-src 'self' blob:",
  "frame-src 'self' https://*.google.com https://content.googleapis.com",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  const isEmbed = req.path.startsWith('/embed/') || req.path === '/embed.html';
  if (isEmbed) {
    res.setHeader('Content-Security-Policy', CSP_BASE); // framing allowed for embeds
  } else {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', CSP_BASE + "; frame-ancestors 'self'");
  }
  next();
});

// ---------- lightweight in-memory rate limiting ----------
// One small Railway instance, so in-process fixed-window counters are enough.
function makeLimiter({ windowMs, max }) {
  const hits = new Map(); // key -> { count, resetAt }
  setInterval(() => { const now = Date.now(); for (const [k, e] of hits) if (e.resetAt < now) hits.delete(k); }, windowMs).unref();
  return (key) => {
    const now = Date.now();
    let e = hits.get(key);
    if (!e || e.resetAt < now) { e = { count: 0, resetAt: now + windowMs }; hits.set(key, e); }
    return ++e.count <= max;
  };
}
const apiLimiter = makeLimiter({ windowMs: 60 * 1000, max: 600 });    // general API: generous
const authLimiter = makeLimiter({ windowMs: 60 * 1000, max: 30 });    // sign-in attempts
const convertLimiter = makeLimiter({ windowMs: 60 * 1000, max: 10 }); // LibreOffice conversions (expensive)
const joinLimiter = makeLimiter({ windowMs: 60 * 1000, max: 60 });    // socket room-code join attempts (per IP)

app.use('/api/', (req, res, next) => {
  let limiter = apiLimiter;
  if (req.path === '/auth/google') limiter = authLimiter;
  else if (req.path === '/convert') limiter = convertLimiter;
  if (!limiter(req.ip)) return res.status(429).json({ error: 'Too many requests — please slow down.' });
  next();
});

app.use(compression()); // gzip responses — cuts static + API egress ~3-5x
// vendored libraries change rarely: let browsers cache them for a week
app.use('/vendor', express.static(path.join(__dirname, 'public', 'vendor'), { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' })); // personal-board REST saves carry full board JSON incl. document images

// Sign-in, sign-out and the callback, plus req.user on every request.
signify.mount(app, {
  permissions: WB_PERMISSIONS,
  postLogoutUri: CANONICAL_HOST ? `https://${CANONICAL_HOST}/` : undefined,
});
app.use(signify.middleware);

// ---------- identity management moved to Signify ID ----------
// Approving people, changing roles, promoting year groups and approving
// school domains are all Signify ID's job now. These endpoints are refused
// here rather than quietly left working, because two places that can both
// change somebody's role is exactly how the two disagree.
//
// Registered ahead of the originals so they intercept; the old handlers
// below are dead and can be deleted once this has settled.
const IDENTITY_MOVED = [
  ['post', '/api/admin/user', 'Adding and editing people'],
  ['post', '/api/admin/users/grade', 'Setting year groups'],
  ['post', '/api/admin/users/promote', 'Promoting year groups'],
  ['post', '/api/admin/users/demote', 'Demoting year groups'],
  ['post', '/api/admin/users/bulk', 'Bulk changes to people'],
  ['delete', '/api/admin/user/:email', 'Removing people'],
  ['post', '/api/admin/roles', 'Creating and editing roles'],
  ['post', '/api/admin/domains', 'Approving school domains'],
];
const SIGNIFY_CONSOLE = (process.env.SIGNIFY_ISSUER || 'https://id.signify.one') + '/admin';
for (const [method, route, what] of IDENTITY_MOVED) {
  app[method](route, (req, res) => res.status(410).json({
    error: `${what} now happens in Signify ID, so every app agrees on who somebody is.`,
    moved: true,
    console: SIGNIFY_CONSOLE,
  }));
}

app.get('/api/config', (req, res) => {
  res.json({
    authEnabled: AUTH_ENABLED,
    signInUrl: '/auth/login',
    signOutUrl: '/auth/logout',
    // Google Classroom import keeps its own client: it asks for roster
    // scopes, which are sensitive and quite separate from signing in.
    // Unset simply hides the import button.
    classroomClientId: process.env.GOOGLE_CLASSROOM_CLIENT_ID || '',
  });
});

// Who is signed in, in the shape the client already speaks — including the
// whiteboard's own permission names rather than Signify's.
app.get('/api/me', (req, res) => {
  const u = sessionFromReq(req);
  if (!u) return res.status(401).json({ error: 'Not signed in.' });
  res.json({
    email: u.email,
    name: u.name,
    role: effectiveRole(u.email),
    perms: permsFor(u.email),
    isSuper: isSuperAdmin(u.email),
    school: req.user.tenantName || null,
  });
});

// Whoever is making this request, in the shape the rest of the file expects.
// The shadow is refreshed here, on every authenticated call, so a role change
// in Signify reaches the whiteboard within one request rather than at the
// next sign-in.
function sessionFromReq(req) {
  if (!req.user) return null;
  shadow(req.user);
  return { email: String(req.user.email).toLowerCase(), name: req.user.name };
}

// Full room listing is for board admins; teachers use /api/my/rooms
app.get('/api/rooms', (req, res) => {
  if (!AUTH_ENABLED) return res.json(listRooms()); // open mode: trusted LAN
  const admin = requirePerm(req, res, 'manage_boards');
  if (!admin) return; // requirePerm already responded
  // Scope to the admin's own school — do not leak other schools' room codes,
  // names, and owner emails (which also fed the classroom-takeover vector).
  res.json(listRooms().filter((r) => admin.isSuper || !r.owner || sameDomainOrAdded(admin, r.owner)));
});

// ---------- classrooms (rosters, ownership) ----------

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function requireUser(req, res) {
  if (!AUTH_ENABLED) {
    res.status(400).json({ error: 'This feature requires Google sign-in to be enabled.' });
    return null;
  }
  const user = sessionFromReq(req);
  if (!user) {
    res.status(401).json({ error: 'Please sign in again.' });
    return null;
  }
  if (accessStatus(user.email) !== 'approved') {
    res.status(403).json({ error: 'Your account does not have access.' });
    return null;
  }
  return { email: user.email, name: user.name, perms: permsFor(user.email), isSuper: isSuperAdmin(user.email) };
}

function canEditRoom(user, data) {
  return user.isSuper || user.perms.includes('manage_boards') || data.owner === user.email;
}

// Which accounts a user may see when searching for students to enroll:
// super admin sees everyone; everyone else sees their own email domain
// plus accounts they added themselves.
function inStudentScope(user, email) {
  if (user.isSuper) return true;
  const rec = store.users[email];
  return domainOf(email) === domainOf(user.email) || !!(rec && rec.addedBy === user.email);
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code) || fs.existsSync(roomFile(code)));
  return code;
}

function rosterEntries(room) {
  return (room.data.roster || []).map((email) => ({
    email,
    name: room.data.names[email] || (store.users[email] && store.users[email].name) || email,
    status: accessStatus(email),
    online: room.students.has(email),
    // boards live in their own files now — data.boards is legacy and gets
    // deleted by migrateLegacyBoards, so never read it here (it threw a 500
    // that made the Students window close as soon as anyone was enrolled)
    hasBoard: boardsFor(email, room.code).length > 0,
  }));
}

app.get('/api/my/rooms', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const teaching = [];
  const enrolled = [];
  const archived = [];
  for (const r of roomSummaries()) {
    // the requester's own latest board in that class makes the best card preview
    const mine = boardsFor(user.email, r.code)[0];
    const item = { code: r.code, name: r.name, owner: r.owner, updatedAt: r.updatedAt, students: r.roster.length, thumb: mine ? mine.thumb : null };
    if (r.owner === user.email) {
      if (r.archived) archived.push(item);
      else teaching.push(item);
    } else if (r.roster.includes(user.email) && !r.archived) enrolled.push(item);
  }
  res.json({ teaching, enrolled, archived });
});

// ---------- template endpoints ----------

app.get('/api/templates', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const out = [];
  for (const meta of templatesIndex.values()) {
    if (!canSeeTemplate(user, meta)) continue;
    out.push({ ...meta, mine: meta.owner === user.email, canManage: canManageTemplate(user, meta) });
  }
  out.sort((a, b) => a.subject.localeCompare(b.subject) || a.title.localeCompare(b.title));
  res.json({ templates: out, subjects: TEMPLATE_SUBJECTS });
});

app.get('/api/templates/:id', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const meta = templatesIndex.get(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Template not found.' });
  if (!canSeeTemplate(user, meta)) return res.status(403).json({ error: 'You cannot use this template.' });
  res.json({ ...meta, json: readTemplateJSON(meta.id) });
});

app.post('/api/templates', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!user.isSuper && !user.perms.includes('teach')) return res.status(403).json({ error: 'Only teachers and admins can save templates.' });
  const title = String(req.body.title || '').trim().slice(0, 60);
  const subject = TEMPLATE_SUBJECTS.includes(req.body.subject) ? req.body.subject : 'General';
  const scope = ['personal', 'school', 'public'].includes(req.body.scope) ? req.body.scope : 'personal';
  const json = req.body.json;
  if (!title) return res.status(400).json({ error: 'Give the template a name.' });
  if (!json || typeof json !== 'object') return res.status(400).json({ error: 'Nothing to save.' });
  if (scope === 'school' && !AUTH_ENABLED) return res.status(400).json({ error: 'School library needs sign-in.' });

  const isBoardAdmin = user.isSuper || user.perms.includes('manage_boards');
  let status = 'approved';
  if (scope === 'public') status = user.isSuper ? 'approved' : 'pending';
  else if (scope === 'school') {
    const open = store.templateOpenDomains.includes(domainOf(user.email));
    status = (isBoardAdmin || open) ? 'approved' : 'pending';
  }
  const meta = createTemplate({
    title, subject, scope, status,
    domain: scope === 'school' ? domainOf(user.email) : (scope === 'public' ? null : null),
    owner: user.email, ownerName: user.name,
    thumb: validThumb(req.body.thumb) ? req.body.thumb : null, json,
  });
  if (status === 'pending') appendAudit(user.email, 'template:submit', `${scope} "${title}"`);
  res.json({ ...meta, submitted: status === 'pending' });
});

app.post('/api/templates/:id/approve', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const meta = templatesIndex.get(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Template not found.' });
  if (!canManageTemplate(user, meta)) return res.status(403).json({ error: 'You cannot approve this template.' });
  meta.status = 'approved';
  saveTemplateMeta(meta.id);
  appendAudit(user.email, 'template:approve', `${meta.scope} "${meta.title}" by ${meta.ownerName}`);
  res.json({ ok: true });
});

app.delete('/api/templates/:id', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const meta = templatesIndex.get(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Template not found.' });
  if (meta.owner === '__builtin__' && !user.isSuper) return res.status(403).json({ error: 'Starter templates can only be removed by the super admin.' });
  if (meta.owner !== user.email && !canManageTemplate(user, meta)) return res.status(403).json({ error: 'You cannot remove this template.' });
  deleteTemplate(meta.id);
  appendAudit(user.email, 'template:delete', `${meta.scope} "${meta.title}"`);
  res.json({ ok: true });
});

app.post('/api/rooms/create', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const isBoardAdmin = user.isSuper || user.perms.includes('manage_boards');
  if (!isBoardAdmin && !user.perms.includes('teach')) {
    return res.status(403).json({ error: 'Your role cannot create classrooms.' });
  }
  const code = sanitizeCode(req.body.code) || generateRoomCode();
  if (rooms.has(code) || fs.existsSync(roomFile(code))) {
    return res.status(400).json({ error: `Room code ${code} is already in use.` });
  }
  let owner = user.email;
  if (req.body.owner && isBoardAdmin) {
    owner = String(req.body.owner).trim().toLowerCase();
    if (!EMAIL_RE.test(owner)) return res.status(400).json({ error: 'The owner must be an email address.' });
  }
  const room = getRoom(code, true);
  room.data.name = String(req.body.name || '').trim().slice(0, 50);
  room.data.owner = owner;
  room.data.updatedAt = Date.now();
  scheduleSave(room);
  res.json({ code, name: room.data.name, owner });
});

app.get('/api/room/:code/roster', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const room = getRoom(sanitizeCode(req.params.code), false);
  if (!room) return res.status(404).json({ error: 'Room not found.' });
  if (!canEditRoom(user, room.data)) return res.status(403).json({ error: 'Only the room owner or an admin can manage this class.' });
  res.json({ code: room.code, name: room.data.name, owner: room.data.owner, roster: rosterEntries(room) });
});

app.post('/api/room/:code/roster', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const room = getRoom(sanitizeCode(req.params.code), false);
  if (!room) return res.status(404).json({ error: 'Room not found.' });
  if (!canEditRoom(user, room.data)) return res.status(403).json({ error: 'Only the room owner or an admin can manage this class.' });

  const results = { added: [], pendingApproval: [], skipped: [], invalid: [], removed: [] };
  let usersChanged = false;
  const now = Date.now();

  const add = Array.isArray(req.body.add) ? req.body.add.slice(0, 300) : [];
  for (const raw of add) {
    const email = String(raw).trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      if (email) results.invalid.push(email);
      continue;
    }
    if (isSuperAdmin(email) || (store.users[email] && adminPerms(permsFor(email)))) {
      results.skipped.push(email);
      continue;
    }
    if (!store.users[email]) {
      // Enrolling someone who has never signed in creates their account;
      // outside approved domains it stays pending until an admin approves.
      store.users[email] = {
        name: email, role: 'student',
        status: domainApproved(email) ? 'approved' : 'pending',
        firstSeen: now, lastSeen: null, addedBy: user.email,
      };
      usersChanged = true;
    }
    if (room.data.roster.includes(email)) {
      results.skipped.push(email);
      continue;
    }
    room.data.roster.push(email);
    room.data.names[email] = room.data.names[email] || store.users[email].name || email;
    if (accessStatus(email) === 'pending') results.pendingApproval.push(email);
    results.added.push({ email, name: room.data.names[email] });
  }

  const remove = Array.isArray(req.body.remove) ? req.body.remove.slice(0, 300) : [];
  for (const raw of remove) {
    const email = String(raw).trim().toLowerCase();
    if (!room.data.roster.includes(email)) continue;
    room.data.roster = room.data.roster.filter((e) => e !== email);
    boardsFor(email, room.code).forEach((b) => deleteBoard(b.id));
    results.removed.push(email);
  }

  room.data.updatedAt = Date.now();
  scheduleSave(room);
  if (usersChanged) saveStore();
  res.json({ ...results, roster: rosterEntries(room) });
});

// ---------- Google Classroom import ----------
// Requires the teacher to grant the Classroom scopes (courses.readonly, rosters.readonly,
// profile.emails) and the project to have the Classroom API enabled. The client sends a
// short-lived OAuth access token obtained via Google's token flow; we never store it.
async function classroomApi(pathAndQuery, accessToken) {
  const r = await fetch('https://classroom.googleapis.com/v1/' + pathAndQuery, {
    headers: { Authorization: 'Bearer ' + accessToken },
  });
  if (!r.ok) {
    const detail = (await r.text().catch(() => '')).slice(0, 300);
    const err = new Error('Classroom API ' + r.status);
    err.httpStatus = r.status;
    err.detail = detail;
    throw err;
  }
  return r.json();
}

app.post('/api/classroom/courses', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const token = String((req.body && req.body.accessToken) || '');
  if (!token) return res.status(400).json({ error: 'Missing Google authorization.' });
  try {
    const data = await classroomApi('courses?teacherId=me&courseStates=ACTIVE&pageSize=100', token);
    res.json({ courses: (data.courses || []).map((c) => ({ id: c.id, name: c.name, section: c.section || '' })) });
  } catch (e) {
    res.status(502).json({ error: 'Could not reach Google Classroom. Make sure the Classroom API is enabled and you granted access.', detail: e.detail });
  }
});

app.post('/api/classroom/students', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const token = String((req.body && req.body.accessToken) || '');
  const courseId = String((req.body && req.body.courseId) || '');
  if (!token || !courseId) return res.status(400).json({ error: 'Missing course or authorization.' });
  try {
    const students = [];
    let pageToken = '';
    let guard = 0;
    do {
      const data = await classroomApi(
        `courses/${encodeURIComponent(courseId)}/students?pageSize=100${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`,
        token,
      );
      for (const s of (data.students || [])) {
        const email = s.profile && s.profile.emailAddress;
        const name = s.profile && s.profile.name && s.profile.name.fullName;
        if (email) students.push({ email: String(email).toLowerCase(), name: name || email });
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken && ++guard < 20);
    res.json({ students });
  } catch (e) {
    res.status(502).json({ error: 'Could not read the class roster from Google. Grant the “see student emails” permission and try again.', detail: e.detail });
  }
});

app.post('/api/room/:code/meta', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const room = getRoom(sanitizeCode(req.params.code), false);
  if (!room) return res.status(404).json({ error: 'Room not found.' });
  if (!canEditRoom(user, room.data)) return res.status(403).json({ error: 'Only the room owner or an admin can manage this class.' });
  if (req.body.name !== undefined) {
    room.data.name = String(req.body.name).trim().slice(0, 50);
  }
  if (req.body.owner !== undefined) {
    if (!user.isSuper && !user.perms.includes('manage_boards')) {
      return res.status(403).json({ error: 'Only an admin can change the room owner.' });
    }
    const owner = String(req.body.owner).trim().toLowerCase();
    if (!EMAIL_RE.test(owner)) return res.status(400).json({ error: 'The owner must be an email address.' });
    room.data.owner = owner;
  }
  if (req.body.archived !== undefined) {
    room.data.archived = !!req.body.archived;
    appendAudit(user.email, room.data.archived ? 'room:archive' : 'room:unarchive', room.code);
  }
  room.data.updatedAt = Date.now();
  scheduleSave(room);
  res.json({ code: room.code, name: room.data.name, owner: room.data.owner, archived: !!room.data.archived });
});

// Search approved student accounts within the requester's scope
app.get('/api/students', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!user.isSuper && !user.perms.includes('teach') && !user.perms.includes('manage_users') && !user.perms.includes('manage_boards')) {
    return res.status(403).json({ error: 'Your role cannot search students.' });
  }
  const q = String(req.query.q || '').trim().toLowerCase();
  const out = [];
  for (const [email, rec] of Object.entries(store.users)) {
    if (isSuperAdmin(email) || permsFor(email).length > 0) continue; // students only
    if (accessStatus(email) !== 'approved') continue;
    if (!inStudentScope(user, email)) continue;
    const name = rec.name || email;
    if (q && !email.includes(q) && !name.toLowerCase().includes(q)) continue;
    out.push({ email, name });
    if (out.length >= 30) break;
  }
  res.json(out);
});

// ---------- admin api ----------

function requireAuthed(req, res) {
  if (!AUTH_ENABLED) {
    res.status(400).json({ error: 'The admin portal requires Google sign-in to be enabled.' });
    return null;
  }
  const user = sessionFromReq(req);
  if (!user) {
    res.status(401).json({ error: 'Please sign in again.' });
    return null;
  }
  if (accessStatus(user.email) !== 'approved') {
    res.status(403).json({ error: 'Your account does not have access.' });
    return null;
  }
  const perms = permsFor(user.email);
  const isSuper = isSuperAdmin(user.email);
  if (!isSuper && !adminPerms(perms)) {
    res.status(403).json({ error: 'This page is for administrators.' });
    return null;
  }
  return { email: user.email, name: user.name, role: effectiveRole(user.email), perms, isSuper };
}

function requirePerm(req, res, perm) {
  const admin = requireAuthed(req, res);
  if (!admin) return null;
  if (!admin.isSuper && !admin.perms.includes(perm)) {
    res.status(403).json({ error: 'Your role does not include this permission.' });
    return null;
  }
  return admin;
}

function kickUser(email) {
  for (const s of io.of('/').sockets.values()) {
    if (s.data && s.data.user && s.data.user.email === email) s.disconnect(true);
  }
}

function userView(email, rec) {
  return {
    email,
    name: rec ? rec.name : email,
    role: effectiveRole(email),
    status: accessStatus(email),
    isSuper: isSuperAdmin(email),
    grade: (rec && rec.grade) || '',
    school: domainOf(email),
    addedBy: (rec && rec.addedBy) || null,
    suspendUntil: (rec && rec.status === 'suspended' && rec.suspendUntil) || null,
    firstSeen: rec ? rec.firstSeen : null,
    lastSeen: rec ? rec.lastSeen : null,
  };
}

// Grade levels, in promotion order. 'Graduated' is the terminal step past 12.
const GRADES = ['Pre-K', 'K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', 'Graduated'];

function nextGrade(g) {
  const i = GRADES.indexOf(g);
  if (i < 0 || i >= GRADES.length - 1) return null; // unset or already Graduated
  return GRADES[i + 1];
}

function prevGrade(g) {
  const i = GRADES.indexOf(g);
  if (i <= 0) return null; // unset or already at the lowest grade
  return GRADES[i - 1];
}

// Shared engine for the promote/demote bulk actions
function shiftGrades(admin, emails, dir) {
  const only = Array.isArray(emails) && emails.length
    ? new Set(emails.map((e) => String(e).trim().toLowerCase()))
    : null;
  const step = dir === 'down' ? prevGrade : nextGrade;
  let changed = 0; let graduated = 0; let noGrade = 0; let atEnd = 0;
  for (const [email, rec] of Object.entries(store.users)) {
    if (only && !only.has(email)) continue;
    if (isSuperAdmin(email) || !canManageTarget(admin, email)) continue;
    if (effectiveRole(email) !== 'student') continue; // only students move
    if (!rec.grade) { noGrade++; continue; }
    const next = step(rec.grade);
    if (!next) { atEnd++; continue; }
    rec.grade = next;
    changed++;
    if (next === 'Graduated') graduated++;
  }
  return { changed, graduated, noGrade, atEnd };
}

app.get('/api/admin/state', (req, res) => {
  const admin = requireAuthed(req, res);
  if (!admin) return;
  const canUsers = admin.isSuper || admin.perms.includes('manage_users');
  const canBoards = admin.isSuper || admin.perms.includes('manage_boards');
  const canSessions = admin.isSuper || admin.perms.includes('view_sessions');
  const canDomains = admin.isSuper || admin.perms.includes('manage_domains');

  let users = [];
  if (canUsers) {
    // Everyone who has signed in at least once. The authoritative roster
    // lives in Signify ID; this is only who has actually opened the app.
    users = Object.entries(store.users)
      .filter(([, r]) => !r.releasedAt)
      .map(([email, r]) => userView(email, r));
    if (!admin.isSuper) users = users.filter((u) => canManageTarget(admin, u.email));
    users.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  }

  const sessions = [];
  if (canSessions) {
    for (const s of io.of('/').sockets.values()) {
      if (!s.data || !s.data.code) continue;
      sessions.push({
        room: s.data.code,
        name: s.data.name,
        email: (s.data.user && s.data.user.email) || null,
        role: s.data.role,
        since: s.data.connectedAt || null,
      });
    }
    sessions.sort((a, b) => (a.room < b.room ? -1 : 1));
  }

  const roles = Object.entries(store.roles).map(([id, r]) => ({ id, label: r.label, builtin: !!r.builtin, perms: r.perms }));

  let domainFeatures = {};
  if (canUsers) {
    if (admin.isSuper) {
      domainFeatures = store.domainFeatures;
      for (const d of store.domains) if (!domainFeatures[d]) domainFeatures = { ...domainFeatures, [d]: {} };
    } else {
      const own = domainOf(admin.email);
      domainFeatures = { [own]: store.domainFeatures[own] || {} };
    }
  }

  res.json({
    me: admin,
    permissions: PERMISSIONS,
    grades: GRADES,
    schools: admin.isSuper ? [...new Set(Object.keys(store.users).map(domainOf))].sort() : [domainOf(admin.email)],
    features: FEATURES,
    domainFeatures,
    roles,
    users,
    domains: canDomains ? store.domains : [],
    rooms: canBoards
      ? listRooms()
        .filter((r) => admin.isSuper || !r.owner || sameDomainOrAdded(admin, r.owner))
        .map((r) => ({ ...r, ownerName: r.owner ? displayNameOf(r.owner) : null }))
      : [],
    sessions,
    // templates awaiting this admin's approval, and the school open-submission flag
    templatesPending: [...templatesIndex.values()]
      .filter((t) => t.status === 'pending' && canManageTemplate(admin, t))
      .map((t) => ({ ...t })),
    templateOpen: store.templateOpenDomains.includes(domainOf(admin.email)),
    myDomain: domainOf(admin.email),
  });
});

// School library: allow this domain's teachers to post without per-template approval
app.post('/api/admin/school-submit', (req, res) => {
  const admin = requirePerm(req, res, 'manage_boards');
  if (!admin) return;
  const domain = String(req.body.domain || '').trim().toLowerCase();
  if (!admin.isSuper && domain !== domainOf(admin.email)) {
    return res.status(403).json({ error: 'You can only change your own school.' });
  }
  const open = !!req.body.open;
  store.templateOpenDomains = store.templateOpenDomains.filter((d) => d !== domain);
  if (open) store.templateOpenDomains.push(domain);
  saveStore();
  appendAudit(admin.email, 'template:school-open', `${domain} = ${open}`);
  res.json({ ok: true, open });
});

// Usage snapshot for the admin dashboard (scoped to what the admin can see)
// A migration aid: everyone the whiteboard knows who has not yet signed in
// through Signify ID, as a CSV the Signify importer accepts as-is.
//
// Deliberately a download behind an admin session rather than something
// printed at boot — Railway keeps stdout, and a list of pupils' addresses is
// not something to leave sitting in a log.
app.get('/api/admin/signify-roster.csv', (req, res) => {
  const admin = requirePerm(req, res, 'manage_users');
  if (!admin) return;

  const esc = (v) => {
    const t = String(v == null ? '' : v);
    return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };

  const rows = [['First name', 'Last name', 'Email address', 'Role', 'Classes', 'Apps', 'Graduation year']];
  for (const [email, rec] of Object.entries(store.users)) {
    if (rec.releasedAt || rec.uid) continue;          // archived, or already linked
    const parts = String(rec.name || '').trim().split(/\s+/);
    const first = parts.length > 1 ? parts.slice(0, -1).join(' ') : (parts[0] || '');
    const last = parts.length > 1 ? parts[parts.length - 1] : '';
    // The whiteboard's own role names, mapped to Signify's.
    const role = rec.role === 'superadmin' ? 'local_admin'
      : rec.role === 'admin' ? 'local_admin'
      : rec.role === 'teacher' ? 'teacher' : 'student';
    rows.push([first, last, email, role, '', '', '']);
  }

  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="whiteboard-people-for-signify.csv"');
  res.send(rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n');
});

app.get('/api/admin/usage', (req, res) => {
  const admin = requirePerm(req, res, 'view_sessions');
  if (!admin) return;
  const weekAgo = Date.now() - 7 * 86400e3;
  const rooms = roomSummaries().filter((r) => admin.isSuper || !r.owner || sameDomainOrAdded(admin, r.owner));
  const roomCodes = new Set(rooms.map((r) => r.code));
  let boards = 0; let boardsWeek = 0;
  for (const b of boardsIndex.values()) {
    const inScope = admin.isSuper ? true : (b.room ? roomCodes.has(b.room) : sameDomainOrAdded(admin, b.owner));
    if (!inScope) continue;
    boards++;
    if (b.updatedAt > weekAgo) boardsWeek++;
  }
  const users = Object.entries(store.users).filter(([e]) => admin.isSuper || sameDomainOrAdded(admin, e));
  const activeWeek = users.filter(([, r]) => r.lastSeen && r.lastSeen > weekAgo).length;
  let online = 0;
  const liveRooms = new Set();
  for (const s of io.of('/').sockets.values()) {
    if (!s.data || !s.data.code) continue;
    if (!roomCodes.has(s.data.code) && !admin.isSuper) continue;
    online++; liveRooms.add(s.data.code);
  }
  res.json({
    rooms: rooms.length, users: users.length, activeWeek,
    boards, boardsWeek, online, liveRooms: liveRooms.size,
    templates: [...templatesIndex.values()].filter((t) => canSeeTemplate(admin, t)).length,
    // storage headroom — only the super admin sees the raw volume figure
    diskFreeMB: admin.isSuper ? Math.round(diskFreeBytes / 1e6) : null,
    diskLow: admin.isSuper ? diskFreeBytes < DISK_WARN_FREE : null,
  });
});

app.get('/api/admin/audit', (req, res) => {
  const admin = requireAuthed(req, res);
  if (!admin) return;
  // scoped: super sees all; others see actions by/about their own domain
  const rows = auditLog.filter((a) => admin.isSuper || domainOf(a.actor) === domainOf(admin.email)).slice(-200).reverse();
  res.json({ audit: rows });
});

// Client-side error reports land in the server log for diagnosis
app.post('/api/client-error', (req, res) => {
  const who = AUTH_ENABLED ? (sessionFromReq(req) || {}).email || 'anon' : 'open';
  // strip control chars/newlines so a client can't forge extra log lines
  const clean = (s, n) => String(s || '').replace(/[\r\n\t\x00-\x1f]+/g, ' ').slice(0, n);
  const msg = clean(req.body && req.body.message, 300);
  const where = clean(req.body && req.body.where, 120);
  if (msg) console.error(`[client-error] ${who} @ ${where}: ${msg}`);
  res.json({ ok: true });
});

app.post('/api/admin/user', (req, res) => {
  const admin = requirePerm(req, res, 'manage_users');
  if (!admin) return;
  const email = String(req.body.email || '').trim().toLowerCase();
  const { role, status } = req.body;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'That is not a valid email address.' });
  if (isSuperAdmin(email)) return res.status(403).json({ error: 'Super admin accounts cannot be modified.' });

  const exists = !!store.users[email];
  if (exists && !canManageTarget(admin, email)) {
    return res.status(403).json({ error: 'You can only manage accounts on your own domain or accounts you added yourself.' });
  }
  // Creating a NEW account: non-super admins are confined to their own school
  // domain, so they can't pre-create (and thereby own) other schools' accounts.
  if (!exists && !admin.isSuper && domainOf(email) !== domainOf(admin.email)) {
    return res.status(403).json({ error: 'You can only add accounts in your own school domain.' });
  }
  if (role && !store.roles[role]) return res.status(400).json({ error: 'Unknown role.' });
  if (role && !canAssignRole(admin, role)) {
    return res.status(403).json({ error: 'Only the super admin can assign roles with admin permissions.' });
  }
  if (status && !['approved', 'pending', 'blocked', 'suspended'].includes(status)) return res.status(400).json({ error: 'Unknown status.' });
  if (req.body.grade !== undefined && req.body.grade !== '' && !GRADES.includes(req.body.grade)) {
    return res.status(400).json({ error: 'Unknown grade level.' });
  }

  const now = Date.now();
  let rec = store.users[email];
  if (!rec) rec = store.users[email] = { name: email, role: 'student', status: 'approved', firstSeen: now, lastSeen: null, addedBy: admin.email };
  if (role) rec.role = role;
  if (status) {
    rec.status = status;
    delete rec.suspendUntil;
    if (status === 'suspended') {
      // Optional timed suspension; a number in ms since epoch, else indefinite
      const until = Number(req.body.suspendUntil);
      if (Number.isFinite(until) && until > now) rec.suspendUntil = until;
      kickUser(email);
    }
    if (status === 'blocked') kickUser(email);
    appendAudit(admin.email, 'user:' + status, email);
  }
  if (role) appendAudit(admin.email, 'user:role', `${email} → ${role}`);
  if (req.body.grade !== undefined) {
    if (req.body.grade === '') delete rec.grade;
    else rec.grade = req.body.grade;
    appendAudit(admin.email, 'user:grade', `${email} → ${req.body.grade || 'none'}`);
  }
  saveStore();
  res.json(userView(email, rec));
});

// Set one grade on many students at once
app.post('/api/admin/users/grade', (req, res) => {
  const admin = requirePerm(req, res, 'manage_users');
  if (!admin) return;
  const grade = String(req.body.grade || '');
  if (grade !== '' && !GRADES.includes(grade)) return res.status(400).json({ error: 'Unknown grade level.' });
  const emails = Array.isArray(req.body.emails) ? req.body.emails.slice(0, 500) : [];
  const updated = [];
  const skipped = [];
  for (const raw of emails) {
    const email = String(raw).trim().toLowerCase();
    const rec = store.users[email];
    if (!rec || isSuperAdmin(email) || !canManageTarget(admin, email)) { skipped.push(email); continue; }
    if (grade === '') delete rec.grade; else rec.grade = grade;
    updated.push(email);
  }
  if (updated.length) {
    appendAudit(admin.email, 'user:grade-bulk', `${updated.length} → ${grade || 'none'}`);
    saveStore();
  }
  res.json({ ok: true, updated: updated.length, skipped: skipped.length });
});

// Move students up a grade — everyone in scope, or just the selected emails
app.post('/api/admin/users/promote', (req, res) => {
  const admin = requirePerm(req, res, 'manage_users');
  if (!admin) return;
  const r = shiftGrades(admin, req.body.emails, 'up');
  if (r.changed) {
    appendAudit(admin.email, 'user:promote', `${r.changed} student${r.changed === 1 ? '' : 's'} advanced${r.graduated ? `, ${r.graduated} graduated` : ''}`);
    saveStore();
  }
  res.json({ ok: true, promoted: r.changed, graduated: r.graduated, noGrade: r.noGrade, atEnd: r.atEnd });
});

// Undo a promotion: move students back down a grade (Graduated -> 12)
app.post('/api/admin/users/demote', (req, res) => {
  const admin = requirePerm(req, res, 'manage_users');
  if (!admin) return;
  const r = shiftGrades(admin, req.body.emails, 'down');
  if (r.changed) {
    appendAudit(admin.email, 'user:demote', `${r.changed} student${r.changed === 1 ? '' : 's'} moved back a grade`);
    saveStore();
  }
  res.json({ ok: true, demoted: r.changed, noGrade: r.noGrade, atEnd: r.atEnd });
});

app.delete('/api/admin/user/:email', (req, res) => {
  const admin = requirePerm(req, res, 'manage_users');
  if (!admin) return;
  const email = String(req.params.email || '').trim().toLowerCase();
  if (isSuperAdmin(email)) return res.status(403).json({ error: 'Super admin accounts cannot be deleted.' });
  if (!store.users[email]) return res.status(404).json({ error: 'User not found.' });
  if (!canManageTarget(admin, email)) {
    return res.status(403).json({ error: 'You can only manage accounts on your own domain or accounts you added yourself.' });
  }
  kickUser(email);
  // Remove the account and everything tied to it: all boards (personal + every
  // room), roster spots, and per-student switches — including rooms not in memory.
  for (const b of [...boardsIndex.values()]) {
    if (b.owner === email) deleteBoard(b.id);
  }
  for (const f of fs.readdirSync(DATA_DIR)) {
    const m = /^room-(.+)\.json$/.exec(f);
    if (!m) continue;
    const room = getRoom(sanitizeCode(m[1]), false);
    if (!room) continue;
    let touched = false;
    if ((room.data.roster || []).includes(email)) {
      room.data.roster = room.data.roster.filter((e) => e !== email);
      touched = true;
    }
    if (room.data.studentFeatures && room.data.studentFeatures[email]) {
      delete room.data.studentFeatures[email];
      touched = true;
    }
    if (touched) scheduleSave(room);
  }
  delete store.users[email];
  appendAudit(admin.email, 'user:delete', email);
  saveStore();
  res.json({ ok: true });
});

// Full data export — pull this to your own computer for true off-site backup
app.get('/api/admin/backup', (req, res) => {
  const admin = requireAuthed(req, res);
  if (!admin) return;
  if (!admin.isSuper) return res.status(403).json({ error: 'Only the super admin can download backups.' });
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="signify-backup-${new Date().toISOString().slice(0, 10)}.tar.gz"`);
  const tar = spawn('tar', ['-czf', '-', '--exclude=./backups', '-C', DATA_DIR, '.']);
  tar.stdout.pipe(res);
  tar.on('error', () => res.end());
});

app.post('/api/admin/users/bulk', (req, res) => {
  const admin = requirePerm(req, res, 'manage_users');
  if (!admin) return;
  const role = req.body.role || 'student';
  if (!store.roles[role]) return res.status(400).json({ error: 'Unknown role.' });
  if (!canAssignRole(admin, role)) {
    return res.status(403).json({ error: 'Only the super admin can assign roles with admin permissions.' });
  }
  const emails = Array.isArray(req.body.emails) ? req.body.emails.slice(0, 300) : [];
  const results = { added: [], skipped: [], invalid: [] };
  const now = Date.now();
  for (const raw of emails) {
    const email = String(raw).trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      if (email) results.invalid.push(email);
      continue;
    }
    // A non-super admin may only pre-create accounts in their own school's
    // domain. Otherwise they could squat other schools' accounts (approved +
    // addedBy them), then read/alter those users once they sign in.
    if (!admin.isSuper && domainOf(email) !== domainOf(admin.email)) {
      results.invalid.push(email);
      continue;
    }
    if (isSuperAdmin(email) || store.users[email]) {
      results.skipped.push(email);
      continue;
    }
    store.users[email] = { name: email, role, status: 'approved', firstSeen: now, lastSeen: null, addedBy: admin.email };
    results.added.push(email);
  }
  if (results.added.length) saveStore();
  res.json(results);
});

app.post('/api/admin/roles', (req, res) => {
  const admin = requireAuthed(req, res);
  if (!admin) return;
  if (!admin.isSuper) return res.status(403).json({ error: 'Only the super admin can manage roles.' });

  const action = req.body.action;
  const id = String(req.body.id || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,24}$/.test(id)) return res.status(400).json({ error: 'Role ids are 2-25 characters: lowercase letters, numbers, dashes.' });
  if (id === 'superadmin') return res.status(400).json({ error: 'That role id is reserved.' });

  let perms = req.body.perms;
  if (perms !== undefined) {
    if (!Array.isArray(perms) || perms.some((p) => !PERMISSIONS.includes(p))) {
      return res.status(400).json({ error: 'Unknown permission.' });
    }
    perms = [...new Set(perms)];
  }
  const label = req.body.label !== undefined ? String(req.body.label).trim().slice(0, 40) : undefined;

  if (action === 'create') {
    if (store.roles[id]) return res.status(400).json({ error: 'That role id already exists.' });
    store.roles[id] = { label: label || id, builtin: false, perms: perms || [] };
  } else if (action === 'update') {
    const role = store.roles[id];
    if (!role) return res.status(404).json({ error: 'Role not found.' });
    if (id === 'student') return res.status(400).json({ error: 'The student role is the default and cannot be changed.' });
    if (label) role.label = label;
    if (perms) role.perms = perms;
  } else if (action === 'delete') {
    const role = store.roles[id];
    if (!role) return res.status(404).json({ error: 'Role not found.' });
    if (role.builtin) return res.status(400).json({ error: 'Built-in roles cannot be deleted.' });
    for (const rec of Object.values(store.users)) {
      if (rec.role === id) rec.role = 'student';
    }
    delete store.roles[id];
  } else {
    return res.status(400).json({ error: 'Unknown action.' });
  }
  saveStore();
  res.json({ roles: Object.entries(store.roles).map(([rid, r]) => ({ id: rid, label: r.label, builtin: !!r.builtin, perms: r.perms })) });
});

// School-wide feature switches: scoped admins manage their own domain, super any
app.post('/api/admin/features', (req, res) => {
  const admin = requirePerm(req, res, 'manage_users');
  if (!admin) return;
  const domain = String(req.body.domain || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(domain)) return res.status(400).json({ error: 'That is not a valid domain.' });
  if (!admin.isSuper && domain !== domainOf(admin.email)) {
    return res.status(403).json({ error: 'You can only manage features for your own school domain.' });
  }
  store.domainFeatures[domain] = store.domainFeatures[domain] || {};
  applyFeaturePatch(store.domainFeatures[domain], req.body.features);
  if (!Object.keys(store.domainFeatures[domain]).length) delete store.domainFeatures[domain];
  saveStore();
  // push the new resolution to every connected student on that domain
  for (const room of rooms.values()) {
    for (const sid of room.students.keys()) {
      if (domainOf(sid) === domain) pushFeatures(room, sid);
    }
  }
  res.json({ domain, features: store.domainFeatures[domain] || {} });
});

app.post('/api/admin/domains', (req, res) => {
  const admin = requirePerm(req, res, 'manage_domains');
  if (!admin) return;
  const domain = String(req.body.domain || '').trim().toLowerCase().replace(/^@/, '');
  const action = req.body.action;
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(domain)) return res.status(400).json({ error: 'That is not a valid domain.' });
  if (action === 'add') {
    if (!store.domains.includes(domain)) store.domains.push(domain);
  } else if (action === 'remove') {
    store.domains = store.domains.filter((d) => d !== domain);
  } else {
    return res.status(400).json({ error: 'Unknown action.' });
  }
  saveStore();
  res.json({ domains: store.domains });
});

app.get('/api/admin/room/:code', (req, res) => {
  const admin = requirePerm(req, res, 'manage_boards');
  if (!admin) return;
  const code = sanitizeCode(req.params.code);
  const room = getRoom(code, false);
  if (!room) return res.status(404).json({ error: 'Room not found.' });
  const boards = roomBoards(code).map((b) => {
    const view = canViewBoard(admin, b); // domain-scoped, even for the super admin
    return {
      ...b, thumb: view ? b.thumb : null, canView: view,
      ownerName: room.data.names[b.owner] || displayNameOf(b.owner), isTeacher: b.owner === room.data.owner,
    };
  });
  res.json({ code, name: room.data.name, owner: room.data.owner, boards });
});

// Every board a user owns — across classrooms and personal — for the portal
app.get('/api/admin/user-boards/:email', (req, res) => {
  const admin = requirePerm(req, res, 'manage_boards');
  if (!admin) return;
  const email = String(req.params.email || '').trim().toLowerCase();
  if (!sameDomainOrAdded(admin, email)) {
    return res.status(403).json({ error: 'Board viewing is limited to your own school.' });
  }
  const boards = [...boardsIndex.values()]
    .filter((b) => b.owner === email)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((b) => {
      const room = b.room ? getRoom(b.room, false) : null;
      return {
        id: b.id, title: b.title, room: b.room,
        roomName: room ? (room.data.name || b.room) : null,
        thumb: b.thumb, updatedAt: b.updatedAt,
      };
    });
  res.json({ email, name: displayNameOf(email), boards });
});

app.delete('/api/admin/room/:code', (req, res) => {
  const admin = requirePerm(req, res, 'manage_boards');
  if (!admin) return;
  const code = sanitizeCode(req.params.code);
  const room = getRoom(code, false);
  if (!room) return res.status(404).json({ error: 'Room not found.' });
  // Only the super admin or an admin in the room owner's school may delete a
  // classroom — this route wipes every board and its history.
  if (!admin.isSuper && room.data.owner && !sameDomainOrAdded(admin, room.data.owner)) {
    return res.status(403).json({ error: 'You can only manage classrooms in your own school.' });
  }
  io.in(code).disconnectSockets(true);
  rooms.delete(code);
  roomBoards(code).forEach((b) => deleteBoard(b.id));
  fs.unlink(roomFile(code), () => {});
  res.json({ ok: true });
});

// ---------- boards ----------
// Each board is its own file: board-<id>.json = { id, title, owner, room, createdAt, updatedAt, thumb, json }
// owner is the verified email (or typed name in open mode); room is a code or null for personal boards.
// boardsIndex holds metadata (no json) for fast listing; writes are debounced per board.

const boardsIndex = new Map(); // id -> meta
const boardPending = new Map(); // id -> latest unflushed json
const boardTimers = new Map();

// Secondary indexes so boardsFor()/roomBoards() are O(a room's or a user's
// boards) instead of O(every board on the server). Without these, a teacher
// joining a class was O(students × all boards).
const boardsByRoom = new Map();  // room|'' -> Set(id)
const boardsByOwner = new Map(); // owner   -> Set(id)
function idxAdd(map, key, id) { let s = map.get(key); if (!s) map.set(key, (s = new Set())); s.add(id); }
function idxDel(map, key, id) { const s = map.get(key); if (s) { s.delete(id); if (!s.size) map.delete(key); } }
function indexBoard(meta) { idxAdd(boardsByRoom, meta.room || '', meta.id); idxAdd(boardsByOwner, meta.owner, meta.id); }
function unindexBoard(meta) { idxDel(boardsByRoom, meta.room || '', meta.id); idxDel(boardsByOwner, meta.owner, meta.id); }

function boardFile(id) {
  return path.join(DATA_DIR, `board-${id}.json`);
}

function boardMetaOf(d) {
  return {
    id: d.id, title: d.title || 'Board', owner: d.owner, room: d.room || null,
    createdAt: d.createdAt || 0, updatedAt: d.updatedAt || 0, thumb: d.thumb || null,
    comments: d.comments || [],
    embed: d.embed || null, // { token, publishedAt, by } when shared to the web
    assignment: d.assignment || null, // assignment id when this board is a submission
  };
}

// token -> boardId, rebuilt from the index so lookups are O(1)
const embedTokens = new Map();

function reindexEmbeds() {
  embedTokens.clear();
  for (const b of boardsIndex.values()) {
    if (b.embed && b.embed.token) embedTokens.set(b.embed.token, b.id);
  }
}

function loadBoardsIndex() {
  let migrated = 0;
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (f.endsWith('.tmp')) { try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch { /* leftover from an interrupted write */ } continue; }
    if (!/^board-[a-f0-9]{16}\.json$/.test(f)) continue;
    try {
      const full = path.join(DATA_DIR, f);
      const d = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (!d.id) continue;
      const meta = boardMetaOf(d);
      boardsIndex.set(d.id, meta);
      indexBoard(meta);
      // One-time migration: externalize any inline images to blobs and rewrite
      // the board small. Deduped, so 30 copies of a pushed PDF collapse to one.
      const dj = dehydrate(d.json);
      if (dj !== d.json) {
        try {
          const tmp = full + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify({ ...boardMetaOf(d), json: dj }));
          fs.renameSync(tmp, full);
          migrated++;
        } catch (e) { console.error('Board image migration failed for', f, e.message); }
      }
    } catch (e) {
      console.error('Could not read board file', f, e.message, '— attempting recovery');
      if (!recoverBoard(f)) {
        // Unrecoverable (e.g. the file was truncated to empty). Set it aside so
        // it stops erroring on every boot; keep it rather than delete, just in case.
        console.error('  recovery failed for', f, '— setting aside as .corrupt');
        try { fs.renameSync(path.join(DATA_DIR, f), path.join(DATA_DIR, f + '.corrupt')); } catch { /* ignore */ }
      }
    }
  }
  if (migrated) { console.log(`Externalized images on ${migrated} board(s); running blob GC.`); gcBlobs(); }
}

// The board meta keys are always serialized before the big (and, when a write
// is truncated, incomplete) "json" value. So even a corrupted file usually has
// an intact prefix we can salvage the meta from.
function salvageMeta(text) {
  const i = text.lastIndexOf(',"json":');
  if (i === -1) return null;
  try { return JSON.parse(text.slice(0, i) + '}'); } catch { return null; }
}

// Rebuild a corrupted board file: recover its meta from the file's intact
// prefix and its content from the most recent version-history snapshot (or
// blank if there is none), then rewrite it atomically so it opens again.
function recoverBoard(f) {
  try {
    const full = path.join(DATA_DIR, f);
    const id = (f.match(/^board-([a-f0-9]{16})\.json$/) || [])[1];
    const meta = salvageMeta(fs.readFileSync(full, 'utf8'));
    if (!id || !meta || meta.id !== id) return false;
    let json = null;
    const hs = histFiles(id);
    if (hs.length) {
      try { json = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DATA_DIR, hs[hs.length - 1]))).toString()); } catch { json = null; }
    }
    const tmp = full + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ ...boardMetaOf(meta), json }));
    fs.renameSync(tmp, full);
    boardsIndex.set(id, boardMetaOf(meta));
    console.warn(`  recovered board ${id} "${meta.title}" (${json ? 'content from history' : 'blank — no snapshot'})`);
    return true;
  } catch (e) {
    console.error('  recovery error:', e.message);
    return false;
  }
}

function flushBoardSoon(id) {
  if (boardTimers.has(id)) return;
  boardTimers.set(id, setTimeout(() => {
    boardTimers.delete(id);
    const meta = boardsIndex.get(id);
    if (!meta) return;
    let json = boardPending.get(id);
    if (json === undefined) json = readBoardStored(id); // meta-only change (e.g. rename) — keep blob refs
    boardPending.delete(id);
    // Atomic write: serialize to a temp file, then rename over the real one.
    // If the disk fills mid-write, only the temp is truncated — the existing
    // board file stays intact instead of being corrupted (which is exactly what
    // took two boards down when the volume filled).
    const dest = boardFile(id);
    const tmp = dest + '.tmp';
    fs.writeFile(tmp, JSON.stringify({ ...meta, json: json || null }), (err) => {
      if (err) { console.error('Board save failed', id, err.message); fs.unlink(tmp, () => {}); return; }
      fs.rename(tmp, dest, (err2) => {
        if (err2) { console.error('Board save rename failed', id, err2.message); fs.unlink(tmp, () => {}); }
      });
    });
    maybeSnapshot(id, json);
  }, 800));
}

// ---------- version history: gzipped snapshots every ~10 minutes ----------

const HIST_MAX = 8;                       // snapshots kept per board
const HIST_MIN_MS = 10 * 60 * 1000;       // min gap between snapshots
const HIST_SKIP_BYTES = 4 * 1024 * 1024;  // huge boards (embedded docs) skip history

function histFiles(id) {
  return fs.readdirSync(DATA_DIR)
    .filter((f) => f.startsWith(`hist-${id}-`) && f.endsWith('.json.gz'))
    .sort();
}

function histTs(f) {
  const m = /^hist-[a-f0-9]+-(\d+)\.json\.gz$/.exec(f);
  return m ? Number(m[1]) : 0;
}

// In-memory snapshot bookkeeping so the flush hot path never touches the disk
// (readdirSync) or stringifies a multi-MB board just to rate-limit. id ->
// { lastAt, tooBig }.
const histState = new Map();

function maybeSnapshot(id, json, force) {
  try {
    if (!json) return;
    const st = histState.get(id) || {};
    if (st.tooBig) return; // learned once: huge doc boards never snapshot
    // Rate-limit WITHOUT reading the directory or serializing the board.
    if (!force && st.lastAt && Date.now() - st.lastAt < HIST_MIN_MS) return;
    const str = JSON.stringify(json);
    if (str.length > HIST_SKIP_BYTES) { histState.set(id, { ...st, tooBig: true }); return; }
    fs.writeFileSync(path.join(DATA_DIR, `hist-${id}-${Date.now()}.json.gz`), zlib.gzipSync(str));
    histState.set(id, { ...st, lastAt: Date.now() });
    // Pruning reads the dir, but only runs when we actually snapshot (~10 min).
    const all = histFiles(id);
    while (all.length > HIST_MAX) fs.unlinkSync(path.join(DATA_DIR, all.shift()));
  } catch (e) {
    console.error('History snapshot failed', id, e.message);
  }
}

function histList(id) {
  return histFiles(id).map(histTs).filter(Boolean).sort((a, b) => b - a);
}

function histRestore(id, ts) {
  const file = path.join(DATA_DIR, `hist-${id}-${ts}.json.gz`);
  if (!fs.existsSync(file)) return null;
  const stored = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString()); // snapshots hold blob refs
  // snapshot the current state first so a restore is itself undoable
  maybeSnapshot(id, readBoardStored(id), true);
  updateBoard(id, { json: stored });
  return rehydrate(stored); // client-ready
}

function deleteHistory(id) {
  for (const f of histFiles(id)) fs.unlinkSync(path.join(DATA_DIR, f));
}

// ---------- image blob store (content-addressed) ----------
// Imported document pages are huge base64 data URLs. Storing them inline in the
// board JSON meant every stroke re-serialized/re-wrote/re-snapshotted tens of MB
// and every pushed copy duplicated them. Instead we externalize each unique
// image to a blob file keyed by its content hash, and keep only a "blob:<hash>"
// reference in the stored board JSON. Blobs are DEDUPED (a PDF pushed to 30 kids
// is stored once) and boards on disk become tiny. Rehydration back to the full
// data URL happens transparently whenever a board is sent to a client, so the
// client and wire protocol are unchanged.
const BLOB_MIN = 4096; // only externalize data URLs bigger than this

function blobPut(dataUrl) {
  const hash = crypto.createHash('sha256').update(dataUrl).digest('hex');
  const f = path.join(DATA_DIR, `blob-${hash}`);
  if (!fs.existsSync(f)) {
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, dataUrl);
    fs.renameSync(tmp, f); // atomic — a partial blob is never referenced
  }
  return `blob:${hash}`;
}

function blobGet(ref) {
  const hash = String(ref).slice(5);
  if (!/^[a-f0-9]{64}$/.test(hash)) return null;
  try { return fs.readFileSync(path.join(DATA_DIR, `blob-${hash}`), 'utf8'); } catch { return null; }
}

// Replace big inline image data URLs with blob refs (non-mutating). A blob write
// failure (e.g. disk full) leaves that image inline — never corrupts the board.
function dehydrate(json) {
  if (!json || !Array.isArray(json.objects)) return json;
  let changed = false;
  const objects = json.objects.map((o) => {
    if (o && typeof o.src === 'string' && o.src.startsWith('data:') && o.src.length > BLOB_MIN) {
      try { const ref = blobPut(o.src); changed = true; return { ...o, src: ref }; } catch { return o; }
    }
    return o;
  });
  return changed ? { ...json, objects } : json;
}

// Resolve blob refs back to full data URLs for sending to clients (non-mutating).
function rehydrate(json) {
  if (!json || !Array.isArray(json.objects)) return json;
  let changed = false;
  const objects = json.objects.map((o) => {
    if (o && typeof o.src === 'string' && o.src.startsWith('blob:')) {
      const data = blobGet(o.src);
      if (data != null) { changed = true; return { ...o, src: data }; }
    }
    return o;
  });
  return changed ? { ...json, objects } : json;
}

// Every blob hash still referenced by a live board, a pending write, a history
// snapshot, or a template. Anything not here is orphaned and safe to delete.
function collectBlobRefs() {
  const refs = new Set();
  const scan = (json) => {
    if (!json || !Array.isArray(json.objects)) return;
    for (const o of json.objects) {
      if (o && typeof o.src === 'string' && o.src.startsWith('blob:')) refs.add(o.src.slice(5));
    }
  };
  for (const j of boardPending.values()) scan(j);
  for (const f of fs.readdirSync(DATA_DIR)) {
    try {
      if (/^board-[a-f0-9]{16}\.json$/.test(f) || /^tmpl-[a-f0-9]{16}\.json$/.test(f)) {
        scan(JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')).json);
      } else if (/^hist-[a-f0-9]+-\d+\.json\.gz$/.test(f)) {
        scan(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DATA_DIR, f))).toString()));
      }
    } catch { /* skip unreadable file — never delete blobs on a partial scan */ }
  }
  return refs;
}

// Delete blob files no board/history/template references anymore.
function gcBlobs() {
  try {
    const refs = collectBlobRefs();
    let removed = 0;
    for (const f of fs.readdirSync(DATA_DIR)) {
      const m = /^blob-([a-f0-9]{64})$/.exec(f);
      if (m && !refs.has(m[1])) { try { fs.unlinkSync(path.join(DATA_DIR, f)); removed++; } catch { /* ignore */ } }
      if (f.startsWith('blob-') && f.endsWith('.tmp')) { try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch { /* ignore */ } }
    }
    if (removed) console.log(`Blob GC: removed ${removed} orphaned image blob(s).`);
  } catch (e) {
    console.error('Blob GC failed:', e.message);
  }
}
setInterval(gcBlobs, 24 * 60 * 60 * 1000); // daily sweep of orphaned blobs

function createBoard({ owner, room, title, json, thumb, assignment }) {
  const id = crypto.randomBytes(8).toString('hex');
  const now = Date.now();
  const meta = { id, title: (title || 'Board').slice(0, 60), owner, room: room || null, createdAt: now, updatedAt: now, thumb: thumb || null, comments: [], assignment: assignment || null };
  boardsIndex.set(id, meta);
  indexBoard(meta);
  boardPending.set(id, dehydrate(json) || null);
  flushBoardSoon(id);
  return meta;
}

// Accept only genuine image data URLs of a sane size as thumbnails
function validThumb(t) {
  return typeof t === 'string' && /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(t) && t.length <= 400000;
}

function updateBoard(id, { json, thumb, title, room, embed }) {
  const meta = boardsIndex.get(id);
  if (!meta) return null;
  if (json !== undefined) boardPending.set(id, dehydrate(json));
  if (thumb !== undefined && validThumb(thumb)) meta.thumb = thumb;
  if (title !== undefined) meta.title = String(title).trim().slice(0, 60) || meta.title;
  if (room !== undefined && (room || null) !== meta.room) {
    idxDel(boardsByRoom, meta.room || '', id); // board moved rooms — keep the room index correct
    meta.room = room || null;
    idxAdd(boardsByRoom, meta.room || '', id);
  }
  if (embed !== undefined) {
    if (meta.embed && meta.embed.token) embedTokens.delete(meta.embed.token);
    meta.embed = embed;
    if (embed && embed.token) embedTokens.set(embed.token, id);
  }
  meta.updatedAt = Date.now();
  flushBoardSoon(id);
  return meta;
}

// Raw stored board JSON — holds blob refs, NOT full images. Used by the
// internals (ops application, snapshots) so the hot path stays tiny.
function readBoardStored(id) {
  if (boardPending.has(id)) return boardPending.get(id);
  try {
    return JSON.parse(fs.readFileSync(boardFile(id), 'utf8')).json || null;
  } catch {
    return null;
  }
}

// Client-ready board JSON: blob refs resolved back to full images. Every place
// that sends a board to a browser goes through here, so none of them need to
// know blobs exist.
function readBoardJSON(id) {
  return rehydrate(readBoardStored(id));
}

function deleteBoard(id) {
  const meta = boardsIndex.get(id);
  if (meta) unindexBoard(meta);
  boardsIndex.delete(id);
  boardPending.delete(id);
  clearTimeout(boardTimers.get(id));
  boardTimers.delete(id);
  fs.unlink(boardFile(id), () => {});
  try { deleteHistory(id); } catch { /* best effort */ }
}

function boardsFor(owner, room) {
  const ids = boardsByOwner.get(owner); // a single user owns very few boards
  if (!ids) return [];
  const want = room || null;
  const out = [];
  for (const id of ids) { const b = boardsIndex.get(id); if (b && b.room === want) out.push(b); }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

function roomBoards(room) {
  const ids = boardsByRoom.get(room || '');
  if (!ids) return [];
  const out = [];
  for (const id of ids) { const b = boardsIndex.get(id); if (b) out.push(b); }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ---------- assignments: assign → turn in → grade → return ----------
const assignments = new Map(); // id -> { id, room, title, instructions, dueAt, createdBy, createdByName, createdAt, submissions }
function assignmentFile(id) { return path.join(DATA_DIR, `assignment-${id}.json`); }

function loadAssignments() {
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (!f.startsWith('assignment-') || !f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
      if (d.id) assignments.set(d.id, d);
    } catch { /* skip a corrupt file */ }
  }
}

function saveAssignment(a) {
  fs.writeFile(assignmentFile(a.id), JSON.stringify(a), (err) => {
    if (err) console.error('Assignment save failed', a.id, err.message);
  });
}

// Shape an assignment for the client — full roster for a teacher, one row for a student
function assignmentView(a, { forStudent, room } = {}) {
  const nameOf = (sid) => (room && room.data.names[sid]) || displayNameOf(sid);
  const base = {
    id: a.id, room: a.room, title: a.title, instructions: a.instructions,
    dueAt: a.dueAt || null, createdAt: a.createdAt, createdByName: a.createdByName,
  };
  const subShape = (s) => ({
    boardId: s.boardId, status: s.status, grade: s.grade ?? null,
    feedback: s.feedback || '', turnedInAt: s.turnedInAt || null, returnedAt: s.returnedAt || null,
  });
  if (forStudent) {
    const s = a.submissions[forStudent];
    return { ...base, submission: s ? subShape(s) : null };
  }
  const submissions = Object.entries(a.submissions).map(([sid, s]) => ({ student: sid, name: nameOf(sid), ...subShape(s) }));
  return { ...base, submissions };
}

// First edit on an assigned board flips its status to "working" (once) for the teacher dashboard
function markAssignmentWorking(assignmentId, studentId, room) {
  const a = assignments.get(assignmentId);
  if (!a) return;
  const s = a.submissions[studentId];
  if (!s || s.status !== 'assigned') return;
  s.status = 'working';
  saveAssignment(a);
  if (room) emitToTeacher(room, 'assignment:progress', { assignmentId, student: studentId, status: 'working' });
}

function displayNameOf(id) {
  return (store.users[id] && store.users[id].name) || id;
}

// Apply object-level ops to a stored board JSON (per-object last-writer-wins)
function applyOpsToJson(json, ops) {
  let j = json && typeof json === 'object' ? json : { version: '5.3.0', objects: [] };
  for (const op of ops) {
    if (!op || typeof op !== 'object') continue;
    if (op.t === 'full') {
      if (op.json && typeof op.json === 'object') j = op.json;
      continue;
    }
    if (!Array.isArray(j.objects)) j.objects = [];
    if (op.t === 'clear') {
      j.objects = [];
    } else if ((op.t === 'add' || op.t === 'mod') && op.o && typeof op.o === 'object') {
      const i = op.o.oid ? j.objects.findIndex((x) => x && x.oid === op.o.oid) : -1;
      if (i >= 0) j.objects[i] = op.o;
      else j.objects.push(op.o);
    } else if (op.t === 'del' && op.oid) {
      j.objects = j.objects.filter((x) => !x || x.oid !== op.oid);
    }
  }
  return j;
}

// Board access: the owner, an admin, or the teacher who owns the room it lives in
// Same email domain, or an account this admin added themselves — WITHOUT the
// super-admin bypass. Board content viewing is domain-private by design.
function sameDomainOrAdded(user, email) {
  const rec = store.users[email];
  return domainOf(email) === domainOf(user.email) || !!(rec && rec.addedBy === user.email);
}

// Who may see a board's CONTENT: the owner, the teacher of its room, or a
// board admin for accounts on their own school domain. The super admin is
// deliberately domain-scoped too — they manage everything but only view
// boards from their own school.
function canViewBoard(user, meta) {
  if (meta.owner === user.email) return true;
  if (meta.room) {
    const room = getRoom(meta.room, false);
    if (room && room.data.owner === user.email) return true;
  }
  if ((user.isSuper || user.perms.includes('manage_boards')) && sameDomainOrAdded(user, meta.owner)) return true;
  return false;
}

// May `id` place boards into `targetRoom`? (owner, enrolled, or admin)
function canUseRoom(id, targetRoom, isBoardAdmin) {
  const room = getRoom(targetRoom, false);
  if (!room) return false;
  if (isBoardAdmin) return true;
  if (!AUTH_ENABLED) return true; // open mode trusts room codes
  return room.data.owner === id || (room.data.roster || []).includes(id);
}

// ---------- board REST api (personal boards + cross-class transfer) ----------

app.get('/api/boards/personal', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  res.json(boardsFor(user.email, null));
});

app.post('/api/boards/personal', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const meta = createBoard({ owner: user.email, room: null, title: req.body.title || `Board ${boardsFor(user.email, null).length + 1}` });
  res.json(meta);
});

app.get('/api/boards/:id', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const meta = boardsIndex.get(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Board not found.' });
  if (!canViewBoard(user, meta)) return res.status(403).json({ error: 'You do not have access to this board.' });
  res.json({ ...meta, json: readBoardJSON(meta.id) });
});

app.post('/api/boards/:id', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const meta = boardsIndex.get(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Board not found.' });
  if (meta.owner !== user.email) return res.status(403).json({ error: 'Only the board owner can edit it.' });
  updateBoard(meta.id, { json: req.body.json, thumb: req.body.thumb, title: req.body.title });
  // personal boards save whole-json over REST — keep any web embed live too
  if (meta.embed && meta.embed.token && req.body.json) {
    io.to('embed:' + meta.embed.token).emit('embed:ops', { ops: [{ t: 'full', json: req.body.json }] });
  }
  res.json(boardsIndex.get(meta.id));
});

app.delete('/api/boards/:id', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const meta = boardsIndex.get(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Board not found.' });
  if (meta.owner !== user.email && !user.isSuper && !user.perms.includes('manage_boards')) {
    return res.status(403).json({ error: 'Only the board owner or an admin can delete it.' });
  }
  deleteBoard(meta.id);
  res.json({ ok: true });
});

// ---------- web embeds (read-only, live, revocable) ----------

// Who may publish a board to the web: its owner (if a teacher/admin), the
// teacher of the room it lives in, or a board admin for their own school.
function canPublishBoard(user, meta) {
  const mayTeach = user.isSuper || user.perms.includes('teach') || user.perms.includes('manage_boards');
  if (!mayTeach) return false;
  if (meta.owner === user.email) return true;
  if (meta.room) {
    const room = getRoom(meta.room, false);
    if (room && room.data.owner === user.email) return true;
  }
  return (user.isSuper || user.perms.includes('manage_boards')) && sameDomainOrAdded(user, meta.owner);
}

// The 'embed' feature switch still governs it (school / room / student scoped)
function embedAllowed(meta, user) {
  if (!meta.room) return true; // personal boards: no room switches to consult
  const room = getRoom(meta.room, false);
  if (!room) return true;
  return effectiveFeatures(room, user.email).embed !== false;
}

app.post('/api/boards/:id/embed', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const meta = boardsIndex.get(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Board not found.' });
  if (!canPublishBoard(user, meta)) return res.status(403).json({ error: 'Only a teacher or admin can share a board to the web.' });
  if (!embedAllowed(meta, user)) return res.status(403).json({ error: 'Sharing boards to the web is turned off for this class.' });
  const token = crypto.randomBytes(12).toString('base64url');
  updateBoard(meta.id, { embed: { token, publishedAt: Date.now(), by: user.email } });
  appendAudit(user.email, 'board:embed-publish', `${meta.title} (${meta.room || 'personal'})`);
  res.json({ ok: true, token, url: `/embed/${token}` });
});

app.delete('/api/boards/:id/embed', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const meta = boardsIndex.get(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Board not found.' });
  if (!canPublishBoard(user, meta)) return res.status(403).json({ error: 'Not allowed.' });
  const oldToken = meta.embed && meta.embed.token;
  updateBoard(meta.id, { embed: null });
  // Kick viewers already connected to the embed room — otherwise "revoked"
  // only blocks NEW connections while live iframes keep streaming ops.
  if (oldToken) io.in('embed:' + oldToken).disconnectSockets(true);
  appendAudit(user.email, 'board:embed-revoke', meta.title);
  res.json({ ok: true });
});

// Public, unauthenticated: the board content behind a valid embed token.
// Deliberately minimal — no owner, no room, no comments, no classmates.
app.get('/api/embed/:token', (req, res) => {
  const id = embedTokens.get(String(req.params.token || ''));
  const meta = id && boardsIndex.get(id);
  if (!meta || !meta.embed) return res.status(404).json({ error: 'This board is no longer shared.' });
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow'); // published boards are link-only, never indexed
  res.json({ title: meta.title, updatedAt: meta.updatedAt, json: readBoardJSON(meta.id) });
});

app.get('/embed/:token', (req, res) => {
  res.set('X-Robots-Tag', 'noindex, nofollow'); // keep shared boards out of search engines
  res.sendFile(path.join(__dirname, 'public', 'embed.html'));
});

app.get('/api/boards/:id/history', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const meta = boardsIndex.get(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Board not found.' });
  if (!canViewBoard(user, meta)) return res.status(403).json({ error: 'You do not have access to this board.' });
  res.json({ versions: histList(meta.id) });
});

app.post('/api/boards/:id/restore', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const meta = boardsIndex.get(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Board not found.' });
  const isRoomTeacher = meta.room && (getRoom(meta.room, false) || { data: {} }).data.owner === user.email;
  if (meta.owner !== user.email && !isRoomTeacher) {
    return res.status(403).json({ error: 'Only the board owner or their teacher can restore versions.' });
  }
  const json = histRestore(meta.id, Number(req.body.ts));
  if (!json) return res.status(404).json({ error: 'That version no longer exists.' });
  // live-update anyone currently on this board
  for (const s of io.of('/').sockets.values()) {
    if (s.data && s.data.code === meta.room && (s.data.id === meta.owner || s.data.role === 'teacher')) {
      s.emit('board:peer', { boardId: meta.id, json, by: user.name, note: 'Board restored to an earlier version' });
    }
  }
  res.json({ ok: true, json });
});

app.post('/api/boards/:id/transfer', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const meta = boardsIndex.get(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Board not found.' });
  const isBoardAdmin = user.isSuper || user.perms.includes('manage_boards');
  if (meta.owner !== user.email && !isBoardAdmin) {
    return res.status(403).json({ error: 'Only the board owner or an admin can move or copy it.' });
  }
  const mode = req.body.mode === 'move' ? 'move' : 'copy';
  const targetRoom = req.body.room ? sanitizeCode(req.body.room) : null;
  if (targetRoom && !canUseRoom(meta.owner, targetRoom, isBoardAdmin)) {
    return res.status(403).json({ error: 'The board owner is not part of that class.' });
  }
  if (mode === 'move') {
    updateBoard(meta.id, { room: targetRoom });
    return res.json(boardsIndex.get(meta.id));
  }
  const copy = createBoard({
    owner: meta.owner, room: targetRoom,
    title: meta.title + (targetRoom === meta.room ? ' (copy)' : ''),
    json: readBoardJSON(meta.id), thumb: meta.thumb,
  });
  res.json(copy);
});

// List all boards in a room (room owner or admin) — powers the teacher close-up and admin portal
app.get('/api/room/:code/boards', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const room = getRoom(sanitizeCode(req.params.code), false);
  if (!room) return res.status(404).json({ error: 'Room not found.' });
  if (!canEditRoom(user, room.data)) return res.status(403).json({ error: 'Only the room owner or an admin can view all boards.' });
  res.json(roomBoards(room.code).map((b) => ({ ...b, ownerName: room.data.names[b.owner] || displayNameOf(b.owner) })));
});

// ---------- document conversion (DOCX/PPTX/... -> PDF via LibreOffice) ----------

const CONVERT_EXTS = ['doc', 'docx', 'ppt', 'pptx', 'odt', 'odp', 'ods', 'rtf', 'txt', 'xls', 'xlsx'];

app.post('/api/convert', express.raw({ type: () => true, limit: '25mb' }), (req, res) => {
  if (AUTH_ENABLED) {
    const user = requireUser(req, res);
    if (!user) return;
  }
  const ext = String(req.query.ext || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!CONVERT_EXTS.includes(ext)) return res.status(400).json({ error: `Unsupported file type ".${ext}".` });
  if (!req.body || !req.body.length) return res.status(400).json({ error: 'Empty file.' });

  const os = require('os');
  const { execFile } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbconv-'));
  const inPath = path.join(dir, `input.${ext}`);
  fs.writeFileSync(inPath, req.body);
  execFile('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', dir, inPath],
    { timeout: 90000, env: { ...process.env, HOME: os.tmpdir() } },
    (err) => {
      const outPath = path.join(dir, 'input.pdf');
      if (err || !fs.existsSync(outPath)) {
        fs.rmSync(dir, { recursive: true, force: true });
        const notInstalled = err && err.code === 'ENOENT';
        return res.status(notInstalled ? 501 : 500).json({
          error: notInstalled
            ? 'Document conversion is not available on this server — PDFs still work directly.'
            : 'Could not convert that document. Try exporting it as a PDF first.',
        });
      }
      const pdf = fs.readFileSync(outPath);
      fs.rmSync(dir, { recursive: true, force: true });
      res.type('application/pdf').send(pdf);
    });
});

// ---------- template library ----------
// Templates live in tmpl-<id>.json files. Scopes: 'personal' (one teacher),
// 'school' (one domain, managed by local admins), 'public' (everyone, curated
// by the super admin). Non-admin submissions start as 'pending'.

const TEMPLATE_SUBJECTS = ['General', 'Math', 'Science', 'English', 'Social Studies', 'Art'];
const templatesIndex = new Map(); // id -> meta (json kept on disk)

function tmplFile(id) {
  return path.join(DATA_DIR, `tmpl-${id}.json`);
}

function tmplMetaOf(d) {
  return {
    id: d.id, title: d.title || 'Template', subject: TEMPLATE_SUBJECTS.includes(d.subject) ? d.subject : 'General',
    scope: d.scope, domain: d.domain || null, owner: d.owner || null, ownerName: d.ownerName || null,
    status: d.status === 'pending' ? 'pending' : 'approved', thumb: d.thumb || null,
    createdAt: d.createdAt || 0, updatedAt: d.updatedAt || 0,
  };
}

function loadTemplatesIndex() {
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (!/^tmpl-[a-f0-9]{16}\.json$/.test(f)) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
      if (d.id) templatesIndex.set(d.id, tmplMetaOf(d));
    } catch (e) {
      console.error('Could not read template file', f, e.message);
    }
  }
}

function createTemplate(fields) {
  const id = crypto.randomBytes(8).toString('hex');
  const now = Date.now();
  const meta = tmplMetaOf({ ...fields, id, createdAt: now, updatedAt: now });
  templatesIndex.set(id, meta);
  fs.writeFileSync(tmplFile(id), JSON.stringify({ ...meta, json: fields.json || null }));
  return meta;
}

function saveTemplateMeta(id) {
  const meta = templatesIndex.get(id);
  if (!meta) return;
  meta.updatedAt = Date.now();
  const json = readTemplateJSON(id);
  fs.writeFileSync(tmplFile(id), JSON.stringify({ ...meta, json }));
}

function readTemplateJSON(id) {
  try {
    return JSON.parse(fs.readFileSync(tmplFile(id), 'utf8')).json || null;
  } catch {
    return null;
  }
}

function deleteTemplate(id) {
  templatesIndex.delete(id);
  fs.unlink(tmplFile(id), () => {});
}

// Who may see a template's content
function canSeeTemplate(user, meta) {
  if (meta.owner === user.email) return true;
  if (meta.scope === 'public') return meta.status === 'approved' || user.isSuper;
  if (meta.scope === 'school') {
    if (meta.domain !== domainOf(user.email)) return false;
    return meta.status === 'approved' || user.isSuper || user.perms.includes('manage_boards');
  }
  return false; // personal templates of other people
}

// Who may manage (approve/edit/delete) a template
function canManageTemplate(user, meta) {
  if (meta.scope === 'personal') return meta.owner === user.email;
  if (meta.scope === 'public') return user.isSuper;
  if (meta.scope === 'school') {
    return user.isSuper || (user.perms.includes('manage_boards') && meta.domain === domainOf(user.email));
  }
  return false;
}

// ----- built-in starter templates (seeded once) -----

function seedTemplates() {
  if ([...templatesIndex.values()].some((t) => t.owner === '__builtin__')) return;
  const L = (x1, y1, x2, y2, w = 1.5, color = '#B9C0C7') => ({ type: 'line', x1, y1, x2, y2, left: Math.min(x1, x2), top: Math.min(y1, y2), stroke: color, strokeWidth: w, selectable: false, evented: false, oid: 'o' + Math.random().toString(36).slice(2, 11) });
  const R = (left, top, width, height, opts = {}) => ({ type: 'rect', left, top, width, height, fill: 'transparent', stroke: '#1F2937', strokeWidth: 2, oid: 'o' + Math.random().toString(36).slice(2, 11), ...opts });
  const T = (text, left, top, fontSize = 22, opts = {}) => ({ type: 'i-text', version: '5.3.0', text, left, top, fontSize, fontFamily: 'Bricolage Grotesque', fill: '#1F2937', styles: [], oid: 'o' + Math.random().toString(36).slice(2, 11), ...opts });
  const C = (left, top, radius, opts = {}) => ({ type: 'circle', left, top, radius, fill: 'transparent', stroke: '#1F2937', strokeWidth: 2, oid: 'o' + Math.random().toString(36).slice(2, 11), ...opts });
  const J = (objects) => ({ version: '5.3.0', objects });
  const seeds = [];

  // General
  const lined = []; for (let i = 0; i < 18; i++) lined.push(L(40, 80 + i * 44, 1000, 80 + i * 44));
  seeds.push({ title: 'Lined paper', subject: 'General', json: J(lined) });
  const grid = []; for (let i = 0; i <= 24; i++) grid.push(L(40 + i * 40, 40, 40 + i * 40, 680, 1, '#D8DEE4')); for (let i = 0; i <= 16; i++) grid.push(L(40, 40 + i * 40, 1000, 40 + i * 40, 1, '#D8DEE4'));
  seeds.push({ title: 'Grid paper', subject: 'General', json: J(grid) });
  seeds.push({ title: 'T-Chart', subject: 'General', json: J([T('Topic:', 60, 30, 28), L(520, 100, 520, 660, 3, '#1F2937'), L(60, 100, 980, 100, 3, '#1F2937'), T('Side A', 220, 55, 24), T('Side B', 680, 55, 24)]) });
  seeds.push({ title: 'KWL Chart', subject: 'General', json: J([T('Topic:', 60, 20, 26), R(40, 70, 320, 560), R(370, 70, 320, 560), R(700, 70, 320, 560), T('K — What I Know', 70, 85, 20), T('W — What I Wonder', 400, 85, 20), T('L — What I Learned', 730, 85, 20)]) });
  seeds.push({ title: 'Exit ticket', subject: 'General', json: J([T('Exit Ticket', 60, 30, 32), T('1. One thing I learned today…', 60, 110, 22), R(60, 150, 900, 120), T('2. One question I still have…', 60, 310, 22), R(60, 350, 900, 120), T('3. How confident do I feel? (1–5)', 60, 510, 22), R(60, 550, 900, 70)]) });

  // Math
  const plane = []; for (let i = 0; i <= 20; i++) { plane.push(L(60 + i * 30, 60, 60 + i * 30, 660, 1, '#E3E7EB')); } for (let i = 0; i <= 20; i++) plane.push(L(60, 60 + i * 30, 660, 60 + i * 30, 1, '#E3E7EB'));
  plane.push(L(360, 60, 360, 660, 2.5, '#1F2937'), L(60, 360, 660, 360, 2.5, '#1F2937'), T('x', 668, 348, 18), T('y', 352, 34, 18));
  seeds.push({ title: 'Coordinate plane', subject: 'Math', json: J(plane) });
  const nline = [L(60, 200, 1060, 200, 3, '#1F2937')]; for (let i = 0; i <= 20; i++) { nline.push(L(60 + i * 50, 188, 60 + i * 50, 212, 2, '#1F2937')); nline.push(T(String(i - 10), 52 + i * 50, 222, 16)); }
  seeds.push({ title: 'Number line (-10 to 10)', subject: 'Math', json: J(nline) });
  const frac = [T('Fraction bars', 60, 20, 26)]; const rows = [1, 2, 3, 4, 6, 8]; rows.forEach((n, r) => { for (let i = 0; i < n; i++) frac.push(R(60 + i * (840 / n), 80 + r * 70, 840 / n, 50)); frac.push(T(`1/${n}`, 930, 90 + r * 70, 20)); });
  seeds.push({ title: 'Fraction bars', subject: 'Math', json: J(frac) });

  // Science
  seeds.push({ title: 'Venn diagram', subject: 'Science', json: J([C(140, 120, 220, { stroke: '#0A7C6E', strokeWidth: 3 }), C(420, 120, 220, { stroke: '#FF6B35', strokeWidth: 3 }), T('A', 220, 90, 26, { fill: '#0A7C6E' }), T('B', 740, 90, 26, { fill: '#FF6B35' }), T('Both', 460, 90, 22)]) });
  seeds.push({ title: 'Lab report', subject: 'Science', json: J([T('Lab report', 60, 20, 30), T('Question', 60, 90, 22), R(60, 125, 920, 80), T('Hypothesis', 60, 230, 22), R(60, 265, 920, 80), T('Materials & method', 60, 370, 22), R(60, 405, 920, 110), T('Observations', 60, 540, 22), R(60, 575, 920, 110), T('Conclusion', 60, 710, 22), R(60, 745, 920, 90)]) });

  // English
  seeds.push({ title: 'Story map', subject: 'English', json: J([T('Story map', 60, 20, 30), R(60, 80, 440, 180), T('Characters', 80, 95, 20), R(540, 80, 440, 180), T('Setting', 560, 95, 20), R(60, 290, 440, 180), T('Problem', 80, 305, 20), R(540, 290, 440, 180), T('Solution', 560, 305, 20), R(60, 500, 920, 150), T('Beginning → Middle → End', 80, 515, 20)]) });

  // Social Studies
  const tl = [T('Timeline', 60, 20, 30), L(80, 400, 1080, 400, 4, '#1F2937')]; for (let i = 0; i < 6; i++) { tl.push(L(140 + i * 180, 385, 140 + i * 180, 415, 3, '#1F2937')); tl.push(R(90 + i * 180, i % 2 === 0 ? 220 : 440, 160, 120, { stroke: '#0A7C6E' })); }
  seeds.push({ title: 'Timeline', subject: 'Social Studies', json: J(tl) });

  for (const s of seeds) {
    createTemplate({ ...s, scope: 'public', status: 'approved', owner: '__builtin__', ownerName: 'Signify Learning' });
  }
  console.log(`Seeded ${seeds.length} starter templates`);
}

// ---------- rooms ----------
// Boards are keyed by a stable id: the verified Google email when auth is on,
// otherwise the typed name. data.names maps id -> display name.

const rooms = new Map();

function sanitizeCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 12);
}

function roomFile(code) {
  return path.join(DATA_DIR, `room-${code}.json`);
}

// The shareable join code is separate from the room id, so it can be reset
function findRoomByJoinCode(code) {
  for (const room of rooms.values()) {
    if (room.data.joinCode === code) return room;
  }
  return null;
}

function generateJoinCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let c;
  do {
    c = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(c) || fs.existsSync(roomFile(c)) || findRoomByJoinCode(c));
  return c;
}

function roomSummaries() {
  // Union of rooms on disk and live rooms not yet flushed by the debounced save
  const codes = new Set(rooms.keys());
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (/^room-.+\.json$/.test(f)) codes.add(f.replace(/^room-/, '').replace(/\.json$/, ''));
  }
  return [...codes]
    .map((code) => {
      try {
        const live = rooms.get(code);
        const d = live ? live.data : JSON.parse(fs.readFileSync(roomFile(code), 'utf8'));
        return {
          code,
          name: d.name || '',
          owner: d.owner || null,
          roster: d.roster || [],
          archived: !!d.archived,
          updatedAt: d.updatedAt || 0,
          students: roomBoards(code).length,
          online: live ? live.students.size : 0,
          teacherOnline: !!(live && live.teacher),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function listRooms() {
  return roomSummaries().map(({ roster, ...r }) => ({ ...r, rosterCount: roster.length }));
}

function getRoom(code, createIfMissing) {
  let room = rooms.get(code);
  if (room) return room;
  let data = { name: '', owner: null, roster: [], joinCode: code, joinDisabled: false, features: {}, studentFeatures: {}, messages: [], teacherBoard: null, boards: {}, thumbs: {}, names: {}, updatedAt: Date.now() };
  const file = roomFile(code);
  if (fs.existsSync(file)) {
    try {
      data = Object.assign(data, JSON.parse(fs.readFileSync(file, 'utf8')));
      data.names = data.names || {};
      data.roster = data.roster || [];
      data.features = data.features || {};
      data.studentFeatures = data.studentFeatures || {};
      data.messages = data.messages || [];
      data.joinCode = data.joinCode || code; // legacy rooms: join code = room id
    } catch (e) {
      console.error('Could not read saved room', code, e.message);
    }
  } else if (!createIfMissing) {
    return null;
  }
  migrateLegacyBoards(code, data);
  room = { code, data, teacher: null, students: new Map(), sharing: false, saveTimer: null, lastTeacherJson: null, poll: null };
  rooms.set(code, room);
  return room;
}

// Aggregate the current poll for the teacher's live view
function pollResults(room) {
  const p = room.poll;
  if (!p) return null;
  const entries = [...p.responses.entries()];
  const base = { id: p.id, question: p.question, type: p.type, open: p.open, total: entries.length, online: room.students.size };
  if (p.type === 'choice') {
    const counts = p.options.map(() => 0);
    for (const [, v] of entries) { if (v >= 0 && v < counts.length) counts[v]++; }
    return { ...base, options: p.options, counts };
  }
  return { ...base, responses: entries.map(([sid, v]) => ({ name: room.data.names[sid] || sid, value: v })) };
}

// Rooms used to embed one board per student plus a teacher board; convert those
// into standalone board entities the first time the room is loaded.
function migrateLegacyBoards(code, data) {
  const hadLegacy = data.teacherBoard || (data.boards && Object.keys(data.boards).length);
  if (!hadLegacy) {
    delete data.teacherBoard; delete data.boards; delete data.thumbs;
    return;
  }
  if (data.teacherBoard) {
    createBoard({ owner: data.owner || 'teacher', room: code, title: 'Board 1', json: data.teacherBoard });
  }
  for (const [uid, json] of Object.entries(data.boards || {})) {
    createBoard({ owner: uid, room: code, title: 'Board 1', json, thumb: (data.thumbs || {})[uid] || null });
  }
  delete data.teacherBoard; delete data.boards; delete data.thumbs;
  fs.writeFileSync(roomFile(code), JSON.stringify(data));
  console.log(`Migrated legacy boards for room ${code}`);
}

function scheduleSave(room) {
  if (room.saveTimer) return;
  room.saveTimer = setTimeout(() => {
    room.saveTimer = null;
    fs.writeFile(roomFile(room.code), JSON.stringify(room.data), (err) => {
      if (err) console.error('Save failed for room', room.code, err.message);
    });
  }, 800);
}

function emitToTeacher(room, event, payload) {
  if (room.teacher) io.to(room.teacher).emit(event, payload);
}

// Who may read a room message: teachers see all; students see broadcasts,
// their own messages, and DMs addressed to them.
function canSeeMessage(sd, msg) {
  if (sd.role === 'teacher') return true;
  if (msg.to === null) return true;
  if (msg.from === sd.id) return true;
  if (msg.to === sd.id) return true;
  return false;
}

// Board-level socket permission: the owner or the room teacher
function canTouchBoardSocket(socket, meta) {
  const { code, id, role } = socket.data || {};
  return !!meta && !!code && meta.room === code && (meta.owner === id || role === 'teacher');
}

function broadcastComments(socket, meta) {
  for (const s of io.of('/').sockets.values()) {
    if (s.id === socket.id || !s.data || s.data.code !== meta.room) continue;
    if (s.data.id === meta.owner || s.data.role === 'teacher') {
      s.emit('comments:update', { boardId: meta.id, comments: meta.comments || [] });
    }
  }
}

// Send a student their freshly-resolved feature switches (to all their tabs)
function pushFeatures(room, sid) {
  emitToStudent(room.code, sid, 'features:update', { features: effectiveFeatures(room, sid) });
}

function teacherRoom(socket) {
  const { code, role } = socket.data || {};
  if (role !== 'teacher' || !code) return null;
  return rooms.get(code) || null;
}

// Build the canonical {email,name,perms,isSuper} user for a socket, so socket
// handlers can reuse the same authorization helpers as the REST routes.
function socketUser(socket) {
  const u = socket.data && socket.data.user;
  if (!u) return null;
  return { email: u.email, name: u.name, perms: permsFor(u.email), isSuper: isSuperAdmin(u.email) };
}

// Iterate only the sockets joined to room `code` (via socket.join(code)),
// instead of scanning every socket on the whole server. Hot paths like
// cursor:move and board:ops fan out through this — at classroom scale the old
// instance-wide scans cost O(all sockets on the box) per event.
function* roomSockets(code) {
  const ns = io.of('/');
  const ids = ns.adapter.rooms.get(code);
  if (!ids) return;
  for (const sid of ids) {
    const s = ns.sockets.get(sid);
    if (s) yield s;
  }
}

// Emit to EVERY socket a student has open in this room — room.students only
// tracks their most recent socket, so a second tab or a mid-event reconnect
// would otherwise silently miss the delivery.
function emitToStudent(code, sid, event, data) {
  for (const s of roomSockets(code)) {
    if (s.data && s.data.id === sid) s.emit(event, data);
  }
}

// Does this student still have at least one live socket in the room (besides
// optionally an excluded one)? Used to avoid a premature "left" on multi-tab.
function studentHasSocket(code, sid, exceptSocketId) {
  for (const s of roomSockets(code)) {
    if (s.id !== exceptSocketId && s.data && s.data.id === sid) return s.id;
  }
  return null;
}

// A running countdown, or null if none/expired
function activeTimer(room) {
  if (room.timer && room.timer.endsAt > Date.now()) return room.timer;
  room.timer = null;
  return null;
}

// What's on the class stage right now (teacher's live board or a student's
// latest). lastTeacherJson holds blob refs, so rehydrate it for the students.
function stageJson(room) {
  if (room.sharing === 'teacher') return rehydrate(room.lastTeacherJson);
  if (room.sharing) {
    const latest = boardsFor(room.sharing, room.code)[0];
    return latest ? readBoardJSON(latest.id) : null; // already rehydrated
  }
  return null;
}

function stageBy(room) {
  if (room.sharing === 'teacher') return 'Your teacher';
  return room.data.names[room.sharing] || displayNameOf(room.sharing);
}

// ---------- sockets ----------

io.use((socket, next) => {
  // Embed viewers are anonymous by design: they may ONLY join an embed room
  // for a valid token and receive ops. They get no session and no other events.
  const et = socket.handshake.auth && socket.handshake.auth.embedToken;
  if (et) {
    const id = embedTokens.get(String(et));
    if (!id) return next(new Error('unauthorized'));
    socket.data.embedToken = String(et);
    socket.data.embedBoard = id;
    return next();
  }
  if (!AUTH_ENABLED) return next();

  // The session is an httpOnly cookie, which the browser sends on a
  // same-origin handshake — so the page never holds a token it could leak.
  signify.verifyCookieSession(socket.handshake.headers.cookie)
    .then((claims) => {
      if (!claims) return next(new Error('unauthorized'));
      shadow(claims);
      socket.data.user = { email: String(claims.email).toLowerCase(), name: claims.name };
      next();
    })
    .catch(() => next(new Error('unauthorized')));
});

io.on('connection', (socket) => {
  // Embed viewers: join the broadcast room and register nothing else, so a
  // public embed connection can never reach board/message/roster events.
  if (socket.data.embedToken) {
    socket.join('embed:' + socket.data.embedToken);
    return;
  }

  socket.on('join', (payload, ack) => {
    if (typeof ack !== 'function') return;
    // Throttle join attempts per IP so the 5-char room-code space can't be brute-forced.
    const ip = (socket.handshake.headers['x-forwarded-for'] || '').split(',')[0].trim() || socket.handshake.address;
    if (!joinLimiter(ip)) return ack({ error: 'Too many attempts — please wait a moment and try again.' });
    try {
      const code = sanitizeCode(payload.room);
      let name, id, role;
      if (AUTH_ENABLED) {
        const u = socket.data.user;
        id = u.email;
        name = (store.users[u.email] && store.users[u.email].name) || u.name;
        role = payload.role === 'teacher' ? 'teacher' : 'student';
        if (role === 'teacher' && !hasPerm(u.email, 'teach')) {
          return ack({ error: 'Your account is not registered as a teacher. Ask your admin to change your role.' });
        }
      } else {
        name = String(payload.name || '').trim().slice(0, 30);
        id = name;
        role = payload.role === 'teacher' ? 'teacher' : 'student';
      }
      if (!code || !id) return ack({ error: 'A name and room code are required.' });
      if (!isSafeKey(id)) return ack({ error: 'That name is not allowed.' }); // open mode: id is the typed name

      // Resolve by room id (roster links, teachers) or by the shareable join code
      let room = getRoom(code, false);
      if (!room) room = findRoomByJoinCode(code);
      if (!room && role === 'teacher') room = getRoom(code, true);
      if (!room) return ack({ error: `Room "${code}" doesn't exist yet. Check the code with your teacher.` });

      // Students who aren't enrolled yet need a live join code
      if (role === 'student' && !(room.data.roster || []).includes(id)) {
        if (room.data.joinCode !== code) {
          return ack({ error: `Room "${code}" doesn't exist yet. Check the code with your teacher.` });
        }
        if (room.data.joinDisabled) {
          return ack({ error: 'Joining with a code is turned off for this class. Ask your teacher to add you.' });
        }
      }

      // A teacher may only take the teacher seat of a room they OWN (or as an
      // admin). Without this, any account with the 'teach' permission that
      // learned a room code could hijack another teacher's class — displacing
      // them and gaining read/write on every student board and DM. Unowned
      // legacy rooms are claimed just below.
      if (AUTH_ENABLED && role === 'teacher' && room.data.owner
          && room.data.owner !== id && !hasPerm(id, 'manage_boards')) {
        return ack({ error: 'This classroom belongs to another teacher. Ask an admin if you need access to it.' });
      }

      socket.data.code = code;
      socket.data.id = id;
      socket.data.name = name;
      socket.data.role = role;
      socket.data.connectedAt = Date.now();
      socket.join(code);

      // Everyone gets their list of boards in this room; create the first one if needed
      let myBoards = boardsFor(id, code);
      if (!myBoards.length) {
        myBoards = [createBoard({ owner: id, room: code, title: 'Board 1' })];
      }
      const active = myBoards[0];
      const activeJson = readBoardJSON(active.id);

      if (role === 'teacher') {
        room.teacher = socket.id;
        room.lastTeacherJson = readBoardStored(active.id); // blob refs; rehydrated when shared
        if (AUTH_ENABLED && !room.data.owner) {
          room.data.owner = id; // first teacher in claims an unowned (legacy) room
          scheduleSave(room);
        }
        const students = [];
        const ids = new Set([...(room.data.roster || []), ...roomBoards(code).map((b) => b.owner)]);
        ids.delete(id);
        if (room.data.owner) ids.delete(room.data.owner);
        for (const sid of ids) {
          const latest = boardsFor(sid, code)[0] || null;
          students.push({
            id: sid,
            name: room.data.names[sid] || displayNameOf(sid),
            online: room.students.has(sid),
            thumb: latest ? latest.thumb : null,
            boardId: latest ? latest.id : null,
          });
        }
        ack({
          ok: true, name, roomName: room.data.name || '', boards: myBoards, activeBoard: { id: active.id, json: activeJson },
          students, sharing: room.sharing, shareBy: room.sharing ? stageBy(room) : null,
          roomFeatures: room.data.features, studentFeatures: room.data.studentFeatures,
          joinCode: room.data.joinCode, joinDisabled: !!room.data.joinDisabled,
          timer: activeTimer(room),
        });
      } else {
        room.students.set(id, socket.id);
        room.data.names[id] = name;
        if (!(room.data.roster || []).includes(id)) {
          room.data.roster = room.data.roster || [];
          room.data.roster.push(id); // joining by code enrolls you; re-entry works after a code reset
        }
        scheduleSave(room);
        const onStage = room.sharing && room.sharing !== id; // the spotlighted kid keeps drawing, no overlay
        ack({
          ok: true,
          name,
          roomName: room.data.name || '',
          boards: myBoards,
          activeBoard: { id: active.id, json: activeJson },
          sharing: onStage ? room.sharing : false,
          teacherBoard: onStage ? stageJson(room) : null,
          shareBy: onStage ? stageBy(room) : null,
          features: effectiveFeatures(room, id),
          timer: activeTimer(room),
        });
        emitToTeacher(room, 'student:joined', {
          id, name,
          thumb: active.thumb || null,
          boardId: active.id,
        });
        if (room.poll && room.poll.open) {
          const p = room.poll;
          socket.emit('poll:open', { id: p.id, question: p.question, type: p.type, options: p.options });
        }
      }
    } catch (e) {
      console.error('join error', e);
      ack({ error: 'Could not join the room.' });
    }
  });

  socket.on('board:update', (payload, ack) => {
    const { code, id, name, role } = socket.data || {};
    const room = code && rooms.get(code);
    const json = payload && payload.json;
    const meta = payload && boardsIndex.get(payload.boardId);
    if (!room || !json || !meta || meta.room !== code) return;
    const isOwner = meta.owner === id;
    if (!isOwner && role !== 'teacher') return; // the room teacher may draw on any board in the room
    room.data.updatedAt = Date.now();
    const safeThumb = validThumb(payload.thumb) ? payload.thumb : null;
    updateBoard(meta.id, { json, thumb: safeThumb });

    // Live-sync the board owner's other devices (and notify them if the teacher is drawing)
    for (const s of roomSockets(code)) {
      if (s.id === socket.id || !s.data) continue;
      if (s.data.id === meta.owner) {
        s.emit('board:peer', { boardId: meta.id, json, by: name, note: !isOwner ? `${name} is drawing on your board` : null });
      }
    }

    if (role === 'teacher' && isOwner) {
      room.lastTeacherJson = dehydrate(json); // keep only blob refs in memory
      if (room.sharing === 'teacher') socket.to(code).emit('teacher:board', { json });
    }
    // spotlighted student drawing: stream their board to the class stage
    if (room.sharing && room.sharing === meta.owner && role === 'student') {
      socket.to(code).emit('teacher:board', { json });
    }
    if (meta.owner !== room.data.owner && room.teacher && room.teacher !== socket.id) {
      // keep the teacher dashboard fresh for student-owned boards
      io.to(room.teacher).emit('student:board', {
        id: meta.owner, name: room.data.names[meta.owner] || meta.owner,
        boardId: meta.id, json, thumb: safeThumb,
      });
    }
    scheduleSave(room);
    if (typeof ack === 'function') ack({ ok: true });
  });

  // Object-level sync: tiny per-object ops instead of the whole board each stroke
  socket.on('board:ops', (payload, ack) => {
    const { code, id, name, role } = socket.data || {};
    const room = code && rooms.get(code);
    const meta = payload && boardsIndex.get(payload.boardId);
    const ops = payload && Array.isArray(payload.ops) ? payload.ops.slice(0, 200) : null;
    if (!room || !meta || meta.room !== code || !ops || !ops.length) return;
    const isOwner = meta.owner === id;
    if (!isOwner && role !== 'teacher') return;
    room.data.updatedAt = Date.now();
    // Apply the tiny stroke op to the RAW stored board (blob refs), never the
    // rehydrated multi-MB version — this is what makes per-stroke saves cheap.
    const json = applyOpsToJson(readBoardStored(meta.id), ops);
    const safeThumb = payload.thumb && validThumb(payload.thumb) ? payload.thumb : undefined;
    updateBoard(meta.id, { json, thumb: safeThumb });
    const rev = meta.updatedAt; // updated by updateBoard — the new board revision
    if (meta.assignment && isOwner) markAssignmentWorking(meta.assignment, id, room);

    // fan the ops out to everyone who cares (they're small)
    for (const s of roomSockets(code)) {
      if (s.id === socket.id || !s.data) continue;
      if (s.data.id === meta.owner || s.data.role === 'teacher') {
        s.emit('board:ops', {
          boardId: meta.id, owner: meta.owner, ops, by: name, rev,
          note: !isOwner && s.data.id === meta.owner ? `${name} is drawing on your board` : null,
        });
      }
    }
    if (safeThumb && meta.owner !== room.data.owner && room.teacher && room.teacher !== socket.id) {
      io.to(room.teacher).emit('student:thumb', { id: meta.owner, boardId: meta.id, thumb: safeThumb });
    }
    // anyone watching this board via a web embed gets the same ops
    if (meta.embed && meta.embed.token) io.to('embed:' + meta.embed.token).emit('embed:ops', { ops });
    // stage streaming (teacher share or student spotlight) as ops too
    if (role === 'teacher' && isOwner) {
      room.lastTeacherJson = json;
      if (room.sharing === 'teacher') socket.to(code).emit('stage:ops', { ops });
    } else if (room.sharing && room.sharing === meta.owner) {
      socket.to(code).emit('stage:ops', { ops });
    }
    scheduleSave(room);
    if (typeof ack === 'function') ack({ ok: true, rev }); // sender tracks its own new revision
  });

  // Live presence: ephemeral cursor positions, routed like board:ops but never stored.
  // Coordinates are scene/board coords so each viewer maps them with its own pan/zoom.
  // Clients announce which board they're looking at so cursors only reach actual co-viewers.
  socket.on('presence:view', (payload) => {
    const meta = payload && boardsIndex.get(payload.boardId);
    socket.data.viewingBoard = meta && meta.room === socket.data.code ? meta.id : null;
  });

  socket.on('cursor:move', (payload) => {
    const { code, id, name, role } = socket.data || {};
    const room = code && rooms.get(code);
    const meta = payload && boardsIndex.get(payload.boardId);
    if (!room || !meta || meta.room !== code) return;
    if (meta.owner !== id && role !== 'teacher') return; // only the owner or the room teacher share a board
    const x = Number(payload.x), y = Number(payload.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    for (const s of roomSockets(code)) {
      if (s.id === socket.id || !s.data) continue;
      // the board owner always co-views their own board; others must have opened it
      if (s.data.viewingBoard === meta.id || s.data.id === meta.owner) {
        s.emit('cursor:peer', { boardId: meta.id, from: id, name, x, y });
      }
    }
  });

  socket.on('cursor:hide', (payload) => {
    const { code, id } = socket.data || {};
    const room = code && rooms.get(code);
    const meta = payload && boardsIndex.get(payload.boardId);
    if (!room || !meta || meta.room !== code) return;
    for (const s of roomSockets(code)) {
      if (s.id === socket.id || !s.data) continue;
      if (s.data.viewingBoard === meta.id || s.data.id === meta.owner) s.emit('cursor:gone', { from: id });
    }
  });

  // ----- board management within the joined room -----

  function myRoomBoard(payload) {
    const { code, id } = socket.data || {};
    if (!code) return null;
    const meta = payload && boardsIndex.get(payload.boardId);
    return meta && meta.owner === id && meta.room === code ? meta : null;
  }

  socket.on('board:list', (payload, ack) => {
    const { code, id } = socket.data || {};
    if (!code || typeof ack !== 'function') return;
    ack(boardsFor(id, code));
  });

  socket.on('board:create', (payload, ack) => {
    const { code, id, role } = socket.data || {};
    if (!code || typeof ack !== 'function') return;
    const room = rooms.get(code);
    if (role === 'student' && room && !effectiveFeatures(room, id).newBoards) {
      return ack({ error: 'Creating new boards is turned off for you right now.' });
    }
    const meta = createBoard({ owner: id, room: code, title: (payload && payload.title) || `Board ${boardsFor(id, code).length + 1}` });
    ack({ ok: true, meta });
  });

  socket.on('board:load', (payload, ack) => {
    const { code, id, role } = socket.data || {};
    if (!code || typeof ack !== 'function') return;
    const meta = payload && boardsIndex.get(payload.boardId);
    if (!meta) return ack({ error: 'Board not found.' });
    const isRoomTeacher = role === 'teacher' && meta.room === code;
    // Admins may load a board only within their own domain — same rule the REST
    // path enforces via canViewBoard. The old bare manage_boards check let any
    // board admin read any board in any school given its id.
    const canView = meta.owner === id || isRoomTeacher || (AUTH_ENABLED && socketUser(socket) && canViewBoard(socketUser(socket), meta));
    if (!canView) return ack({ error: 'You do not have access to this board.' });
    // Reconnect guard: if the client already holds this exact revision, skip the
    // (potentially multi-MB) transfer. Stops a class-wide wifi blip from turning
    // into 30 simultaneous full-board pulls.
    if (payload.haveRev && payload.haveRev === meta.updatedAt) return ack({ ok: true, unchanged: true, meta });
    ack({ ok: true, meta, json: readBoardJSON(meta.id) });
  });

  socket.on('board:rename', (payload, ack) => {
    const meta = myRoomBoard(payload);
    if (!meta) return typeof ack === 'function' && ack({ error: 'Board not found.' });
    updateBoard(meta.id, { title: payload.title });
    if (typeof ack === 'function') ack({ ok: true, meta: boardsIndex.get(meta.id) });
  });

  socket.on('board:delete', (payload, ack) => {
    const meta = myRoomBoard(payload);
    if (!meta) return typeof ack === 'function' && ack({ error: 'Board not found.' });
    deleteBoard(meta.id);
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('board:duplicate', (payload, ack) => {
    const meta = myRoomBoard(payload);
    if (!meta) return typeof ack === 'function' && ack({ error: 'Board not found.' });
    const { code, id, role } = socket.data || {};
    const room = rooms.get(code);
    if (role === 'student' && room && !effectiveFeatures(room, id).newBoards) {
      return typeof ack === 'function' && ack({ error: 'Creating new boards is turned off for you right now.' });
    }
    const copy = createBoard({ owner: meta.owner, room: meta.room, title: meta.title + ' (copy)', json: readBoardJSON(meta.id), thumb: meta.thumb });
    if (typeof ack === 'function') ack({ ok: true, meta: copy });
  });

  socket.on('board:transfer', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const meta = myRoomBoard(payload);
    if (!meta) return ack({ error: 'Board not found.' });
    const targetRoom = payload.room ? sanitizeCode(payload.room) : null;
    if (targetRoom === null && !AUTH_ENABLED) return ack({ error: 'Personal boards require sign-in.' });
    const isAdmin = AUTH_ENABLED && socket.data.user && hasPerm(socket.data.user.email, 'manage_boards');
    if (targetRoom && !canUseRoom(meta.owner, targetRoom, isAdmin)) {
      return ack({ error: targetRoom === meta.room ? 'The board is already in that class.' : 'You are not part of that class (check the code).' });
    }
    if (payload.mode === 'move') {
      updateBoard(meta.id, { room: targetRoom });
      return ack({ ok: true, meta: boardsIndex.get(meta.id), moved: true });
    }
    const copy = createBoard({
      owner: meta.owner, room: targetRoom,
      title: meta.title + (targetRoom === meta.room ? ' (copy)' : ''),
      json: readBoardJSON(meta.id), thumb: meta.thumb,
    });
    ack({ ok: true, meta: copy, moved: false });
  });

  socket.on('board:history', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const meta = payload && boardsIndex.get(payload.boardId);
    if (!canTouchBoardSocket(socket, meta)) return ack({ error: 'Not allowed.' });
    ack({ ok: true, versions: histList(meta.id) });
  });

  socket.on('board:restore', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const meta = payload && boardsIndex.get(payload.boardId);
    if (!canTouchBoardSocket(socket, meta)) return ack({ error: 'Not allowed.' });
    const json = histRestore(meta.id, Number(payload.ts));
    if (!json) return ack({ error: 'That version no longer exists.' });
    for (const s of io.of('/').sockets.values()) {
      if (s.id !== socket.id && s.data && s.data.code === meta.room && (s.data.id === meta.owner || s.data.role === 'teacher')) {
        s.emit('board:peer', { boardId: meta.id, json, by: socket.data.name, note: 'Board restored to an earlier version' });
      }
    }
    ack({ ok: true, json });
  });

  socket.on('student:boards', (payload, ack) => {
    const { code, role } = socket.data || {};
    if (!code || role !== 'teacher' || typeof ack !== 'function') return;
    ack(boardsFor(String(payload && payload.student || ''), code));
  });

  // The class "stage": room.sharing is false, 'teacher', or a spotlighted student id
  socket.on('share:start', (payload, ack) => {
    const room = teacherRoom(socket);
    if (!room) return;
    room.sharing = 'teacher';
    socket.to(room.code).emit('share:start', { json: room.lastTeacherJson, by: 'Your teacher' });
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('spotlight:start', (payload, ack) => {
    const done = typeof ack === 'function' ? ack : () => {};
    const room = teacherRoom(socket);
    const sid = payload && String(payload.student || '');
    if (!room || !sid) return done({ error: 'Not allowed.' });
    room.sharing = sid;
    const json = stageJson(room);
    const by = stageBy(room);
    for (const [stuId, sockId] of room.students) {
      if (stuId === sid) io.to(sockId).emit('spotlight:you');
      else io.to(sockId).emit('share:start', { json, by });
    }
    done({ ok: true, by });
  });

  socket.on('share:stop', () => {
    const room = teacherRoom(socket);
    if (!room) return;
    room.sharing = false;
    socket.to(room.code).emit('share:stop');
  });

  // Pushing content now creates a NEW board for each target student
  socket.on('template:push', (payload, ack) => {
    const done = typeof ack === 'function' ? ack : () => {};
    const room = teacherRoom(socket);
    const json = payload && payload.json;
    if (!room || !json) return done({ error: 'Not allowed.' });
    // A push target must be an actual member of this class — never an arbitrary
    // string (which would mint a board owned by a non-member, or pollute a map).
    const members = new Set([...(room.data.roster || []), ...room.students.keys()]);
    const targets = payload.target
      ? (members.has(payload.target) ? [payload.target] : [])
      : [...members].filter((sid) => sid !== socket.data.id && sid !== room.data.owner);
    if (!targets.length) return done({ error: 'No matching students in this class.' });
    const title = String(payload.title || `From ${socket.data.name}`).slice(0, 60);
    for (const sid of targets) {
      const meta = createBoard({ owner: sid, room: room.code, title, json });
      emitToStudent(room.code, sid, 'board:new', { meta, by: socket.data.name });
    }
    done({ ok: true, count: targets.length });
  });

  // ----- assignments -----

  // Teacher assigns the given board content to every student as their own graded board
  socket.on('assignment:create', (payload, ack) => {
    const done = typeof ack === 'function' ? ack : () => {};
    const room = teacherRoom(socket);
    const json = payload && payload.json;
    if (!room || !json) return done({ error: 'Not allowed.' });
    const title = String(payload.title || 'Assignment').trim().slice(0, 80) || 'Assignment';
    const instructions = String(payload.instructions || '').slice(0, 2000);
    const dueAt = Number(payload.dueAt) || null;
    const roster = [...new Set([...(room.data.roster || []), ...room.students.keys()])]
      .filter((sid) => sid !== room.data.owner);
    if (!roster.length) return done({ error: 'Add students to the class first.' });
    const id = crypto.randomBytes(8).toString('hex');
    const a = {
      id, room: room.code, title, instructions, dueAt,
      createdBy: socket.data.id, createdByName: socket.data.name, createdAt: Date.now(), submissions: {},
    };
    for (const sid of roster) {
      const board = createBoard({ owner: sid, room: room.code, title, json, assignment: id });
      a.submissions[sid] = { boardId: board.id, status: 'assigned', grade: null, feedback: '', turnedInAt: null, returnedAt: null };
      emitToStudent(room.code, sid, 'board:new', { meta: board, by: socket.data.name });
      emitToStudent(room.code, sid, 'assignment:new', assignmentView(a, { forStudent: sid, room }));
    }
    assignments.set(id, a);
    saveAssignment(a);
    done({ ok: true, assignment: assignmentView(a, { room }), count: roster.length });
  });

  // List assignments for the joined room (teacher: full roster; student: their own rows)
  socket.on('assignment:list', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const { code, id, role } = socket.data || {};
    if (!code) return ack({ error: 'Not in a room.' });
    const room = rooms.get(code);
    const mine = [...assignments.values()].filter((a) => a.room === code).sort((x, y) => y.createdAt - x.createdAt);
    if (role === 'teacher') return ack({ ok: true, assignments: mine.map((a) => assignmentView(a, { room })) });
    ack({ ok: true, assignments: mine.filter((a) => a.submissions[id]).map((a) => assignmentView(a, { forStudent: id, room })) });
  });

  // Student turns in their submission
  socket.on('assignment:turnin', (payload, ack) => {
    const done = typeof ack === 'function' ? ack : () => {};
    const { code, id, name } = socket.data || {};
    const a = payload && assignments.get(payload.assignmentId);
    if (!a || a.room !== code) return done({ error: 'Assignment not found.' });
    const sub = a.submissions[id];
    if (!sub) return done({ error: 'This assignment is not yours.' });
    if (sub.status === 'returned') return done({ error: 'It has already been graded.' });
    sub.status = 'turnedin';
    sub.turnedInAt = Date.now();
    saveAssignment(a);
    const room = rooms.get(code);
    if (room) emitToTeacher(room, 'assignment:submitted', { assignmentId: a.id, student: id, name, at: sub.turnedInAt });
    done({ ok: true });
  });

  // Teacher returns a submission with an optional grade and feedback
  socket.on('assignment:return', (payload, ack) => {
    const done = typeof ack === 'function' ? ack : () => {};
    const room = teacherRoom(socket);
    const a = payload && assignments.get(payload.assignmentId);
    if (!room || !a || a.room !== room.code) return done({ error: 'Not allowed.' });
    const student = String(payload.student || '');
    // isSafeKey blocks '__proto__' etc. from resolving to Object.prototype and
    // sneaking past the `!sub` guard below.
    if (!isSafeKey(student) || !Object.prototype.hasOwnProperty.call(a.submissions, student)) {
      return done({ error: 'No such submission.' });
    }
    const sub = a.submissions[student];
    sub.grade = payload.grade != null && String(payload.grade).trim() !== '' ? String(payload.grade).slice(0, 20) : null;
    sub.feedback = String(payload.feedback || '').slice(0, 2000);
    sub.status = 'returned';
    sub.returnedAt = Date.now();
    saveAssignment(a);
    // Reach every tab the student has open, not just their newest socket.
    emitToStudent(room.code, student, 'assignment:returned', assignmentView(a, { forStudent: student, room }));
    done({ ok: true });
  });

  // Teacher sends selected objects onto students' current boards
  socket.on('objects:push', (payload, ack) => {
    const done = typeof ack === 'function' ? ack : () => {};
    const room = teacherRoom(socket);
    const objects = payload && Array.isArray(payload.objects) ? payload.objects.slice(0, 200) : null;
    if (!room || !objects || !objects.length) return done({ error: 'Nothing to send.' });
    const members = new Set([...(room.data.roster || []), ...room.students.keys()]);
    const targets = (Array.isArray(payload.targets) && payload.targets.length
      ? payload.targets.map(String).filter((sid) => members.has(sid)) // only real class members
      : [...members])
      .filter((sid) => sid !== socket.data.id && sid !== room.data.owner);
    for (const sid of targets) {
      let meta = boardsFor(sid, room.code)[0];
      if (!meta) meta = createBoard({ owner: sid, room: room.code, title: 'Board 1' });
      const json = readBoardJSON(meta.id) || { version: '5.3.0', objects: [] };
      json.objects = [...(json.objects || []), ...objects];
      updateBoard(meta.id, { json });
      emitToStudent(room.code, sid, 'board:peer', { boardId: meta.id, json, by: socket.data.name, note: `${socket.data.name} added items to your board` });
      if (room.teacher && room.teacher !== socket.id) {
        io.to(room.teacher).emit('student:board', { id: sid, name: room.data.names[sid] || sid, boardId: meta.id, json, thumb: meta.thumb });
      }
    }
    done({ ok: true, count: targets.length });
  });

  // Teacher copies any board in their room to their own set
  socket.on('board:copy-as', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const room = teacherRoom(socket);
    const meta = payload && boardsIndex.get(payload.boardId);
    if (!room || !meta || meta.room !== room.code) return ack({ error: 'Board not found.' });
    const ownerName = room.data.names[meta.owner] || meta.owner;
    const copy = createBoard({
      owner: socket.data.id, room: room.code,
      title: `${ownerName} — ${meta.title} (copy)`.slice(0, 60),
      json: readBoardJSON(meta.id), thumb: meta.thumb,
    });
    ack({ ok: true, meta: copy });
  });

  // ----- live polls -----

  socket.on('poll:start', (payload, ack) => {
    const done = typeof ack === 'function' ? ack : () => {};
    const room = teacherRoom(socket);
    if (!room) return done({ error: 'Only the room teacher can start a poll.' });
    const question = String((payload && payload.question) || '').trim().slice(0, 200);
    if (!question) return done({ error: 'Enter a question.' });
    const type = payload && payload.type === 'text' ? 'text' : 'choice';
    let options = [];
    if (type === 'choice') {
      options = (Array.isArray(payload.options) ? payload.options : [])
        .map((o) => String(o || '').trim().slice(0, 80)).filter(Boolean).slice(0, 8);
      if (options.length < 2) return done({ error: 'Add at least two options.' });
    }
    room.poll = { id: crypto.randomBytes(6).toString('hex'), question, type, options, responses: new Map(), open: true };
    socket.to(room.code).emit('poll:open', { id: room.poll.id, question, type, options });
    done({ ok: true, results: pollResults(room) });
  });

  socket.on('poll:respond', (payload, ack) => {
    const done = typeof ack === 'function' ? ack : () => {};
    const { code, id } = socket.data || {};
    const room = code && rooms.get(code);
    if (!room || !room.poll || !room.poll.open) return done({ error: 'No poll is open.' });
    const p = room.poll;
    if (!payload || payload.id !== p.id) return done({ error: 'This poll has changed.' });
    if (p.type === 'choice') {
      const i = Number(payload.value);
      if (!Number.isInteger(i) || i < 0 || i >= p.options.length) return done({ error: 'Invalid option.' });
      p.responses.set(id, i);
    } else {
      const v = String((payload && payload.value) || '').trim().slice(0, 280);
      if (!v) return done({ error: 'Enter a response.' });
      p.responses.set(id, v);
    }
    emitToTeacher(room, 'poll:results', pollResults(room));
    done({ ok: true });
  });

  socket.on('poll:end', (payload, ack) => {
    const done = typeof ack === 'function' ? ack : () => {};
    const room = teacherRoom(socket);
    if (!room || !room.poll) return done({ error: 'No active poll.' });
    room.poll.open = false;
    socket.to(room.code).emit('poll:close');
    done({ ok: true, results: pollResults(room) });
  });

  socket.on('poll:clear', () => {
    const room = teacherRoom(socket);
    if (!room) return;
    room.poll = null;
    socket.to(room.code).emit('poll:close');
  });

  socket.on('poll:get', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const { code, role } = socket.data || {};
    const room = code && rooms.get(code);
    if (!room) return ack(null);
    if (role === 'teacher') return ack(pollResults(room));
    const p = room.poll;
    ack(p && p.open ? { id: p.id, question: p.question, type: p.type, options: p.options } : null);
  });

  // ----- live-classroom: countdown timer, random picker, reactions -----

  socket.on('timer:start', (payload, ack) => {
    const room = teacherRoom(socket);
    if (!room) return typeof ack === 'function' && ack({ error: 'Not allowed.' });
    const seconds = Math.max(5, Math.min(3600, Math.round(Number(payload && payload.seconds) || 0)));
    room.timer = { endsAt: Date.now() + seconds * 1000, seconds };
    io.to(room.code).emit('timer:start', room.timer);
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('timer:stop', () => {
    const room = teacherRoom(socket);
    if (!room) return;
    room.timer = null;
    io.to(room.code).emit('timer:stop');
  });

  socket.on('picker:pick', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const room = teacherRoom(socket);
    if (!room) return ack({ error: 'Not allowed.' });
    // pool = enrolled students, preferring those online; teacher & owner excluded
    const online = [...room.students.keys()].filter((id) => id !== room.data.owner);
    const roster = (room.data.roster || []).filter((id) => id !== room.data.owner);
    const pool = online.length ? online : roster;
    if (!pool.length) return ack({ error: 'No students to pick from.' });
    const id = pool[Math.floor(Math.random() * pool.length)];
    const picked = { id, name: room.data.names[id] || displayNameOf(id) };
    socket.to(room.code).emit('picker:result', picked); // teacher animates locally from the ack
    ack({ ok: true, picked });
  });

  socket.on('reaction:send', (payload) => {
    const { code, id, name, role } = socket.data || {};
    const room = code && rooms.get(code);
    if (!room) return;
    const allowed = ['👍', '👏', '❤️', '😂', '🎉', '🤔', '😮', '✅', '❓', '🙋'];
    const emoji = payload && String(payload.emoji || '');
    if (!allowed.includes(emoji)) return;
    // fan out to everyone else (the sender already floated it locally)
    socket.to(code).emit('reaction', { emoji, name, from: id });
    void role;
  });

  // ----- messaging (teacher <-> students, plus teacher broadcast) -----

  socket.on('msg:send', (payload, ack) => {
    const done = typeof ack === 'function' ? ack : () => {};
    const { code, id, name, role } = socket.data || {};
    const room = code && rooms.get(code);
    const text = payload && String(payload.text || '').trim().slice(0, 1000);
    if (!room || !text) return done({ error: 'Nothing to send.' });
    // students always message the teacher; teachers message one student or broadcast (to=null)
    const to = role === 'student' ? '__teacher__' : (payload.to ? String(payload.to) : null);
    const msg = {
      id: crypto.randomBytes(6).toString('hex'),
      from: id, fromName: name, fromRole: role, to, text, ts: Date.now(),
    };
    room.data.messages = room.data.messages || [];
    room.data.messages.push(msg);
    if (room.data.messages.length > 400) room.data.messages = room.data.messages.slice(-400);
    scheduleSave(room);
    for (const s of roomSockets(code)) {
      if (s.id === socket.id || !s.data) continue;
      if (s.data.role === 'teacher' || canSeeMessage(s.data, msg)) s.emit('msg:new', msg);
    }
    done({ ok: true, msg });
  });

  socket.on('msg:history', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const { code } = socket.data || {};
    const room = code && rooms.get(code);
    if (!room) return ack([]);
    ack((room.data.messages || []).filter((m) => canSeeMessage(socket.data, m)).slice(-200));
  });

  // ----- comments anchored to board objects -----

  socket.on('comment:add', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const meta = payload && boardsIndex.get(payload.boardId);
    if (!canTouchBoardSocket(socket, meta)) return ack({ error: 'Not allowed.' });
    const text = String(payload.text || '').trim().slice(0, 500);
    const oid = String(payload.oid || '').slice(0, 40);
    if (!text || !oid) return ack({ error: 'Empty comment.' });
    meta.comments = meta.comments || [];
    meta.comments.push({
      id: crypto.randomBytes(6).toString('hex'),
      oid, author: socket.data.name, authorId: socket.data.id, text, ts: Date.now(),
    });
    if (meta.comments.length > 200) meta.comments = meta.comments.slice(-200);
    flushBoardSoon(meta.id);
    broadcastComments(socket, meta);
    ack({ ok: true, comments: meta.comments });
  });

  socket.on('comment:remove', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const meta = payload && boardsIndex.get(payload.boardId);
    if (!canTouchBoardSocket(socket, meta)) return ack({ error: 'Not allowed.' });
    const { id, role } = socket.data;
    meta.comments = (meta.comments || []).filter((c) => !(c.id === payload.commentId && (c.authorId === id || role === 'teacher')));
    flushBoardSoon(meta.id);
    broadcastComments(socket, meta);
    ack({ ok: true, comments: meta.comments });
  });

  socket.on('comment:list', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const meta = payload && boardsIndex.get(payload.boardId);
    if (!canTouchBoardSocket(socket, meta)) return ack({ error: 'Not allowed.' });
    ack({ ok: true, comments: meta.comments || [] });
  });

  // ----- join code management (teacher) -----

  socket.on('code:reset', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const room = teacherRoom(socket);
    if (!room) return ack({ error: 'Only the room teacher can change the join code.' });
    room.data.joinCode = generateJoinCode();
    room.data.joinDisabled = false;
    scheduleSave(room);
    ack({ ok: true, joinCode: room.data.joinCode, joinDisabled: false });
  });

  socket.on('code:toggle', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const room = teacherRoom(socket);
    if (!room) return ack({ error: 'Only the room teacher can change the join code.' });
    room.data.joinDisabled = !!(payload && payload.disabled);
    scheduleSave(room);
    ack({ ok: true, joinCode: room.data.joinCode, joinDisabled: room.data.joinDisabled });
  });

  // Teacher toggles feature switches for the whole room or one student
  socket.on('features:set', (payload, ack) => {
    const done = typeof ack === 'function' ? ack : () => {};
    const room = teacherRoom(socket);
    if (!room) return done({ error: 'Only the room teacher can change features.' });
    const patch = payload && payload.features;
    if (payload && payload.scope === 'student') {
      const sid = String(payload.student || '');
      if (!sid || !isSafeKey(sid)) return done({ error: 'Missing student.' });
      room.data.studentFeatures[sid] = room.data.studentFeatures[sid] || {};
      applyFeaturePatch(room.data.studentFeatures[sid], patch);
      if (!Object.keys(room.data.studentFeatures[sid]).length) delete room.data.studentFeatures[sid];
      pushFeatures(room, sid);
    } else {
      applyFeaturePatch(room.data.features, patch);
      for (const sid of room.students.keys()) pushFeatures(room, sid);
    }
    room.data.updatedAt = Date.now();
    scheduleSave(room);
    done({ ok: true, roomFeatures: room.data.features, studentFeatures: room.data.studentFeatures });
  });

  socket.on('disconnect', () => {
    const { code, id, role } = socket.data || {};
    const room = code && rooms.get(code);
    if (!room) return;
    socket.to(code).emit('cursor:gone', { from: id }); // clear my presence dot for everyone
    if (role === 'teacher') {
      if (room.teacher === socket.id) {
        room.teacher = null;
        if (room.sharing) {
          room.sharing = false;
          io.to(room.code).emit('share:stop');
        }
      }
    } else if (room.students.get(id) === socket.id) {
      // Only mark the student gone when their LAST tab closes. If another tab
      // is still open, hand the primary slot to it instead of emitting 'left'
      // (which previously flipped them offline and broke targeted delivery).
      const survivor = studentHasSocket(code, id, socket.id);
      if (survivor) {
        room.students.set(id, survivor);
      } else {
        room.students.delete(id);
        emitToTeacher(room, 'student:left', { id });
      }
    }
  });
});

// ---------- backups: daily local rotation + on-demand super-admin download ----------

const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_KEEP = 3;                          // rotated copies to retain (was 7)
const DISK_MIN_FREE = 250 * 1024 * 1024;        // critical: reclaim/skip backups below this
const DISK_WARN_FREE = 700 * 1024 * 1024;       // warn well before it gets critical

// Available bytes on the data volume, or Infinity if it can't be determined.
function freeSpaceBytes() {
  try {
    const s = fs.statfsSync(DATA_DIR);
    return s.bavail * s.bsize;
  } catch {
    return Infinity;
  }
}

// Delete rotated backups down to `keep`, plus any leftover .tmp files. Backups
// are regenerable disaster-recovery tars (of all boards, PDFs included), so
// they're the first thing to drop when the volume gets tight — never the live
// board files.
function pruneBackups(keep) {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return;
    const files = fs.readdirSync(BACKUP_DIR);
    for (const f of files) {
      if (f.endsWith('.tmp')) { try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch { /* ignore */ } }
    }
    const all = files.filter((f) => f.startsWith('backup-') && f.endsWith('.tar.gz')).sort();
    while (all.length > keep) { try { fs.unlinkSync(path.join(BACKUP_DIR, all.shift())); } catch { /* ignore */ } }
  } catch (e) {
    console.error('Backup prune failed:', e.message);
  }
}

// Last-known free space, exposed to the admin dashboard so a full volume is
// visible before it becomes an outage.
let diskFreeBytes = freeSpaceBytes();

// Periodic watch: warn loudly well before the volume is critical, and reclaim
// backup space automatically if it gets dangerous.
function checkDisk() {
  diskFreeBytes = freeSpaceBytes();
  if (diskFreeBytes < DISK_WARN_FREE) {
    console.warn(`⚠ Data volume low: ${Math.round(diskFreeBytes / 1e6)}MB free. Enlarge the volume or offload backups.`);
    if (diskFreeBytes < DISK_MIN_FREE) pruneBackups(1);
  }
}
setTimeout(checkDisk, 30 * 1000);
setInterval(checkDisk, 60 * 60 * 1000); // hourly

// On boot, reclaim space so a full volume can't crash-loop the server (an
// unhandled ENOSPC on the backup stream is exactly what took it down).
(function reclaimDiskOnBoot() {
  const free = freeSpaceBytes();
  if (free < DISK_MIN_FREE) {
    console.warn(`Low disk: ${Math.round(free / 1e6)}MB free — clearing all backups to recover.`);
    pruneBackups(0);
  } else {
    pruneBackups(BACKUP_KEEP);
  }
})();

function runBackup() {
  try {
    if (freeSpaceBytes() < DISK_MIN_FREE) {
      console.warn('Skipping backup — low disk space; pruning old copies instead.');
      pruneBackups(1);
      return;
    }
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const name = `backup-${new Date().toISOString().slice(0, 10)}.tar.gz`;
    const tmp = path.join(BACKUP_DIR, name + '.tmp');
    const out = fs.createWriteStream(tmp);
    const tar = spawn('tar', ['-czf', '-', '--exclude=./backups', '-C', DATA_DIR, '.']);
    // A write error (e.g. the volume filling mid-backup) must NOT crash the
    // process — handle it, drop the partial file, and stop the tar.
    out.on('error', (e) => {
      console.error('Backup write failed:', e.message);
      try { tar.kill(); } catch { /* ignore */ }
      fs.unlink(tmp, () => {});
      if (e.code === 'ENOSPC') pruneBackups(0); // reclaim so the app keeps saving boards
    });
    tar.stdout.pipe(out);
    tar.on('close', (code) => {
      if (code === 0) {
        try {
          const finalPath = path.join(BACKUP_DIR, name);
          fs.renameSync(tmp, finalPath);
          if (offsite.enabled()) {
            // Off-site: push it away, prune the off-site history, and keep
            // just ONE local copy so backups can never fill the volume again.
            // If the upload fails, keep the full local set instead — a failed
            // mirror must never leave FEWER copies than having no mirror.
            offsite.upload(finalPath, name)
              .then(() => offsite.prune(OFFSITE_KEEP))
              .then(() => { pruneBackups(1); console.log('Backup mirrored off-site:', name); })
              .catch((e) => { console.error('Off-site backup failed (kept local copies):', e.message); pruneBackups(BACKUP_KEEP); });
          } else {
            pruneBackups(BACKUP_KEEP);
            console.log('Backup written:', name);
          }
        } catch (e) { console.error('Backup finalize failed:', e.message); fs.unlink(tmp, () => {}); }
      } else {
        fs.unlink(tmp, () => {});
        console.error('Backup failed, tar exit code', code);
      }
    });
    tar.on('error', (e) => console.error('Backup failed:', e.message));
  } catch (e) {
    console.error('Backup failed:', e.message);
  }
}
setTimeout(runBackup, 60 * 1000);
setInterval(runBackup, 24 * 60 * 60 * 1000);

// ---------- optional off-site backups ----------
// Set R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY to
// mirror every daily backup off the Railway volume to Cloudflare R2. Unset =
// local-only backups, exactly as before. See offsite.js for why it is a
// bucket-scoped key and not a Google account.
const offsite = require('./offsite');
const OFFSITE_KEEP = Number(process.env.R2_KEEP) || 30;   // daily copies to retain off-site
if (offsite.enabled()) console.log('Off-site backups:', offsite.describe());

// Build the board & template indexes and seed starter templates at startup
loadBoardsIndex();
reindexEmbeds();
loadTemplatesIndex();
loadAssignments();
seedTemplates();
for (const f of fs.readdirSync(DATA_DIR)) {
  const m = /^room-(.+)\.json$/.exec(f);
  if (m) getRoom(sanitizeCode(m[1]), false);
}

server.listen(PORT, () => {
  console.log(`Signify Learning running on port ${PORT}`);
  console.log(`  Boards: ${boardsIndex.size}`);
  console.log(`  Sign-in: ${AUTH_ENABLED
    ? 'Signify ID (' + process.env.SIGNIFY_ISSUER + ')'
    : 'NOT configured — set SIGNIFY_ISSUER, SIGNIFY_CLIENT_ID, SIGNIFY_CLIENT_SECRET, SIGNIFY_REDIRECT_URI'}`);
  if (AUTH_ENABLED) {
    const known = Object.values(store.users).filter((u) => !u.releasedAt);
    const linked = known.filter((u) => u.uid).length;
    console.log(`  Accounts: ${linked}/${known.length} linked to Signify ID`);
    const waiting = known.filter((u) => !u.uid).length;
    if (waiting) console.log(`  ${waiting} will link on their next sign-in`);
  }
});
