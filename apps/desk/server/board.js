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
const ACCENTS = ['blue', 'green', 'purple', 'red', 'orange', 'teal', 'pink', 'slate'];
const FITS = ['cover', 'contain', 'tile'];

const DEFAULT_PREFS = { theme: 'auto', accent: 'blue', background: '', backgroundFit: 'cover', backgroundDim: 40 };

function cleanPrefs(input) {
  const p = (input && typeof input === 'object') ? input : {};
  const n = Math.round(Number(p.backgroundDim));
  return {
    theme: THEMES.includes(p.theme) ? p.theme : DEFAULT_PREFS.theme,
    accent: ACCENTS.includes(p.accent) ? p.accent : DEFAULT_PREFS.accent,
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

module.exports = { boardFor, saveBoard, resetBoard, cleanPrefs, COLUMNS, MAX_ITEMS, STARTER, DEFAULT_PREFS, ACCENTS };
