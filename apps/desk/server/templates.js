// ===================================================================
// Teacher's Desk — saved room templates
//
// A template is the FURNITURE, not the class: where the desks are, which way
// they face, which wall the front is, and whatever else the teacher has drawn
// in. No pupil is ever part of one.
//
// That separation is the whole point. A teacher sets their room up once and
// then seats five different classes in it — and it also means a template can
// be kept indefinitely without holding anything about a child, which is why
// these are not swept the way behaviour notes are.
// ===================================================================

const store = require('./store');

const clean = (s, max) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
const MAX_PER_TEACHER = 40;
const FRONTS = ['top', 'right', 'bottom', 'left'];
const DESK_SHAPES = ['row', 'table', 'round'];
const OBJECT_SHAPES = ['rect', 'circle', 'strip'];
const FACINGS = ['up', 'right', 'down', 'left'];

const num = (v, lo, hi, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

function listFor(user) {
  const db = store.load();
  return Object.values(db.templates)
    .filter((t) => t.ownerUid === user.uid)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 100);
}

/**
 * Takes only the shape of a room, and only in the shapes the client can
 * actually draw. A template is written by the browser, so it is validated
 * here rather than trusted — the same as any other body.
 */
function normalise(input) {
  const desks = [];
  for (const d of Array.isArray(input.desks) ? input.desks : []) {
    if (!DESK_SHAPES.includes(d && d.shape)) continue;
    desks.push({
      id: clean(d.id, 40) || store.id('d'),
      shape: d.shape,
      seats: num(d.seats, 1, 12, 2),
      facing: FACINGS.includes(d.facing) ? d.facing : 'up',
      x: num(d.x, 0, 200, 0),
      y: num(d.y, 0, 200, 0),
    });
    if (desks.length >= 60) break;
  }

  const objects = [];
  for (const o of Array.isArray(input.objects) ? input.objects : []) {
    if (!OBJECT_SHAPES.includes(o && o.shape)) continue;
    objects.push({
      id: clean(o.id, 40) || store.id('o'),
      shape: o.shape,
      label: clean(o.label, 30),
      x: num(o.x, 0, 200, 0),
      y: num(o.y, 0, 200, 0),
      w: num(o.w, 1, 200, 6),
      h: num(o.h, 1, 200, 4),
    });
    if (objects.length >= 40) break;
  }

  return {
    front: FRONTS.includes(input.front) ? input.front : 'top',
    desks,
    objects,
  };
}

function create(user, input) {
  const db = store.load();
  const room = normalise(input || {});
  if (!room.desks.length && !room.objects.length) throw new Error('There is nothing in this room to save.');

  const mine = Object.values(db.templates).filter((t) => t.ownerUid === user.uid);
  if (mine.length >= MAX_PER_TEACHER) {
    // Drop the oldest rather than refusing: somebody at this limit is using
    // the feature, not making a mistake.
    mine.sort((a, b) => a.createdAt - b.createdAt);
    delete db.templates[mine[0].id];
  }

  const row = {
    id: store.id('t'),
    ownerUid: user.uid,
    tenantId: user.tenantId || null,
    name: clean(input.name, 60) || 'Untitled room',
    ...room,
    createdAt: Date.now(),
  };
  db.templates[row.id] = row;
  store.save();
  return row;
}

function get(user, id) {
  const row = store.load().templates[id];
  return row && row.ownerUid === user.uid ? row : null;
}

function rename(user, id, name) {
  const row = get(user, id);
  if (!row) return null;
  row.name = clean(name, 60) || row.name;
  store.save();
  return row;
}

function remove(user, id) {
  const row = get(user, id);
  if (!row) return false;
  delete store.load().templates[id];
  store.save();
  return true;
}

module.exports = { listFor, create, get, rename, remove, normalise };
