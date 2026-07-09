/* global io, Whiteboard, BoardViewer, pdfjsLib */
'use strict';

const params = new URLSearchParams(location.search);
const room = (params.get('room') || '').toUpperCase();
const soloBoardId = params.get('board') || null; // personal board, no room
const role = params.get('role') === 'teacher' ? 'teacher' : 'student';
let myName = params.get('name') || '';

if (!room && !soloBoardId) location.href = '/';

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
  document.getElementById('ctx-comment').hidden = !anySelection || isSolo || wb.canvas.getActiveObjects().length !== 1;
  document.getElementById('ctx-send').hidden = !(anySelection && role === 'teacher' && !isSolo);
  const apply = document.getElementById('ctx-apply');
  apply.hidden = !(cropping || editing);
  apply.textContent = cropping ? 'Apply crop' : 'Done';
  document.getElementById('ctx-cancel').hidden = !(cropping || editing);
}

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

function setCurrentBoard(meta, foreignName) {
  currentBoard = { id: meta.id, title: meta.title };
  foreignBoardOwner = foreignName || null;
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
let authToken = null;

async function authedFetch(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (authToken) headers.Authorization = 'Bearer ' + authToken;
  const res = await fetch(path, { ...opts, headers });
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

function sendBoard(json, thumb) {
  if (!currentBoard) return;
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

  if (cfg.authEnabled) {
    const session = JSON.parse(localStorage.getItem('wb-session') || 'null');
    if (!session || (session.exp && session.exp < Date.now())) {
      localStorage.removeItem('wb-session');
      location.href = '/';
      return;
    }
    authToken = session.token;
    myName = session.name;
  } else if (isSolo) {
    location.href = '/'; // personal boards need sign-in
    return;
  } else if (!myName) {
    location.href = '/';
    return;
  }

  document.getElementById('user-label').textContent = isSolo ? myName : `${myName} (${role})`;
  wireBoardsDrawer();
  wireDocuments();

  if (isSolo) {
    statusDot.hidden = true;
    try {
      const b = await authedFetch(`/api/boards/${soloBoardId}`);
      setCurrentBoard(b);
      if (b.json) wb.loadJSON(b.json, updatePageNav);
      hasLoaded = true;
    } catch (e) {
      alert(e.message);
      location.href = '/';
    }
    return;
  }

  socket = io({ auth: { token: authToken } });

  // Room boards sync per-object ops (tiny) instead of the whole board per stroke
  wb.enableOps((ops, thumb) => {
    if (!currentBoard || !socket || !socket.connected) return;
    saveIndicator.textContent = 'Saving…';
    socket.emit('board:ops', { boardId: currentBoard.id, ops, thumb }, savedFlash);
  });
  wb.onChange = () => {}; // whole-board path stays only for reconnect pushes

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
      boardsList = res.boards || [];
      if (!hasLoaded) {
        hasLoaded = true;
        if (res.activeBoard) {
          setCurrentBoard(boardsList.find((b) => b.id === res.activeBoard.id) || { id: res.activeBoard.id, title: 'Board' });
          if (res.activeBoard.json) wb.loadJSON(res.activeBoard.json, updatePageNav);
          setBoardComments(res.activeBoard.comments || []);
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
        }
      } else if (currentBoard) {
        // Reconnected: our local board is the source of truth
        sendBoard(wb.getJSON(), wb.getThumb());
      }
    });
  });

  socket.on('disconnect', () => { statusDot.className = 'dot offline'; });

  if (role === 'student') wireStudent();
  else wireTeacher();
  wireCommon();
})();

// ---------- board switcher drawer ----------

async function fetchBoardsList() {
  if (isSolo) {
    boardsList = await authedFetch('/api/boards/personal');
  } else {
    boardsList = await new Promise((resolve) => socket.emit('board:list', {}, resolve));
  }
  return boardsList;
}

async function loadBoardFull(id) {
  if (isSolo) return authedFetch(`/api/boards/${id}`);
  return new Promise((resolve, reject) => {
    socket.emit('board:load', { boardId: id }, (res) => (res && res.ok ? resolve({ ...res.meta, json: res.json }) : reject(new Error((res && res.error) || 'Could not load board.'))));
  });
}

async function switchBoard(id) {
  if (currentBoard && id === currentBoard.id) return;
  flushBoard();
  try {
    const b = await loadBoardFull(id);
    setCurrentBoard(b);
    if (b.json) wb.loadJSON(b.json, updatePageNav);
    else { wb.clear(); updatePageNav(); }
    setBoardComments(b.comments || []);
    toast(`Opened "${b.title}"`);
  } catch (e) {
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
    updatePageNav();
    renderBoardsGrid(await fetchBoardsList());
  } catch (e) {
    toast(e.message);
  }
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
          if (currentBoard && currentBoard.id === b.id) wb.loadJSON(json, updatePageNav);
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
          headers: authToken ? { Authorization: 'Bearer ' + authToken } : {},
          body: file,
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error || 'Conversion failed.');
        }
        pdfData = await res.arrayBuffer();
      }
      await insertPdf(pdfData);
    } catch (e) {
      toast(e.message);
    }
  });

  document.getElementById('page-prev').addEventListener('click', () => wb.gotoDocPage(wb.getCurrentDocPage() - 1));
  document.getElementById('page-next').addEventListener('click', () => wb.gotoDocPage(wb.getCurrentDocPage() + 1));
}

const MAX_DOC_PAGES = 40;

async function insertPdf(arrayBuffer) {
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
  wb.addDocumentPages(urls, (n) => {
    toast(`Added ${n} page${n === 1 ? '' : 's'}${doc.numPages > pages ? ` (of ${doc.numPages} — capped)` : ''}. Scroll or use ◀ ▶ to move through them.`);
    updatePageNav();
  });
}

function updatePageNav() {
  const count = wb.getDocPages().length;
  const show = count > 0;
  document.getElementById('page-prev').hidden = !show;
  document.getElementById('page-next').hidden = !show;
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
  shapesMenu.style.top = Math.min(shapesBtn.getBoundingClientRect().top, window.innerHeight - 90) + 'px';
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
function updateTextToolbar() {
  const o = wb.getActiveText();
  if (!o) { textToolbar.hidden = true; return; }
  const r = o.getBoundingRect();
  textToolbar.hidden = false;
  const tw = textToolbar.offsetWidth || 240;
  let left = r.left + r.width / 2 - tw / 2;
  left = Math.max(6, Math.min(left, canvasWrap.clientWidth - tw - 6));
  textToolbar.style.left = left + 'px';
  textToolbar.style.top = Math.max(4, r.top - 44) + 'px';
  document.getElementById('tt-bold').classList.toggle('on', wb.getTextStyleValue('fontWeight') === 'bold' || wb.getTextStyleValue('fontWeight') === 700);
  document.getElementById('tt-italic').classList.toggle('on', wb.getTextStyleValue('fontStyle') === 'italic');
  document.getElementById('tt-underline').classList.toggle('on', wb.getTextStyleValue('underline') === true);
}
document.getElementById('tt-bold').addEventListener('mousedown', (e) => { e.preventDefault(); wb.toggleTextStyle('fontWeight', 'bold', 'normal'); updateTextToolbar(); });
document.getElementById('tt-italic').addEventListener('mousedown', (e) => { e.preventDefault(); wb.toggleTextStyle('fontStyle', 'italic', 'normal'); updateTextToolbar(); });
document.getElementById('tt-underline').addEventListener('mousedown', (e) => { e.preventDefault(); wb.toggleTextStyle('underline', true, false); updateTextToolbar(); });
document.getElementById('tt-smaller').addEventListener('mousedown', (e) => { e.preventDefault(); wb.changeTextSize(-4); updateTextToolbar(); });
document.getElementById('tt-bigger').addEventListener('mousedown', (e) => { e.preventDefault(); wb.changeTextSize(4); updateTextToolbar(); });
document.getElementById('tt-color').addEventListener('mousedown', (e) => { e.preventDefault(); wb.applyTextStyle({ fill: wb.color }); });

// font picker (buttons, not a <select>, so text editing keeps focus)
const TEXT_FONTS = ['Bricolage Grotesque', 'Arial', 'Georgia', 'Times New Roman', 'Courier New', 'Comic Sans MS'];
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

  // another device (mine, or the teacher's pen on my board) changed this board
  socket.on('board:peer', ({ boardId, json, note }) => {
    if (currentBoard && currentBoard.id === boardId) {
      wb.loadJSON(json, updatePageNav);
    }
    if (note) toast(note);
  });

  // incremental object ops from other editors of boards I can see
  socket.on('board:ops', ({ boardId, owner, ops, note }) => {
    if (currentBoard && currentBoard.id === boardId) {
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
    try {
      flushBoard();
      const b = await loadBoardFull(modalBoardId);
      setCurrentBoard(b, name);
      wb.loadJSON(b.json || { version: '5.3.0', objects: [] }, updatePageNav);
      setBoardComments(b.comments || []);
      toast(`You are drawing on ${name}'s board — they see your changes live`);
    } catch (e) { toast(e.message); }
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

// ================= FEATURE SWITCHES =================

const FEATURE_DEFS = [
  ['draw', 'Drawing'],
  ['text', 'Text'],
  ['images', 'Photos'],
  ['documents', 'Documents'],
  ['charts', 'Charts & graphs'],
  ['newBoards', 'New boards'],
  ['download', 'Download'],
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
  if (f === 'charts') return [document.getElementById('graph-btn'), document.getElementById('chart-btn')];
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
}

updateZoomLabel();
