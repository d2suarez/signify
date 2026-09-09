// ===================================================================
// Teacher's Desk — files a teacher uploads
//
// Sounds for their soundboard, an image behind their board. Small, few, and
// private to the person who uploaded them.
//
// Everything here is deliberately narrow, because an upload endpoint on a
// school app is the sort of thing that gets found:
//
//   * The file type is decided by SNIFFING THE BYTES, never by the name or
//     the Content-Type the browser claims. An .mp3 that is really an .html
//     is the whole attack.
//   * Files are served back with the sniffed type, `nosniff`, and an
//     attachment disposition, so nothing uploaded here can ever execute as a
//     page on this origin.
//   * Stored under a generated id. The teacher's own filename is kept as a
//     label and never touches the filesystem.
//   * Per-teacher count and byte quotas, so one person cannot fill the disk.
// ===================================================================

const fs = require('fs');
const path = require('path');
const store = require('./store');

const DIR = path.join(store.DATA_DIR, 'uploads');

const MAX_BYTES = 2 * 1024 * 1024;        // one file
const MAX_PER_TEACHER = 60;
const MAX_BYTES_PER_TEACHER = 40 * 1024 * 1024;

// What a soundboard pad or a board background can legitimately be. Anything
// that is not on this list simply has no entry here and is refused.
const KINDS = {
  'audio/mpeg': { ext: 'mp3', kind: 'audio' },
  'audio/mp4': { ext: 'm4a', kind: 'audio' },
  'audio/ogg': { ext: 'ogg', kind: 'audio' },
  'audio/wav': { ext: 'wav', kind: 'audio' },
  'audio/webm': { ext: 'weba', kind: 'audio' },
  'image/jpeg': { ext: 'jpg', kind: 'image' },
  'image/png': { ext: 'png', kind: 'image' },
  'image/webp': { ext: 'webp', kind: 'image' },
  'image/gif': { ext: 'gif', kind: 'image' },
};

const clean = (s, max) => String(s == null ? '' : s).replace(/[\r\n\t]/g, ' ').trim().slice(0, max);

/**
 * What this actually is, from its first bytes.
 *
 * Deliberately not a library: the list is short, the checks are the file
 * format's own magic numbers, and anything unrecognised is refused rather
 * than guessed at.
 */
function sniff(buf) {
  if (buf.length < 12) return null;
  const ascii = (at, n) => buf.slice(at, at + n).toString('latin1');

  if (ascii(0, 3) === 'ID3') return 'audio/mpeg';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'audio/mpeg';   // MPEG frame sync
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'audio/wav';
  if (ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4);
    // M4A and friends. Video brands are not on the allowlist, so a .mp4 of
    // moving pictures is refused here rather than becoming a "sound".
    if (['M4A ', 'M4B ', 'mp42', 'isom', 'iso2'].includes(brand)) return 'audio/mp4';
    return null;
  }
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'audio/webm';

  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (ascii(1, 3) === 'PNG') return 'image/png';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  if (ascii(0, 3) === 'GIF') return 'image/gif';

  return null;
}

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
}

const mine = (uid) => Object.values(store.load().assets || {}).filter((a) => a.ownerUid === uid);

function usage(user) {
  const files = mine(user.uid);
  return {
    count: files.length,
    bytes: files.reduce((n, a) => n + a.bytes, 0),
    maxCount: MAX_PER_TEACHER,
    maxBytes: MAX_BYTES_PER_TEACHER,
    maxFileBytes: MAX_BYTES,
  };
}

function listFor(user, kind) {
  return mine(user.uid)
    .filter((a) => !kind || a.kind === kind)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(({ path: _p, ...rest }) => rest);
}

/**
 * Stores one uploaded file. `buf` is the raw body; `name` is only ever a
 * label. Throws with a message meant to be shown to the teacher.
 */
function save(user, buf, name) {
  if (!buf || !buf.length) throw new Error('That file was empty.');
  if (buf.length > MAX_BYTES) {
    throw new Error(`That file is ${(buf.length / 1048576).toFixed(1)}MB. The limit is ${MAX_BYTES / 1048576}MB.`);
  }

  const type = sniff(buf);
  const spec = type && KINDS[type];
  if (!spec) throw new Error('That is not a sound or a picture this can use. Try MP3, M4A, OGG, WAV, JPG, PNG, WEBP or GIF.');

  const used = usage(user);
  if (used.count >= MAX_PER_TEACHER) throw new Error(`That is as many files as one desk can hold (${MAX_PER_TEACHER}). Remove one first.`);
  if (used.bytes + buf.length > MAX_BYTES_PER_TEACHER) {
    throw new Error(`That would take you over your ${MAX_BYTES_PER_TEACHER / 1048576}MB of space. Remove something first.`);
  }

  ensureDir();
  const id = store.id('a');
  const file = path.join(DIR, `${id}.${spec.ext}`);
  fs.writeFileSync(file, buf);

  const row = {
    id,
    ownerUid: user.uid,
    tenantId: user.tenantId || null,
    label: clean(name, 60).replace(/\.[a-z0-9]{1,5}$/i, '') || 'Untitled',
    type,
    kind: spec.kind,
    bytes: buf.length,
    path: file,
    createdAt: Date.now(),
  };
  store.load().assets[id] = row;
  store.save();

  const { path: _p, ...safe } = row;
  return safe;
}

/** The stored record, only ever for its owner. */
function get(user, id) {
  const row = store.load().assets[id];
  return row && row.ownerUid === user.uid ? row : null;
}

function rename(user, id, label) {
  const row = get(user, id);
  if (!row) return null;
  row.label = clean(label, 60) || row.label;
  store.save();
  const { path: _p, ...safe } = row;
  return safe;
}

function remove(user, id) {
  const row = get(user, id);
  if (!row) return false;
  try { fs.unlinkSync(row.path); } catch (e) { if (e.code !== 'ENOENT') console.warn('desk: could not delete upload —', e.message); }
  delete store.load().assets[id];
  store.save();
  return true;
}

module.exports = { save, get, listFor, rename, remove, usage, sniff, KINDS, MAX_BYTES, DIR };
