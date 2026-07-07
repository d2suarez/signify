/* global io, Whiteboard, BoardViewer */
'use strict';

const params = new URLSearchParams(location.search);
const room = (params.get('room') || '').toUpperCase();
const role = params.get('role') === 'teacher' ? 'teacher' : 'student';
let myName = params.get('name') || '';

if (!room) location.href = '/';

document.title = `${room} — Whiteboard`;
document.getElementById('room-badge').textContent = room;

// ---------- whiteboard ----------

const canvasWrap = document.getElementById('canvas-wrap');
const wb = new Whiteboard('board', canvasWrap, {
  onChange: (json, thumb) => sendBoard(json, thumb),
  onViewChange: updateZoomLabel,
});

function updateZoomLabel() {
  document.getElementById('zoom-label').textContent = Math.round(wb.getZoom() * 100) + '%';
}

// ---------- socket ----------

const statusDot = document.getElementById('status-dot');
const saveIndicator = document.getElementById('save-indicator');
let socket = null;
let hasLoaded = false;

function sendBoard(json, thumb) {
  if (!socket) return;
  saveIndicator.textContent = 'Saving…';
  socket.emit('board:update', { json, thumb }, () => {
    saveIndicator.textContent = 'Saved ✓';
    clearTimeout(sendBoard._t);
    sendBoard._t = setTimeout(() => { saveIndicator.textContent = ''; }, 2000);
  });
}

(async function init() {
  let cfg = { authEnabled: false };
  try {
    cfg = await (await fetch('/api/config')).json();
  } catch { /* fall through to open mode */ }

  let token = null;
  if (cfg.authEnabled) {
    const session = JSON.parse(localStorage.getItem('wb-session') || 'null');
    if (!session || (session.exp && session.exp < Date.now())) {
      localStorage.removeItem('wb-session');
      location.href = '/';
      return;
    }
    token = session.token;
    myName = session.name;
  } else if (!myName) {
    location.href = '/';
    return;
  }

  document.getElementById('user-label').textContent = `${myName} (${role})`;

  socket = io({ auth: { token } });

  socket.on('connect_error', (err) => {
    statusDot.className = 'dot offline';
    if (err.message === 'unauthorized') {
      localStorage.removeItem('wb-session');
      alert('Your sign-in has expired. Please sign in again.');
      location.href = '/';
    }
  });

  socket.on('connect', () => {
    socket.emit('join', { room, name: myName, role }, (res) => {
      if (res.error) {
        alert(res.error);
        location.href = '/';
        return;
      }
      statusDot.className = 'dot online';
      if (res.name) {
        myName = res.name;
        document.getElementById('user-label').textContent = `${myName} (${role})`;
      }
      if (!hasLoaded) {
        hasLoaded = true;
        if (res.board) wb.loadJSON(res.board);
        if (role === 'teacher') {
          (res.students || []).forEach((s) => upsertStudent(s));
          setSharing(res.sharing);
        } else if (res.sharing && res.teacherBoard) {
          studentUI.showShare(res.teacherBoard);
        }
      } else {
        // Reconnected: our local board is the source of truth
        sendBoard(wb.getJSON(), wb.getThumb());
      }
    });
  });

  socket.on('disconnect', () => { statusDot.className = 'dot offline'; });

  if (role === 'student') wireStudent();
  else wireTeacher();
})();

// ---------- toolbar ----------

document.querySelectorAll('.tool[data-tool]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tool[data-tool]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    wb.setTool(btn.dataset.tool);
  });
});

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
document.getElementById('fill-input').addEventListener('change', (e) => {
  wb.setFillShapes(e.target.checked);
});

const imageInput = document.getElementById('image-input');
document.getElementById('image-btn').addEventListener('click', () => imageInput.click());
imageInput.addEventListener('change', () => {
  if (imageInput.files[0]) wb.addImageFile(imageInput.files[0]);
  imageInput.value = '';
});

document.getElementById('ruler-btn').addEventListener('click', () => wb.addRuler());
document.getElementById('undo-btn').addEventListener('click', () => wb.undo());
document.getElementById('redo-btn').addEventListener('click', () => wb.redo());
document.getElementById('delete-btn').addEventListener('click', () => wb.deleteSelection());

// ---------- top bar ----------

document.getElementById('zoom-in').addEventListener('click', () => wb.zoomBy(1.25));
document.getElementById('zoom-out').addEventListener('click', () => wb.zoomBy(0.8));
document.getElementById('zoom-label').addEventListener('click', () => wb.resetZoom());
document.getElementById('zoom-fit').addEventListener('click', () => wb.fitContent());

const dlMenu = document.getElementById('download-menu');
function dlName(kind) {
  const d = new Date().toISOString().slice(0, 10);
  return `${room}-${myName}-${kind}-${d}.png`.replace(/\s+/g, '_');
}
document.getElementById('dl-full').addEventListener('click', () => { wb.downloadFull(dlName('board')); dlMenu.open = false; });
document.getElementById('dl-view').addEventListener('click', () => { wb.downloadView(dlName('view')); dlMenu.open = false; });
document.addEventListener('click', (e) => { if (!dlMenu.contains(e.target)) dlMenu.open = false; });

document.getElementById('clear-btn').addEventListener('click', () => {
  if (confirm('Clear the whole board? You can undo this.')) wb.clear();
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
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); wb.redo(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); wb.deleteSelection(); return; }
  if (e.key === 'Escape') { wb.cancelPending(); return; }
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

  studentUI.showShare = (json) => {
    overlay.hidden = false;
    sizeShareViewer();
    shareViewer.load(json);
  };

  socket.on('share:start', ({ json }) => studentUI.showShare(json));
  socket.on('teacher:board', ({ json }) => { if (!overlay.hidden) shareViewer.load(json); });
  socket.on('share:stop', () => { overlay.hidden = true; });

  socket.on('template', ({ json }) => {
    wb.loadJSON(json, () => {
      wb.fitContent();
      sendBoard(wb.getJSON(), wb.getThumb());
      toast('📥 Your teacher sent you a new board');
    });
  });
}

// ================= TEACHER =================

const latestBoards = new Map(); // student id -> board json
let modalStudent = null; // { id, name }
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
  if (s.board) latestBoards.set(s.id, s.board);
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

function updateStudentCount() {
  const tiles = document.querySelectorAll('#student-tiles .tile:not(.offline)');
  document.getElementById('student-count').textContent = tiles.length;
}

function setSharing(on) {
  const btn = document.getElementById('share-btn');
  btn.classList.toggle('sharing', on);
  btn.textContent = on ? '⏹ Stop sharing' : '📺 Share my board';
  btn.dataset.on = on ? '1' : '';
}

function openStudentModal(id) {
  const tile = document.querySelector(`#student-tiles [data-student="${CSS.escape(id)}"]`);
  const name = (tile && tile.dataset.name) || id;
  modalStudent = { id, name };
  document.getElementById('modal-title').textContent = `${name}'s board (live)`;
  const modal = document.getElementById('student-modal');
  modal.hidden = false;
  const wrap = modal.querySelector('.overlay-canvas-wrap');
  modalViewer.setSize(wrap.clientWidth, wrap.clientHeight);
  modalViewer.load(latestBoards.get(id) || null);
}

function wireTeacher() {
  document.getElementById('students-panel').hidden = false;
  document.querySelectorAll('.teacher-only').forEach((el) => { el.hidden = false; });

  const modal = document.getElementById('student-modal');
  modalViewer = new BoardViewer('modal-canvas');

  document.getElementById('modal-close').addEventListener('click', () => {
    modal.hidden = true;
    modalStudent = null;
  });
  document.getElementById('modal-push').addEventListener('click', () => {
    if (!modalStudent) return;
    if (confirm(`Replace ${modalStudent.name}'s board with your board?`)) {
      socket.emit('template:push', { json: wb.getJSON(), target: modalStudent.id });
      toast(`📤 Board sent to ${modalStudent.name}`);
    }
  });

  socket.on('student:joined', (s) => {
    upsertStudent({ ...s, online: true });
    toast(`👋 ${s.name} joined`);
  });

  socket.on('student:left', ({ id }) => {
    const tile = document.querySelector(`#student-tiles [data-student="${CSS.escape(id)}"]`);
    if (tile) tile.classList.add('offline');
    updateStudentCount();
  });

  socket.on('student:board', ({ id, name, json, thumb }) => {
    latestBoards.set(id, json);
    const tile = document.querySelector(`#student-tiles [data-student="${CSS.escape(id)}"]`);
    if (tile) {
      tile.classList.remove('offline');
      if (thumb) setTileThumb(tile, thumb);
    } else {
      upsertStudent({ id, name, online: true, thumb });
    }
    updateStudentCount();
    if (modalStudent && modalStudent.id === id) modalViewer.load(json);
  });

  document.getElementById('share-btn').addEventListener('click', (e) => {
    const on = !e.currentTarget.dataset.on;
    socket.emit(on ? 'share:start' : 'share:stop');
    setSharing(on);
    toast(on ? '📺 Students now see your board' : 'Stopped sharing');
  });

  document.getElementById('push-btn').addEventListener('click', () => {
    if (confirm('Send your board to every student? This replaces what is on their boards (they can undo).')) {
      socket.emit('template:push', { json: wb.getJSON() });
      toast('📤 Board pushed to the class');
    }
  });
}

updateZoomLabel();
