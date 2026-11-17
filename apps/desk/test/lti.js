// ===================================================================
// Teacher's Desk — Schoology (LTI 1.3) against a fake platform.
//
//   node test/lti.js
//
// Starts the real server on a spare port with its data in a temp folder, and
// a fake platform that signs launches. Then a few in-process checks of the
// parts that need a stubbed Signify ID (the school's tool ceiling) or a
// clock (the retention sweep).
// ===================================================================

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PLAT_PORT = 19000 + Math.floor(Math.random() * 800);
const DESK_PORT = PLAT_PORT + 1000;
const PLAT = `http://localhost:${PLAT_PORT}`;
const DESK = `http://localhost:${DESK_PORT}`;
const CLIENT = 'desk-client-1';
const DEPLOY = 'dep-1';
const H = 'x-desk-lti';

// ---------- the fake platform ----------
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pubJwk = Object.assign(publicKey.export({ format: 'jwk' }), { kid: 'plat-1', alg: 'RS256', use: 'sig' });
const b64u = (x) => Buffer.from(x).toString('base64url');
function signAs(claims, key = privateKey, kid = 'plat-1') {
  const h = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const b = b64u(JSON.stringify(claims));
  return `${h}.${b}.${b64u(crypto.sign('RSA-SHA256', Buffer.from(`${h}.${b}`), key))}`;
}
const platform = http.createServer((req, res) => {
  if (req.url === '/jwks') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ keys: [pubJwk] })); }
  res.writeHead(404); res.end();
});

// ---------- helpers ----------
let passed = 0;
async function check(name, fn) { await fn(); passed += 1; console.log('  pass  ' + name); }

async function login() {
  const q = new URLSearchParams({ iss: PLAT, login_hint: 'hint', target_link_uri: `${DESK}/lti/launch`, client_id: CLIENT, lti_message_hint: 'mh' });
  const r = await fetch(`${DESK}/lti/login?${q}`, { redirect: 'manual' });
  assert.strictEqual(r.status, 302);
  const loc = new URL(r.headers.get('location'));
  assert.strictEqual(loc.origin + loc.pathname, `${PLAT}/auth`);
  assert.strictEqual(loc.searchParams.get('redirect_uri'), `${DESK}/lti/launch`);
  assert.strictEqual(loc.searchParams.get('client_id'), CLIENT);
  assert.strictEqual(loc.searchParams.get('lti_message_hint'), 'mh');
  assert.strictEqual(loc.searchParams.get('response_mode'), 'form_post');
  return { state: loc.searchParams.get('state'), nonce: loc.searchParams.get('nonce') };
}

const STUDENT = 'http://purl.imsglobal.org/vocab/lis/v2/membership#Learner';
const TEACHER = 'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor';

function claimsFor({ nonce, sub, role, type = 'LtiResourceLinkRequest', dep = DEPLOY, course = 'c1' }) {
  const now = Math.floor(Date.now() / 1000);
  const c = {
    iss: PLAT, aud: CLIENT, sub, nonce, iat: now, exp: now + 300,
    name: 'Real Name Never Stored', email: 'kid@school.example', given_name: 'Realname',
    'https://purl.imsglobal.org/spec/lti/claim/message_type': type,
    'https://purl.imsglobal.org/spec/lti/claim/version': '1.3.0',
    'https://purl.imsglobal.org/spec/lti/claim/deployment_id': dep,
    'https://purl.imsglobal.org/spec/lti/claim/target_link_uri': `${DESK}/lti/launch`,
    'https://purl.imsglobal.org/spec/lti/claim/roles': [role],
    'https://purl.imsglobal.org/spec/lti/claim/context': { id: course, title: 'Science 7' },
    'https://purl.imsglobal.org/spec/lti/claim/lis': { person_sourcedid: 'SIS-99887' },
  };
  if (type === 'LtiResourceLinkRequest') c['https://purl.imsglobal.org/spec/lti/claim/resource_link'] = { id: 'rl-1', title: 'Desk' };
  return c;
}

async function launch(opts, { key, mutate } = {}) {
  const { state, nonce } = await login();
  const claims = claimsFor(Object.assign({ nonce }, opts));
  if (mutate) mutate(claims);
  const r = await fetch(`${DESK}/lti/launch`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: signAs(claims, key), state }).toString(),
  });
  return { r, token: r.status === 303 ? /#t=(.+)$/.exec(r.headers.get('location'))[1] : null, text: r.status === 303 ? '' : await r.text(), state, claims };
}

const api = (token, method, p, body) => fetch(DESK + p, {
  method, headers: Object.assign({}, token ? { [H]: token } : {}, body ? { 'content-type': 'application/json' } : {}),
  body: body ? JSON.stringify(body) : undefined,
});

// ---------- run ----------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-lti-'));
let server;

async function main() {
  await new Promise((r) => platform.listen(PLAT_PORT, r));
  const env = Object.assign({}, process.env, {
    PORT: String(DESK_PORT), DATA_DIR: TMP,
    LTI_CLIENT_ID: CLIENT, LTI_DEPLOYMENT_IDS: DEPLOY, LTI_ISSUER: PLAT,
    LTI_AUTH_URL: `${PLAT}/auth`, LTI_JWKS_URL: `${PLAT}/jwks`,
    LTI_FRAME_ORIGINS: 'https://class.example.org,https://*.schoology.com',
  });
  for (const k of ['DESK_DEV_USER', 'RAILWAY_ENVIRONMENT', 'SIGNIFY_ISSUER', 'SIGNIFY_CLIENT_ID', 'SIGNIFY_CLIENT_SECRET', 'CANONICAL_HOST', 'LTI_TENANT_ID']) delete env[k];
  server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(`${DESK}/healthz`)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }

  const lti = require('../server/lti');
  const CAPABLE = lti.CAPABLE;

  await check('publishes a JWKS', async () => {
    const j = await (await fetch(`${DESK}/lti/jwks`)).json();
    assert.strictEqual(j.keys.length, 1);
    assert.strictEqual(j.keys[0].alg, 'RS256');
    assert(!('d' in j.keys[0]), 'no private part');
  });

  await check('login refuses an unknown platform', async () => {
    const r = await fetch(`${DESK}/lti/login?iss=https://evil.example&login_hint=x`, { redirect: 'manual' });
    assert.strictEqual(r.status, 400);
  });

  let student;
  await check('a student launch opens a session and lands on the framed page', async () => {
    student = await launch({ sub: 'sub-student-1', role: STUDENT });
    assert.strictEqual(student.r.status, 303, student.text);
    assert(/^\/lti\/app#t=/.test(student.r.headers.get('location')));
  });

  await check('the framed page may be framed by Schoology only, and the desk may not be framed at all', async () => {
    const a = await fetch(`${DESK}/lti/app`);
    const csp = a.headers.get('content-security-policy');
    assert(csp.includes('frame-ancestors https://class.example.org https://*.schoology.com'), csp);
    assert(!a.headers.get('x-frame-options'));
    const d = await fetch(`${DESK}/lti/desk`);
    assert(d.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
    assert.strictEqual(d.headers.get('x-frame-options'), 'DENY');
    const html = await d.text();
    assert(html.includes('/js/lti-boot.js'), 'LTI boot script');
    assert(html.indexOf('/js/lti-boot.js') < html.indexOf('/js/api.js'), 'before the API');
    assert(!html.includes('signify-switcher'), 'no app switcher');
    const root = await fetch(`${DESK}/`);
    assert(root.headers.get('content-security-policy').includes("frame-ancestors 'none'"), 'the desk itself stays unframeable');
  });

  await check('the session says student', async () => {
    const s = await (await api(student.token, 'GET', '/lti/api/state')).json();
    assert.strictEqual(s.role, 'student');
    assert(!s.tools, 'students are not shown the settings');
  });

  await check('a student gets a blank desk with only tools that need no account', async () => {
    const me = await (await api(student.token, 'GET', '/api/me')).json();
    assert.strictEqual(me.user.lti, true);
    assert.strictEqual(me.user.can.desk, true);
    assert.strictEqual(me.user.can.classLists, false);
    assert.strictEqual(me.user.email, '');
    assert.deepStrictEqual(me.user.tools.sort(), CAPABLE.slice().sort());
    for (const t of ['behaviour', 'seating', 'groups', 'randomiser', 'jobs', 'passage', 'picture', 'soundboard', 'helpdesk', 'whiteboard']) {
      assert(!me.user.tools.includes(t), t);
    }
    const b = await (await api(student.token, 'GET', '/api/board')).json();
    assert.deepStrictEqual(b.items, []);
    const cfg = await (await api(student.token, 'GET', '/api/config')).json();
    assert.strictEqual(cfg.lti, true);
  });

  await check('a student desk saves, and a teacher tool cannot be smuggled onto it', async () => {
    const b = await (await api(student.token, 'GET', '/api/board')).json();
    const r = await api(student.token, 'PUT', '/api/board', {
      rev: b.rev,
      items: [
        { id: 'w1', type: 'timer', x: 0, y: 0, w: 3, h: 4, state: { label: 'Reading' } },
        { id: 'w2', type: 'behaviour', x: 3, y: 0, w: 3, h: 4, state: {} },
      ],
    });
    assert.strictEqual(r.status, 200);
    const again = await (await api(student.token, 'GET', '/api/board')).json();
    assert.deepStrictEqual(again.items.map((i) => i.type), ['timer']);
  });

  await check('everything outside the desk itself is refused to an LTI desk', async () => {
    for (const [m, p] of [['GET', '/api/classes'], ['GET', '/api/assets'], ['POST', '/api/assets'], ['GET', '/api/templates'],
      ['GET', '/api/groupings'], ['GET', '/api/behaviour/reasons'], ['POST', '/api/lists']]) {
      const r = await api(student.token, m, p);
      assert.strictEqual(r.status, 403, `${m} ${p} → ${r.status}`);
    }
  });

  await check('no header is an ordinary signed-out visitor; a dead token is a closed desk', async () => {
    assert.strictEqual((await api(null, 'GET', '/api/me')).status, 401);
    const r = await api('x'.repeat(43), 'GET', '/api/me');
    assert.strictEqual(r.status, 401);
    assert.strictEqual((await r.json()).lti, true);
    assert.strictEqual((await api('x'.repeat(43), 'GET', '/lti/api/state')).status, 401);
  });

  await check('a student cannot change the course’s tools', async () => {
    assert.strictEqual((await api(student.token, 'PUT', '/lti/api/course', { on: CAPABLE })).status, 403);
  });

  let teacher;
  await check('a teacher sees the school’s tools for this course and can narrow them', async () => {
    teacher = await launch({ sub: 'sub-teacher-1', role: TEACHER });
    assert.strictEqual(teacher.r.status, 303, teacher.text);
    const s = await (await api(teacher.token, 'GET', '/lti/api/state')).json();
    assert.strictEqual(s.role, 'teacher');
    assert.strictEqual(s.courseTitle, 'Science 7');
    assert.strictEqual(s.schoolSet, false);
    assert.deepStrictEqual(s.tools.map((t) => t.type).sort(), CAPABLE.slice().sort());
    assert(s.tools.every((t) => t.on), 'all on to start');
    const r = await api(teacher.token, 'PUT', '/lti/api/course', { on: ['timer', 'notes', 'behaviour'] });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual((await r.json()).on.sort(), ['notes', 'timer'], 'cannot turn on what the school does not allow');
    const me = await (await api(student.token, 'GET', '/api/me')).json();
    assert.deepStrictEqual(me.user.tools.sort(), ['notes', 'timer']);
  });

  await check('a tool the teacher turns off is hidden, not deleted', async () => {
    await api(teacher.token, 'PUT', '/lti/api/course', { on: ['notes'] });
    const b = await (await api(student.token, 'GET', '/api/board')).json();
    assert.deepStrictEqual(b.items, []);
    await api(student.token, 'PUT', '/api/board', { rev: b.rev, items: [{ id: 'n1', type: 'notes', x: 0, y: 0, w: 3, h: 4, state: {} }] });
    await api(teacher.token, 'PUT', '/lti/api/course', { on: ['notes', 'timer'] });
    const back = await (await api(student.token, 'GET', '/api/board')).json();
    assert.deepStrictEqual(back.items.map((i) => i.type).sort(), ['notes', 'timer']);
  });

  await check('another course keeps its own setting; the same student keeps one desk', async () => {
    const s2 = await launch({ sub: 'sub-student-1', role: STUDENT, course: 'c2' });
    const me = await (await api(s2.token, 'GET', '/api/me')).json();
    assert.deepStrictEqual(me.user.tools.sort(), CAPABLE.slice().sort());
    const b = await (await api(s2.token, 'GET', '/api/board')).json();
    assert.deepStrictEqual(b.items.map((i) => i.type).sort(), ['notes', 'timer']);
  });

  await check('Reset my desk on a Schoology desk goes back to blank', async () => {
    const t = await launch({ sub: 'sub-reset', role: STUDENT });
    const b = await (await api(t.token, 'GET', '/api/board')).json();
    await api(t.token, 'PUT', '/api/board', { rev: b.rev, items: [{ id: 'x', type: 'timer', x: 0, y: 0, w: 3, h: 4, state: {} }] });
    const r = await (await api(t.token, 'POST', '/api/board/reset')).json();
    assert.deepStrictEqual(r.items, []);
  });

  await check('the teacher’s student-desk preview is separate from any student’s', async () => {
    const b = await (await api(teacher.token, 'GET', '/api/board')).json();
    assert.deepStrictEqual(b.items, []);
  });

  await check('refuses a forged signature, a replay, a wrong deployment and a deep-link launch', async () => {
    const forged = await launch({ sub: 's', role: STUDENT }, { key: other.privateKey });
    assert.strictEqual(forged.r.status, 400);
    assert(/not signed by Schoology/.test(forged.text));

    // Replay: reuse a launch's state + token once it has been used.
    const first = await login();
    const claims = claimsFor({ nonce: first.nonce, sub: 's', role: STUDENT });
    const body = new URLSearchParams({ id_token: signAs(claims), state: first.state }).toString();
    const post = () => fetch(`${DESK}/lti/launch`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    assert.strictEqual((await post()).status, 303);
    assert.strictEqual((await post()).status, 400);

    const dep = await launch({ sub: 's', role: STUDENT, dep: 'someone-else' });
    assert.strictEqual(dep.r.status, 400);
    assert(/not the one/.test(dep.text));

    const dl = await launch({ sub: 's', role: TEACHER, type: 'LtiDeepLinkingRequest' });
    assert.strictEqual(dl.r.status, 400);
    assert(/External Tool/.test(dl.text));

    const old = await launch({ sub: 's', role: STUDENT }, { mutate: (c) => { c.exp = Math.floor(Date.now() / 1000) - 600; } });
    assert.strictEqual(old.r.status, 400);
  });

  await check('nothing Schoology says about who a student is reaches the disk', async () => {
    await new Promise((r) => setTimeout(r, 400));   // the store's write debounce
    const raw = fs.readFileSync(path.join(TMP, 'desk.json'), 'utf8');
    for (const s of ['Real Name Never Stored', 'Realname', 'kid@school.example', 'sub-student-1', 'sub-teacher-1', 'SIS-99887', '"c1"']) {
      assert(!raw.includes(s), `${s} must not be stored`);
    }
    const db = JSON.parse(raw);
    assert(Object.keys(db.boards).some((k) => /^lti_[A-Za-z0-9_-]{32}$/.test(k)), 'desks under a hashed id');
    assert(!raw.includes(student.token), 'session tokens are stored hashed');
  });

  server.kill();
  await new Promise((r) => server.on('exit', r));

  // ---------- in-process: the school's ceiling, and the sweep ----------
  // A fresh copy of the modules, pointed at a stub Signify ID.
  for (const k of Object.keys(require.cache)) if (k.includes(`${path.sep}server${path.sep}`)) delete require.cache[k];
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-lti-2-'));
  Object.assign(process.env, { SIGNIFY_ISSUER: 'https://id.example', SIGNIFY_CLIENT_ID: 'teachers-desk', SIGNIFY_CLIENT_SECRET: 's', LTI_TENANT_ID: 'school-1' });
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url) === 'https://id.example/api/v1/tenants/school-1/features') {
      return new Response(JSON.stringify({ roles: { student: { flashcards: false, behaviour: true, seating: true } } }), { status: 200 });
    }
    throw new Error('unexpected fetch ' + url);
  };
  const lti2 = require('../server/lti');
  const store2 = require('../server/store');

  await check('the school’s Student setting in Signify ID is the ceiling, and cannot add teacher tools', async () => {
    const list = await lti2._schoolAllows(lti2.config());
    assert(!list.includes('flashcards'), 'school turned flashcards off');
    assert(list.includes('timer'));
    assert(!list.includes('behaviour') && !list.includes('seating'), 'a school turning on teacher tools for students does not reach an LTI desk');
  });
  global.fetch = realFetch;

  await check('a Schoology desk nobody opens for a year is erased, and nobody else’s is', async () => {
    const db = store2.load();
    const now = Date.now();
    db.boards.lti_old = { uid: 'lti_old', items: [], updatedAt: now - 400 * 864e5 };
    db.users.lti_old = { uid: 'lti_old', lastSeen: now - 400 * 864e5 };
    db.boardHistory.lti_old = [{ rev: 1 }];
    db.boards.lti_new = { uid: 'lti_new', items: [], updatedAt: now };
    db.boards['teacher-uuid'] = { uid: 'teacher-uuid', items: [], updatedAt: now - 900 * 864e5 };
    assert.strictEqual(lti2.sweep(lti2.config(), now), 1);
    assert(!db.boards.lti_old && !db.users.lti_old && !db.boardHistory.lti_old);
    assert(db.boards.lti_new && db.boards['teacher-uuid']);
  });

  await check('uids and course ids are stable and do not contain the Schoology ids', async () => {
    const a = lti2._uidFor('iss', 'dep', 'sub-1');
    assert.strictEqual(a, lti2._uidFor('iss', 'dep', 'sub-1'));
    assert.notStrictEqual(a, lti2._uidFor('iss', 'dep', 'sub-2'));
    assert.notStrictEqual(a, lti2._uidFor('iss', 'dep2', 'sub-1'));
    assert(!a.includes('sub-1'));
  });

  platform.close();
  console.log(`\n${passed} LTI checks passed.`);
}

main().catch((e) => {
  console.error('\nFAIL:', e && e.stack || e);
  if (server) server.kill();
  platform.close();
  process.exit(1);
});
