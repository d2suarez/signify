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
  toastEl.style.borderColor = isError ? '#FF6B35' : '#0A7C6E';
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
  if (section === 'usage') loadUsage();
  if (section === 'audit') loadAudit();
}

function applyNavVisibility() {
  const visible = {
    users: can('manage_users'),
    roles: state.me.isSuper,
    domains: can('manage_domains'),
    sessions: can('view_sessions'),
    boards: can('manage_boards'),
    templates: can('manage_boards'),
    usage: can('view_sessions'),
    audit: can('manage_users') || can('manage_boards'),
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

// ----- templates, usage, audit -----

document.getElementById('tmpl-school-open').addEventListener('change', async (e) => {
  try {
    await api('/api/admin/school-submit', { method: 'POST', body: JSON.stringify({ domain: state.myDomain, open: e.target.checked }) });
    toast(e.target.checked ? 'Teachers can now publish without approval' : 'School submissions now require approval');
  } catch (err) { toast(err.message, true); e.target.checked = !e.target.checked; }
});

function renderTemplatesAdmin() {
  if (!can('manage_boards')) return;
  document.getElementById('tmpl-school-card').style.display = state.me.isSuper ? 'none' : '';
  document.getElementById('tmpl-school-open').checked = !!state.templateOpen;
  const pending = state.templatesPending || [];
  const badge = document.getElementById('tmpl-pending-badge');
  badge.hidden = !pending.length;
  badge.textContent = pending.length;
  const list = document.getElementById('tmpl-pending-list');
  list.innerHTML = '';
  if (!pending.length) { list.innerHTML = '<p class="hint">Nothing awaiting approval.</p>'; return; }
  for (const t of pending) {
    const row = document.createElement('div');
    row.className = 'roster-row';
    row.innerHTML = '<span class="roster-who"><span class="roster-name"></span><span class="roster-email"></span></span><span class="tmpl-actions"></span>';
    row.querySelector('.roster-name').textContent = `${t.title} · ${t.subject}`;
    row.querySelector('.roster-email').textContent = `${t.scope} · by ${t.ownerName || t.owner}`;
    const acts = row.querySelector('.tmpl-actions');
    const view = document.createElement('button');
    view.className = 'btn-view'; view.textContent = 'Preview';
    view.onclick = async () => { try { const f = await api(`/api/templates/${t.id}`); openViewer(`${t.title} (${t.subject})`, f.json); } catch (e) { toast(e.message, true); } };
    const ap = document.createElement('button');
    ap.className = 'btn-approve'; ap.textContent = '✓ Approve';
    ap.onclick = async () => { try { await api(`/api/templates/${t.id}/approve`, { method: 'POST' }); toast('Approved'); refresh(); } catch (e) { toast(e.message, true); } };
    const rej = document.createElement('button');
    rej.className = 'btn-block'; rej.textContent = 'Reject';
    rej.onclick = async () => { if (!confirm(`Reject and delete "${t.title}"?`)) return; try { await api(`/api/templates/${t.id}`, { method: 'DELETE' }); toast('Rejected'); refresh(); } catch (e) { toast(e.message, true); } };
    acts.append(view, ap, rej);
    list.appendChild(row);
  }
}

async function loadUsage() {
  if (!can('view_sessions')) return;
  try {
    const u = await api('/api/admin/usage');
    const cards = [
      ['Classrooms', u.rooms], ['Users', u.users], ['Active this week', u.activeWeek],
      ['Boards', u.boards], ['Boards edited (7d)', u.boardsWeek], ['Templates visible', u.templates],
      ['Online now', u.online], ['Live classes', u.liveRooms],
    ];
    const grid = document.getElementById('usage-grid');
    grid.innerHTML = '';
    for (const [label, n] of cards) {
      const c = document.createElement('div');
      c.className = 'usage-card';
      c.innerHTML = '<div class="usage-n"></div><div class="usage-l"></div>';
      c.querySelector('.usage-n').textContent = n;
      c.querySelector('.usage-l').textContent = label;
      grid.appendChild(c);
    }
  } catch (e) { toast(e.message, true); }
}

async function loadAudit() {
  try {
    const d = await api('/api/admin/audit');
    const tb = document.querySelector('#audit-table tbody');
    tb.innerHTML = '';
    if (!d.audit.length) { tb.innerHTML = '<tr><td colspan="4" class="hint">No recorded actions yet.</td></tr>'; return; }
    for (const a of d.audit) {
      const tr = document.createElement('tr');
      [new Date(a.ts).toLocaleString(), a.actor, a.action, a.detail].forEach((v) => {
        const td = document.createElement('td'); td.textContent = v; tr.appendChild(td);
      });
      tb.appendChild(tr);
    }
  } catch (e) { toast(e.message, true); }
}

document.getElementById('backup-btn').addEventListener('click', async () => {
  toast('Preparing backup…');
  try {
    const res = await fetch('/api/admin/backup', { headers: { Authorization: 'Bearer ' + session.token } });
    if (!res.ok) throw new Error('Backup failed.');
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `signify-backup-${new Date().toISOString().slice(0, 10)}.tar.gz`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Backup downloaded — keep a copy somewhere safe');
  } catch (e) {
    toast(e.message, true);
  }
});

// ---------- rendering ----------

function fmtTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString();
}

// ----- grade levels & bulk selection -----

const selectedUsers = new Set();

function updateSelCount() {
  document.getElementById('sel-count').textContent = `${selectedUsers.size} selected`;
}

function visibleUserEmails() {
  return [...document.querySelectorAll('#users-table .user-sel')].map((c) => c.value);
}

document.getElementById('sel-all').addEventListener('change', (e) => {
  const emails = visibleUserEmails();
  if (e.target.checked) emails.forEach((x) => selectedUsers.add(x));
  else emails.forEach((x) => selectedUsers.delete(x));
  document.querySelectorAll('#users-table .user-sel').forEach((c) => { c.checked = e.target.checked; });
  updateSelCount();
});

document.getElementById('user-sort').addEventListener('change', () => renderUsers());
document.getElementById('school-filter').addEventListener('change', () => renderUsers());

document.getElementById('bulk-grade-btn').addEventListener('click', async () => {
  if (!selectedUsers.size) { toast('Select some students first.', true); return; }
  const grade = document.getElementById('bulk-grade-select').value;
  try {
    const d = await api('/api/admin/users/grade', { method: 'POST', body: JSON.stringify({ emails: [...selectedUsers], grade }) });
    toast(`Grade set for ${d.updated} student${d.updated === 1 ? '' : 's'}${d.skipped ? `, ${d.skipped} skipped` : ''}`);
    selectedUsers.clear();
    document.getElementById('sel-all').checked = false;
    refresh();
  } catch (e) { toast(e.message, true); }
});

document.getElementById('promote-btn').addEventListener('click', async () => {
  const only = selectedUsers.size ? [...selectedUsers] : null;
  const who = only ? `${only.length} selected student${only.length === 1 ? '' : 's'}` : 'every student you manage';
  if (!confirm(`Move ${who} up one grade level?\n\nStudents in grade 12 become "Graduated". This cannot be undone in bulk.`)) return;
  try {
    const d = await api('/api/admin/users/promote', { method: 'POST', body: JSON.stringify(only ? { emails: only } : {}) });
    const bits = [`${d.promoted} advanced`];
    if (d.graduated) bits.push(`${d.graduated} graduated`);
    if (d.noGrade) bits.push(`${d.noGrade} had no grade set`);
    toast(bits.join(' · '));
    selectedUsers.clear();
    document.getElementById('sel-all').checked = false;
    refresh();
  } catch (e) { toast(e.message, true); }
});

function renderGradeOptions() {
  const sel = document.getElementById('bulk-grade-select');
  if (sel.options.length) return;
  sel.appendChild(new Option('Clear grade', ''));
  (state.grades || []).forEach((g) => sel.appendChild(new Option('Grade ' + g, g)));
  sel.value = state.grades && state.grades.includes('K') ? 'K' : '';
}

function renderUsers() {
  if (!can('manage_users')) return;
  renderGradeOptions();
  updateSelCount();
  const tbody = document.querySelector('#users-table tbody');
  tbody.innerHTML = '';
  const pending = state.users.filter((u) => u.status === 'pending').length;
  const badge = document.getElementById('pending-badge');
  badge.hidden = !pending;
  badge.textContent = pending;

  // Scoped admins may only assign teach-only roles
  const roleOptions = assignableRoles();

  // super admin can group/filter the whole directory by school
  const isSuper = state.me.isSuper;
  document.getElementById('school-col').hidden = !isSuper;
  const schoolFilter = document.getElementById('school-filter');
  schoolFilter.hidden = !isSuper;
  if (isSuper && schoolFilter.options.length !== (state.schools || []).length + 1) {
    const cur = schoolFilter.value;
    schoolFilter.innerHTML = '';
    schoolFilter.appendChild(new Option('All schools', ''));
    (state.schools || []).forEach((s) => schoolFilter.appendChild(new Option('@' + s, s)));
    schoolFilter.value = cur || '';
  }
  const wantSchool = isSuper ? schoolFilter.value : '';
  const sortBy = document.getElementById('user-sort').value;

  const order = { pending: 0, approved: 1, blocked: 2 };
  const gradeIdx = (g) => { const i = (state.grades || []).indexOf(g); return i < 0 ? 99 : i; };
  let list = state.users.filter((u) => !wantSchool || u.school === wantSchool);
  list = list.sort((a, b) => {
    if (sortBy === 'name') return a.name.localeCompare(b.name);
    if (sortBy === 'grade') return gradeIdx(a.grade) - gradeIdx(b.grade) || a.name.localeCompare(b.name);
    if (sortBy === 'school') return a.school.localeCompare(b.school) || a.name.localeCompare(b.name);
    return (order[a.status] - order[b.status]) || (b.lastSeen || 0) - (a.lastSeen || 0);
  });

  let lastSchool = null;
  for (const u of list) {
    // when sorting by school, head each group with the domain
    if (isSuper && sortBy === 'school' && u.school !== lastSchool) {
      lastSchool = u.school;
      const htr = document.createElement('tr');
      const htd = document.createElement('td');
      htd.colSpan = 8;
      htd.className = 'school-group-head';
      htd.textContent = '@' + u.school;
      htr.appendChild(htd);
      tbody.appendChild(htr);
    }
    const tr = document.createElement('tr');
    if (u.status === 'pending') tr.className = 'row-pending';

    const tdSel = document.createElement('td');
    if (!u.isSuper) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'user-sel';
      cb.value = u.email;
      cb.checked = selectedUsers.has(u.email);
      cb.onchange = () => { if (cb.checked) selectedUsers.add(u.email); else selectedUsers.delete(u.email); updateSelCount(); };
      tdSel.appendChild(cb);
    }
    tr.appendChild(tdSel);

    const tdUser = document.createElement('td');
    tdUser.innerHTML = `<div class="u-name"></div><div class="u-email"></div>`;
    tdUser.querySelector('.u-name').textContent = u.name;
    tdUser.querySelector('.u-email').textContent = u.email + (u.addedBy ? ` · added by ${u.addedBy}` : '');
    tr.appendChild(tdUser);

    if (isSuper) {
      const tdSchool = document.createElement('td');
      tdSchool.textContent = '@' + u.school;
      tdSchool.className = 'u-email';
      tr.appendChild(tdSchool);
    }

    const tdGrade = document.createElement('td');
    if (u.isSuper) tdGrade.textContent = '—';
    else {
      const gsel = document.createElement('select');
      gsel.className = 'grade-select';
      gsel.appendChild(new Option('—', '', !u.grade, !u.grade));
      (state.grades || []).forEach((g) => gsel.appendChild(new Option(g, g, false, u.grade === g)));
      gsel.onchange = () => updateUser(u.email, { grade: gsel.value });
      tdGrade.appendChild(gsel);
    }
    tr.appendChild(tdGrade);

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
    const badge = document.createElement('span');
    badge.className = 'status-badge status-' + u.status;
    badge.textContent = u.status;
    tdStatus.appendChild(badge);
    if (u.status === 'suspended') {
      const sub = document.createElement('div');
      sub.className = 'status-sub';
      sub.textContent = u.suspendUntil ? 'until ' + new Date(u.suspendUntil).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'until lifted';
      tdStatus.appendChild(sub);
    }
    tr.appendChild(tdStatus);

    const tdSeen = document.createElement('td');
    tdSeen.textContent = fmtTime(u.lastSeen);
    tr.appendChild(tdSeen);

    const tdActions = document.createElement('td');
    tdActions.className = 'user-actions';
    if (can('manage_boards')) {
      const bb = document.createElement('button');
      bb.className = 'btn-view';
      bb.textContent = 'Boards';
      bb.onclick = () => openUserBoards(u);
      tdActions.appendChild(bb);
    }
    if (!u.isSuper) {
      const addBtn = (cls, text, fn) => {
        const b = document.createElement('button');
        b.className = cls;
        b.textContent = text;
        b.onclick = fn;
        tdActions.appendChild(b);
      };
      if (u.status !== 'approved') {
        addBtn('btn-approve', u.status === 'pending' ? '✓ Approve' : '✓ Reactivate', () => updateUser(u.email, { status: 'approved' }));
      }
      if (u.status !== 'suspended') {
        addBtn('btn-suspend', 'Suspend', () => openSuspendModal(u));
      }
      if (u.status !== 'blocked') {
        addBtn('btn-block', 'Block', () => { if (confirm(`Block ${u.email}? They will be disconnected and unable to sign in until you unblock them.`)) updateUser(u.email, { status: 'blocked' }); });
      }
      addBtn('btn-delete', 'Delete', () => deleteUser(u));
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

// All of one user's boards: classrooms and personal
async function openUserBoards(u) {
  try {
    const d = await api('/api/admin/user-boards/' + encodeURIComponent(u.email));
    document.getElementById('user-boards-title').textContent = `${d.name}'s boards (${d.boards.length})`;
    const grid = document.getElementById('user-boards-grid');
    grid.innerHTML = '';
    if (!d.boards.length) grid.innerHTML = '<p class="hint">This user has no boards yet.</p>';
    for (const b of d.boards) {
      const item = document.createElement('div');
      item.className = 'board-item';
      if (b.thumb) { const im = document.createElement('img'); im.alt = ''; im.src = b.thumb; item.appendChild(im); }
      else { const dd = document.createElement('div'); dd.className = 'tile-empty'; dd.textContent = 'No preview'; item.appendChild(dd); }
      const foot = document.createElement('div');
      foot.className = 'board-item-foot';
      foot.innerHTML = '<span class="board-item-name"></span><button class="btn-view">View</button>';
      foot.querySelector('.board-item-name').textContent = `${b.title} · ${b.roomName || 'Personal'}`;
      foot.querySelector('.btn-view').onclick = async () => {
        try {
          const full = await api(`/api/boards/${b.id}`);
          openViewer(`${d.name} — ${b.title} (${b.roomName || 'personal board'})`, full.json);
        } catch (e) { toast(e.message, true); }
      };
      item.appendChild(foot);
      grid.appendChild(item);
    }
    document.getElementById('user-boards-modal').hidden = false;
  } catch (e) {
    toast(e.message, true);
  }
}

async function deleteUser(u) {
  if (!confirm(`Delete ${u.name} (${u.email})?\n\nThis permanently removes their account, all of their boards, and their class enrollments. This cannot be undone.`)) return;
  try {
    await api('/api/admin/user/' + encodeURIComponent(u.email), { method: 'DELETE' });
    toast(`Deleted ${u.email}`);
    refresh();
  } catch (e) {
    toast(e.message, true);
  }
}

// ----- suspend modal (temporary hold, optional auto-lift) -----

const SUSPEND_DURATIONS = [
  ['1 hour', 3600e3],
  ['1 day', 86400e3],
  ['3 days', 3 * 86400e3],
  ['1 week', 7 * 86400e3],
  ['Until I lift it', 0],
];
let suspendTarget = null;
let suspendChoice = 86400e3;

function openSuspendModal(u) {
  suspendTarget = u;
  suspendChoice = 86400e3;
  document.getElementById('suspend-who').textContent = `${u.name} (${u.email})`;
  const opts = document.getElementById('suspend-durations');
  opts.innerHTML = '';
  for (const [label, ms] of SUSPEND_DURATIONS) {
    const b = document.createElement('button');
    b.className = 'chart-type' + (ms === suspendChoice ? ' active' : '');
    b.textContent = label;
    b.onclick = () => {
      suspendChoice = ms;
      [...opts.children].forEach((c) => c.classList.remove('active'));
      b.classList.add('active');
    };
    opts.appendChild(b);
  }
  document.getElementById('suspend-modal').hidden = false;
}

document.getElementById('suspend-confirm').addEventListener('click', async () => {
  if (!suspendTarget) return;
  const patch = { status: 'suspended' };
  if (suspendChoice > 0) patch.suspendUntil = Date.now() + suspendChoice;
  document.getElementById('suspend-modal').hidden = true;
  await updateUser(suspendTarget.email, patch);
});
document.getElementById('suspend-cancel').addEventListener('click', () => { document.getElementById('suspend-modal').hidden = true; });

// ---------- school-wide feature switches ----------

const FEATURE_LABELS = {
  draw: 'Drawing', text: 'Text', images: 'Photos', documents: 'Documents',
  charts: 'Charts & graphs', newBoards: 'New boards', download: 'Download',
};

function renderDomainFeatures() {
  const wrap = document.getElementById('domain-features');
  if (!wrap || !can('manage_users')) return;
  wrap.innerHTML = '';
  const domains = Object.keys(state.domainFeatures || {});
  if (!domains.length) {
    wrap.innerHTML = '<p class="hint">No domains yet — approve a domain first.</p>';
    return;
  }
  for (const domain of domains) {
    const row = document.createElement('div');
    row.className = 'f-student-row';
    const nm = document.createElement('div');
    nm.className = 'f-row-name';
    nm.textContent = '@' + domain;
    row.appendChild(nm);
    const chips = document.createElement('div');
    chips.className = 'f-chips';
    for (const f of state.features || []) {
      const b = document.createElement('button');
      b.type = 'button';
      const stateOf = () => {
        const m = state.domainFeatures[domain] || {};
        return m[f] === false ? 'off' : m[f] === true ? 'on' : 'inherit';
      };
      const paint = () => {
        b.className = 'f-chip f-' + stateOf();
        b.textContent = FEATURE_LABELS[f] || f;
      };
      b.onclick = async () => {
        const cur = stateOf();
        const val = cur === 'inherit' ? false : cur === 'off' ? true : null;
        try {
          const d = await api('/api/admin/features', { method: 'POST', body: JSON.stringify({ domain, features: { [f]: val } }) });
          state.domainFeatures[domain] = d.features;
          paint();
        } catch (e) { toast(e.message, true); }
      };
      paint();
      chips.appendChild(b);
    }
    row.appendChild(chips);
    wrap.appendChild(row);
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
    toast(parts.join(', '));
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
  // group classrooms by their teacher
  const groups = new Map();
  for (const r of state.rooms) {
    const key = r.ownerName || r.owner || 'No teacher assigned';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const [teacher, roomsOf] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const head = document.createElement('h3');
    head.className = 'room-group-head';
    head.textContent = `${teacher} · ${roomsOf.length} classroom${roomsOf.length === 1 ? '' : 's'}`;
    wrap.appendChild(head);
    for (const r of roomsOf.sort((a, b) => (a.name || a.code).localeCompare(b.name || b.code))) renderRoomCard(wrap, r);
  }
}

function renderRoomCard(wrap, r) {
  {
    const card = document.createElement('div');
    card.className = 'room-card';
    card.innerHTML = `
      <div class="room-card-head">
        <span class="room-title"></span>
        <span class="badge badge-sm">${r.code}</span>
        <span class="room-meta"></span>
        <span class="room-card-actions">
          <button class="btn-view">Boards</button>
          <button class="btn-view btn-roster">Roster</button>
          <button class="btn-view btn-rename">Rename</button>
          <button class="btn-view btn-owner">Owner</button>
          <button class="btn-view btn-archive">${r.archived ? 'Unarchive' : 'Archive'}</button>
          <button class="btn-block btn-del-room">Delete</button>
        </span>
      </div>
      <div class="room-boards" hidden></div>
      <div class="room-roster-panel" hidden></div>`;
    if (r.archived) card.classList.add('room-archived');
    card.querySelector('.room-title').textContent = (r.archived ? '🗄 ' : '') + (r.name || '(unnamed)');
    card.querySelector('.btn-archive').onclick = async () => {
      try { await api(`/api/room/${r.code}/meta`, { method: 'POST', body: JSON.stringify({ archived: !r.archived }) }); toast(r.archived ? 'Unarchived' : 'Archived'); refresh(); }
      catch (e) { toast(e.message, true); }
    };
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
      // Never interpolate the client-supplied thumb into HTML — set .src as a property
      if (b.thumb) { const im = document.createElement('img'); im.alt = ''; im.src = b.thumb; item.appendChild(im); }
      else { const d = document.createElement('div'); d.className = 'tile-empty'; d.textContent = b.canView === false ? 'Private (other school)' : 'No preview'; item.appendChild(d); }
      const foot = document.createElement('div');
      foot.className = 'board-item-foot';
      foot.innerHTML = '<span class="board-item-name"></span><span><button class="btn-view">View</button><button class="btn-block">Delete</button></span>';
      item.appendChild(foot);
      if (b.canView === false) foot.querySelector('.btn-view').remove(); // content is domain-private
      item.querySelector('.board-item-name').textContent = `${b.isTeacher ? 'Teacher · ' : ''}${b.ownerName} — ${b.title}`;
      const viewBtn = item.querySelector('.btn-view');
      if (viewBtn) viewBtn.onclick = async () => {
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
document.getElementById('user-boards-close').addEventListener('click', () => {
  document.getElementById('user-boards-modal').hidden = true;
});

// ---------- refresh loop ----------

async function refresh(manual) {
  try {
    state = await api('/api/admin/state');
    document.getElementById('admin-me').textContent = `${state.me.name || state.me.email} · ${roleLabel(state.me.role)}`;
    document.getElementById('backup-btn').hidden = !state.me.isSuper;
    applyNavVisibility();
    renderAddUserRoles();
    renderDomainFeatures();
    renderUsers();
    renderRoles();
    renderDomains();
    renderSessions();
    renderRooms();
    renderTemplatesAdmin();
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
