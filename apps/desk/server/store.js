// ===================================================================
// Teacher's Desk — JSON file store
//
// One teacher, one board, a few hundred behaviour notes a term: this is
// classroom-scale data, so a single JSON document on a persistent volume is
// the right size of tool. Writes are atomic (temp file + rename) and
// debounced, so dragging a widget around does not thrash the disk.
// ===================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'desk.json');

const EMPTY = {
  // uid is the Signify ID user id — never the email address, because an
  // address can be released to a new pupil and a uuid never is.
  users: {},       // uid -> { uid, email, name, picture, tenantId, tenantName, firstSeen, lastSeen }
  boards: {},      // uid -> { uid, rev, items: [ { id, type, x, y, w, h, state } ], updatedAt }
  rosters: {},     // id  -> { id, ownerUid, name, students: [ { id, name } ], createdAt, updatedAt }
  behaviour: {},   // id  -> { id, teacherUid, tenantId, classKey, className, studentKey, studentName,
                   //          kind, reason, note, at }
  reasons: {},     // uid -> [ { id, kind, label } ]   the teacher's own chips
  groupings: {},   // id  -> { id, ownerUid, classKey, className, name, groups: [[studentKey]], names, createdAt }
  // Furniture only, never a pupil — see server/templates.js for why that
  // separation is what lets these be kept indefinitely.
  templates: {},   // id  -> { id, ownerUid, name, front, desks: [...], objects: [...], createdAt }
  // Sounds and pictures a teacher uploaded. The bytes live beside this file
  // on the volume; see server/assets.js for why so little is trusted.
  assets: {},      // id  -> { id, ownerUid, label, type, kind, bytes, path, createdAt }
};

let db = null;
let writeTimer = null;
let writing = false;
let dirtyAgain = false;

function load() {
  if (db) return db;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    db = Object.assign(blank(), JSON.parse(fs.readFileSync(FILE, 'utf8')));
    for (const k of Object.keys(EMPTY)) if (!db[k]) db[k] = {};
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Store unreadable, starting fresh:', e.message);
    db = blank();
  }
  return db;
}

const blank = () => JSON.parse(JSON.stringify(EMPTY));

function flushNow() {
  if (writing) { dirtyAgain = true; return; }
  writing = true;
  const tmp = `${FILE}.${process.pid}.tmp`;
  const body = JSON.stringify(db);
  fs.promises.mkdir(DATA_DIR, { recursive: true })
    .then(() => fs.promises.writeFile(tmp, body))
    .then(() => fs.promises.rename(tmp, FILE))
    .catch((err) => console.error('Store write failed:', err.message))
    .finally(() => {
      writing = false;
      if (dirtyAgain) { dirtyAgain = false; save(); }
    });
}

function save() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(flushNow, 150);
}

// Nothing in the debounce window should be lost when the dyno stops.
function flushSync() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.exit.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, FILE);
  } catch (e) { console.error('Final store write failed:', e.message); }
}

const id = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;

module.exports = { load, save, flushSync, id, DATA_DIR, FILE, _blank: blank };
