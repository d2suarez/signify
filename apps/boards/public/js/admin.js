/* global BoardViewer */
'use strict';

const session = JSON.parse(localStorage.getItem('wb-session') || 'null');
if (!session || (session.exp && session.exp < Date.now())) {
  location.href = '/';
}

const PERM_LABELS = {
  teach: 'Teach classes (create rooms, share, push templates)',
  manage_users: 'Manage users (approve, block, assign roles — scoped to own domain unless super admin)',
  manage_boards: 'View & delete rooms and boards',
  view_sessions: 'View live sessions',
  manage_domains: 'Manage approved domains',
};

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

function can(perm) {
  return state.me.isSuper || state.me.perms.includes(perm);
}

function roleById(id) {
  return state.roles.find((r) => r.id === id) || null;
}

function roleLabel(id) {
  if (id === 'superadmin') return 'super admin';
  const r = roleById(id);
  return r ? r.label : id;
}

// Roles a non-super manager may hand out: no admin permissions
function assignableRoles() {
  if (state.me.isSuper) return state.roles;
  return state.roles.filter((r) => r.perms.every((p) => p === 'teach'));
}

// ---------- nav ----------

document.querySelectorAll('.nav-pill').forEach((pill) => {
  pill.addEventListener('click', () => activateSection(pill.dataset.section));
});

function activateSection(section) {
  document.querySelectorAll('.nav-pill').forEach((p) => p.classList.toggle('active', p.dataset.section === section));
  document.querySelectorAll('.admin-section').forEach((s) => { s.hidden = s.id !== 'section-' + section; });
}

function applyNavVisibility() {
  const visible = {
    users: can('manage_users'),
    roles: state.me.isSuper,
    domains: can('manage_domains'),
    sessions: can('view_sessions'),
    boards: can('manage_boards'),
  };
  let first = null;
  document.querySelectorAll('.nav-pill').forEach((pill) => {
    const show = visible[pill.dataset.section];
    pill.hidden = !show;
    if (show && !first) first = pill.dataset.section;
  });
  const active = document.querySelector('.nav-pill.active');
  if ((!active || active.hidden) && first) activateSection(first);
}

document.getElementById('admin-refresh').addEventListener('click', () => refresh(true));

// ---------- rendering ----------

function fmtTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString();
}

function renderUsers() {
  if (!can('manage_users')) return;
  const tbody = document.querySelector('#users-table tbody');
  tbody.innerHTML = '';
  const pending = state.users.filter((u) => u.status === 'pending').length;
  const badge = document.getElementById('pending-badge');
  badge.hidden = !pending;
  badge.textContent = pending;

  // Scoped admins may only assign teach-only roles
  const roleOptions = assignableRoles();

  const order = { pending: 0, approved: 1, blocked: 2 };
  const sorted = [...state.users].sort((a, b) => (order[a.status] - order[b.status]) || (b.lastSeen || 0) - (a.lastSeen || 0));

  for (const u of sorted) {
    const tr = document.createElement('tr');
    if (u.status === 'pending') tr.className = 'row-pending';

    const tdUser = document.createElement('td');
    tdUser.innerHTML = `<div class="u-name"></div><div class="u-email"></div>`;
    tdUser.querySelector('.u-name').textContent = u.name;
    tdUser.querySelector('.u-email').textContent = u.email + (u.addedBy ? ` · added by ${u.addedBy}` : '');
    tr.appendChild(tdUser);

    const tdRole = document.createElement('td');
    if (u.isSuper) {
      tdRole.innerHTML = '<span class="badge-super">super admin</span>';
    } else {
      const currentAssignable = roleOptions.some((r) => r.id === u.role);
      const sel = document.createElement('select');
      for (const r of roleOptions) {
        sel.appendChild(new Option(r.label, r.id, false, u.role === r.id));
      }
      if (!currentAssignable) {
        // e.g. scoped admin looking at a role they can't hand out — show, but lock
        sel.appendChild(new Option(roleLabel(u.role), u.role, false, true));
        sel.disabled = true;
      }
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
    if (!u.isSuper) {
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

function renderAddUserRoles() {
  for (const selId of ['add-role', 'bulk-role']) {
    const sel = document.getElementById(selId);
    sel.innerHTML = '';
    for (const r of assignableRoles()) {
      sel.appendChild(new Option(r.label, r.id, r.id === 'student', r.id === 'student'));
    }
  }
}

document.getElementById('bulk-add-btn').addEventListener('click', async () => {
  const box = document.getElementById('bulk-emails');
  const emails = box.value.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  const role = document.getElementById('bulk-role').value;
  if (!emails.length) { toast('Paste some email addresses first.', true); return; }
  try {
    const d = await api('/api/admin/users/bulk', { method: 'POST', body: JSON.stringify({ emails, role }) });
    box.value = '';
    const parts = [`added ${d.added.length}`];
    if (d.skipped.length) parts.push(`${d.skipped.length} already existed`);
    if (d.invalid.length) parts.push(`${d.invalid.length} invalid`);
    toast('👥 ' + parts.join(', '));
    refresh();
  } catch (e) {
    toast(e.message, true);
  }
});

document.getElementById('add-user-btn').addEventListener('click', async () => {
  const email = document.getElementById('add-email').value.trim();
  const role = document.getElementById('add-role').value;
  if (!email) return;
  try {
    await api('/api/admin/user', { method: 'POST', body: JSON.stringify({ email, role, status: 'approved' }) });
    document.getElementById('add-email').value = '';
    toast(`Added ${email} as ${roleLabel(role)}`);
    refresh();
  } catch (e) {
    toast(e.message, true);
  }
});

// ---------- roles ----------

function permCheckboxes(container, checked, disabled) {
  container.innerHTML = '';
  for (const p of state.permissions) {
    const label = document.createElement('label');
    label.className = 'perm-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = p;
    cb.checked = checked.includes(p);
    cb.disabled = !!disabled;
    label.appendChild(cb);
    label.appendChild(document.createTextNode(' ' + (PERM_LABELS[p] || p)));
    container.appendChild(label);
  }
}

function selectedPerms(container) {
  return [...container.querySelectorAll('input:checked')].map((c) => c.value);
}

function renderRoles() {
  if (!state.me.isSuper) return;
  permCheckboxes(document.getElementById('new-role-perms'), [], false);

  const wrap = document.getElementById('roles-list');
  wrap.innerHTML = '';
  for (const role of state.roles) {
    const card = document.createElement('div');
    card.className = 'admin-card';
    const locked = role.id === 'student';
    const userCount = state.users.filter((u) => u.role === role.id).length;

    const head = document.createElement('div');
    head.className = 'role-head';
    head.innerHTML = `<h2></h2><span class="hint role-meta"></span>`;
    head.querySelector('h2').textContent = role.label;
    head.querySelector('.role-meta').textContent =
      `id: ${role.id} · ${role.builtin ? 'built-in' : 'custom'} · ${userCount} user${userCount === 1 ? '' : 's'}${locked ? ' · locked (default role)' : ''}`;
    card.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'perm-grid';
    permCheckboxes(grid, role.perms, locked);
    card.appendChild(grid);

    if (!locked) {
      const actions = document.createElement('div');
      actions.className = 'role-actions';
      const save = document.createElement('button');
      save.className = 'primary-sm';
      save.textContent = 'Save permissions';
      save.onclick = async () => {
        try {
          await api('/api/admin/roles', { method: 'POST', body: JSON.stringify({ action: 'update', id: role.id, perms: selectedPerms(grid) }) });
          toast(`Updated ${role.label}`);
          refresh();
        } catch (e) { toast(e.message, true); }
      };
      actions.appendChild(save);
      if (!role.builtin) {
        const del = document.createElement('button');
        del.className = 'btn-block';
        del.textContent = 'Delete role';
        del.onclick = async () => {
          if (!confirm(`Delete the "${role.label}" role? Its ${userCount} user${userCount === 1 ? '' : 's'} will become Students.`)) return;
          try {
            await api('/api/admin/roles', { method: 'POST', body: JSON.stringify({ action: 'delete', id: role.id }) });
            toast(`Deleted ${role.label}`);
            refresh();
          } catch (e) { toast(e.message, true); }
        };
        actions.appendChild(del);
      }
      card.appendChild(actions);
    }
    wrap.appendChild(card);
  }
}

document.getElementById('create-role-btn').addEventListener('click', async () => {
  const id = document.getElementById('new-role-id').value.trim().toLowerCase();
  const label = document.getElementById('new-role-label').value.trim();
  const perms = selectedPerms(document.getElementById('new-role-perms'));
  if (!id) { toast('Enter a role id.', true); return; }
  try {
    await api('/api/admin/roles', { method: 'POST', body: JSON.stringify({ action: 'create', id, label: label || id, perms }) });
    document.getElementById('new-role-id').value = '';
    document.getElementById('new-role-label').value = '';
    toast(`Created role ${label || id}`);
    refresh();
  } catch (e) {
    toast(e.message, true);
  }
});

// ---------- domains ----------

function renderDomains() {
  if (!can('manage_domains')) return;
  const ul = document.getElementById('domains-list');
  ul.innerHTML = '';
  if (!state.domains.length) {
    ul.innerHTML = '<li class="hint">No approved domains yet — every account needs individual approval.</li>';
    return;
  }
  for (const d of state.domains) {
    const li = document.createElement('li');
    li.innerHTML = `<span>@${d}</span>`;
    const b = document.createElement('button');
    b.className = 'btn-block';
    b.textContent = 'Remove';
    b.onclick = async () => {
      if (!confirm(`Remove @${d}? New sign-ins from it will need individual approval.`)) return;
      try { await api('/api/admin/domains', { method: 'POST', body: JSON.stringify({ action: 'remove', domain: d }) }); refresh(); }
      catch (e) { toast(e.message, true); }
    };
    li.appendChild(b);
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

// ---------- sessions ----------

function renderSessions() {
  if (!can('view_sessions')) return;
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

// ---------- boards ----------

function renderRooms() {
  if (!can('manage_boards')) return;
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
        <span class="room-title"></span>
        <span class="room-meta"></span>
        <span class="room-card-actions">
          <button class="btn-view">Boards</button>
          <button class="btn-view btn-roster">Roster</button>
          <button class="btn-view btn-rename">Rename</button>
          <button class="btn-view btn-owner">Owner</button>
          <button class="btn-block btn-del-room">Delete</button>
        </span>
      </div>
      <div class="room-boards" hidden></div>
      <div class="room-roster-panel" hidden></div>`;
    card.querySelector('.room-title').textContent = r.name || '(unnamed)';
    card.querySelector('.room-meta').textContent =
      `${r.owner || 'no owner'} · ${r.rosterCount} enrolled · ${r.students} board${r.students === 1 ? '' : 's'} · ${r.online} online${r.teacherOnline ? ' · teacher live' : ''} · ${fmtTime(r.updatedAt)}`;
    card.querySelector('.btn-del-room').onclick = async () => {
      if (!confirm(`Delete room ${r.code} and ALL its boards? This cannot be undone.`)) return;
      try { await api(`/api/admin/room/${r.code}`, { method: 'DELETE' }); toast(`Deleted room ${r.code}`); refresh(); }
      catch (e) { toast(e.message, true); }
    };
    card.querySelector('.btn-view').onclick = () => toggleRoomBoards(card, r.code);
    card.querySelector('.btn-rename').onclick = async () => {
      const name = prompt(`New name for ${r.code}:`, r.name || '');
      if (name === null) return;
      try { await api(`/api/room/${r.code}/meta`, { method: 'POST', body: JSON.stringify({ name }) }); toast('Renamed'); refresh(); }
      catch (e) { toast(e.message, true); }
    };
    card.querySelector('.btn-owner').onclick = async () => {
      const owner = prompt(`Teacher (owner) email for ${r.code}:`, r.owner || '');
      if (!owner) return;
      try { await api(`/api/room/${r.code}/meta`, { method: 'POST', body: JSON.stringify({ owner }) }); toast('Owner updated'); refresh(); }
      catch (e) { toast(e.message, true); }
    };
    card.querySelector('.btn-roster').onclick = () => toggleRoomRoster(card, r.code);
    wrap.appendChild(card);
  }
}

document.getElementById('create-room-admin-btn').addEventListener('click', async () => {
  const name = document.getElementById('new-room-name-admin').value.trim();
  const code = document.getElementById('new-room-code-admin').value.trim();
  const owner = document.getElementById('new-room-owner-admin').value.trim();
  try {
    const d = await api('/api/rooms/create', { method: 'POST', body: JSON.stringify({ name, code: code || undefined, owner: owner || undefined }) });
    ['new-room-name-admin', 'new-room-code-admin', 'new-room-owner-admin'].forEach((id) => { document.getElementById(id).value = ''; });
    toast(`Created classroom ${d.code}${d.name ? ` (${d.name})` : ''}`);
    refresh();
  } catch (e) {
    toast(e.message, true);
  }
});

async function toggleRoomRoster(card, code) {
  const panel = card.querySelector('.room-roster-panel');
  if (!panel.hidden) { panel.hidden = true; return; }
  try {
    await renderRoomRoster(panel, code);
    panel.hidden = false;
  } catch (e) {
    toast(e.message, true);
  }
}

async function renderRoomRoster(panel, code) {
  const d = await api(`/api/room/${code}/roster`);
  panel.innerHTML = '';
  const addRow = document.createElement('div');
  addRow.className = 'add-user-row';
  addRow.innerHTML = `<input type="text" placeholder="Emails to enroll (comma or space separated)" /><button class="primary-sm">Enroll</button>`;
  addRow.querySelector('button').onclick = async () => {
    const emails = addRow.querySelector('input').value.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    if (!emails.length) return;
    try {
      const res = await api(`/api/room/${code}/roster`, { method: 'POST', body: JSON.stringify({ add: emails }) });
      toast(`Enrolled ${res.added.length}${res.pendingApproval.length ? `, ${res.pendingApproval.length} awaiting approval` : ''}${res.invalid.length ? `, ${res.invalid.length} invalid` : ''}`);
      renderRoomRoster(panel, code);
    } catch (e) { toast(e.message, true); }
  };
  panel.appendChild(addRow);

  if (!d.roster.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Nobody enrolled yet.';
    panel.appendChild(p);
    return;
  }
  for (const s of d.roster) {
    const row = document.createElement('div');
    row.className = 'roster-row';
    row.innerHTML = `<span class="roster-who"><span class="roster-name"></span><span class="roster-email"></span></span><span></span>`;
    row.querySelector('.roster-name').textContent = s.name;
    row.querySelector('.roster-email').textContent = s.email + (s.status === 'pending' ? ' · awaiting approval' : '');
    const del = document.createElement('button');
    del.className = 'btn-block';
    del.textContent = 'Remove';
    del.onclick = async () => {
      if (!confirm(`Remove ${s.name} from ${code}? Their board in this room will be deleted.`)) return;
      try {
        await api(`/api/room/${code}/roster`, { method: 'POST', body: JSON.stringify({ remove: [s.email] }) });
        toast(`Removed ${s.name}`);
        renderRoomRoster(panel, code);
      } catch (e) { toast(e.message, true); }
    };
    row.lastElementChild.appendChild(del);
    panel.appendChild(row);
  }
}

async function toggleRoomBoards(card, code) {
  const panel = card.querySelector('.room-boards');
  if (!panel.hidden) { panel.hidden = true; return; }
  try {
    const { boards } = await api(`/api/admin/room/${code}`);
    panel.innerHTML = '';
    if (!boards.length) panel.innerHTML = '<p class="hint">No boards saved in this room yet.</p>';
    for (const b of boards) {
      const item = document.createElement('div');
      item.className = 'board-item';
      const img = b.thumb ? `<img src="${b.thumb}" alt="" />` : '<div class="tile-empty">No preview</div>';
      item.innerHTML = `${img}<div class="board-item-foot"><span class="board-item-name"></span><span><button class="btn-view">View</button><button class="btn-block">Delete</button></span></div>`;
      item.querySelector('.board-item-name').textContent = `${b.isTeacher ? '👩‍🏫 ' : ''}${b.ownerName} — ${b.title}`;
      item.querySelector('.btn-view').onclick = async () => {
        try {
          const full = await api(`/api/boards/${b.id}`);
          openViewer(`${code} — ${b.ownerName} — ${b.title}`, full.json);
        } catch (err) { toast(err.message, true); }
      };
      item.querySelector('.btn-block').onclick = async () => {
        if (!confirm(`Delete "${b.title}" (${b.ownerName}) in ${code}?`)) return;
        try {
          await api(`/api/boards/${b.id}`, { method: 'DELETE' });
          toast('Board deleted');
          panel.hidden = true;
          toggleRoomBoards(card, code);
          refresh();
        } catch (err) { toast(err.message, true); }
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
    document.getElementById('admin-me').textContent = `${state.me.name || state.me.email} · ${roleLabel(state.me.role)}`;
    applyNavVisibility();
    renderAddUserRoles();
    renderUsers();
    renderRoles();
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
  // keep users/sessions fresh without stomping on open board panels or role edits
  api('/api/admin/state').then((s) => {
    state = s;
    renderUsers();
    renderSessions();
  }).catch(() => {});
}, 15000);
