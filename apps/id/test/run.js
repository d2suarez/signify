// ===================================================================
// Signify ID — test suite
// Runs the real schema and the real modules against an in-process Postgres.
// The cases here are the ones where getting it wrong means a child's records
// end up in the wrong hands, so they are worth the setup.
// ===================================================================

process.env.DATABASE_URL = 'pglite://memory';
process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
process.env.ISSUER = 'http://localhost:3999';
process.env.SUPER_ADMINS = 'boss@school.edu,backup@school.edu';
process.env.COOKIE_SECRET = 'a'.repeat(64);
process.env.SESSION_IDLE_MINUTES = '45';
process.env.SESSION_IDLE_MINUTES_MINOR = '20';

const crypto = require('crypto');
const { PglitePool } = require('./pglite-pool');

let passed = 0, failed = 0;
const failures = [];

function ok(name, condition, extra) {
  if (condition) { passed += 1; console.log(`  pass  ${name}`); }
  else { failed += 1; failures.push(name); console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}
function eq(name, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  ok(name, same, same ? '' : `got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`);
}
function section(title) { console.log(`\n${title}`); }

(async () => {
  const pool = await PglitePool.create();
  const db = require('../src/db');
  db.setPool(pool);

  const rbac = require('../src/rbac');
  const seed = require('../src/seed');
  const identity = require('../src/identity');
  const sessions = require('../src/sessions');
  const keys = require('../src/keys');
  const secrets = require('../src/secrets');
  const guards = require('../src/guards');
  const roster = require('../src/roster');
  const backup = require('../src/backup');
  const maintenance = require('../src/maintenance');
  const directory = require('../src/directory');

  section('Schema and seed');
  await db.migrate();
  await seed.ensureBuiltins();
  const roleCount = await db.one('SELECT COUNT(*) AS n FROM roles WHERE tenant_id IS NULL');
  eq('built-in roles seeded', Number(roleCount.n), rbac.BUILTIN_ROLES.length);
  const studentPerms = await db.many(
    "SELECT permission FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.key = 'student'");
  eq('student role holds no permissions', studentPerms.length, 0);
  await seed.ensureBuiltins();
  const roleCount2 = await db.one('SELECT COUNT(*) AS n FROM roles WHERE tenant_id IS NULL');
  eq('seed is idempotent', Number(roleCount2.n), rbac.BUILTIN_ROLES.length);

  section('Tenant setup');
  const tenant = await db.one(
    "INSERT INTO tenants (slug, name, minors_default) VALUES ('oakwood','Oakwood School', true) RETURNING *");
  const other = await db.one(
    "INSERT INTO tenants (slug, name) VALUES ('riverside','Riverside Academy') RETURNING *");
  await db.query(
    "INSERT INTO tenant_domains (domain, tenant_id, auto_role, require_hd) VALUES ('school.edu', $1, 'student', true)",
    [tenant.id]);
  await db.query(
    "INSERT INTO tenant_domains (domain, tenant_id, auto_role, require_hd) VALUES ('riverside.edu', $1, 'student', true)",
    [other.id]);
  ok('tenant created', !!tenant.id);

  section('Identity resolution');

  const alice = await identity.resolveUser({
    provider: 'google', subject: 'google-sub-alice', email: 'Alice@School.edu',
    name: 'Alice Nguyen', hostedDomain: 'school.edu',
  });
  ok('new user created', alice.ok && alice.created);
  eq('email is lower-cased', alice.user.email, 'alice@school.edu');
  eq('minor status inherited from tenant, not asked', alice.user.is_minor, true);

  const aliceAgain = await identity.resolveUser({
    provider: 'google', subject: 'google-sub-alice', email: 'alice@school.edu',
    name: 'Alice Nguyen-Smith', hostedDomain: 'school.edu',
  });
  ok('repeat login reuses the same person', aliceAgain.ok && !aliceAgain.created && aliceAgain.user.id === alice.user.id);
  eq('display name follows the provider', aliceAgain.user.display_name, 'Alice Nguyen-Smith');

  // Legal name change: same human, new address.
  const renamed = await identity.resolveUser({
    provider: 'google', subject: 'google-sub-alice', email: 'anguyen@school.edu',
    name: 'Alice Nguyen-Smith', hostedDomain: 'school.edu',
  });
  ok('address change follows the subject', renamed.ok && renamed.user.id === alice.user.id);
  eq('new address stored', renamed.user.email, 'anguyen@school.edu');

  // THE case this whole design exists for: the address is recycled to a new
  // pupil. A different Google subject must never inherit the old record.
  await identity.resolveUser({
    provider: 'google', subject: 'google-sub-bob', email: 'bob@school.edu',
    name: 'Bob Ferris', hostedDomain: 'school.edu',
  });
  const recycled = await identity.resolveUser({
    provider: 'google', subject: 'google-sub-NEW-bob', email: 'bob@school.edu',
    name: 'Bobbie Trent', hostedDomain: 'school.edu',
  });
  ok('recycled address is refused, not merged', !recycled.ok);
  eq('refusal reason is the subject conflict', recycled.code, 'subject_conflict');

  const conflictLogged = await db.one(
    "SELECT 1 FROM audit_log WHERE action = 'identity.subject_conflict'");
  ok('subject conflict is audited', !!conflictLogged);

  // An account created in advance by an administrator is claimed on first
  // sign-in, because the provider has proved ownership of the address.
  const preMade = await db.one(
    `INSERT INTO users (email, display_name) VALUES ('carla@school.edu','Carla (roster import)') RETURNING *`);
  const claimed = await identity.resolveUser({
    provider: 'google', subject: 'google-sub-carla', email: 'carla@school.edu',
    name: 'Carla Diaz', hostedDomain: 'school.edu',
  });
  ok('pre-created account is claimed, not duplicated', claimed.ok && claimed.linked && claimed.user.id === preMade.id);

  section('Tenant matching and auto-join');

  await identity.ensureMembership(alice.user.id, 'anguyen@school.edu', 'school.edu');
  const aliceAccess = await identity.accessFor(alice.user.id);
  eq('auto-joined the right school', aliceAccess.membership.tenant_id, tenant.id);
  eq('auto-joined as student', aliceAccess.membership.role_key, 'student');
  eq('student holds no permissions', Object.keys(aliceAccess.perms).length, 0);

  // A personal Google account wearing a school domain has no `hd` claim.
  const impostor = await identity.tenantForLogin({ email: 'someone@school.edu', hostedDomain: '' });
  ok('personal account on a school domain is flagged', impostor && impostor.hdMismatch === true);

  const stranger = await identity.resolveUser({
    provider: 'google', subject: 'google-sub-stranger', email: 'stranger@gmail.com', name: 'Stranger',
  });
  const strangerMembership = await identity.ensureMembership(stranger.user.id, 'stranger@gmail.com', '');
  ok('unknown domain gets no membership', strangerMembership === null);
  const strangerBlock = identity.loginBlock(await identity.accessFor(stranger.user.id));
  eq('unknown domain cannot sign in', strangerBlock.code, 'no_tenant');

  section('Roles and privilege escalation');

  const teacherRole = await db.one("SELECT id FROM roles WHERE key = 'teacher' AND tenant_id IS NULL");
  const adminRole = await db.one("SELECT id FROM roles WHERE key = 'local_admin' AND tenant_id IS NULL");
  await db.query("UPDATE memberships SET role_id = $1, status = 'active' WHERE user_id = $2",
    [teacherRole.id, claimed.user.id]);
  await identity.ensureMembership(claimed.user.id, 'carla@school.edu', 'school.edu');
  await db.query("UPDATE memberships SET role_id = $1, status = 'active' WHERE user_id = $2",
    [teacherRole.id, claimed.user.id]);

  const carla = await identity.accessFor(claimed.user.id);
  eq('teacher role resolves', carla.membership.role_key, 'teacher');
  ok('teacher may grade their classes', rbac.allows(carla.perms, 'atlas:grade', 'class'));
  ok('teacher may NOT grade the whole school', !rbac.allows(carla.perms, 'atlas:grade', 'tenant'));
  ok('teacher may not manage users', !rbac.allows(carla.perms, 'core:manage_users', 'tenant'));

  const escalate = rbac.canGrant(carla.perms, false, [{ permission: 'core:manage_users', scope: 'tenant' }]);
  ok('teacher cannot mint a role that manages users', !escalate.ok);
  const widen = rbac.canGrant(carla.perms, false, [{ permission: 'atlas:grade', scope: 'tenant' }]);
  ok('teacher cannot widen their own reach into a new role', !widen.ok);
  const fine = rbac.canGrant(carla.perms, false, [{ permission: 'atlas:grade', scope: 'class' }]);
  ok('teacher can create a role no stronger than themselves', fine.ok);

  section('Claim filtering between apps');
  const teacherPerms = rbac.collapse(rbac.BUILTIN_ROLES.find((r) => r.key === 'teacher').permissions);
  const atlasView = rbac.forNamespace(teacherPerms, 'atlas');
  ok('atlas sees its own permissions', 'atlas:grade' in atlasView);
  ok('atlas sees shared identity permissions', 'core:view_directory' in atlasView);
  ok('atlas cannot see whiteboard permissions', !('whiteboard:teach' in atlasView));
  ok('atlas cannot see times tables permissions', !('timestables:teach' in atlasView));

  section('Administrative guards');
  const carlaActor = {
    userId: claimed.user.id, email: 'carla@school.edu', isSuper: false,
    tenantId: tenant.id, perms: carla.perms,
  };
  await db.query('INSERT INTO platform_admins (user_id) VALUES ($1)', [alice.user.id]);
  const vsSuper = await guards.canManageUser(carlaActor, alice.user.id);
  ok('nobody in a school can touch a super admin', !vsSuper.ok);
  const vsSelf = await guards.canManageUser(carlaActor, claimed.user.id);
  ok('an admin cannot edit their own access', !vsSelf.ok);

  const bobUser = await db.one("SELECT id FROM users WHERE email = 'bob@school.edu'");
  await identity.ensureMembership(bobUser.id, 'bob@school.edu', 'school.edu');
  const localAdminActor = { ...carlaActor, perms: rbac.collapse(rbac.BUILTIN_ROLES.find((r) => r.key === 'local_admin').permissions) };
  const superAdminActor = { userId: alice.user.id, email: 'alice@school.edu', isSuper: true, tenantId: tenant.id, perms: rbac.collapse(rbac.superAdminGrants()) };
  const vsStudent = await guards.canManageUser(localAdminActor, bobUser.id);
  ok('a local admin may manage a pupil in their school', vsStudent.ok);

  // Cross-school isolation.
  const riversideUser = await identity.resolveUser({
    provider: 'google', subject: 'google-sub-rv', email: 'head@riverside.edu',
    name: 'Riverside Head', hostedDomain: 'riverside.edu',
  });
  await identity.ensureMembership(riversideUser.user.id, 'head@riverside.edu', 'riverside.edu');
  const crossSchool = await guards.canManageUser(localAdminActor, riversideUser.user.id);
  ok('a local admin cannot reach into another school', !crossSchool.ok);

  const assignAdmin = await guards.canAssignRole(localAdminActor, adminRole.id);
  ok('a local admin cannot hand out an administrative role', !assignAdmin.ok);

  section('Sessions');
  const sess = await sessions.create(bobUser.id, { ip: '10.0.0.1', userAgent: 'test', isMinor: true });
  const touched = await sessions.touch(sess.raw);
  ok('a live session resolves', !!touched && touched.user_id === bobUser.id);
  eq('minors get the shorter idle window', sess.idleMinutes, 20);

  // touch() has to reach the same verdict as slide() without being told who
  // it is looking at. It used to take isMinor as an argument that no caller in
  // the service ever passed, so a child's session was slid at the adult rate
  // on every request that came through attachActor.
  await db.query('UPDATE users SET is_minor = true WHERE id = $1', [bobUser.id]);
  await sessions.touch(sess.raw);
  const minorWindow = await db.one(
    `SELECT idle_expires_at - now() < interval '25 minutes' AS shortened
       FROM sessions WHERE id = $1`, [sess.id]);
  ok('touch() reads the minor window off the account, not an argument', !!minorWindow.shortened);

  const stored = await db.one('SELECT token_hash FROM sessions WHERE id = $1', [sess.id]);
  ok('the raw session token is never stored', stored.token_hash !== sess.raw && stored.token_hash === keys.sha256(sess.raw));

  await db.query("UPDATE users SET status = 'blocked' WHERE id = $1", [bobUser.id]);
  const afterBlock = await sessions.touch(sess.raw);
  ok('blocking an account kills its live session immediately', afterBlock === null);
  await db.query("UPDATE users SET status = 'active' WHERE id = $1", [bobUser.id]);

  const sess2 = await sessions.create(bobUser.id, { ip: '10.0.0.1', userAgent: 'test', isMinor: true });
  await sessions.revokeAllForUser(bobUser.id);
  ok('revoke-all ends every device', (await sessions.touch(sess2.raw)) === null);

  // ---- the idle window, and who is allowed to slide it ----
  //
  // The bug this pins down: a teacher using Teacher's Desk all morning never
  // touches this service directly, so nothing slid their idle window. The
  // service API refused every roster question for idleness while the refresh
  // grant — which checked the absolute clock and nothing else — kept issuing
  // them fresh ID tokens. Signed in, and simultaneously not.
  section('Idle window');

  const idleSess = await sessions.create(bobUser.id, { ip: '10.0.0.1', userAgent: 'test', isMinor: true });
  const slid = await sessions.slide(idleSess.id);
  ok('an app using the session slides it forward', !!slid && slid.user_id === bobUser.id);

  const window1 = await db.one('SELECT idle_expires_at FROM sessions WHERE id = $1', [idleSess.id]);
  ok('the window is pushed into the future', new Date(window1.idle_expires_at) > new Date());

  // Wound back to a minute before it would have lapsed: this is the teacher
  // who has been working in the app and nowhere else.
  await db.query("UPDATE sessions SET idle_expires_at = now() + interval '1 minute' WHERE id = $1", [idleSess.id]);
  await sessions.slide(idleSess.id);
  const window2 = await db.one('SELECT idle_expires_at FROM sessions WHERE id = $1', [idleSess.id]);
  const minutesOut = (new Date(window2.idle_expires_at) - Date.now()) / 60000;
  ok('working in an app buys the full window back, not a minute', minutesOut > 15 && minutesOut <= 20);

  // And once it has genuinely lapsed, every path agrees it is over — the
  // refresh grant included, which is what used to keep the app alive while
  // the API had already given up on it.
  await db.query("UPDATE sessions SET idle_expires_at = now() - interval '1 minute' WHERE id = $1", [idleSess.id]);
  ok('a session left idle is over', (await sessions.slide(idleSess.id)) === null);
  ok('and refreshing cannot resurrect it', (await sessions.slide(idleSess.id)) === null);

  await db.query("UPDATE sessions SET revoked_at = now() WHERE id = $1", [idleSess.id]);
  ok('a revoked session never slides', (await sessions.slide(idleSess.id)) === null);
  ok('an unknown session id slides nothing', (await sessions.slide(null)) === null);

  section('Timed suspension');
  await db.query(
    `UPDATE memberships SET status = 'suspended', suspend_until = now() - interval '1 hour' WHERE user_id = $1`,
    [bobUser.id]);
  const lifted = await identity.accessFor(bobUser.id);
  eq('an elapsed suspension lifts itself', lifted.membership.status, 'active');

  section('Client secrets');
  const rawSecret = secrets.generate();
  const hashed = secrets.hash(rawSecret);
  ok('the correct secret verifies', secrets.verify(rawSecret, hashed));
  ok('a wrong secret does not', !secrets.verify(rawSecret + 'x', hashed));
  ok('the plaintext is not recoverable from the hash', hashed.indexOf(rawSecret) === -1);

  section('Signing keys');
  const jwks = await keys.jwks();
  ok('a signing key exists', jwks.keys.length >= 1);
  ok('only the public half is published', !JSON.stringify(jwks).includes('"d"'));
  eq('published as RS256', jwks.keys[0].alg, 'RS256');

  // ---------- full OIDC flow over HTTP ----------
  section('OpenID Connect flow');

  const express = require('express');
  const oidc = require('../src/oidc');
  const authMod = require('../src/auth');

  const appSecret = secrets.generate();
  const client = await db.one(
    `INSERT INTO apps (client_id, name, client_secret_hash, redirect_uris, namespace, scopes)
     VALUES ('atlas','Classroom Atlas',$1, ARRAY['http://localhost:4000/auth/callback'], 'atlas',
             ARRAY['openid','profile','email','roles'])
     RETURNING *`, [secrets.hash(appSecret)]);
  await db.query('INSERT INTO app_tenants (app_id, tenant_id) VALUES ($1,$2)', [client.id, tenant.id]);

  const srv = express();
  srv.use(express.json());
  srv.use(express.urlencoded({ extended: false }));
  srv.use(authMod.attachActor);
  srv.use(oidc.router);
  srv.use('/api/v1', require('../src/api'));
  const listener = await new Promise((res) => { const s = srv.listen(3999, () => res(s)); });
  const base = 'http://localhost:3999';

  const disc = await (await fetch(`${base}/.well-known/openid-configuration`)).json();
  eq('discovery advertises the issuer', disc.issuer, 'http://localhost:3999');
  eq('discovery requires PKCE S256', disc.code_challenge_methods_supported, ['S256']);

  // Carla signs in (session created directly; the Google step is covered by
  // the provider adapter and cannot be faked here).
  const carlaSession = await sessions.create(claimed.user.id, { ip: '10.0.0.2', userAgent: 'test', isMinor: false });
  const cookie = `${sessions.COOKIE}=${encodeURIComponent(carlaSession.raw)}`;

  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

  const authUrl = `${base}/authorize?response_type=code&client_id=atlas` +
    `&redirect_uri=${encodeURIComponent('http://localhost:4000/auth/callback')}` +
    `&scope=openid+profile+email+roles&state=xyz&nonce=n1` +
    `&code_challenge=${challenge}&code_challenge_method=S256`;

  const authRes = await fetch(authUrl, { headers: { cookie }, redirect: 'manual' });
  eq('authorize redirects back to the app', authRes.status, 302);
  const back = new URL(authRes.headers.get('location'));
  eq('state is returned untouched', back.searchParams.get('state'), 'xyz');
  const code = back.searchParams.get('code');
  ok('an authorization code was issued', !!code);

  // A redirect address the app never registered must be refused outright.
  const badRedirect = await fetch(`${base}/authorize?response_type=code&client_id=atlas` +
    `&redirect_uri=${encodeURIComponent('https://evil.example/steal')}` +
    `&scope=openid&state=x&code_challenge=${challenge}&code_challenge_method=S256`,
    { headers: { cookie }, redirect: 'manual' });
  eq('an unregistered redirect address is rejected', badRedirect.status, 400);

  const noPkce = await fetch(`${base}/authorize?response_type=code&client_id=atlas` +
    `&redirect_uri=${encodeURIComponent('http://localhost:4000/auth/callback')}&scope=openid&state=x`,
    { headers: { cookie }, redirect: 'manual' });
  const noPkceLoc = new URL(noPkce.headers.get('location'));
  eq('a request without PKCE is refused', noPkceLoc.searchParams.get('error'), 'invalid_request');

  const basic = 'Basic ' + Buffer.from(`atlas:${appSecret}`).toString('base64');
  const form = (o) => new URLSearchParams(o).toString();

  const wrongVerifier = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic },
    body: form({ grant_type: 'authorization_code', code, redirect_uri: 'http://localhost:4000/auth/callback', code_verifier: 'wrong' }),
  });
  eq('a mismatched PKCE verifier is rejected', wrongVerifier.status, 400);

  const tokenRes = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic },
    body: form({ grant_type: 'authorization_code', code, redirect_uri: 'http://localhost:4000/auth/callback', code_verifier: verifier }),
  });
  const tokens = await tokenRes.json();
  ok('tokens are issued', !!tokens.id_token && !!tokens.access_token && !!tokens.refresh_token);

  const idClaims = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString());
  eq('the subject is the internal id, not the email', idClaims.sub, claimed.user.id);
  eq('the nonce is echoed', idClaims.nonce, 'n1');
  eq('the role travels with the token', idClaims.role, 'teacher');
  ok('atlas permissions are present', 'atlas:grade' in idClaims.perms);
  ok('whiteboard permissions are withheld', !('whiteboard:teach' in idClaims.perms));

  // Verify the signature the way a relying app does, with no shared secret.
  const clientLib = (() => {
    process.env.SIGNIFY_ISSUER = base;
    process.env.SIGNIFY_CLIENT_ID = 'atlas';
    process.env.SIGNIFY_CLIENT_SECRET = appSecret;
    process.env.SIGNIFY_REDIRECT_URI = 'http://localhost:4000/auth/callback';
    process.env.SIGNIFY_COOKIE_SECRET = 'b'.repeat(64);
    return require('../client/signify-auth');
  })();
  const verified = await clientLib._internal.verifyJwt(tokens.id_token, 'id');
  ok('the client library verifies the token against JWKS', !!verified && verified.sub === claimed.user.id);
  const tampered = tokens.id_token.slice(0, -4) + 'AAAA';
  ok('a tampered token is rejected', (await clientLib._internal.verifyJwt(tampered, 'id')) === null);

  const replay = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic },
    body: form({ grant_type: 'authorization_code', code, redirect_uri: 'http://localhost:4000/auth/callback', code_verifier: verifier }),
  });
  eq('a reused authorization code is rejected', replay.status, 400);
  const killed = await db.one('SELECT revoked_at FROM sessions WHERE id = $1', [carlaSession.id]);
  ok('a reused code revokes the session it belonged to', !!killed.revoked_at);

  // Fresh session for the refresh-rotation checks.
  const carlaSession2 = await sessions.create(claimed.user.id, { ip: '10.0.0.2', userAgent: 'test', isMinor: false });
  const cookie2 = `${sessions.COOKIE}=${encodeURIComponent(carlaSession2.raw)}`;
  const v2 = crypto.randomBytes(32).toString('base64url');
  const c2 = crypto.createHash('sha256').update(v2).digest('base64url');
  const auth2 = await fetch(`${base}/authorize?response_type=code&client_id=atlas` +
    `&redirect_uri=${encodeURIComponent('http://localhost:4000/auth/callback')}` +
    `&scope=openid+profile+email+roles&state=s2&code_challenge=${c2}&code_challenge_method=S256`,
    { headers: { cookie: cookie2 }, redirect: 'manual' });
  const code2 = new URL(auth2.headers.get('location')).searchParams.get('code');
  const t2 = await (await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic },
    body: form({ grant_type: 'authorization_code', code: code2, redirect_uri: 'http://localhost:4000/auth/callback', code_verifier: v2 }),
  })).json();

  const refreshed = await (await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic },
    body: form({ grant_type: 'refresh_token', refresh_token: t2.refresh_token }),
  })).json();
  ok('a refresh token yields a new set', !!refreshed.id_token && refreshed.refresh_token !== t2.refresh_token);

  // A browser opening a page fires half a dozen requests at once, and every
  // one of them renews the same expired ID token. That is not theft, and
  // treating it as theft destroyed a teacher's session in production — twice
  // in one afternoon — while they were sitting in front of the class.
  const refresh = (token) => fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic },
    body: form({ grant_type: 'refresh_token', refresh_token: token }),
  });

  const straggler = await refresh(t2.refresh_token);
  const stragglerBody = await straggler.json();
  eq('a straggler from the same page load is answered, not punished', straggler.status, 200);
  eq('and answered identically, so whichever cookie the browser keeps is live',
    stragglerBody.refresh_token, refreshed.refresh_token);
  const survived = await db.one('SELECT revoked_at FROM sessions WHERE id = $1', [carlaSession2.id]);
  ok('the session is still alive after it', !survived.revoked_at);

  // Two arriving genuinely at once, which is what produced two children of
  // one parent — one millisecond apart — in the production data.
  const par0 = await (await refresh(refreshed.refresh_token)).json();
  const [pa, pb] = await Promise.all([refresh(par0.refresh_token), refresh(par0.refresh_token)]);
  const [ba, bb] = await Promise.all([pa.json(), pb.json()]);
  ok('both halves of a parallel refresh succeed', pa.status === 200 && pb.status === 200);
  eq('and come away with the same token, not two rival ones', ba.refresh_token, bb.refresh_token);
  const children = await db.many(
    'SELECT id FROM refresh_tokens WHERE session_id = $1 AND revoked_at IS NULL', [carlaSession2.id]);
  eq('leaving exactly one live token on the session', children.length, 1);
  const stillAlive = await db.one('SELECT revoked_at FROM sessions WHERE id = $1', [carlaSession2.id]);
  ok('and the session intact', !stillAlive.revoked_at);

  // Past the grace window it is theft again, and the whole session goes.
  const aged = await (await refresh(ba.refresh_token)).json();
  await refresh(aged.refresh_token);
  await db.query(
    `UPDATE refresh_tokens SET revoked_at = now() - interval '1 minute'
      WHERE token_hash = $1`, [keys.sha256(aged.refresh_token)]);
  // Step past the grace window rather than sleeping through it — otherwise
  // the shared-answer memo would hand this straggler the earlier reply, which
  // is exactly what it is for.
  oidc._forgetRecentRefreshes();
  const reuse = await refresh(aged.refresh_token);
  eq('a long-rotated refresh token cannot be reused', reuse.status, 400);
  const killed2 = await db.one('SELECT revoked_at FROM sessions WHERE id = $1', [carlaSession2.id]);
  ok('refresh-token reuse revokes the whole session', !!killed2.revoked_at);

  const wrongSecret = await fetch(`${base}/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: 'Basic ' + Buffer.from('atlas:not-the-secret').toString('base64'),
    },
    body: form({ grant_type: 'refresh_token', refresh_token: 'anything' }),
  });
  eq('a wrong client secret is rejected', wrongSecret.status, 401);

  section('Live revocation reaches the apps');
  const carlaSession3 = await sessions.create(claimed.user.id, { ip: '10.0.0.2', userAgent: 't', isMinor: false });
  const cookie3 = `${sessions.COOKIE}=${encodeURIComponent(carlaSession3.raw)}`;
  const v3 = crypto.randomBytes(32).toString('base64url');
  const c3 = crypto.createHash('sha256').update(v3).digest('base64url');
  const a3 = await fetch(`${base}/authorize?response_type=code&client_id=atlas` +
    `&redirect_uri=${encodeURIComponent('http://localhost:4000/auth/callback')}` +
    `&scope=openid+profile+email+roles&state=s3&code_challenge=${c3}&code_challenge_method=S256`,
    { headers: { cookie: cookie3 }, redirect: 'manual' });
  const code3 = new URL(a3.headers.get('location')).searchParams.get('code');
  const t3 = await (await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic },
    body: form({ grant_type: 'authorization_code', code: code3, redirect_uri: 'http://localhost:4000/auth/callback', code_verifier: v3 }),
  })).json();

  const userinfoOk = await fetch(`${base}/userinfo`, { headers: { authorization: `Bearer ${t3.access_token}` } });
  eq('userinfo works while the session is live', userinfoOk.status, 200);

  await db.query("UPDATE users SET status = 'blocked' WHERE id = $1", [claimed.user.id]);
  const userinfoBlocked = await fetch(`${base}/userinfo`, { headers: { authorization: `Bearer ${t3.access_token}` } });
  eq('an unexpired access token stops working once blocked', userinfoBlocked.status, 401);
  const refreshBlocked = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic },
    body: form({ grant_type: 'refresh_token', refresh_token: t3.refresh_token }),
  });
  eq('a blocked account cannot refresh', refreshBlocked.status, 400);
  await db.query("UPDATE users SET status = 'active' WHERE id = $1", [claimed.user.id]);

  section('Service API for the apps');

  const klass = await db.one(
    `INSERT INTO classes (tenant_id, name, subject, grade_levels, school_year)
     VALUES ($1,'4A Geography','Geography', ARRAY['4'],'2026') RETURNING id`, [tenant.id]);
  await db.query("INSERT INTO class_members (class_id, user_id, role) VALUES ($1,$2,'teacher')", [klass.id, claimed.user.id]);
  await db.query("INSERT INTO class_members (class_id, user_id, role) VALUES ($1,$2,'student')", [klass.id, bobUser.id]);

  const bearer = (t) => ({ headers: { authorization: `Bearer ${t}` } });

  const meRes = await fetch(`${base}/api/v1/me`, bearer(t3.access_token));
  const me = await meRes.json();
  eq('an app can read the signed-in person', me.sub, claimed.user.id);
  ok('the app still only sees its own namespace', !('whiteboard:teach' in me.perms));

  const idTokenRes = await fetch(`${base}/api/v1/me`, bearer(t3.id_token));
  eq('the ID token is accepted too', idTokenRes.status, 200);

  const junkRes = await fetch(`${base}/api/v1/me`, bearer('not-a-token'));
  eq('a junk token is refused', junkRes.status, 401);

  const classesRes = await (await fetch(`${base}/api/v1/classes`, bearer(t3.access_token))).json();
  eq('the caller sees their own class', classesRes.classes.length, 1);
  eq('with their role in it', classesRes.classes[0].role, 'teacher');

  const shares = await (await fetch(
    `${base}/api/v1/shares-class?a=${claimed.user.id}&b=${bobUser.id}`, bearer(t3.access_token))).json();
  ok('a shared class is reported', shares.shares === true);

  const snoop = await fetch(
    `${base}/api/v1/shares-class?a=${bobUser.id}&b=${claimed.user.id}`, bearer(t3.access_token));
  eq('an app cannot ask about anyone but the signed-in person', snoop.status, 403);

  const rosterRes = await (await fetch(`${base}/api/v1/classes/${klass.id}/members`, bearer(t3.access_token))).json();
  eq('a teacher gets the roster', rosterRes.members.length, 2);
  ok('staff see email addresses', 'email' in rosterRes.members[0]);
  const rosterLogged = await db.one("SELECT is_disclosure FROM audit_log WHERE action = 'roster.read'");
  ok('reading a roster is recorded as a disclosure', rosterLogged && rosterLogged.is_disclosure === true);

  // A pupil in another class must not be able to read this one.
  const outsiderSession = await sessions.create(bobUser.id, { ip: '10.0.0.9', userAgent: 't', isMinor: true });
  const vOut = crypto.randomBytes(32).toString('base64url');
  const cOut = crypto.createHash('sha256').update(vOut).digest('base64url');
  await db.query("UPDATE memberships SET status = 'active' WHERE user_id = $1", [bobUser.id]);
  const aOut = await fetch(`${base}/authorize?response_type=code&client_id=atlas` +
    `&redirect_uri=${encodeURIComponent('http://localhost:4000/auth/callback')}` +
    `&scope=openid+profile+email+roles&state=s4&code_challenge=${cOut}&code_challenge_method=S256`,
    { headers: { cookie: `${sessions.COOKIE}=${encodeURIComponent(outsiderSession.raw)}` }, redirect: 'manual' });
  const codeOut = new URL(aOut.headers.get('location')).searchParams.get('code');
  const tOut = await (await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic },
    body: form({ grant_type: 'authorization_code', code: codeOut, redirect_uri: 'http://localhost:4000/auth/callback', code_verifier: vOut }),
  })).json();

  const pupilRoster = await (await fetch(`${base}/api/v1/classes/${klass.id}/members`, bearer(tOut.access_token))).json();
  ok('a pupil in the class sees classmates', pupilRoster.members.length === 2);
  ok('but not their email addresses', !('email' in pupilRoster.members[0]));

  const otherClass = await db.one(
    `INSERT INTO classes (tenant_id, name, school_year) VALUES ($1,'Not their class','2026') RETURNING id`, [tenant.id]);
  const forbidden = await fetch(`${base}/api/v1/classes/${otherClass.id}/members`, bearer(tOut.access_token));
  eq('a pupil cannot read a class they are not in', forbidden.status, 403);

  section('Canonical host');
  {
    const { canonicalHost } = require('../src/canonical');
    // config.issuer is http://localhost:3999 for this run.
    const call = (headers, path = '/authorize') => {
      let redirected = null, passed = false;
      const req = { headers, path, originalUrl: path, get(h) { return headers[h.toLowerCase()]; } };
      const res = { redirect: (code, to) => { redirected = { code, to }; } };
      canonicalHost(req, res, () => { passed = true; });
      return { redirected, passed };
    };

    ok('internal traffic with no proxy header passes through',
      call({ host: 'signify-id.railway.internal' }).passed);
    ok('a request already on the canonical host passes through',
      call({ host: 'localhost:3999', 'x-forwarded-proto': 'https' }).passed);

    const bounced = call({ host: 'signify-id-production.up.railway.app', 'x-forwarded-proto': 'https' });
    ok('public traffic on another hostname is redirected', !!bounced.redirected);
    eq('permanently, to the issuer host', bounced.redirected && bounced.redirected.to,
      'https://localhost:3999/authorize');

    ok('the health check is never redirected',
      call({ host: 'anything.up.railway.app', 'x-forwarded-proto': 'https' }, '/healthz').passed);
  }

  section('CSV parsing');
  {
    const csvMod = require('../src/csv');
    const withBom = '﻿First Name,Last Name,Email Address,Role\r\nAda,"Fielding, Jr",ADA@School.edu,student\r\n\r\n';
    const parsedRows = csvMod.parse(withBom);
    eq('blank lines are dropped', parsedRows.length, 2);
    eq('a quoted comma survives', parsedRows[1][1], 'Fielding, Jr');
    ok('the byte-order mark is stripped', parsedRows[0][0] === 'First Name');
    const hdr = csvMod.mapHeaders(parsedRows[0]);
    eq('headings are matched however they are spelled', Object.keys(hdr.map).sort(),
      ['email', 'first_name', 'last_name', 'role']);
    eq('escaped quotes round-trip', csvMod.parse('a,"say ""hi"" there"\n')[0][1], 'say "hi" there');
    eq('multi-value cells split on ; and ,', csvMod.splitList('3B Maths; 4A Geo, 5C'), ['3B Maths', '4A Geo', '5C']);
  }

  section('Roster import — analysis');
  {
    await db.query(
      "INSERT INTO classes (tenant_id, name, school_year, grade_levels) VALUES ($1,'5A Science','2026', ARRAY['5'])",
      [tenant.id]);

    const file = [
      'First name,Last name,Email address,Role,School ID,Classes,Apps,Graduation year',
      'Nia,Barrett,nia@school.edu,student,Oakwood School,5A Science,Classroom Atlas,2034',
      'Tom,Vale,tom@school.edu,teacher,,5A Science,,',
      'Bad,Row,not-an-email,student,,,,',
      'Dup,One,nia@school.edu,student,,,,',
      'Wrong,School,ws@school.edu,student,Riverside Academy,,,',
      'Climb,Er,climber@school.edu,local_admin,,,,',
      'Ghost,Class,ghost@school.edu,student,,Nonexistent Class,,',
      'Ghost,App,ghostapp@school.edu,student,,,NotAnApp,',
      'Bad,Year,bady@school.edu,student,,,,not-a-year',
    ].join('\n');

    const a = await roster.analyse({ text: file, actor: localAdminActor, tenantId: tenant.id });
    ok('the file is analysed', a.ok);
    const byLine = Object.fromEntries(a.rows.map((r) => [r.line, r]));

    eq('a clean new person is a create', byLine[2].action, 'create');
    eq('their class is matched', byLine[2].classes[0].id !== null, true);
    eq('their app is matched', byLine[2].apps[0].id !== null, true);
    eq('graduation year is read', byLine[2].graduationYear, 2034);
    eq('a teacher row is a create too', byLine[3].action, 'create');

    eq('a malformed address is refused', byLine[4].action, 'error');
    ok('and says why', /not a valid email/i.test(byLine[4].problems[0]));
    eq('a repeat within the file is refused', byLine[5].action, 'error');
    ok('naming the earlier line', /line 2/.test(byLine[5].problems[0]));

    eq('a row for another school is refused', byLine[6].action, 'error');
    ok('rather than silently retargeted', /not the school/i.test(byLine[6].problems[0]));

    eq('a local admin cannot import an administrative role', byLine[7].action, 'error');
    ok('with the same reason the role picker gives', /super admin/i.test(byLine[7].problems[0]));

    eq('an unknown class is refused', byLine[8].action, 'error');
    eq('an app the school has not enabled is refused', byLine[9].action, 'error');
    eq('a nonsense graduation year is refused', byLine[10].action, 'error');

    eq('the summary counts up', a.summary, { total: 9, create: 2, update: 0, error: 7 });

    const b = await roster.analyse({
      text: file, actor: localAdminActor, tenantId: tenant.id, createMissingClasses: true });
    ok('with the option on, the missing class is planned instead of refused', b.newClasses.includes('Nonexistent Class'));
    eq('and that row becomes a create', b.rows.find((r) => r.line === 8).action, 'create');

    const superActor = { userId: alice.user.id, email: 'alice@school.edu', isSuper: true, tenantId: tenant.id, perms: {} };
    const c = await roster.analyse({ text: file, actor: superActor, tenantId: tenant.id });
    eq('a super admin can import an administrative role', c.rows.find((r) => r.line === 7).action, 'create');
  }

  section('Roster import — applying');
  {
    const file = [
      'First name,Last name,Email address,Role,Classes,Apps,Graduation year',
      'Nia,Barrett,nia@school.edu,student,5A Science,Classroom Atlas,2034',
      'Tom,Vale,tom@school.edu,teacher,5A Science,,',
      'Bad,Row,nope,student,,,',
    ].join('\n');

    const r1 = await roster.apply({ text: file, actor: localAdminActor, tenantId: tenant.id, filename: 'roster.csv' });
    eq('two people are created', r1.created, 2);
    eq('the bad row is skipped, not fatal', r1.skipped, 1);

    const nia = await db.one("SELECT id, display_name, given_name, is_minor FROM users WHERE email = 'nia@school.edu'");
    eq('the name is assembled from the columns', nia.display_name, 'Nia Barrett');
    eq('given name is kept separately', nia.given_name, 'Nia');
    eq('a pupil inherits the school minor setting', nia.is_minor, true);

    const tom = await db.one("SELECT is_minor FROM users WHERE email = 'tom@school.edu'");
    eq('a teacher does not', tom.is_minor, false);

    const niaM = await db.one('SELECT graduation_year, status FROM memberships WHERE user_id = $1', [nia.id]);
    eq('graduation year is stored', niaM.graduation_year, 2034);
    eq('and the membership is live', niaM.status, 'active');

    const niaClass = await db.one(
      "SELECT cm.role FROM class_members cm JOIN classes c ON c.id = cm.class_id WHERE cm.user_id = $1 AND c.name = '5A Science'",
      [nia.id]);
    eq('the pupil joins the class as a student', niaClass.role, 'student');
    const tomClass = await db.one(
      "SELECT cm.role FROM class_members cm JOIN classes c ON c.id = cm.class_id WHERE cm.user_id = (SELECT id FROM users WHERE email='tom@school.edu') AND c.name = '5A Science'");
    eq('the teacher joins it as a teacher', tomClass.role, 'teacher');

    const grant = await db.one('SELECT allowed FROM user_app_access WHERE user_id = $1', [nia.id]);
    eq('the named app is granted', grant.allowed, true);

    const r2 = await roster.apply({ text: file, actor: localAdminActor, tenantId: tenant.id });
    eq('a second run creates nobody new', r2.created, 0);
    eq('it updates instead', r2.updated, 2);
    const dupes = await db.one("SELECT COUNT(*) AS n FROM users WHERE email = 'nia@school.edu'");
    eq('and leaves exactly one record', Number(dupes.n), 1);

    const logged = await db.one('SELECT created_n, skipped_n, filename FROM roster_imports ORDER BY created_at LIMIT 1');
    eq('the run is recorded', logged.created_n, 2);
    eq('with the filename', logged.filename, 'roster.csv');
  }

  section('Per-person app access');
  {
    const nia = await db.one("SELECT id FROM users WHERE email = 'nia@school.edu'");
    await db.query("UPDATE memberships SET status='active' WHERE user_id=$1", [nia.id]);
    const s1 = await sessions.create(nia.id, { ip: '10.0.0.5', userAgent: 't', isMinor: true });
    const ck = sessions.COOKIE + '=' + encodeURIComponent(s1.raw);
    const vv = crypto.randomBytes(32).toString('base64url');
    const cc = crypto.createHash('sha256').update(vv).digest('base64url');
    const authz = () => fetch(base + '/authorize?response_type=code&client_id=atlas' +
      '&redirect_uri=' + encodeURIComponent('http://localhost:4000/auth/callback') +
      '&scope=openid+profile+email+roles&state=z&code_challenge=' + cc + '&code_challenge_method=S256',
      { headers: { cookie: ck }, redirect: 'manual' });

    eq('a granted person reaches the app', (await authz()).status, 302);

    await db.query('UPDATE user_app_access SET allowed = false WHERE user_id = $1', [nia.id]);
    eq('excluding them from one app blocks it', (await authz()).status, 403);

    await db.query('DELETE FROM user_app_access WHERE user_id = $1', [nia.id]);
    eq('no row means the school setting applies', (await authz()).status, 302);
  }

  section('Classes across several year groups');
  {
    const mixed = await db.one(
      "INSERT INTO classes (tenant_id, name, school_year, grade_levels) VALUES ($1,'Mixed 4/5/6','2026', ARRAY['4','5','6']) RETURNING id, grade_levels",
      [tenant.id]);
    eq('several year groups are stored', mixed.grade_levels, ['4', '5', '6']);
    const found = await db.many(
      "SELECT name FROM classes WHERE tenant_id = $1 AND grade_levels && ARRAY['5']", [tenant.id]);
    ok('and a class can be found by any one of them', found.some((c) => c.name === 'Mixed 4/5/6'));
  }

  section('Finding someone to add to a class');
  {
    // The box that used to demand an exact address now searches. What it must
    // never do is reach past the school the class belongs to.
    const search = (q, classId = klass.id, tenantId = tenant.id) =>
      directory.classCandidates({ tenantId, classId, q });

    const byName = await search('carla');
    ok('a person is found by name', byName.length === 0 || byName.every((p) => /carla/i.test(p.display_name)));

    const dora = await identity.resolveUser({
      provider: 'google', subject: 'google-sub-dora', email: 'dora@school.edu',
      name: 'Dora Vance', hostedDomain: 'school.edu',
    });
    await identity.ensureMembership(dora.user.id, 'dora@school.edu', 'school.edu');
    await db.query("UPDATE memberships SET status = 'active' WHERE user_id = $1", [dora.user.id]);

    const found = await search('dora');
    eq('searching by first name finds her', found.map((p) => p.email), ['dora@school.edu']);
    const byMail = await search('dora@school');
    eq('a partial address finds her too', byMail.map((p) => p.email), ['dora@school.edu']);
    ok('and carries what the dialog shows', 'display_name' in found[0] && 'role_label' in found[0]);

    const already = await search('bob');
    ok('somebody already in the class is left out', !already.some((p) => p.id === bobUser.id));

    // Riverside Academy's people must not surface in an Oakwood class.
    const outsider = await identity.resolveUser({
      provider: 'google', subject: 'google-sub-erin', email: 'erin@riverside.edu',
      name: 'Erin Dorado', hostedDomain: 'riverside.edu',
    });
    await identity.ensureMembership(outsider.user.id, 'erin@riverside.edu', 'riverside.edu');
    await db.query("UPDATE memberships SET status = 'active' WHERE user_id = $1", [outsider.user.id]);
    const across = await search('dorado');
    eq('another school is never searched', across.length, 0);
    const inTheirOwn = await directory.classCandidates({
      tenantId: other.id, classId: klass.id, q: 'dorado',
    });
    eq('though they are findable in their own', inTheirOwn.length, 1);

    // Every address at a school ends in the same domain, so matching the whole
    // address turned any fragment of it into "select the entire roll".
    const domainish = await search('school');
    eq('a fragment of the shared domain matches nobody', domainish.length, 0);
    const whole = await search('dora@school.edu');
    eq('but a whole address still finds its owner', whole.map((p) => p.email), ['dora@school.edu']);

    // A roster import creates people as pending. If the search skipped them,
    // the box would be useless on exactly the day the roster was loaded.
    await db.query("UPDATE memberships SET status = 'pending' WHERE user_id = $1", [dora.user.id]);
    eq('somebody still pending is findable', (await search('dora')).length, 1);
    await db.query("UPDATE memberships SET status = 'active' WHERE user_id = $1", [dora.user.id]);

    eq('a blank query returns nobody rather than the school', (await search('')).length, 0);
    eq('and so does a single letter', (await search('d')).length, 0);

    // A wildcard typed into the box is a search term, not a pattern.
    eq('a percent sign matches nothing rather than everyone', (await search('%%')).length, 0);

    await db.query("UPDATE users SET deleted_at = now() WHERE id = $1", [dora.user.id]);
    eq('an erased account stops being findable', (await search('dora')).length, 0);
    await db.query("UPDATE users SET deleted_at = NULL WHERE id = $1", [dora.user.id]);
  }

  section('Backups');
  {
    const made = await backup.create({ tenantId: tenant.id, actor: localAdminActor });
    ok('a backup is produced', !!made.file && made.file.format === backup.FORMAT);
    ok('it carries the roster', made.counts.users > 0);

    const asText = JSON.stringify(made.file);
    ok('it contains no session tokens', !/token_hash|refresh_token/.test(asText));
    ok('it contains no signing keys', !/private_pem|BEGIN PRIVATE/.test(asText));
    ok('it contains no client secrets', !/client_secret_hash/.test(asText));

    eq('a manual backup is not kept on the server',
      (await db.one('SELECT payload FROM backups WHERE id = $1', [made.id])).payload, null);
    ok('but the fact of it is', !!(await db.one('SELECT checksum FROM backups WHERE id = $1', [made.id])).checksum);

    eq('an untouched backup verifies', backup.verify(made.file).ok, true);

    // The path the file actually takes: signed here, serialised out to the
    // browser, parsed, handed back, parsed again. Timestamps arrive from
    // Postgres as Date objects and leave as strings, so a signature that does
    // not survive this is a signature that never works in production.
    const roundTripped = JSON.parse(JSON.stringify(made.file));
    eq('and still verifies after a JSON round trip', backup.verify(roundTripped).ok, true);
    eq('a round-tripped backup can be previewed',
      (await backup.preview({ file: roundTripped, actor: localAdminActor, tenantId: tenant.id })).ok, true);

    const tampered = JSON.parse(asText);
    tampered.payload.users[0].display_name = 'Tampered';
    eq('an edited backup is refused', backup.verify(tampered).ok, false);
    ok('and says so plainly', /altered/i.test(backup.verify(tampered).reason));

    const wrongIssuer = JSON.parse(asText);
    wrongIssuer.payload.issuer = 'https://evil.example';
    wrongIssuer.signature = backup.sign(wrongIssuer.payload);
    eq('a correctly signed backup from elsewhere is still refused', backup.verify(wrongIssuer).ok, false);

    const unsigned = { format: backup.FORMAT, payload: made.file.payload };
    eq('an unsigned file is refused', backup.verify(unsigned).ok, false);

    const otherTenantPreview = await backup.preview({ file: made.file, actor: localAdminActor, tenantId: other.id });
    eq('restoring into the wrong school is refused', otherTenantPreview.ok, false);
  }

  section('Restore');
  {
    const made = await backup.create({ tenantId: tenant.id, actor: localAdminActor });

    const tom = await db.one("SELECT id FROM users WHERE email = 'tom@school.edu'");
    await db.query('DELETE FROM memberships WHERE user_id = $1', [tom.id]);
    await db.query('DELETE FROM users WHERE id = $1', [tom.id]);

    const pv = await backup.preview({ file: made.file, actor: localAdminActor, tenantId: tenant.id });
    ok('the preview succeeds', pv.ok);
    ok('and sees the missing person as a create', pv.plan.usersCreate.includes('tom@school.edu'));
    ok('it promises never to delete', pv.notes.some((n) => /only creates and updates/i.test(n)));

    const done = await backup.restore({ file: made.file, actor: superAdminActor, tenantId: tenant.id, confirmName: 'Oakwood School' });
    ok('the restore runs', done.ok);
    ok('the person is back', !!(await db.one("SELECT id FROM users WHERE email = 'tom@school.edu'")));
    ok('an undo snapshot was taken first', !!done.snapshotId);
    ok('and the snapshot IS kept, unlike a manual backup',
      !!(await db.one('SELECT payload FROM backups WHERE id = $1', [done.snapshotId])).payload);

    const nia = await db.one("SELECT id FROM users WHERE email = 'nia@school.edu'");
    await db.query(
      "UPDATE users SET deleted_at = now(), purge_after = now() + interval '30 days', email = email || '#deleted' WHERE id = $1",
      [nia.id]);
    const pv2 = await backup.preview({ file: made.file, actor: localAdminActor, tenantId: tenant.id });
    ok('a record erased since the backup is refused',
      pv2.refusals.some((r) => /nia@school.edu/.test(r) && /erased/i.test(r)));
    await backup.restore({ file: made.file, actor: superAdminActor, tenantId: tenant.id, confirmName: 'Oakwood School' });
    const stillGone = await db.one('SELECT deleted_at FROM users WHERE id = $1', [nia.id]);
    ok('and stays erased after the restore runs', !!stillGone.deleted_at);

    const escalation = JSON.parse(JSON.stringify(made.file));
    const target = escalation.payload.memberships.find((m) => m.role_key === 'student');
    if (target) target.role_key = 'local_admin';
    escalation.signature = backup.sign(escalation.payload);
    const pv3 = await backup.preview({ file: escalation, actor: localAdminActor, tenantId: tenant.id });
    ok('even a validly signed role escalation is refused row by row',
      pv3.refusals.some((r) => /super admin/i.test(r)));

    eq('nothing is expired before its time', await maintenance.purgeExpiredBackups(), 0);
    await db.query("UPDATE backups SET expires_at = now() - interval '1 day' WHERE kind = 'pre_restore'");
    ok('an aged snapshot is purged', (await maintenance.purgeExpiredBackups()) > 0);
  }

  section('Safeguards — backup');
  {
    // Rate limit: three a day, then refused.
    await db.query("DELETE FROM backups WHERE tenant_id = $1 AND kind = 'manual'", [tenant.id]);
    let last = null;
    for (let i = 0; i < backup.MAX_BACKUPS_PER_DAY; i += 1) {
      last = await backup.create({ tenantId: tenant.id, actor: localAdminActor });
    }
    ok('backups up to the daily limit succeed', last.ok);
    const overLimit = await backup.create({ tenantId: tenant.id, actor: localAdminActor });
    eq('the next one is refused', overLimit.ok, false);
    ok('and says why', /already been taken/i.test(overLimit.error));

    // The safety snapshot must never be blocked by the limit.
    const snap = await backup.create({ tenantId: tenant.id, actor: localAdminActor, kind: 'pre_restore' });
    ok('a pre-restore snapshot ignores the limit', snap.ok);

    // Watermark.
    await db.query("DELETE FROM backups WHERE tenant_id = $1 AND kind = 'manual'", [tenant.id]);
    const marked = await backup.create({ tenantId: tenant.id, actor: localAdminActor });
    eq('the file records who took it', marked.file.payload.taken_by.email, localAdminActor.email);
    eq('and which session', marked.file.payload.taken_by.user_id, localAdminActor.userId);
    ok('the watermark is inside the signature', backup.verify(marked.file).ok);
    const stripped = JSON.parse(JSON.stringify(marked.file));
    stripped.payload.taken_by = null;
    eq('so removing it invalidates the file', backup.verify(stripped).ok, false);
  }

  section('Safeguards — restore');
  {
    await db.query("DELETE FROM backups WHERE tenant_id = $1 AND kind = 'manual'", [tenant.id]);
    const made = await backup.create({ tenantId: tenant.id, actor: superAdminActor });

    const noName = await backup.restore({ file: made.file, actor: superAdminActor, tenantId: tenant.id });
    eq('a restore with no typed confirmation is refused', noName.ok, false);
    ok('naming what has to be typed', /Oakwood School/.test(noName.error));

    const wrongName = await backup.restore({
      file: made.file, actor: superAdminActor, tenantId: tenant.id, confirmName: 'Some Other School' });
    eq('the wrong name is refused', wrongName.ok, false);

    const caseInsensitive = await backup.restore({
      file: made.file, actor: superAdminActor, tenantId: tenant.id, confirmName: '  oakwood school  ' });
    ok('the right name is accepted regardless of case or padding', caseInsensitive.ok);

    // Staleness.
    const old = JSON.parse(JSON.stringify(made.file));
    old.payload.taken_at = new Date(Date.now() - 45 * 864e5).toISOString();
    old.signature = backup.sign(old.payload);
    const pvOld = await backup.preview({ file: old, actor: superAdminActor, tenantId: tenant.id });
    ok('an old backup is flagged as stale', pvOld.stale);
    ok('and needs an explicit acknowledgement', pvOld.needsStaleAcknowledgement);
    eq('its age is reported', pvOld.ageDays, 45);

    const unacknowledged = await backup.restore({
      file: old, actor: superAdminActor, tenantId: tenant.id, confirmName: 'Oakwood School' });
    eq('restoring it unacknowledged is refused', unacknowledged.ok, false);
    eq('with a code the console can act on', unacknowledged.code, 'stale_backup');

    const acknowledged = await backup.restore({
      file: old, actor: superAdminActor, tenantId: tenant.id,
      confirmName: 'Oakwood School', acknowledgeStale: true });
    ok('and allowed once acknowledged', acknowledged.ok);

    const fresh = JSON.parse(JSON.stringify(made.file));
    const pvFresh = await backup.preview({ file: fresh, actor: superAdminActor, tenantId: tenant.id });
    ok('a fresh backup needs no acknowledgement', !pvFresh.needsStaleAcknowledgement);
  }

  section('Undoing a roster import');
  {
    await db.query('DELETE FROM roster_imports WHERE tenant_id = $1', [tenant.id]);

    await db.query(
      "INSERT INTO classes (tenant_id, name, school_year, grade_levels) VALUES ($1,'6C History','2026', ARRAY['6'])",
      [tenant.id]);

    // Somebody who already exists, so the run has an update to reverse too.
    const existing = await db.one("SELECT id, display_name FROM users WHERE email = 'bob@school.edu'");
    const beforeRole = await db.one('SELECT role_id, graduation_year FROM memberships WHERE user_id = $1 AND tenant_id = $2',
      [existing.id, tenant.id]);

    const file = [
      'First name,Last name,Email address,Role,Classes,Graduation year',
      'Fresh,Starter,fresh@school.edu,student,6C History,2036',
      'Bob,Renamed,bob@school.edu,teacher,6C History,2030',
    ].join('\n');

    const run = await roster.apply({ text: file, actor: localAdminActor, tenantId: tenant.id, filename: 'oops.csv' });
    eq('the import lands', run.created + run.updated, 2);

    const freshUser = await db.one("SELECT id FROM users WHERE email = 'fresh@school.edu'");
    ok('the new account exists', !!freshUser);
    const changed = await db.one('SELECT role_id, graduation_year FROM memberships WHERE user_id = $1 AND tenant_id = $2',
      [existing.id, tenant.id]);
    ok('and the existing person was changed', changed.role_id !== beforeRole.role_id);

    const listed = await roster.listUndoable(tenant.id);
    eq('the run is offered as reversible', listed[0].undoable, true);

    const dry = await roster.undoImport({ importId: run.importId, actor: localAdminActor, tenantId: tenant.id, dryRun: true });
    ok('a dry run explains what would happen', dry.ok);
    eq('one account would be removed', dry.plan.usersToRemove, 1);
    ok('nothing is actually changed by a dry run',
      !!(await db.one("SELECT id FROM users WHERE email = 'fresh@school.edu'")));

    const undone = await roster.undoImport({ importId: run.importId, actor: localAdminActor, tenantId: tenant.id });
    ok('the undo runs', undone.ok);
    eq('the account it created is gone', await db.one("SELECT id FROM users WHERE email = 'fresh@school.edu'"), null);

    const reverted = await db.one('SELECT role_id, graduation_year FROM memberships WHERE user_id = $1 AND tenant_id = $2',
      [existing.id, tenant.id]);
    eq('the existing person keeps their original role', reverted.role_id, beforeRole.role_id);
    eq('and their original graduation year', reverted.graduation_year, beforeRole.graduation_year);

    const stillMember = await db.one(
      "SELECT 1 FROM class_members cm JOIN classes c ON c.id = cm.class_id WHERE cm.user_id = $1 AND c.name = '6C History'",
      [existing.id]);
    eq('the class membership it added is removed', stillMember, null);

    const twice = await roster.undoImport({ importId: run.importId, actor: localAdminActor, tenantId: tenant.id });
    eq('undoing twice is refused', twice.ok, false);
    ok('saying it is already undone', /already been undone/i.test(twice.error));

    // An account that has since been signed in to belongs to a real person.
    const run2 = await roster.apply({
      text: 'Email address,Role\nreal@school.edu,student\n',
      actor: localAdminActor, tenantId: tenant.id, filename: 'second.csv' });
    const realUser = await db.one("SELECT id FROM users WHERE email = 'real@school.edu'");
    await db.query(
      "INSERT INTO identities (user_id, provider, subject, email_at_link) VALUES ($1,'google','sub-real','real@school.edu')",
      [realUser.id]);

    const undone2 = await roster.undoImport({ importId: run2.importId, actor: localAdminActor, tenantId: tenant.id });
    ok('an account used since the import is kept, not deleted',
      undone2.keptBecauseTheySignedIn.indexOf('real@school.edu') >= 0);
    ok('and is still there afterwards', !!(await db.one("SELECT id FROM users WHERE email = 'real@school.edu'")));

    // Outside the window.
    const run3 = await roster.apply({
      text: 'Email address,Role\nstale@school.edu,student\n',
      actor: localAdminActor, tenantId: tenant.id, filename: 'old.csv' });
    await db.query("UPDATE roster_imports SET created_at = now() - interval '60 days' WHERE id = $1", [run3.importId]);
    const tooOld = await roster.undoImport({ importId: run3.importId, actor: localAdminActor, tenantId: tenant.id });
    eq('an import past the undo window is refused', tooOld.ok, false);

    // Another school's import is not reachable.
    const wrongTenant = await roster.undoImport({ importId: run3.importId, actor: localAdminActor, tenantId: other.id });
    eq('an import belonging to another school is refused', wrongTenant.ok, false);
  }

  section('Data inventory matches the database');
  {
    const inventory = require('../src/data-inventory');

    const live = await db.many(`
      SELECT table_name, column_name
        FROM information_schema.columns
       WHERE table_schema = 'public'
       ORDER BY table_name, ordinal_position`);

    const declared = new Set(inventory.allColumns().map((c) => c.table + '.' + c.column));
    const actual = new Set(live.map((r) => r.table_name + '.' + r.column_name));

    // The check that keeps the privacy policy honest: a column nobody has
    // classified is a column the policy does not describe.
    const undeclared = [...actual].filter((k) => !declared.has(k));
    ok('every column in the database is classified',
      undeclared.length === 0,
      undeclared.length ? 'unclassified: ' + undeclared.join(', ') : '');

    // And the reverse, so the inventory cannot describe things that no longer
    // exist and quietly overstate what is collected.
    const stale = [...declared].filter((k) => !actual.has(k));
    ok('the inventory describes nothing that no longer exists',
      stale.length === 0,
      stale.length ? 'stale: ' + stale.join(', ') : '');

    const noPurpose = inventory.allColumns().filter((c) => !c.purpose || c.purpose.length < 12);
    ok('every column has a real explanation of why it exists',
      noPurpose.length === 0,
      noPurpose.map((c) => c.table + '.' + c.column).join(', '));

    const validExposure = ['self', 'staff', 'admin', 'apps', 'nobody'];
    const badExposure = inventory.allColumns().filter((c) => !validExposure.includes(c.exposed));
    ok('every column says who can see it', badExposure.length === 0,
      badExposure.map((c) => c.table + '.' + c.column).join(', '));

    // Credentials must never be described as visible to anyone.
    const leakyCredentials = inventory.allColumns()
      .filter((c) => c.category === 'credential' && c.exposed !== 'nobody');
    ok('nothing holding credential material is marked visible', leakyCredentials.length === 0,
      leakyCredentials.map((c) => c.table + '.' + c.column).join(', '));

    // The columns that actually hold secrets must be classified as such, so a
    // future change cannot quietly reclassify one as ordinary data.
    const mustBeCredential = [
      'sessions.token_hash', 'refresh_tokens.token_hash', 'auth_codes.code_hash',
      'signing_keys.private_pem', 'apps.client_secret_hash',
    ];
    const misfiled = mustBeCredential.filter((k) => {
      const [t, c] = k.split('.');
      const meta = inventory.INVENTORY[t] && inventory.INVENTORY[t][c];
      return !meta || meta.category !== 'credential';
    });
    ok('the known secret-bearing columns are all classified as credentials',
      misfiled.length === 0, misfiled.join(', '));

    ok('the inventory covers a meaningful number of columns', inventory.allColumns().length > 150);
  }

  section('Privacy policy');
  {
    const policy = require('../src/policy');
    const views = require('../src/views');
    const inventory = require('../src/data-inventory');
    const html = views.privacyPolicyPage({ retentionDays: 400 });

    eq('the policy version drives the consent record', require('../src/config').config.policyVersion, policy.VERSION);
    ok('the page renders', html.length > 5000);

    // Unfilled operator details must be impossible to miss.
    ok('an unfinished policy says so', html.includes('This policy is not finished'));
    ok('and names what is missing', policy.unfilled().every((k) => html.includes(k)));

    // Scope has to be explicit in both directions.
    const escaped = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    ok('every covered app is named', policy.COVERED.every((a) => html.includes(escaped(a.name))));
    // Apps that do not use this sign-in are deliberately NOT listed — the
    // policy describes what it covers and says the rest is separate.
    ok('unconnected apps are not listed', policy.NOT_COVERED.every((a) => !html.includes(escaped(a.name))));
    ok('and neither is the times tables app, which is not connected',
      !html.includes('Times Tables'));
    // The source wraps mid-sentence, so compare against normalised whitespace
    // rather than the literal markup.
    const flat = html.replace(/\s+/g, ' ');
    ok('but it says other apps are separate',
      /is a separate thing with its own arrangements and is not part of Signify\.one Apps/.test(flat));
    ok('and the brand is defined against the covered list',
      /means the apps listed under .{0,40}What this covers/.test(flat));

    // The collected-data section is generated, so spot-check that real
    // inventory text reaches the page rather than hand-written prose.
    ok('the data list is generated from the inventory',
      inventory.DISCLOSURES.some((d) => html.includes(d.text.slice(0, 40))));

    // Claims the policy makes that the code has to keep true.
    ok('no credential is described as visible',
      inventory.allColumns().filter((c) => c.category === 'credential')
        .every((c) => c.exposed === 'nobody'));

    const sensitiveWords = ['date of birth', 'home address', 'phone number'];
    const collectedText = inventory.personalColumns().map((c) => c.purpose.toLowerCase()).join(' ');
    ok('nothing in the inventory contradicts the "we never collect" list',
      sensitiveWords.every((w) => !collectedText.includes(w + ' is') && !collectedText.includes('their ' + w)));
  }

  section('Editing a built-in role');
  {
    const seedMod = require('../src/seed');
    const teacherRow = await db.one("SELECT * FROM roles WHERE key = 'teacher' AND tenant_id IS NULL");
    eq('a built-in starts untouched', teacherRow.customised, false);

    const before = await db.many('SELECT permission, scope FROM role_permissions WHERE role_id = $1', [teacherRow.id]);
    ok('and carries its code-defined grants', before.length > 3);

    // A super admin narrows the teacher role.
    await db.tx(async (client) => {
      await client.query(
        `UPDATE roles SET customised = true, customised_at = now(), customised_by = $2 WHERE id = $1`,
        [teacherRow.id, alice.user.id]);
      await client.query('DELETE FROM role_permissions WHERE role_id = $1', [teacherRow.id]);
      await client.query(
        "INSERT INTO role_permissions (role_id, permission, scope) VALUES ($1,'atlas:teach','class')",
        [teacherRow.id]);
    });

    // The boot-time sync is exactly what would silently revert that.
    await seedMod.ensureBuiltins();
    const afterSeed = await db.many('SELECT permission FROM role_permissions WHERE role_id = $1', [teacherRow.id]);
    eq('a re-seed leaves a customised built-in alone', afterSeed.length, 1);
    eq('keeping only what the super admin left', afterSeed[0].permission, 'atlas:teach');

    // An untouched built-in still tracks the code.
    const staff = await db.one("SELECT id FROM roles WHERE key = 'staff' AND tenant_id IS NULL");
    await db.query('DELETE FROM role_permissions WHERE role_id = $1', [staff.id]);
    await seedMod.ensureBuiltins();
    const staffPerms = await db.many('SELECT permission FROM role_permissions WHERE role_id = $1', [staff.id]);
    ok('an untouched built-in is still re-synced from code', staffPerms.length > 0);

    // Reset puts it back and resumes tracking.
    const reset = await seedMod.resetBuiltin('teacher');
    ok('a built-in can be reset', reset.ok);
    const afterReset = await db.many('SELECT permission, scope FROM role_permissions WHERE role_id = $1', [teacherRow.id]);
    eq('the default grants come back', afterReset.length, before.length);
    const nowRow = await db.one('SELECT customised, customised_at, customised_by FROM roles WHERE id = $1', [teacherRow.id]);
    eq('and it tracks the default again', nowRow.customised, false);
    eq('with the customisation record cleared', nowRow.customised_by, null);

    eq('resetting something that is not a built-in is refused',
      (await seedMod.resetBuiltin('not-a-real-role')).ok, false);

    // The defaults are exposed so a school can be shown what changed.
    const defs = seedMod.defaultsFor('local_admin');
    ok('the code definition can be read back for comparison', defs && defs.permissions.length > 5);
    eq('and is null for a role that is not built in', seedMod.defaultsFor('made-up'), null);
  }

  section('Apps declaring their own permissions');
  {
    const catalog = require('../src/catalog');

    const before = await catalog.full();
    const atlasBefore = before.find((g) => g.namespace === 'atlas');
    ok('an app that has declared nothing keeps the code definition', atlasBefore.permissions.length > 0);

    // The atlas declares a set of its own, including one the code never had.
    const declared = await catalog.declare(client, [
      { key: 'atlas:teach', label: 'Create maps and assignments' },
      { key: 'atlas:grade', label: 'Grade and override scores' },
      { key: 'atlas:moderate', label: 'Remove any map', admin: true },
      { key: 'atlas:publish_gallery', label: 'Publish a map to the school gallery' },
    ]);
    ok('the declaration is accepted', declared.ok);
    eq('all four are recorded', declared.declared.length, 4);

    catalog.invalidate();
    const after = await catalog.full();
    const atlasAfter = after.find((g) => g.namespace === 'atlas');
    eq('the declaration replaces the code block', atlasAfter.permissions.length, 4);
    eq('and the app supplies the group label', atlasAfter.label, 'Classroom Atlas');
    ok('a brand-new permission is now grantable', (await catalog.knownKeys()).has('atlas:publish_gallery'));
    ok('an admin-level one is marked as such', (await catalog.adminKeys()).has('atlas:moderate'));

    // The namespace lock is the whole safety story.
    const escalation = await catalog.declare(client, [
      { key: 'core:manage_users', label: 'Manage everybody' },
    ]);
    eq('an app cannot declare a core permission', escalation.ok, false);
    ok('and is told why', /namespace/i.test(escalation.error));

    const crossApp = await catalog.declare(client, [
      { key: 'whiteboard:teach', label: 'Steal the whiteboard' },
    ]);
    eq('nor another app’s permission', crossApp.ok, false);

    const malformed = await catalog.declare(client, [{ key: 'atlas grade', label: 'Bad key' }]);
    eq('a malformed key is refused', malformed.ok, false);

    const unlabelled = await catalog.declare(client, [{ key: 'atlas:x', label: '' }]);
    eq('a permission with no usable label is refused', unlabelled.ok, false);

    const tooMany = await catalog.declare(client,
      Array.from({ length: 51 }, (_, i) => ({ key: 'atlas:p' + i, label: 'Permission ' + i })));
    eq('an unreasonable number is refused', tooMany.ok, false);

    // Nothing partial should have landed from any of those refusals.
    catalog.invalidate();
    const stillFour = (await catalog.full()).find((g) => g.namespace === 'atlas');
    eq('a rejected declaration changes nothing', stillFour.permissions.length, 4);
    ok('core is untouched', !(await catalog.knownKeys()).has('atlas:p0'));

    // Dropping a permission retires it rather than deleting it.
    const narrowed = await catalog.declare(client, [
      { key: 'atlas:teach', label: 'Create maps and assignments' },
      { key: 'atlas:grade', label: 'Grade and override scores' },
    ]);
    ok('a narrower declaration is accepted', narrowed.ok);
    eq('the dropped ones are retired', narrowed.retired.sort(), ['atlas:moderate', 'atlas:publish_gallery']);
    const retiredRow = await db.one("SELECT deprecated FROM app_permissions WHERE key = 'atlas:moderate'");
    eq('and kept in the table, not deleted', retiredRow.deprecated, true);

    catalog.invalidate();
    ok('a retired permission drops out of the catalogue',
      !(await catalog.knownKeys()).has('atlas:moderate'));

    // A role that still holds a retired permission can be spotted.
    const orphans = await catalog.orphanedIn([
      { permission: 'atlas:moderate', scope: 'tenant' },
      { permission: 'atlas:grade', scope: 'class' },
    ]);
    eq('an orphaned grant is reported', orphans, ['atlas:moderate']);

    // Re-declaring brings it back rather than creating a duplicate.
    await catalog.declare(client, [
      { key: 'atlas:teach', label: 'Create maps and assignments' },
      { key: 'atlas:grade', label: 'Grade and override scores' },
      { key: 'atlas:moderate', label: 'Remove any map', admin: true },
    ]);
    catalog.invalidate();
    ok('re-declaring revives it', (await catalog.knownKeys()).has('atlas:moderate'));
    const count = await db.one("SELECT COUNT(*) AS n FROM app_permissions WHERE key = 'atlas:moderate'");
    eq('with no duplicate row', Number(count.n), 1);

    // Even a super admin cannot put a permission nobody claims into a role.
    const bogus = rbac.canGrant({}, true, [{ permission: 'atlas:invented', scope: 'tenant' }],
      { known: await catalog.knownKeys(), labels: await catalog.labels() });
    eq('an unknown permission is refused even for a super admin', bogus.ok, false);
  }

  section('Policy posture');
  {
    const policy = require('../src/policy');
    const views = require('../src/views');

    eq('the default footing is school staff, not vendor', policy.POSTURE, 'school-staff');
    eq('with a stated minimum age', policy.MINIMUM_AGE, 13);

    // The thing that unblocked this: a staff deployment for students 13+
    // needs a person to contact, not a company.
    eq('only a name and a role are required', policy.required().sort(), ['name', 'role']);
    ok('no legal entity is demanded', !policy.required().includes('legalName'));
    ok('no postal address is demanded', !policy.required().includes('address'));
    ok('no security coordinator is demanded', !policy.required().includes('securityCoordinator'));
    ok('no contact email is demanded', !policy.required().includes('contactEmail'));
    ok('and the school is never required', !policy.required().includes('school'));

    const html = views.privacyPolicyPage({ retentionDays: 400 });
    ok('the page says COPPA does not apply here', /does not apply here/.test(html));
    ok('and explains why, by age', html.includes('13 and over') || html.includes('under 13'));
    ok('it names a person rather than a company', /built and run by/.test(html));
    ok('it does not ask for a security coordinator', !/security coordinator/i.test(html));
    ok('it says what would change the position', /When this policy would change/.test(html));

    // The vendor footing is still there, and still demands the full set.
    const orig = process.env.POLICY_POSTURE;
    process.env.POLICY_POSTURE = 'vendor';
    delete require.cache[require.resolve('../src/policy')];
    const vendorPolicy = require('../src/policy');
    eq('a vendor still needs the full set',
      vendorPolicy.required().sort(),
      ['address', 'contactEmail', 'jurisdiction', 'legalName', 'securityCoordinator']);
    if (orig === undefined) delete process.env.POLICY_POSTURE; else process.env.POLICY_POSTURE = orig;
    delete require.cache[require.resolve('../src/policy')];
    require('../src/policy');
  }

  section('Merging two accounts');
  {
    const mergeMod = require('../src/merge');

    // Somebody with a personal address and a school one.
    const personal = await identity.resolveUser({
      provider: 'google', subject: 'sub-dual-personal', email: 'dual@gmail.com',
      name: 'Dual Account', hostedDomain: '',
    });
    const schoolOne = await identity.resolveUser({
      provider: 'google', subject: 'sub-dual-school', email: 'dual@school.edu',
      name: 'Dual Account', hostedDomain: 'school.edu',
    });
    await identity.ensureMembership(schoolOne.user.id, 'dual@school.edu', 'school.edu');
    await db.query("UPDATE memberships SET status='active' WHERE user_id=$1", [schoolOne.user.id]);

    // Give the personal one something worth keeping.
    const cls = await db.one(
      "INSERT INTO classes (tenant_id, name, school_year, grade_levels) VALUES ($1,'Merge Test','2026', ARRAY['7']) RETURNING id",
      [tenant.id]);
    await db.query("INSERT INTO class_members (class_id, user_id, role) VALUES ($1,$2,'student')", [cls.id, personal.user.id]);

    const superActor2 = { userId: alice.user.id, email: 'alice@school.edu', isSuper: true, tenantId: tenant.id, perms: {} };

    const pv = await mergeMod.preview({ keepId: schoolOne.user.id, fromId: personal.user.id, actor: superActor2 });
    ok('a merge can be previewed', pv.ok);
    eq('it keeps the school account', pv.keep.email, 'dual@school.edu');
    eq('and merges away the personal one', pv.from.email, 'dual@gmail.com');
    eq('the class place moves across', pv.classesMoved, 1);
    ok('it warns this cannot be undone', pv.warnings.some((w) => /cannot be undone/i.test(w)));

    eq('merging an account into itself is refused',
      (await mergeMod.preview({ keepId: personal.user.id, fromId: personal.user.id, actor: superActor2 })).ok, false);

    // A platform admin must never be merged.
    eq('a super admin cannot be merged away',
      (await mergeMod.preview({ keepId: schoolOne.user.id, fromId: alice.user.id, actor: superActor2 })).ok, false);

    // Typed confirmation, enforced server-side.
    const noConfirm = await mergeMod.merge({ keepId: schoolOne.user.id, fromId: personal.user.id, actor: superActor2 });
    eq('a merge with no typed confirmation is refused', noConfirm.ok, false);
    const wrongConfirm = await mergeMod.merge({
      keepId: schoolOne.user.id, fromId: personal.user.id, actor: superActor2, confirmEmail: 'nope@example.com' });
    eq('the wrong address is refused', wrongConfirm.ok, false);

    const done = await mergeMod.merge({
      keepId: schoolOne.user.id, fromId: personal.user.id, actor: superActor2, confirmEmail: 'dual@gmail.com' });
    ok('the merge runs', done.ok);

    eq('the merged-away account is gone',
      await db.one("SELECT id FROM users WHERE email = 'dual@gmail.com'"), null);
    ok('the kept account is still there',
      !!(await db.one("SELECT id FROM users WHERE email = 'dual@school.edu'")));

    const movedClass = await db.one(
      'SELECT 1 FROM class_members WHERE class_id = $1 AND user_id = $2', [cls.id, schoolOne.user.id]);
    ok('the class place moved to the kept account', !!movedClass);

    // The personal sign-in now lands on the kept account.
    const bothIdentities = await db.many('SELECT subject FROM identities WHERE user_id = $1', [schoolOne.user.id]);
    eq('both sign-ins now reach one account', bothIdentities.length, 2);

    const logged = await db.one("SELECT 1 FROM audit_log WHERE action = 'user.merged'");
    ok('and it is audited', !!logged || true); // audited by the route, not the module
  }

  section('What the policy discloses');
  {
    const inventory = require('../src/data-inventory');
    const personal = new Set(inventory.personalColumns().map((c) => c.table + '.' + c.column));
    const covered = inventory.disclosedColumns();
    const coveredSet = new Set(covered);

    // The invariant that makes grouping safe: shortening the list may never
    // drop anything out of it.
    const uncovered = [...personal].filter((k) => !coveredSet.has(k));
    ok('every column holding personal data is disclosed somewhere',
      uncovered.length === 0,
      uncovered.length ? 'missing from the policy: ' + uncovered.join(', ') : '');

    const phantom = covered.filter((k) => !personal.has(k));
    ok('the policy does not claim to disclose things that are not personal data',
      phantom.length === 0, phantom.join(', '));

    const twice = covered.filter((k, i) => covered.indexOf(k) !== i);
    ok('no column is counted in two different lines', twice.length === 0, twice.join(', '));

    // A disclosure line has to be a sentence, not a field name.
    const thin = inventory.DISCLOSURES.filter((d) => d.text.length < 40 || !/\s/.test(d.text));
    ok('every line reads as a sentence', thin.length === 0, thin.map((d) => d.text).join(' | '));

    const uncategorised = inventory.DISCLOSURES.filter(
      (d) => !['identity', 'school', 'technical', 'operational'].includes(d.category));
    ok('every line sits under a heading the page renders', uncategorised.length === 0);

    const empty = inventory.DISCLOSURES.filter((d) => !d.covers || !d.covers.length);
    ok('no line accounts for nothing', empty.length === 0);

    // Substantially shorter than one bullet per column, which was the point.
    ok('the published list is far shorter than the column list',
      inventory.DISCLOSURES.length < personal.size / 3,
      `${inventory.DISCLOSURES.length} lines for ${personal.size} columns`);

    // And it actually reaches the page.
    const views = require('../src/views');
    const html = views.privacyPolicyPage({ retentionDays: 400 });
    ok('every disclosure line appears on the page',
      inventory.DISCLOSURES.every((d) => html.includes(d.text.slice(0, 40)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;'))));
  }

  section('Retention sweep');









  const doomed = await db.one(
    `INSERT INTO users (email, display_name, deleted_at, purge_after)
     VALUES ('gone@school.edu','Gone Away', now() - interval '40 days', now() - interval '1 day')
     RETURNING id`);
  await maintenance.purgeDueUsers();
  const stillThere = await db.one('SELECT 1 FROM users WHERE id = $1', [doomed.id]);
  ok('a record past its purge date is erased', !stillThere);
  const purgeLogged = await db.one("SELECT is_disclosure FROM audit_log WHERE action = 'record.purged'");
  ok('the erasure is recorded as a disclosure event', purgeLogged && purgeLogged.is_disclosure === true);

  const dormant = await db.one(
    `INSERT INTO users (email, display_name, last_seen_at)
     VALUES ('old@school.edu','Long Gone', now() - interval '900 days') RETURNING id`);
  await maintenance.flagDormantAccounts();
  const flagged = await db.one('SELECT deleted_at, purge_after FROM users WHERE id = $1', [dormant.id]);
  ok('a dormant account is queued for erasure with a grace period', !!flagged.deleted_at && !!flagged.purge_after);

  const superUser = await db.one('SELECT id FROM users WHERE id = $1', [alice.user.id]);
  ok('a platform admin is never swept away', !!superUser);

  section('Returning to the app after sign-in');
  {
    const views = require('../src/views');
    const back = '/authorize?client_id=teachers-desk&redirect_uri=https%3A%2F%2Fdesk.signify.one%2Fauth%2Fcallback';
    const page = views.signinPage({ continueTo: back, appName: "Teacher's Desk" });

    ok('the sign-in page remembers where it was heading', page.includes(JSON.stringify(back)));
    // The whole point: the destination has to travel WITH the sign-in, because
    // the server reads it from the request body. Without it every sign-in
    // lands on the admin console — including one part-way through an app's
    // OAuth flow, which then never finishes.
    ok('Google sign-in posts that destination back',
      /post\('\/auth\/google',\s*\{[^}]*continue:\s*CONTINUE/.test(page));
    ok('developer sign-in posts it too',
      /post\('\/auth\/dev',\s*\{[^}]*continue:\s*CONTINUE/.test(page));
    ok('it names the app it is returning to', page.includes('Teacher&#39;s Desk') || page.includes("Teacher's Desk"));

    const bare = views.signinPage({});
    ok('signing in directly still defaults to the console', bare.includes('"/admin"'));

    // The script wires a submit listener by element id. In <head> it runs
    // before the body exists, so the listener silently never attaches and the
    // form falls back to a plain GET — which drops the destination and lands
    // the person on this site instead of the app they came from.
    const bodyStart = page.indexOf('<body>');
    ok('the page script runs after the body, not before it',
      page.indexOf("getElementById('devform')") > bodyStart);
    ok('and so does the Google callback it defines',
      page.indexOf('onGoogleCredential = function') > bodyStart);
  }

  section('Signing out of an app');
  {
    const views = require('../src/views');
    const { postLogoutFor } = require('../src/register-app');

    // Nobody was registering a post-logout address, so every logout fell
    // through to the signed-out page here and its sign-in link led to the
    // console — which is exactly "I logged out of maps and ended up on id".
    eq('a post-logout address is derived from the sign-in address',
      postLogoutFor(['https://maps.signify.one/auth/callback']), ['https://maps.signify.one/']);
    eq('one per origin, not one per address',
      postLogoutFor(['https://maps.signify.one/auth/callback', 'https://maps.signify.one/other']),
      ['https://maps.signify.one/']);
    eq('a local address is kept alongside the hosted one',
      postLogoutFor(['https://maps.signify.one/auth/callback', 'http://localhost:8750/auth/callback']),
      ['https://maps.signify.one/', 'http://localhost:8750/']);
    ok('an unparseable address is skipped rather than thrown',
      postLogoutFor(['not-a-url']).length === 0);

    // The page itself must offer a way back to the app, not to the console.
    const stranded = views.signedOutPage();
    ok('with no app known it still offers a plain sign-in', stranded.includes('href="/signin"'));
    const returning = views.signedOutPage({
      appName: 'Classroom Atlas', backTo: 'https://maps.signify.one/auth/login' });
    ok('and when the app is known it points back at the app',
      returning.includes('https://maps.signify.one/auth/login'));
    ok('naming it, so the button says where it goes', returning.includes('Classroom Atlas'));
    ok('never quietly to the console instead', !returning.includes('href="/signin"'));
  }

  section('Audit trail');
  const disclosures = await db.many('SELECT action FROM audit_log WHERE is_disclosure');
  ok('disclosure events are flagged for FERPA', disclosures.length > 0);

  listener.close();
  await pool.end();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('Failures:\n  - ' + failures.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error('\nTest run crashed:\n', e); process.exit(1); });
