/* global BoardViewer */
'use strict';

const session = JSON.parse(localStorage.getItem('wb-session') || 'null');
if (!session || (session.exp && session.exp < Date.now())) {
  location.href = '/';
}

let state = null;
const toastEl = document.getElementById('toast');

function toast(msg, isError) {
  toastEl.textContent = msg;
  toastEl.style.borderColor = isError ? '#dc2626' : '#4f46e5';
  toastEl.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toastEl.hidden = true; }, 3500);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + session.token,
      ...(opts.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { location.href = '/'; throw new Error('unauthorized'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- nav ----------

document.querySelectorAll('.nav-pill').forEach((pill) => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('.nav-pill').forEach((p) => p.classList.remove('active'));
    pill.classList.add('active');
    document.querySelectorAll('.admin-section').forEach((s) => { s.hidden = true; });
    document.getElementById('section-' + pill.dataset.section).hidden = false;
  });
});

document.getElementById('admin-refresh').addEventListener('click', () => refresh(true));

// ---------- rendering ----------

function fmtTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString();
}

function renderUsers() {
  const tbody = document.querySelector('#users-table tbody');
  tbody.innerHTML = '';
  const iAmSuper = state.me.role === 'superadmin';
  const pending = state.users.filter((u) => u.status === 'pending').length;
  const badge = document.getElementById('pending-badge');
  badge.hidden = !pending;
  badge.textContent = pending;

  const order = { pending: 0, approved: 1, blocked: 2 };
  const sorted = [...state.users].sort((a, b) => (order[a.status] - order[b.status]) || (b.lastSeen || 0) - (a.lastSeen || 0));

  for (const u of sorted) {
    const tr = document.createElement('tr');
    if (u.status === 'pending') tr.className = 'row-pending';

    const tdUser = document.createElement('td');
    tdUser.innerHTML = `<div class="u-name"></div><div class="u-email"></div>`;
    tdUser.querySelector('.u-name').textContent = u.name;
    tdUser.querySelector('.u-email').textContent = u.email;
    tr.appendChild(tdUser);

    const tdRole = document.createElement('td');
    if (u.isSuper) {
      tdRole.innerHTML = '<span class="badge-super">super admin</span>';
    } else {
      const sel = document.createElement('select');
      const canManageAdmins = iAmSuper;
      [['student', 'Student'], ['teacher', 'Teacher'], ['admin', 'Local admin']].forEach(([v, label]) => {
        if (v === 'admin' && !canManageAdmins) return;
        const opt = new Option(label, v, false, u.role === v);
        sel.appendChild(opt);
      });
      sel.disabled = u.role === 'admin' && !canManageAdmins;
      sel.onchange = () => updateUser(u.email, { role: sel.value });
      tdRole.appendChild(sel);
    }
    tr.appendChild(tdRole);

    const tdStatus = document.createElement('td');
    tdStatus.innerHTML = `<span class="status-badge status-${u.status}">${u.status}</span>`;
    tr.appendChild(tdStatus);

    const tdSeen = document.createElement('td');
    tdSeen.textContent = fmtTime(u.lastSeen);
    tr.appendChild(tdSeen);

    const tdActions = document.createElement('td');
    if (!u.isSuper && (u.role !== 'admin' || iAmSuper)) {
      if (u.status !== 'approved') {
        const b = document.createElement('button');
        b.className = 'btn-approve';
        b.textContent = '✓ Approve';
        b.onclick = () => updateUser(u.email, { status: 'approved' });
        tdActions.appendChild(b);
      }
      if (u.status !== 'blocked') {
        const b = document.createElement('button');
        b.className = 'btn-block';
        b.textContent = '⛔ Block';
        b.onclick = () => { if (confirm(`Block ${u.email}? They will be disconnected and unable to sign in.`)) updateUser(u.email, { status: 'blocked' }); };
        tdActions.appendChild(b);
      }
    }
    tr.appendChild(tdActions);
    tbody.appendChild(tr);
  }
}

async function updateUser(email, patch) {
  try {
    await api('/api/admin/user', { method: 'POST', body: JSON.stringify({ email, ...patch }) });
    toast(`Updated ${email}`);
    refresh();
  } catch (e) {
    toast(e.message, true);
    refresh();
  }
}

document.getElementById('add-user-btn').addEventListener('click', async () => {
  const email = document.getElementById('add-email').value.trim();
  const role = document.getElementById('add-role').value;
  if (!email) return;
  try {
    await api('/api/admin/user', { method: 'POST', body: JSON.stringify({ email, role, status: 'approved' }) });
    document.getElementById('add-email').value = '';
    toast(`Added ${email} as ${role}`);
    refresh();
  } catch (e) {
    toast(e.message, true);
  }
});

function renderDomains() {
  const ul = document.getElementById('domains-list');
  ul.innerHTML = '';
  const iAmSuper = state.me.role === 'superadmin';
  document.querySelector('#section-domains .add-user-row').style.display = iAmSuper ? '' : 'none';
  if (!state.domains.length) {
    ul.innerHTML = '<li class="hint">No approved domains yet — every account needs individual approval.</li>';
    return;
  }
  for (const d of state.domains) {
    const li = document.createElement('li');
    li.innerHTML = `<span>@${d}</span>`;
    if (iAmSuper) {
      const b = document.createElement('button');
      b.className = 'btn-block';
      b.textContent = 'Remove';
      b.onclick = async () => {
        if (!confirm(`Remove @${d}? New sign-ins from it will need individual approval.`)) return;
        try { await api('/api/admin/domains', { method: 'POST', body: JSON.stringify({ action: 'remove', domain: d }) }); refresh(); }
        catch (e) { toast(e.message, true); }
      };
      li.appendChild(b);
    }
    ul.appendChild(li);
  }
}

document.getElementById('add-domain-btn').addEventListener('click', async () => {
  const domain = document.getElementById('add-domain').value.trim();
  if (!domain) return;
  try {
    await api('/api/admin/domains', { method: 'POST', body: JSON.stringify({ action: 'add', domain }) });
    document.getElementById('add-domain').value = '';
    toast(`Approved @${domain.replace(/^@/, '')}`);
    refresh();
  } catch (e) {
    toast(e.message, true);
  }
});

function renderSessions() {
  const tbody = document.querySelector('#sessions-table tbody');
  tbody.innerHTML = '';
  document.getElementById('session-count').textContent = state.sessions.length;
  document.getElementById('sessions-empty').hidden = !!state.sessions.length;
  for (const s of state.sessions) {
    const tr = document.createElement('tr');
    [s.room, s.name, s.email || '—', s.role, fmtTime(s.since)].forEach((v) => {
      const td = document.createElement('td');
      td.textContent = v;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
}

function renderRooms() {
  const wrap = document.getElementById('rooms-admin-list');
  wrap.innerHTML = '';
  if (!state.rooms.length) {
    wrap.innerHTML = '<p class="hint">No rooms yet.</p>';
    return;
  }
  for (const r of state.rooms) {
    const card = document.createElement('div');
    card.className = 'room-card';
    card.innerHTML = `
      <div class="room-card-head">
        <span class="badge">${r.code}</span>
        <span class="room-meta">${r.students} student board${r.students === 1 ? '' : 's'} · ${r.online} online${r.teacherOnline ? ' · teacher live' : ''} · ${fmtTime(r.updatedAt)}</span>
        <span class="room-card-actions">
          <button class="btn-view">View boards</button>
          <button class="btn-block btn-del-room">Delete room</button>
        </span>
      </div>
      <div class="room-boards" hidden></div>`;
    card.querySelector('.btn-del-room').onclick = async () => {
      if (!confirm(`Delete room ${r.code} and ALL its boards? This cannot be undone.`)) return;
      try { await api(`/api/admin/room/${r.code}`, { method: 'DELETE' }); toast(`Deleted room ${r.code}`); refresh(); }
      catch (e) { toast(e.message, true); }
    };
    card.querySelector('.btn-view').onclick = () => toggleRoomBoards(card, r.code);
    wrap.appendChild(card);
  }
}

async function toggleRoomBoards(card, code) {
  const panel = card.querySelector('.room-boards');
  if (!panel.hidden) { panel.hidden = true; return; }
  try {
    const { data } = await api(`/api/admin/room/${code}`);
    panel.innerHTML = '';
    const entries = [];
    if (data.teacherBoard) entries.push({ id: '__teacher__', name: '👩‍🏫 Teacher board', json: data.teacherBoard, thumb: null });
    for (const [id, json] of Object.entries(data.boards || {})) {
      entries.push({ id, name: (data.names || {})[id] || id, json, thumb: (data.thumbs || {})[id] || null });
    }
    if (!entries.length) panel.innerHTML = '<p class="hint">No boards saved in this room yet.</p>';
    for (const e of entries) {
      const item = document.createElement('div');
      item.className = 'board-item';
      const img = e.thumb ? `<img src="${e.thumb}" alt="" />` : '<div class="tile-empty">No preview</div>';
      item.innerHTML = `${img}<div class="board-item-foot"><span class="board-item-name"></span><span><button class="btn-view">View</button><button class="btn-block">Delete</button></span></div>`;
      item.querySelector('.board-item-name').textContent = e.name;
      item.querySelector('.btn-view').onclick = () => openViewer(`${code} — ${e.name}`, e.json);
      item.querySelector('.btn-block').onclick = async () => {
        if (!confirm(`Delete ${e.name}'s board in ${code}?`)) return;
        try { await api(`/api/admin/room/${code}/board/${encodeURIComponent(e.id)}`, { method: 'DELETE' }); toast('Board deleted'); toggleRoomBoards(card, code); toggleRoomBoards(card, code); refresh(); }
        catch (err) { toast(err.message, true); }
      };
      panel.appendChild(item);
    }
    panel.hidden = false;
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------- board viewer ----------

let viewer = null;
function openViewer(title, json) {
  const modal = document.getElementById('board-viewer-modal');
  document.getElementById('viewer-title').textContent = title;
  modal.hidden = false;
  if (!viewer) viewer = new BoardViewer('viewer-canvas');
  const wrap = modal.querySelector('.overlay-canvas-wrap');
  viewer.setSize(wrap.clientWidth, wrap.clientHeight);
  viewer.load(json);
}
document.getElementById('viewer-close').addEventListener('click', () => {
  document.getElementById('board-viewer-modal').hidden = true;
});

// ---------- refresh loop ----------

async function refresh(manual) {
  try {
    state = await api('/api/admin/state');
    document.getElementById('admin-me').textContent = `${state.me.name || state.me.email} · ${state.me.role === 'superadmin' ? 'super admin' : 'local admin'}`;
    renderUsers();
    renderDomains();
    renderSessions();
    renderRooms();
    if (manual) toast('Refreshed');
  } catch (e) {
    if (e.message !== 'unauthorized') toast(e.message, true);
  }
}

refresh();
setInterval(() => {
  // keep sessions/users fresh without stomping on open board panels
  api('/api/admin/state').then((s) => {
    state = s;
    renderUsers();
    renderSessions();
    document.getElementById('session-count').textContent = s.sessions.length;
  }).catch(() => {});
}, 15000);
