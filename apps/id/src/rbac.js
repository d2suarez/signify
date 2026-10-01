// ===================================================================
// Signify ID — roles, permissions and the rules about who may grant what
//
// Permissions are `namespace:verb` strings. `core:` covers identity itself;
// every other namespace belongs to one registered app, which keeps a
// centralised directory from quietly becoming a cross-app profile of a child.
//
// Each grant carries a scope, so the catalogue stays short:
//   own    — only the actor's own records (or, for a guardian, their children)
//   class  — records of classes the actor teaches or belongs to
//   tenant — everything within one school
//   global — the whole platform (super admins only)
// ===================================================================

const SCOPES = ['own', 'class', 'tenant', 'global'];

// The year groups offered when describing a class. A school with different
// nomenclature overrides this in its own settings; this is only the default.
const DEFAULT_YEAR_GROUPS = [
  'Pre-K', 'K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12',
];
const SCOPE_RANK = { own: 1, class: 2, tenant: 3, global: 4 };

// The catalogue is the single source of truth for the admin console's role
// editor. Adding an app means adding a block here and registering the client.
const CATALOG = [
  {
    namespace: 'core',
    label: 'Identity and roster',
    permissions: [
      { key: 'core:view_directory',      label: 'See who is in the school',      admin: false },
      { key: 'core:manage_classes',      label: 'Create and edit classes',       admin: false },
      { key: 'core:manage_users',        label: 'Approve, edit and remove users', admin: true },
      { key: 'core:manage_roles',        label: 'Create and edit roles',          admin: true },
      { key: 'core:manage_apps',         label: 'Register and configure apps',    admin: true },
      { key: 'core:manage_tenants',      label: 'Create and configure schools',   admin: true },
      { key: 'core:view_audit',          label: 'Read the audit log',             admin: true },
      { key: 'core:export_student_data', label: 'Export a student record',        admin: false },
      { key: 'core:delete_student_data', label: 'Erase a student record',         admin: true },
      { key: 'core:manage_guardians',    label: 'Verify guardian relationships',  admin: true },
      { key: 'core:import_roster',       label: 'Import a roster from a file',    admin: true },
      { key: 'core:manage_backups',      label: 'Download a backup of the school', admin: true },
      { key: 'core:undo_import',         label: 'Undo a roster import',            admin: true },
      { key: 'core:triage_reports',      label: 'Read and close problem reports',  admin: true },
    ],
  },
  {
    namespace: 'whiteboard',
    label: 'Classroom Whiteboard',
    permissions: [
      { key: 'whiteboard:teach',          label: 'Host and lead a board',   admin: false },
      { key: 'whiteboard:manage_boards',  label: 'Manage all boards',       admin: true },
      { key: 'whiteboard:view_sessions',  label: 'See live sessions',       admin: true },
      { key: 'whiteboard:manage_templates', label: 'Publish to the school template library', admin: false },
    ],
  },
  {
    namespace: 'atlas',
    label: 'Classroom Atlas',
    permissions: [
      { key: 'atlas:teach',    label: 'Create maps and assignments', admin: false },
      { key: 'atlas:grade',    label: 'Grade and override scores',   admin: false },
      { key: 'atlas:moderate', label: 'Remove any map',              admin: true },
    ],
  },
  {
    namespace: 'timestables',
    label: 'Times Tables Trainer',
    permissions: [
      { key: 'timestables:teach',       label: 'Assign practice and see class progress', admin: false },
      { key: 'timestables:manage_board', label: 'Reset or edit the class leaderboard',   admin: false },
    ],
  },
];

const ALL_PERMISSIONS = CATALOG.flatMap((g) => g.permissions.map((p) => p.key));
const ADMIN_PERMISSIONS = new Set(
  CATALOG.flatMap((g) => g.permissions.filter((p) => p.admin).map((p) => p.key))
);
const PERMISSION_LABELS = Object.fromEntries(
  CATALOG.flatMap((g) => g.permissions.map((p) => [p.key, p.label]))
);

const isKnownPermission = (p) => ALL_PERMISSIONS.includes(p);
const namespaceOf = (p) => String(p).split(':')[0];

// A role that carries any administrative permission may only be granted by
// someone who is themselves an administrator. This is what stops a teacher
// from minting a "Teacher Plus" role that can manage users.
// `adminSet` lets the caller pass the live catalogue's administrative keys,
// which include permissions declared by apps after this file was written.
const roleIsAdministrative = (perms, adminSet) => {
  const set = adminSet || ADMIN_PERMISSIONS;
  return perms.some((p) => set.has(p.permission || p));
};

// ---------- built-in roles ----------
// Seeded as global roles (tenant_id NULL). A school may clone any of these
// into a custom role but cannot edit the originals.

const BUILTIN_ROLES = [
  {
    key: 'student',
    label: 'Student',
    description: 'Takes part in lessons. Holds no permissions by design.',
    is_admin: false,
    sort_order: 10,
    // Deliberately empty. Student access to their own work is granted by the
    // apps themselves through ownership, never through a permission string.
    permissions: [],
  },
  {
    key: 'guardian',
    label: 'Parent or guardian',
    description: 'Can inspect and request correction of their own children’s records, as FERPA requires.',
    is_admin: false,
    sort_order: 20,
    permissions: [
      { permission: 'core:export_student_data', scope: 'own' },
    ],
  },
  {
    key: 'staff',
    label: 'Support staff',
    description: 'Aides, counsellors and office staff. Sees the roster but not student work or grades.',
    is_admin: false,
    sort_order: 30,
    permissions: [
      { permission: 'core:view_directory', scope: 'tenant' },
    ],
  },
  {
    key: 'substitute',
    label: 'Substitute teacher',
    description: 'Covers other teachers’ classes on the days the school schedules. Can sign in only on those days, and does not grade.',
    is_admin: false,
    sort_order: 35,
    // A teacher's rights in the apps, only for the classes being covered and
    // only on covered days (see coverage.js). No grading: atlas:grade is left
    // out on purpose. No school directory, and nothing administrative.
    permissions: [
      { permission: 'whiteboard:teach', scope: 'class' },
      { permission: 'atlas:teach', scope: 'class' },
      { permission: 'timestables:teach', scope: 'class' },
      // Teacher's Desk declares these itself rather than in the code catalogue.
      { permission: 'desk:use', scope: 'class' },
      { permission: 'desk:behaviour', scope: 'class' },
    ],
  },
  {
    key: 'teacher',
    label: 'Teacher',
    description: 'Runs classes and grades work for their own classes.',
    is_admin: false,
    sort_order: 40,
    permissions: [
      { permission: 'core:view_directory',        scope: 'tenant' },
      { permission: 'core:manage_classes',        scope: 'own' },
      { permission: 'core:export_student_data',   scope: 'class' },
      { permission: 'whiteboard:teach',           scope: 'class' },
      { permission: 'whiteboard:manage_templates', scope: 'tenant' },
      { permission: 'atlas:teach',                scope: 'class' },
      { permission: 'atlas:grade',                scope: 'class' },
      { permission: 'timestables:teach',          scope: 'class' },
      { permission: 'timestables:manage_board',   scope: 'class' },
    ],
  },
  {
    key: 'local_admin',
    label: 'Local admin',
    description: 'Administers one school: its people, classes, roles and audit trail.',
    is_admin: true,
    sort_order: 50,
    permissions: [
      { permission: 'core:view_directory',        scope: 'tenant' },
      { permission: 'core:manage_classes',        scope: 'tenant' },
      { permission: 'core:manage_users',          scope: 'tenant' },
      { permission: 'core:manage_roles',          scope: 'tenant' },
      { permission: 'core:view_audit',            scope: 'tenant' },
      { permission: 'core:export_student_data',   scope: 'tenant' },
      { permission: 'core:delete_student_data',   scope: 'tenant' },
      { permission: 'core:manage_guardians',      scope: 'tenant' },
      { permission: 'core:import_roster',         scope: 'tenant' },
      { permission: 'core:manage_backups',        scope: 'tenant' },
      { permission: 'core:undo_import',           scope: 'tenant' },
      { permission: 'core:triage_reports',        scope: 'tenant' },
      { permission: 'whiteboard:teach',           scope: 'tenant' },
      { permission: 'whiteboard:manage_boards',   scope: 'tenant' },
      { permission: 'whiteboard:view_sessions',   scope: 'tenant' },
      { permission: 'whiteboard:manage_templates', scope: 'tenant' },
      { permission: 'atlas:teach',                scope: 'tenant' },
      { permission: 'atlas:grade',                scope: 'tenant' },
      { permission: 'atlas:moderate',             scope: 'tenant' },
      { permission: 'timestables:teach',          scope: 'tenant' },
      { permission: 'timestables:manage_board',   scope: 'tenant' },
    ],
  },
];

// Super admin is not a row in `roles`. It lives in platform_admins so that no
// school-level administrator can ever grant it, accidentally or otherwise.
function superAdminGrants() {
  return ALL_PERMISSIONS.map((permission) => ({ permission, scope: 'global' }));
}

// ---------- evaluation ----------

// Collapses a grant list into { permission: highestScope }.
function collapse(grants) {
  const out = {};
  for (const g of grants) {
    const cur = out[g.permission];
    if (!cur || SCOPE_RANK[g.scope] > SCOPE_RANK[cur]) out[g.permission] = g.scope;
  }
  return out;
}

// Does `perms` allow `permission` at least at `needed` reach?
function allows(perms, permission, needed = 'own') {
  const have = perms[permission];
  if (!have) return false;
  return SCOPE_RANK[have] >= SCOPE_RANK[needed];
}

// Narrows a permission map to what one app is entitled to see. An app only
// ever receives `core:` claims plus its own namespace.
function forNamespace(perms, namespace) {
  const out = {};
  for (const [key, scope] of Object.entries(perms)) {
    const ns = namespaceOf(key);
    if (ns === 'core' || ns === namespace) out[key] = scope;
  }
  return out;
}

// Privilege-escalation guard: an actor may only put permissions into a role
// that they themselves hold, at a scope no wider than their own.
function canGrant(actorPerms, isSuper, grants, live) {
  const known = (live && live.known) || null;
  const labels = (live && live.labels) || PERMISSION_LABELS;
  const isKnown = (k) => (known ? known.has(k) : isKnownPermission(k));

  if (isSuper) {
    // Even a super admin cannot put a permission into a role that no app
    // claims — that is a typo, not an intention.
    for (const g of grants) {
      if (!isKnown(g.permission)) return { ok: false, reason: `Unknown permission: ${g.permission}` };
    }
    return { ok: true };
  }

  for (const g of grants) {
    if (!isKnown(g.permission)) {
      return { ok: false, reason: `Unknown permission: ${g.permission}` };
    }
    if (!allows(actorPerms, g.permission, g.scope)) {
      return {
        ok: false,
        reason: `You cannot grant "${labels[g.permission] || g.permission}" at ${g.scope} level because you do not hold it yourself at that level.`,
      };
    }
  }
  return { ok: true };
}

module.exports = {
  SCOPES, SCOPE_RANK, DEFAULT_YEAR_GROUPS, CATALOG, ALL_PERMISSIONS, ADMIN_PERMISSIONS, PERMISSION_LABELS,
  BUILTIN_ROLES, superAdminGrants,
  isKnownPermission, namespaceOf, roleIsAdministrative,
  collapse, allows, forNamespace, canGrant,
};
