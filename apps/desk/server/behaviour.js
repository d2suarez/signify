// ===================================================================
// Teacher's Desk — behaviour notes
//
// These are records about named children on the worst five minutes of their
// day, so the rules are narrow on purpose:
//
//   * Only the teacher who wrote a note can ever read it back. There is no
//     endpoint that returns somebody else's notes — not for another teacher,
//     not for an administrator, not for a super admin. A school that needs a
//     child's record has `core:export_student_data` in Signify ID, which is
//     audited; a quiet back door here would not be.
//   * Everything expires. BEHAVIOUR_RETENTION_DAYS (90 by default) is short
//     deliberately: a running tally for this half term is what a teacher
//     actually uses, and a permanent file on an eight-year-old is not.
//   * A note is free text, so it is capped and never rendered as markup.
// ===================================================================

const store = require('./store');

const RETENTION_DAYS = Math.max(1, Math.min(365, Number(process.env.BEHAVIOUR_RETENTION_DAYS) || 90));
const RETENTION_MS = RETENTION_DAYS * 864e5;

const KINDS = ['positive', 'concern'];

// What the chips say before a teacher changes them. Positive first, and more
// of them than concerns, because that is the board a class should see.
const DEFAULT_REASONS = [
  { id: 'r1', kind: 'positive', label: 'Great effort' },
  { id: 'r2', kind: 'positive', label: 'Helped someone' },
  { id: 'r3', kind: 'positive', label: 'Good answer' },
  { id: 'r4', kind: 'positive', label: 'Ready to learn' },
  { id: 'r5', kind: 'positive', label: 'Kind' },
  { id: 'r6', kind: 'concern', label: 'Off task' },
  { id: 'r7', kind: 'concern', label: 'Calling out' },
  { id: 'r8', kind: 'concern', label: 'Unkind words' },
];

const clean = (s, max) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);

function reasonsFor(uid) {
  const db = store.load();
  if (!db.reasons[uid]) { db.reasons[uid] = JSON.parse(JSON.stringify(DEFAULT_REASONS)); store.save(); }
  return db.reasons[uid];
}

function setReasons(uid, list) {
  const db = store.load();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const label = clean(raw && raw.label, 40);
    const kind = KINDS.includes(raw && raw.kind) ? raw.kind : 'positive';
    if (!label) continue;
    out.push({ id: clean(raw.id, 24) || store.id('r'), kind, label });
    if (out.length >= 24) break;
  }
  db.reasons[uid] = out;
  store.save();
  return out;
}

function record(user, entry) {
  const db = store.load();
  const kind = KINDS.includes(entry.kind) ? entry.kind : 'positive';
  const row = {
    id: store.id('b'),
    teacherUid: user.uid,
    tenantId: user.tenantId || null,
    classKey: clean(entry.classKey, 80),
    className: clean(entry.className, 60),
    studentKey: clean(entry.studentKey, 80),
    studentName: clean(entry.studentName, 80),
    kind,
    reason: clean(entry.reason, 40),
    note: clean(entry.note, 300),
    at: Date.now(),
  };
  if (!row.studentKey || !row.classKey) throw new Error('A note needs a pupil and a class.');
  db.behaviour[row.id] = row;
  store.save();
  return row;
}

function remove(user, id) {
  const db = store.load();
  const row = db.behaviour[id];
  if (!row || row.teacherUid !== user.uid) return false;
  delete db.behaviour[id];
  store.save();
  return true;
}

/** One class, one window: the entries plus a per-pupil tally. */
function forClass(user, classKey, sinceMs) {
  const db = store.load();
  const from = Number(sinceMs) || 0;
  const rows = Object.values(db.behaviour)
    .filter((b) => b.teacherUid === user.uid && b.classKey === classKey && b.at >= from)
    .sort((a, b) => b.at - a.at);

  const totals = {};
  for (const r of rows) {
    const t = totals[r.studentKey] || (totals[r.studentKey] = { positive: 0, concern: 0, last: 0 });
    t[r.kind] += 1;
    if (r.at > t.last) t.last = r.at;
  }
  return { entries: rows.slice(0, 500), totals, retentionDays: RETENTION_DAYS };
}

/**
 * Deletes everything past its date. Runs at boot and hourly — not on read,
 * because a teacher who stops using the desk should still stop holding the
 * records.
 */
function sweep() {
  const db = store.load();
  const cutoff = Date.now() - RETENTION_MS;
  let gone = 0;
  for (const [id, row] of Object.entries(db.behaviour)) {
    if (row.at < cutoff) { delete db.behaviour[id]; gone += 1; }
  }
  if (gone) { store.save(); console.log(`desk: retention removed ${gone} behaviour note(s) older than ${RETENTION_DAYS} days`); }
  return gone;
}

function startSweeping() {
  sweep();
  const timer = setInterval(sweep, 60 * 60 * 1000);
  timer.unref();
  return timer;
}

module.exports = { record, remove, forClass, reasonsFor, setReasons, sweep, startSweeping, RETENTION_DAYS, DEFAULT_REASONS };
