/* ===================================================================
   Signify ID — admin console
   One page, one fetch helper, one render function per view. Kept in plain
   JavaScript so it can be read and changed without a build step.
   =================================================================== */

'use strict';

var state = {
  actor: null,
  catalog: [],
  scopes: [],
  tenants: [],
  tenantId: null,
  page: 'overview',
  policyVersion: '',
  retentionDays: 0,
  yearGroups: [],
  cache: {},
};

// ---------- utilities ----------

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function cookie(name) {
  var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}

function api(path, options) {
  options = options || {};
  var headers = { 'content-type': 'application/json' };
  if (options.method && options.method !== 'GET') headers['x-csrf-token'] = cookie('csrf');
  return fetch('/api/admin' + path, {
    method: options.method || 'GET',
    headers: headers,
    credentials: 'same-origin',
    body: options.body ? JSON.stringify(options.body) : undefined,
  }).then(function (res) {
    if (res.status === 401) { window.location.href = '/signin'; throw new Error('Signed out'); }
    return res.json().catch(function () { return {}; }).then(function (data) {
      // Sensitive operations want a recent sign-in. Send the person through
      // Google and bring them back where they were.
      if (res.status === 403 && data.code === 'reauth_required') {
        window.location.href = '/signin?reauth=1&continue=' +
          encodeURIComponent('/admin');
        throw new Error(data.error);
      }
      if (!res.ok) { const e = new Error(data.error || 'That did not work.'); e.data = data; throw e; }
      return data;
    });
  });
}

var toastTimer = null;
function toast(message, isError) {
  var el = document.createElement('div');
  el.className = 'toast' + (isError ? ' err' : '');
  el.textContent = message;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.remove(); }, 3800);
}

function when(ts) {
  if (!ts) return '—';
  var d = new Date(ts);
  var days = (Date.now() - d.getTime()) / 86400000;
  if (days < 1) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

function statusChip(status) {
  var map = {
    active: 'chip-green', pending: 'chip-yellow',
    suspended: 'chip-yellow', blocked: 'chip-red', disabled: 'chip-grey',
  };
  var labels = { active: 'Active', pending: 'Awaiting approval', suspended: 'Suspended', blocked: 'Blocked' };
  return '<span class="chip ' + (map[status] || 'chip-grey') + '">' + esc(labels[status] || status || 'none') + '</span>';
}

function can(permission, scope) {
  if (!state.actor) return false;
  if (state.actor.isSuper) return true;
  var rank = { own: 1, class: 2, tenant: 3, global: 4 };
  var have = state.actor.perms[permission];
  return !!have && rank[have] >= rank[scope || 'tenant'];
}

// ---------- modal ----------

function modal(opts) {
  var root = document.getElementById('modalRoot');
  root.innerHTML =
    '<div class="modal-back"><div class="modal" role="dialog" aria-modal="true">' +
      '<div class="modal-head"><h2>' + esc(opts.title) + '</h2>' +
        (opts.subtitle ? '<p class="muted small" style="margin:.25rem 0 0">' + esc(opts.subtitle) + '</p>' : '') +
      '</div>' +
      '<div class="modal-body">' + opts.body + '</div>' +
      '<div class="modal-foot">' +
        '<button class="btn" data-close>Cancel</button>' +
        '<button class="btn ' + (opts.danger ? 'btn-danger' : 'btn-primary') + '" data-confirm>' + esc(opts.confirm || 'Save') + '</button>' +
      '</div>' +
    '</div></div>';

  function close() { root.innerHTML = ''; }
  root.querySelector('[data-close]').onclick = close;
  root.querySelector('.modal-back').onclick = function (e) { if (e.target === this) close(); };
  root.querySelector('[data-confirm]').onclick = function () {
    var btn = this;
    btn.disabled = true;
    Promise.resolve(opts.onConfirm(root.querySelector('.modal'), close))
      .then(function (keep) { if (!keep) close(); })
      .catch(function (e) { toast(e.message, true); })
      .finally(function () { btn.disabled = false; });
  };
  if (opts.onOpen) opts.onOpen(root.querySelector('.modal'));
  var first = root.querySelector('input, select, textarea');
  if (first) first.focus();
  return { close: close, root: root.querySelector('.modal') };
}

function closeModal() { document.getElementById('modalRoot').innerHTML = ''; }

// ---------- shell ----------

function setPage(page) {
  state.page = page;
  Array.prototype.forEach.call(document.querySelectorAll('#nav button'), function (b) {
    b.classList.toggle('active', b.dataset.page === page);
  });
  var main = document.getElementById('main');
  main.innerHTML = '<div class="empty">Loading…</div>';
  var fn = pages[page];
  if (!fn) { main.innerHTML = '<div class="empty">Nothing here.</div>'; return; }
  Promise.resolve(fn()).catch(function (e) {
    main.innerHTML = '<div class="notice notice-danger"><strong>Could not load this page</strong>' + esc(e.message) + '</div>';
  });
}

function head(title, blurb) {
  return '<div class="page-head"><h1>' + esc(title) + '</h1><p>' + esc(blurb) + '</p></div>';
}

// The one group that is not a school (migration 012). Its members cannot see
// each other, hold no admin role and are never in a class.
function independentView() {
  var t = (state.tenants || []).filter(function (x) { return x.id === state.tenantId; })[0];
  return !!t && t.kind === 'independent';
}

function tenantLabel(t) {
  return t.kind === 'independent' ? 'Independent (no school)' : t.name;
}

function tenantQuery() {
  return state.tenantId ? '?tenant_id=' + encodeURIComponent(state.tenantId) : '';
}

// ---------- pages ----------

var pages = {};

// Someone with no administrative reach sees their own account and nothing of
// anybody else's.
function personalOverview(me) {
  var apps = (me.apps || []).map(function (a) {
    return '<tr><td>' + esc(a.name) + '</td><td style="text-align:right">' +
      '<a class="btn btn-sm" href="' + esc(a.url) + '">Open</a></td></tr>';
  }).join('') || '<tr><td class="muted">No apps are switched on for you yet.</td></tr>';
  document.getElementById('main').innerHTML =
    head('Your account', 'You are signed in to Signify ID. It is what lets you into the Signify apps.') +
    '<div class="card" style="margin-bottom:1rem"><div class="card-body">' +
      '<div style="font-weight:600">' + esc(me.name) + '</div>' +
      '<div class="muted small">' + esc(me.email) + '</div>' +
      '<div class="small" style="margin-top:.5rem">' + esc(me.roleLabel || 'No role') +
        (me.tenantName ? ' · ' + esc(me.tenantName) : '') + '</div>' +
    '</div></div>' +
    '<div class="card"><div class="card-head"><h2>Your apps</h2></div>' +
    '<div class="table-wrap"><table><tbody>' + apps + '</tbody></table></div></div>';
}

pages.overview = function () {
  return api('/overview' + tenantQuery()).then(function (d) {
    if (!d.school && !d.audit) { personalOverview(d.me); return; }
    var alerts = d.alerts.map(function (a) {
      return '<div class="notice notice-' + (a.level === 'danger' ? 'danger' : a.level === 'info' ? 'info' : 'warn') + '">' +
        '<strong>' + (a.level === 'info' ? 'For your information' : 'Needs attention') + '</strong>' + esc(a.text) +
        (a.go ? ' <a href="#" data-go="' + esc(a.go) + '">Open</a>' : '') + '</div>';
    }).join('');

    var stats = (d.counts ? [
      ['Active people', d.counts.active],
      ['Students', d.counts.students],
      ['Staff', d.counts.staff],
      ['Awaiting approval', d.counts.pending],
      ['Restricted', d.counts.restricted],
      ['Classes', d.classes],
    ] : []).map(function (s) {
      return '<div class="card stat"><div class="n">' + esc(s[1]) + '</div><div class="k">' + esc(s[0]) + '</div></div>';
    }).join('');

    var rows = d.recent.map(function (e) {
      return '<tr><td class="muted">' + esc(when(e.ts)) + '</td>' +
        '<td>' + esc(e.actor_email || 'system') + '</td>' +
        '<td><span class="code">' + esc(e.action) + '</span></td></tr>';
    }).join('') || '<tr><td colspan="3" class="muted">Nothing yet.</td></tr>';

    var sensitive = '';
    if (d.sensitive && d.sensitive.length) {
      var LABELS = {
        'backup.downloaded': 'Backup downloaded',
        'backup.snapshot_downloaded': 'Restore snapshot downloaded',
        'backup.rate_limited': 'Backup refused \u2014 daily limit reached',
        'restore.applied': 'Backup restored',
        'restore.rejected': 'Restore refused',
        'roster.imported': 'Roster imported',
        'roster.import_undone': 'Roster import undone',
        'record.exported': 'A record was exported',
        'record.erase_requested': 'A record was erased',
        'record.purged': 'A record was permanently purged',
        'platform_admin.granted': 'Super admin granted',
        'platform_admin.revoked': 'Super admin removed',
        'user.bulk_block': 'Accounts blocked in bulk'
      };
      sensitive =
        '<div class="card" style="margin-bottom:1rem">' +
        '<div class="card-head"><h2>Records that moved</h2>' +
        '<div class="spacer"></div><span class="small muted">last 7 days</span></div>' +
        '<div class="table-wrap"><table><tbody>' +
        d.sensitive.map(function (e) {
          return '<tr><td class="muted small" style="white-space:nowrap;width:9rem">' + esc(when(e.ts)) + '</td>' +
            '<td>' + esc(LABELS[e.action] || e.action) + '</td>' +
            '<td class="muted small">' + esc(e.actor_email || 'system') + '</td></tr>';
        }).join('') +
        '</tbody></table></div></div>';
    }

    document.getElementById('main').innerHTML =
      head('Overview', 'Who has access to your school’s apps, and what changed recently.') +
      alerts + sensitive +
      (stats ? '<div class="grid-2" style="margin-bottom:1rem">' + stats + '</div>' : '') +
      (d.audit
        ? '<div class="card"><div class="card-head"><h2>Recent activity</h2><div class="spacer"></div>' +
          '<button class="btn btn-sm" data-go="audit">Full log</button></div>' +
          '<div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th></tr></thead>' +
          '<tbody>' + rows + '</tbody></table></div></div>'
        : '');

    bindGo();
  });
};

function bindGo() {
  Array.prototype.forEach.call(document.querySelectorAll('[data-go]'), function (el) {
    el.onclick = function (e) { e.preventDefault(); setPage(el.dataset.go); };
  });
}

function usersUrl() {
  var q = (state.cache.userQuery || '');
  var filter = (state.cache.userFilter || '');
  return '/users' + tenantQuery() + (state.tenantId ? '&' : '?') +
    'q=' + encodeURIComponent(q) + (filter ? '&status=' + encodeURIComponent(filter) : '');
}

function userRows(users, canManage) {
  return users.map(function (u) {
    var flags = '';
    if (u.is_super) flags += ' <span class="chip chip-red">Super admin</span>';
    else if (u.is_admin) flags += ' <span class="chip chip-blue">Admin</span>';
    if (Number(u.identity_count) === 0) flags += ' <span class="chip chip-grey" title="Created in advance; has not signed in yet">Not signed in</span>';
    if (u.is_minor) flags += ' <span class="chip chip-yellow" title="Treated as a minor: shorter sessions and stricter data handling">Minor</span>';
    if (u.outside_domain) flags += ' <span class="chip chip-grey" title="Signs in with an address that is not on one of ' +
      esc(u.tenant_name) + '’s domains. They are still a member of ' + esc(u.tenant_name) + '.">Outside address</span>';

    return '<tr data-id="' + esc(u.id) + '">' +
      (canManage ? '<td><input type="checkbox" class="pick" value="' + esc(u.id) + '"></td>' : '') +
      '<td><div style="font-weight:550">' + esc(u.display_name) + flags + '</div>' +
      '<div class="small muted">' + esc(u.email) + '</div></td>' +
      '<td>' + esc(u.role_label || '—') + '</td>' +
      '<td>' + esc(u.grade_level || '—') + '</td>' +
      '<td class="muted">' + esc(u.graduation_year || '—') + '</td>' +
      '<td>' + statusChip(u.status) + '</td>' +
      '<td class="muted small">' + esc(when(u.last_seen_at)) + '</td>' +
      '<td style="text-align:right;white-space:nowrap">' +
        '<button class="btn btn-sm btn-quiet" data-act="record">Record</button>' +
        (canManage && !u.is_super ? ' <button class="btn btn-sm" data-act="edit">Manage</button>' : '') +
      '</td></tr>';
  }).join('') || '<tr><td colspan="8" class="empty">Nobody matches that.</td></tr>';
}

pages.users = function () {
  var q = (state.cache.userQuery || '');
  var filter = (state.cache.userFilter || '');

  return Promise.all([api(usersUrl()), api('/roles' + tenantQuery())]).then(function (r) {
    var users = r[0].users;
    var roles = r[1].roles;
    state.cache.roles = roles;
    state.cache.users = users;

    var canManage = can('core:manage_users', 'tenant');
    var indep = independentView();

    document.getElementById('main').innerHTML =
      (indep
        ? head('People with no school', 'Accounts for people who are not at any school. Each one is added by a super admin, and none of them can see the others.')
        : head('People', 'Everyone who can sign in to your school’s apps. Approving an account is what lets it through the door.')) +
      '<div class="notice notice-info"><strong>Accounts are for people aged 13 and over</strong>' +
      'That is what the privacy policy says, and it is what keeps children’s privacy law out of ' +
      'scope. Do not create accounts for younger students.</div>' +
      '<div class="toolbar">' +
        '<input type="search" id="q" placeholder="Search name or email" value="' + esc(q) + '">' +
        '<select id="filter" style="width:auto">' +
          ['', 'pending', 'active', 'suspended', 'blocked'].map(function (v) {
            var label = v === '' ? 'All statuses' : v.charAt(0).toUpperCase() + v.slice(1);
            return '<option value="' + v + '"' + (v === filter ? ' selected' : '') + '>' + label + '</option>';
          }).join('') +
        '</select>' +
        (canManage ? '<div class="spacer" style="flex:1"></div>' +
          '<button class="btn btn-sm" id="bulkApprove" disabled>Approve selected</button>' +
          '<button class="btn btn-sm btn-danger" id="bulkBlock" disabled>Block selected</button>' +
          (can('core:import_roster', 'tenant') && !indep
            ? '<button class="btn btn-sm" id="importRoster">Import CSV</button>' : '') +
          '<button class="btn btn-primary btn-sm" id="addUser">Add person</button>' : '') +
      '</div>' +
      '<div class="card"><div class="table-wrap"><table><thead><tr>' +
        (canManage ? '<th style="width:2rem"><input type="checkbox" id="pickAll"></th>' : '') +
        '<th>Person</th><th>Role</th><th>Year</th><th>Graduates</th><th>Status</th><th>Last seen</th><th></th>' +
      '</tr></thead><tbody id="userRows">' + userRows(users, canManage) + '</tbody></table></div></div>';

    var picks = function () {
      return Array.prototype.slice.call(document.querySelectorAll('.pick:checked')).map(function (c) { return c.value; });
    };
    var sync = function () {
      if (!canManage) return;
      var n = picks().length;
      document.getElementById('bulkApprove').disabled = !n;
      document.getElementById('bulkBlock').disabled = !n;
    };

    var bindRows = function () {
      Array.prototype.forEach.call(document.querySelectorAll('.pick'), function (c) { c.onchange = sync; });
      Array.prototype.forEach.call(document.querySelectorAll('tr[data-id]'), function (tr) {
        var u = users.filter(function (x) { return x.id === tr.dataset.id; })[0];
        Array.prototype.forEach.call(tr.querySelectorAll('[data-act]'), function (b) {
          b.onclick = function () {
            if (b.dataset.act === 'edit') editUserDialog(u, roles);
            else recordDialog(u);
          };
        });
      });
    };

    // Searching swaps only the table rows, so the box keeps focus and the
    // page doesn't flash "Loading…" on every letter. A slow answer to an
    // earlier term is dropped rather than overwriting a newer one.
    var seq = 0;
    var tbody = document.getElementById('userRows');
    var refresh = function () {
      var mine = ++seq;
      tbody.style.opacity = '.55';
      api(usersUrl()).then(function (d) {
        if (mine !== seq || !document.body.contains(tbody)) return;
        users = d.users;
        state.cache.users = users;
        tbody.innerHTML = userRows(users, canManage);
        tbody.style.opacity = '';
        var all = document.getElementById('pickAll');
        if (all) all.checked = false;
        bindRows();
        sync();
      }).catch(function (e) {
        if (mine !== seq) return;
        tbody.style.opacity = '';
        toast(e.message, true);
      });
    };

    var qEl = document.getElementById('q');
    var t = null;
    qEl.oninput = function () {
      clearTimeout(t);
      t = setTimeout(function () {
        if (qEl.value === (state.cache.userQuery || '')) return;
        state.cache.userQuery = qEl.value;
        refresh();
      }, 200);
    };
    document.getElementById('filter').onchange = function () {
      state.cache.userFilter = this.value; refresh();
    };

    if (canManage) {
      document.getElementById('pickAll').onchange = function () {
        var v = this.checked;
        Array.prototype.forEach.call(document.querySelectorAll('.pick'), function (c) { c.checked = v; });
        sync();
      };
      document.getElementById('bulkApprove').onclick = function () { bulk('approve', picks()); };
      document.getElementById('bulkBlock').onclick = function () { bulk('block', picks()); };
      document.getElementById('addUser').onclick = addUserDialog;
      const importBtn = document.getElementById('importRoster');
      if (importBtn) importBtn.onclick = importDialog;
    }

    bindRows();
  });
};

function bulk(action, ids) {
  if (!ids.length) return;
  api('/users/bulk', { method: 'POST', body: { action: action, ids: ids } })
    .then(function (d) {
      toast(d.changed + ' account' + (d.changed === 1 ? '' : 's') + ' updated' +
        (d.skipped.length ? ', ' + d.skipped.length + ' skipped' : '') + '.');
      setPage('users');
    })
    .catch(function (e) { toast(e.message, true); });
}

function roleOptions(roles, selected) {
  return roles.map(function (r) {
    return '<option value="' + esc(r.id) + '"' + (r.id === selected ? ' selected' : '') + '>' +
      esc(r.label) + (r.tenant_id ? ' (custom)' : '') + '</option>';
  }).join('');
}

// ---------- a person's classes, all in one place ----------
// A tick per class, with their place in it. Used when adding someone and when
// managing them, so a new student can be put in every class at once rather
// than being added roster by roster.

var CLASS_ROLE_LABELS = { student: 'Student', teacher: 'Teacher', aide: 'Aide', observer: 'Observer' };

function classPickerHtml() {
  return '<div class="field" id="m_classes_wrap"><label>Classes</label>' +
    '<input type="search" id="m_class_q" placeholder="Filter classes" style="margin-bottom:.4rem">' +
    '<div id="m_classes" class="class-picker"><div class="small muted">Loading classes…</div></div>' +
    '<div class="hint" id="m_classes_hint"></div></div>';
}

// Fills the picker. `classes` carry id, name, subject, teachers, role (their
// current place, or null) and editable.
function fillClassPicker(m, classes, defaultRole) {
  var box = m.querySelector('#m_classes');
  if (!classes.length) {
    box.innerHTML = '<div class="small muted">This school has no classes yet. Make them on the Classes page.</div>';
    return;
  }
  box.innerHTML = classes.map(function (c) {
    var on = !!c.role;
    var role = c.role || defaultRole;
    var label = esc(c.name) + (c.subject ? ' <span class="muted small">· ' + esc(c.subject) + '</span>' : '') +
      (c.teachers ? '<div class="small muted">' + esc(c.teachers) + '</div>' : '');
    return '<div class="class-pick" data-name="' + esc((c.name + ' ' + (c.subject || '') + ' ' + (c.teachers || '')).toLowerCase()) + '">' +
      '<label style="display:flex;gap:.5rem;align-items:flex-start;flex:1;margin:0;font-weight:400">' +
        '<input type="checkbox" data-class="' + esc(c.id) + '"' + (on ? ' checked' : '') + (c.editable === false ? ' disabled' : '') + '>' +
        '<span>' + label + '</span></label>' +
      '<select data-class-role="' + esc(c.id) + '" style="width:auto"' + (on ? '' : ' hidden') + (c.editable === false ? ' disabled' : '') + '>' +
        Object.keys(CLASS_ROLE_LABELS).map(function (k) {
          return '<option value="' + k + '"' + (k === role ? ' selected' : '') + '>' + CLASS_ROLE_LABELS[k] + '</option>';
        }).join('') +
      '</select></div>';
  }).join('');
  var locked = classes.filter(function (c) { return c.editable === false; }).length;
  m.querySelector('#m_classes_hint').textContent = locked
    ? 'Greyed-out classes are not yours to change.' : '';

  Array.prototype.forEach.call(box.querySelectorAll('[data-class]'), function (cb) {
    cb.onchange = function () {
      box.querySelector('[data-class-role="' + cb.dataset.class + '"]').hidden = !cb.checked;
    };
  });
  var q = m.querySelector('#m_class_q');
  q.oninput = function () {
    var v = q.value.trim().toLowerCase();
    Array.prototype.forEach.call(box.querySelectorAll('.class-pick'), function (row) {
      row.hidden = !!v && row.dataset.name.indexOf(v) === -1;
    });
  };
}

function pickedClasses(m) {
  return Array.prototype.filter.call(m.querySelectorAll('#m_classes [data-class]'), function (cb) {
    return cb.checked && !cb.disabled;
  }).map(function (cb) {
    return { id: cb.dataset.class, role: m.querySelector('[data-class-role="' + cb.dataset.class + '"]').value };
  });
}

function classRoleFor(roleKey) {
  return roleKey === 'teacher' || roleKey === 'substitute' ? 'teacher' : roleKey === 'staff' ? 'aide' : 'student';
}

function addUserDialog() {
  var roles = state.cache.roles || [];
  var indep = independentView();
  var offered = roles.filter(function (r) {
    if (indep) return !r.is_admin && r.key !== 'substitute';
    return !r.is_admin || state.actor.isSuper;
  });
  var val = function (m, sel) { var el = m.querySelector(sel); return el ? el.value : ''; };
  modal({
    title: indep ? 'Add someone with no school' : 'Add a person',
    subtitle: 'Creates the account now. It links to their real Google identity the first time they sign in.',
    confirm: 'Add',
    body:
      '<div class="field"><label for="m_email">' + (indep ? 'Email address' : 'School email address') + '</label>' +
      '<input id="m_email" type="email" placeholder="' + (indep ? 'name@gmail.com' : 'name@school.edu') + '" autocomplete="off">' +
      '<div class="hint">' + (indep ? 'Any address they sign in to with Google, personal ones included. ' : 'Must be an address they can actually sign in to with Google, ') +
      (indep ? 'They' : 'and') + ' must be aged 13 or over.</div></div>' +
      '<div class="field"><label for="m_name">Name</label><input id="m_name" type="text" placeholder="Optional — Google fills this in"></div>' +
      (indep
        ? '<div class="field"><label for="m_role">Role</label>' +
          '<select id="m_role">' + roleOptions(offered, (offered.filter(function (r) { return r.key === 'teacher'; })[0] || {}).id) + '</select>' +
          '<div class="hint">Decides what they can do inside each app. Whatever the role, they only ever reach their own work.</div></div>'
        : '<div class="row"><div class="field"><label for="m_role">Role</label>' +
          '<select id="m_role">' + roleOptions(offered) + '</select></div>' +
          '<div class="field"><label for="m_grade">Year group</label><input id="m_grade" type="text" placeholder="e.g. 3"></div>' +
          '<div class="field"><label for="m_gradyear">Graduation year</label>' +
          '<input id="m_gradyear" type="number" min="1900" max="2200" placeholder="e.g. 2035">' +
          '<div class="hint">Stays true as they move up. Year group does not.</div></div></div>') +
      (indep ? '<div class="notice notice-info" style="margin:1rem 0 0"><strong>Which apps they get</strong>' +
        'Whatever is turned on for Independent on the Apps page, the same way as for a school.</div>' : '') +
      (!indep && can('core:manage_classes', 'own') ? classPickerHtml() : ''),
    onOpen: function (m) {
      if (indep || !m.querySelector('#m_classes')) return;
      var roleSel = m.querySelector('#m_role');
      var keyOf = function () {
        return (offered.filter(function (r) { return r.id === roleSel.value; })[0] || {}).key;
      };
      api('/classes' + tenantQuery()).then(function (d) {
        fillClassPicker(m, d.classes.map(function (c) {
          return { id: c.id, name: c.name, subject: c.subject, teachers: c.teachers, role: null };
        }), classRoleFor(keyOf()));
        // Picking a role first sets the place they take in the classes ticked after.
        roleSel.addEventListener('change', function () {
          var r = classRoleFor(keyOf());
          Array.prototype.forEach.call(m.querySelectorAll('#m_classes [data-class]'), function (cb) {
            if (!cb.checked) m.querySelector('[data-class-role="' + cb.dataset.class + '"]').value = r;
          });
        });
      }).catch(function (e) { m.querySelector('#m_classes').innerHTML = '<div class="small muted">' + esc(e.message) + '</div>'; });
    },
    onConfirm: function (m) {
      var classes = m.querySelector('#m_classes') ? pickedClasses(m) : [];
      return api('/users', { method: 'POST', body: {
        email: val(m, '#m_email'),
        name: val(m, '#m_name'),
        role_id: val(m, '#m_role'),
        grade_level: val(m, '#m_grade'),
        graduation_year: val(m, '#m_gradyear'),
        tenant_id: state.tenantId,
      } }).then(function (d) {
        if (!classes.length) return 'Account added.';
        return api('/users/' + d.id + '/classes', { method: 'PUT', body: { classes: classes } })
          .then(function () { return 'Account added to ' + classes.length + ' class' + (classes.length === 1 ? '' : 'es') + '.'; })
          .catch(function (e) { return 'Account added, but the classes were not saved: ' + e.message; });
      }).then(function (msg) { toast(msg); setPage('users'); });
    },
  });
}

function editUserDialog(u, roles) {
  var assignable = roles.filter(function (r) { return !r.is_admin || state.actor.isSuper; });
  modal({
    title: 'Manage ' + u.display_name,
    subtitle: u.email,
    confirm: 'Save changes',
    body:
      '<div class="field"><label>School</label><div>' + esc(u.tenant_kind === 'independent' ? 'Independent (no school)' : (u.tenant_name || '—')) +
        (state.actor.isSuper
          ? ' <button class="btn btn-sm btn-quiet" id="m_move" type="button">Move to another school</button>'
          : '<div class="hint">Only a super admin can move someone to another school.</div>') +
        (u.outside_domain ? '<div class="hint">Their address is not on one of this school’s domains, but they are a member here.</div>' : '') +
      '</div></div>' +
      '<div class="row">' +
        '<div class="field"><label for="m_role">Role</label><select id="m_role">' + roleOptions(assignable, u.role_id) + '</select></div>' +
        '<div class="field"><label for="m_status">Status</label><select id="m_status">' +
          ['active', 'pending', 'suspended', 'blocked'].map(function (s) {
            return '<option value="' + s + '"' + (s === u.status ? ' selected' : '') + '>' +
              s.charAt(0).toUpperCase() + s.slice(1) + '</option>';
          }).join('') + '</select></div>' +
      '</div>' +
      '<div class="row"><div class="field"><label for="m_grade">Year group</label>' +
      '<input id="m_grade" type="text" value="' + esc(u.grade_level || '') + '"></div>' +
      '<div class="field"><label for="m_gradyear">Graduation year</label>' +
      '<input id="m_gradyear" type="number" min="1900" max="2200" value="' + esc(u.graduation_year || '') + '"></div></div>' +
      (u.tenant_kind !== 'independent' && can('core:manage_classes', 'own') ? classPickerHtml() : '') +
      '<div class="notice notice-info" style="margin:1rem 0 0"><strong>Blocking ends live sessions</strong>' +
      'Every device this person is signed in on, in every app, stops working immediately.</div>' +
      '<hr style="border:none;border-top:1px solid var(--line);margin:1.25rem 0">' +
      '<div style="display:flex;gap:.5rem;flex-wrap:wrap">' +
        '<button class="btn btn-sm" id="m_revoke">Sign out everywhere</button>' +
        '<button class="btn btn-sm" id="m_release">Release email address</button>' +
        '<button class="btn btn-sm" id="m_merge">Merge another account in</button>' +
        (can('core:delete_student_data', 'tenant') ? '<button class="btn btn-sm btn-danger" id="m_erase">Erase record</button>' : '') +
      '</div>' +
      '<p class="small muted" style="margin:.6rem 0 0">Release the address when a different person inherits it — the old account is archived rather than handed over.</p>',
    onOpen: function (m) {
      if (m.querySelector('#m_classes')) {
        api('/users/' + u.id + '/classes').then(function (d) {
          fillClassPicker(m, d.classes, classRoleFor(u.role_key));
          m.dataset.classesLoaded = '1';
        }).catch(function (e) { m.querySelector('#m_classes').innerHTML = '<div class="small muted">' + esc(e.message) + '</div>'; });
      }
      var move = m.querySelector('#m_move');
      if (move) move.onclick = function () { closeModal(); moveDialog(u, roles); };
      m.querySelector('#m_revoke').onclick = function () {
        api('/users/' + u.id + '/sessions', { method: 'DELETE' })
          .then(function (d) { toast('Signed out of ' + d.revoked + ' session' + (d.revoked === 1 ? '' : 's') + '.'); })
          .catch(function (e) { toast(e.message, true); });
      };
      m.querySelector('#m_release').onclick = function () {
        if (!window.confirm('Release ' + u.email + '? The current account is archived and the address becomes free for a new person.')) return;
        api('/users/' + u.id + '/release-email', { method: 'POST', body: {} })
          .then(function () { toast('Address released.'); closeModal(); setPage('users'); })
          .catch(function (e) { toast(e.message, true); });
      };
      m.querySelector('#m_merge').onclick = function () {
        closeModal();
        mergeDialog(u, state.cache.users || []);
      };
      var erase = m.querySelector('#m_erase');
      if (erase) erase.onclick = function () {
        if (!window.confirm('Erase the record for ' + u.display_name + '?\n\nIt is recoverable for 30 days, then permanently deleted. This is logged as a disclosure event.')) return;
        api('/users/' + u.id, { method: 'DELETE' })
          .then(function (d) { toast('Queued for erasure in ' + d.purge_in_days + ' days.'); closeModal(); setPage('users'); })
          .catch(function (e) { toast(e.message, true); });
      };
    },
    onConfirm: function (m) {
      return api('/users/' + u.id, { method: 'PATCH', body: {
        role_id: m.querySelector('#m_role').value,
        status: m.querySelector('#m_status').value,
        grade_level: m.querySelector('#m_grade').value,
        graduation_year: m.querySelector('#m_gradyear').value,
        tenant_id: state.tenantId,
      } }).then(function () {
        // Only once the list has loaded: saving an empty, unloaded list would
        // take them out of every class.
        if (m.dataset.classesLoaded !== '1') return;
        return api('/users/' + u.id + '/classes', { method: 'PUT', body: { classes: pickedClasses(m) } });
      }).then(function () { toast('Saved.'); setPage('users'); });
    },
  });
}

// Super admins only. Custom roles belong to one school, so only the built-in
// ones are offered; Independent takes no admin or substitute role.
function moveDialog(u, roles) {
  var others = (state.tenants || []).filter(function (t) { return t.id !== u.tenant_id; });
  if (!others.length) { toast('There is nowhere else to move them.', true); return; }
  var builtin = roles.filter(function (r) { return !r.tenant_id; });
  var rolesFor = function (tenantId) {
    var t = others.filter(function (x) { return x.id === tenantId; })[0];
    return builtin.filter(function (r) {
      return !(t && t.kind === 'independent' && (r.is_admin || r.key === 'substitute'));
    });
  };
  var keep = function (list) {
    return (list.filter(function (r) { return r.id === u.role_id; })[0] ||
      list.filter(function (r) { return r.key === 'teacher'; })[0] || list[0] || {}).id;
  };
  modal({
    title: 'Move ' + u.display_name,
    subtitle: 'From ' + (u.tenant_kind === 'independent' ? 'Independent (no school)' : u.tenant_name),
    confirm: 'Move',
    danger: true,
    body:
      '<div class="row"><div class="field"><label for="m_to">To</label><select id="m_to">' +
        others.map(function (t) { return '<option value="' + esc(t.id) + '">' + esc(tenantLabel(t)) + '</option>'; }).join('') +
      '</select></div>' +
      '<div class="field"><label for="m_role">Role there</label><select id="m_role"></select></div></div>' +
      '<div class="notice notice-warn" style="margin:1rem 0 0"><strong>What stays behind</strong>' +
      'Their classes, cover, guardian links and app exceptions at the old school are removed, and they are signed out ' +
      'everywhere so every app sees the new school. Their account, sign-in and history stay as they are.</div>',
    onOpen: function (m) {
      var to = m.querySelector('#m_to');
      var role = m.querySelector('#m_role');
      var fill = function () { var list = rolesFor(to.value); role.innerHTML = roleOptions(list, keep(list)); };
      to.onchange = fill;
      fill();
    },
    onConfirm: function (m) {
      return api('/users/' + u.id + '/move', { method: 'POST', body: {
        from_tenant_id: u.tenant_id,
        to_tenant_id: m.querySelector('#m_to').value,
        role_id: m.querySelector('#m_role').value,
      } }).then(function () { toast('Moved.'); setPage('users'); });
    },
  });
}

function recordDialog(u) {
  modal({
    title: 'Record for ' + u.display_name,
    subtitle: 'Everything Signify ID holds about this person.',
    confirm: 'Download record',
    body:
      '<p class="small">A parent or eligible student may inspect this under FERPA. Downloading it is logged as a disclosure, ' +
      'with the reason you give below.</p>' +
      '<div class="field"><label for="m_purpose">Reason for this request</label>' +
      '<input id="m_purpose" type="text" placeholder="e.g. parent inspection request, 25 August"></div>' +
      '<div class="notice notice-info"><strong>This covers identity only</strong>' +
      'Work produced inside each app — boards, maps, quiz results — is exported from that app separately.</div>',
    onConfirm: function (m) {
      var purpose = encodeURIComponent(m.querySelector('#m_purpose').value || 'administrative request');
      window.open('/api/admin/users/' + u.id + '/export?purpose=' + purpose, '_blank');
      toast('Record downloaded and logged.');
    },
  });
}

var SCOPE_LABELS = { own: 'Own', class: 'Their classes', tenant: 'Whole school', global: 'Everywhere' };

// Turns a role's grants into a readable, grouped list. Used read-only on the
// Roles page so anyone who can see a role can see exactly what it allows —
// including the built-ins, which previously only showed a count.
function permissionList(perms, defaults) {
  if (!perms.length) {
    return '<p class="small muted" style="margin:0">No permissions at all. ' +
      'A student’s access to their own work comes from owning it, not from a permission.</p>';
  }

  var held = {};
  perms.forEach(function (p) { held[p.permission] = p.scope; });

  var wasDefault = {};
  if (defaults) (defaults.permissions || []).forEach(function (p) { wasDefault[p.permission] = p.scope; });

  return state.catalog.map(function (group) {
    var rows = group.permissions.filter(function (p) { return held[p.key]; }).map(function (p) {
      var changed = defaults && wasDefault[p.key] !== held[p.key];
      return '<div class="perm-row">' +
        '<span class="label">' + esc(p.label) +
          (p.admin ? ' <span class="chip chip-red">Admin</span>' : '') +
          (changed ? ' <span class="chip chip-yellow">changed</span>' : '') +
        '</span>' +
        '<span class="chip chip-grey">' + esc(SCOPE_LABELS[held[p.key]] || held[p.key]) + '</span>' +
        '</div>';
    }).join('');
    if (!rows) return '';
    return '<div class="perm-group"><h3>' + esc(group.label) + '</h3>' + rows + '</div>';
  }).join('');
}

// Permissions the default has but this role no longer does.
function removedFromDefault(perms, defaults) {
  if (!defaults) return [];
  var held = {};
  perms.forEach(function (p) { held[p.permission] = true; });
  var labels = {};
  state.catalog.forEach(function (g) {
    g.permissions.forEach(function (p) { labels[p.key] = p.label; });
  });
  return (defaults.permissions || [])
    .filter(function (p) { return !held[p.permission]; })
    .map(function (p) { return labels[p.permission] || p.permission; });
}

pages.roles = function () {
  return api('/roles' + tenantQuery()).then(function (d) {
    state.catalog = d.catalog || state.catalog;
    var canEdit = can('core:manage_roles', 'tenant');
    var isSuper = state.actor.isSuper;

    var cards = d.roles.map(function (r) {
      var removed = removedFromDefault(r.permissions, r.defaults);
      var mayEditThis = canEdit && (!r.builtin || isSuper);

      var divergence = '';
      if (r.builtin && r.customised) {
        divergence =
          '<div class="notice notice-warn" style="margin:0 0 .75rem">' +
          '<strong>Changed from the default</strong>' +
          'This role no longer tracks the built-in definition, so it will not pick up ' +
          'permissions from newly added apps automatically.' +
          (r.customised_by_email ? ' Changed by ' + esc(r.customised_by_email) : '') +
          (r.customised_at ? ' on ' + esc(when(r.customised_at)) + '.' : '.') +
          (removed.length
            ? '<div class="small" style="margin-top:.35rem">Removed from the default: ' +
              esc(removed.join(', ')) + '</div>'
            : '') +
          '</div>';
      }

      return '<div class="card"><div class="card-head">' +
        '<h2>' + esc(r.label) + '</h2>' +
        (r.builtin ? '<span class="chip chip-blue">Built in</span>' : '<span class="chip chip-yellow">Custom</span>') +
        (r.customised ? '<span class="chip chip-yellow">Changed</span>' : '') +
        (r.is_admin ? '<span class="chip chip-red">Administrative</span>' : '') +
        '<div class="spacer"></div>' +
        '<span class="muted small">' + esc(r.in_use) + ' in use</span>' +
        (canEdit ? '<button class="btn btn-sm" data-dup="' + esc(r.id) + '">Duplicate</button>' : '') +
        (mayEditThis ? '<button class="btn btn-sm" data-edit="' + esc(r.id) + '">Edit</button>' : '') +
        (isSuper && r.builtin && r.customised
          ? '<button class="btn btn-sm btn-quiet" data-reset="' + esc(r.id) + '">Reset</button>' : '') +
        (canEdit && !r.builtin ? '<button class="btn btn-sm btn-quiet" data-del="' + esc(r.id) + '">Delete</button>' : '') +
        '</div><div class="card-body tight">' +
        '<p class="muted small" style="margin:0 0 .75rem">' + esc(r.description) + '</p>' +
        divergence +
        permissionList(r.permissions, r.defaults) +
        '</div></div>';
    }).join('');

    document.getElementById('main').innerHTML =
      head('Roles', 'What each kind of account is allowed to do, and how far that reach extends.') +
      (isSuper
        ? '<div class="notice notice-info"><strong>Editing a built-in role</strong>' +
          'As a super admin you can change the built-ins directly. Doing so stops that role tracking ' +
          'the platform default, so it will not gain permissions when a new app is added — you can reset ' +
          'it back at any time.</div>'
        : '') +
      (canEdit ? '<div class="toolbar"><button class="btn btn-primary btn-sm" id="newRole">New role</button></div>' : '') +
      cards;

    if (canEdit) {
      document.getElementById('newRole').onclick = function () { roleDialog(null, d.roles); };
      Array.prototype.forEach.call(document.querySelectorAll('[data-dup]'), function (b) {
        b.onclick = function () {
          var src = d.roles.filter(function (r) { return r.id === b.dataset.dup; })[0];
          roleDialog({ label: src.label + ' (copy)', description: src.description, permissions: src.permissions }, d.roles);
        };
      });
      Array.prototype.forEach.call(document.querySelectorAll('[data-edit]'), function (b) {
        b.onclick = function () {
          roleDialog(d.roles.filter(function (r) { return r.id === b.dataset.edit; })[0], d.roles);
        };
      });
      Array.prototype.forEach.call(document.querySelectorAll('[data-del]'), function (b) {
        b.onclick = function () {
          var r = d.roles.filter(function (x) { return x.id === b.dataset.del; })[0];
          if (!window.confirm('Delete the role "' + r.label + '"?')) return;
          api('/roles/' + r.id, { method: 'DELETE' })
            .then(function () { toast('Role deleted.'); setPage('roles'); })
            .catch(function (e) { toast(e.message, true); });
        };
      });
    }

    Array.prototype.forEach.call(document.querySelectorAll('[data-reset]'), function (b) {
      b.onclick = function () {
        var r = d.roles.filter(function (x) { return x.id === b.dataset.reset; })[0];
        if (!window.confirm('Reset "' + r.label + '" to the platform default?\n\nYour changes to it are discarded, and it starts tracking the default again.')) return;
        api('/roles/' + r.id + '/reset', { method: 'POST', body: {} })
          .then(function () { toast('Reset to the default.'); setPage('roles'); })
          .catch(function (e) { toast(e.message, true); });
      };
    });
  });
};

function roleDialog(role, allRoles) {
  var held = {};
  (role && role.permissions ? role.permissions : []).forEach(function (p) { held[p.permission] = p.scope; });

  var groups = state.catalog.map(function (g) {
    var rows = g.permissions.map(function (p) {
      // Only offer what the current administrator could grant.
      var allowed = state.actor.isSuper || state.actor.perms[p.key];
      var scopeSel = state.scopes.map(function (s) {
        var maxRank = { own: 1, class: 2, tenant: 3, global: 4 };
        var mine = state.actor.isSuper ? 'global' : (state.actor.perms[p.key] || 'own');
        if (maxRank[s] > maxRank[mine]) return '';
        return '<option value="' + s + '"' + (held[p.key] === s ? ' selected' : '') + '>' +
          ({ own: 'Own', class: 'Their classes', tenant: 'Whole school', global: 'Everywhere' })[s] + '</option>';
      }).join('');

      return '<div class="perm-row"' + (allowed ? '' : ' style="opacity:.45"') + '>' +
        '<input type="checkbox" data-perm="' + esc(p.key) + '"' +
          (held[p.key] ? ' checked' : '') + (allowed ? '' : ' disabled') + '>' +
        '<span class="label">' + esc(p.label) +
          (p.admin ? ' <span class="chip chip-red">Admin</span>' : '') + '</span>' +
        '<select data-scope="' + esc(p.key) + '"' + (allowed ? '' : ' disabled') + '>' + scopeSel + '</select>' +
        '</div>';
    }).join('');
    return '<div class="perm-group"><h3>' + esc(g.label) + '</h3>' + rows + '</div>';
  }).join('');

  var editingBuiltin = !!(role && role.id && role.builtin);

  modal({
    title: role && role.id ? 'Edit ' + role.label : 'New role',
    subtitle: editingBuiltin
      ? 'A built-in role. Changing it stops it tracking the platform default.'
      : 'You can only grant what you hold yourself, at no wider a reach.',
    confirm: 'Save role',
    body:
      (editingBuiltin
        ? '<div class="notice notice-warn"><strong>This is a built-in role</strong>' +
          'Every school uses it. After this it will no longer pick up permissions from ' +
          'newly added apps automatically — you can reset it to the default at any time.</div>'
        : '') +
      '<div class="field"><label for="m_label">Name</label>' +
      '<input id="m_label" type="text" value="' + esc(role ? role.label : '') + '" placeholder="e.g. Reading specialist"></div>' +
      '<div class="field"><label for="m_desc">What is it for?</label>' +
      '<input id="m_desc" type="text" value="' + esc(role ? role.description : '') + '"></div>' +
      '<label style="margin-top:1rem">Permissions</label>' + groups,
    onConfirm: function (m) {
      var perms = [];
      Array.prototype.forEach.call(m.querySelectorAll('[data-perm]:checked'), function (c) {
        var key = c.dataset.perm;
        var sel = m.querySelector('[data-scope="' + key + '"]');
        perms.push({ permission: key, scope: sel.value });
      });
      var body = {
        label: m.querySelector('#m_label').value,
        description: m.querySelector('#m_desc').value,
        permissions: perms,
        tenant_id: state.tenantId,
      };
      var call = role && role.id
        ? api('/roles/' + role.id, { method: 'PATCH', body: body })
        : api('/roles', { method: 'POST', body: body });
      return call.then(function () { toast('Role saved.'); setPage('roles'); });
    },
  });
}

// ---------- substitutes ----------
// A substitute keeps one account all year and can sign in only on the days
// they are covering. On those days every app treats them as a teacher of the
// classes they cover. This page arranges and ends that cover.

// "2026-09-30" becomes "Tue 30 Sep", built from its parts so no time zone
// can move it to the day before.
function dayLabel(iso) {
  if (!iso) return '';
  var p = String(iso).split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}
function spanLabel(a, b) { return a === b ? dayLabel(a) : dayLabel(a) + ' – ' + dayLabel(b); }
function classNames(list) { return (list || []).map(function (x) { return x.name; }).join(', '); }

pages.substitutes = function () {
  if (!state.tenantId) {
    document.getElementById('main').innerHTML = head('Substitutes', 'Choose a school first.');
    return Promise.resolve();
  }
  return api('/substitutes?tenant_id=' + encodeURIComponent(state.tenantId)).then(function (d) {
    var subRows = d.substitutes.map(function (s) {
      var status = s.coveringNow.length
        ? '<span class="chip chip-green">Covering today</span>' +
          '<div class="small muted" style="margin-top:.2rem">' + esc(s.coveringNow.map(function (c) { return classNames(c.classes); }).join('; ')) + '</div>'
        : s.next
          ? '<span class="chip chip-blue">Next: ' + esc(dayLabel(s.next.starts_on)) + '</span>'
          : '<span class="chip chip-grey">No cover arranged</span>';
      return '<tr data-sub="' + esc(s.id) + '">' +
        '<td><div style="font-weight:550">' + esc(s.name) + '</div><div class="small muted">' + esc(s.email) + '</div></td>' +
        '<td>' + status + '</td>' +
        '<td style="text-align:right;white-space:nowrap">' +
          '<button class="btn btn-sm" data-today>Cover today</button> ' +
          '<button class="btn btn-sm btn-primary" data-arrange>Arrange cover</button>' +
        '</td></tr>';
    }).join('');

    var covRows = d.coverages.map(function (c) {
      var chip = c.ended_at
        ? '<span class="chip chip-grey">Ended' + (c.ended_by_name ? ' by ' + esc(c.ended_by_name) : '') + '</span>'
        : c.current ? '<span class="chip chip-green">Now</span>'
        : c.upcoming ? '<span class="chip chip-blue">Upcoming</span>'
        : '<span class="chip chip-grey">Finished</span>';
      var action = c.current
        ? '<button class="btn btn-sm btn-danger" data-end="' + esc(c.id) + '" data-kind="end">End now</button>'
        : c.upcoming ? '<button class="btn btn-sm" data-end="' + esc(c.id) + '" data-kind="cancel">Cancel</button>' : '';
      return '<tr>' +
        '<td style="white-space:nowrap">' + esc(spanLabel(c.starts_on, c.ends_on)) + '</td>' +
        '<td>' + esc(c.substitute_name) + (c.covering_for_name ? '<div class="small muted">for ' + esc(c.covering_for_name) + '</div>' : '') + '</td>' +
        '<td class="small">' + esc(classNames(c.classes)) + (c.note ? '<div class="muted">' + esc(c.note) + '</div>' : '') + '</td>' +
        '<td>' + chip + '</td>' +
        '<td style="text-align:right">' + action + '</td></tr>';
    }).join('') || '<tr><td colspan="5" class="empty">No cover arranged.</td></tr>';

    document.getElementById('main').innerHTML =
      head('Substitutes', 'A substitute keeps one account all year but can sign in only on the days they are covering. ' +
        'On those days every app treats them as a teacher of the classes they cover, without grading.') +
      (d.substitutes.length ? '' :
        '<div class="notice notice-info"><strong>No substitutes yet</strong>' +
        'Add one on the People page with the role Substitute teacher. Their account stays closed until you arrange cover.' +
        '<div style="margin-top:.5rem"><button class="btn btn-sm" data-go="users">Open People</button></div></div>') +
      (d.substitutes.length
        ? '<div class="card"><div class="card-head"><h2>Substitutes</h2></div><div class="table-wrap"><table><thead><tr>' +
          '<th>Who</th><th>Today</th><th></th></tr></thead><tbody>' + subRows + '</tbody></table></div></div>'
        : '') +
      '<div class="card"><div class="card-head"><h2>Cover</h2><div class="spacer"></div>' +
        (d.substitutes.length ? '<button class="btn btn-sm btn-primary" id="newCover">Arrange cover</button>' : '') + '</div>' +
      '<div class="table-wrap"><table><thead><tr><th>Days</th><th>Substitute</th><th>Classes</th><th>Status</th><th></th></tr></thead>' +
      '<tbody>' + covRows + '</tbody></table></div>' +
      '<p class="small muted" style="margin:.6rem .9rem">Today at this school is ' + esc(dayLabel(d.today)) + '. ' +
      'Cover runs whole days in the school’s time zone. The last two weeks are shown.</p></div>';

    bindGo();
    var nc = document.getElementById('newCover');
    if (nc) nc.onclick = function () { coverDialog(d, null, false); };
    Array.prototype.forEach.call(document.querySelectorAll('tr[data-sub]'), function (tr) {
      tr.querySelector('[data-arrange]').onclick = function () { coverDialog(d, tr.dataset.sub, false); };
      tr.querySelector('[data-today]').onclick = function () { coverDialog(d, tr.dataset.sub, true); };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-end]'), function (b) {
      b.onclick = function () {
        var cancel = b.dataset.kind === 'cancel';
        if (!window.confirm(cancel
          ? 'Cancel this cover? The substitute will not be able to sign in for it.'
          : 'End this cover now? The substitute loses these classes in every app straight away.')) return;
        api('/coverages/' + encodeURIComponent(b.dataset.end) + '/end', { method: 'POST', body: { tenant_id: state.tenantId } })
          .then(function (r) {
            toast(cancel ? 'Cover cancelled.' : 'Cover ended.' + (r.signedOut ? ' The substitute has been signed out.' : ''));
            setPage('substitutes');
          })
          .catch(function (e) { toast(e.message, true); });
      };
    });
  });
};

function coverDialog(d, subId, todayOnly) {
  var subOptions = d.substitutes.map(function (s) {
    return '<option value="' + esc(s.id) + '"' + (s.id === subId ? ' selected' : '') + '>' + esc(s.name) + '</option>';
  }).join('');
  var teacherOptions = '<option value="">Nobody in particular</option>' + d.teachers.map(function (t) {
    return '<option value="' + esc(t.id) + '">' + esc(t.name) + '</option>';
  }).join('');
  var classRows = d.classes.map(function (c) {
    return '<label class="perm-row" style="cursor:pointer;margin:0"><input type="checkbox" value="' + esc(c.id) + '">' +
      '<span class="label">' + esc(c.name) + (c.teachers ? '<span class="muted small"> · ' + esc(c.teachers) + '</span>' : '') + '</span></label>';
  }).join('') || '<div class="empty">No classes at this school yet.</div>';

  modal({
    title: todayOnly ? 'Cover today' : 'Arrange cover',
    confirm: todayOnly ? 'Turn on for today' : 'Arrange cover',
    body:
      '<div class="field"><label for="cv_sub">Substitute</label><select id="cv_sub">' + subOptions + '</select></div>' +
      '<div class="field"><label for="cv_for">Covering for</label><select id="cv_for">' + teacherOptions + '</select>' +
      '<div class="hint">Choosing a teacher ticks their classes below. Change the ticks as you need.</div></div>' +
      '<div class="field"><label>Classes</label><div class="perm-group" style="max-height:14rem;overflow:auto" id="cv_classes">' + classRows + '</div></div>' +
      '<div class="row">' +
        '<div class="field"><label for="cv_start">First day</label><input id="cv_start" type="date" value="' + esc(d.today) + '" min="' + esc(d.today) + '"' + (todayOnly ? ' disabled' : '') + '></div>' +
        '<div class="field"><label for="cv_end">Last day</label><input id="cv_end" type="date" value="' + esc(d.today) + '" min="' + esc(d.today) + '"' + (todayOnly ? ' disabled' : '') + '></div>' +
      '</div>' +
      '<div class="field"><label for="cv_note">Note <span class="muted small">(optional)</span></label>' +
      '<input id="cv_note" type="text" maxlength="300" placeholder="For example: Mr. Stone at a conference"></div>',
    onOpen: function (m) {
      var forSel = m.querySelector('#cv_for');
      forSel.onchange = function () {
        var teacherId = forSel.value;
        Array.prototype.forEach.call(m.querySelectorAll('#cv_classes input'), function (box) {
          var cls = d.classes.filter(function (c) { return c.id === box.value; })[0];
          box.checked = !!teacherId && !!cls && (cls.teacher_ids || []).indexOf(teacherId) >= 0;
        });
      };
      var start = m.querySelector('#cv_start');
      var end = m.querySelector('#cv_end');
      start.onchange = function () { if (end.value < start.value) end.value = start.value; end.min = start.value; };
    },
    onConfirm: function (m) {
      var ids = Array.prototype.map.call(m.querySelectorAll('#cv_classes input:checked'), function (b) { return b.value; });
      return api('/coverages', { method: 'POST', body: {
        tenant_id: state.tenantId,
        substitute_id: m.querySelector('#cv_sub').value,
        covering_for: m.querySelector('#cv_for').value || null,
        class_ids: ids,
        starts_on: m.querySelector('#cv_start').value,
        ends_on: m.querySelector('#cv_end').value,
        note: m.querySelector('#cv_note').value,
      } }).then(function () {
        toast(todayOnly ? 'Cover is on for today.' : 'Cover arranged.');
        setPage('substitutes');
      });
    },
  });
}

pages.classes = function () {
  return api('/classes' + tenantQuery()).then(function (d) {
    var canEdit = can('core:manage_classes', 'own');
    var rows = d.classes.map(function (c) {
      return '<tr data-id="' + esc(c.id) + '">' +
        '<td style="font-weight:550">' + esc(c.name) + '</td>' +
        '<td>' + esc(c.subject || '—') + '</td>' +
        '<td>' + ((c.grade_levels || []).length
          ? (c.grade_levels || []).map(function (y) { return '<span class="chip chip-blue">' + esc(y) + '</span>'; }).join(' ')
          : '<span class="muted">—</span>') + '</td>' +
        '<td>' + esc(c.teachers || '—') + '</td>' +
        '<td>' + esc(c.students) + '</td>' +
        '<td style="text-align:right;white-space:nowrap">' +
          (canEdit ? '<button class="btn btn-sm btn-quiet" data-edit>Edit</button> ' : '') +
          '<button class="btn btn-sm" data-open>Roster</button></td></tr>';
    }).join('') || '<tr><td colspan="6" class="empty">No classes yet.</td></tr>';

    document.getElementById('main').innerHTML =
      head('Classes', 'One roster, shared by every app. A class made here shows up in the whiteboard, the atlas and the times tables trainer.') +
      (canEdit ? '<div class="toolbar"><button class="btn btn-primary btn-sm" id="newClass">New class</button></div>' : '') +
      '<div class="card"><div class="table-wrap"><table><thead><tr>' +
      '<th>Class</th><th>Subject</th><th>Year groups</th><th>Teachers</th><th>Students</th><th></th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div></div>';

    if (canEdit) document.getElementById('newClass').onclick = newClassDialog;
    Array.prototype.forEach.call(document.querySelectorAll('tr[data-id] [data-open]'), function (b) {
      b.onclick = function () { rosterDialog(b.closest('tr').dataset.id); };
    });
    Array.prototype.forEach.call(document.querySelectorAll('tr[data-id] [data-edit]'), function (b) {
      b.onclick = function () {
        const id = b.closest('tr').dataset.id;
        editClassDialog(d.classes.filter(function (c) { return c.id === id; })[0]);
      };
    });
  });
};

function newClassDialog() {
  modal({
    title: 'New class',
    confirm: 'Create',
    body:
      '<div class="field"><label for="m_name">Class name</label><input id="m_name" type="text" placeholder="e.g. 3B Mathematics"></div>' +
      '<div class="field"><label for="m_subject">Subject</label><input id="m_subject" type="text"></div>' +
      yearGroupPicker('m_years', []),
    onOpen: function (m) { bindYearGroupPicker(m, 'm_years'); },
    onConfirm: function (m) {
      return api('/classes', { method: 'POST', body: {
        name: m.querySelector('#m_name').value,
        subject: m.querySelector('#m_subject').value,
        grade_levels: readYearGroups(m, 'm_years'),
        tenant_id: state.tenantId,
      } }).then(function () { toast('Class created.'); setPage('classes'); });
    },
  });
}

function editClassDialog(cls) {
  modal({
    title: 'Edit ' + cls.name,
    confirm: 'Save',
    body:
      '<div class="field"><label for="e_name">Class name</label>' +
      '<input id="e_name" type="text" value="' + esc(cls.name) + '"></div>' +
      '<div class="row">' +
        '<div class="field"><label for="e_subject">Subject</label>' +
        '<input id="e_subject" type="text" value="' + esc(cls.subject || '') + '"></div>' +
        '<div class="field"><label for="e_year">School year</label>' +
        '<input id="e_year" type="text" value="' + esc(cls.school_year || '') + '"></div>' +
      '</div>' +
      yearGroupPicker('e_years', cls.grade_levels || []) +
      '<div class="field"><label style="display:flex;gap:.5rem;align-items:center;font-weight:500">' +
      '<input type="checkbox" id="e_archived"' + (cls.archived ? ' checked' : '') + '> Archived</label>' +
      '<div class="hint">Archiving hides the class without losing who was in it.</div></div>',
    onOpen: function (m) { bindYearGroupPicker(m, 'e_years'); },
    onConfirm: function (m) {
      return api('/classes/' + cls.id, { method: 'PATCH', body: {
        name: m.querySelector('#e_name').value,
        subject: m.querySelector('#e_subject').value,
        school_year: m.querySelector('#e_year').value,
        grade_levels: readYearGroups(m, 'e_years'),
        archived: m.querySelector('#e_archived').checked,
      } }).then(function () { toast('Class saved.'); setPage('classes'); });
    },
  });
}

// The roster dialog. The "add people" box is a search first and a paste
// target second: adding a colleague you know by name is the case that
// actually happens, and typing their address exactly was the old price of it.
function rosterDialog(classId) {
  api('/classes/' + classId + '/members').then(function (d) {
    var list = d.members.map(function (m) {
      return '<div class="perm-row"><span class="label">' + esc(m.display_name) +
        '<span class="muted small"> · ' + esc(m.email) + '</span></span>' +
        '<span class="chip ' + (m.role === 'teacher' ? 'chip-blue' : 'chip-grey') + '">' + esc(m.role) + '</span>' +
        '<button class="btn btn-sm btn-quiet" data-remove="' + esc(m.id) + '">Remove</button></div>';
    }).join('') || '<div class="empty">Nobody in this class yet.</div>';

    // Already on the roster. The search leaves these out, so without this a
    // teacher retyping a name would be told nobody matched.
    var onRoster = {};
    d.members.forEach(function (m) { onRoster[lower(m.email)] = m.display_name; });

    modal({
      title: d.class.name,
      subtitle: 'Roster shared across every app.',
      confirm: 'Add people',
      body:
        '<div class="perm-group" style="max-height:16rem;overflow:auto">' + list + '</div>' +
        '<div class="field"><label for="m_q">Add people</label>' +
        '<div class="picker">' +
          '<div class="picked" id="m_picked" hidden></div>' +
          '<input id="m_q" type="text" autocomplete="off" spellcheck="false" ' +
            'placeholder="Search by name, or type an email address">' +
          '<div class="picker-results" id="m_results" hidden></div>' +
        '</div>' +
        '<div class="hint">Searches the people who already have an account in this school. ' +
        'A pasted list of addresses still works.</div></div>' +
        '<div class="field"><label for="m_role">Add as</label><select id="m_role">' +
        '<option value="student">Student</option><option value="teacher">Teacher</option>' +
        '<option value="aide">Aide</option><option value="observer">Observer</option></select></div>',
      onOpen: function (m) {
        Array.prototype.forEach.call(m.querySelectorAll('[data-remove]'), function (b) {
          b.onclick = function () {
            api('/classes/' + classId + '/members/' + b.dataset.remove, { method: 'DELETE' })
              .then(function () { closeModal(); rosterDialog(classId); })
              .catch(function (e) { toast(e.message, true); });
          };
        });
        bindPeoplePicker(m, classId, onRoster);
      },
      onConfirm: function (m) {
        m._picker.commitTyped();          // forgive not pressing Enter
        var emails = m._picker.emails();
        if (!emails.length) { toast('Nobody chosen yet.', true); return true; }
        return api('/classes/' + classId + '/members', { method: 'POST', body: {
          emails: emails, role: m.querySelector('#m_role').value,
        } }).then(function (r) {
          toast(r.added + (r.added === 1 ? ' person added' : ' people added') +
            (r.missing.length
              ? '. No account in this school for ' + r.missing.slice(0, 3).join(', ') +
                (r.missing.length > 3 ? ' and ' + (r.missing.length - 3) + ' more' : '')
              : '') + '.',
            r.missing.length > 0);
          closeModal(); setPage('classes');
        });
      },
    });
  }).catch(function (e) { toast(e.message, true); });
}

function lower(s) { return String(s || '').trim().toLowerCase(); }
function looksLikeEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lower(s)); }

// The people picker. Search, staged list and keyboard handling kept together
// so the box behaves as one control rather than three that agree by accident.
//
// A staged person's `known` is deliberately three-valued: true once the
// school confirmed them, false once it denied them, null while unchecked. A
// pasted column of forty addresses stays null rather than firing forty
// lookups — the server reports those back after the add.
function bindPeoplePicker(m, classId, onRoster) {
  var input = m.querySelector('#m_q');
  var results = m.querySelector('#m_results');
  var picked = m.querySelector('#m_picked');
  var chosen = [];        // { email, name, known }
  var rows = [];          // people currently listed under the box
  var cursor = -1;
  var timer = null;
  var seq = 0;

  function renderPicked() {
    picked.hidden = chosen.length === 0;
    picked.innerHTML = chosen.map(function (c, i) {
      var tone = c.known === true ? 'chip-blue' : c.known === false ? 'chip-red' : 'chip-grey';
      return '<span class="chip ' + tone + '"' +
        (c.known === false ? ' title="No account with that address in this school"' : '') + '>' +
        esc(c.name || c.email) +
        '<button type="button" data-drop="' + i + '" aria-label="Remove ' + esc(c.email) + '">&times;</button></span>';
    }).join('');
    Array.prototype.forEach.call(picked.querySelectorAll('[data-drop]'), function (b) {
      b.onclick = function () { chosen.splice(Number(b.dataset.drop), 1); renderPicked(); input.focus(); };
    });
  }

  function add(email, name, known) {
    var e = lower(email);
    if (!e) return;
    if (onRoster[e]) { toast(onRoster[e] + ' is already in this class.', true); return; }
    if (chosen.some(function (c) { return c.email === e; })) return;
    chosen.push({ email: e, name: name || null, known: known === undefined ? null : known });
    renderPicked();
  }

  function closeResults() { results.hidden = true; results.innerHTML = ''; rows = []; cursor = -1; }

  function renderResults(people, term) {
    rows = people;
    cursor = people.length ? 0 : -1;
    if (!people.length) {
      results.innerHTML = '<div class="picker-empty">' +
        (looksLikeEmail(term)
          ? 'Nobody in this school holds <span class="code">' + esc(term) + '</span>. ' +
            'Press Enter to stage it anyway.'
          : 'Nobody in this school matches <strong>' + esc(term) + '</strong>.') +
        '</div>';
    } else {
      results.innerHTML = people.map(function (p, i) {
        return '<button type="button" class="picker-row' + (i === cursor ? ' on' : '') + '" data-pick="' + i + '">' +
          '<span class="picker-name">' + esc(p.display_name) + '</span>' +
          '<span class="picker-mail">' + esc(p.email) + '</span>' +
          (p.role_label ? '<span class="chip chip-grey">' + esc(p.role_label) + '</span>' : '') +
        '</button>';
      }).join('');
      Array.prototype.forEach.call(results.querySelectorAll('[data-pick]'), function (b) {
        // Mousedown would blur the input and close this list before the click.
        b.onmousedown = function (e) { e.preventDefault(); };
        b.onclick = function () { pick(Number(b.dataset.pick)); };
      });
    }
    results.hidden = false;
  }

  function pick(i) {
    var p = rows[i];
    if (!p) return;
    add(p.email, p.display_name, true);
    input.value = ''; closeResults(); input.focus();
  }

  function highlight(next) {
    if (!rows.length) return;
    cursor = (next + rows.length) % rows.length;
    Array.prototype.forEach.call(results.querySelectorAll('.picker-row'), function (el, i) {
      el.classList.toggle('on', i === cursor);
      if (i === cursor && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    });
  }

  function search(term) {
    var mine = ++seq;
    api('/classes/' + classId + '/candidates?q=' + encodeURIComponent(term))
      .then(function (r) { if (mine === seq && input.value.trim() === term) renderResults(r.people, term); })
      .catch(function () { /* a failed lookup must not block typing */ });
  }

  // A single typed address is checked against the school straight away, so an
  // unknown one turns red as it is entered rather than after the add fails.
  function verify(email) {
    if (!looksLikeEmail(email)) return;
    api('/classes/' + classId + '/candidates?q=' + encodeURIComponent(email)).then(function (r) {
      var hit = r.people.filter(function (p) { return lower(p.email) === email; })[0];
      chosen.forEach(function (c) {
        if (c.email !== email) return;
        c.known = !!hit;
        if (hit) c.name = hit.display_name;
      });
      renderPicked();
    }).catch(function () {});
  }

  // Splitting on separators is what keeps a pasted column working: every
  // complete token becomes a chip and the unterminated tail stays in the box.
  function absorbSeparators() {
    if (!/[,;\n\t]/.test(input.value)) return false;
    var parts = input.value.split(/[,;\n\t]+/);
    var tail = parts.pop();
    var addresses = parts.map(lower).filter(Boolean);
    addresses.forEach(function (e) { add(e, null, null); });
    if (addresses.length <= 5) addresses.forEach(verify);
    input.value = tail;
    return true;
  }

  input.addEventListener('input', function () {
    if (absorbSeparators()) { closeResults(); return; }
    var term = input.value.trim();
    clearTimeout(timer);
    // Drop the listed people the moment the term changes. Leaving them would
    // let Enter add whoever the previous term matched while the new search is
    // still in flight — the wrong person, silently.
    rows = []; cursor = -1;
    if (term.length < 2) { closeResults(); return; }
    results.innerHTML = '<div class="picker-empty">Searching\u2026</div>';
    results.hidden = false;
    timer = setTimeout(function () { search(term); }, 160);
  });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight(cursor + 1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); highlight(cursor - 1); return; }
    if (e.key === 'Escape' && !results.hidden) { e.stopPropagation(); closeResults(); return; }
    if (e.key === 'Backspace' && !input.value && chosen.length) { chosen.pop(); renderPicked(); return; }
    if (e.key !== 'Enter') return;
    if (cursor >= 0 && rows[cursor]) { e.preventDefault(); pick(cursor); return; }
    if (looksLikeEmail(input.value)) {
      e.preventDefault();
      var typed = lower(input.value);
      add(typed, null, null);
      verify(typed);
      input.value = ''; closeResults();
    }
  });

  input.addEventListener('blur', function () { setTimeout(closeResults, 120); });

  // Exposed so "Add people" can pick up an address that was typed but never
  // committed — much the commonest way to lose one.
  m._picker = {
    emails: function () { return chosen.map(function (c) { return c.email; }); },
    commitTyped: function () {
      absorbSeparators();
      if (looksLikeEmail(input.value)) { add(lower(input.value), null, null); input.value = ''; }
    },
  };
}

pages.audit = function () {
  var only = state.cache.auditDisclosures ? '&disclosures=1' : '';
  return api('/audit' + tenantQuery() + (state.tenantId ? '' : '?') + (state.tenantId ? '&' : '') + 'limit=250' + only).then(function (d) {
    var rows = d.entries.map(function (e) {
      return '<tr>' +
        '<td class="muted small" style="white-space:nowrap">' + esc(when(e.ts)) + '</td>' +
        '<td>' + esc(e.actor_email || 'system') + '</td>' +
        '<td><span class="code">' + esc(e.action) + '</span>' +
          (e.is_disclosure ? ' <span class="chip chip-yellow">Disclosure</span>' : '') + '</td>' +
        '<td class="small muted">' + esc(JSON.stringify(e.detail)).slice(0, 160) + '</td>' +
        '<td class="small muted">' + esc(e.ip || '') + '</td>' +
      '</tr>';
    }).join('') || '<tr><td colspan="5" class="empty">Nothing logged yet.</td></tr>';

    document.getElementById('main').innerHTML =
      head('Audit log', 'Every administrative action, and every time a record was disclosed. Disclosure entries are kept for as long as the record itself, because the law requires it.') +
      '<div class="toolbar"><label style="display:flex;align-items:center;gap:.4rem;font-weight:500">' +
      '<input type="checkbox" id="onlyDisc"' + (state.cache.auditDisclosures ? ' checked' : '') + '> Show disclosures only</label></div>' +
      '<div class="card"><div class="table-wrap"><table><thead><tr>' +
      '<th>When</th><th>Who</th><th>Action</th><th>Detail</th><th>From</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div></div>';

    document.getElementById('onlyDisc').onchange = function () {
      state.cache.auditDisclosures = this.checked; setPage('audit');
    };
  });
};

// "8 hours" reads better than "480 minutes" on a page about policy.
function idleLabel(minutes) {
  var n = Number(minutes) || 0;
  if (n % 60 !== 0) return n + ' minutes';
  var h = n / 60;
  return h + (h === 1 ? ' hour' : ' hours');
}

pages.compliance = function () {
  return api('/compliance' + tenantQuery()).then(function (d) {
    var auth = d.consents.filter(function (c) { return c.kind === 'school_authorization' && !c.revoked_at; })[0];

    // What legal footing this deployment is on, said plainly at the top.
    var postureCard = d.posture === 'school-staff'
      ? '<div class="notice notice-info"><strong>Run by school staff, for students ' +
        esc(d.minimumAge) + ' and over</strong>' +
        'On this footing COPPA does not apply \u2014 it governs information collected from ' +
        'children under 13. No legal entity, postal address or designated security coordinator ' +
        'is required. That changes if a younger student gets an account, or if these apps are ' +
        'offered to a school beyond your own.' +
        (d.policyUnfilled && d.policyUnfilled.length
          ? '<div class="small" style="margin-top:.4rem"><strong>The published policy is still incomplete:</strong> ' +
            esc(d.policyUnfilled.join(', ')) + '</div>'
          : '') +
        '</div>'
      : '<div class="notice notice-warn"><strong>Operating as a vendor</strong>' +
        'These apps are offered to schools beyond your own, so a legal entity, a published address, ' +
        'a named security coordinator and a written security programme are all required \u2014 and ' +
        'COPPA applies as soon as a school enrols a student under 13.</div>';

    var authCard = auth
      ? '<div class="notice notice-ok"><strong>School authorization on file</strong>' +
        esc(auth.signer_name) + ' (' + esc(auth.signer_title) + ', ' + esc(auth.signer_email) + ') on ' +
        esc(new Date(auth.signed_at).toLocaleDateString()) + ', against policy version ' + esc(auth.policy_version) + '.</div>'
      : d.posture === 'school-staff'
      ? '<div class="notice notice-info"><strong>No school authorization recorded</strong>' +
        'Not needed right now — COPPA only matters if a student under ' + esc(d.minimumAge) + ' gets an account.</div>'
      : '<div class="notice notice-danger"><strong>No school authorization recorded</strong>' +
        'COPPA lets a school consent on parents’ behalf for classroom software — but only if the school actually authorized it and was told what is collected. Record that here.</div>';

    var purge = d.pendingPurge.map(function (p) {
      return '<tr><td>' + esc(p.display_name) + '</td><td class="muted small">' + esc(when(p.purge_after)) + '</td></tr>';
    }).join('') || '<tr><td colspan="2" class="muted">Nothing queued.</td></tr>';

    var disc = d.disclosures.map(function (e) {
      return '<tr><td class="muted small">' + esc(when(e.ts)) + '</td><td>' + esc(e.actor_email || 'system') +
        '</td><td><span class="code">' + esc(e.action) + '</span></td></tr>';
    }).join('') || '<tr><td colspan="3" class="muted">None recorded.</td></tr>';

    document.getElementById('main').innerHTML =
      head('Compliance', 'The records that make the legal basis for handling children’s data real rather than assumed.') +
      authCard +
      (d.posture !== 'school-staff' && can('core:manage_tenants', 'tenant')
        ? '<div class="toolbar"><button class="btn btn-primary btn-sm" id="recordAuth">' +
          (auth ? 'Record a new authorization' : 'Record the school authorization') + '</button></div>'
        : '') +
      '<div class="grid-2">' +
        '<div class="card"><div class="card-head"><h2>Retention</h2></div><div class="card-body">' +
          '<p class="small">Inactive accounts are erased after <strong>' + esc(d.effectiveRetentionDays) + ' days</strong>. ' +
          'Erased records leave encrypted backups within 30 days.</p>' +
          (d.sessionWindows
            ? '<p class="small">A sign-in ends after <strong>' + esc(idleLabel(d.sessionWindows.staffIdleMinutes)) +
              '</strong> away from it for staff, and <strong>' + esc(idleLabel(d.sessionWindows.studentIdleMinutes)) +
              '</strong> for students — classroom devices get handed on. Either way it ends after <strong>' +
              esc(d.sessionWindows.absoluteHours) + ' hours</strong>.</p>'
            : '') +
          '<p class="small muted">Current policy version: <span class="code">' + esc(d.policyVersion) + '</span></p>' +
        '</div></div>' +
        '<div class="card"><div class="card-head"><h2>Queued for erasure</h2></div>' +
        '<div class="table-wrap"><table><thead><tr><th>Person</th><th>Erased on</th></tr></thead><tbody>' + purge + '</tbody></table></div></div>' +
      '</div>' +
      '<div class="card"><div class="card-head"><h2>Recent disclosures</h2><div class="spacer"></div>' +
      '<button class="btn btn-sm" data-go="audit">Full record</button></div>' +
      '<div class="table-wrap"><table><thead><tr><th>When</th><th>By</th><th>What</th></tr></thead><tbody>' + disc + '</tbody></table></div></div>';

    bindGo();
    var btn = document.getElementById('recordAuth');
    if (btn) btn.onclick = authorizationDialog;
  });
};

function authorizationDialog() {
  modal({
    title: 'Record the school authorization',
    subtitle: 'Who at the school authorized these apps to collect pupil data, and when.',
    confirm: 'Record it',
    body:
      '<p class="small">This is the evidence behind the COPPA school-consent exception. Keep it accurate — it is what a district would ask to see.</p>' +
      '<div class="row">' +
        '<div class="field"><label for="m_signer">Name</label><input id="m_signer" type="text"></div>' +
        '<div class="field"><label for="m_title">Role at the school</label><input id="m_title" type="text" placeholder="e.g. Principal, Head of IT"></div>' +
      '</div>' +
      '<div class="field"><label for="m_semail">Email address</label><input id="m_semail" type="email"></div>' +
      '<div class="field"><label for="m_method">How was it given?</label><input id="m_method" type="text" placeholder="e.g. signed agreement, email confirmation, meeting"></div>' +
      '<div class="field"><label for="m_note">Notes</label><textarea id="m_note" rows="3"></textarea>' +
      '<div class="hint">The reason only \u2014 no addresses, phone numbers or other personal details. The privacy policy says none are asked for, and this is one of the few places somebody could type one anyway.</div>' + '</div>' +
      '<div class="notice notice-info"><strong>What they are authorizing</strong>' +
      'Name, school email, profile picture, role, class membership and sign-in records, used only to run the school’s own apps. No advertising, no profiling, no sale.</div>',
    onConfirm: function (m) {
      return api('/compliance/authorization', { method: 'POST', body: {
        signer_name: m.querySelector('#m_signer').value,
        signer_title: m.querySelector('#m_title').value,
        signer_email: m.querySelector('#m_semail').value,
        method: m.querySelector('#m_method').value,
        note: m.querySelector('#m_note').value,
        tenant_id: state.tenantId,
      } }).then(function () { toast('Authorization recorded.'); setPage('compliance'); });
    },
  });
}

pages.tenants = function () {
  return api('/tenants').then(function (d) {
    var cards = d.tenants.map(function (t) {
      if (t.kind === 'independent') {
        return '<div class="card"><div class="card-head"><h2>' + esc(tenantLabel(t)) + '</h2>' +
          statusChip(t.status) +
          '<div class="spacer"></div>' +
          '<span class="muted small">' + esc(t.people) + ' people</span></div>' +
          '<div class="card-body tight"><p class="small" style="margin:0">For people who are not at any school. ' +
          'A super admin adds each one from People (pick <strong>Independent</strong> in the school picker) ' +
          'or approves a request into it. Members cannot see one another, never hold an admin role, ' +
          'and are not in classes. No email domain can join them automatically.</p></div></div>';
      }
      var domains = (t.domains || []).map(function (x) {
        return '<span class="chip chip-grey">' + esc(x) + ' <button class="btn btn-sm btn-quiet" data-rmdom="' + esc(t.id) + '|' + esc(x) + '" style="padding:0 .2rem">remove</button></span>';
      }).join(' ') || '<span class="muted small">No domains yet — nobody can join automatically.</span>';

      return '<div class="card"><div class="card-head"><h2>' + esc(t.name) + '</h2>' +
        statusChip(t.status) +
        '<div class="spacer"></div>' +
        '<span class="muted small">' + esc(t.people) + ' people</span>' +
        '<button class="btn btn-sm" data-edit-tenant="' + esc(t.id) + '">Settings</button></div>' +
        '<div class="card-body tight">' +
        '<p class="small" style="margin:0 0 .6rem">School ID <span class="code">' + esc(t.slug) + '</span> ' +
        '<span class="muted">— for the School ID column of a roster import. The school\u2019s full ' +
        'name works there too, and leaving the column blank is usually simplest.</span></p>' +
        '<div style="margin-bottom:.6rem">' + domains + '</div>' +
        '<button class="btn btn-sm" data-adddom="' + esc(t.id) + '">Add domain</button></div></div>';
    }).join('');

    document.getElementById('main').innerHTML =
      head('Schools', 'Each school is a separate world: its own people, roles, classes and audit trail. Nothing crosses between them.') +
      '<div class="toolbar"><button class="btn btn-primary btn-sm" id="newTenant">New school</button></div>' + cards;

    document.getElementById('newTenant').onclick = function () {
      modal({
        title: 'New school', confirm: 'Create',
        body: '<div class="field"><label for="m_name">Name</label><input id="m_name" type="text"></div>' +
          '<div class="notice notice-info"><strong>Accounts are for people 13 and over</strong>' +
          'That applies to every school here — it is stated in the privacy policy rather than ' +
          'configured per school, so the two cannot disagree.</div>',
        onConfirm: function (m) {
          return api('/tenants', { method: 'POST', body: {
            name: m.querySelector('#m_name').value,
            minors_default: false,
          } }).then(function () { toast('School created.'); setPage('tenants'); });
        },
      });
    };

    Array.prototype.forEach.call(document.querySelectorAll('[data-adddom]'), function (b) {
      b.onclick = function () {
        var roles = (state.cache.roles || []).filter(function (r) { return !r.is_admin; });
        modal({
          title: 'Add an email domain', confirm: 'Add',
          body: '<div class="field"><label for="m_dom">Domain</label><input id="m_dom" type="text" placeholder="school.edu"></div>' +
            '<div class="field"><label for="m_role">Give new sign-ins this role</label><select id="m_role">' +
            '<option value="">Leave awaiting approval</option>' +
            roles.map(function (r) { return '<option value="' + esc(r.key) + '">' + esc(r.label) + '</option>'; }).join('') +
            '</select><div class="hint">Administrative roles can never be granted this way.</div></div>' +
            '<div class="field"><label style="display:flex;gap:.5rem;align-items:center;font-weight:500">' +
            '<input type="checkbox" id="m_hd" checked> Require a Google Workspace account on this domain</label>' +
            '<div class="hint">Leave on. Without it, a personal account using the same domain name would be accepted.</div></div>',
          onConfirm: function (m) {
            return api('/tenants/' + b.dataset.adddom + '/domains', { method: 'POST', body: {
              domain: m.querySelector('#m_dom').value,
              auto_role: m.querySelector('#m_role').value || null,
              require_hd: m.querySelector('#m_hd').checked,
            } }).then(function () { toast('Domain added.'); setPage('tenants'); });
          },
        });
      };
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-rmdom]'), function (b) {
      b.onclick = function () {
        var parts = b.dataset.rmdom.split('|');
        if (!window.confirm('Remove ' + parts[1] + '? New sign-ins on it will no longer join automatically.')) return;
        api('/tenants/' + parts[0] + '/domains/' + encodeURIComponent(parts[1]), { method: 'DELETE' })
          .then(function () { toast('Domain removed.'); setPage('tenants'); })
          .catch(function (e) { toast(e.message, true); });
      };
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-edit-tenant]'), function (b) {
      b.onclick = function () {
        var t = d.tenants.filter(function (x) { return x.id === b.dataset.editTenant; })[0];
        modal({
          title: t.name + ' settings', confirm: 'Save',
          body: '<div class="field"><label for="m_name">Name</label><input id="m_name" type="text" value="' + esc(t.name) + '"></div>' +
            '<div class="row"><div class="field"><label for="m_status">Status</label><select id="m_status">' +
            ['active', 'suspended', 'archived'].map(function (s) {
              return '<option value="' + s + '"' + (s === t.status ? ' selected' : '') + '>' + s + '</option>';
            }).join('') + '</select></div>' +
            '<div class="field"><label for="m_ret">Retention (days)</label>' +
            '<input id="m_ret" type="number" value="' + esc(t.retention_days || '') + '" placeholder="' + esc(state.retentionDays) + '"></div></div>' +
'',
          onConfirm: function (m) {
            return api('/tenants/' + t.id, { method: 'PATCH', body: {
              name: m.querySelector('#m_name').value,
              status: m.querySelector('#m_status').value,
              retention_days: m.querySelector('#m_ret').value,
            } }).then(function () { toast('Saved.'); setPage('tenants'); });
          },
        });
      };
    });
  });
};

pages.apps = function () {
  return Promise.all([api('/apps'), api('/tenants')]).then(function (r) {
    var apps = r[0].apps;
    var issuer = r[0].issuer;
    var tenants = r[1].tenants;

    var cards = apps.map(function (a) {
      return '<div class="card"><div class="card-head"><h2>' + esc(a.name) + '</h2>' +
        statusChip(a.status) +
        '<span class="chip chip-blue">' + esc(a.namespace) + '</span>' +
        '<div class="spacer"></div>' +
        '<button class="btn btn-sm" data-schools="' + esc(a.id) + '">Schools</button>' +
        '<button class="btn btn-sm" data-rotate="' + esc(a.id) + '">Rotate secret</button>' +
        '<button class="btn btn-sm" data-setup="' + esc(a.id) + '">Setup</button>' +
        '</div><div class="card-body tight">' +
        '<p class="small muted" style="margin:0 0 .5rem">' + esc(a.description) + '</p>' +
        '<div class="small">Client id <span class="code">' + esc(a.client_id) + '</span></div>' +
        '<div class="small muted">Returns to: ' + (a.redirect_uris || []).map(function (u) { return '<span class="code">' + esc(u) + '</span>'; }).join(' ') + '</div>' +
        '<div class="small muted" style="margin-top:.35rem">Enabled for: ' + esc((a.tenants || []).join(', ') || 'no schools yet') + '</div>' +
        '</div></div>';
    }).join('') || '<div class="empty">No applications registered yet.</div>';

    document.getElementById('main').innerHTML =
      head('Applications', 'Each app that signs people in through Signify ID. An app only ever receives its own permissions plus the shared identity ones.') +
      '<div class="toolbar"><button class="btn btn-primary btn-sm" id="newApp">Register an app</button></div>' + cards;

    document.getElementById('newApp').onclick = function () {
      modal({
        title: 'Register an application', confirm: 'Register',
        body:
          '<div class="row"><div class="field"><label for="m_name">Name</label><input id="m_name" type="text" placeholder="Classroom Atlas"></div>' +
          '<div class="field"><label for="m_ns">Permission namespace</label><input id="m_ns" type="text" placeholder="atlas">' +
          '<div class="hint">Which permissions it may see.</div></div></div>' +
          '<div class="field"><label for="m_uris">Redirect addresses</label>' +
          '<textarea id="m_uris" rows="3" placeholder="https://maps.signify.one/auth/callback"></textarea>' +
          '<div class="hint">One per line. Must match exactly, and must use https outside localhost.</div></div>' +
          '<div class="field"><label for="m_desc">Description</label><input id="m_desc" type="text"></div>',
        onConfirm: function (m) {
          return api('/apps', { method: 'POST', body: {
            name: m.querySelector('#m_name').value,
            namespace: m.querySelector('#m_ns').value,
            redirect_uris: m.querySelector('#m_uris').value,
            description: m.querySelector('#m_desc').value,
          } }).then(function (d) {
            closeModal();
            showSecret(d.app, d.client_secret, issuer);
            setPage('apps');
            return true;
          });
        },
      });
    };

    Array.prototype.forEach.call(document.querySelectorAll('[data-rotate]'), function (b) {
      b.onclick = function () {
        var a = apps.filter(function (x) { return x.id === b.dataset.rotate; })[0];
        if (!window.confirm('Rotate the secret for ' + a.name + '?\n\nThe app stops working until you paste the new secret into its environment.')) return;
        api('/apps/' + a.id + '/rotate-secret', { method: 'POST', body: {} })
          .then(function (d) { showSecret(a, d.client_secret, issuer); })
          .catch(function (e) { toast(e.message, true); });
      };
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-setup]'), function (b) {
      b.onclick = function () {
        var a = apps.filter(function (x) { return x.id === b.dataset.setup; })[0];
        showSecret(a, null, issuer);
      };
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-schools]'), function (b) {
      b.onclick = function () {
        var a = apps.filter(function (x) { return x.id === b.dataset.schools; })[0];
        var enabled = a.tenants || [];
        modal({
          title: a.name + ' — schools', confirm: 'Done',
          body: tenants.map(function (t) {
            return '<div class="perm-row"><input type="checkbox" data-t="' + esc(t.id) + '"' +
              (enabled.indexOf(t.name) >= 0 ? ' checked' : '') + '>' +
              '<span class="label">' + esc(t.name) + '</span></div>';
          }).join('') +
          '<p class="small muted" style="margin-top:.75rem">A school that is not ticked cannot sign in to this app at all.</p>',
          onConfirm: function (m) {
            var calls = Array.prototype.map.call(m.querySelectorAll('[data-t]'), function (c) {
              return api('/apps/' + a.id + '/tenants', { method: 'POST', body: { tenant_id: c.dataset.t, enabled: c.checked } });
            });
            return Promise.all(calls).then(function () { toast('Updated.'); setPage('apps'); });
          },
        });
      };
    });
  });
};

function showSecret(app, secret, issuer) {
  var env =
    'SIGNIFY_ISSUER=' + issuer + '\n' +
    'SIGNIFY_CLIENT_ID=' + app.client_id + '\n' +
    'SIGNIFY_CLIENT_SECRET=' + (secret || '(unchanged — rotate to see a new one)') + '\n' +
    'SIGNIFY_REDIRECT_URI=' + ((app.redirect_uris || [])[0] || '');

  modal({
    title: app.name + ' setup', confirm: 'Done',
    body:
      (secret ? '<div class="notice notice-warn"><strong>Copy the secret now</strong>' +
        'It is shown once and never again. Rotating produces a new one and immediately invalidates this.</div>' : '') +
      '<p class="small">Paste these into the app’s environment, then drop <span class="code">signify-auth.js</span> into it.</p>' +
      '<pre class="code" id="envblock">' + esc(env) + '</pre>' +
      '<button class="btn btn-sm" id="copyEnv">Copy</button>',
    onOpen: function (m) {
      m.querySelector('#copyEnv').onclick = function () {
        navigator.clipboard.writeText(env).then(function () { toast('Copied.'); });
      };
    },
    onConfirm: function () {},
  });
}

pages.platform = function () {
  return api('/platform').then(function (d) {
    var rows = d.admins.map(function (a) {
      return '<tr><td style="font-weight:550">' + esc(a.display_name) + '<div class="small muted">' + esc(a.email) + '</div></td>' +
        '<td class="small muted">' + esc(a.note || '') + '</td>' +
        '<td class="small muted">' + esc(when(a.last_seen_at)) + '</td>' +
        '<td style="text-align:right"><button class="btn btn-sm btn-quiet" data-rm="' + esc(a.id) + '">Remove</button></td></tr>';
    }).join('');

    document.getElementById('main').innerHTML =
      head('Super admins', 'Full control over every school and every app. Keep at least two so a lost account cannot lock everyone out.') +
      (d.admins.length < 2 ? '<div class="notice notice-danger"><strong>Only one super admin</strong>' +
        'If that account is lost, nobody can administer any of the apps. Add a second now.</div>' : '') +
      '<div class="toolbar"><button class="btn btn-primary btn-sm" id="addSuper">Add super admin</button></div>' +
      '<div class="card"><div class="table-wrap"><table><thead><tr>' +
      '<th>Person</th><th>Note</th><th>Last seen</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div></div>' +
      '<div class="card"><div class="card-head"><h2>Service</h2></div><div class="card-body">' +
      '<p class="small">Issuer <span class="code">' + esc(d.issuer) + '</span></p>' +
      '<p class="small muted">Bootstrapped from SUPER_ADMINS: ' + esc(d.configuredSuperAdmins.join(', ') || 'none') + '</p>' +
      '</div></div>';

    document.getElementById('addSuper').onclick = function () {
      modal({
        title: 'Add a super admin', confirm: 'Grant',
        body: '<div class="field"><label for="m_email">Email address</label><input id="m_email" type="email">' +
          '<div class="hint">They must have signed in at least once already.</div></div>' +
          '<div class="field"><label for="m_note">Note</label><input id="m_note" type="text" placeholder="Why this person?">' +
          '<div class="hint">The reason only \u2014 no addresses, phone numbers or other personal details. The privacy policy says none are asked for, and this is one of the few places somebody could type one anyway.</div>' + '</div>' +
          '<div class="notice notice-warn"><strong>This is total access</strong>' +
          'A super admin can see and change every record in every school. Make sure their Google account has two-step verification turned on.</div>',
        onConfirm: function (m) {
          return api('/platform/admins', { method: 'POST', body: {
            email: m.querySelector('#m_email').value, note: m.querySelector('#m_note').value,
          } }).then(function () { toast('Granted.'); setPage('platform'); });
        },
      });
    };

    Array.prototype.forEach.call(document.querySelectorAll('[data-rm]'), function (b) {
      b.onclick = function () {
        if (!window.confirm('Remove super admin access?')) return;
        api('/platform/admins/' + b.dataset.rm, { method: 'DELETE' })
          .then(function () { toast('Removed.'); setPage('platform'); })
          .catch(function (e) { toast(e.message, true); });
      };
    });
  });
};


// ---------- year group picker ----------
// A dropdown that adds a chip, rather than a multi-select list: a class can
// span several year groups, and a browser multi-select is miserable on a
// touchscreen and hides what is chosen.

function yearGroupPicker(id, selected) {
  const chosen = Array.isArray(selected) ? selected.slice() : [];
  const options = state.yearGroups.map(function (y) {
    return '<option value="' + esc(y) + '">' + esc(y) + '</option>';
  }).join('');
  return '<div class="field"><label for="' + id + '">Year groups</label>' +
    '<div class="chips" id="' + id + '_chips" data-value="' + esc(chosen.join('|')) + '"></div>' +
    '<select id="' + id + '"><option value="">Add a year group…</option>' + options + '</select>' +
    '<div class="hint">A class can cover more than one. Leave empty if it does not map to a year.</div></div>';
}

function bindYearGroupPicker(root, id) {
  const chips = root.querySelector('#' + id + '_chips');
  const sel = root.querySelector('#' + id);

  function values() {
    const raw = chips.dataset.value || '';
    return raw ? raw.split('|').filter(Boolean) : [];
  }
  function render() {
    chips.innerHTML = values().map(function (v) {
      return '<span class="chip chip-blue">' + esc(v) +
        '<button type="button" data-remove="' + esc(v) + '" aria-label="Remove ' + esc(v) + '">&times;</button></span>';
    }).join('');
    Array.prototype.forEach.call(chips.querySelectorAll('[data-remove]'), function (b) {
      b.onclick = function () {
        chips.dataset.value = values().filter(function (v) { return v !== b.dataset.remove; }).join('|');
        render();
      };
    });
  }
  sel.onchange = function () {
    const v = this.value;
    this.value = '';
    if (!v) return;
    const cur = values();
    if (cur.indexOf(v) >= 0) return;
    cur.push(v);
    // Keep them in the order the school lists them, not the order clicked.
    chips.dataset.value = state.yearGroups.filter(function (y) { return cur.indexOf(y) >= 0; })
      .concat(cur.filter(function (y) { return state.yearGroups.indexOf(y) < 0; })).join('|');
    render();
  };
  render();
  return values;
}

function readYearGroups(root, id) {
  const chips = root.querySelector('#' + id + '_chips');
  const raw = chips ? (chips.dataset.value || '') : '';
  return raw ? raw.split('|').filter(Boolean) : [];
}

// ---------- roster import ----------

function importDialog() {
  let fileText = '';
  let fileName = '';
  let analysis = null;

  const chooser =
    '<p class="small">Every row needs an email address — that is what identifies a person. ' +
    'Everything else is optional and can be left blank.</p>' +
    '<div class="dropzone" id="drop">' +
      '<div id="dropLabel"><strong>Choose a CSV file</strong>' +
      '<div class="small muted">or drag one here</div></div>' +
      '<input type="file" id="csvfile" accept=".csv,text/csv" hidden>' +
    '</div>' +
    '<div class="field" style="margin-top:1rem">' +
      '<label style="display:flex;gap:.5rem;align-items:center;font-weight:500">' +
      '<input type="checkbox" id="mkClasses"> Create classes that do not exist yet</label>' +
      '<div class="hint">Off by default, so a typo in a class name is reported rather than ' +
      'turned into a new class.</div>' +
    '</div>' +
    '<p class="small"><a href="/api/admin/roster/template.csv" download>Download a template</a> ' +
    '— it has example rows showing how to write more than one class or app.</p>' +
    // Filled in from /roster/reference once it lands, so nobody has to guess
    // at the exact spelling of a class or an app.
    '<div id="importRef"><p class="small muted">Loading what each column accepts…</p></div>';

  const m = modal({
    title: 'Import a roster',
    subtitle: 'Nothing is changed until you have seen exactly what it would do.',
    confirm: 'Check the file',
    body: chooser,
    onOpen: function (root) {
      // Nobody should have to guess at the exact spelling of a class or an
      // app, so the dialog fetches and shows what each column will accept.
      api('/roster/reference' + tenantQuery()).then(function (ref) {
        const box = root.querySelector('#importRef');
        if (!box) return;

        const chips = function (items, empty) {
          return items.length
            ? items.map(function (x) { return '<span class="chip chip-grey">' + esc(x) + '</span>'; }).join(' ')
            : '<span class="small muted">' + empty + '</span>';
        };
        const row = function (title, note, body) {
          return '<div class="perm-row" style="display:block">' +
            '<div class="small" style="font-weight:600;margin-bottom:.25rem">' + title + '</div>' +
            (note ? '<div class="small muted" style="margin-bottom:.35rem">' + note + '</div>' : '') +
            (body || '') + '</div>';
        };

        box.innerHTML =
          '<div class="perm-group" style="margin-top:1rem">' +
          '<h3>What each column accepts</h3>' +
          row('School ID',
            ref.schoolColumnNeeded
              ? 'Importing into <strong>' + esc(ref.tenant.name) + '</strong>. Leaving the column ' +
                'blank uses it. To be explicit, either the full name <span class="code">' +
                esc(ref.tenant.name) + '</span> or the short id <span class="code">' +
                esc(ref.tenant.slug) + '</span> works.'
              : 'Leave this blank. You can only import into <strong>' + esc(ref.tenant.name) +
                '</strong>, and rows naming another school are refused.', '') +
          row('Role', 'One per person. Blank means student.',
            chips(ref.roles.map(function (r) { return r.key + (r.admin ? ' (admin)' : ''); }), 'No roles found.')) +
          row('Classes',
            'Several are fine — separate them with a semicolon, like ' +
            '<span class="code">3B Mathematics; 4A Geography</span>. Names must match these ' +
            'exactly, unless you tick the box above.',
            chips(ref.classes, 'No classes yet — tick the box above to create them as you import.')) +
          row('Apps',
            'Several are fine, separated the same way. The name or the short id both work. ' +
            'Blank means everything the school allows.',
            chips(ref.apps.map(function (a) { return a.name; }), 'No apps switched on for this school yet.')) +
          row('Graduation year', 'A four-digit year, like <span class="code">2035</span>.', '') +
          '</div>';
      }).catch(function () {
        const box = root.querySelector('#importRef');
        if (box) box.innerHTML = '<p class="small muted">Could not load the column reference. ' +
          'The template download still shows the format.</p>';
      });

      const drop = root.querySelector('#drop');
      const input = root.querySelector('#csvfile');

      function take(file) {
        if (!file) return;
        fileName = file.name;
        const reader = new FileReader();
        reader.onload = function () {
          fileText = String(reader.result || '');
          drop.classList.add('has-file');
          root.querySelector('#dropLabel').innerHTML =
            '<strong>' + esc(fileName) + '</strong><div class="small muted">' +
            (fileText.split(/\r?\n/).filter(function (l) { return l.trim(); }).length - 1) +
            ' rows — choose another to replace it</div>';
        };
        reader.readAsText(file);
      }

      drop.onclick = function () { input.click(); };
      input.onchange = function () { take(this.files[0]); };
      drop.ondragover = function (e) { e.preventDefault(); };
      drop.ondrop = function (e) {
        e.preventDefault();
        take(e.dataTransfer.files[0]);
      };
    },
    onConfirm: function (root, close) {
      // Stage one: analyse. Stage two: apply.
      if (!analysis) {
        if (!fileText.trim()) { toast('Choose a file first.', true); return true; }
        return api('/roster/preview', { method: 'POST', body: {
          text: fileText,
          tenant_id: state.tenantId,
          create_missing_classes: root.querySelector('#mkClasses').checked,
        } }).then(function (a) {
          analysis = a;
          renderPreview(root, a);
          return true; // keep the modal open
        });
      }

      return api('/roster/apply', { method: 'POST', body: {
        text: fileText,
        filename: fileName,
        tenant_id: state.tenantId,
        create_missing_classes: analysis.usedCreateClasses,
      } }).then(function (r) {
        toast(r.created + ' added, ' + r.updated + ' updated' +
          (r.skipped ? ', ' + r.skipped + ' skipped' : '') + '.');
        close();
        setPage('users');
      });
    },
  });

  function renderPreview(root, a) {
    a.usedCreateClasses = root.querySelector('#mkClasses')
      ? root.querySelector('#mkClasses').checked : false;

    const rows = a.rows.map(function (r) {
      const chip = r.action === 'create' ? '<span class="chip chip-green">Add</span>'
        : r.action === 'update' ? '<span class="chip chip-blue">Update</span>'
        : '<span class="chip chip-red">Skip</span>';
      const detail = r.action === 'error'
        ? '<span class="problem">' + esc(r.problems.join(' ')) + '</span>'
        : esc([r.role ? r.role.label : '', (r.changes || []).join(', ')].filter(Boolean).join(' · '));
      return '<tr><td class="row-num">' + esc(r.line) + '</td>' +
        '<td>' + chip + '</td>' +
        '<td>' + esc(r.name || '') + '<div class="small muted">' + esc(r.email) + '</div></td>' +
        '<td class="' + (r.action === 'error' ? 'problem' : 'muted') + ' small">' + detail + '</td></tr>';
    }).join('');

    const warn = [];
    if (a.unknownColumns.length) {
      warn.push('<div class="notice notice-warn"><strong>Columns that were ignored</strong>' +
        esc(a.unknownColumns.join(', ')) + '</div>');
    }
    if (a.newClasses.length) {
      warn.push('<div class="notice notice-info"><strong>Classes that will be created</strong>' +
        esc(a.newClasses.join(', ')) + '</div>');
    }
    if (a.summary.error) {
      warn.push('<div class="notice notice-warn"><strong>' + a.summary.error +
        ' row' + (a.summary.error === 1 ? '' : 's') + ' will be skipped</strong>' +
        'The rest still import. Fix these and run the file again.</div>');
    }

    root.querySelector('.modal-body').innerHTML =
      '<div class="stat-row" style="margin-bottom:1rem">' +
        '<div class="card stat"><div class="n">' + a.summary.create + '</div><div class="k">To add</div></div>' +
        '<div class="card stat"><div class="n">' + a.summary.update + '</div><div class="k">To update</div></div>' +
        '<div class="card stat"><div class="n">' + a.summary.error + '</div><div class="k">To skip</div></div>' +
      '</div>' + warn.join('') +
      '<div class="preview-wrap"><table><thead><tr>' +
      '<th>Line</th><th></th><th>Person</th><th>What happens</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';

    const btn = root.querySelector('[data-confirm]');
    const total = a.summary.create + a.summary.update;
    btn.textContent = total ? 'Import ' + total + ' ' + (total === 1 ? 'person' : 'people') : 'Nothing to import';
    btn.disabled = !total;
  }
}

// ---------- backups ----------

pages.backups = function () {
  const mayBackup = can('core:manage_backups', 'tenant');
  const mayUndo = can('core:undo_import', 'tenant');
  const mayRestore = state.actor.isSuper;

  if (!mayBackup && !mayUndo) {
    document.getElementById('main').innerHTML =
      head('Backups', 'Downloading a copy of the school, and undoing a roster import.') +
      '<div class="notice notice-info"><strong>Not available to your role</strong>' +
      'A backup contains every pupil’s record, so it is limited to administrators.</div>';
    return Promise.resolve();
  }

  return Promise.all([
    mayBackup ? api('/backups' + tenantQuery()) : Promise.resolve({ backups: [], keepDays: 30 }),
    mayUndo ? api('/roster/imports' + tenantQuery()) : Promise.resolve({ imports: [], windowDays: 30 }),
  ]).then(function (r) {
    const d = r[0];
    const imports = r[1];

    const backupRows = d.backups.map(function (b) {
      const counts = Object.keys(b.row_counts || {})
        .filter(function (k) { return b.row_counts[k]; })
        .map(function (k) { return b.row_counts[k] + ' ' + k.replace(/_/g, ' '); })
        .join(', ');
      const kind = b.kind === 'pre_restore'
        ? '<span class="chip chip-yellow">Before a restore</span>'
        : '<span class="chip chip-grey">Downloaded</span>';
      return '<tr><td class="muted small" style="white-space:nowrap">' + esc(when(b.created_at)) + '</td>' +
        '<td>' + kind + '</td>' +
        '<td>' + esc(b.created_by || 'system') + '</td>' +
        '<td class="small muted">' + esc(counts) + '</td>' +
        '<td style="text-align:right">' +
          (b.expires_at && mayRestore
            ? '<a class="btn btn-sm" href="/api/admin/backups/' + esc(b.id) + '/download">Download undo</a>'
            : '<span class="small faint">not kept</span>') +
        '</td></tr>';
    }).join('') || '<tr><td colspan="5" class="empty">No backups yet.</td></tr>';

    const importRows = imports.imports.map(function (i) {
      const status = i.undone_at
        ? '<span class="chip chip-grey">Undone</span>'
        : (i.undoable ? '<span class="chip chip-green">Reversible</span>'
                      : '<span class="chip chip-grey">Past the window</span>');
      return '<tr data-import="' + esc(i.id) + '">' +
        '<td class="muted small" style="white-space:nowrap">' + esc(when(i.created_at)) + '</td>' +
        '<td>' + esc(i.filename || 'roster') + '</td>' +
        '<td>' + esc(i.created_by || '') + '</td>' +
        '<td class="small muted">' + esc(i.created_n) + ' added, ' + esc(i.updated_n) + ' updated' +
          (i.skipped_n ? ', ' + esc(i.skipped_n) + ' skipped' : '') + '</td>' +
        '<td>' + status + '</td>' +
        '<td style="text-align:right">' +
          (i.undoable ? '<button class="btn btn-sm" data-undo>Undo</button>' : '') +
        '</td></tr>';
    }).join('') || '<tr><td colspan="6" class="empty">No roster imports yet.</td></tr>';

    document.getElementById('main').innerHTML =
      head('Backups', 'A backup is one school’s roster and settings. It carries no passwords, sessions or keys — but it does carry every pupil’s name and email, so treat the file as the record it is.') +
      '<div class="toolbar">' +
        (mayBackup ? '<button class="btn btn-primary btn-sm" id="mkBackup">Download a backup</button>' : '') +
        (mayRestore ? '<button class="btn btn-sm btn-danger" id="doRestore">Restore from a backup</button>' : '') +
      '</div>' +
      (mayRestore
        ? '<div class="notice notice-warn"><strong>Restore is a super admin operation</strong>' +
          'It only ever creates and updates — nobody is removed and no class is deleted. A snapshot of the current state is taken first and kept for ' + esc(d.keepDays) + ' days. ' +
          'Anything you could not do by hand is refused row by row, and you will be asked to type the school’s name.</div>'
        : '<div class="notice notice-info"><strong>Undoing an import, not restoring a file</strong>' +
          'Restoring an uploaded backup is reserved to super admins, because it can quietly revert work done since. ' +
          'What you can do instead is undo a roster import below — a known change, reversed exactly.</div>') +
      (mayBackup
        ? '<div class="card"><div class="card-head"><h2>Backups</h2><div class="spacer"></div>' +
          '<span class="small muted">at most 3 a day · downloaded ones are not stored here</span></div>' +
          '<div class="table-wrap"><table><thead><tr>' +
          '<th>When</th><th>Kind</th><th>By</th><th>Contents</th><th></th>' +
          '</tr></thead><tbody>' + backupRows + '</tbody></table></div></div>'
        : '') +
      (mayUndo
        ? '<div class="card"><div class="card-head"><h2>Roster imports</h2><div class="spacer"></div>' +
          '<span class="small muted">reversible for ' + esc(imports.windowDays) + ' days</span></div>' +
          '<div class="table-wrap"><table><thead><tr>' +
          '<th>When</th><th>File</th><th>By</th><th>Result</th><th></th><th></th>' +
          '</tr></thead><tbody>' + importRows + '</tbody></table></div></div>'
        : '');

    const mk = document.getElementById('mkBackup');
    if (mk) mk.onclick = function () {
      const btn = this;
      btn.disabled = true;
      fetch('/api/admin/backups', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': cookie('csrf') },
        credentials: 'same-origin',
        body: JSON.stringify({ tenant_id: state.tenantId }),
      }).then(function (res) {
        if (res.status === 403) {
          return res.json().then(function (e) {
            if (e.code === 'reauth_required') {
              window.location.href = '/signin?reauth=1&continue=' + encodeURIComponent('/admin');
            }
            throw new Error(e.error || 'Not allowed.');
          });
        }
        if (!res.ok) return res.json().then(function (e) { throw new Error(e.error || 'Could not make a backup.'); });
        return res.blob();
      }).then(function (blob) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'signify-backup-' + new Date().toISOString().slice(0, 10) + '.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        toast('Backup downloaded. It is watermarked and logged as a disclosure.');
        setPage('backups');
      }).catch(function (e) { toast(e.message, true); })
        .finally(function () { btn.disabled = false; });
    };

    const rs = document.getElementById('doRestore');
    if (rs) rs.onclick = restoreDialog;

    Array.prototype.forEach.call(document.querySelectorAll('[data-undo]'), function (b) {
      b.onclick = function () { undoImportDialog(b.closest('tr').dataset.import); };
    });
  });
};

function undoImportDialog(importId) {
  api('/roster/imports/' + importId + '/undo-preview', { method: 'POST', body: { tenant_id: state.tenantId } })
    .then(function (p) {
      const kept = p.plan.usersKeptBecauseTheySignedIn;
      modal({
        title: 'Undo this import',
        subtitle: esc(p.filename || 'roster') + ', ' + esc(when(p.createdAt)),
        confirm: 'Undo the import',
        danger: true,
        body:
          '<div class="stat-row" style="margin-bottom:1rem">' +
            '<div class="card stat"><div class="n">' + p.plan.usersToRemove + '</div><div class="k">Accounts removed</div></div>' +
            '<div class="card stat"><div class="n">' + p.plan.membershipsToRevert + '</div><div class="k">Roles put back</div></div>' +
            '<div class="card stat"><div class="n">' + p.plan.classMembershipsToUndo + '</div><div class="k">Class changes</div></div>' +
          '</div>' +
          (kept.length
            ? '<div class="notice notice-warn"><strong>' + kept.length + ' account' +
              (kept.length === 1 ? ' is' : 's are') + ' being kept</strong>' +
              'These have been signed in to since the import, so they belong to real people now and will not be deleted. ' +
              'Remove them from the People page if that is genuinely what you want.' +
              '<div class="small" style="margin-top:.35rem">' +
              kept.slice(0, 10).map(function (e) { return esc(e); }).join('<br>') +
              (kept.length > 10 ? '<br>and ' + (kept.length - 10) + ' more' : '') + '</div></div>'
            : '') +
          '<div class="notice notice-info"><strong>What this does</strong>' +
          'Puts back the values this import changed, and removes the accounts it created. ' +
          'Anything done since by other means is left alone.</div>',
        onConfirm: function (m, close) {
          return api('/roster/imports/' + importId + '/undo', { method: 'POST', body: { tenant_id: state.tenantId } })
            .then(function (r) {
              toast(r.usersRemoved + ' removed, ' + p.plan.membershipsToRevert + ' put back' +
                (r.keptBecauseTheySignedIn.length ? ', ' + r.keptBecauseTheySignedIn.length + ' kept' : '') + '.');
              close();
              setPage('backups');
            });
        },
      });
    })
    .catch(function (e) { toast(e.message, true); });
}

function restoreDialog() {
  let file = null;
  let preview = null;

  modal({
    title: 'Restore from a backup',
    subtitle: 'Nothing changes until you have seen what it would do.',
    confirm: 'Check the file',
    danger: true,
    body:
      '<div class="dropzone" id="rdrop">' +
        '<div id="rdropLabel"><strong>Choose a backup file</strong>' +
        '<div class="small muted">the .json file you downloaded from here</div></div>' +
        '<input type="file" id="rfile" accept=".json,application/json" hidden>' +
      '</div>' +
      '<div class="notice notice-warn" style="margin-top:1rem"><strong>A backup is not a rollback</strong>' +
      'Restoring puts back what the file contains. It does not undo anything done since. ' +
      'A record erased at someone’s request stays erased.</div>',
    onOpen: function (root) {
      const drop = root.querySelector('#rdrop');
      const input = root.querySelector('#rfile');
      function take(f) {
        if (!f) return;
        const reader = new FileReader();
        reader.onload = function () {
          try { file = JSON.parse(String(reader.result || '')); }
          catch (e) { toast('That file is not readable JSON.', true); return; }
          drop.classList.add('has-file');
          root.querySelector('#rdropLabel').innerHTML =
            '<strong>' + esc(f.name) + '</strong><div class="small muted">ready to check</div>';
        };
        reader.readAsText(f);
      }
      drop.onclick = function () { input.click(); };
      input.onchange = function () { take(this.files[0]); };
      drop.ondragover = function (e) { e.preventDefault(); };
      drop.ondrop = function (e) { e.preventDefault(); take(e.dataTransfer.files[0]); };
    },
    onConfirm: function (root, close) {
      if (!preview) {
        if (!file) { toast('Choose a file first.', true); return true; }
        return api('/restore/preview', { method: 'POST', body: { file: file, tenant_id: state.tenantId } })
          .then(function (p) {
            preview = p;
            renderRestorePreview(root, p);
            return true;
          });
      }
      const typed = root.querySelector('#r_confirm');
      const ack = root.querySelector('#r_ack');
      return api('/restore/apply', { method: 'POST', body: {
        file: file,
        tenant_id: state.tenantId,
        confirm_name: typed ? typed.value : '',
        acknowledge_stale: ack ? ack.checked : false,
      } }).then(function (r) {
        toast(r.usersCreated + ' restored, ' + r.usersUpdated + ' updated' +
          (r.refusals.length ? ', ' + r.refusals.length + ' refused' : '') + '.');
        close();
        setPage('backups');
      });
    },
  });

  function renderRestorePreview(root, p) {
    const refusals = p.refusals.length
      ? '<div class="notice notice-warn"><strong>' + p.refusals.length +
        ' thing' + (p.refusals.length === 1 ? '' : 's') + ' will not be restored</strong>' +
        '<div class="small" style="margin-top:.35rem">' +
        p.refusals.slice(0, 12).map(function (r) { return esc(r); }).join('<br>') +
        (p.refusals.length > 12 ? '<br>and ' + (p.refusals.length - 12) + ' more' : '') +
        '</div></div>'
      : '';

    root.querySelector('.modal-body').innerHTML =
      '<p class="small">Taken from <strong>' + esc(p.tenantName) + '</strong> on ' +
      esc(new Date(p.takenAt).toLocaleString()) + '.</p>' +
      '<div class="stat-row" style="margin-bottom:1rem">' +
        '<div class="card stat"><div class="n">' + p.plan.usersCreate.length + '</div><div class="k">People to restore</div></div>' +
        '<div class="card stat"><div class="n">' + p.plan.usersUpdate.length + '</div><div class="k">People to update</div></div>' +
        '<div class="card stat"><div class="n">' + p.plan.classesCreate.length + '</div><div class="k">Classes to restore</div></div>' +
      '</div>' + refusals +
      p.notes.map(function (n) {
        return '<div class="notice notice-info"><strong>Note</strong>' + esc(n) + '</div>';
      }).join('');

    const btn = root.querySelector('[data-confirm]');
    const total = p.plan.usersCreate.length + p.plan.usersUpdate.length + p.plan.classesCreate.length;

    // Typed confirmation, and an explicit acknowledgement for an old file.
    // Both are enforced server-side too; these are the visible half.
    const gate = document.createElement('div');
    gate.innerHTML =
      (p.stale
        ? '<div class="notice notice-warn"><strong>This backup is ' + esc(p.ageDays) + ' days old</strong>' +
          'Anything done since would be overwritten with what it contains.' +
          (p.needsStaleAcknowledgement
            ? '<label style="display:flex;gap:.5rem;align-items:center;font-weight:500;margin-top:.5rem">' +
              '<input type="checkbox" id="r_ack"> I mean to restore a file this old</label>'
            : '') +
          '</div>'
        : '') +
      (p.takenBy
        ? '<p class="small muted">Taken by ' + esc(p.takenBy.email) + '.</p>'
        : '') +
      '<div class="field"><label for="r_confirm">Type <strong>' + esc(p.tenantName) + '</strong> to confirm</label>' +
      '<input id="r_confirm" type="text" autocomplete="off" placeholder="' + esc(p.tenantName) + '"></div>';
    root.querySelector('.modal-body').appendChild(gate);

    const typed = root.querySelector('#r_confirm');
    const ack = root.querySelector('#r_ack');
    const sync = function () {
      const nameOk = typed.value.trim().toLowerCase() === String(p.tenantName).trim().toLowerCase();
      btn.disabled = !total || !nameOk || (ack ? !ack.checked : false);
    };
    typed.oninput = sync;
    if (ack) ack.onchange = sync;

    btn.textContent = total ? 'Restore ' + total + ' record' + (total === 1 ? '' : 's') : 'Nothing to restore';
    sync();
  }
}


// ---------- people waiting for an account ----------

// What someone said about themselves when they asked. Folded away so a long
// list of requests stays scannable; a line a person skipped is left out.
function requestAnswers(a) {
  function line(label, value) {
    if (!value || (Array.isArray(value) && !value.length)) return '';
    return '<dt>' + esc(label) + '</dt><dd>' + esc(Array.isArray(value) ? value.join(', ') : value) + '</dd>';
  }
  return '<details class="answers"><summary>Answers</summary><dl>' +
    line('Describes themselves as', a.respondentLabel) +
    line('Interested in', a.apps) +
    line('Was opening', a.cameFrom) +
    line('School', a.school) +
    line('Job title', a.jobTitle) +
    line('School uses', a.googleAccounts) +
    line('Who would use it', a.usageScope) +
    line('Students', a.studentCount) +
    line('Wants to start', a.startWhen) +
    line('Subjects', a.subjects) +
    line('Grade levels', a.gradeLevels) +
    line('Heard about Signify.one from', a.heardFrom) +
    '</dl></details>';
}

// ---------- problem reports ----------
// Everything people have flagged with "Report a problem", from every app. A
// super admin sees all of it; a local admin with core:triage_reports sees
// their own school's. The server decides that — this only draws it.

var REPORT_STATUS = {
  new:           { label: 'New',            chip: 'chip-blue' },
  investigating: { label: 'Looking into it', chip: 'chip-yellow' },
  fixed:         { label: 'Fixed',          chip: 'chip-green' },
  wont_fix:      { label: 'Won’t fix',  chip: 'chip-grey' },
  duplicate:     { label: 'Duplicate',      chip: 'chip-grey' },
};
var REPORT_KIND = {
  bug:     { label: 'Not working',    chip: 'chip-red' },
  mistake: { label: 'Something wrong', chip: 'chip-yellow' },
  other:   { label: 'Other',          chip: 'chip-grey' },
};

function reportChip(map, key) {
  var m = map[key] || { label: key, chip: 'chip-grey' };
  return '<span class="chip ' + m.chip + '">' + esc(m.label) + '</span>';
}

function reportBadge(count) {
  var btn = document.querySelector('#nav button[data-page="reports"]');
  if (!btn) return;
  var badge = btn.querySelector('.nav-count');
  if (!count) { if (badge) badge.remove(); btn.removeAttribute('aria-label'); return; }
  if (!badge) { badge = document.createElement('span'); badge.className = 'nav-count'; btn.appendChild(badge); }
  badge.textContent = count;
  btn.setAttribute('aria-label', 'Problem reports, ' + count + ' new');
}

function refreshReportBadge() {
  if (!can('core:triage_reports', 'tenant')) return Promise.resolve();
  return api('/reports/summary').then(function (d) { reportBadge(d.new); }).catch(function () {});
}

// Runs once the console knows who is looking.
function initReports() {
  var btn = document.querySelector('#nav button[data-page="reports"]');
  if (btn) btn.hidden = !can('core:triage_reports', 'tenant');
  var own = document.getElementById('reportOwn');
  if (own) own.onclick = function () {
    if (window.SignifyReport) window.SignifyReport.open();
    else toast('The report form did not load. Reload the page and try again.', true);
  };
  refreshReportBadge();
}

function reportDetail(r) {
  var c = r.context || {};
  var row = function (label, value) {
    return value ? '<dt>' + esc(label) + '</dt><dd>' + value + '</dd>' : '';
  };
  var page = /^https?:\/\//.test(r.page_url || '')
    ? '<a href="' + esc(r.page_url) + '" target="_blank" rel="noopener noreferrer">' + esc(r.page_url) + '</a>'
    : '';
  var errors = (c.errors || []).map(function (e) {
    var where = e.source ? ' <span class="muted">' + esc(e.source) + (e.line != null ? ':' + esc(e.line) + (e.col != null ? ':' + esc(e.col) : '') : '') + '</span>' : '';
    return '<li><span class="code">' + esc(e.message) + '</span>' + where + '</li>';
  }).join('');

  return '<div class="report-msg">' + esc(r.message) + '</div>' +
    '<dl class="report-meta">' +
      row('Reference', '<span class="code">' + esc(r.ref) + '</span>') +
      row('Sent', esc(new Date(r.created_at).toLocaleString())) +
      row('From', esc(r.reporter_name || 'An erased account') +
        (r.reporter_email ? ' <span class="muted">&lt;' + esc(r.reporter_email) + '&gt;</span>' : '')) +
      row('School', esc(r.tenant_name || '')) +
      row('App', esc(r.app_name)) +
      row('Page', page) +
      row('Highlighted', c.selection ? '<q>' + esc(c.selection) + '</q>' : '') +
      row('Browser', esc(c.userAgent || '')) +
      row('Screen', esc([c.viewport && ('window ' + c.viewport), c.screen && ('screen ' + c.screen)].filter(Boolean).join(', '))) +
      row('Language', esc([c.language, c.timezone].filter(Boolean).join(' · '))) +
      row('Errors', errors ? '<ol class="report-errors">' + errors + '</ol>' : '') +
    '</dl>' +
    (!c.userAgent && !errors ? '<p class="small muted">No technical details were included.</p>' : '') +
    '<div class="field"><label for="rp_status">Status</label><select id="rp_status">' +
      Object.keys(REPORT_STATUS).map(function (k) {
        return '<option value="' + k + '"' + (k === r.status ? ' selected' : '') + '>' + esc(REPORT_STATUS[k].label) + '</option>';
      }).join('') +
    '</select></div>' +
    '<div class="field"><label for="rp_note">Note <span class="muted small">(for administrators only)</span></label>' +
      '<textarea id="rp_note" rows="3" maxlength="2000" placeholder="What was done, or why not.">' + esc(r.resolution || '') + '</textarea></div>' +
    (r.closed_at ? '<p class="small muted">Closed ' + esc(when(r.closed_at)) + (r.closed_by_name ? ' by ' + esc(r.closed_by_name) : '') + '.</p>' : '');
}

pages.reports = function () {
  if (!can('core:triage_reports', 'tenant')) {
    document.getElementById('main').innerHTML =
      head('Problem reports', 'What people have flagged from inside the apps.') +
      '<div class="notice notice-info"><strong>Not part of your role</strong>' +
      'Reading problem reports needs the “Read and close problem reports” permission.</div>';
    return Promise.resolve();
  }

  var f = state.cache.reportFilter || (state.cache.reportFilter = { status: 'open', kind: '', app: '' });
  var q = [];
  if (state.tenantId) q.push('tenant_id=' + encodeURIComponent(state.tenantId));
  if (f.status) q.push('status=' + encodeURIComponent(f.status));
  if (f.kind) q.push('kind=' + encodeURIComponent(f.kind));
  if (f.app) q.push('app=' + encodeURIComponent(f.app));

  return api('/reports' + (q.length ? '?' + q.join('&') : '')).then(function (d) {
    var byId = {};
    var rows = d.reports.map(function (r) {
      byId[r.id] = r;
      return '<tr class="clickable" data-id="' + esc(r.id) + '" tabindex="0">' +
        '<td class="muted small" style="white-space:nowrap">' + esc(when(r.created_at)) + '</td>' +
        '<td>' + reportChip(REPORT_KIND, r.kind) + '</td>' +
        '<td><div class="report-snippet">' + esc(r.message) + '</div>' +
          '<div class="small muted">' + esc(r.app_name) +
            (r.tenant_name && !state.tenantId ? ' · ' + esc(r.tenant_name) : '') + '</div></td>' +
        '<td class="small">' + esc(r.reporter_name || '—') + '</td>' +
        '<td>' + reportChip(REPORT_STATUS, r.status) + '</td>' +
      '</tr>';
    }).join('') || '<tr><td colspan="5" class="empty">' +
      (f.status === 'open' ? 'Nothing open. Everything reported has been dealt with.' : 'No reports match.') + '</td></tr>';

    var opt = function (value, label, current) {
      return '<option value="' + esc(value) + '"' + (value === current ? ' selected' : '') + '>' + esc(label) + '</option>';
    };

    document.getElementById('main').innerHTML =
      head('Problem reports', 'What people have flagged with “Report a problem”, from every app. Closed reports are erased 180 days after closing.') +
      '<div class="toolbar">' +
        '<select id="rfStatus" aria-label="Status" style="width:auto">' +
          opt('open', 'Open', f.status) + opt('new', 'New', f.status) + opt('investigating', 'Looking into it', f.status) +
          opt('fixed', 'Fixed', f.status) + opt('wont_fix', 'Won’t fix', f.status) + opt('duplicate', 'Duplicate', f.status) +
          opt('', 'Everything', f.status) +
        '</select>' +
        '<select id="rfKind" aria-label="Kind" style="width:auto">' +
          opt('', 'Any kind', f.kind) + opt('bug', 'Not working', f.kind) + opt('mistake', 'Something wrong', f.kind) + opt('other', 'Other', f.kind) +
        '</select>' +
        '<select id="rfApp" aria-label="App" style="width:auto">' + opt('', 'Every app', f.app) +
          d.apps.map(function (a) { return opt(a, a, f.app); }).join('') +
        '</select>' +
      '</div>' +
      '<div class="card"><div class="table-wrap"><table><thead><tr>' +
        '<th>When</th><th>Kind</th><th>What they said</th><th>From</th><th>Status</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div></div>';

    ['rfStatus', 'rfKind', 'rfApp'].forEach(function (id, i) {
      document.getElementById(id).onchange = function () {
        f[['status', 'kind', 'app'][i]] = this.value;
        setPage('reports');
      };
    });

    function openReport(r) {
      modal({
        title: (REPORT_KIND[r.kind] || {}).label || 'Report',
        subtitle: r.app_name + ' · ' + when(r.created_at),
        confirm: 'Save',
        body: reportDetail(r),
        onConfirm: function (m) {
          return api('/reports/' + encodeURIComponent(r.id), { method: 'PATCH', body: {
            status: m.querySelector('#rp_status').value,
            resolution: m.querySelector('#rp_note').value,
          } }).then(function () {
            toast('Report ' + r.ref + ' updated.');
            refreshReportBadge();
            setPage('reports');
          });
        },
      });
      // A new report that has been opened has been seen. Moving it on is one
      // less thing to remember, and it can still be set back.
      if (r.status === 'new') {
        var sel = document.querySelector('#rp_status');
        if (sel) sel.value = 'investigating';
      }
    }

    Array.prototype.forEach.call(document.querySelectorAll('tr[data-id]'), function (tr) {
      var go = function () { openReport(byId[tr.dataset.id]); };
      tr.onclick = go;
      tr.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
    });
  });
};

// ---------- new account requests ----------
// When a super admin opens the console and someone has asked for an account
// since they last looked, a card says so and the Requests button carries a
// count. The card can be put off; the count stays until the page is opened.
function requestBadge(count) {
  var btn = document.querySelector('#nav button[data-page="requests"]');
  if (!btn) return;
  var badge = btn.querySelector('.nav-count');
  if (!count) {
    if (badge) badge.remove();
    btn.removeAttribute('aria-label');
    return;
  }
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'nav-count';
    btn.appendChild(badge);
  }
  badge.textContent = count;
  btn.setAttribute('aria-label', 'Requests, ' + count + ' new');
}

function announceNewRequests(count) {
  requestBadge(count);
  var root = document.getElementById('noticeRoot');
  root.innerHTML =
    '<div class="notify" role="status">' +
      '<div class="notify-title">' + (count === 1 ? 'A new account request' : esc(count) + ' new account requests') + '</div>' +
      '<div class="small muted">' + (count === 1 ? 'Someone has' : 'People have') +
        ' asked for an account since you last looked.</div>' +
      '<div class="notify-actions">' +
        '<button class="btn btn-sm btn-primary" data-review>Review</button>' +
        '<button class="btn btn-sm btn-quiet" data-later>Later</button>' +
      '</div>' +
    '</div>';
  root.querySelector('[data-review]').onclick = function () { root.innerHTML = ''; setPage('requests'); };
  root.querySelector('[data-later]').onclick = function () { root.innerHTML = ''; };
}

pages.requests = function () {
  if (!state.actor.isSuper) {
    document.getElementById('main').innerHTML =
      head('Requests', 'People asking for an account.') +
      '<div class="notice notice-info"><strong>For super admins</strong>' +
      'Deciding which school someone belongs to is not a question one school’s ' +
      'administrator should answer, so these are handled at platform level.</div>';
    return Promise.resolve();
  }

  return Promise.all([
    api('/requests'),
    api('/unassigned'),
    api('/tenants'),
    api('/roles'),
  ]).then(function (r) {
    // Looking at the page is what the notice was asking for.
    requestBadge(0);
    document.getElementById('noticeRoot').innerHTML = '';

    var requests = r[0].requests;
    var unassigned = r[1].users;
    var tenants = r[2].tenants;
    var roles = r[3].roles.filter(function (x) { return !x.is_admin || state.actor.isSuper; });

    var open = requests.filter(function (q) { return q.status === 'pending'; });
    var decided = requests.filter(function (q) { return q.status !== 'pending'; });

    var openRows = open.map(function (q) {
      var a = q.answers || {};
      var summary = a.answered
        ? esc([a.jobTitle, a.school].filter(Boolean).join(' \u00b7 '))
        : '<span class="faint">Has not answered the questions yet' +
          (a.cameFrom ? ' \u00b7 was opening ' + esc(a.cameFrom) : '') + '</span>';
      return '<tr data-req="' + esc(q.id) + '" style="vertical-align:top">' +
        '<td><div style="font-weight:550">' + esc(q.display_name || q.email) +
          (a.respondent === 'student' ? ' <span class="chip chip-red">Says they are a student</span>' : '') +
          (a.googleAccountsKey === 'microsoft' ? ' <span class="chip chip-yellow">Microsoft school</span>' : '') + '</div>' +
        '<div class="small muted">' + esc(q.email) + '</div>' +
        '<div class="small" style="margin-top:.2rem">' + summary + '</div>' +
        (a.answered ? requestAnswers(a) : '') + '</td>' +
        '<td class="muted small">' + esc(when(q.requested_at)) + '</td>' +
        '<td class="muted small">' + esc(q.attempts) + ' attempt' + (Number(q.attempts) === 1 ? '' : 's') + '</td>' +
        '<td style="text-align:right;white-space:nowrap">' +
          '<button class="btn btn-sm btn-primary" data-approve>Approve</button> ' +
          '<button class="btn btn-sm btn-quiet" data-decline>Decline</button>' +
        '</td></tr>';
    }).join('') || '<tr><td colspan="4" class="empty">Nobody is waiting.</td></tr>';

    var decidedRows = decided.slice(0, 20).map(function (q) {
      return '<tr><td>' + esc(q.display_name || q.email) + '<div class="small muted">' + esc(q.email) + '</div></td>' +
        '<td>' + (q.status === 'approved'
          ? '<span class="chip chip-green">Approved</span>'
          : '<span class="chip chip-grey">Declined</span>') + '</td>' +
        '<td class="small muted">' + esc(q.tenant_name || '—') + '</td>' +
        '<td class="small muted">' + esc(q.decided_by_email || '') + ' · ' + esc(when(q.decided_at)) + '</td></tr>';
    }).join('') || '<tr><td colspan="4" class="muted">Nothing decided yet.</td></tr>';

    // Accounts that exist but belong to no school. Super admins have no
    // membership by design, so they are expected to be in here.
    var unRows = unassigned.map(function (u) {
      var why = u.is_super ? '<span class="chip chip-red">Super admin</span>'
        : u.request_status === 'pending' ? '<span class="chip chip-yellow">Waiting</span>'
        : u.request_status === 'declined' ? '<span class="chip chip-grey">Declined</span>'
        : Number(u.identities) ? '<span class="chip chip-yellow">No school</span>'
        : '<span class="chip chip-grey">Never signed in</span>';
      return '<tr data-user="' + esc(u.id) + '">' +
        '<td><div style="font-weight:550">' + esc(u.display_name) + '</div>' +
        '<div class="small muted">' + esc(u.email) + '</div></td>' +
        '<td>' + why + '</td>' +
        '<td class="muted small">' + esc(when(u.last_seen_at)) + '</td>' +
        '<td style="text-align:right">' +
          (u.is_super ? '' : '<button class="btn btn-sm" data-assign>Add to a school</button>') +
        '</td></tr>';
    }).join('') || '<tr><td colspan="4" class="empty">Everyone belongs to a school.</td></tr>';

    document.getElementById('main').innerHTML =
      head('Requests', 'People who have tried to sign in but belong to no school yet, and accounts that are not attached to one.') +
      '<div class="card"><div class="card-head"><h2>Waiting for a decision</h2>' +
      (open.length ? '<span class="chip chip-yellow">' + open.length + '</span>' : '') + '</div>' +
      '<div class="table-wrap"><table><thead><tr>' +
      '<th>Who</th><th>First asked</th><th></th><th></th>' +
      '</tr></thead><tbody>' + openRows + '</tbody></table></div></div>' +

      '<div class="card"><div class="card-head"><h2>Not in any school</h2><div class="spacer"></div>' +
      '<span class="small muted">super admins belong to none by design</span></div>' +
      '<div class="table-wrap"><table><thead><tr>' +
      '<th>Who</th><th></th><th>Last seen</th><th></th>' +
      '</tr></thead><tbody>' + unRows + '</tbody></table></div></div>' +

      '<div class="card"><div class="card-head"><h2>Already decided</h2></div>' +
      '<div class="table-wrap"><table><thead><tr>' +
      '<th>Who</th><th></th><th>School</th><th>By</th>' +
      '</tr></thead><tbody>' + decidedRows + '</tbody></table></div></div>';

    function admitDialog(title, onSubmit) {
      modal({
        title: title,
        subtitle: 'Choose the school they belong to (Independent if they are at none) and what they may do there.',
        confirm: 'Add to school',
        body:
          '<div class="row">' +
            '<div class="field"><label for="a_tenant">School</label><select id="a_tenant">' +
            tenants.map(function (t) { return '<option value="' + esc(t.id) + '">' + esc(tenantLabel(t)) + '</option>'; }).join('') +
            '</select></div>' +
            '<div class="field"><label for="a_role">Role</label><select id="a_role">' +
            roles.map(function (x) { return '<option value="' + esc(x.id) + '"' + (x.key === 'student' ? ' selected' : '') + '>' + esc(x.label) + '</option>'; }).join('') +
            '</select></div>' +
          '</div>' +
          '<div class="field"><label for="a_note">Note</label><input id="a_note" type="text" placeholder="Why, for the record">' +
          '<div class="hint">The reason only \u2014 no addresses, phone numbers or other personal details. The privacy policy says none are asked for, and this is one of the few places somebody could type one anyway.</div>' + '</div>',
        onConfirm: function (m) {
          return onSubmit({
            tenant_id: m.querySelector('#a_tenant').value,
            role_id: m.querySelector('#a_role').value,
            note: m.querySelector('#a_note').value,
          });
        },
      });
    }

    Array.prototype.forEach.call(document.querySelectorAll('[data-approve]'), function (b) {
      b.onclick = function () {
        var id = b.closest('tr').dataset.req;
        var q = open.filter(function (x) { return x.id === id; })[0];
        admitDialog('Approve ' + (q.display_name || q.email), function (body) {
          return api('/requests/' + id + '/approve', { method: 'POST', body: body })
            .then(function () { toast('Approved.'); setPage('requests'); });
        });
      };
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-decline]'), function (b) {
      b.onclick = function () {
        var id = b.closest('tr').dataset.req;
        if (!window.confirm('Decline this request? They will keep seeing "waiting for approval" until somebody decides otherwise.')) return;
        api('/requests/' + id + '/decline', { method: 'POST', body: {} })
          .then(function () { toast('Declined.'); setPage('requests'); })
          .catch(function (e) { toast(e.message, true); });
      };
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-assign]'), function (b) {
      b.onclick = function () {
        var id = b.closest('tr').dataset.user;
        var u = unassigned.filter(function (x) { return x.id === id; })[0];
        admitDialog('Add ' + u.display_name + ' to a school', function (body) {
          return api('/users', { method: 'POST', body: {
            email: u.email, name: u.display_name,
            role_id: body.role_id, tenant_id: body.tenant_id,
          } }).then(function () { toast('Added.'); setPage('requests'); });
        });
      };
    });
  });
};

// ---------- merging two accounts ----------

function mergeDialog(keepUser, allUsers) {
  var others = allUsers.filter(function (u) {
    return u.id !== keepUser.id && !u.is_super;
  });

  modal({
    title: 'Merge another account into ' + keepUser.display_name,
    subtitle: 'For somebody who ended up with two — a personal address and a school one, say.',
    confirm: 'Check the merge',
    danger: true,
    body:
      '<div class="field"><label for="mg_from">Account to merge away</label>' +
      '<select id="mg_from"><option value="">Choose…</option>' +
      others.map(function (u) {
        return '<option value="' + esc(u.id) + '">' + esc(u.display_name) + ' — ' + esc(u.email) + '</option>';
      }).join('') + '</select>' +
      '<div class="hint">Everything it owns moves to <strong>' + esc(keepUser.email) + '</strong>, and it is deleted.</div></div>' +
      '<div class="notice notice-warn"><strong>This cannot be undone</strong>' +
      'Two records become one. Which was which is not recoverable afterwards.</div>',
    onConfirm: function (root, close) {
      var fromId = root.querySelector('#mg_from') && root.querySelector('#mg_from').value;
      if (!root.dataset.previewed) {
        if (!fromId) { toast('Choose an account to merge away.', true); return true; }
        return api('/users/' + keepUser.id + '/merge-preview', { method: 'POST', body: { from_id: fromId } })
          .then(function (p) {
            root.dataset.previewed = '1';
            root.dataset.fromId = fromId;
            var moving = Object.keys(p.moving).length
              ? '<ul class="small">' + Object.keys(p.moving).map(function (k) {
                  return '<li>' + esc(k.replace(/_/g, ' ').replace('.', ' → ')) + ': ' + esc(p.moving[k]) + '</li>';
                }).join('') + '</ul>'
              : '<p class="small muted">Nothing much to move.</p>';
            root.querySelector('.modal-body').innerHTML =
              '<p class="small">Keeping <strong>' + esc(p.keep.email) + '</strong>, merging away <strong>' + esc(p.from.email) + '</strong>.</p>' +
              (p.membershipsMoved.length ? '<p class="small">Schools moving across: ' + esc(p.membershipsMoved.join(', ')) + '</p>' : '') +
              (p.membershipsDropped.length ? '<p class="small muted">Already in, so dropped: ' + esc(p.membershipsDropped.join(', ')) + '</p>' : '') +
              (p.classesMoved ? '<p class="small">' + esc(p.classesMoved) + ' class place(s) move across.</p>' : '') +
              moving +
              p.warnings.map(function (w) {
                return '<div class="notice notice-warn"><strong>Note</strong>' + esc(w) + '</div>';
              }).join('') +
              '<div class="field"><label for="mg_confirm">Type <strong>' + esc(p.from.email) + '</strong> to confirm</label>' +
              '<input id="mg_confirm" type="text" autocomplete="off"></div>';
            var btn = root.querySelector('[data-confirm]');
            btn.textContent = 'Merge and delete the other account';
            btn.disabled = true;
            root.querySelector('#mg_confirm').oninput = function () {
              btn.disabled = this.value.trim().toLowerCase() !== p.from.email.toLowerCase();
            };
            return true;
          });
      }

      return api('/users/' + keepUser.id + '/merge', { method: 'POST', body: {
        from_id: root.dataset.fromId,
        confirm_email: root.querySelector('#mg_confirm').value,
      } }).then(function (r) {
        toast('Merged. ' + r.mergedEmail + ' now reaches ' + r.keptEmail + '.');
        close();
        setPage('users');
      });
    },
  });
}

// ---------- whiteboard ----------
// The whiteboard's own admin tools — classrooms, template approvals,
// school-wide feature switches and monitoring. Its data stays in the
// whiteboard; every call here goes through /app-admin, which forwards it with
// a token for the person signed in (see src/app-admin.js). The whiteboard
// applies its usual permission checks, so this page offers only what the
// whiteboard reports this person may do.

function wbApp() {
  return (state.appAdmin || []).filter(function (a) { return a.namespace === 'whiteboard'; })[0] || null;
}

function wbApi(path, options) {
  var app = wbApp();
  if (!app) return Promise.reject(new Error('The whiteboard is not available to you here.'));
  return api('/app-admin/' + encodeURIComponent(app.clientId) + path, options);
}

var WB_FEATURES = {
  draw: 'Drawing', text: 'Text', images: 'Images', documents: 'Documents (PDF, Word, slides)',
  charts: 'Charts & graphs', newBoards: 'Making new boards', download: 'Downloading boards',
  embed: 'Publishing boards to the web',
};

function wbCan(d, perm) { return !!d.me && (d.me.isSuper || d.me.perms.indexOf(perm) >= 0); }

function wbThumb(src) {
  return src
    ? '<img class="wb-thumb" alt="" src="' + esc(src) + '">'
    : '<div class="wb-thumb wb-thumb-empty">No drawing yet</div>';
}

// Boards open in the whiteboard itself: it has the drawing engine, and admins
// may already view boards in their own school there.
function wbOpenLink(boardId) {
  var app = wbApp();
  return '<a class="btn btn-sm" target="_blank" rel="noopener" href="' +
    esc(app.url + '/board.html?board=' + encodeURIComponent(boardId)) + '">Open ↗</a>';
}

function wbBoardGrid(boards, empty) {
  if (!boards.length) return '<p class="muted">' + esc(empty) + '</p>';
  return '<div class="wb-grid">' + boards.map(function (b) {
    return '<div class="wb-card">' + wbThumb(b.thumb) +
      '<div class="wb-card-body"><div class="wb-card-title">' + esc(b.title || 'Board') + '</div>' +
      '<div class="small muted">' + esc(b.sub || '') + '</div>' +
      (b.canView === false ? '<div class="small faint">Outside your school</div>' : wbOpenLink(b.id)) +
      '</div></div>';
  }).join('') + '</div>';
}

pages.whiteboard = function () {
  if (!wbApp()) {
    document.getElementById('main').innerHTML =
      head('Whiteboard', 'Classrooms, templates, feature switches and monitoring for the whiteboard.') +
      '<div class="notice notice-info"><strong>Not part of your role</strong>' +
      'The whiteboard’s admin tools need one of its admin permissions, and the whiteboard turned on for your school.</div>';
    return Promise.resolve();
  }
  return wbApi('/api/admin/state').then(function (d) {
    state.cache.wb = d;
    var tabs = [];
    if (wbCan(d, 'manage_boards')) tabs.push(['classrooms', 'Classrooms']);
    if (wbCan(d, 'manage_boards') || d.templatesPending.length) tabs.push(['templates', 'Templates']);
    if (wbCan(d, 'manage_users')) tabs.push(['features', 'Feature switches']);
    if (wbCan(d, 'view_sessions')) tabs.push(['monitoring', 'Monitoring']);
    if (!tabs.length) {
      document.getElementById('main').innerHTML =
        head('Whiteboard', 'The whiteboard’s admin tools.') +
        '<div class="notice notice-info"><strong>Nothing to manage</strong>' +
        'Your role does not include any of the whiteboard’s admin permissions.</div>';
      return;
    }
    var tab = state.cache.wbTab;
    if (!tabs.some(function (t) { return t[0] === tab; })) tab = state.cache.wbTab = tabs[0][0];

    document.getElementById('main').innerHTML =
      head('Whiteboard', (d.me.isSuper ? 'Every school. ' : '') +
        'The whiteboard keeps this data; what you change here happens there straight away.') +
      '<div class="wb-tabs" role="tablist">' + tabs.map(function (t) {
        return '<button class="wb-tab' + (t[0] === tab ? ' active' : '') + '" role="tab" aria-selected="' +
          (t[0] === tab) + '" data-tab="' + t[0] + '">' + esc(t[1]) + '</button>';
      }).join('') + '</div>' +
      '<div id="wbBody"><div class="empty">Loading…</div></div>';

    Array.prototype.forEach.call(document.querySelectorAll('.wb-tab'), function (b) {
      b.onclick = function () { state.cache.wbTab = b.dataset.tab; setPage('whiteboard'); };
    });
    return wbTabs[tab](d);
  });
};

var wbTabs = {};

// ----- classrooms -----

wbTabs.classrooms = function (d) {
  var f = state.cache.wbRoomFilter || (state.cache.wbRoomFilter = { q: '', archived: false });
  var body = document.getElementById('wbBody');

  function render() {
    var q = f.q.trim().toLowerCase();
    var list = d.rooms.filter(function (r) {
      if (!!r.archived !== f.archived) return false;
      if (!q) return true;
      return [r.name, r.code, r.owner, r.ownerName].some(function (v) { return String(v || '').toLowerCase().indexOf(q) >= 0; });
    });
    var rows = list.map(function (r) {
      var chips = (r.idClassId ? '<span class="chip chip-blue">ID class</span> ' : '') +
        (r.teacherOnline ? '<span class="chip chip-green">Live</span> ' : '') +
        (r.archived ? '<span class="chip chip-grey">Archived</span>' : '');
      return '<tr data-code="' + esc(r.code) + '">' +
        '<td><div style="font-weight:600">' + esc(r.name || 'Class ' + r.code) + '</div>' +
          '<div class="small muted"><span class="code">' + esc(r.code) + '</span> ' + chips + '</div></td>' +
        '<td>' + esc(r.ownerName || r.owner || '—') + (r.ownerName && r.owner ? '<div class="small muted">' + esc(r.owner) + '</div>' : '') + '</td>' +
        '<td>' + esc(r.rosterCount) + '</td>' +
        '<td>' + esc(r.students) + '</td>' +
        '<td class="muted small">' + esc(when(r.updatedAt)) + '</td>' +
        '<td style="white-space:nowrap">' +
          '<button class="btn btn-sm" data-act="boards">Boards</button> ' +
          '<button class="btn btn-sm" data-act="edit">Edit</button> ' +
          '<button class="btn btn-sm btn-danger" data-act="delete">Delete</button>' +
        '</td></tr>';
    }).join('') || '<tr><td colspan="6" class="empty">' + (f.archived ? 'No archived classrooms.' : 'No classrooms match.') + '</td></tr>';

    body.innerHTML =
      '<div class="toolbar">' +
        '<input type="search" id="wbRoomQ" placeholder="Search by class, code or teacher" value="' + esc(f.q) + '">' +
        '<label class="small" style="display:flex;gap:.35rem;align-items:center"><input type="checkbox" id="wbRoomArch"' + (f.archived ? ' checked' : '') + '> Archived</label>' +
        '<span style="flex:1"></span>' +
        '<button class="btn btn-sm" id="wbFindBoards">Find someone’s boards</button>' +
        '<button class="btn btn-sm btn-primary" id="wbNewRoom">New classroom</button>' +
      '</div>' +
      '<p class="small muted" style="margin-top:-.5rem">Classes from Signify ID are set up automatically the first time their teacher opens the whiteboard.</p>' +
      '<div class="card"><div class="table-wrap"><table><thead><tr>' +
        '<th>Classroom</th><th>Teacher</th><th>Students</th><th>Boards</th><th>Last used</th><th></th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div></div>';

    var qIn = document.getElementById('wbRoomQ');
    qIn.oninput = function () {
      f.q = this.value;
      var pos = this.selectionStart;
      render();
      var again = document.getElementById('wbRoomQ');
      again.focus();
      again.setSelectionRange(pos, pos);
    };
    document.getElementById('wbRoomArch').onchange = function () { f.archived = this.checked; render(); };
    document.getElementById('wbNewRoom').onclick = newRoom;
    document.getElementById('wbFindBoards').onclick = findBoards;
    Array.prototype.forEach.call(body.querySelectorAll('tr[data-code]'), function (tr) {
      var room = d.rooms.filter(function (r) { return r.code === tr.dataset.code; })[0];
      Array.prototype.forEach.call(tr.querySelectorAll('[data-act]'), function (b) {
        b.onclick = function () { ({ boards: showBoards, edit: editRoom, delete: deleteRoom })[b.dataset.act](room); };
      });
    });
  }

  function showBoards(r) {
    wbApi('/api/admin/room/' + encodeURIComponent(r.code)).then(function (x) {
      var boards = x.boards.map(function (b) {
        return { id: b.id, title: b.title, thumb: b.thumb, canView: b.canView,
          sub: (b.ownerName || b.owner) + (b.isTeacher ? ' (teacher)' : '') + ' · ' + when(b.updatedAt) };
      });
      var m = modal({
        title: r.name || 'Class ' + r.code, subtitle: boards.length + ' board' + (boards.length === 1 ? '' : 's'),
        confirm: 'Done', body: wbBoardGrid(boards, 'No boards in this classroom yet.'),
        onConfirm: function () {},
      });
      m.root.classList.add('modal-wide');
      m.root.querySelector('[data-close]').hidden = true;
    }).catch(function (e) { toast(e.message, true); });
  }

  function editRoom(r) {
    modal({
      title: 'Edit classroom', subtitle: r.code,
      body:
        '<div class="field"><label for="wb_name">Name</label><input id="wb_name" maxlength="50" value="' + esc(r.name || '') + '"' + (r.idClassId ? ' disabled' : '') + '>' +
          (r.idClassId ? '<div class="small muted">This class comes from Signify ID; rename it on the Classes page and the whiteboard follows.</div>' : '') + '</div>' +
        '<div class="field"><label for="wb_owner">Teacher’s email address</label><input id="wb_owner" type="email" value="' + esc(r.owner || '') + '"></div>' +
        '<label class="small" style="display:flex;gap:.4rem;align-items:center"><input type="checkbox" id="wb_arch"' + (r.archived ? ' checked' : '') + '> Archived (hidden from students)</label>',
      onConfirm: function (m) {
        var body = { archived: m.querySelector('#wb_arch').checked };
        if (!r.idClassId) body.name = m.querySelector('#wb_name').value;
        var owner = m.querySelector('#wb_owner').value.trim().toLowerCase();
        if (owner && owner !== r.owner) body.owner = owner;
        return wbApi('/api/room/' + encodeURIComponent(r.code) + '/meta', { method: 'POST', body: body })
          .then(function () { toast('Classroom saved.'); setPage('whiteboard'); });
      },
    });
  }

  function deleteRoom(r) {
    modal({
      title: 'Delete ' + (r.name || r.code) + '?', danger: true, confirm: 'Delete classroom',
      body: '<div class="notice notice-danger"><strong>This cannot be undone</strong>Every board in this classroom, and its version history, is deleted. Archiving hides a class and keeps its boards.</div>' +
        '<div class="field"><label for="wb_confirm">Type the class code <span class="code">' + esc(r.code) + '</span> to confirm</label><input id="wb_confirm" autocomplete="off"></div>',
      onConfirm: function (m) {
        if (m.querySelector('#wb_confirm').value.trim().toUpperCase() !== r.code) {
          toast('Type the class code exactly to confirm.', true);
          return true; // keep the dialog open
        }
        return wbApi('/api/admin/room/' + encodeURIComponent(r.code), { method: 'DELETE' })
          .then(function () { toast('Classroom deleted.'); setPage('whiteboard'); });
      },
    });
  }

  function newRoom() {
    modal({
      title: 'New classroom',
      subtitle: 'For a group that isn’t a class in Signify ID. Classes in Signify ID are set up automatically.',
      confirm: 'Create',
      body:
        '<div class="field"><label for="wb_nname">Name</label><input id="wb_nname" maxlength="50" placeholder="e.g. Chess club"></div>' +
        '<div class="field"><label for="wb_nowner">Teacher’s email address</label><input id="wb_nowner" type="email" placeholder="Leave empty to own it yourself"></div>',
      onConfirm: function (m) {
        var name = m.querySelector('#wb_nname').value.trim();
        if (!name) { toast('Give the classroom a name.', true); return true; }
        var body = { name: name };
        var owner = m.querySelector('#wb_nowner').value.trim().toLowerCase();
        if (owner) body.owner = owner;
        return wbApi('/api/rooms/create', { method: 'POST', body: body })
          .then(function (x) { toast('Classroom ' + x.code + ' created.'); setPage('whiteboard'); });
      },
    });
  }

  function findBoards() {
    modal({
      title: 'Find someone’s boards', subtitle: 'Every board a person owns, in any classroom or on their own.', confirm: 'Find',
      body: '<div class="field"><label for="wb_femail">Email address</label><input id="wb_femail" type="email"></div><div id="wb_fout"></div>',
      onConfirm: function (m) {
        var email = m.querySelector('#wb_femail').value.trim().toLowerCase();
        if (!email) return true;
        return wbApi('/api/admin/user-boards/' + encodeURIComponent(email)).then(function (x) {
          m.classList.add('modal-wide');
          m.querySelector('#wb_fout').innerHTML = '<h3 style="margin:1rem 0 .5rem">' + esc(x.name || email) + '</h3>' +
            wbBoardGrid(x.boards.map(function (b) {
              return { id: b.id, title: b.title, thumb: b.thumb, sub: (b.roomName || 'Personal board') + ' · ' + when(b.updatedAt) };
            }), 'No boards.');
          return true; // stay open to show the result
        });
      },
    });
  }

  render();
};

// ----- templates -----

wbTabs.templates = function (d) {
  var body = document.getElementById('wbBody');
  var pending = d.templatesPending;
  var cards = pending.map(function (t) {
    return '<div class="wb-card" data-id="' + esc(t.id) + '">' + wbThumb(t.thumb) +
      '<div class="wb-card-body"><div class="wb-card-title">' + esc(t.title) + '</div>' +
      '<div class="small muted">' + esc(t.subject) + ' · ' + esc(t.scope === 'public' ? 'Public library' : 'School library') + '</div>' +
      '<div class="small muted">From ' + esc(t.ownerName || t.owner) + '</div>' +
      '<div style="display:flex;gap:.4rem;margin-top:.5rem">' +
        '<button class="btn btn-sm btn-primary" data-act="approve">Approve</button>' +
        '<button class="btn btn-sm" data-act="decline">Decline</button>' +
      '</div></div></div>';
  }).join('');

  body.innerHTML =
    (wbCan(d, 'manage_boards') && d.myDomain ?
      '<div class="card"><div class="card-body">' +
        '<label style="display:flex;gap:.5rem;align-items:flex-start"><input type="checkbox" id="wbOpen"' + (d.templateOpen ? ' checked' : '') + '>' +
        '<span><strong>Teachers at ' + esc(d.myDomain) + ' can publish to the school library without approval</strong>' +
        '<br><span class="small muted">Off: each template they share waits here for an admin.</span></span></label>' +
      '</div></div>' : '') +
    '<h2 style="margin:1.5rem 0 .75rem">Waiting for approval</h2>' +
    (pending.length ? '<div class="wb-grid">' + cards + '</div>' : '<p class="muted">Nothing waiting. Templates teachers submit appear here.</p>');

  var open = document.getElementById('wbOpen');
  if (open) {
    open.onchange = function () {
      var want = this.checked;
      wbApi('/api/admin/school-submit', { method: 'POST', body: { domain: d.myDomain, open: want } })
        .then(function () { toast(want ? 'Teachers can publish without approval.' : 'School templates now need approval.'); })
        .catch(function (e) { open.checked = !want; toast(e.message, true); });
    };
  }
  Array.prototype.forEach.call(body.querySelectorAll('.wb-card[data-id]'), function (card) {
    var t = pending.filter(function (x) { return x.id === card.dataset.id; })[0];
    card.querySelector('[data-act="approve"]').onclick = function () {
      wbApi('/api/templates/' + encodeURIComponent(t.id) + '/approve', { method: 'POST', body: {} })
        .then(function () { toast('“' + t.title + '” approved.'); setPage('whiteboard'); })
        .catch(function (e) { toast(e.message, true); });
    };
    card.querySelector('[data-act="decline"]').onclick = function () {
      modal({
        title: 'Decline “' + t.title + '”?', danger: true, confirm: 'Decline and remove',
        body: '<p>The submission is removed from the library. The teacher’s own boards are not affected.</p>',
        onConfirm: function () {
          return wbApi('/api/templates/' + encodeURIComponent(t.id), { method: 'DELETE' })
            .then(function () { toast('Declined.'); setPage('whiteboard'); });
        },
      });
    };
  });
};

// ----- school-wide feature switches -----

wbTabs.features = function (d) {
  var body = document.getElementById('wbBody');
  var domains = Object.keys(d.domainFeatures || {}).sort();
  if (!domains.length) {
    body.innerHTML = '<p class="muted">No school domains to manage yet.</p>';
    return;
  }
  body.innerHTML =
    '<p class="muted small">Turn a tool off for everyone at a school. Teachers can still turn tools off for a class or one student inside the whiteboard, but not back on past what is set here.</p>' +
    domains.map(function (domain) {
      var set = d.domainFeatures[domain] || {};
      return '<div class="card" data-domain="' + esc(domain) + '"><div class="card-head"><strong>' + esc(domain) + '</strong></div>' +
        '<div class="card-body"><div class="wb-feature-list">' +
        d.features.map(function (f) {
          var off = set[f] === false;
          return '<label class="wb-feature"><input type="checkbox" data-f="' + esc(f) + '"' + (off ? '' : ' checked') + '> ' +
            esc(WB_FEATURES[f] || f) + '</label>';
        }).join('') +
        '</div></div></div>';
    }).join('');

  Array.prototype.forEach.call(body.querySelectorAll('[data-domain]'), function (card) {
    var domain = card.dataset.domain;
    Array.prototype.forEach.call(card.querySelectorAll('[data-f]'), function (box) {
      box.onchange = function () {
        var patch = {};
        patch[box.dataset.f] = box.checked ? null : false; // on = no override
        var on = box.checked;
        wbApi('/api/admin/features', { method: 'POST', body: { domain: domain, features: patch } })
          .then(function (x) {
            d.domainFeatures[domain] = x.features;
            toast((WB_FEATURES[box.dataset.f] || box.dataset.f) + (on ? ' turned on' : ' turned off') + ' for ' + domain + '.');
          })
          .catch(function (e) { box.checked = !on; toast(e.message, true); });
      };
    });
  });
};

// ----- monitoring -----

wbTabs.monitoring = function (d) {
  var body = document.getElementById('wbBody');
  return Promise.all([wbApi('/api/admin/usage'), wbApi('/api/admin/audit')]).then(function (r) {
    var u = r[0];
    var stats = [
      ['Online now', u.online], ['Live classrooms', u.liveRooms], ['Classrooms', u.rooms],
      ['Boards', u.boards], ['Boards changed this week', u.boardsWeek], ['People', u.users],
      ['Active this week', u.activeWeek], ['Templates', u.templates],
    ];
    if (u.diskFreeMB != null) stats.push([u.diskLow ? 'Storage free (low)' : 'Storage free', u.diskFreeMB + ' MB']);

    var sessions = d.sessions.map(function (s) {
      return '<tr><td><span class="code">' + esc(s.room) + '</span></td><td>' + esc(s.name) +
        (s.email ? '<div class="small muted">' + esc(s.email) + '</div>' : '') + '</td>' +
        '<td>' + esc(s.role) + '</td><td class="muted small">' + esc(when(s.since)) + '</td></tr>';
    }).join('') || '<tr><td colspan="4" class="empty">Nobody is connected right now.</td></tr>';

    var audit = r[1].audit.map(function (a) {
      return '<tr><td class="muted small" style="white-space:nowrap">' + esc(when(a.ts || a.at)) + '</td>' +
        '<td>' + esc(a.actor) + '</td><td><span class="code">' + esc(a.action) + '</span></td>' +
        '<td class="small">' + esc(a.detail || a.target || '') + '</td></tr>';
    }).join('') || '<tr><td colspan="4" class="empty">Nothing recorded yet.</td></tr>';

    var app = wbApp();
    body.innerHTML =
      '<div class="stat-row">' + stats.map(function (s) {
        return '<div class="card stat"><div class="n">' + esc(s[1]) + '</div><div class="k">' + esc(s[0]) + '</div></div>';
      }).join('') + '</div>' +
      '<h2 style="margin:1.5rem 0 .75rem">Connected right now</h2>' +
      '<div class="card"><div class="table-wrap"><table><thead><tr><th>Class</th><th>Who</th><th>As</th><th>Since</th></tr></thead><tbody>' +
        sessions + '</tbody></table></div></div>' +
      '<h2 style="margin:1.5rem 0 .75rem">Recent admin actions in the whiteboard</h2>' +
      '<div class="card"><div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Detail</th></tr></thead><tbody>' +
        audit + '</tbody></table></div></div>' +
      (d.me.isSuper ?
        '<h2 style="margin:1.5rem 0 .75rem">Backup</h2>' +
        '<div class="card"><div class="card-body"><p class="muted small" style="margin-top:0">Everything the whiteboard stores, as one file. It holds pupils’ work, so keep it somewhere safe.</p>' +
        '<a class="btn" href="/api/admin/app-admin/' + esc(encodeURIComponent(app.clientId)) + '/api/admin/backup">Download whiteboard backup</a></div></div>' : '');
  });
};

// ---------- boot ----------

api('/bootstrap').then(function (d) {
  state.actor = d.actor;
  state.catalog = d.catalog;
  state.scopes = d.scopes;
  state.tenants = d.tenants;
  state.policyVersion = d.policyVersion;
  state.retentionDays = d.retentionDays;
  state.yearGroups = d.yearGroups || [];
  state.appAdmin = d.appAdmin || [];
  state.tenantId = d.actor.isSuper ? (d.tenants[0] ? d.tenants[0].id : null) : d.actor.tenantId;

  document.getElementById('whoName').textContent = d.actor.name;
  document.getElementById('whoEmail').textContent = d.actor.email;
  document.getElementById('whoRole').textContent = d.actor.roleLabel || 'No role';

  // A page that needs a permission this person does not hold is not offered.
  // data-needs may list alternatives ("a|b"), each optionally "perm@scope".
  Array.prototype.forEach.call(document.querySelectorAll('#nav [data-needs]'), function (el) {
    var ok = el.dataset.needs.split('|').some(function (n) {
      var parts = n.split('@');
      return can(parts[0], parts[1] || 'tenant');
    });
    if (!ok) el.hidden = true;
  });


  if (!d.actor.isSuper) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-super]'), function (el) { el.hidden = true; });
  } else if (d.tenants.length) {
    var wrap = document.getElementById('tenantPickerWrap');
    var sel = document.getElementById('tenantPicker');
    sel.innerHTML = d.tenants.map(function (t) {
      return '<option value="' + esc(t.id) + '">' + esc(tenantLabel(t)) + '</option>';
    }).join('');
    sel.value = state.tenantId;
    sel.onchange = function () { state.tenantId = this.value; setPage(state.page); };
    wrap.hidden = false;
  }

  if (d.newRequests && d.newRequests.count) announceNewRequests(d.newRequests.count);
  initReports();
  var wbBtn = document.querySelector('#nav button[data-page="whiteboard"]');
  var hasApps = !!wbApp();
  wbBtn.hidden = !hasApps;
  document.getElementById('appsGroup').hidden = !hasApps;

  // A heading with nothing left under it goes too.
  Array.prototype.forEach.call(document.querySelectorAll('#nav .nav-group'), function (g) {
    var el = g.nextElementSibling, any = false;
    while (el && !el.classList.contains('nav-group')) { if (!el.hidden) any = true; el = el.nextElementSibling; }
    if (!any) g.hidden = true;
  });

  Array.prototype.forEach.call(document.querySelectorAll('#nav button'), function (b) {
    b.onclick = function () { setPage(b.dataset.page); };
  });

  // An app can send an admin straight to its page here (the whiteboard links
  // to /admin#whiteboard).
  var wanted = (location.hash || '').slice(1);
  var target = document.querySelector('#nav button[data-page="' + wanted.replace(/[^a-z-]/g, '') + '"]');
  setPage(wanted && target && !target.hidden ? wanted : 'overview');
}).catch(function (e) {
  document.getElementById('main').innerHTML =
    '<div class="notice notice-danger"><strong>Could not load the console</strong>' + esc(e.message) + '</div>';
});
