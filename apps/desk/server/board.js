// ===================================================================
// Teacher's Desk — the board itself
//
// One document per teacher: which widgets are on the desk, where they sit,
// and each one's own state (the timer's presets, the note's text). Widget
// state is opaque here on purpose — adding a new tool must not mean a change
// to the server.
//
// `rev` is what stops a laptop and a projector-side tab from silently
// overwriting each other: a save carrying a stale rev is refused, and the
// browser reloads rather than clobbering.
// ===================================================================

const store = require('./store');

const COLUMNS = 12;
const MAX_ROWS = 400;
const MAX_ITEMS = 40;
const MAX_BOARD_BYTES = 256 * 1024;

// How many previous versions of a board to keep, and how often to take one
// just because time has passed. The targeted snapshots below are the ones
// that matter; the periodic one is there so an ordinary bad afternoon is also
// recoverable.
const HISTORY_KEEP = 30;
const HISTORY_EVERY_MS = 30 * 60 * 1000;

/**
 * How many pupils are seated in each seating widget on a board.
 *
 * Counted per widget and per class, because "the board still has six plans"
 * is not the same as "the six plans still have anybody in them" — and the
 * second is the thing that has twice gone missing.
 */
function seatCounts(items) {
  const out = {};
  for (const it of items || []) {
    if (it.type !== 'seating') continue;
    const plans = (it.state && it.state.plans) || {};
    for (const [key, plan] of Object.entries(plans)) {
      out[`${it.id}:${key}`] = Object.keys((plan && plan.seats) || {}).length;
    }
  }
  return out;
}

/** Which plans lost pupils between two boards, and how many. */
function seatsLost(before, after) {
  const a = seatCounts(before);
  const b = seatCounts(after);
  const lost = [];
  for (const [key, was] of Object.entries(a)) {
    const now = b[key] == null ? 0 : b[key];
    if (now < was) lost.push({ key, was, now });
  }
  return lost;
}

/**
 * Keeps a copy of a board before it is overwritten.
 *
 * Always when the save would remove seated pupils, and otherwise at most every
 * half hour. The first is the point: a seating plan is twenty minutes of work
 * and it has twice been emptied by something nobody has yet caught in the act,
 * so the copy is taken on the way past whether or not the cause is understood.
 */
function keepHistory(uid, board, why) {
  const db = store.load();
  const list = db.boardHistory[uid] || (db.boardHistory[uid] = []);
  list.unshift({ rev: board.rev, at: Date.now(), why, items: JSON.parse(JSON.stringify(board.items)) });
  list.length = Math.min(list.length, HISTORY_KEEP);
}

// What a brand-new teacher's desk looks like. Enough to be useful before
// anything is configured, and small enough not to be a wall of widgets.
const STARTER = [
  { type: 'timer', x: 0, y: 0, w: 4, h: 5 },
  { type: 'randomiser', x: 4, y: 0, w: 4, h: 5 },
  { type: 'notes', x: 8, y: 0, w: 4, h: 5 },
  { type: 'stopwatch', x: 0, y: 5, w: 4, h: 4 },
  { type: 'groups', x: 4, y: 5, w: 4, h: 4 },
  { type: 'alarms', x: 8, y: 5, w: 4, h: 4 },
  // Filtered out for anyone whose role does not hold desk:behaviour.
  { type: 'behaviour', x: 0, y: 9, w: 5, h: 6 },
];

const int = (v, lo, hi, fallback) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};

// How the desk looks. Kept on the board rather than in the browser, because a
// teacher who sets their room's colours up wants them on the laptop AND on
// the machine driving the projector.
const THEMES = ['auto', 'light', 'dark'];
const PALETTES = ['primary', 'garden', 'berry', 'ocean', 'mono-red', 'custom'];
// What a board saved under the old eight-accent scheme becomes. Read once, on
// the way out of the store, so a teacher who chose "teal" two terms ago opens
// their desk on Ocean rather than back at the default.
const ACCENT_TO_PALETTE = {
  blue: 'primary', slate: 'primary',
  green: 'garden', orange: 'garden',
  teal: 'ocean',
  purple: 'berry', pink: 'berry',
  red: 'mono-red',
  custom: 'custom',
};
// Six hex digits and nothing else. The value goes straight into a CSS custom
// property, so this is the gate that stops a saved preference from carrying
// anything but a colour into the stylesheet.
const HEX = /^#[0-9a-f]{6}$/i;
const FITS = ['cover', 'contain', 'tile'];
const DEFAULT_PREFS = { theme: 'auto', palette: 'primary', accentHex: '#EC3013', background: '', backgroundFit: 'cover', backgroundDim: 40 };

function cleanPrefs(input) {
  const p = (input && typeof input === 'object') ? input : {};
  const n = Math.round(Number(p.backgroundDim));
  return {
    theme: THEMES.includes(p.theme) ? p.theme : DEFAULT_PREFS.theme,
    palette: PALETTES.includes(p.palette) ? p.palette
      : (ACCENT_TO_PALETTE[p.accent] || DEFAULT_PREFS.palette),
    accentHex: HEX.test(String(p.accentHex || '')) ? String(p.accentHex).toLowerCase() : DEFAULT_PREFS.accentHex,
    // `chrome` ('card' or 'bare', floating) is no longer a choice: every tool
    // sits on its card. A saved one is simply not carried forward.
    // Either an uploaded asset id or one of the built-in patterns. Never a
    // URL: a background that can point anywhere is a background that can
    // report every teacher's IP to somebody else's server.
    background: String(p.background || '').replace(/[^\w-]/g, '').slice(0, 64),
    backgroundFit: FITS.includes(p.backgroundFit) ? p.backgroundFit : DEFAULT_PREFS.backgroundFit,
    backgroundDim: Number.isFinite(n) ? Math.min(90, Math.max(0, n)) : DEFAULT_PREFS.backgroundDim,
  };
}

function boardFor(user) {
  const db = store.load();
  let board = db.boards[user.uid];
  if (!board) {
    board = {
      uid: user.uid,
      rev: 1,
      items: STARTER.map((s) => ({ id: store.id('w'), state: {}, ...s })),
      prefs: { ...DEFAULT_PREFS },
      updatedAt: Date.now(),
    };
    db.boards[user.uid] = board;
    store.save();
  }
  if (!board.prefs) board.prefs = { ...DEFAULT_PREFS };   // boards made before theming
  return board;
}

/**
 * Replaces the board, if the caller was looking at the current one.
 * Returns { ok } or { conflict, board }.
 */
function saveBoard(user, incoming) {
  const db = store.load();
  const current = boardFor(user);

  if (Number(incoming.rev) !== current.rev) return { conflict: true, board: current };

  const items = [];
  const seen = new Set();
  for (const raw of Array.isArray(incoming.items) ? incoming.items : []) {
    if (items.length >= MAX_ITEMS) break;
    const type = String(raw && raw.type || '').slice(0, 40);
    if (!type) continue;
    const id = String(raw.id || '').slice(0, 40) || store.id('w');
    if (seen.has(id)) continue;
    seen.add(id);
    const w = int(raw.w, 1, COLUMNS, 3);
    items.push({
      id,
      type,
      x: int(raw.x, 0, COLUMNS - w, 0),
      y: int(raw.y, 0, MAX_ROWS, 0),
      w,
      h: int(raw.h, 1, 40, 4),
      state: (raw.state && typeof raw.state === 'object' && !Array.isArray(raw.state)) ? raw.state : {},
    });
  }

  const body = JSON.stringify(items);
  if (body.length > MAX_BOARD_BYTES) {
    return { tooBig: true };
  }

  // Before anything is overwritten. A save that empties a seating plan is
  // said out loud with the numbers, because twice now a term's work has gone
  // and there was nothing in the log to say when or how much.
  const lost = seatsLost(current.items, items);
  const history = db.boardHistory[user.uid] || [];
  const lastKept = history.length ? history[0].at : 0;
  if (lost.length) {
    for (const l of lost) {
      console.warn(`desk: board ${user.uid} rev ${current.rev}→${current.rev + 1} — ${l.key} lost seats ${l.was}→${l.now}`);
    }
    keepHistory(user.uid, current, `before losing ${lost.reduce((n, l) => n + (l.was - l.now), 0)} seated pupil(s)`);
  } else if (Date.now() - lastKept > HISTORY_EVERY_MS) {
    keepHistory(user.uid, current, 'periodic');
  }

  current.items = items;
  if (incoming.prefs) current.prefs = cleanPrefs(incoming.prefs);
  current.rev += 1;
  current.updatedAt = Date.now();
  store.save();
  return { ok: true, rev: current.rev, updatedAt: current.updatedAt };
}

function resetBoard(user) {
  const db = store.load();
  const current = boardFor(user);
  current.items = STARTER.map((s) => ({ id: store.id('w'), state: {}, ...s }));
  // Colours are not "tools on the desk" — resetting the board should not
  // repaint the room the teacher set up.
  current.rev += 1;
  current.updatedAt = Date.now();
  db.boards[user.uid] = current;
  store.save();
  return current;
}

/** The kept versions of this teacher's board, newest first, without the bulk. */
function listHistory(user) {
  const db = store.load();
  return (db.boardHistory[user.uid] || []).map((h) => ({
    rev: h.rev,
    at: h.at,
    why: h.why,
    seated: Object.values(seatCounts(h.items)).reduce((n, x) => n + x, 0),
    plans: Object.keys(seatCounts(h.items)).length,
  }));
}

/**
 * Puts a kept version back as the live board.
 *
 * The board as it stands is kept first, so this is as undoable as everything
 * else here.
 */
function restoreHistory(user, rev) {
  const db = store.load();
  const snap = (db.boardHistory[user.uid] || []).find((h) => h.rev === Number(rev));
  if (!snap) return null;

  const current = boardFor(user);
  keepHistory(user.uid, current, 'before putting an earlier desk back');
  current.items = JSON.parse(JSON.stringify(snap.items));
  current.rev += 1;
  current.updatedAt = Date.now();
  store.save();
  return { ok: true, rev: current.rev };
}

module.exports = {
  boardFor, saveBoard, resetBoard, cleanPrefs, listHistory, restoreHistory,
  COLUMNS, MAX_ITEMS, STARTER, DEFAULT_PREFS, PALETTES, ACCENT_TO_PALETTE,
  _seatCounts: seatCounts, _seatsLost: seatsLost,
};
