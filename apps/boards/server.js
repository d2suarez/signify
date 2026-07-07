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

app.get('/api/rooms', (req, res) => {
  if (AUTH_ENABLED) {
    const user = sessionFromReq(req);
    if (!user || !hasPerm(user.email, 'teach') || accessStatus(user.email) !== 'approved') {
      return res.status(401).json([]);
    }
  }
  res.json(listRooms());
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
  res.json({ code, data: room.data });
});

app.delete('/api/admin/room/:code', (req, res) => {
  const admin = requirePerm(req, res, 'manage_boards');
  if (!admin) return;
  const code = sanitizeCode(req.params.code);
  io.in(code).disconnectSockets(true);
  rooms.delete(code);
  fs.unlink(roomFile(code), () => {});
  res.json({ ok: true });
});

app.delete('/api/admin/room/:code/board/:id', (req, res) => {
  const admin = requirePerm(req, res, 'manage_boards');
  if (!admin) return;
  const code = sanitizeCode(req.params.code);
  const room = getRoom(code, false);
  if (!room) return res.status(404).json({ error: 'Room not found.' });
  const id = req.params.id;
  if (id === '__teacher__') {
    room.data.teacherBoard = null;
  } else {
    delete room.data.boards[id];
    delete room.data.thumbs[id];
  }
  scheduleSave(room);
  res.json({ ok: true });
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

function listRooms() {
  return fs.readdirSync(DATA_DIR)
    .filter((f) => /^room-.+\.json$/.test(f))
    .map((f) => {
      const code = f.replace(/^room-/, '').replace(/\.json$/, '');
      try {
        const live = rooms.get(code);
        const d = live ? live.data : JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
        return {
          code,
          updatedAt: d.updatedAt || 0,
          students: Object.keys(d.boards || {}).length,
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

function getRoom(code, createIfMissing) {
  let room = rooms.get(code);
  if (room) return room;
  let data = { teacherBoard: null, boards: {}, thumbs: {}, names: {}, updatedAt: Date.now() };
  const file = roomFile(code);
  if (fs.existsSync(file)) {
    try {
      data = Object.assign(data, JSON.parse(fs.readFileSync(file, 'utf8')));
      data.names = data.names || {};
    } catch (e) {
      console.error('Could not read saved room', code, e.message);
    }
  } else if (!createIfMissing) {
    return null;
  }
  room = { code, data, teacher: null, students: new Map(), sharing: false, saveTimer: null };
  rooms.set(code, room);
  return room;
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

      if (role === 'teacher') {
        room.teacher = socket.id;
        const students = [];
        const seen = new Set();
        for (const sid of room.students.keys()) {
          seen.add(sid);
          students.push({
            id: sid, name: room.data.names[sid] || sid, online: true,
            thumb: room.data.thumbs[sid] || null, board: room.data.boards[sid] || null,
          });
        }
        for (const sid of Object.keys(room.data.boards)) {
          if (!seen.has(sid)) {
            students.push({
              id: sid, name: room.data.names[sid] || sid, online: false,
              thumb: room.data.thumbs[sid] || null, board: room.data.boards[sid],
            });
          }
        }
        ack({ ok: true, name, board: room.data.teacherBoard, students, sharing: room.sharing });
      } else {
        room.students.set(id, socket.id);
        room.data.names[id] = name;
        scheduleSave(room);
        ack({
          ok: true,
          name,
          board: room.data.boards[id] || null,
          sharing: room.sharing,
          teacherBoard: room.sharing ? room.data.teacherBoard : null,
        });
        emitToTeacher(room, 'student:joined', {
          id, name,
          thumb: room.data.thumbs[id] || null,
          board: room.data.boards[id] || null,
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
    if (!room || !json) return;
    room.data.updatedAt = Date.now();
    if (role === 'teacher') {
      room.data.teacherBoard = json;
      if (room.sharing) socket.to(code).emit('teacher:board', { json });
    } else {
      room.data.boards[id] = json;
      if (payload.thumb) room.data.thumbs[id] = payload.thumb;
      emitToTeacher(room, 'student:board', { id, name, json, thumb: payload.thumb || null });
    }
    scheduleSave(room);
    if (typeof ack === 'function') ack({ ok: true });
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

server.listen(PORT, () => {
  console.log(`Classroom Whiteboard running on port ${PORT}`);
  console.log(`Google sign-in: ${AUTH_ENABLED ? 'ENABLED' : 'disabled (open mode)'}`);
  if (AUTH_ENABLED) {
    console.log(`  Super admins: ${SUPER_ADMINS.join(', ')}`);
    console.log(`  Approved domains: ${store.domains.join(', ') || '(none yet — approve them in the admin portal)'}`);
    console.log(`  Roles: ${Object.keys(store.roles).join(', ')}`);
    if (!process.env.SESSION_SECRET) console.log('  Note: set SESSION_SECRET so sign-ins survive server restarts.');
  }
});
