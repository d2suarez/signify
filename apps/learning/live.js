// ===================================================================
// Live lessons
//
// One live session per course at a time. The teacher's screen is the source
// of truth: it says which lesson and which block is showing, whether a poll's
// results are on screen, and when a timer runs. Every student's screen
// follows. Students send poll answers; only the teacher sees who said what.
//
// Nobody joins on their word alone. Next decides who may teach or follow a
// course (it can see the database and Signify ID) and signs a short ticket
// saying so (src/lib/live-ticket.ts); this file only checks the signature,
// and that the ticket belongs to the person on the socket.
//
// State is in memory, on globalThis so Next's routes (same process) can read
// which lesson is live. Restarting the server ends live lessons; every client
// reconnects and gets the state again from the teacher's next move. With more
// than one process this moves to Redis (socket.io's adapter + a hash per
// course); the event names and shapes stay the same.
// ===================================================================

'use strict';

const crypto = require('crypto');
const { Server } = require('socket.io');

/** courseId -> session. Shared with Next via globalThis. */
const sessions = (globalThis.__learningLive ??= new Map());

function verifyTicket(ticket, secret) {
  if (typeof ticket !== 'string') return null;
  const [body, sig] = ticket.split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const t = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!t || t.exp < Date.now()) return null;
    return t;
  } catch { return null; }
}

function room(courseId) { return `course:${courseId}`; }
function teachersRoom(courseId) { return `teachers:${courseId}`; }

/** What everyone in the course may see right now. No names, no answers. */
function publicState(s) {
  if (!s) return { live: false };
  const block = s.currentBlockId;
  return {
    live: true,
    lessonId: s.lessonId,
    lessonVersion: s.lessonVersion,
    index: s.index,
    count: s.count,
    revealed: s.revealed,
    tally: s.revealed && block ? tally(s, block) : null,
    timer: s.timer,
    serverNow: Date.now(),
  };
}

function tally(s, blockId) {
  const counts = {};
  const answers = s.answers.get(blockId) || new Map();
  for (const choice of answers.values()) counts[choice] = (counts[choice] || 0) + 1;
  return { blockId, counts, answered: answers.size };
}

/** What only the teacher sees: who is here, and who answered what. */
function teacherState(s, io, courseId) {
  const students = new Map();
  const sockets = io.sockets.adapter.rooms.get(room(courseId)) || new Set();
  for (const id of sockets) {
    const sock = io.sockets.sockets.get(id);
    if (sock && sock.data.ticket.role === 'student') {
      students.set(sock.data.ticket.sub, { id: sock.data.ticket.sub, name: sock.data.ticket.name });
    }
  }
  const block = s && s.currentBlockId;
  const answers = s && block ? Object.fromEntries(s.answers.get(block) || []) : {};
  return { ...publicState(s), students: [...students.values()], answers, tallyAll: s && block ? tally(s, block) : null };
}

function attach(server, { secret, whoIs }) {
  const io = new Server(server, { path: '/live', serveClient: false });

  io.use(async (socket, nextFn) => {
    try {
      const ticket = verifyTicket(socket.handshake.auth && socket.handshake.auth.ticket, secret);
      if (!ticket) return nextFn(new Error('not allowed'));
      const user = await whoIs(socket.handshake.headers.cookie);
      // The ticket must belong to whoever's browser this is: a ticket copied
      // to another account is worthless.
      if (!user || user.id !== ticket.sub) return nextFn(new Error('not allowed'));
      socket.data.ticket = ticket;
      nextFn();
    } catch (e) {
      nextFn(new Error('not allowed'));
    }
  });

  const pushTeacher = (courseId) => {
    io.to(teachersRoom(courseId)).emit('live:teacher', teacherState(sessions.get(courseId), io, courseId));
  };
  const pushAll = (courseId) => {
    io.to(room(courseId)).emit('live:state', publicState(sessions.get(courseId)));
    pushTeacher(courseId);
  };

  io.on('connection', (socket) => {
    const t = socket.data.ticket;
    const courseId = t.course;
    socket.join(room(courseId));
    if (t.role === 'teacher') socket.join(teachersRoom(courseId));

    socket.emit('live:state', publicState(sessions.get(courseId)));
    pushTeacher(courseId);

    socket.on('disconnect', () => pushTeacher(courseId));

    if (t.role === 'teacher') {
      // Start (or switch to) a lesson. The ticket says which lesson this
      // teacher was allowed to present, so a socket cannot start another.
      socket.on('live:start', (msg) => {
        if (!t.lesson) return;
        const count = Math.max(0, Math.min(500, Number(msg && msg.count) || 0));
        const prev = sessions.get(courseId);
        const same = prev && prev.lessonId === t.lesson;
        sessions.set(courseId, {
          lessonId: t.lesson,
          lessonVersion: Number(msg && msg.version) || 0,
          count,
          index: same ? Math.min(prev.index, Math.max(0, count - 1)) : 0,
          currentBlockId: msg && typeof msg.blockId === 'string' ? msg.blockId.slice(0, 40) : null,
          revealed: false,
          timer: null,
          answers: same ? prev.answers : new Map(),
          startedBy: t.sub,
        });
        pushAll(courseId);
      });

      socket.on('live:goto', (msg) => {
        const s = sessions.get(courseId);
        if (!s || s.lessonId !== t.lesson) return;
        const index = Math.round(Number(msg && msg.index));
        if (!Number.isFinite(index) || index < 0 || index >= s.count) return;
        s.index = index;
        s.currentBlockId = msg && typeof msg.blockId === 'string' ? msg.blockId.slice(0, 40) : null;
        s.revealed = false;
        s.timer = null;
        pushAll(courseId);
      });

      socket.on('live:reveal', (msg) => {
        const s = sessions.get(courseId);
        if (!s || s.lessonId !== t.lesson) return;
        s.revealed = !!(msg && msg.revealed);
        pushAll(courseId);
      });

      // Timer: the teacher's screen sends absolute state (running until a
      // moment, or paused with time left), so a late joiner sees it right.
      socket.on('live:timer', (msg) => {
        const s = sessions.get(courseId);
        if (!s || s.lessonId !== t.lesson) return;
        if (!msg || msg.action === 'reset') s.timer = null;
        else if (msg.action === 'run') s.timer = { endsAt: Date.now() + Math.max(0, Math.min(3600, Number(msg.remaining) || 0)) * 1000, remaining: null };
        else if (msg.action === 'pause') s.timer = { endsAt: null, remaining: Math.max(0, Math.min(3600, Number(msg.remaining) || 0)) };
        pushAll(courseId);
      });

      socket.on('live:end', () => {
        const s = sessions.get(courseId);
        if (!s || s.lessonId !== t.lesson) return;
        sessions.delete(courseId);
        pushAll(courseId);
      });
    }

    if (t.role === 'student') {
      socket.on('live:answer', (msg) => {
        const s = sessions.get(courseId);
        if (!s || !s.currentBlockId || !msg || msg.blockId !== s.currentBlockId) return;
        const choice = typeof msg.choiceId === 'string' ? msg.choiceId.slice(0, 40) : '';
        if (!choice) return;
        if (!s.answers.has(s.currentBlockId)) s.answers.set(s.currentBlockId, new Map());
        s.answers.get(s.currentBlockId).set(t.sub, choice);
        if (s.revealed) pushAll(courseId); else pushTeacher(courseId);
      });
    }
  });

  return io;
}

module.exports = { attach, verifyTicket, publicState, sessions };
