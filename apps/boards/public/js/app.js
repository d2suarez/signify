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
document.getElementById('room-badge').textContent = room || 'My board';

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
  document.getElementById('ctx-crop').hidden = kind !== 'image';
  document.getElementById('ctx-curve').hidden = kind !== 'curve';
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

function setCurrentBoard(meta) {
  currentBoard = { id: meta.id, title: meta.title };
  document.getElementById('board-title').textContent = `${meta.title} ▾`;
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

// Emit any pending debounced change right now (used before switching boards)
function flushBoard() {
  if (wb._changeTimer) {
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
        }
        if (role === 'teacher') {
          (res.students || []).forEach((s) => upsertStudent(s));
          setSharing(res.sharing);
        } else if (res.sharing && res.teacherBoard) {
          studentUI.showShare(res.teacherBoard);
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
    toast(`Opened "${b.title}"`);
  } catch (e) {
    toast(e.message);
  }
}

async function createBoardAndSwitch() {
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
    if (!file) return;
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
    document.querySelectorAll('.tool[data-tool]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    wb.setTool(btn.dataset.tool);
    document.getElementById('hand-mode').hidden = btn.dataset.tool !== 'pan';
    refreshCtx();
  });
});

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
  if (!file) return;
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
['selection:created', 'selection:updated', 'selection:cleared', 'object:moving', 'object:scaling'].forEach((ev) =>
  wb.canvas.on(ev, updateTextToolbar));
wb.canvas.on('text:editing:entered', updateTextToolbar);
wb.canvas.on('text:editing:exited', () => { textToolbar.hidden = true; });
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
document.getElementById('dl-full').addEventListener('click', () => { wb.downloadFull(dlName('board')); dlMenu.open = false; });
document.getElementById('dl-view').addEventListener('click', () => { wb.downloadView(dlName('view')); dlMenu.open = false; });
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
      updatePageNav();
      sendBoard(wb.getJSON(), wb.getThumb());
      toast('Your teacher sent you a new board');
    });
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

function setSharing(on) {
  const btn = document.getElementById('share-btn');
  btn.classList.toggle('sharing', on);
  btn.textContent = on ? 'Stop sharing' : 'Share my board';
  btn.dataset.on = on ? '1' : '';
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
  });

  document.getElementById('share-btn').addEventListener('click', (e) => {
    const on = !e.currentTarget.dataset.on;
    socket.emit(on ? 'share:start' : 'share:stop');
    setSharing(on);
    toast(on ? 'Students now see your board' : 'Stopped sharing');
  });

  document.getElementById('push-btn').addEventListener('click', () => {
    if (confirm('Send your board to every student? This replaces their current board (they can undo).')) {
      socket.emit('template:push', { json: wb.getJSON() });
      toast('Board pushed to the class');
    }
  });

  wirePollTeacher();
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
