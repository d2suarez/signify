/* global io, Whiteboard, BoardViewer, pdfjsLib */
'use strict';

const params = new URLSearchParams(location.search);
const room = (params.get('room') || '').toUpperCase();
const soloBoardId = params.get('board') || null; // personal board, no room
const role = params.get('role') === 'teacher' ? 'teacher' : 'student';
let myName = params.get('name') || '';

if (!room && !soloBoardId) location.href = '/';

// Report uncaught client errors so problems on a student's device reach the server log
let _errReported = 0;
window.addEventListener('error', (e) => {
  if (_errReported++ > 8) return;
  try {
    fetch('/api/client-error', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: (e.message || '') + ' @ ' + (e.filename || '') + ':' + (e.lineno || ''), where: location.pathname }),
    });
  } catch { /* ignore */ }
});

const isSolo = !room;
document.title = `${room || 'My board'} — Signify Learning`;
// Join code is hidden by default (safe to project); only the teacher can reveal it.
// The shareable joinCode is separate from the room id and can be reset/disabled.
let codeHidden = true;
let joinCode = room;
let joinDisabled = false;
function paintCode() {
  const shown = joinDisabled ? 'joining off' : joinCode;
  document.getElementById('room-code-text').textContent = codeHidden ? (isSolo ? 'My board' : '•••••') : (shown || 'My board');
  const t = document.getElementById('code-toggle');
  t.textContent = codeHidden ? '👁' : '🙈';
  t.title = codeHidden ? 'Reveal the join code' : 'Hide the join code';
  const row = document.getElementById('code-controls');
  if (row) {
    document.getElementById('code-current').textContent = joinDisabled ? 'Joining by code is OFF' : `Join code: ${joinCode}`;
    document.getElementById('code-disable').textContent = joinDisabled ? 'Enable joining' : 'Disable joining';
  }
}
document.getElementById('code-toggle').addEventListener('click', () => {
  codeHidden = !codeHidden;
  paintCode();
});
// students never see the reveal control — they don't need the code once they're in
if (isSolo || role !== 'teacher') document.getElementById('code-toggle').hidden = true;
paintCode();

// the page itself must never zoom — only the board (pinch/ctrl-scroll on canvas)
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('wheel', (e) => {
  if ((e.ctrlKey || e.metaKey) && !document.getElementById('canvas-wrap').contains(e.target)) e.preventDefault();
}, { passive: false });

if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.js';

// ---------- whiteboard ----------

const canvasWrap = document.getElementById('canvas-wrap');
const wb = new Whiteboard('board', canvasWrap, {
  onChange: (json, thumb) => sendBoard(json, thumb),
  onViewChange: updateZoomLabel,
  onSelection: () => refreshCtx(),
  onModeChange: () => refreshCtx(),
});

// Contextual actions for the current selection / edit session
function refreshCtx() {
  const cropping = wb.isCropping();
  const editing = wb.isCurveEditing();
  const kind = cropping || editing ? null : wb.getActiveKind();
  const anySelection = !cropping && !editing && wb.canvas.getActiveObject();
  document.getElementById('ctx-crop').hidden = kind !== 'image';
  document.getElementById('ctx-curve').hidden = kind !== 'curve';
  document.getElementById('ctx-beautify').hidden = kind !== 'stroke';
  document.getElementById('ctx-duplicate').hidden = !anySelection;
  document.getElementById('ctx-comment').hidden = !anySelection || isSolo || wb.canvas.getActiveObjects().length !== 1;
  document.getElementById('ctx-send').hidden = !(anySelection && role === 'teacher' && !isSolo);
  const apply = document.getElementById('ctx-apply');
  apply.hidden = !(cropping || editing);
  apply.textContent = cropping ? 'Apply crop' : 'Done';
  document.getElementById('ctx-cancel').hidden = !(cropping || editing);
}

document.getElementById('ctx-duplicate').addEventListener('click', () => wb.duplicateSelection());
document.getElementById('ctx-beautify').addEventListener('click', () => {
  const kind = wb.beautifyActive();
  if (!kind) toast('Couldn’t tidy that one — try a clearer line, box, triangle or circle.');
});
document.getElementById('ctx-crop').addEventListener('click', () => wb.startCropOnActive());
document.getElementById('ctx-curve').addEventListener('click', () => wb.startCurveEditOnActive());
document.getElementById('ctx-apply').addEventListener('click', () => {
  if (wb.isCropping()) wb.applyCrop();
  else wb.finishCurveEdit(true);
});
document.getElementById('ctx-cancel').addEventListener('click', () => {
  wb.cancelCrop();
  wb.finishCurveEdit(false);
});

function updateZoomLabel() {
  document.getElementById('zoom-label').textContent = Math.round(wb.getZoom() * 100) + '%';
  updatePageNav();
  if (typeof updateTextToolbar === 'function' && wb.getActiveText()) updateTextToolbar();
}

// ---------- boards state ----------

let currentBoard = null; // { id, title }
let boardsList = [];
let offlineDirty = false; // drew while disconnected — local canvas has unsent work

function setCurrentBoard(meta, foreignName) {
  const prev = currentBoard;
  if (prev && prev.id !== meta.id && !isSolo && socket && socket.connected) {
    socket.emit('cursor:hide', { boardId: prev.id }); // tell peers I left the old board
  }
  if (typeof clearCursors === 'function' && (!prev || prev.id !== meta.id)) clearCursors();
  if (!isSolo && socket && socket.connected) socket.emit('presence:view', { boardId: meta.id });
  // rev = the board revision we currently hold, for the reconnect skip-if-unchanged guard
  currentBoard = { id: meta.id, title: meta.title, rev: meta.updatedAt || null };
  foreignBoardOwner = foreignName || null;
  if (typeof renderAssignmentBanner === 'function') renderAssignmentBanner();
  document.getElementById('board-title').textContent = foreignName
    ? `${foreignName}: ${meta.title} ▾`
    : `${meta.title} ▾`;
  const back = document.getElementById('back-my-board');
  if (back) back.hidden = !foreignName;
  if (isSolo) document.title = `${meta.title} — Signify Learning`;
}

// ---------- socket / persistence ----------

const statusDot = document.getElementById('status-dot');
const saveIndicator = document.getElementById('save-indicator');
let socket = null;
let hasLoaded = false;
// Signed-in state is a flag now, not a token — the session is an httpOnly
// cookie the browser attaches on its own.
let authToken = null;
// A SEPARATE Google client, used only for the Google Classroom import. Sign-in
// does not touch Google here any more; Classroom needs its own consent because
// it asks for roster scopes, which are far more than signing in requires.
let googleClientId = null;

async function authedFetch(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const res = await fetch(path, { ...opts, headers, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Build a thumbnail node WITHOUT interpolating the (client-supplied) data URL into
// HTML — set .src as a property so a malicious thumb string can never inject markup.
function boardThumbNode(thumb, emptyText) {
  if (thumb) {
    const im = document.createElement('img');
    im.alt = '';
    im.src = thumb;
    return im;
  }
  const d = document.createElement('div');
  d.className = 'tile-empty';
  d.textContent = emptyText;
  return d;
}

function savedFlash() {
  saveIndicator.textContent = 'Saved ✓';
  clearTimeout(savedFlash._t);
  savedFlash._t = setTimeout(() => { saveIndicator.textContent = ''; }, 2000);
}

// ---------- board loading overlay (progress feedback on slow wifi) ----------

function showBoardLoading(label) {
  const el = document.getElementById('board-loading');
  el.hidden = false;
  el.classList.add('indeterminate'); // downloading: no byte progress available
  document.getElementById('bl-text').textContent = label || 'Loading board…';
  document.getElementById('bl-fill').style.width = '0%';
}
function boardLoadingProgress(done, total) {
  const el = document.getElementById('board-loading');
  el.hidden = false;
  el.classList.remove('indeterminate');
  document.getElementById('bl-text').textContent = `Loading board — ${done} of ${total}`;
  document.getElementById('bl-fill').style.width = Math.round((done / total) * 100) + '%';
}
function hideBoardLoading() {
  document.getElementById('board-loading').hidden = true;
}

// Load json into the main canvas with the progress overlay; hides it when done.
function loadBoardWithProgress(json, after) {
  wb.loadJSON(json || { version: '5.3.0', objects: [] }, () => {
    hideBoardLoading();
    updatePageNav();
    if (after) after();
  }, boardLoadingProgress);
}

function sendBoard(json, thumb) {
  if (!currentBoard) return;
  // A board mid-load has an empty/partial canvas — shipping that as the
  // board's content is how pushed PDFs used to vanish. Never send it.
  if (wb.loading) return;
  saveIndicator.textContent = 'Saving…';
  if (isSolo) {
    authedFetch(`/api/boards/${currentBoard.id}`, { method: 'POST', body: JSON.stringify({ json, thumb }) })
      .then(savedFlash)
      .catch((e) => { saveIndicator.textContent = ''; toast(e.message); });
  } else if (socket) {
    socket.emit('board:update', { boardId: currentBoard.id, json, thumb }, savedFlash);
  }
}

// Emit any pending debounced change right now (used before switching boards).
// A full-board send supersedes any queued ops, so drop them to avoid
// stale ops landing on the wrong board after a switch.
function flushBoard() {
  const hadOps = wb._ops.length > 0 || wb._needFullSync;
  wb._ops = [];
  wb._needFullSync = false;
  clearTimeout(wb._opsTimer);
  wb._opsTimer = null;
  if (wb._changeTimer || hadOps) {
    clearTimeout(wb._changeTimer);
    wb._changeTimer = null;
    sendBoard(wb.getJSON(), wb.getThumb());
  }
}

(async function init() {
  let cfg = { authEnabled: false };
  try {
    cfg = await (await fetch('/api/config')).json();
  } catch { /* fall through to open mode */ }
  // Signed-in state comes from the server, not from anything this page holds.
  let me = null;
  if (cfg.authEnabled) {
    try {
      const r = await fetch('/api/me', { credentials: 'same-origin' });
      if (r.ok) me = await r.json();
    } catch { /* treated as signed out */ }
    if (!me) { location.href = '/'; return; }
    myName = me.name;
    authToken = true;              // signed in; the cookie does the rest
    googleClientId = cfg.classroomClientId || null;
  } else if (isSolo) {
    location.href = '/'; // personal boards need sign-in
    return;
  } else if (!myName) {
    location.href = '/';
    return;
  }

  document.getElementById('user-label').textContent = isSolo ? myName : `${myName} (${role})`;
  if (me) {
    const perms = Array.isArray(me.perms) ? me.perms : [];
    canPublishBoards = !!me.isSuper || perms.includes('teach') || perms.includes('manage_boards');
  }
  wireBoardsDrawer();
  wireDocuments();
  wireTemplates();
  wireEmbed();

  if (isSolo) {
    statusDot.hidden = true;
    showBoardLoading('Downloading board…');
    try {
      const b = await authedFetch(`/api/boards/${soloBoardId}`);
      setCurrentBoard(b);
      if (b.json) loadBoardWithProgress(b.json);
      else hideBoardLoading();
      hasLoaded = true;
    } catch (e) {
      hideBoardLoading();
      alert(e.message);
      location.href = '/';
    }
    return;
  }

  showBoardLoading('Connecting to your class…');
  socket = io({ withCredentials: true });

  // Room boards sync per-object ops (tiny) instead of the whole board per stroke
  wb.enableOps((ops, thumb) => {
    if (!currentBoard) return;
    if (!socket || !socket.connected) {
      // The strokes stay on the local canvas; remember to push the whole
      // board when the connection returns instead of silently losing them.
      offlineDirty = true;
      saveIndicator.textContent = 'Offline — will save when reconnected';
      return;
    }
    saveIndicator.textContent = 'Saving…';
    const boardId = currentBoard.id;
    socket.emit('board:ops', { boardId, ops, thumb }, (r) => {
      if (r && r.rev && currentBoard && currentBoard.id === boardId) currentBoard.rev = r.rev; // track our own new revision
      savedFlash();
    });
  });
  wb.onChange = () => {}; // whole-board path stays only for reconnect pushes

  socket.on('connect_error', (err) => {
    statusDot.className = 'dot offline';
    if (err.message === 'unauthorized') {
      alert('Your sign-in has expired. Please sign in again.');
      location.href = '/auth/login?return=' + encodeURIComponent(location.pathname + location.search);
    }
  });

  // The server lets a teacher seat go when Signify ID stops listing the person
  // as teaching this class — a substitute whose cover has ended, say.
  socket.on('seat:revoked', (msg) => {
    alert((msg && msg.message) || 'Your access to this class has ended.');
    location.href = '/';
  });

  // While a classroom is open, keep the server's answer about who teaches it
  // current. It only asks Signify ID when a request comes in, and a lesson on
  // the board can go a long time without one.
  if (role === 'teacher' && !window.__seatPing) {
    window.__seatPing = setInterval(() => { fetch('/api/ping', { credentials: 'same-origin' }).catch(() => {}); }, 2 * 60 * 1000);
  }

  socket.on('connect', () => {
    socket.emit('join', { room, name: myName, role }, (res) => {
      if (res.error) {
        alert(res.error);
        location.href = '/';
        return;
      }
      statusDot.className = 'dot online';
      if (res.roomName) document.title = `${res.roomName} — Signify Learning`;
      if (res.name) {
        myName = res.name;
        document.getElementById('user-label').textContent = `${myName} (${role})`;
      }
      boardsList = res.boards || [];
      if (!hasLoaded) {
        hasLoaded = true;
        if (res.activeBoard) {
          setCurrentBoard(boardsList.find((b) => b.id === res.activeBoard.id) || { id: res.activeBoard.id, title: 'Board' });
          if (res.activeBoard.json) loadBoardWithProgress(res.activeBoard.json);
          else hideBoardLoading();
          setBoardComments(res.activeBoard.comments || []);
        } else {
          hideBoardLoading();
        }
        if (role === 'teacher') {
          (res.students || []).forEach((s) => upsertStudent(s));
          setSharing(res.sharing, res.shareBy);
          roomFeatures = res.roomFeatures || {};
          studentFeaturesMap = res.studentFeatures || {};
          if (res.joinCode) joinCode = res.joinCode;
          joinDisabled = !!res.joinDisabled;
          paintCode();
        } else {
          if (res.features) applyFeatures(res.features, false);
          if (res.sharing && res.teacherBoard) studentUI.showShare(res.teacherBoard, res.shareBy);
          refreshStudentAssignments();
        }
        if (res.timer) showTimer(res.timer);
      } else if (currentBoard) {
        // Reconnected mid-session. Only push our canvas up if we actually
        // drew while offline AND the board is fully loaded — blindly sending
        // the local canvas used to wipe boards (empty/partial canvas during a
        // big load, or stomping teacher edits made while we were away).
        if (offlineDirty && !wb.loading) {
          offlineDirty = false;
          sendBoard(wb.getJSON(), wb.getThumb());
        } else if (!wb.loading) {
          // Nothing unsent locally — ask the server for the board, but pass the
          // revision we hold so it can answer "unchanged" and skip the transfer
          // when nothing moved during the blip (avoids a reconnect-storm of
          // full-board pulls).
          loadBoardFull(currentBoard.id, currentBoard.rev).then((b) => {
            if (b.unchanged) { if (currentBoard) currentBoard.rev = b.updatedAt || currentBoard.rev; return; }
            loadBoardWithProgress(b.json, () => setBoardComments(b.comments || []));
            if (currentBoard) currentBoard.rev = b.updatedAt || currentBoard.rev;
          }).catch(() => {});
        }
        // Re-sync the live class state that changed while we were offline:
        // feature locks, a running timer, and any share/spotlight overlay.
        if (role === 'student') {
          if (res.features) applyFeatures(res.features, false);
          if (res.sharing && res.teacherBoard) studentUI.showShare(res.teacherBoard, res.shareBy);
          else if (!res.sharing && studentUI.hideShare) studentUI.hideShare();
          refreshStudentAssignments();
        } else {
          setSharing(res.sharing, res.shareBy);
          roomFeatures = res.roomFeatures || {};
          studentFeaturesMap = res.studentFeatures || {};
        }
        if (res.timer) showTimer(res.timer); else hideTimer();
      }
    });
  });

  socket.on('disconnect', () => {
    statusDot.className = 'dot offline';
    // ops queued but not yet flushed ride along in the next reconnect push
    if (wb._ops.length || wb._needFullSync || wb._opsTimer) offlineDirty = true;
  });

  if (role === 'student') wireStudent();
  else wireTeacher();
  wireCommon();
  wireLiveClassroom();
})();

// ================= LIVE CLASSROOM: timer, picker, reactions =================

let timerInterval = null;
function fmtClock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function showTimer(t) {
  const chip = document.getElementById('timer-chip');
  const time = document.getElementById('timer-time');
  clearInterval(timerInterval);
  const tick = () => {
    const left = t.endsAt - Date.now();
    time.textContent = fmtClock(left);
    chip.classList.toggle('ending', left <= 10000 && left > 0);
    if (left <= 0) {
      clearInterval(timerInterval);
      time.textContent = "Time's up!";
      chip.classList.add('done');
      setTimeout(() => { chip.hidden = true; chip.classList.remove('done'); }, 4000);
    }
  };
  chip.hidden = false;
  chip.classList.remove('done');
  tick();
  timerInterval = setInterval(tick, 250);
}
function hideTimer() {
  clearInterval(timerInterval);
  document.getElementById('timer-chip').hidden = true;
}

const REACTIONS = ['👍', '👏', '❤️', '😂', '🎉', '🤔', '😮', '✅', '❓', '🙋'];
function floatReaction(emoji, name) {
  const layer = document.getElementById('reactions-layer');
  const el = document.createElement('div');
  el.className = 'float-reaction';
  el.textContent = emoji;
  el.style.left = (12 + Math.random() * 60) + '%';
  if (name) { const tag = document.createElement('span'); tag.textContent = name; el.appendChild(tag); }
  layer.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function wireLiveClassroom() {
  // everyone: receive timer / picker / reactions
  socket.on('timer:start', (t) => showTimer(t));
  socket.on('timer:stop', () => hideTimer());
  socket.on('picker:result', (p) => showPicker(p.name));
  socket.on('reaction', (r) => floatReaction(r.emoji, r.name));

  if (role === 'teacher') wireClassroomTeacher();
  // Everyone gets the reaction bar — teachers were the only ones without it,
  // which is why it "disappeared" when signed in as the teacher.
  wireReactionsBar();

  document.getElementById('picker-dismiss').onclick = () => { document.getElementById('picker-overlay').hidden = true; };
}

function wireClassroomTeacher() {
  const btn = document.getElementById('classroom-btn');
  btn.hidden = false;
  const modal = document.getElementById('classroom-modal');
  btn.addEventListener('click', () => { modal.hidden = false; });
  document.getElementById('classroom-close').addEventListener('click', () => { modal.hidden = true; });

  const startTimer = (sec) => {
    socket.emit('timer:start', { seconds: sec }, (r) => { if (!r || !r.ok) toast((r && r.error) || 'Could not start timer.'); });
    modal.hidden = true;
  };
  document.querySelectorAll('.timer-preset').forEach((b) => b.addEventListener('click', () => startTimer(Number(b.dataset.sec))));
  document.getElementById('timer-custom-btn').addEventListener('click', () => {
    const mins = Number(document.getElementById('timer-custom').value);
    if (mins > 0) startTimer(Math.round(mins * 60));
  });
  document.getElementById('timer-stop-btn').addEventListener('click', () => { socket.emit('timer:stop'); modal.hidden = true; });

  document.getElementById('picker-btn').addEventListener('click', () => {
    socket.emit('picker:pick', {}, (r) => {
      if (r && r.ok) { modal.hidden = true; runPickerAnimation(r.picked.name); }
      else toast((r && r.error) || 'No students to pick.');
    });
  });
}

// teacher spins through names before landing (student side just gets the result)
function runPickerAnimation(finalName) {
  const overlay = document.getElementById('picker-overlay');
  const nameEl = document.getElementById('picker-name');
  overlay.hidden = false;
  const names = [...document.querySelectorAll('#student-tiles .tile')].map((t) => t.dataset.name);
  const pool = names.length ? names : [finalName];
  let n = 0;
  const spin = setInterval(() => {
    nameEl.textContent = pool[Math.floor(Math.random() * pool.length)];
    if (++n > 14) { clearInterval(spin); nameEl.textContent = finalName; nameEl.classList.add('landed'); setTimeout(() => nameEl.classList.remove('landed'), 1200); }
  }, 90);
}
function showPicker(name) {
  // students / non-initiators: simple reveal
  const overlay = document.getElementById('picker-overlay');
  if (!overlay.hidden && document.getElementById('picker-name').classList.contains('landed')) return;
  overlay.hidden = false;
  document.getElementById('picker-name').textContent = name;
}

function wireReactionsBar() {
  const bar = document.getElementById('reactions-bar');
  bar.hidden = false;
  REACTIONS.forEach((e) => {
    const b = document.createElement('button');
    b.textContent = e;
    b.title = 'Send reaction';
    b.onclick = () => { socket.emit('reaction:send', { emoji: e }); floatReaction(e, null); };
    bar.appendChild(b);
  });
}

// ---------- live presence: multiplayer cursors ----------
const PRESENCE_COLORS = ['#e5484d', '#0ea5e9', '#f5a623', '#8b5cf6', '#16a34a', '#db2777', '#0d9488', '#d97706'];
const remoteCursors = new Map(); // from -> { el, x, y, seen }
let presenceEmitAt = 0;

function presenceColor(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PRESENCE_COLORS[h % PRESENCE_COLORS.length];
}
function placeCursor(c) {
  const vpt = wb.canvas.viewportTransform; // [zoomX,0,0,zoomY,panX,panY]
  c.el.style.transform = `translate(${c.x * vpt[0] + vpt[4]}px, ${c.y * vpt[3] + vpt[5]}px)`;
}
function positionCursors() { for (const c of remoteCursors.values()) placeCursor(c); }
function removeCursor(from) {
  const c = remoteCursors.get(from);
  if (c) { c.el.remove(); remoteCursors.delete(from); }
}
function clearCursors() { for (const from of [...remoteCursors.keys()]) removeCursor(from); }

function wirePresence() {
  if (isSolo) return; // a personal board has no classmates on it
  const layer = document.getElementById('cursor-layer');
  const canvas = wb.canvas;

  // broadcast my pointer (in scene coords) over whatever board I'm viewing
  canvas.on('mouse:move', (opt) => {
    if (!currentBoard || !socket || !socket.connected) return;
    const now = Date.now();
    if (now - presenceEmitAt < 55) return;
    presenceEmitAt = now;
    const p = canvas.getPointer(opt.e);
    socket.emit('cursor:move', { boardId: currentBoard.id, x: Math.round(p.x), y: Math.round(p.y) });
  });
  canvas.upperCanvasEl.addEventListener('mouseleave', () => {
    if (currentBoard && socket && socket.connected) socket.emit('cursor:hide', { boardId: currentBoard.id });
  });
  canvas.on('after:render', positionCursors); // keep dots glued to the board through pan/zoom

  socket.on('cursor:peer', ({ boardId, from, name, x, y }) => {
    if (!currentBoard || boardId !== currentBoard.id) return;
    let c = remoteCursors.get(from);
    if (!c) {
      const color = presenceColor(from || 'x');
      const el = document.createElement('div');
      el.className = 'remote-cursor';
      el.innerHTML = '<svg viewBox="0 0 16 16" width="20" height="20"><path d="M2 1l11 5.4-4.7 1.4L6 13.6z" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg><span class="rc-name"></span>';
      el.querySelector('path').setAttribute('fill', color);
      const tag = el.querySelector('.rc-name');
      tag.textContent = name || 'Someone';
      tag.style.background = color;
      layer.appendChild(el);
      c = { el };
      remoteCursors.set(from, c);
    }
    c.x = x; c.y = y; c.seen = Date.now();
    placeCursor(c);
  });
  socket.on('cursor:gone', ({ from }) => removeCursor(from));

  setInterval(() => {
    const now = Date.now();
    for (const [from, c] of remoteCursors) if (now - (c.seen || 0) > 5000) removeCursor(from);
  }, 2000);
}

// ---------- board switcher drawer ----------

async function fetchBoardsList() {
  if (isSolo) {
    boardsList = await authedFetch('/api/boards/personal');
  } else {
    boardsList = await new Promise((resolve) => socket.emit('board:list', {}, resolve));
  }
  return boardsList;
}

async function loadBoardFull(id, haveRev) {
  if (isSolo) return authedFetch(`/api/boards/${id}`);
  return new Promise((resolve, reject) => {
    socket.emit('board:load', { boardId: id, haveRev }, (res) => (res && res.ok ? resolve({ ...res.meta, json: res.json, unchanged: res.unchanged }) : reject(new Error((res && res.error) || 'Could not load board.'))));
  });
}

async function switchBoard(id) {
  if (currentBoard && id === currentBoard.id) return;
  flushBoard();
  showBoardLoading('Downloading board…');
  try {
    const b = await loadBoardFull(id);
    setCurrentBoard(b);
    if (b.json) loadBoardWithProgress(b.json);
    else { wb.clear(); wb.resetHistory(); updatePageNav(); hideBoardLoading(); }
    setBoardComments(b.comments || []);
    toast(`Opened "${b.title}"`);
  } catch (e) {
    hideBoardLoading();
    toast(e.message);
  }
}

async function createBoardAndSwitch() {
  if (role === 'student' && !isSolo && !featureOn('newBoards')) {
    toast('Creating new boards is turned off for you right now.');
    return;
  }
  flushBoard();
  try {
    let meta;
    if (isSolo) {
      meta = await authedFetch('/api/boards/personal', { method: 'POST', body: JSON.stringify({}) });
    } else {
      const res = await new Promise((resolve) => socket.emit('board:create', {}, resolve));
      if (!res || !res.ok) throw new Error((res && res.error) || 'Could not create board.');
      meta = res.meta;
    }
    setCurrentBoard(meta);
    wb.clear();
    wb.resetHistory(); // the new board must not be able to Undo back into the previous one
    updatePageNav();
    renderBoardsGrid(await fetchBoardsList());
  } catch (e) {
    toast(e.message);
  }
}

// ---------- template library ----------

let tmplLib = 'public';
let tmplData = [];
// teachers/admins may publish boards to the web; students never can
let canPublishBoards = false;

function wireTemplates() {
  const btn = document.getElementById('templates-btn');
  if (!authToken || (!isSolo && role !== 'teacher')) return; // teachers/admins only
  btn.hidden = false;
  const modal = document.getElementById('templates-modal');
  btn.addEventListener('click', () => { modal.hidden = false; loadTemplates(); });
  document.getElementById('templates-close').addEventListener('click', () => { modal.hidden = true; });
  document.querySelectorAll('.tmpl-tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tmpl-tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    tmplLib = t.dataset.lib;
    renderTemplates();
  }));
  document.getElementById('tmpl-subject').addEventListener('change', renderTemplates);

  // subject dropdowns
  const subjSel = document.getElementById('tmpl-save-subject');
  ['General', 'Math', 'Science', 'English', 'Social Studies', 'Art'].forEach((s) => {
    subjSel.appendChild(new Option(s, s));
    document.getElementById('tmpl-subject').appendChild(new Option(s, s));
  });

  // save-as-template flow
  document.getElementById('tmpl-save').addEventListener('click', () => {
    document.getElementById('templates-modal').hidden = true;
    document.getElementById('tmpl-save-title').value = currentBoard ? currentBoard.title : '';
    updateSaveNote();
    document.getElementById('tmpl-save-modal').hidden = false;
  });
  document.getElementById('tmpl-save-close').addEventListener('click', () => { document.getElementById('tmpl-save-modal').hidden = true; });
  document.getElementById('tmpl-save-scope').addEventListener('change', updateSaveNote);
  document.getElementById('tmpl-save-go').addEventListener('click', saveAsTemplate);
}

function updateSaveNote() {
  const scope = document.getElementById('tmpl-save-scope').value;
  const note = document.getElementById('tmpl-save-note');
  if (scope === 'personal') note.textContent = 'Only you will see this template.';
  else if (scope === 'school') note.textContent = 'Shared with your school. It may need an admin to approve it first.';
  else note.textContent = 'Submitted to the public library for the super admin to review.';
}

async function saveAsTemplate() {
  const title = document.getElementById('tmpl-save-title').value.trim();
  const subject = document.getElementById('tmpl-save-subject').value;
  const scope = document.getElementById('tmpl-save-scope').value;
  if (!title) { toast('Give the template a name.'); return; }
  wb.cancelPending();
  try {
    const r = await authedFetch('/api/templates', { method: 'POST', body: JSON.stringify({ title, subject, scope, json: wb.getJSON(), thumb: wb.getThumb() }) });
    document.getElementById('tmpl-save-modal').hidden = true;
    toast(r.submitted ? 'Template submitted for approval' : 'Template saved');
  } catch (e) { toast(e.message); }
}

async function loadTemplates() {
  try {
    const d = await authedFetch('/api/templates');
    tmplData = d.templates;
    renderTemplates();
  } catch (e) { toast(e.message); }
}

function renderTemplates() {
  const grid = document.getElementById('tmpl-grid');
  const subj = document.getElementById('tmpl-subject').value;
  grid.innerHTML = '';
  let items = tmplData.filter((t) => (tmplLib === 'mine' ? t.mine : t.scope === tmplLib));
  if (subj) items = items.filter((t) => t.subject === subj);
  // pending items an admin can approve float to the top
  items.sort((a, b) => (a.status === 'pending' ? -1 : 0) - (b.status === 'pending' ? -1 : 0) || a.subject.localeCompare(b.subject) || a.title.localeCompare(b.title));
  if (!items.length) { grid.innerHTML = '<p class="hint" style="padding:14px">No templates here yet.</p>'; return; }
  let lastSubj = null;
  for (const t of items) {
    if (t.subject !== lastSubj) {
      lastSubj = t.subject;
      const h = document.createElement('div');
      h.className = 'tmpl-subject-head';
      h.textContent = t.subject;
      grid.appendChild(h);
    }
    const card = document.createElement('div');
    card.className = 'tmpl-card';
    if (t.thumb) { const im = document.createElement('img'); im.alt = ''; im.src = t.thumb; card.appendChild(im); }
    else { const e = document.createElement('div'); e.className = 'tile-empty'; e.textContent = t.title; card.appendChild(e); }
    const foot = document.createElement('div');
    foot.className = 'tmpl-card-foot';
    const nm = document.createElement('div');
    nm.className = 'tmpl-card-name';
    nm.textContent = t.title;
    foot.appendChild(nm);
    const sub = document.createElement('div');
    sub.className = 'tmpl-card-sub';
    sub.textContent = (t.ownerName || '') + (t.status === 'pending' ? ' · pending' : '');
    foot.appendChild(sub);
    const acts = document.createElement('div');
    acts.className = 'tmpl-card-acts';
    const use = document.createElement('button');
    use.className = 'btn-approve';
    use.textContent = 'Use';
    use.onclick = () => useTemplate(t);
    acts.appendChild(use);
    if (t.status === 'pending' && t.canManage) {
      const ap = document.createElement('button');
      ap.className = 'btn-view';
      ap.textContent = 'Approve';
      ap.onclick = async () => { try { await authedFetch(`/api/templates/${t.id}/approve`, { method: 'POST' }); toast('Approved'); loadTemplates(); } catch (e) { toast(e.message); } };
      acts.appendChild(ap);
    }
    if (t.canManage || t.mine) {
      const del = document.createElement('button');
      del.className = 'btn-block';
      del.textContent = '🗑';
      del.onclick = async () => { if (!confirm(`Remove template "${t.title}"?`)) return; try { await authedFetch(`/api/templates/${t.id}`, { method: 'DELETE' }); loadTemplates(); } catch (e) { toast(e.message); } };
      acts.appendChild(del);
    }
    foot.appendChild(acts);
    card.appendChild(foot);
    grid.appendChild(card);
  }
}

async function useTemplate(t) {
  try {
    const full = await authedFetch(`/api/templates/${t.id}`);
    flushBoard();
    let meta;
    if (isSolo) meta = await authedFetch('/api/boards/personal', { method: 'POST', body: JSON.stringify({ title: t.title }) });
    else {
      const res = await new Promise((resolve) => socket.emit('board:create', { title: t.title }, resolve));
      if (!res || !res.ok) throw new Error((res && res.error) || 'Could not create board.');
      meta = res.meta;
    }
    setCurrentBoard(meta);
    loadBoardWithProgress(full.json, () => {
      wb._markFullSync ? wb._markFullSync() : null;
      flushBoard();
    });
    document.getElementById('templates-modal').hidden = true;
    toast(`New board from "${t.title}"`);
  } catch (e) { toast(e.message); }
}

function wireBoardsDrawer() {
  const modal = document.getElementById('boards-modal');
  document.getElementById('boards-context').textContent = isSolo ? ' (not in a class)' : ` in ${room}`;
  document.getElementById('board-title').addEventListener('click', async () => {
    modal.hidden = false;
    try {
      renderBoardsGrid(await fetchBoardsList());
    } catch (e) {
      toast(e.message);
      modal.hidden = true;
    }
  });
  document.getElementById('boards-close').addEventListener('click', () => { modal.hidden = true; });
  document.getElementById('board-new').addEventListener('click', () => createBoardAndSwitch());
  wireTransferModal();
}

function renderBoardsGrid(list) {
  const grid = document.getElementById('boards-grid');
  grid.innerHTML = '';
  for (const b of list) {
    const card = document.createElement('div');
    card.className = 'board-item board-switch-card' + (currentBoard && b.id === currentBoard.id ? ' current' : '');
    card.innerHTML = `<div class="board-item-foot"><span class="board-item-name"></span></div>
      <div class="board-card-actions">
        <button class="btn-view b-open">Open</button>
        <button class="btn-view b-rename" title="Rename">✎</button>
        <button class="btn-view b-dup" title="Duplicate">⧉</button>
        <button class="btn-view b-transfer" title="Copy or move to another class">➜</button>
        <button class="btn-view b-hist" title="Version history">🕘</button>
        <button class="btn-view b-embed" title="Share to the web" hidden>🌐</button>
        <button class="btn-block b-del" title="Delete">🗑</button>
      </div>`;
    card.insertBefore(boardThumbNode(b.thumb, 'Empty board'), card.firstChild);
    card.querySelector('.board-item-name').textContent = b.title + (currentBoard && b.id === currentBoard.id ? ' (open)' : '');
    card.querySelector('.b-open').onclick = async () => { await switchBoard(b.id); document.getElementById('boards-modal').hidden = true; };
    card.querySelector('.b-rename').onclick = async () => {
      const title = prompt('Board name:', b.title);
      if (!title || title === b.title) return;
      try {
        if (isSolo) await authedFetch(`/api/boards/${b.id}`, { method: 'POST', body: JSON.stringify({ title }) });
        else await new Promise((res, rej) => socket.emit('board:rename', { boardId: b.id, title }, (r) => (r && r.ok ? res() : rej(new Error((r && r.error) || 'Rename failed.')))));
        if (currentBoard && currentBoard.id === b.id) setCurrentBoard({ id: b.id, title });
        renderBoardsGrid(await fetchBoardsList());
      } catch (e) { toast(e.message); }
    };
    card.querySelector('.b-dup').onclick = async () => {
      try {
        if (isSolo) await authedFetch(`/api/boards/${b.id}/transfer`, { method: 'POST', body: JSON.stringify({ room: null, mode: 'copy' }) });
        else await new Promise((res, rej) => socket.emit('board:duplicate', { boardId: b.id }, (r) => (r && r.ok ? res() : rej(new Error((r && r.error) || 'Duplicate failed.')))));
        toast('Board duplicated');
        renderBoardsGrid(await fetchBoardsList());
      } catch (e) { toast(e.message); }
    };
    card.querySelector('.b-transfer').onclick = () => openTransferModal(b);
    card.querySelector('.b-hist').onclick = () => openHistoryModal(b);
    // publishing is teachers/admins only, and honours the 'embed' feature switch
    const embedBtn = card.querySelector('.b-embed');
    if (authToken && canPublishBoards && featureOn('embed')) {
      embedBtn.hidden = false;
      if (b.embed) embedBtn.classList.add('published');
      embedBtn.title = b.embed ? 'Shared to the web — manage link' : 'Share to the web';
      embedBtn.onclick = () => openEmbedModal(b);
    }
    card.querySelector('.b-del').onclick = async () => {
      if (!confirm(`Delete "${b.title}"? This cannot be undone.`)) return;
      try {
        if (isSolo) await authedFetch(`/api/boards/${b.id}`, { method: 'DELETE' });
        else await new Promise((res, rej) => socket.emit('board:delete', { boardId: b.id }, (r) => (r && r.ok ? res() : rej(new Error((r && r.error) || 'Delete failed.')))));
        const list2 = await fetchBoardsList();
        if (currentBoard && currentBoard.id === b.id) {
          if (list2.length) await switchBoard(list2[0].id);
          else await createBoardAndSwitch();
        }
        renderBoardsGrid(await fetchBoardsList());
        toast('Board deleted');
      } catch (e) { toast(e.message); }
    };
    grid.appendChild(card);
  }
}

// ----- share a board to the web (read-only live embed) -----

let embedBoard = null;

function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
}

function embedOpts() {
  return {
    w: clampInt(document.getElementById('embed-w').value, 200, 4000, 800),
    h: clampInt(document.getElementById('embed-h').value, 200, 4000, 600),
    fit: document.getElementById('embed-fit').value,
    start: clampInt(document.getElementById('embed-start').value, 1, 999, 1),
    nav: document.getElementById('embed-nav').checked,
    autoplay: document.getElementById('embed-autoplay').checked,
  };
}

function embedUrl(token) {
  const o = embedOpts();
  const p = new URLSearchParams();
  if (o.fit === 'all') p.set('fit', 'all');
  else if (o.start > 1) p.set('page', String(o.start));
  if (!o.nav) p.set('nav', '0');
  if (o.autoplay) p.set('autoplay', '1');
  const qs = p.toString();
  return `${location.origin}/embed/${token}${qs ? '?' + qs : ''}`;
}

function embedSnippet(token) {
  const o = embedOpts();
  return `<iframe src="${embedUrl(token)}" width="${o.w}" height="${o.h}" style="border:1px solid #E4E2DD;border-radius:6px" allowfullscreen title="Signify Learning board"></iframe>`;
}

function paintEmbedState(tok) {
  document.getElementById('embed-off').hidden = !!tok;
  document.getElementById('embed-on').hidden = !tok;
  if (tok) {
    // The plain public link stays canonical; the embed code carries the options.
    document.getElementById('embed-url').value = `${location.origin}/embed/${tok}`;
    document.getElementById('embed-code').value = embedSnippet(tok);
    // Start-page only matters when opening on the first page
    document.getElementById('embed-start').disabled = document.getElementById('embed-fit').value === 'all';
  }
}

async function openEmbedModal(b) {
  embedBoard = b;
  document.getElementById('embed-board-title').textContent = b.title;
  paintEmbedState(b.embed && b.embed.token);
  document.getElementById('embed-modal').hidden = false;
}

function wireEmbed() {
  document.getElementById('embed-close').addEventListener('click', () => { document.getElementById('embed-modal').hidden = true; });
  // Any option change rebuilds the embed snippet in place
  ['embed-w', 'embed-h', 'embed-fit', 'embed-start', 'embed-nav', 'embed-autoplay'].forEach((id) => {
    document.getElementById(id).addEventListener('input', () => {
      const tok = embedBoard && embedBoard.embed && embedBoard.embed.token;
      if (tok) paintEmbedState(tok);
    });
  });
  document.getElementById('embed-publish').addEventListener('click', async () => {
    if (!embedBoard) return;
    try {
      const r = await authedFetch(`/api/boards/${embedBoard.id}/embed`, { method: 'POST' });
      embedBoard.embed = { token: r.token };
      paintEmbedState(r.token);
      toast('Board published — anyone with the link can view it');
      fetchBoardsList().then(renderBoardsGrid).catch(() => {});
    } catch (e) { toast(e.message); }
  });
  document.getElementById('embed-revoke').addEventListener('click', async () => {
    if (!embedBoard || !confirm('Unpublish this board? The link and any embeds stop working immediately.')) return;
    try {
      await authedFetch(`/api/boards/${embedBoard.id}/embed`, { method: 'DELETE' });
      embedBoard.embed = null;
      paintEmbedState(null);
      toast('Board unpublished');
      fetchBoardsList().then(renderBoardsGrid).catch(() => {});
    } catch (e) { toast(e.message); }
  });
  document.getElementById('embed-copy').addEventListener('click', async () => {
    const code = document.getElementById('embed-code').value;
    try { await navigator.clipboard.writeText(code); toast('Embed code copied'); }
    catch { document.getElementById('embed-code').select(); toast('Press Ctrl/⌘+C to copy'); }
  });
  document.getElementById('embed-open').addEventListener('click', () => {
    const tok = embedBoard && embedBoard.embed && embedBoard.embed.token;
    if (tok) window.open(`/embed/${tok}`, '_blank', 'noopener');
  });
}

// ----- version history -----

async function historyVersions(id) {
  if (isSolo) return (await authedFetch(`/api/boards/${id}/history`)).versions;
  return new Promise((res, rej) => socket.emit('board:history', { boardId: id }, (r) =>
    (r && r.ok ? res(r.versions) : rej(new Error((r && r.error) || 'No access.')))));
}

async function historyRestoreVersion(id, ts) {
  if (isSolo) return (await authedFetch(`/api/boards/${id}/restore`, { method: 'POST', body: JSON.stringify({ ts }) })).json;
  return new Promise((res, rej) => socket.emit('board:restore', { boardId: id, ts }, (r) =>
    (r && r.ok ? res(r.json) : rej(new Error((r && r.error) || 'Restore failed.')))));
}

async function openHistoryModal(b) {
  document.getElementById('history-board-title').textContent = b.title;
  const list = document.getElementById('history-list');
  list.innerHTML = '<p class="hint">Loading…</p>';
  document.getElementById('history-modal').hidden = false;
  try {
    const versions = await historyVersions(b.id);
    list.innerHTML = '';
    if (!versions.length) {
      list.innerHTML = '<p class="hint">No snapshots yet — they appear once a board has been edited for a while.</p>';
      return;
    }
    for (const ts of versions) {
      const when = new Date(ts);
      const row = document.createElement('div');
      row.className = 'roster-row';
      row.innerHTML = '<span class="roster-who"><span class="roster-name"></span></span>';
      row.querySelector('.roster-name').textContent = when.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const btn = document.createElement('button');
      btn.className = 'btn-approve';
      btn.textContent = 'Restore';
      btn.onclick = async () => {
        if (!confirm(`Restore "${b.title}" to ${when.toLocaleString()}? The current version is snapshotted first, so this is reversible.`)) return;
        try {
          const json = await historyRestoreVersion(b.id, ts);
          if (currentBoard && currentBoard.id === b.id) loadBoardWithProgress(json);
          document.getElementById('history-modal').hidden = true;
          document.getElementById('boards-modal').hidden = true;
          toast('Board restored');
        } catch (e) { toast(e.message); }
      };
      row.appendChild(btn);
      list.appendChild(row);
    }
  } catch (e) {
    list.innerHTML = '';
    toast(e.message);
  }
}
document.getElementById('history-close').addEventListener('click', () => {
  document.getElementById('history-modal').hidden = true;
});

// ----- copy / move to another class -----

let transferBoard = null;

function wireTransferModal() {
  document.getElementById('transfer-close').addEventListener('click', () => {
    document.getElementById('transfer-modal').hidden = true;
  });
  document.getElementById('transfer-copy').addEventListener('click', () => doTransfer('copy'));
  document.getElementById('transfer-move').addEventListener('click', () => doTransfer('move'));
}

async function openTransferModal(board) {
  transferBoard = board;
  const modal = document.getElementById('transfer-modal');
  document.getElementById('transfer-title').textContent = `Copy or move "${board.title}"`;
  const sel = document.getElementById('transfer-dest');
  sel.innerHTML = '';
  if (authToken) {
    sel.appendChild(new Option('My boards (no class)', ''));
    try {
      const mine = await authedFetch('/api/my/rooms');
      const seen = new Set();
      for (const r of [...mine.teaching, ...mine.enrolled]) {
        if (seen.has(r.code)) continue;
        seen.add(r.code);
        sel.appendChild(new Option(`${r.code}${r.name ? ' — ' + r.name : ''}`, r.code));
      }
    } catch { /* rooms list optional */ }
    modal.hidden = false;
  } else {
    // open mode: no account, just ask for a room code
    const code = prompt('Room code to copy this board to:');
    if (!code) return;
    socket.emit('board:transfer', { boardId: board.id, room: code, mode: 'copy' }, (r) => {
      toast(r && r.ok ? `Copied to ${code.toUpperCase()}` : (r && r.error) || 'Copy failed.');
    });
  }
}

async function doTransfer(mode) {
  if (!transferBoard) return;
  const dest = document.getElementById('transfer-dest').value || null;
  try {
    let res;
    if (isSolo) {
      res = await authedFetch(`/api/boards/${transferBoard.id}/transfer`, { method: 'POST', body: JSON.stringify({ room: dest, mode }) });
    } else {
      const r = await new Promise((resolve) => socket.emit('board:transfer', { boardId: transferBoard.id, room: dest, mode }, resolve));
      if (!r || !r.ok) throw new Error((r && r.error) || 'Transfer failed.');
      res = r.meta;
    }
    void res;
    const destLabel = dest || 'My boards';
    toast(mode === 'move' ? `Moved to ${destLabel}` : `Copied to ${destLabel}`);
    document.getElementById('transfer-modal').hidden = true;
    const list = await fetchBoardsList();
    if (mode === 'move' && currentBoard && currentBoard.id === transferBoard.id) {
      if (list.length) await switchBoard(list[0].id);
      else await createBoardAndSwitch();
    }
    renderBoardsGrid(list);
  } catch (e) {
    toast(e.message);
  }
}

// ---------- documents (PDF + converted office files) ----------

function wireDocuments() {
  const input = document.getElementById('doc-input');
  document.getElementById('doc-btn').addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.value = '';
    if (!file || !featureOn('documents')) return;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    try {
      let pdfData;
      if (ext === 'pdf') {
        pdfData = await file.arrayBuffer();
      } else {
        toast(`Converting ${file.name}…`);
        const res = await fetch(`/api/convert?ext=${ext}`, {
          method: 'POST',
          credentials: 'same-origin',
          body: file,
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error || 'Conversion failed.');
        }
        pdfData = await res.arrayBuffer();
      }
      const rendered = await renderPdf(pdfData, file.name);
      choosePlacement(rendered);
    } catch (e) {
      toast(e.message);
    }
  });

  document.getElementById('page-prev').addEventListener('click', () => wb.gotoDocPage(wb.getCurrentDocPage() - 1));
  document.getElementById('page-next').addEventListener('click', () => wb.gotoDocPage(wb.getCurrentDocPage() + 1));
  document.getElementById('page-add').addEventListener('click', () => { wb.addBlankPage(); updatePageNav(); });
  document.getElementById('margin-more').addEventListener('click', () => { wb.setDocMargin(wb.getDocMargin() + 40); });
  document.getElementById('margin-less').addEventListener('click', () => { wb.setDocMargin(wb.getDocMargin() - 40); });

  // The placement choice modal (as a document vs. movable objects)
  const modal = document.getElementById('docmode-modal');
  const close = () => { modal.hidden = true; pendingDoc = null; };
  document.getElementById('docmode-cancel').addEventListener('click', close);
  document.getElementById('docmode-doc').addEventListener('click', () => {
    if (!pendingDoc) return; const d = pendingDoc; close();
    wb.addDocumentPages(d.urls, (n) => {
      toast(`Added ${n} page${n === 1 ? '' : 's'}${d.capped ? ' (capped at ' + MAX_DOC_PAGES + ')' : ''}. It's fenced in now — scroll and zoom freely, add pages with ＋ Page.`);
      updatePageNav();
    });
  });
  document.getElementById('docmode-object').addEventListener('click', () => {
    if (!pendingDoc) return; const d = pendingDoc; close();
    wb.addDocumentObjects(d.urls, (n) => {
      toast(`Placed ${n} page${n === 1 ? '' : 's'} on the board — drag, resize, or delete them like any object.`);
      updatePageNav();
    });
  });
}

const MAX_DOC_PAGES = 40;
let pendingDoc = null; // { urls, capped, name } awaiting a placement choice

// Render a PDF to page image data-URLs (does not place them yet)
async function renderPdf(arrayBuffer, name) {
  if (!window.pdfjsLib) throw new Error('PDF renderer failed to load.');
  const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pages = Math.min(doc.numPages, MAX_DOC_PAGES);
  const urls = [];
  for (let i = 1; i <= pages; i++) {
    toast(`Rendering page ${i}/${pages}…`);
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1.5 });
    const c = document.createElement('canvas');
    c.width = viewport.width;
    c.height = viewport.height;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    // 'print' intent renders without requestAnimationFrame scheduling,
    // so it also completes in throttled/background tabs
    await page.render({ canvasContext: ctx, viewport, intent: 'print' }).promise;
    urls.push(c.toDataURL('image/jpeg', 0.85));
  }
  return { urls, capped: doc.numPages > pages, name: name || 'document' };
}

// Ask the teacher/student how to place the just-rendered document
function choosePlacement(rendered) {
  pendingDoc = rendered;
  document.getElementById('docmode-name').textContent = rendered.name;
  document.getElementById('docmode-modal').hidden = false;
}

function updatePageNav() {
  const count = wb.getDocPages().length;
  const docMode = wb.isDocMode && wb.isDocMode();
  const show = count > 0 && docMode;
  ['page-prev', 'page-next', 'page-add', 'margin-more', 'margin-less'].forEach((id) => {
    document.getElementById(id).hidden = !show;
  });
  const label = document.getElementById('page-label');
  label.hidden = !show;
  if (show) label.textContent = `${wb.getCurrentDocPage()}/${count}`;
}

// ---------- toolbar ----------

document.querySelectorAll('.tool[data-tool]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tool[data-tool], #shapes-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    wb.setTool(btn.dataset.tool);
    document.getElementById('hand-mode').hidden = btn.dataset.tool !== 'pan';
    document.getElementById('eraser-mode').hidden = btn.dataset.tool !== 'eraser';
    document.getElementById('shapes-menu').hidden = true;
    refreshCtx();
  });
});

// ----- shapes flyout: one button, many shapes -----
const SHAPE_ICONS = { rect: '▭', ellipse: '◯', triangle: '△', diamond: '◇', pentagon: '⬠', hexagon: '⬡', star: '☆' };
let currentShape = 'rect';
const shapesBtn = document.getElementById('shapes-btn');
const shapesMenu = document.getElementById('shapes-menu');
shapesBtn.addEventListener('click', () => {
  const r = shapesBtn.getBoundingClientRect();
  shapesMenu.style.top = Math.min(r.top, window.innerHeight - 90) + 'px';
  // sit just past the (now floating) toolbar's right edge so it never overlaps it
  shapesMenu.style.left = (document.getElementById('toolbar').getBoundingClientRect().right + 8) + 'px';
  if (shapesBtn.classList.contains('active')) {
    shapesMenu.hidden = !shapesMenu.hidden; // second tap opens the picker
  } else {
    activateShape(currentShape);
    shapesMenu.hidden = false;
  }
});
document.querySelectorAll('.shape-opt').forEach((b) => {
  b.addEventListener('click', () => {
    currentShape = b.dataset.shape;
    activateShape(currentShape);
    shapesMenu.hidden = true;
  });
});
function activateShape(shape) {
  document.querySelectorAll('.tool[data-tool]').forEach((x) => x.classList.remove('active'));
  shapesBtn.classList.add('active');
  shapesBtn.textContent = SHAPE_ICONS[shape];
  shapesBtn.title = `Shape: ${shape} — drag to draw, click again for more shapes`;
  wb.setTool(shape);
  document.getElementById('hand-mode').hidden = true;
  document.getElementById('eraser-mode').hidden = true;
  refreshCtx();
}
document.addEventListener('click', (e) => {
  if (!shapesMenu.hidden && !shapesMenu.contains(e.target) && e.target !== shapesBtn) shapesMenu.hidden = true;
});

// ----- eraser mode pill -----
document.getElementById('eraser-object').addEventListener('click', () => setEraserModeUI('object'));
document.getElementById('eraser-partial').addEventListener('click', () => setEraserModeUI('partial'));
function setEraserModeUI(mode) {
  wb.setEraserMode(mode);
  document.getElementById('eraser-object').classList.toggle('active', mode === 'object');
  document.getElementById('eraser-partial').classList.toggle('active', mode === 'partial');
}
if (!window.fabric || !fabric.EraserBrush) document.getElementById('eraser-partial').hidden = true;

// ----- finger vs stylus on touch screens -----
const touchToggle = document.getElementById('touch-toggle');
if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
  touchToggle.hidden = false;
  const paintTouch = () => { touchToggle.textContent = wb.fingerPans ? 'Finger: pans' : 'Finger: draws'; };
  touchToggle.addEventListener('click', () => { wb.setFingerPans(!wb.fingerPans); paintTouch(); });
  paintTouch();
}

// Hand tool mode: pan the board vs. manipulate objects
document.getElementById('hand-board').addEventListener('click', () => setHandModeUI('board'));
document.getElementById('hand-objects').addEventListener('click', () => setHandModeUI('objects'));
function setHandModeUI(mode) {
  wb.setHandMode(mode);
  document.getElementById('hand-board').classList.toggle('active', mode === 'board');
  document.getElementById('hand-objects').classList.toggle('active', mode === 'objects');
}

function activateTool(t) {
  const btn = document.querySelector(`.tool[data-tool="${t}"]`);
  if (btn) btn.click();
}

const colorInput = document.getElementById('color-input');
document.querySelectorAll('.swatch').forEach((sw) => {
  sw.addEventListener('click', () => {
    document.querySelectorAll('.swatch').forEach((s) => s.classList.remove('active'));
    sw.classList.add('active');
    colorInput.value = sw.dataset.color;
    wb.setColor(sw.dataset.color);
  });
});
colorInput.addEventListener('input', () => {
  document.querySelectorAll('.swatch').forEach((s) => s.classList.remove('active'));
  wb.setColor(colorInput.value);
});

document.getElementById('width-input').addEventListener('input', (e) => {
  wb.setStrokeWidth(Number(e.target.value));
});
document.getElementById('opacity-input').addEventListener('input', (e) => {
  wb.setOpacity(Number(e.target.value) / 100);
});

// line-style cycle: solid -> dashed -> dotted
const LINE_STYLES = ['solid', 'dashed', 'dotted'];
const LINE_DASH = { solid: '', dashed: '5,3', dotted: '1,3' };
let lineStyleIdx = 0;
document.getElementById('linestyle-btn').addEventListener('click', () => {
  lineStyleIdx = (lineStyleIdx + 1) % 3;
  const style = LINE_STYLES[lineStyleIdx];
  wb.setLineStyle(style);
  const line = document.querySelector('#linestyle-btn line');
  line.setAttribute('stroke-dasharray', LINE_DASH[style]);
  line.setAttribute('stroke-linecap', style === 'dotted' ? 'round' : 'butt');
  document.getElementById('linestyle-btn').title = `Line style: ${style} (click to change)`;
  toast(`Line style: ${style}`);
});
document.getElementById('fill-input').addEventListener('change', (e) => {
  wb.setFillShapes(e.target.checked);
});

// ----- insert flyout: image / document / ruler / graph / chart -----
const insertBtn = document.getElementById('insert-btn');
const insertMenu = document.getElementById('insert-menu');
insertBtn.addEventListener('click', () => {
  insertMenu.style.top = Math.min(insertBtn.getBoundingClientRect().top, window.innerHeight - 200) + 'px';
  insertMenu.hidden = !insertMenu.hidden;
});
insertMenu.addEventListener('click', () => { insertMenu.hidden = true; }); // any pick closes it
document.addEventListener('click', (e) => {
  if (!insertMenu.hidden && !insertMenu.contains(e.target) && e.target !== insertBtn) insertMenu.hidden = true;
});

const imageInput = document.getElementById('image-input');
document.getElementById('image-btn').addEventListener('click', () => imageInput.click());
imageInput.addEventListener('change', () => {
  if (imageInput.files[0] && featureOn('images')) wb.addImageFile(imageInput.files[0]);
  imageInput.value = '';
});

document.getElementById('ruler-btn').addEventListener('click', () => wb.addRuler());

// ----- coordinate graph -----
const graphModal = document.getElementById('graph-modal');
document.getElementById('graph-btn').addEventListener('click', () => { graphModal.hidden = false; });
document.getElementById('graph-close').addEventListener('click', () => { graphModal.hidden = true; });
document.getElementById('graph-insert').addEventListener('click', () => {
  const num = (id, d) => { const v = parseFloat(document.getElementById(id).value); return Number.isFinite(v) ? v : d; };
  wb.addGraph({
    xMin: num('graph-xmin', -10), xMax: num('graph-xmax', 10),
    yMin: num('graph-ymin', -10), yMax: num('graph-ymax', 10),
    xLabel: document.getElementById('graph-xlabel').value || 'x',
    yLabel: document.getElementById('graph-ylabel').value || 'y',
    title: document.getElementById('graph-title').value.trim(),
  });
  graphModal.hidden = true;
});

// ----- math equation editor (MathJax SVG, lazy-loaded) -----
let mathjaxPromise = null;
function ensureMathJax() {
  if (mathjaxPromise) return mathjaxPromise;
  mathjaxPromise = new Promise((resolve, reject) => {
    // fontCache:'none' inlines every glyph path so the SVG is self-contained for fabric
    window.MathJax = {
      loader: { load: ['[tex]/ams'] },
      tex: { packages: { '[+]': ['ams'] } },
      svg: { fontCache: 'none' },
      startup: { typeset: false },
    };
    const s = document.createElement('script');
    s.src = '/vendor/mathjax-tex-svg.js';
    s.async = true;
    s.onload = () => {
      if (window.MathJax && window.MathJax.startup && window.MathJax.startup.promise) {
        window.MathJax.startup.promise.then(resolve).catch(reject);
      } else resolve();
    };
    s.onerror = () => reject(new Error('Could not load the math renderer.'));
    document.head.appendChild(s);
  });
  return mathjaxPromise;
}

function renderEquationSVG(latex) {
  // returns an SVG string, or throws on a TeX error
  const node = window.MathJax.tex2svg(latex, { display: true });
  const svg = node.querySelector('svg');
  if (!svg) throw new Error('No output');
  const err = svg.querySelector('[data-mml-node="merror"], .merror');
  if (err) throw new Error('TeX error');
  return svg.outerHTML;
}

const EQN_SYMBOLS = [
  ['x²', 'x^{2}'], ['√', '\\sqrt{ }'], ['⁄', '\\frac{ }{ }'], ['π', '\\pi'],
  ['θ', '\\theta'], ['≤', '\\leq'], ['≥', '\\geq'], ['≠', '\\neq'],
  ['±', '\\pm'], ['×', '\\times'], ['÷', '\\div'], ['∑', '\\sum'],
  ['∫', '\\int'], ['∞', '\\infty'], ['→', '\\rightarrow'], ['°', '^{\\circ}'],
];

(function wireEquationEditor() {
  const modal = document.getElementById('equation-modal');
  const btn = document.getElementById('equation-btn');
  const input = document.getElementById('eqn-input');
  const preview = document.getElementById('eqn-preview');
  const insertBtnEl = document.getElementById('eqn-insert');
  const symbols = document.getElementById('eqn-symbols');
  if (!modal || !btn) return;

  for (const [label, tex] of EQN_SYMBOLS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'eqn-sym';
    b.textContent = label;
    b.title = tex.trim();
    b.addEventListener('click', () => {
      const s = input.selectionStart || input.value.length;
      input.value = input.value.slice(0, s) + tex + input.value.slice(input.selectionEnd || s);
      input.focus();
      input.selectionStart = input.selectionEnd = s + tex.length;
      schedulePreview();
    });
    symbols.appendChild(b);
  }

  let lastSVG = null;
  let previewTimer = null;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(runPreview, 220);
  }
  async function runPreview() {
    const latex = input.value.trim();
    lastSVG = null;
    insertBtnEl.disabled = true;
    if (!latex) { preview.innerHTML = '<span class="hint">Your equation appears here.</span>'; return; }
    try {
      await ensureMathJax();
      const svg = renderEquationSVG(latex);
      lastSVG = svg;
      preview.innerHTML = svg;
      insertBtnEl.disabled = false;
    } catch {
      preview.innerHTML = '<span class="eqn-err">Check your LaTeX — that didn\'t render.</span>';
    }
  }
  input.addEventListener('input', schedulePreview);

  btn.addEventListener('click', () => {
    if (!featureOn('charts')) return;
    modal.hidden = false;
    input.focus();
    ensureMathJax().catch(() => { preview.innerHTML = '<span class="eqn-err">Math renderer failed to load.</span>'; });
    if (input.value.trim()) runPreview();
  });
  document.getElementById('equation-close').addEventListener('click', () => { modal.hidden = true; });
  insertBtnEl.addEventListener('click', async () => {
    if (!lastSVG) return;
    try {
      await wb.addEquation(lastSVG, wb.color || '#1f2937');
      modal.hidden = true;
    } catch {
      toast('Could not insert that equation.');
    }
  });
})();

// ----- CSV charts -----
const chartModal = document.getElementById('chart-modal');
const csvInput = document.getElementById('csv-input');
let csvData = null; // { headers, rows }
let chartType = 'bar';

document.getElementById('chart-btn').addEventListener('click', () => csvInput.click());
csvInput.addEventListener('change', () => {
  const file = csvInput.files[0];
  csvInput.value = '';
  if (!file || !featureOn('charts')) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      csvData = parseCSV(reader.result);
      if (csvData.headers.length < 2 || !csvData.rows.length) throw new Error('Need a label column and at least one value column.');
      openChartModal();
    } catch (e) {
      toast('CSV: ' + e.message);
    }
  };
  reader.readAsText(file);
});

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', q = false;
  const push = () => { row.push(field); field = ''; };
  const endRow = () => { push(); if (row.some((c) => c !== '')) rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') push();
    else if (c === '\n') endRow();
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) endRow();
  if (!rows.length) throw new Error('empty file');
  return { headers: rows[0].map((h) => h.trim()), rows: rows.slice(1) };
}

function openChartModal() {
  const labelSel = document.getElementById('chart-labelcol');
  labelSel.innerHTML = '';
  csvData.headers.forEach((h, i) => labelSel.appendChild(new Option(h || `Column ${i + 1}`, String(i))));
  labelSel.value = '0';
  const valWrap = document.getElementById('chart-valcols');
  valWrap.innerHTML = '';
  csvData.headers.forEach((h, i) => {
    const numeric = csvData.rows.some((r) => r[i] !== undefined && r[i] !== '' && Number.isFinite(parseFloat(String(r[i]).replace(/[$£€,%\s]/g, ''))));
    if (!numeric) return;
    const id = 'valcol-' + i;
    const label = document.createElement('label');
    label.className = 'chk';
    label.innerHTML = `<input type="checkbox" id="${id}" value="${i}" ${i === 1 ? 'checked' : ''}> <span></span>`;
    label.querySelector('span').textContent = h || `Column ${i + 1}`;
    valWrap.appendChild(label);
  });
  updateChartSummary();
  chartModal.hidden = false;
}

document.querySelectorAll('.chart-type').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.chart-type').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    chartType = b.dataset.type;
    updateChartSummary();
  });
});
document.getElementById('chart-labelcol').addEventListener('change', updateChartSummary);
document.getElementById('chart-valcols').addEventListener('change', updateChartSummary);
document.getElementById('chart-close').addEventListener('click', () => { chartModal.hidden = true; });

function selectedValCols() {
  return [...document.querySelectorAll('#chart-valcols input:checked')].map((c) => Number(c.value));
}

// Parse a cell to a number, tolerating thousands separators and currency/percent symbols
function cellNum(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[$£€,%\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function updateChartSummary() {
  const cols = selectedValCols();
  const s = document.getElementById('chart-summary');
  if (chartType === 'pie' && cols.length > 1) s.textContent = 'Pie charts use the first selected value column only.';
  else s.textContent = `${csvData.rows.length} rows · ${cols.length} value column${cols.length === 1 ? '' : 's'}.`;
}

document.getElementById('chart-insert').addEventListener('click', () => {
  const labelCol = Number(document.getElementById('chart-labelcol').value);
  let cols = selectedValCols();
  if (!cols.length) { toast('Pick at least one value column.'); return; }
  if (chartType === 'pie') cols = cols.slice(0, 1);
  const labels = csvData.rows.map((r) => (r[labelCol] || '').trim() || '—');
  const series = cols.map((ci) => csvData.rows.map((r) => cellNum(r[ci])));
  const seriesNames = cols.map((ci) => csvData.headers[ci] || `Column ${ci + 1}`);
  wb.addChart({ type: chartType, title: document.getElementById('chart-title').value.trim(), labels, series, seriesNames });
  chartModal.hidden = true;
  toast('Chart added');
});

// ----- rich text floating toolbar -----
const textToolbar = document.getElementById('text-toolbar');
// Hold the toolbar still while it's in use. It used to re-center on the text
// after every click, so pressing A+ widened the text, slid the toolbar sideways,
// and the next click landed on the wrong button. It re-anchors above the text
// once the mouse leaves it (or, on touch, shortly after the last tap).
let ttHover = false;
let ttHoldUntil = 0;
let ttReleaseTimer = null;
function ttHeld() {
  return !textToolbar.hidden && (ttHover || Date.now() < ttHoldUntil);
}
function ttRelease() { if (!ttHeld()) updateTextToolbar(); }
function updateTextToolbar() {
  const o = wb.getActiveText();
  if (!o) { textToolbar.hidden = true; return; }
  if (!ttHeld()) {
    const r = o.getBoundingRect();
    textToolbar.hidden = false;
    const tw = textToolbar.offsetWidth || 240;
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(6, Math.min(left, canvasWrap.clientWidth - tw - 6));
    textToolbar.style.left = left + 'px';
    textToolbar.style.top = Math.max(4, r.top - 44) + 'px';
  }
  document.getElementById('tt-bold').classList.toggle('on', wb.getTextStyleValue('fontWeight') === 'bold' || wb.getTextStyleValue('fontWeight') === 700);
  document.getElementById('tt-italic').classList.toggle('on', wb.getTextStyleValue('fontStyle') === 'italic');
  document.getElementById('tt-underline').classList.toggle('on', wb.getTextStyleValue('underline') === true);
}
[textToolbar, document.getElementById('tt-font-menu')].forEach((el) => {
  el.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') ttHover = true; });
  el.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'mouse') return;
    ttHover = false;
    ttRelease();
  });
  // pointerdown fires before the buttons' mousedown handlers, so the hold is in
  // place before they resize the text and ask the toolbar to reposition. A mouse
  // is held by hovering; touch has no hover, so taps hold it for a moment.
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') { ttHover = true; return; }
    ttHoldUntil = Date.now() + 1500;
    clearTimeout(ttReleaseTimer);
    ttReleaseTimer = setTimeout(ttRelease, 1600);
  });
});
document.getElementById('tt-bold').addEventListener('mousedown', (e) => { e.preventDefault(); wb.toggleTextStyle('fontWeight', 'bold', 'normal'); updateTextToolbar(); });
document.getElementById('tt-italic').addEventListener('mousedown', (e) => { e.preventDefault(); wb.toggleTextStyle('fontStyle', 'italic', 'normal'); updateTextToolbar(); });
document.getElementById('tt-underline').addEventListener('mousedown', (e) => { e.preventDefault(); wb.toggleTextStyle('underline', true, false); updateTextToolbar(); });
document.getElementById('tt-smaller').addEventListener('mousedown', (e) => { e.preventDefault(); wb.changeTextSize(-4); updateTextToolbar(); });
document.getElementById('tt-bigger').addEventListener('mousedown', (e) => { e.preventDefault(); wb.changeTextSize(4); updateTextToolbar(); });
document.getElementById('tt-color').addEventListener('mousedown', (e) => { e.preventDefault(); wb.applyTextStyle({ fill: wb.color }); });

// font picker (buttons, not a <select>, so text editing keeps focus).
// Bricolage Grotesque is intentionally excluded: Fabric mis-measures that
// variable display font per character, so its typing caret drifts. These
// system fonts all measure exactly as they render.
const TEXT_FONTS = ['Arial', 'Georgia', 'Times New Roman', 'Courier New', 'Comic Sans MS', 'Verdana'];
const fontMenu = document.getElementById('tt-font-menu');
TEXT_FONTS.forEach((f) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = f;
  b.style.fontFamily = f;
  b.addEventListener('mousedown', (e) => {
    e.preventDefault();
    wb.applyTextStyle({ fontFamily: f });
    fontMenu.hidden = true;
    updateTextToolbar();
  });
  fontMenu.appendChild(b);
});
document.getElementById('tt-font').addEventListener('mousedown', (e) => {
  e.preventDefault();
  const tb = document.getElementById('text-toolbar');
  fontMenu.hidden = !fontMenu.hidden;
  fontMenu.style.left = tb.style.left;
  fontMenu.style.top = (parseInt(tb.style.top, 10) + 38) + 'px';
});
['selection:created', 'selection:updated', 'selection:cleared', 'object:moving', 'object:scaling'].forEach((ev) =>
  wb.canvas.on(ev, updateTextToolbar));
wb.canvas.on('text:editing:entered', updateTextToolbar);
wb.canvas.on('text:editing:exited', () => { textToolbar.hidden = true; document.getElementById('tt-font-menu').hidden = true; });
wb.canvas.on('text:selection:changed', updateTextToolbar);
wb.canvas.on('mouse:up', () => { if (wb.getActiveText()) updateTextToolbar(); });
document.getElementById('undo-btn').addEventListener('click', () => { wb.undo(); updatePageNav(); });
document.getElementById('redo-btn').addEventListener('click', () => { wb.redo(); updatePageNav(); });
document.getElementById('delete-btn').addEventListener('click', () => wb.deleteSelection());

// ---------- top bar ----------

document.getElementById('zoom-in').addEventListener('click', () => wb.zoomBy(1.25));
document.getElementById('zoom-out').addEventListener('click', () => wb.zoomBy(0.8));
document.getElementById('zoom-label').addEventListener('click', () => wb.resetZoom());
document.getElementById('zoom-fit').addEventListener('click', () => wb.fitContent());

const dlMenu = document.getElementById('download-menu');
function dlName(kind) {
  const d = new Date().toISOString().slice(0, 10);
  const base = currentBoard ? currentBoard.title : (room || 'board');
  return `${room || 'personal'}-${base}-${kind}-${d}.png`.replace(/\s+/g, '_');
}
document.getElementById('dl-full').addEventListener('click', () => { if (featureOn('download')) wb.downloadFull(dlName('board')); dlMenu.open = false; });
document.getElementById('dl-view').addEventListener('click', () => { if (featureOn('download')) wb.downloadView(dlName('view')); dlMenu.open = false; });
document.addEventListener('click', (e) => { if (!dlMenu.contains(e.target)) dlMenu.open = false; });

document.getElementById('clear-btn').addEventListener('click', () => {
  if (confirm('Clear the whole board? You can undo this.')) { wb.clear(); updatePageNav(); }
});

document.getElementById('fullscreen-btn').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
});

// ---------- keyboard shortcuts ----------

document.addEventListener('keydown', (e) => {
  const typing = wb.isEditingText() || /INPUT|TEXTAREA/.test(document.activeElement.tagName);
  if (typing) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) wb.redo(); else wb.undo();
    updatePageNav();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); wb.redo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') { if (wb.copySelection()) toast('Copied'); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') { if (wb.copySelection()) { wb.deleteSelection(); toast('Cut'); } return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') { e.preventDefault(); wb.paste(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); wb.duplicateSelection(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); wb.deleteSelection(); return; }
  if (e.key === 'Escape') { wb.cancelPending(); refreshCtx(); return; }
  if (e.key === 'Enter' && (wb.isCropping() || wb.isCurveEditing())) {
    e.preventDefault();
    if (wb.isCropping()) wb.applyCrop(); else wb.finishCurveEdit(true);
    return;
  }
  if (e.key === 'PageDown') { e.preventDefault(); wb.gotoDocPage(wb.getCurrentDocPage() + 1); return; }
  if (e.key === 'PageUp') { e.preventDefault(); wb.gotoDocPage(wb.getCurrentDocPage() - 1); return; }
  // Arrow keys page through a document when nothing is selected
  if (wb.getDocPages().length && !wb.canvas.getActiveObject() && !wb.isCropping() && !wb.isCurveEditing()) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); wb.gotoDocPage(wb.getCurrentDocPage() + 1); return; }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); wb.gotoDocPage(wb.getCurrentDocPage() - 1); return; }
  }
  const map = { v: 'select', h: 'pan', p: 'pen', t: 'text', e: 'eraser' };
  if (map[e.key.toLowerCase()] && !e.ctrlKey && !e.metaKey) activateTool(map[e.key.toLowerCase()]);
});

// ---------- toast ----------

const toastEl = document.getElementById('toast');
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toastEl.hidden = true; }, 3000);
}

// ================= LIVE SYNC, COMMENTS, MESSAGING =================

let foreignBoardOwner = null; // student name when the teacher is drawing on their board
let overviewOpen = false;
const overviewViewers = new Map();

function toastAction(msg, label, fn) {
  toastEl.textContent = msg + ' ';
  const b = document.createElement('button');
  b.className = 'toast-action';
  b.textContent = label;
  b.onclick = () => { toastEl.hidden = true; fn(); };
  toastEl.appendChild(b);
  toastEl.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toastEl.hidden = true; }, 6000);
}

let lastOpsNoteTs = 0;

function wireCommon() {
  document.getElementById('msg-btn').hidden = false;
  wirePresence();
  wireAssignments();

  // another device (mine, or the teacher's pen on my board) changed this board
  socket.on('board:peer', ({ boardId, json, note }) => {
    if (currentBoard && currentBoard.id === boardId) {
      // If I have unflushed strokes, a full reload would erase them from my
      // screen. Flush them as per-object ops first (the server merges by id, so
      // nothing is lost) and keep my canvas rather than clobbering it.
      if (wb._ops.length || wb._needFullSync || wb._opsTimer) {
        wb.flushOpsNow();
      } else {
        loadBoardWithProgress(json);
      }
    }
    if (note) toast(note);
  });

  // incremental object ops from other editors of boards I can see
  socket.on('board:ops', ({ boardId, owner, ops, note, rev }) => {
    if (currentBoard && currentBoard.id === boardId) {
      if (rev) currentBoard.rev = rev; // keep our revision current so reconnect can skip an unchanged pull
      wb.applyOps(ops, updatePageNav);
    } else if (typeof modalBoardId !== 'undefined' && modalBoardId === boardId && modalViewer) {
      modalViewer.applyOps(ops);
    }
    if (overviewOpen && owner && overviewViewers.has(owner)) {
      const cell = overviewViewers.get(owner);
      if (cell.boardId === boardId) cell.viewer.applyOps(ops);
    }
    if (note && Date.now() - lastOpsNoteTs > 10000) {
      lastOpsNoteTs = Date.now();
      toast(note);
    }
  });

  socket.on('student:thumb', ({ id, thumb }) => {
    const tile = document.querySelector(`#student-tiles [data-student="${CSS.escape(id)}"]`);
    if (tile && thumb) setTileThumb(tile, thumb);
  });

  socket.on('comments:update', ({ boardId, comments }) => {
    if (currentBoard && currentBoard.id === boardId) {
      boardComments = comments || [];
      renderCommentPins();
      if (!document.getElementById('comment-pop').hidden) renderCommentThread();
    }
  });

  socket.on('msg:new', (m) => {
    messagesCache.push(m);
    const panelOpen = !document.getElementById('msg-panel').hidden;
    if (panelOpen && msgInCurrentThread(m)) {
      appendMsg(m);
    } else {
      msgUnread++;
      paintUnread();
      toastAction(`${m.fromName}: ${m.text.slice(0, 60)}`, 'Reply', () => openMsgPanel(m.fromRole === 'student' ? m.from : null));
    }
  });

  wireComments();
  wireMessaging();
}

// ---------- comments on board objects ----------

let boardComments = [];
let commentOid = null;
const pinEls = new Map();

function setBoardComments(list) {
  boardComments = list || [];
  renderCommentPins();
}

function wireComments() {
  wb.canvas.on('after:render', () => positionCommentPins());
  document.getElementById('ctx-comment').addEventListener('click', () => {
    const obj = wb.canvas.getActiveObjects()[0];
    if (!obj) return;
    if (!obj.oid) { obj.oid = 'o' + Math.random().toString(36).slice(2, 11); wb.commit(); }
    openCommentPop(obj.oid);
  });
  document.getElementById('comment-close').addEventListener('click', () => {
    document.getElementById('comment-pop').hidden = true;
    commentOid = null;
  });
  document.getElementById('comment-save').addEventListener('click', () => {
    const text = document.getElementById('comment-input').value.trim();
    if (!text || !commentOid || !currentBoard) return;
    socket.emit('comment:add', { boardId: currentBoard.id, oid: commentOid, text }, (r) => {
      if (r && r.ok) {
        document.getElementById('comment-input').value = '';
        setBoardComments(r.comments);
        renderCommentThread();
      } else toast((r && r.error) || 'Could not comment.');
    });
  });
}

function openCommentPop(oid) {
  commentOid = oid;
  renderCommentThread();
  const pop = document.getElementById('comment-pop');
  pop.hidden = false;
  const obj = wb.findByOid(oid);
  if (obj) {
    const a = wb.anchorPos(obj);
    pop.style.left = Math.min(Math.max(8, a.x + 10), canvasWrap.clientWidth - 280) + 'px';
    pop.style.top = Math.min(Math.max(8, a.y), canvasWrap.clientHeight - 220) + 'px';
  }
  document.getElementById('comment-input').focus();
}

function renderCommentThread() {
  const list = document.getElementById('comment-thread');
  list.innerHTML = '';
  const mine = boardComments.filter((c) => c.oid === commentOid);
  if (!mine.length) list.innerHTML = '<p class="hint">No comments yet on this item.</p>';
  for (const c of mine) {
    const row = document.createElement('div');
    row.className = 'comment-row';
    row.innerHTML = '<div class="comment-meta"><b></b> <span></span> <button class="c-del" title="Delete">✕</button></div><div class="comment-text"></div>';
    row.querySelector('b').textContent = c.author;
    row.querySelector('span').textContent = new Date(c.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    row.querySelector('.comment-text').textContent = c.text;
    row.querySelector('.c-del').onclick = () => {
      socket.emit('comment:remove', { boardId: currentBoard.id, commentId: c.id }, (r) => {
        if (r && r.ok) { setBoardComments(r.comments); renderCommentThread(); }
      });
    };
    list.appendChild(row);
  }
}

function renderCommentPins() {
  for (const el of pinEls.values()) el.remove();
  pinEls.clear();
  if (isSolo) return;
  const byOid = new Map();
  for (const c of boardComments) byOid.set(c.oid, (byOid.get(c.oid) || 0) + 1);
  for (const [oid, count] of byOid) {
    const pin = document.createElement('button');
    pin.className = 'comment-pin';
    pin.textContent = count;
    pin.title = `${count} comment${count === 1 ? '' : 's'} — click to view`;
    pin.onclick = () => openCommentPop(oid);
    canvasWrap.appendChild(pin);
    pinEls.set(oid, pin);
  }
  positionCommentPins();
}

let pinRaf = null;
function positionCommentPins() {
  if (pinRaf) return;
  pinRaf = requestAnimationFrame(() => {
    pinRaf = null;
    for (const [oid, pin] of pinEls) {
      const obj = wb.findByOid(oid);
      if (!obj) { pin.style.display = 'none'; continue; }
      const a = wb.anchorPos(obj);
      pin.style.display = '';
      pin.style.left = (a.x - 6) + 'px';
      pin.style.top = (a.y - 12) + 'px';
    }
  });
}

// ---------- messaging ----------

let messagesCache = [];
let msgUnread = 0;
let msgThread = null; // teacher: null = announcement thread, else student id

function paintUnread() {
  const b = document.getElementById('msg-unread');
  b.hidden = !msgUnread;
  b.textContent = msgUnread;
}

function msgInCurrentThread(m) {
  if (role !== 'teacher') return true; // students have a single thread
  if (msgThread === null) return m.to === null;
  return m.from === msgThread || m.to === msgThread;
}

function wireMessaging() {
  const panel = document.getElementById('msg-panel');
  document.getElementById('msg-btn').addEventListener('click', () => {
    if (panel.hidden) openMsgPanel();
    else panel.hidden = true;
  });
  document.getElementById('msg-close').addEventListener('click', () => { panel.hidden = true; });
  document.getElementById('msg-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('msg-input');
    const text = input.value.trim();
    if (!text) return;
    const to = role === 'teacher' ? (document.getElementById('msg-to').value || null) : undefined;
    socket.emit('msg:send', { to, text }, (r) => {
      if (r && r.ok) {
        messagesCache.push(r.msg);
        appendMsg(r.msg);
        input.value = '';
      } else toast((r && r.error) || 'Could not send.');
    });
  });
  if (role === 'teacher') {
    document.getElementById('msg-to').hidden = false;
    document.getElementById('msg-to').addEventListener('change', (e) => {
      msgThread = e.target.value || null;
      renderMsgList();
    });
  }
}

function openMsgPanel(threadId) {
  const panel = document.getElementById('msg-panel');
  panel.hidden = false;
  msgUnread = 0;
  paintUnread();
  if (role === 'teacher') {
    const sel = document.getElementById('msg-to');
    sel.innerHTML = '';
    sel.appendChild(new Option('📢 Everyone (announcement)', ''));
    for (const t of document.querySelectorAll('#student-tiles .tile')) {
      sel.appendChild(new Option(t.dataset.name, t.dataset.student));
    }
    if (threadId) sel.value = threadId;
    msgThread = sel.value || null;
  }
  socket.emit('msg:history', {}, (list) => {
    messagesCache = list || [];
    renderMsgList();
  });
}

function renderMsgList() {
  const list = document.getElementById('msg-list');
  list.innerHTML = '';
  messagesCache.filter(msgInCurrentThread).forEach(appendMsg);
}

function appendMsg(m) {
  if (!msgInCurrentThread(m)) return;
  const list = document.getElementById('msg-list');
  const row = document.createElement('div');
  const mine = m.fromName === myName && m.fromRole === role;
  row.className = 'msg-row' + (mine ? ' mine' : '');
  row.innerHTML = '<div class="msg-meta"></div><div class="msg-text"></div>';
  row.querySelector('.msg-meta').textContent =
    `${m.fromName}${m.to === null && m.fromRole === 'teacher' ? ' · announcement' : ''} · ${new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  row.querySelector('.msg-text').textContent = m.text;
  list.appendChild(row);
  list.scrollTop = list.scrollHeight;
}

// ---------- teacher extras: overview grid, panel collapse, draw/copy, object send ----------

function wireTeacherExtras() {
  modalViewer.enableNav();

  // collapse / reopen the students panel
  document.getElementById('panel-collapse').addEventListener('click', () => {
    if (overviewOpen) collapseOverview();
    document.getElementById('students-panel').hidden = true;
    document.getElementById('panel-reopen').hidden = false;
    wb.resize();
  });
  document.getElementById('panel-reopen').addEventListener('click', () => {
    document.getElementById('students-panel').hidden = false;
    document.getElementById('panel-reopen').hidden = true;
  });

  // export every student's current board(s) to a single PDF (via the print dialog)
  const exportBtn = document.getElementById('export-all-btn');
  if (exportBtn) exportBtn.addEventListener('click', () => {
    document.getElementById('download-menu').open = false;
    exportAllBoards();
  });

  // expanded live grid of all boards (the students panel widens leftward)
  document.getElementById('overview-btn').addEventListener('click', toggleOverview);
  const sizeSlider = document.getElementById('preview-size');
  sizeSlider.value = localStorage.getItem('wb-preview-size') || 300;
  sizeSlider.addEventListener('input', () => {
    localStorage.setItem('wb-preview-size', sizeSlider.value);
    applyPreviewSize();
  });

  // draw on a student's board / copy it
  document.getElementById('modal-draw').addEventListener('click', async () => {
    if (!modalBoardId || !modalStudent) return;
    const name = modalStudent.name;
    document.getElementById('student-modal').hidden = true;
    showBoardLoading(`Downloading ${name}'s board…`);
    try {
      flushBoard();
      const b = await loadBoardFull(modalBoardId);
      setCurrentBoard(b, name);
      loadBoardWithProgress(b.json, () => setBoardComments(b.comments || []));
      toast(`You are drawing on ${name}'s board — they see your changes live`);
    } catch (e) { hideBoardLoading(); toast(e.message); }
  });
  document.getElementById('back-my-board').addEventListener('click', async () => {
    flushBoard();
    const mine = await fetchBoardsList();
    if (mine.length) await switchBoard(mine[0].id);
    else await createBoardAndSwitch();
  });
  document.getElementById('modal-spotlight').addEventListener('click', () => {
    if (!modalStudent) return;
    socket.emit('spotlight:start', { student: modalStudent.id }, (r) => {
      if (r && r.ok) {
        setSharing(modalStudent.id, modalStudent.name);
        document.getElementById('student-modal').hidden = true;
        toast(`${modalStudent.name}'s board is on everyone's screen — click "Stop spotlight" to end`);
      } else toast((r && r.error) || 'Could not spotlight.');
    });
  });
  document.getElementById('modal-copy').addEventListener('click', () => {
    if (!modalBoardId) return;
    socket.emit('board:copy-as', { boardId: modalBoardId }, (r) => {
      toast(r && r.ok ? `Copied to your boards as "${r.meta.title}"` : (r && r.error) || 'Copy failed');
    });
  });

  // send selected objects to chosen students
  document.getElementById('ctx-send').addEventListener('click', openSendModal);
  document.getElementById('send-close').addEventListener('click', () => { document.getElementById('send-modal').hidden = true; });
  document.getElementById('send-all').addEventListener('change', (e) => {
    document.querySelectorAll('#send-list input').forEach((c) => { c.disabled = e.target.checked; });
  });
  document.getElementById('send-confirm').addEventListener('click', () => {
    const objs = pendingSendObjects;
    if (!objs || !objs.length) return;
    const all = document.getElementById('send-all').checked;
    const targets = all ? null : [...document.querySelectorAll('#send-list input:checked')].map((c) => c.value);
    if (!all && !targets.length) { toast('Pick at least one student.'); return; }
    socket.emit('objects:push', { targets, objects: objs }, (r) => {
      toast(r && r.ok ? `Sent to ${r.count} student${r.count === 1 ? '' : 's'}` : (r && r.error) || 'Send failed');
    });
    document.getElementById('send-modal').hidden = true;
  });
}

let pendingSendObjects = null;

function openSendModal() {
  const selected = wb.canvas.getActiveObjects();
  if (!selected.length) return;
  wb.canvas.discardActiveObject();
  wb.canvas.requestRenderAll();
  pendingSendObjects = selected.map((o) => o.toObject(PERSIST_PROPS));
  const list = document.getElementById('send-list');
  list.innerHTML = '';
  for (const t of document.querySelectorAll('#student-tiles .tile')) {
    const label = document.createElement('label');
    label.className = 'chk';
    label.innerHTML = '<input type="checkbox" disabled /> <span></span>';
    label.querySelector('input').value = t.dataset.student;
    label.querySelector('span').textContent = t.dataset.name;
    list.appendChild(label);
  }
  document.getElementById('send-all').checked = true;
  document.getElementById('send-modal').hidden = false;
}

function previewSize() {
  return Number(document.getElementById('preview-size').value) || 300;
}

function applyPreviewSize() {
  const w = previewSize();
  document.getElementById('students-grid').style.setProperty('--preview-w', w + 'px');
  for (const entry of overviewViewers.values()) {
    entry.viewer.setSize(w, Math.round(w * 0.7));
    entry.viewer.refit();
  }
}

function toggleOverview() {
  if (overviewOpen) collapseOverview();
  else expandOverview();
}

function expandOverview() {
  overviewOpen = true;
  document.getElementById('students-panel').classList.add('expanded');
  document.getElementById('student-tiles').hidden = true;
  document.getElementById('preview-size').hidden = false;
  const btn = document.getElementById('overview-btn');
  btn.textContent = '⤡';
  btn.title = 'Back to the small student list';
  buildOverviewGrid();
  document.getElementById('students-grid').hidden = false;
  wb.resize();
  setTimeout(() => wb.resize(), 260); // again after the width transition settles
}

function collapseOverview() {
  overviewOpen = false;
  document.getElementById('students-panel').classList.remove('expanded');
  const grid = document.getElementById('students-grid');
  grid.hidden = true;
  grid.innerHTML = '';
  overviewViewers.clear();
  document.getElementById('student-tiles').hidden = false;
  document.getElementById('preview-size').hidden = true;
  const btn = document.getElementById('overview-btn');
  btn.textContent = '⤢';
  btn.title = "Expand — see every student's board large";
  wb.resize();
  setTimeout(() => wb.resize(), 260);
}

function buildOverviewGrid() {
  const grid = document.getElementById('students-grid');
  grid.innerHTML = '';
  overviewViewers.clear();
  const w = previewSize();
  grid.style.setProperty('--preview-w', w + 'px');
  const tiles = [...document.querySelectorAll('#student-tiles .tile')];
  if (!tiles.length) grid.innerHTML = '<p class="hint" style="padding:10px">No students yet.</p>';
  for (const t of tiles) {
    const id = t.dataset.student;
    const cell = document.createElement('div');
    cell.className = 'overview-cell';
    const cv = document.createElement('canvas');
    cell.appendChild(cv);
    const nm = document.createElement('div');
    nm.className = 'overview-name';
    nm.textContent = t.dataset.name;
    cell.appendChild(nm);
    cell.onclick = () => openStudentModal(id); // stay expanded behind the close-up
    grid.appendChild(cell);
    const viewer = new BoardViewer(cv);
    viewer.setSize(w, Math.round(w * 0.7));
    const entry = { viewer, boardId: null };
    overviewViewers.set(id, entry);
    // fetch the student's latest board fresh; live ops keep it current from there
    socket.emit('student:boards', { student: id }, (list) => {
      if (list && list.length) {
        entry.boardId = list[0].id;
        socket.emit('board:load', { boardId: list[0].id }, (r) => {
          if (r && r.ok) viewer.load(r.json);
        });
      } else {
        viewer.load(null);
      }
    });
  }
}

// ---------- export every student's board to one PDF (print dialog) ----------
let exportBusy = false;

async function exportAllBoards() {
  if (exportBusy) return;
  const tiles = [...document.querySelectorAll('#student-tiles .tile')];
  if (!tiles.length) { toast('No students to export yet.'); return; }
  exportBusy = true;
  try {
    // one reusable offscreen viewer sized to a landscape page
    const off = document.createElement('canvas');
    off.style.cssText = 'position:fixed;left:-99999px;top:0;';
    document.body.appendChild(off);
    const PW = 1200, PH = 850;
    const viewer = new BoardViewer(off);
    viewer.setSize(PW, PH);

    const pages = [];
    let done = 0;
    for (const t of tiles) {
      const id = t.dataset.student, name = t.dataset.name || id;
      toast(`Rendering boards… ${++done}/${tiles.length}`);
      const list = await new Promise((res) => socket.emit('student:boards', { student: id }, (l) => res(l || [])));
      if (!list.length) { pages.push({ name, title: 'No board yet', url: null }); continue; }
      for (const b of list) {
        const r = await new Promise((res) => socket.emit('board:load', { boardId: b.id }, res));
        if (!r || !r.ok) continue;
        await viewer.loadAsync(r.json);
        pages.push({ name, title: b.title || 'Board', url: viewer.canvas.toDataURL({ format: 'png', multiplier: 1 }) });
      }
    }
    off.remove();
    if (!pages.length) { toast('Nothing to export.'); return; }
    printBoardPages(pages);
    toast('Choose "Save as PDF" in the print dialog to save all boards.');
  } catch (e) {
    toast('Could not export boards.');
    console.error(e);
  } finally {
    exportBusy = false;
  }
}

// Build a self-contained print document in a hidden iframe and open the print dialog.
// Using an iframe (not window.open) avoids popup blockers after the async render.
function printBoardPages(pages) {
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  doc.open();
  doc.write('<!doctype html><html><head><meta charset="utf-8"><title>Student boards</title></head><body></body></html>');
  doc.close();
  const style = doc.createElement('style');
  style.textContent = [
    '*{box-sizing:border-box}',
    'body{margin:0;font-family:system-ui,-apple-system,sans-serif;color:#1f2937}',
    '.page{page-break-after:always;padding:10px 4px}',
    '.page:last-child{page-break-after:auto}',
    'h2{font-size:15px;margin:0 0 6px}',
    'h2 span{font-weight:400;color:#6b7280;margin-left:8px}',
    'img{display:block;width:100%;height:auto;border:1px solid #e5e7eb;border-radius:6px}',
    '.empty{color:#9ca3af;font-style:italic;padding:24px 0}',
    '@page{size:landscape;margin:12mm}',
  ].join('');
  doc.head.appendChild(style);
  for (const p of pages) {
    const sec = doc.createElement('section');
    sec.className = 'page';
    const h = doc.createElement('h2');
    h.textContent = p.name;
    const sp = doc.createElement('span');
    sp.textContent = p.title;
    h.appendChild(sp);
    sec.appendChild(h);
    if (p.url) {
      const img = doc.createElement('img');
      img.src = p.url;
      sec.appendChild(img);
    } else {
      const e = doc.createElement('p');
      e.className = 'empty';
      e.textContent = 'No board yet';
      sec.appendChild(e);
    }
    doc.body.appendChild(sec);
  }
  // wait for the images to decode before printing
  const imgs = [...doc.images];
  Promise.all(imgs.map((im) => im.complete ? Promise.resolve() : new Promise((r) => { im.onload = im.onerror = r; })))
    .then(() => {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
      setTimeout(() => iframe.remove(), 2000);
    });
}

// ================= ACCESSIBILITY =================
(function wireAccessibility() {
  const PREF = { dyslexic: 'a11y-dyslexic', contrast: 'a11y-contrast' };
  function apply(key, on) {
    document.body.classList.toggle(PREF[key], on);
    localStorage.setItem('wb-' + PREF[key], on ? '1' : '0');
    const btn = document.getElementById(PREF[key]);
    if (btn) {
      btn.textContent = on ? 'On' : 'Off';
      btn.setAttribute('aria-checked', on ? 'true' : 'false');
      btn.classList.toggle('active', on);
    }
  }
  for (const key of Object.keys(PREF)) apply(key, localStorage.getItem('wb-' + PREF[key]) === '1');

  const modal = document.getElementById('a11y-modal');
  const openBtn = document.getElementById('a11y-btn');
  if (openBtn && modal) {
    openBtn.addEventListener('click', () => {
      const dm = document.getElementById('download-menu');
      if (dm) dm.open = false;
      modal.hidden = false;
    });
    document.getElementById('a11y-close').addEventListener('click', () => { modal.hidden = true; });
    for (const key of Object.keys(PREF)) {
      const btn = document.getElementById(PREF[key]);
      if (btn) btn.addEventListener('click', () => apply(key, !document.body.classList.contains(PREF[key])));
    }
  }

  // Screen-reader names for icon-only controls, and an announced toast
  document.querySelectorAll('button[title]:not([aria-label])').forEach((b) => b.setAttribute('aria-label', b.title));
  const board = document.getElementById('board');
  if (board) board.setAttribute('aria-label', 'Drawing canvas');
  const toastEl2 = document.getElementById('toast');
  if (toastEl2) { toastEl2.setAttribute('role', 'status'); toastEl2.setAttribute('aria-live', 'polite'); }

  // Esc closes the topmost open dialog (using its own close button so cleanup still runs)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = [...document.querySelectorAll('[id$="-modal"]')].filter((m) => !m.hidden);
    const top = open[open.length - 1];
    if (!top) return;
    const close = top.querySelector('[id$="-close"]') || top.querySelector('.modal-head button');
    if (close) close.click(); else top.hidden = true;
    e.stopPropagation();
  });
})();

// Offline/online awareness (the app reconnects and re-syncs the local board automatically)
window.addEventListener('offline', () => { if (typeof toast === 'function') toast("You're offline — your work is kept here and will sync when you reconnect."); });
window.addEventListener('online', () => { if (typeof toast === 'function') toast('Back online — syncing.'); });

// ================= ASSIGNMENTS: assign → turn in → grade → return =================
const studentAssignments = new Map(); // boardId -> { id, title, instructions, submission }
let teacherAssignments = [];

const ASSIGN_STATUS = { assigned: 'Not started', working: 'Working', turnedin: 'Turned in', returned: 'Returned' };

function fmtWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function wireAssignments() {
  if (isSolo) return;
  if (role === 'teacher') wireAssignmentsTeacher();
  else wireAssignmentsStudent();
}

// ----- student side: banner + turn in -----
function ingestStudentAssignment(a) {
  if (a && a.submission && a.submission.boardId) studentAssignments.set(a.submission.boardId, a);
}
function refreshStudentAssignments() {
  if (!socket) return;
  socket.emit('assignment:list', {}, (r) => {
    if (r && r.ok) { (r.assignments || []).forEach(ingestStudentAssignment); renderAssignmentBanner(); }
  });
}
function renderAssignmentBanner() {
  const banner = document.getElementById('assignment-banner');
  if (!banner) return;
  if (role === 'teacher' || isSolo) { banner.hidden = true; return; }
  const a = currentBoard && studentAssignments.get(currentBoard.id);
  if (!a) { banner.hidden = true; return; }
  const sub = a.submission || {};
  document.getElementById('ab-title').textContent = a.title;
  const statusEl = document.getElementById('ab-status');
  const turnin = document.getElementById('ab-turnin');
  const gradeEl = document.getElementById('ab-grade');
  const info = document.getElementById('ab-info');
  const instr = document.getElementById('ab-instructions');
  info.hidden = !a.instructions;
  instr.textContent = a.instructions || '';
  instr.hidden = true;
  banner.className = '';
  gradeEl.hidden = true;
  if (sub.status === 'returned') {
    statusEl.textContent = 'Returned';
    banner.classList.add('ab-returned');
    turnin.hidden = true;
    const bits = [];
    if (sub.grade != null && sub.grade !== '') bits.push('Grade: ' + sub.grade);
    if (sub.feedback) bits.push(sub.feedback);
    gradeEl.textContent = bits.join(' — ') || 'Returned';
    gradeEl.hidden = false;
  } else if (sub.status === 'turnedin') {
    statusEl.textContent = 'Turned in';
    banner.classList.add('ab-turnedin');
    turnin.hidden = true;
    gradeEl.textContent = 'Turned in ✓ — waiting for feedback';
    gradeEl.hidden = false;
  } else {
    statusEl.textContent = 'Assignment';
    turnin.hidden = false;
    turnin.textContent = 'Turn in';
  }
  banner.hidden = false;
}
function wireAssignmentsStudent() {
  document.getElementById('ab-turnin').addEventListener('click', () => {
    const a = currentBoard && studentAssignments.get(currentBoard.id);
    if (!a) return;
    if (!confirm(`Turn in "${a.title}"? Your teacher will see it as done.`)) return;
    socket.emit('assignment:turnin', { assignmentId: a.id }, (r) => {
      if (r && r.ok) {
        a.submission = a.submission || {};
        a.submission.status = 'turnedin';
        a.submission.turnedInAt = Date.now();
        renderAssignmentBanner();
        toast('Turned in! 🎉');
      } else toast((r && r.error) || 'Could not turn in.');
    });
  });
  document.getElementById('ab-info').addEventListener('click', () => {
    const instr = document.getElementById('ab-instructions');
    instr.hidden = !instr.hidden;
  });
  socket.on('assignment:new', (a) => { ingestStudentAssignment(a); toast(`New assignment: ${a.title}`); renderAssignmentBanner(); });
  socket.on('assignment:returned', (a) => {
    ingestStudentAssignment(a);
    const g = a.submission && a.submission.grade;
    toast(`Your work was returned${g != null && g !== '' ? ': ' + g : ''}`);
    renderAssignmentBanner();
  });
}

// ----- teacher side: assign + dashboard + grading -----
function wireAssignmentsTeacher() {
  const assignModal = document.getElementById('assign-modal');
  document.getElementById('assign-btn').addEventListener('click', () => {
    document.getElementById('download-menu').open = false;
    document.getElementById('assign-title').value = currentBoard ? currentBoard.title : '';
    assignModal.hidden = false;
  });
  document.getElementById('assign-close').addEventListener('click', () => { assignModal.hidden = true; });
  document.getElementById('assign-send').addEventListener('click', () => {
    const title = document.getElementById('assign-title').value.trim();
    if (!title) { toast('Give the assignment a title.'); return; }
    const instructions = document.getElementById('assign-instructions').value;
    const dueVal = document.getElementById('assign-due').value;
    const dueAt = dueVal ? new Date(dueVal).getTime() : null;
    socket.emit('assignment:create', { title, instructions, dueAt, json: wb.getJSON() }, (r) => {
      if (r && r.ok) {
        assignModal.hidden = true;
        document.getElementById('assign-instructions').value = '';
        document.getElementById('assign-due').value = '';
        toast(`Assigned to ${r.count} student${r.count === 1 ? '' : 's'}.`);
      } else toast((r && r.error) || 'Could not assign.');
    });
  });

  const listModal = document.getElementById('assignments-modal');
  document.getElementById('assignments-btn').addEventListener('click', () => {
    document.getElementById('download-menu').open = false;
    listModal.hidden = false;
    loadAssignmentsList();
  });
  document.getElementById('assignments-close').addEventListener('click', () => { listModal.hidden = true; });

  socket.on('assignment:submitted', ({ name }) => {
    toast(`${name} turned in their work.`);
    if (!listModal.hidden) loadAssignmentsList();
  });
  socket.on('assignment:progress', () => { if (!listModal.hidden) loadAssignmentsList(); });
}

function loadAssignmentsList() {
  socket.emit('assignment:list', {}, (r) => {
    if (!r || !r.ok) return;
    teacherAssignments = r.assignments || [];
    renderAssignmentsList();
  });
}
function renderAssignmentsList() {
  const wrap = document.getElementById('assignments-list');
  wrap.innerHTML = '';
  if (!teacherAssignments.length) {
    wrap.innerHTML = '<p class="hint">No assignments yet. Open a board and use “Assign to class…” to create one.</p>';
    return;
  }
  for (const a of teacherAssignments) {
    const card = document.createElement('div');
    card.className = 'assignment-card';
    const head = document.createElement('div');
    head.className = 'assignment-head';
    const strong = document.createElement('strong');
    strong.textContent = a.title;
    head.appendChild(strong);
    const counts = a.submissions.reduce((m, s) => (m[s.status] = (m[s.status] || 0) + 1, m), {});
    const meta = document.createElement('span');
    meta.className = 'hint';
    meta.textContent = ` ${counts.turnedin || 0} turned in · ${counts.returned || 0} returned · ${a.submissions.length} student${a.submissions.length === 1 ? '' : 's'}`;
    head.appendChild(meta);
    card.appendChild(head);
    if (a.submissions.length === 0) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'No students in the class yet.';
      card.appendChild(p);
    }
    for (const s of a.submissions) card.appendChild(buildSubmissionRow(a, s));
    wrap.appendChild(card);
  }
}
function buildSubmissionRow(a, s) {
  const row = document.createElement('div');
  row.className = 'submission-row';
  const nm = document.createElement('span');
  nm.className = 'sr-name';
  nm.textContent = s.name;
  row.appendChild(nm);
  const st = document.createElement('span');
  st.className = 'sr-status status-' + s.status;
  st.textContent = ASSIGN_STATUS[s.status] || s.status;
  row.appendChild(st);
  const open = document.createElement('button');
  open.className = 'sr-open';
  open.textContent = 'Open';
  open.title = "Open this student's board on your canvas";
  open.onclick = () => openAssignmentBoard(a, s);
  row.appendChild(open);
  const grade = document.createElement('input');
  grade.className = 'sr-grade';
  grade.placeholder = 'Grade';
  grade.maxLength = 20;
  grade.value = s.grade || '';
  row.appendChild(grade);
  const fb = document.createElement('input');
  fb.className = 'sr-feedback';
  fb.placeholder = 'Feedback';
  fb.maxLength = 2000;
  fb.value = s.feedback || '';
  row.appendChild(fb);
  const ret = document.createElement('button');
  ret.className = 'sr-return primary-sm';
  ret.textContent = s.status === 'returned' ? 'Update' : 'Return';
  ret.onclick = () => {
    socket.emit('assignment:return', { assignmentId: a.id, student: s.student, grade: grade.value, feedback: fb.value }, (r) => {
      if (r && r.ok) {
        s.status = 'returned'; s.grade = grade.value; s.feedback = fb.value;
        st.className = 'sr-status status-returned';
        st.textContent = ASSIGN_STATUS.returned;
        ret.textContent = 'Update';
        toast(`Returned to ${s.name}.`);
      } else toast((r && r.error) || 'Could not return.');
    });
  };
  row.appendChild(ret);
  return row;
}
function openAssignmentBoard(a, s) {
  flushBoard(); // send any pending strokes to the CURRENT board before switching
  showBoardLoading('Downloading board…');
  socket.emit('board:load', { boardId: s.boardId }, (r) => {
    if (r && r.ok) {
      setCurrentBoard({ id: s.boardId, title: a.title }, s.name);
      loadBoardWithProgress(r.json);
      document.getElementById('assignments-modal').hidden = true;
    } else { hideBoardLoading(); toast('Could not open that board.'); }
  });
}

// ================= FEATURE SWITCHES =================

const FEATURE_DEFS = [
  ['draw', 'Drawing'],
  ['text', 'Text'],
  ['images', 'Photos'],
  ['documents', 'Documents'],
  ['charts', 'Charts & graphs'],
  ['newBoards', 'New boards'],
  ['download', 'Download'],
  ['embed', 'Share to web'],
];
const DRAW_TOOLS = ['pen', 'highlighter', 'line', 'curve', 'arrow', 'rect', 'ellipse', 'triangle'];

let myFeatures = null;        // student: my resolved switches
let roomFeatures = {};        // teacher: raw room overrides
let studentFeaturesMap = {};  // teacher: raw per-student overrides

function featureOn(f) {
  return !myFeatures || myFeatures[f] !== false;
}

function featureTargets(f) {
  if (f === 'draw') return DRAW_TOOLS.map((t) => document.querySelector(`.tool[data-tool="${t}"]`));
  if (f === 'text') return [document.querySelector('.tool[data-tool="text"]')];
  if (f === 'images') return [document.getElementById('image-btn')];
  if (f === 'documents') return [document.getElementById('doc-btn')];
  if (f === 'charts') return [document.getElementById('graph-btn'), document.getElementById('chart-btn'), document.getElementById('equation-btn')];
  if (f === 'download') return [document.getElementById('download-menu')];
  if (f === 'newBoards') return [document.getElementById('board-new')];
  return [];
}

function applyFeatures(next, announce) {
  const prev = myFeatures;
  myFeatures = next;
  for (const [f, label] of FEATURE_DEFS) {
    const off = next[f] === false;
    featureTargets(f).forEach((el) => {
      if (!el) return;
      el.classList.toggle('feature-off', off);
      if (el.tagName === 'BUTTON') el.disabled = off;
      el.title = off ? `${label} is turned off by your teacher` : el.dataset.origTitle || el.title;
    });
    if (announce && prev && (prev[f] !== false) !== (next[f] !== false)) {
      toast(off ? `Your teacher turned off ${label}` : `${label} is back on`);
    }
  }
  // kick out of a tool that just got disabled
  if ((next.draw === false && DRAW_TOOLS.includes(wb.tool)) || (next.text === false && wb.tool === 'text')) {
    activateTool('select');
  }
}

// ----- teacher panel: tri-state chips (inherit -> off -> on) -----

function chipState(map, f) {
  return map && map[f] === false ? 'off' : map && map[f] === true ? 'on' : 'inherit';
}

function nextChipValue(state) {
  return state === 'inherit' ? false : state === 'off' ? true : null; // cycle inherit->off->on->inherit
}

function mkFeatureChip(f, label, getMap, send) {
  const b = document.createElement('button');
  b.type = 'button';
  const paint = () => {
    const st = chipState(getMap(), f);
    b.className = 'f-chip f-' + st;
    b.textContent = label;
    b.title = st === 'inherit' ? `${label}: inherited (click to turn off)` : st === 'off' ? `${label}: OFF (click to force on)` : `${label}: forced ON (click to inherit)`;
  };
  b.onclick = () => send(f, nextChipValue(chipState(getMap(), f)), paint);
  paint();
  return b;
}

function renderFeaturesModal() {
  const roomRow = document.getElementById('features-room-row');
  roomRow.innerHTML = '';
  const rowLabel = document.createElement('div');
  rowLabel.className = 'f-row-name';
  rowLabel.textContent = 'Whole room';
  roomRow.appendChild(rowLabel);
  const chips = document.createElement('div');
  chips.className = 'f-chips';
  for (const [f, label] of FEATURE_DEFS) {
    chips.appendChild(mkFeatureChip(f, label, () => roomFeatures, (feat, val, paint) => {
      socket.emit('features:set', { scope: 'room', features: { [feat]: val } }, (r) => {
        if (r && r.ok) { roomFeatures = r.roomFeatures || {}; paint(); }
        else toast((r && r.error) || 'Could not update.');
      });
    }));
  }
  roomRow.appendChild(chips);

  const wrap = document.getElementById('features-students');
  wrap.innerHTML = '';
  const students = [...document.querySelectorAll('#student-tiles .tile')].map((t) => ({ id: t.dataset.student, name: t.dataset.name }));
  if (!students.length) {
    wrap.innerHTML = '<p class="hint">No students in this class yet.</p>';
    return;
  }
  for (const s of students) {
    const row = document.createElement('div');
    row.className = 'f-student-row';
    const nm = document.createElement('div');
    nm.className = 'f-row-name';
    nm.textContent = s.name;
    row.appendChild(nm);
    const sChips = document.createElement('div');
    sChips.className = 'f-chips';
    for (const [f, label] of FEATURE_DEFS) {
      sChips.appendChild(mkFeatureChip(f, label, () => studentFeaturesMap[s.id], (feat, val, paint) => {
        socket.emit('features:set', { scope: 'student', student: s.id, features: { [feat]: val } }, (r) => {
          if (r && r.ok) { studentFeaturesMap = r.studentFeatures || {}; paint(); }
          else toast((r && r.error) || 'Could not update.');
        });
      }));
    }
    row.appendChild(sChips);
    wrap.appendChild(row);
  }
}

function wireFeaturesTeacher() {
  const btn = document.getElementById('features-btn');
  const modal = document.getElementById('features-modal');
  document.getElementById('features-room').textContent = room;
  btn.addEventListener('click', () => {
    renderFeaturesModal();
    modal.hidden = false;
  });
  document.getElementById('features-close').addEventListener('click', () => { modal.hidden = true; });
}

// ================= STUDENT =================

const studentUI = { showShare: () => {} };

function wireStudent() {
  const overlay = document.getElementById('share-overlay');
  const shareViewer = new BoardViewer('share-canvas');

  function sizeShareViewer() {
    const wrap = overlay.querySelector('.overlay-canvas-wrap');
    shareViewer.setSize(wrap.clientWidth, wrap.clientHeight);
  }
  window.addEventListener('resize', () => { if (!overlay.hidden) sizeShareViewer(); });

  studentUI.showShare = (json, by) => {
    document.getElementById('share-banner').textContent =
      !by || by === 'Your teacher' ? 'Your teacher is sharing their board' : `${by}'s board is on screen — nice work!`;
    overlay.hidden = false;
    sizeShareViewer();
    shareViewer.load(json);
  };

  socket.on('features:update', ({ features }) => applyFeatures(features, true));

  socket.on('share:start', ({ json, by }) => studentUI.showShare(json, by));
  socket.on('spotlight:you', () => toast('Your board is being shown to the whole class!'));
  socket.on('stage:ops', ({ ops }) => { if (!overlay.hidden) shareViewer.applyOps(ops); });
  socket.on('teacher:board', ({ json }) => { if (!overlay.hidden) shareViewer.load(json); });
  socket.on('share:stop', () => { overlay.hidden = true; });

  socket.on('board:new', ({ meta, by }) => {
    fetchBoardsList().catch(() => {});
    toastAction(`${by} sent you a new board: "${meta.title}"`, 'Open it', () => switchBoard(meta.id));
  });

  wirePollStudent();
}

// Palette for poll bars, matching the chart builders
const POLL_COLORS = ['#0A7C6E', '#F59E0B', '#FF6B35', '#2563EB', '#7C3AED', '#DB2777', '#0891B2', '#65A30D'];

// ----- student poll overlay -----
function wirePollStudent() {
  const overlay = document.getElementById('poll-overlay');
  const optsEl = document.getElementById('poll-choice-opts');
  const textIn = document.getElementById('poll-text-input');
  const sentEl = document.getElementById('poll-sent');
  const closedEl = document.getElementById('poll-closed');
  let cur = null;

  socket.on('poll:open', (p) => { cur = p; show(p); });
  socket.on('poll:close', () => {
    optsEl.hidden = true; textIn.hidden = true; sentEl.hidden = true;
    closedEl.hidden = false;
    setTimeout(() => { overlay.hidden = true; cur = null; }, 2500);
  });

  function show(p) {
    overlay.hidden = false;
    sentEl.hidden = true; closedEl.hidden = true;
    document.getElementById('poll-overlay-q').textContent = p.question;
    if (p.type === 'choice') {
      textIn.hidden = true; optsEl.hidden = false; optsEl.innerHTML = '';
      p.options.forEach((o, i) => {
        const b = document.createElement('button');
        b.className = 'poll-opt-btn';
        b.textContent = o;
        b.onclick = () => respond(i, b);
        optsEl.appendChild(b);
      });
    } else {
      optsEl.hidden = true; textIn.hidden = false;
      document.getElementById('poll-answer').value = '';
    }
  }

  function respond(value, btn) {
    if (!cur) return;
    socket.emit('poll:respond', { id: cur.id, value }, (res) => {
      if (res && res.error) { toast(res.error); return; }
      if (btn) { optsEl.querySelectorAll('.poll-opt-btn').forEach((x) => x.classList.remove('chosen')); btn.classList.add('chosen'); }
      sentEl.hidden = false;
    });
  }

  document.getElementById('poll-send').onclick = () => {
    const v = document.getElementById('poll-answer').value.trim();
    if (!v) { toast('Type an answer first.'); return; }
    respond(v);
  };
}

// ================= TEACHER =================

const latestStudentBoards = new Map(); // student id -> { boardId, json }
let modalStudent = null; // { id, name }
let modalBoardId = null;
let modalViewer = null;

function upsertStudent(s) {
  const tilesEl = document.getElementById('student-tiles');
  let tile = tilesEl.querySelector(`[data-student="${CSS.escape(s.id)}"]`);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'tile';
    tile.dataset.student = s.id;
    tile.innerHTML = '<div class="tile-empty">No drawing yet</div><div class="tname"></div>';
    tile.addEventListener('click', () => openStudentModal(s.id));
    tilesEl.appendChild(tile);
  }
  tile.querySelector('.tname').textContent = s.name || s.id;
  tile.dataset.name = s.name || s.id;
  tile.classList.toggle('offline', s.online === false);
  if (s.thumb) setTileThumb(tile, s.thumb);
  updateStudentCount();
}

function setTileThumb(tile, thumb) {
  let img = tile.querySelector('img');
  if (!img) {
    img = document.createElement('img');
    tile.replaceChild(img, tile.querySelector('.tile-empty'));
  }
  img.src = thumb;
}

function removeStudentTile(id) {
  const tile = document.querySelector(`#student-tiles [data-student="${CSS.escape(id)}"]`);
  if (tile) tile.remove();
  latestStudentBoards.delete(id);
  updateStudentCount();
}

function updateStudentCount() {
  const tiles = document.querySelectorAll('#student-tiles .tile:not(.offline)');
  document.getElementById('student-count').textContent = tiles.length;
}

let sharingMode = false; // false | 'teacher' | spotlighted student id
function setSharing(mode, by) {
  sharingMode = mode || false;
  const btn = document.getElementById('share-btn');
  btn.classList.toggle('sharing', !!sharingMode);
  btn.textContent = !sharingMode ? 'Share' : (sharingMode === 'teacher' ? 'Stop sharing' : 'Stop spotlight');
  btn.title = sharingMode && sharingMode !== 'teacher'
    ? `${by || 'A student'}'s board is on every screen — click to stop`
    : "Show your board live on every student's screen";
}

async function openStudentModal(id) {
  const tile = document.querySelector(`#student-tiles [data-student="${CSS.escape(id)}"]`);
  const name = (tile && tile.dataset.name) || id;
  modalStudent = { id, name };
  document.getElementById('modal-title').textContent = `${name}'s boards (live)`;
  const modal = document.getElementById('student-modal');
  modal.hidden = false;
  const wrap = modal.querySelector('.overlay-canvas-wrap');
  modalViewer.setSize(wrap.clientWidth, wrap.clientHeight);
  await refreshModalStrip();
}

async function refreshModalStrip(selectBoardId) {
  if (!modalStudent) return;
  const strip = document.getElementById('modal-board-strip');
  const boards = await new Promise((resolve) => socket.emit('student:boards', { student: modalStudent.id }, resolve));
  strip.innerHTML = '';
  if (!boards || !boards.length) {
    modalViewer.load(null);
    modalBoardId = null;
    return;
  }
  const target = selectBoardId || modalBoardId || (latestStudentBoards.get(modalStudent.id) || {}).boardId || boards[0].id;
  for (const b of boards) {
    const item = document.createElement('button');
    item.className = 'strip-item';
    item.dataset.boardId = b.id;
    item.title = b.title;
    if (b.thumb) { const im = document.createElement('img'); im.alt = ''; im.src = b.thumb; item.appendChild(im); }
    else { const sp = document.createElement('span'); sp.className = 'strip-empty'; sp.textContent = '▢'; item.appendChild(sp); }
    const nm = document.createElement('span');
    nm.textContent = b.title;
    item.appendChild(nm);
    item.onclick = () => viewStudentBoard(b.id);
    strip.appendChild(item);
  }
  viewStudentBoard(target);
}

function viewStudentBoard(boardId) {
  modalBoardId = boardId;
  document.querySelectorAll('#modal-board-strip .strip-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.boardId === boardId);
  });
  socket.emit('board:load', { boardId }, (res) => {
    if (res && res.ok) modalViewer.load(res.json);
  });
  const cached = latestStudentBoards.get(modalStudent && modalStudent.id);
  if (cached && cached.boardId === boardId && cached.json) modalViewer.load(cached.json);
}

function wireTeacher() {
  document.getElementById('students-panel').hidden = false;
  document.querySelectorAll('.teacher-only').forEach((el) => { el.hidden = false; });

  const modal = document.getElementById('student-modal');
  modalViewer = new BoardViewer('modal-canvas');

  document.getElementById('modal-close').addEventListener('click', () => {
    modal.hidden = true;
    modalStudent = null;
    modalBoardId = null;
  });
  document.getElementById('modal-push').addEventListener('click', () => {
    if (!modalStudent) return;
    if (confirm(`Replace ${modalStudent.name}'s current board with your board?`)) {
      socket.emit('template:push', { json: wb.getJSON(), target: modalStudent.id });
      toast(`Board sent to ${modalStudent.name}`);
    }
  });

  socket.on('student:joined', (s) => {
    upsertStudent({ ...s, online: true });
    if (overviewOpen) buildOverviewGrid();
    toast(`${s.name} joined`);
  });

  socket.on('student:left', ({ id }) => {
    const tile = document.querySelector(`#student-tiles [data-student="${CSS.escape(id)}"]`);
    if (tile) tile.classList.add('offline');
    updateStudentCount();
  });

  socket.on('student:board', ({ id, name, boardId, json, thumb }) => {
    latestStudentBoards.set(id, { boardId, json });
    const tile = document.querySelector(`#student-tiles [data-student="${CSS.escape(id)}"]`);
    if (tile) {
      tile.classList.remove('offline');
      if (thumb) setTileThumb(tile, thumb);
    } else {
      upsertStudent({ id, name, online: true, thumb });
    }
    updateStudentCount();
    if (modalStudent && modalStudent.id === id) {
      if (modalBoardId === boardId) modalViewer.load(json);
      else refreshModalStrip();
    }
    // teacher is drawing on this student's board on the main canvas: mirror their edits live
    if (currentBoard && currentBoard.id === boardId && foreignBoardOwner) {
      wb.loadJSON(json, updatePageNav);
    }
    if (overviewOpen && overviewViewers.has(id)) {
      const cell = overviewViewers.get(id);
      cell.boardId = boardId;
      cell.viewer.load(json);
    }
  });

  document.getElementById('share-btn').addEventListener('click', () => {
    if (sharingMode) {
      socket.emit('share:stop');
      setSharing(false);
      toast('Stopped sharing');
    } else {
      socket.emit('share:start');
      setSharing('teacher');
      toast('Students now see your board');
    }
  });

  document.getElementById('push-btn').addEventListener('click', () => {
    if (confirm('Send a copy of your board to every student? Each of them gets it as a NEW board in this class.')) {
      socket.emit('template:push', { json: wb.getJSON(), title: `From ${myName} — ${currentBoard ? currentBoard.title : 'Board'}` }, (r) => {
        toast(r && r.ok ? `Board sent to ${r.count} student${r.count === 1 ? '' : 's'} as a new board` : (r && r.error) || 'Push failed');
      });
    }
  });

  wirePollTeacher();
  wireFeaturesTeacher();
  wireTeacherExtras();
  if (authToken) wireRoster();
}

// ----- teacher poll composer + live results -----
let pollState = null;
function wirePollTeacher() {
  const compose = document.getElementById('poll-compose');
  const results = document.getElementById('poll-results');
  const optionsBox = document.getElementById('poll-options');
  let pollType = 'choice';

  function addOption(val = '') {
    const row = document.createElement('div');
    row.className = 'poll-option-row';
    const inp = document.createElement('input');
    inp.type = 'text'; inp.maxLength = 80; inp.placeholder = 'Option'; inp.value = val;
    const del = document.createElement('button');
    del.className = 'btn-block'; del.textContent = '✕';
    del.onclick = () => row.remove();
    row.append(inp, del);
    optionsBox.appendChild(row);
  }
  function setPollType(t) {
    pollType = t;
    document.querySelectorAll('.poll-type').forEach((x) => x.classList.toggle('active', x.dataset.type === t));
    document.getElementById('poll-options-wrap').hidden = t !== 'choice';
  }
  function openCompose() {
    document.getElementById('poll-question').value = '';
    optionsBox.innerHTML = '';
    addOption(); addOption();
    setPollType('choice');
    compose.hidden = false;
  }

  document.getElementById('poll-btn').addEventListener('click', () => { if (pollState) openResults(); else openCompose(); });
  document.getElementById('poll-compose-close').onclick = () => { compose.hidden = true; };
  document.getElementById('poll-add-option').onclick = () => addOption();
  document.querySelectorAll('.poll-type').forEach((b) => { b.onclick = () => setPollType(b.dataset.type); });

  document.getElementById('poll-start').onclick = () => {
    const question = document.getElementById('poll-question').value.trim();
    const options = [...optionsBox.querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean);
    if (!question) { toast('Enter a question.'); return; }
    if (pollType === 'choice' && options.length < 2) { toast('Add at least two options.'); return; }
    socket.emit('poll:start', { question, type: pollType, options }, (res) => {
      if (res.error) { toast(res.error); return; }
      pollState = res.results;
      compose.hidden = true;
      openResults();
    });
  };

  socket.on('poll:results', (r) => { pollState = r; if (!results.hidden) renderResults(); });

  function openResults() { results.hidden = false; renderResults(); }
  document.getElementById('poll-results-close').onclick = () => { results.hidden = true; };
  document.getElementById('poll-newpoll').onclick = () => { socket.emit('poll:clear'); pollState = null; results.hidden = true; openCompose(); };
  document.getElementById('poll-end').onclick = () => socket.emit('poll:end', {}, (res) => { if (res && res.results) { pollState = res.results; renderResults(); } });

  document.querySelectorAll('#poll-choice-view [data-chart]').forEach((b) => {
    b.onclick = () => {
      if (!pollState) return;
      wb.addChart({ type: b.dataset.chart, title: pollState.question, labels: pollState.options, series: [pollState.counts], seriesNames: ['Responses'] });
      results.hidden = true;
      toast('Chart added to board');
    };
  });
  document.getElementById('poll-wall-insert').onclick = () => {
    if (!pollState || !pollState.responses) return;
    wb.addTextWall({ title: pollState.question, responses: pollState.responses });
    results.hidden = true;
    toast('Responses added to board');
  };

  function renderResults() {
    if (!pollState) return;
    document.getElementById('poll-results-title').textContent = pollState.question;
    document.getElementById('poll-count').textContent = `${pollState.total} response${pollState.total === 1 ? '' : 's'} · ${pollState.online} online`;
    const flag = document.getElementById('poll-openflag');
    flag.textContent = pollState.open ? 'Open' : 'Closed';
    flag.className = 'status-badge ' + (pollState.open ? 'status-approved' : 'status-blocked');
    document.getElementById('poll-end').hidden = !pollState.open;
    const choiceV = document.getElementById('poll-choice-view');
    const textV = document.getElementById('poll-text-view');
    if (pollState.type === 'choice') { choiceV.hidden = false; textV.hidden = true; renderBars(); }
    else { choiceV.hidden = true; textV.hidden = false; renderWall(); }
  }

  function renderBars() {
    const wrap = document.getElementById('poll-bars');
    wrap.innerHTML = '';
    const max = Math.max(1, ...pollState.counts);
    pollState.options.forEach((opt, i) => {
      const c = pollState.counts[i];
      const pct = pollState.total ? Math.round((c / pollState.total) * 100) : 0;
      const row = document.createElement('div');
      row.className = 'poll-bar-row';
      const label = document.createElement('div');
      label.className = 'poll-bar-label'; label.textContent = opt;
      const track = document.createElement('div');
      track.className = 'poll-bar-track';
      const fill = document.createElement('div');
      fill.className = 'poll-bar-fill';
      fill.style.width = (c / max * 100) + '%';
      fill.style.background = POLL_COLORS[i % POLL_COLORS.length];
      const val = document.createElement('div');
      val.className = 'poll-bar-val'; val.textContent = `${c} · ${pct}%`;
      track.appendChild(fill);
      row.append(label, track, val);
      wrap.appendChild(row);
    });
  }

  function renderWall() {
    const wall = document.getElementById('poll-wall');
    wall.innerHTML = '';
    if (!pollState.responses.length) { wall.innerHTML = '<p class="hint">No answers yet…</p>'; return; }
    const tints = ['#E3F1EF', '#FDF1DC', '#FFE9E0', '#EAF1FD', '#F3ECFB'];
    pollState.responses.forEach((r, i) => {
      const card = document.createElement('div');
      card.className = 'poll-wall-card';
      card.style.background = tints[i % tints.length];
      const v = document.createElement('div');
      v.className = 'poll-wall-text'; v.textContent = r.value;
      const n = document.createElement('div');
      n.className = 'poll-wall-name'; n.textContent = r.name;
      card.append(v, n);
      wall.appendChild(card);
    });
  }

  socket.emit('poll:get', {}, (r) => { if (r) pollState = r; });
}

// ----- class roster (auth mode only) -----

function wireRoster() {
  const btn = document.getElementById('students-btn');
  const modal = document.getElementById('roster-modal');
  const searchInput = document.getElementById('roster-search');
  const resultsEl = document.getElementById('roster-results');
  const listEl = document.getElementById('roster-list');
  let enrolled = new Set();

  btn.hidden = false;
  document.getElementById('roster-room').textContent = room;

  // join-code management lives with the rest of class management
  document.getElementById('code-controls').hidden = false;
  document.getElementById('code-reset').addEventListener('click', () => {
    if (!confirm('Reset the join code? The old code stops working immediately; enrolled students are unaffected.')) return;
    socket.emit('code:reset', {}, (r) => {
      if (r && r.ok) { joinCode = r.joinCode; joinDisabled = false; paintCode(); toast(`New join code: ${r.joinCode}`); }
      else toast((r && r.error) || 'Could not reset the code.');
    });
  });
  document.getElementById('code-disable').addEventListener('click', () => {
    socket.emit('code:toggle', { disabled: !joinDisabled }, (r) => {
      if (r && r.ok) {
        joinDisabled = r.joinDisabled;
        paintCode();
        toast(joinDisabled ? 'Joining by code is off — only enrolled students can enter' : 'Joining by code is back on');
      } else toast((r && r.error) || 'Could not update.');
    });
  });
  paintCode();

  btn.addEventListener('click', async () => {
    modal.hidden = false;
    searchInput.value = '';
    resultsEl.innerHTML = '';
    try {
      renderRoster(await authedFetch(`/api/room/${room}/roster`));
    } catch (e) {
      toast(e.message);
      modal.hidden = true;
    }
  });
  document.getElementById('roster-close').addEventListener('click', () => { modal.hidden = true; });

  function renderRoster(data) {
    enrolled = new Set(data.roster.map((r) => r.email));
    document.getElementById('roster-count').textContent = data.roster.length;
    listEl.innerHTML = '';
    if (!data.roster.length) {
      listEl.innerHTML = '<p class="hint">Nobody enrolled yet. Search on the left, paste a list, or share the room code.</p>';
      return;
    }
    for (const r of data.roster) {
      const row = document.createElement('div');
      row.className = 'roster-row';
      row.innerHTML = `<span class="roster-who"><span class="roster-name"></span><span class="roster-email"></span></span><span class="roster-tags"></span>`;
      row.querySelector('.roster-name').textContent = r.name;
      row.querySelector('.roster-email').textContent = r.email;
      const tags = row.querySelector('.roster-tags');
      if (r.online) tags.innerHTML += '<span class="status-badge status-approved">online</span> ';
      if (r.status === 'pending') tags.innerHTML += '<span class="status-badge status-pending">awaiting admin approval</span> ';
      const del = document.createElement('button');
      del.className = 'btn-block';
      del.textContent = 'Remove';
      del.onclick = async () => {
        if (!confirm(`Remove ${r.name} from this class? Their boards in this room will be deleted. They can rejoin with the room code.`)) return;
        try {
          const d = await authedFetch(`/api/room/${room}/roster`, { method: 'POST', body: JSON.stringify({ remove: [r.email] }) });
          renderRoster(d);
          removeStudentTile(r.email);
          toast(`Removed ${r.name}`);
        } catch (e) { toast(e.message); }
      };
      tags.appendChild(del);
      listEl.appendChild(row);
    }
  }

  async function addEmails(emails) {
    if (!emails.length) return;
    try {
      const d = await authedFetch(`/api/room/${room}/roster`, { method: 'POST', body: JSON.stringify({ add: emails }) });
      renderRoster(d);
      d.added.forEach((s) => upsertStudent({ id: s.email, name: s.name, online: false }));
      const parts = [];
      if (d.added.length) parts.push(`added ${d.added.length}`);
      if (d.pendingApproval.length) parts.push(`${d.pendingApproval.length} awaiting admin approval`);
      if (d.skipped.length) parts.push(`${d.skipped.length} already enrolled/skipped`);
      if (d.invalid.length) parts.push(`${d.invalid.length} invalid`);
      toast(parts.join(', ') || 'No changes');
      runSearch();
    } catch (e) {
      toast(e.message);
    }
  }

  let searchTimer = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 300);
  });

  async function runSearch() {
    const q = searchInput.value.trim();
    try {
      const students = await authedFetch(`/api/students?q=${encodeURIComponent(q)}`);
      resultsEl.innerHTML = '';
      const candidates = students.filter((s) => !enrolled.has(s.email));
      if (!candidates.length) {
        resultsEl.innerHTML = `<p class="hint">${q ? 'No matching students found.' : 'No students to add — try the bulk box below.'}</p>`;
        return;
      }
      for (const s of candidates) {
        const row = document.createElement('div');
        row.className = 'roster-row';
        row.innerHTML = `<span class="roster-who"><span class="roster-name"></span><span class="roster-email"></span></span>`;
        row.querySelector('.roster-name').textContent = s.name;
        row.querySelector('.roster-email').textContent = s.email;
        const addBtn = document.createElement('button');
        addBtn.className = 'btn-approve';
        addBtn.textContent = '＋ Add';
        addBtn.onclick = () => addEmails([s.email]);
        row.appendChild(addBtn);
        resultsEl.appendChild(row);
      }
    } catch (e) {
      toast(e.message);
    }
  }

  document.getElementById('roster-bulk-btn').addEventListener('click', () => {
    const emails = document.getElementById('roster-bulk').value.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    document.getElementById('roster-bulk').value = '';
    addEmails(emails);
  });

  // ----- Google Classroom import (only when Google sign-in is configured) -----
  (function wireClassroomImport() {
    const wrap = document.getElementById('roster-classroom');
    const importBtn = document.getElementById('roster-classroom-btn');
    const picker = document.getElementById('roster-classroom-picker');
    if (!wrap || !googleClientId) return; // hidden in open mode / when no client id
    wrap.hidden = false;

    function getAccessToken() {
      return new Promise((resolve, reject) => {
        if (!(window.google && google.accounts && google.accounts.oauth2)) {
          return reject(new Error('Google is still loading — try again in a moment.'));
        }
        const client = google.accounts.oauth2.initTokenClient({
          client_id: googleClientId,
          scope: 'https://www.googleapis.com/auth/classroom.courses.readonly https://www.googleapis.com/auth/classroom.rosters.readonly https://www.googleapis.com/auth/classroom.profile.emails',
          callback: (resp) => (resp && resp.access_token ? resolve(resp.access_token) : reject(new Error('Google did not grant access.'))),
          error_callback: () => reject(new Error('Google authorization was cancelled.')),
        });
        client.requestAccessToken();
      });
    }

    importBtn.addEventListener('click', async () => {
      picker.innerHTML = '<p class="hint">Connecting to Google Classroom…</p>';
      try {
        const token = await getAccessToken();
        const { courses } = await authedFetch('/api/classroom/courses', { method: 'POST', body: JSON.stringify({ accessToken: token }) });
        if (!courses || !courses.length) { picker.innerHTML = '<p class="hint">No active Google Classroom courses found for your account.</p>'; return; }
        picker.innerHTML = '';
        const label = document.createElement('p');
        label.className = 'hint';
        label.textContent = 'Pick a class to import its students:';
        picker.appendChild(label);
        for (const c of courses) {
          const b = document.createElement('button');
          b.className = 'btn-view';
          b.style.cssText = 'display:block;width:100%;text-align:left;margin:4px 0';
          b.textContent = c.name + (c.section ? ' · ' + c.section : '');
          b.onclick = async () => {
            picker.innerHTML = '<p class="hint">Importing students…</p>';
            try {
              const { students } = await authedFetch('/api/classroom/students', { method: 'POST', body: JSON.stringify({ accessToken: token, courseId: c.id }) });
              const emails = (students || []).map((s) => s.email);
              if (!emails.length) { picker.innerHTML = '<p class="hint">That class has no students with visible email addresses.</p>'; return; }
              await addEmails(emails);
              picker.innerHTML = '';
            } catch (e) { picker.innerHTML = ''; toast(e.message); }
          };
          picker.appendChild(b);
        }
      } catch (e) {
        picker.innerHTML = '';
        toast(e.message);
      }
    });
  })();
}

updateZoomLabel();
