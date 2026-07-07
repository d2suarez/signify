const express = require('express');
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
const io = new Server(server, { maxHttpBufferSize: 30 * 1024 * 1024 });

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
  for (const r of roomSummaries()) {
    const item = { code: r.code, name: r.name, owner: r.owner, updatedAt: r.updatedAt, students: r.roster.length };
    if (r.owner === user.email) teaching.push(item);
    if (r.roster.includes(user.email)) enrolled.push(item);
  }
  res.json({ teaching, enrolled });
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
  room.data.updatedAt = Date.now();
  scheduleSave(room);
  res.json({ code: room.code, name: room.data.name, owner: room.data.owner });
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
    addedBy: (rec && rec.addedBy) || null,
    firstSeen: rec ? rec.firstSeen : null,
    lastSeen: rec ? rec.lastSeen : null,
  };
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

  res.json({
    me: admin,
    permissions: PERMISSIONS,
    roles,
    users,
    domains: canDomains ? store.domains : [],
    rooms: canBoards ? listRooms() : [],
    sessions,
  });
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
  if (status && !['approved', 'pending', 'blocked'].includes(status)) return res.status(400).json({ error: 'Unknown status.' });

  const now = Date.now();
  let rec = store.users[email];
  if (!rec) rec = store.users[email] = { name: email, role: 'student', status: 'approved', firstSeen: now, lastSeen: null, addedBy: admin.email };
  if (role) rec.role = role;
  if (status) {
    rec.status = status;
    if (status === 'blocked') kickUser(email);
  }
  saveStore();
  res.json(userView(email, rec));
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
  const boards = roomBoards(code).map((b) => ({
    ...b, ownerName: room.data.names[b.owner] || displayNameOf(b.owner), isTeacher: b.owner === room.data.owner,
  }));
  res.json({ code, name: room.data.name, owner: room.data.owner, boards });
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
  }, 800));
}

function createBoard({ owner, room, title, json, thumb }) {
  const id = crypto.randomBytes(8).toString('hex');
  const now = Date.now();
  const meta = { id, title: (title || 'Board').slice(0, 60), owner, room: room || null, createdAt: now, updatedAt: now, thumb: thumb || null };
  boardsIndex.set(id, meta);
  boardPending.set(id, json || null);
  flushBoardSoon(id);
  return meta;
}

function updateBoard(id, { json, thumb, title, room }) {
  const meta = boardsIndex.get(id);
  if (!meta) return null;
  if (json !== undefined) boardPending.set(id, json);
  if (thumb !== undefined) meta.thumb = thumb;
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

// Board access: the owner, an admin, or the teacher who owns the room it lives in
function canViewBoard(user, meta) {
  if (meta.owner === user.email) return true;
  if (user.isSuper || user.perms.includes('manage_boards')) return true;
  if (meta.room) {
    const room = getRoom(meta.room, false);
    if (room && room.data.owner === user.email) return true;
  }
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
  let data = { name: '', owner: null, roster: [], teacherBoard: null, boards: {}, thumbs: {}, names: {}, updatedAt: Date.now() };
  const file = roomFile(code);
  if (fs.existsSync(file)) {
    try {
      data = Object.assign(data, JSON.parse(fs.readFileSync(file, 'utf8')));
      data.names = data.names || {};
      data.roster = data.roster || [];
    } catch (e) {
      console.error('Could not read saved room', code, e.message);
    }
  } else if (!createIfMissing) {
    return null;
  }
  migrateLegacyBoards(code, data);
  room = { code, data, teacher: null, students: new Map(), sharing: false, saveTimer: null, lastTeacherJson: null };
  rooms.set(code, room);
  return room;
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

function teacherRoom(socket) {
  const { code, role } = socket.data || {};
  if (role !== 'teacher' || !code) return null;
  return rooms.get(code) || null;
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

      const room = getRoom(code, role === 'teacher');
      if (!room) return ack({ error: `Room "${code}" doesn't exist yet. Check the code with your teacher.` });

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
        ack({ ok: true, name, boards: myBoards, activeBoard: { id: active.id, json: activeJson }, students, sharing: room.sharing });
      } else {
        room.students.set(id, socket.id);
        room.data.names[id] = name;
        if (AUTH_ENABLED && !(room.data.roster || []).includes(id)) {
          room.data.roster = room.data.roster || [];
          room.data.roster.push(id); // joining by code enrolls you in the class
        }
        scheduleSave(room);
        ack({
          ok: true,
          name,
          boards: myBoards,
          activeBoard: { id: active.id, json: activeJson },
          sharing: room.sharing,
          teacherBoard: room.sharing ? room.lastTeacherJson : null,
        });
        emitToTeacher(room, 'student:joined', {
          id, name,
          thumb: active.thumb || null,
          boardId: active.id,
        });
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
    if (!room || !json || !meta || meta.owner !== id || meta.room !== code) return;
    room.data.updatedAt = Date.now();
    updateBoard(meta.id, { json, thumb: payload.thumb });
    if (role === 'teacher') {
      room.lastTeacherJson = json;
      if (room.sharing) socket.to(code).emit('teacher:board', { json });
    } else {
      emitToTeacher(room, 'student:board', { id, name, boardId: meta.id, json, thumb: payload.thumb || null });
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
    const { code, id } = socket.data || {};
    if (!code || typeof ack !== 'function') return;
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

  socket.on('student:boards', (payload, ack) => {
    const { code, role } = socket.data || {};
    if (!code || role !== 'teacher' || typeof ack !== 'function') return;
    ack(boardsFor(String(payload && payload.student || ''), code));
  });

  socket.on('share:start', () => {
    const room = teacherRoom(socket);
    if (!room) return;
    room.sharing = true;
    socket.to(room.code).emit('share:start', { json: room.data.teacherBoard });
  });

  socket.on('share:stop', () => {
    const room = teacherRoom(socket);
    if (!room) return;
    room.sharing = false;
    socket.to(room.code).emit('share:stop');
  });

  socket.on('template:push', (payload) => {
    const room = teacherRoom(socket);
    const json = payload && payload.json;
    if (!room || !json) return;
    if (payload.target) {
      const sid = room.students.get(payload.target);
      if (sid) io.to(sid).emit('template', { json });
    } else {
      socket.to(room.code).emit('template', { json });
    }
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

// Build the board index and migrate any legacy single-board rooms at startup
loadBoardsIndex();
for (const f of fs.readdirSync(DATA_DIR)) {
  const m = /^room-(.+)\.json$/.exec(f);
  if (m) getRoom(sanitizeCode(m[1]), false);
}

server.listen(PORT, () => {
  console.log(`Classroom Whiteboard running on port ${PORT}`);
  console.log(`  Boards: ${boardsIndex.size}`);
  console.log(`Google sign-in: ${AUTH_ENABLED ? 'ENABLED' : 'disabled (open mode)'}`);
  if (AUTH_ENABLED) {
    console.log(`  Super admins: ${SUPER_ADMINS.join(', ')}`);
    console.log(`  Approved domains: ${store.domains.join(', ') || '(none yet — approve them in the admin portal)'}`);
    console.log(`  Roles: ${Object.keys(store.roles).join(', ')}`);
    if (!process.env.SESSION_SECRET) console.log('  Note: set SESSION_SECRET so sign-ins survive server restarts.');
  }
});
