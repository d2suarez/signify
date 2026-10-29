// ===================================================================
// Local playground: the real server, backed by an in-process Postgres that
// starts empty every time. Nothing here ships to Railway.
//   node test/dev-server.js
// ===================================================================

process.env.DATABASE_URL = 'pglite://memory';
process.env.ISSUER = process.env.ISSUER || 'http://localhost:3010';
process.env.PORT = process.env.PORT || '3010';
process.env.SUPER_ADMINS = process.env.SUPER_ADMINS || 'desmond@signify.one';
process.env.COOKIE_SECRET = 'dev'.repeat(16);
process.env.ALLOW_DEV_LOGIN = '1';
delete process.env.RAILWAY_ENVIRONMENT;

const { PglitePool } = require('./pglite-pool');

(async () => {
  const pool = await PglitePool.create();
  const db = require('../src/db');
  db.setPool(pool);

  // A school to look at, so the console is not an empty shell.
  const seedDemo = async () => {
    const t = await db.one(
      `INSERT INTO tenants (slug, name, minors_default) VALUES ('demo','Demo Primary School', true)
       ON CONFLICT (slug) DO NOTHING RETURNING *`);
    if (!t) return;
    await db.query(
      `INSERT INTO tenant_domains (domain, tenant_id, auto_role, require_hd)
       VALUES ('signify.one', $1, 'teacher', false), ('demo.edu', $1, 'student', false)`, [t.id]);

    const student = await db.one("SELECT id FROM roles WHERE key='student' AND tenant_id IS NULL");
    const teacher = await db.one("SELECT id FROM roles WHERE key='teacher' AND tenant_id IS NULL");
    const substitute = await db.one("SELECT id FROM roles WHERE key='substitute' AND tenant_id IS NULL");
    const guardian = await db.one("SELECT id FROM roles WHERE key='guardian' AND tenant_id IS NULL");
    const names = [
      ['ada@demo.edu', 'Ada Fielding', student, 'active', '3'],
      ['ben@demo.edu', 'Ben Okafor', student, 'active', '3'],
      ['cleo@demo.edu', 'Cleo Marsh', student, 'pending', '4'],
      ['dev@demo.edu', 'Dev Raman', student, 'active', '4'],
      ['erin@demo.edu', 'Erin Wallis', student, 'blocked', '3'],
      ['mrs.hall@demo.edu', 'Priya Hall', teacher, 'active', null],
      ['mr.stone@demo.edu', 'Alex Stone', teacher, 'active', null],
      // Signs in only on days the school has arranged cover (Substitutes page).
      ['sam.reed@demo.edu', 'Sam Reed', substitute, 'active', null],
      // Ben's parent, not yet linked to him (Parents page).
      ['pat.okafor@gmail.com', 'Pat Okafor', guardian, 'active', null],
    ];
    for (const [email, name, role, status, grade] of names) {
      const u = await db.one(
        `INSERT INTO users (email, display_name, is_minor, last_seen_at)
         VALUES ($1,$2,$3, now() - (random() * interval '5 days')) RETURNING id`,
        [email, name, role.id === student.id]);
      await db.query(
        'INSERT INTO memberships (user_id, tenant_id, role_id, status, grade_level) VALUES ($1,$2,$3,$4,$5)',
        [u.id, t.id, role.id, status, grade]);
    }
    const cls = await db.one(
      `INSERT INTO classes (tenant_id, name, subject, grade_levels, school_year)
       VALUES ($1,'3B Mathematics','Mathematics', ARRAY['3'],'2026') RETURNING id`, [t.id]);
    const idOf = async (email) => (await db.one('SELECT id FROM users WHERE email = $1', [email])).id;
    const put = async (classId, email, role) => db.query(
      'INSERT INTO class_members (class_id, user_id, role) VALUES ($1,$2,$3)', [classId, await idOf(email), role]);
    await put(cls.id, 'mrs.hall@demo.edu', 'teacher');
    for (const e of ['ada@demo.edu', 'ben@demo.edu', 'cleo@demo.edu', 'dev@demo.edu', 'erin@demo.edu']) {
      await put(cls.id, e, 'student');
    }
    const reading = await db.one(
      `INSERT INTO classes (tenant_id, name, subject, grade_levels, school_year)
       VALUES ($1,'Mixed 4/5 Reading','English', ARRAY['4','5'],'2026') RETURNING id`, [t.id]);
    await put(reading.id, 'mr.stone@demo.edu', 'teacher');
    for (const e of ['cleo@demo.edu', 'dev@demo.edu']) await put(reading.id, e, 'student');
    console.log('Demo school seeded.');
  };

  // A stand-in app, so the whole round trip an app actually makes —
  // /auth/login, /authorize, the sign-in page, the code, the callback — can be
  // walked locally. Without it the only thing testable here is the console,
  // which is the one path that never has to come back to an app.
  const seedDemoApp = async () => {
    const secrets = require('../src/secrets');
    const existing = await db.one("SELECT id FROM apps WHERE client_id = 'demo-app'");
    if (existing) return;
    await db.query(
      `INSERT INTO apps (client_id, name, client_secret_hash, redirect_uris, scopes, namespace, status)
       VALUES ('demo-app','Demo App',$1, ARRAY['http://localhost:3011/auth/callback'],
               ARRAY['openid','profile','email','roles'],'demo','active')`,
      [secrets.hash('demo-secret')]);
    const app = await db.one("SELECT id FROM apps WHERE client_id = 'demo-app'");
    // A launch address is what puts an app in the switcher and in the list a
    // person asking for an account chooses from.
    await db.query(
      "UPDATE apps SET launch_url = 'http://localhost:3011/', short_name = 'Demo', description = 'A stand-in app for walking the sign-in round trip locally.' WHERE id = $1",
      [app.id]);
    const t = await db.one("SELECT id FROM tenants WHERE slug = 'demo'");
    if (t) await db.query('INSERT INTO app_tenants (app_id, tenant_id, enabled) VALUES ($1,$2,true)', [app.id, t.id]);
    console.log('Demo app registered. Run: node test/dev-app.js  (then open http://localhost:3011)');
  };

  const FLEET_DEV_APPS = [
    { clientId: 'whiteboard-dev', name: 'Classroom Whiteboard', short: 'Whiteboard', namespace: 'whiteboard', origin: 'http://wb.localhost:3000', order: 10 },
    { clientId: 'atlas-dev', name: 'Classroom Atlas', short: 'Atlas', namespace: 'atlas', origin: 'http://atlas.localhost:8750', order: 20 },
  ];
  const seedFleetApps = async () => {
    const secrets = require('../src/secrets');
    const t = await db.one("SELECT id FROM tenants WHERE slug = 'demo'");
    for (const a of FLEET_DEV_APPS) {
      if (await db.one('SELECT id FROM apps WHERE client_id = $1', [a.clientId])) continue;
      const app = await db.one(
        `INSERT INTO apps (client_id, name, client_secret_hash, redirect_uris, post_logout_uris, scopes,
                           namespace, status, launch_url, short_name, sort_order)
         VALUES ($1,$2,$3, ARRAY[$4::text], ARRAY[$5::text], ARRAY['openid','profile','email','roles'],
                 $6,'active',$5,$7,$8) RETURNING id`,
        [a.clientId, a.name, secrets.hash('dev-secret'), a.origin + '/auth/callback', a.origin + '/',
          a.namespace, a.short, a.order]);
      if (t) await db.query('INSERT INTO app_tenants (app_id, tenant_id, enabled) VALUES ($1,$2,true)', [app.id, t.id]);
    }
    console.log('Fleet dev apps registered: ' + FLEET_DEV_APPS.map((a) => a.origin).join(', '));
  };

  // server.js migrates and seeds built-ins on boot; wait for that first.
  require('../server.js');
  setTimeout(async () => { await seedDemo(); await seedDemoApp(); await seedFleetApps(); }, 1500);
})();
