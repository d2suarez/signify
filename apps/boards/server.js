const express = require('express');
const compression = require('compression');
const zlib = require('zlib');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { OAuth2Client } = require('google-auth-library');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- auth config ----------
// Set GOOGLE_CLIENT_ID to require Google sign-in. Without it the app runs
// open (name-only), which is fine for local/classroom-network use.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const AUTH_ENABLED = !!GOOGLE_CLIENT_ID;
const SUPER_ADMINS = (process.env.SUPER_ADMINS || 'desmond@signify.one')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_HOURS = 12;
const oauthClient = AUTH_ENABLED ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// ---------- permissions & roles ----------

const PERMISSIONS = ['teach', 'manage_users', 'manage_boards', 'view_sessions', 'manage_domains'];

// ---------- feature switches ----------
// Features can be turned on/off per school domain (admin), per room (teacher),
// or per student in a room (teacher). Most specific setting wins; default is on.

const FEATURES = ['draw', 'text', 'images', 'documents', 'charts', 'newBoards', 'download'];

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

function isSuperAdmin(email) {
  return SUPER_ADMINS.includes(email);
}

function effectiveRole(email) {
  if (isSuperAdmin(email)) return 'superadmin';
  const role = (store.users[email] && store.users[email].role) || 'student';
  return store.roles[role] ? role : 'student';
}

function permsFor(email) {
  if (isSuperAdmin(email)) return [...PERMISSIONS];
  return store.roles[effectiveRole(email)].perms;
}

function hasPerm(email, perm) {
  return isSuperAdmin(email) || permsFor(email).includes(perm);
}

// Any permission beyond teaching makes an account "admin-like"
function adminPerms(perms) {
  return perms.some((p) => p !== 'teach');
}

function domainOf(email) {
  return email.split('@')[1] || '';
}

function domainApproved(email) {
  return store.domains.includes(domainOf(email));
}

function accessStatus(email) {
  if (isSuperAdmin(email)) return 'approved';
  const rec = store.users[email];
  if (rec && rec.status === 'suspended') {
    // Timed suspensions lift themselves once the deadline passes
    if (rec.suspendUntil && rec.suspendUntil <= Date.now()) {
      rec.status = 'approved';
      delete rec.suspendUntil;
      saveStore();
      return 'approved';
    }
    return 'suspended';
  }
  if (rec && rec.status === 'blocked') return 'blocked';
  if (rec && rec.status === 'approved') return 'approved';
  return domainApproved(email) ? 'approved' : 'pending';
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

function signSession(user) {
  const body = Buffer.from(JSON.stringify(user)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifySession(token) {
  try {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return null;
    const expect = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const user = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!user.exp || user.exp < Date.now()) return null;
    return user;
  } catch {
    return null;
  }
}

// ---------- http ----------

const app = express();
const server = http.createServer(app);
// perMessageDeflate: board JSON is highly compressible text — this is the
// single biggest egress (cost) saver for live drawing sync
const io = new Server(server, {
  maxHttpBufferSize: 30 * 1024 * 1024,
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

app.use(compression()); // gzip responses — cuts static + API egress ~3-5x
// vendored libraries change rarely: let browsers cache them for a week
app.use('/vendor', express.static(path.join(__dirname, 'public', 'vendor'), { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

app.get('/api/config', (req, res) => {
  res.json({ authEnabled: AUTH_ENABLED, clientId: GOOGLE_CLIENT_ID });
});

app.post('/api/auth/google', async (req, res) => {
  if (!AUTH_ENABLED) return res.status(400).json({ error: 'Google sign-in is not enabled on this server.' });
  try {
    const ticket = await oauthClient.verifyIdToken({
      idToken: req.body.credential,
      audience: GOOGLE_CLIENT_ID,
    });
    const p = ticket.getPayload();
    const email = (p.email || '').toLowerCase();
    if (!p.email_verified) return res.status(403).json({ error: 'This Google account has no verified email.' });

    // Every real sign-in gets a user record so admins can see and approve it
    const now = Date.now();
    let rec = store.users[email];
    if (!rec) {
      rec = store.users[email] = { name: p.name || email, role: 'student', status: 'pending', firstSeen: now, lastSeen: now, addedBy: null };
    }
    rec.name = p.name || rec.name;
    rec.lastSeen = now;
    const status = accessStatus(email);
    if (rec.status === 'pending' && status === 'approved') rec.status = 'approved';
    saveStore();

    if (status === 'blocked') return res.status(403).json({ error: 'Your access has been disabled by an administrator.' });
    if (status === 'suspended') {
      const until = store.users[email] && store.users[email].suspendUntil;
      return res.status(403).json({ error: until ? `Your account is suspended until ${new Date(until).toLocaleString()}.` : 'Your account is suspended. Please contact your teacher or administrator.' });
    }
    if (status === 'pending') return res.status(403).json({ error: 'Your account is waiting for administrator approval. Ask your teacher or admin to approve it.' });

    const role = effectiveRole(email);
    const user = { email, name: rec.name, role, exp: now + SESSION_HOURS * 3600 * 1000 };
    res.json({
      token: signSession(user),
      email,
      name: rec.name,
      role,
      perms: permsFor(email),
      isSuper: isSuperAdmin(email),
      exp: user.exp,
    });
  } catch (e) {
    res.status(401).json({ error: 'Google sign-in could not be verified. Please try again.' });
  }
});

function sessionFromReq(req) {
  return verifySession((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
}

// Full room listing is for board admins; teachers use /api/my/rooms
app.get('/api/rooms', (req, res) => {
  if (AUTH_ENABLED) {
    const user = sessionFromReq(req);
    if (!user || accessStatus(user.email) !== 'approved' || !hasPerm(user.email, 'manage_boards')) {
      return res.status(401).json([]);
    }
  }
  res.json(listRooms());
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
    hasBoard: !!room.data.boards[email],
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

app.get('/api/admin/state', (req, res) => {
  const admin = requireAuthed(req, res);
  if (!admin) return;
  const canUsers = admin.isSuper || admin.perms.includes('manage_users');
  const canBoards = admin.isSuper || admin.perms.includes('manage_boards');
  const canSessions = admin.isSuper || admin.perms.includes('view_sessions');
  const canDomains = admin.isSuper || admin.perms.includes('manage_domains');

  let users = [];
  if (canUsers) {
    users = Object.entries(store.users).map(([email, r]) => userView(email, r));
    for (const email of SUPER_ADMINS) {
      if (!store.users[email]) users.push(userView(email, null));
    }
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
  const msg = String(req.body && req.body.message || '').slice(0, 300);
  const where = String(req.body && req.body.where || '').slice(0, 120);
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

// Move students up one grade — everyone in scope, or just the selected emails
app.post('/api/admin/users/promote', (req, res) => {
  const admin = requirePerm(req, res, 'manage_users');
  if (!admin) return;
  const only = Array.isArray(req.body.emails) && req.body.emails.length
    ? new Set(req.body.emails.map((e) => String(e).trim().toLowerCase()))
    : null;
  let promoted = 0; let graduated = 0; let noGrade = 0;
  for (const [email, rec] of Object.entries(store.users)) {
    if (only && !only.has(email)) continue;
    if (isSuperAdmin(email) || !canManageTarget(admin, email)) continue;
    if (effectiveRole(email) !== 'student') continue; // only students advance
    if (!rec.grade) { noGrade++; continue; }
    const next = nextGrade(rec.grade);
    if (!next) continue; // already Graduated
    rec.grade = next;
    promoted++;
    if (next === 'Graduated') graduated++;
  }
  if (promoted) {
    appendAudit(admin.email, 'user:promote', `${promoted} student${promoted === 1 ? '' : 's'} advanced${graduated ? `, ${graduated} graduated` : ''}`);
    saveStore();
  }
  res.json({ ok: true, promoted, graduated, noGrade });
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

function boardFile(id) {
  return path.join(DATA_DIR, `board-${id}.json`);
}

function boardMetaOf(d) {
  return {
    id: d.id, title: d.title || 'Board', owner: d.owner, room: d.room || null,
    createdAt: d.createdAt || 0, updatedAt: d.updatedAt || 0, thumb: d.thumb || null,
    comments: d.comments || [],
  };
}

function loadBoardsIndex() {
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (!/^board-[a-f0-9]{16}\.json$/.test(f)) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
      if (d.id) boardsIndex.set(d.id, boardMetaOf(d));
    } catch (e) {
      console.error('Could not read board file', f, e.message);
    }
  }
}

function flushBoardSoon(id) {
  if (boardTimers.has(id)) return;
  boardTimers.set(id, setTimeout(() => {
    boardTimers.delete(id);
    const meta = boardsIndex.get(id);
    if (!meta) return;
    let json = boardPending.get(id);
    if (json === undefined) json = readBoardJSON(id); // meta-only change (e.g. rename)
    boardPending.delete(id);
    fs.writeFile(boardFile(id), JSON.stringify({ ...meta, json: json || null }), (err) => {
      if (err) console.error('Board save failed', id, err.message);
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

function maybeSnapshot(id, json, force) {
  try {
    if (!json) return;
    const str = JSON.stringify(json);
    if (str.length > HIST_SKIP_BYTES) return;
    const files = histFiles(id);
    const lastTs = files.length ? histTs(files[files.length - 1]) : 0;
    if (!force && Date.now() - lastTs < HIST_MIN_MS) return;
    fs.writeFileSync(path.join(DATA_DIR, `hist-${id}-${Date.now()}.json.gz`), zlib.gzipSync(str));
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
  const json = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString());
  // snapshot the current state first so a restore is itself undoable
  maybeSnapshot(id, readBoardJSON(id), true);
  updateBoard(id, { json });
  return json;
}

function deleteHistory(id) {
  for (const f of histFiles(id)) fs.unlinkSync(path.join(DATA_DIR, f));
}

function createBoard({ owner, room, title, json, thumb }) {
  const id = crypto.randomBytes(8).toString('hex');
  const now = Date.now();
  const meta = { id, title: (title || 'Board').slice(0, 60), owner, room: room || null, createdAt: now, updatedAt: now, thumb: thumb || null, comments: [] };
  boardsIndex.set(id, meta);
  boardPending.set(id, json || null);
  flushBoardSoon(id);
  return meta;
}

// Accept only genuine image data URLs of a sane size as thumbnails
function validThumb(t) {
  return typeof t === 'string' && /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(t) && t.length <= 400000;
}

function updateBoard(id, { json, thumb, title, room }) {
  const meta = boardsIndex.get(id);
  if (!meta) return null;
  if (json !== undefined) boardPending.set(id, json);
  if (thumb !== undefined && validThumb(thumb)) meta.thumb = thumb;
  if (title !== undefined) meta.title = String(title).trim().slice(0, 60) || meta.title;
  if (room !== undefined) meta.room = room;
  meta.updatedAt = Date.now();
  flushBoardSoon(id);
  return meta;
}

function readBoardJSON(id) {
  if (boardPending.has(id)) return boardPending.get(id);
  try {
    return JSON.parse(fs.readFileSync(boardFile(id), 'utf8')).json || null;
  } catch {
    return null;
  }
}

function deleteBoard(id) {
  boardsIndex.delete(id);
  boardPending.delete(id);
  clearTimeout(boardTimers.get(id));
  boardTimers.delete(id);
  fs.unlink(boardFile(id), () => {});
  try { deleteHistory(id); } catch { /* best effort */ }
}

function boardsFor(owner, room) {
  return [...boardsIndex.values()]
    .filter((b) => b.owner === owner && b.room === (room || null))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function roomBoards(room) {
  return [...boardsIndex.values()].filter((b) => b.room === room).sort((a, b) => b.updatedAt - a.updatedAt);
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

// Send a student their freshly-resolved feature switches
function pushFeatures(room, sid) {
  const sockId = room.students.get(sid);
  if (sockId) io.to(sockId).emit('features:update', { features: effectiveFeatures(room, sid) });
}

function teacherRoom(socket) {
  const { code, role } = socket.data || {};
  if (role !== 'teacher' || !code) return null;
  return rooms.get(code) || null;
}

// What's on the class stage right now (teacher's live board or a student's latest)
function stageJson(room) {
  if (room.sharing === 'teacher') return room.lastTeacherJson;
  if (room.sharing) {
    const latest = boardsFor(room.sharing, room.code)[0];
    return latest ? readBoardJSON(latest.id) : null;
  }
  return null;
}

function stageBy(room) {
  if (room.sharing === 'teacher') return 'Your teacher';
  return room.data.names[room.sharing] || displayNameOf(room.sharing);
}

// ---------- sockets ----------

io.use((socket, next) => {
  if (!AUTH_ENABLED) return next();
  const user = verifySession(socket.handshake.auth && socket.handshake.auth.token);
  if (!user) return next(new Error('unauthorized'));
  if (accessStatus(user.email) !== 'approved') return next(new Error('unauthorized'));
  socket.data.user = { email: user.email, name: user.name };
  next();
});

io.on('connection', (socket) => {
  socket.on('join', (payload, ack) => {
    if (typeof ack !== 'function') return;
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
        room.lastTeacherJson = activeJson;
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
          ok: true, name, boards: myBoards, activeBoard: { id: active.id, json: activeJson },
          students, sharing: room.sharing, shareBy: room.sharing ? stageBy(room) : null,
          roomFeatures: room.data.features, studentFeatures: room.data.studentFeatures,
          joinCode: room.data.joinCode, joinDisabled: !!room.data.joinDisabled,
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
          boards: myBoards,
          activeBoard: { id: active.id, json: activeJson },
          sharing: onStage ? room.sharing : false,
          teacherBoard: onStage ? stageJson(room) : null,
          shareBy: onStage ? stageBy(room) : null,
          features: effectiveFeatures(room, id),
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
    for (const s of io.of('/').sockets.values()) {
      if (s.id === socket.id || !s.data || s.data.code !== code) continue;
      if (s.data.id === meta.owner) {
        s.emit('board:peer', { boardId: meta.id, json, by: name, note: !isOwner ? `${name} is drawing on your board` : null });
      }
    }

    if (role === 'teacher' && isOwner) {
      room.lastTeacherJson = json;
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
    const json = applyOpsToJson(readBoardJSON(meta.id), ops);
    const safeThumb = payload.thumb && validThumb(payload.thumb) ? payload.thumb : undefined;
    updateBoard(meta.id, { json, thumb: safeThumb });

    // fan the ops out to everyone who cares (they're small)
    for (const s of io.of('/').sockets.values()) {
      if (s.id === socket.id || !s.data || s.data.code !== code) continue;
      if (s.data.id === meta.owner || s.data.role === 'teacher') {
        s.emit('board:ops', {
          boardId: meta.id, owner: meta.owner, ops, by: name,
          note: !isOwner && s.data.id === meta.owner ? `${name} is drawing on your board` : null,
        });
      }
    }
    if (safeThumb && meta.owner !== room.data.owner && room.teacher && room.teacher !== socket.id) {
      io.to(room.teacher).emit('student:thumb', { id: meta.owner, boardId: meta.id, thumb: safeThumb });
    }
    // stage streaming (teacher share or student spotlight) as ops too
    if (role === 'teacher' && isOwner) {
      room.lastTeacherJson = json;
      if (room.sharing === 'teacher') socket.to(code).emit('stage:ops', { ops });
    } else if (room.sharing && room.sharing === meta.owner) {
      socket.to(code).emit('stage:ops', { ops });
    }
    scheduleSave(room);
    if (typeof ack === 'function') ack({ ok: true });
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
    const room = rooms.get(code);
    const isRoomTeacher = role === 'teacher' && meta.room === code;
    const isAdmin = AUTH_ENABLED && socket.data.user && hasPerm(socket.data.user.email, 'manage_boards');
    if (meta.owner !== id && !isRoomTeacher && !isAdmin) return ack({ error: 'You do not have access to this board.' });
    void room;
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
    const targets = payload.target
      ? [payload.target]
      : [...new Set([...(room.data.roster || []), ...room.students.keys()])]
        .filter((sid) => sid !== socket.data.id && sid !== room.data.owner);
    const title = String(payload.title || `From ${socket.data.name}`).slice(0, 60);
    for (const sid of targets) {
      const meta = createBoard({ owner: sid, room: room.code, title, json });
      const sockId = room.students.get(sid);
      if (sockId) io.to(sockId).emit('board:new', { meta, by: socket.data.name });
    }
    done({ ok: true, count: targets.length });
  });

  // Teacher sends selected objects onto students' current boards
  socket.on('objects:push', (payload, ack) => {
    const done = typeof ack === 'function' ? ack : () => {};
    const room = teacherRoom(socket);
    const objects = payload && Array.isArray(payload.objects) ? payload.objects.slice(0, 200) : null;
    if (!room || !objects || !objects.length) return done({ error: 'Nothing to send.' });
    const targets = (Array.isArray(payload.targets) && payload.targets.length
      ? payload.targets.map(String)
      : [...new Set([...(room.data.roster || []), ...room.students.keys()])])
      .filter((sid) => sid !== socket.data.id && sid !== room.data.owner);
    for (const sid of targets) {
      let meta = boardsFor(sid, room.code)[0];
      if (!meta) meta = createBoard({ owner: sid, room: room.code, title: 'Board 1' });
      const json = readBoardJSON(meta.id) || { version: '5.3.0', objects: [] };
      json.objects = [...(json.objects || []), ...objects];
      updateBoard(meta.id, { json });
      for (const s of io.of('/').sockets.values()) {
        if (s.data && s.data.code === room.code && s.data.id === sid) {
          s.emit('board:peer', { boardId: meta.id, json, by: socket.data.name, note: `${socket.data.name} added items to your board` });
        }
      }
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
    for (const s of io.of('/').sockets.values()) {
      if (s.id === socket.id || !s.data || s.data.code !== code) continue;
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
      if (!sid) return done({ error: 'Missing student.' });
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
    if (role === 'teacher') {
      if (room.teacher === socket.id) {
        room.teacher = null;
        if (room.sharing) {
          room.sharing = false;
          io.to(room.code).emit('share:stop');
        }
      }
    } else if (room.students.get(id) === socket.id) {
      room.students.delete(id);
      emitToTeacher(room, 'student:left', { id });
    }
  });
});

// ---------- backups: daily local rotation + on-demand super-admin download ----------

const BACKUP_DIR = path.join(DATA_DIR, 'backups');

function runBackup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const name = `backup-${new Date().toISOString().slice(0, 10)}.tar.gz`;
    const tmp = path.join(BACKUP_DIR, name + '.tmp');
    const out = fs.createWriteStream(tmp);
    const tar = spawn('tar', ['-czf', '-', '--exclude=./backups', '-C', DATA_DIR, '.']);
    tar.stdout.pipe(out);
    tar.on('close', (code) => {
      if (code === 0) {
        fs.renameSync(tmp, path.join(BACKUP_DIR, name));
        const all = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('backup-') && f.endsWith('.tar.gz')).sort();
        while (all.length > 7) fs.unlinkSync(path.join(BACKUP_DIR, all.shift()));
        console.log('Backup written:', name);
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

// Build the board & template indexes and seed starter templates at startup
loadBoardsIndex();
loadTemplatesIndex();
seedTemplates();
for (const f of fs.readdirSync(DATA_DIR)) {
  const m = /^room-(.+)\.json$/.exec(f);
  if (m) getRoom(sanitizeCode(m[1]), false);
}

server.listen(PORT, () => {
  console.log(`Signify Learning running on port ${PORT}`);
  console.log(`  Boards: ${boardsIndex.size}`);
  console.log(`Google sign-in: ${AUTH_ENABLED ? 'ENABLED' : 'disabled (open mode)'}`);
  if (AUTH_ENABLED) {
    console.log(`  Super admins: ${SUPER_ADMINS.join(', ')}`);
    console.log(`  Approved domains: ${store.domains.join(', ') || '(none yet — approve them in the admin portal)'}`);
    console.log(`  Roles: ${Object.keys(store.roles).join(', ')}`);
    if (!process.env.SESSION_SECRET) console.log('  Note: set SESSION_SECRET so sign-ins survive server restarts.');
  }
});
