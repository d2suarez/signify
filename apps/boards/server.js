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
const ALLOWED_DOMAINS = (process.env.ALLOWED_DOMAINS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const TEACHER_EMAILS = (process.env.TEACHER_EMAILS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_HOURS = 12;
const oauthClient = AUTH_ENABLED ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

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

function roleFor(email) {
  if (!TEACHER_EMAILS.length) return 'choose'; // no list configured: user picks
  return TEACHER_EMAILS.includes(email) ? 'teacher' : 'student';
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
    const domain = email.split('@')[1] || '';
    if (!p.email_verified) return res.status(403).json({ error: 'This Google account has no verified email.' });
    if (ALLOWED_DOMAINS.length && !ALLOWED_DOMAINS.includes(domain) && !ALLOWED_DOMAINS.includes((p.hd || '').toLowerCase())) {
      return res.status(403).json({ error: `Only ${ALLOWED_DOMAINS.join(', ')} accounts can use this whiteboard.` });
    }
    const user = {
      email,
      name: p.name || email,
      role: roleFor(email),
      exp: Date.now() + SESSION_HOURS * 3600 * 1000,
    };
    res.json({ token: signSession(user), email: user.email, name: user.name, role: user.role, exp: user.exp });
  } catch (e) {
    res.status(401).json({ error: 'Google sign-in could not be verified. Please try again.' });
  }
});

app.get('/api/rooms', (req, res) => {
  if (AUTH_ENABLED) {
    const user = verifySession((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!user || user.role === 'student') return res.status(401).json([]);
  }
  const list = fs.readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
        return {
          code: f.replace(/\.json$/, ''),
          updatedAt: d.updatedAt || 0,
          students: Object.keys(d.boards || {}).length,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  res.json(list);
});

// ---------- rooms ----------
// Boards are keyed by a stable id: the verified Google email when auth is on,
// otherwise the typed name. data.names maps id -> display name.

const rooms = new Map();

function sanitizeCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 12);
}

function roomFile(code) {
  return path.join(DATA_DIR, code + '.json');
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
  socket.data.user = user;
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
        name = u.name;
        role = payload.role === 'teacher' ? 'teacher' : 'student';
        if (role === 'teacher' && u.role === 'student') {
          return ack({ error: 'Your account is not registered as a teacher for this whiteboard.' });
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
    console.log(`  Allowed domains: ${ALLOWED_DOMAINS.join(', ') || '(any Google account!)'}`);
    console.log(`  Teachers: ${TEACHER_EMAILS.join(', ') || '(anyone may join as teacher!)'}`);
    if (!process.env.SESSION_SECRET) console.log('  Note: set SESSION_SECRET so sign-ins survive server restarts.');
  }
});
