// ===================================================================
// Teacher's Desk — saved groupings
//
// The group maker itself runs in the browser (a teacher re-rolls it four
// times before they like it, and a round trip for each is silly). What comes
// here is the arrangement they decided to keep, so it survives the lesson and
// can be put back up next week.
// ===================================================================

const store = require('./store');

const clean = (s, max) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
const MAX_PER_TEACHER = 60;

function listFor(user, classKey) {
  const db = store.load();
  return Object.values(db.groupings)
    .filter((g) => g.ownerUid === user.uid && (!classKey || g.classKey === classKey))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 100);
}

function create(user, input) {
  const db = store.load();
  const mine = Object.values(db.groupings).filter((g) => g.ownerUid === user.uid);
  if (mine.length >= MAX_PER_TEACHER) {
    // Drop the oldest rather than refusing — a teacher hitting this limit is
    // saving every week, not making a mistake.
    mine.sort((a, b) => a.createdAt - b.createdAt);
    delete db.groupings[mine[0].id];
  }

  const groups = [];
  for (const raw of Array.isArray(input.groups) ? input.groups : []) {
    const members = [];
    for (const m of Array.isArray(raw && raw.members) ? raw.members : []) {
      const key = clean(m && m.key, 80);
      if (!key) continue;
      members.push({ key, name: clean(m.name, 80) });
      if (members.length >= 200) break;
    }
    groups.push({ label: clean(raw && raw.label, 40) || `Group ${groups.length + 1}`, members });
    if (groups.length >= 40) break;
  }
  if (!groups.length) throw new Error('There are no groups to save.');

  const row = {
    id: store.id('g'),
    ownerUid: user.uid,
    tenantId: user.tenantId || null,
    classKey: clean(input.classKey, 80),
    className: clean(input.className, 60),
    name: clean(input.name, 60) || new Date().toLocaleDateString(),
    groups,
    createdAt: Date.now(),
  };
  db.groupings[row.id] = row;
  store.save();
  return row;
}

function remove(user, id) {
  const db = store.load();
  const row = db.groupings[id];
  if (!row || row.ownerUid !== user.uid) return false;
  delete db.groupings[id];
  store.save();
  return true;
}

module.exports = { listFor, create, remove };
