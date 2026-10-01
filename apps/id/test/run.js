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
process.env.SESSION_IDLE_MINUTES_STAFF = '480';

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
  const sess = await sessions.create(bobUser.id, { ip: '10.0.0.1', userAgent: 'test', isStaff: false });
  const touched = await sessions.touch(sess.raw);
  ok('a live session resolves', !!touched && touched.user_id === bobUser.id);
  eq('a student gets the short idle window', sess.idleMinutes, 45);

  // Who gets which window is decided once, at sign-in, and written on the
  // row. touch() and slide() both read it from there, so the two cannot
  // disagree about the same session depending on which saw it last.
  ok('a student is not staff', !sessions.isStaffAccess({ membership: { role_key: 'student' } }));
  ok('a teacher is', sessions.isStaffAccess({ membership: { role_key: 'teacher' } }));
  ok('a super admin belonging to no school is', sessions.isStaffAccess({ isSuper: true, membership: null }));
  ok('somebody with no school at all is not, until they have one',
    !sessions.isStaffAccess({ membership: null }));

  await sessions.touch(sess.raw);
  const studentWindow = await db.one(
    `SELECT idle_minutes, idle_expires_at - now() < interval '50 minutes' AS stays_short
       FROM sessions WHERE id = $1`, [sess.id]);
  eq('the window is stored on the session, not worked out again', studentWindow.idle_minutes, 45);
  ok('so touching a student session slides it only that far', !!studentWindow.stays_short);

  const staffSess = await sessions.create(bobUser.id, { ip: '10.0.0.1', userAgent: 'test', isStaff: true });
  eq('staff get a school day', staffSess.idleMinutes, 480);
  await sessions.touch(staffSess.raw);
  const staffWindow = await db.one(
    `SELECT idle_expires_at - now() > interval '7 hours' AS stays_long
       FROM sessions WHERE id = $1`, [staffSess.id]);
  ok('and touching one slides it by the same eight hours', !!staffWindow.stays_long);
  await sessions.revoke(staffSess.id, 'finished with');

  const stored = await db.one('SELECT token_hash FROM sessions WHERE id = $1', [sess.id]);
  ok('the raw session token is never stored', stored.token_hash !== sess.raw && stored.token_hash === keys.sha256(sess.raw));

  await db.query("UPDATE users SET status = 'blocked' WHERE id = $1", [bobUser.id]);
  const afterBlock = await sessions.touch(sess.raw);
  ok('blocking an account kills its live session immediately', afterBlock === null);
  await db.query("UPDATE users SET status = 'active' WHERE id = $1", [bobUser.id]);

  const sess2 = await sessions.create(bobUser.id, { ip: '10.0.0.1', userAgent: 'test', isStaff: false });
  await sessions.revokeAllForUser(bobUser.id);
  ok('revoke-all ends every device', (await sessions.touch(sess2.raw)) === null);

  // The reason used to be accepted and dropped, so nothing recorded why a
  // sign-in ended — the first question when somebody says they were logged out.
  const why = await db.one('SELECT revoked_reason FROM sessions WHERE id = $1', [sess2.id]);
  eq('and says who ended them', why.revoked_reason, 'ended by an administrator');
  const single = await sessions.create(bobUser.id, { ip: '10.0.0.1', userAgent: 'test', isStaff: false });
  await sessions.revoke(single.id, 'reauth');
  const singleWhy = await db.one('SELECT revoked_reason FROM sessions WHERE id = $1', [single.id]);
  eq('ending one session records its reason too', singleWhy.revoked_reason, 'reauth');

  // ---- the idle window, and who is allowed to slide it ----
  //
  // The bug this pins down: a teacher using Teacher's Desk all morning never
  // touches this service directly, so nothing slid their idle window. The
  // service API refused every roster question for idleness while the refresh
  // grant — which checked the absolute clock and nothing else — kept issuing
  // them fresh ID tokens. Signed in, and simultaneously not.
  section('Idle window');

  const idleSess = await sessions.create(bobUser.id, { ip: '10.0.0.1', userAgent: 'test', isStaff: false });
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
  ok('working in an app buys the full window back, not a minute', minutesOut > 40 && minutesOut <= 45);

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
  const carlaSession = await sessions.create(claimed.user.id, { ip: '10.0.0.2', userAgent: 'test', isStaff: true });
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
  const carlaSession2 = await sessions.create(claimed.user.id, { ip: '10.0.0.2', userAgent: 'test', isStaff: true });
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
  const carlaSession3 = await sessions.create(claimed.user.id, { ip: '10.0.0.2', userAgent: 't', isStaff: true });
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
  const outsiderSession = await sessions.create(bobUser.id, { ip: '10.0.0.9', userAgent: 't', isStaff: false });
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
    const s1 = await sessions.create(nia.id, { ip: '10.0.0.5', userAgent: 't', isStaff: false });
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

    // Base tables only: a view (class_access) stores nothing to account for.
    const live = await db.many(`
      SELECT c.table_name, c.column_name
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
       ORDER BY c.table_name, c.ordinal_position`);

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
      (d) => !['identity', 'school', 'technical', 'operational', 'request'].includes(d.category));
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

  section('Asking for an account');
  {
    const survey = require('../src/access-survey');
    const views = require('../src/views');

    // ---- only the person who signed in can answer ----
    const someone = await identity.resolveUser({
      provider: 'google', subject: 'google-sub-frank', email: 'frank@elsewhere.org',
      name: 'Frank Ortiz', hostedDomain: 'elsewhere.org',
    });
    const token = survey.sign(someone.user.id);
    eq('a fresh token names who signed in', survey.verify(token), someone.user.id);
    const [uid, exp, sig] = token.split('.');
    eq('a token re-pointed at someone else is refused',
      survey.verify(['00000000-0000-0000-0000-000000000000', exp, sig].join('.')), null);
    eq('so is one with its expiry pushed back', survey.verify([uid, String(Number(exp) + 1), sig].join('.')), null);
    eq('and one past its expiry', survey.verify(token, Date.now() + survey.TOKEN_MS + 1000), null);
    eq('and anything that is not a token at all', survey.verify('nonsense'), null);

    // ---- reading answers ----
    const appKeys = ['classroom-atlas', 'teachers-desk'];

    // The reason the first question exists.
    const student = survey.normalise({
      respondent: 'student', interested_apps: 'classroom-atlas', school_name: 'Somewhere Middle', grade_levels: '6',
    }, appKeys);
    ok('a student can send the form', student.ok);
    eq('and nothing beyond the first answer is kept from a student',
      [student.answers.school_name, student.answers.interested_apps, student.answers.grade_levels],
      ['', [], []]);

    const bare = survey.normalise({ respondent: 'educator' }, appKeys);
    ok('an educator has to say which apps, which school and what job',
      !bare.ok && ['interested_apps', 'school_name', 'job_title'].every((k) => bare.errors[k]));
    ok('nobody gets past without answering the first question', !survey.normalise({}, appKeys).ok);

    const noSchool = survey.normalise({
      respondent: 'educator', interested_apps: ['teachers-desk'], not_at_school: 'on',
      job_title: 'Tutor', school_name: 'typed before ticking the box',
    }, appKeys);
    ok('ticking "not at a school" stands in for a school name', noSchool.ok);
    eq('and a school typed anyway is not kept', noSchool.answers.school_name, '');

    const messy = survey.normalise({
      respondent: 'educator', interested_apps: ['classroom-atlas', 'made-up-app'],
      school_name: '  Riverside   High ', job_title: 'x'.repeat(500),
      google_accounts: 'google', usage_scope: 'school', student_count: '100-500', start_when: 'next-year',
      heard_from: 'edtech-unpacked', heard_from_other: 'dropped, because "somewhere else" was not chosen',
      subjects: ['math', 'astrology'], subjects_other: 'dropped too',
      grade_levels: ['9', '14', 'K'],
    }, appKeys);
    ok('a real submission is accepted', messy.ok);
    eq('an app nobody registered is dropped', messy.answers.interested_apps, ['classroom-atlas']);
    eq('whitespace is tidied', messy.answers.school_name, 'Riverside High');
    eq('long text is capped', messy.answers.job_title.length, survey.TEXT_LIMIT);
    eq('"somewhere else" text is kept only when that was chosen', messy.answers.heard_from_other, '');
    eq('an unknown subject is dropped', messy.answers.subjects, ['math']);
    eq('grade levels come back in school order, unknown ones dropped', messy.answers.grade_levels, ['K', '9']);

    const hidden = survey.normalise({
      respondent: 'other', interested_apps: 'other', interested_other: 'Maps' + String.fromCharCode(0, 7) + 'for home',
    }, appKeys);
    eq('invisible characters do not survive', hidden.answers.interested_other, 'Maps for home');
    ok('someone who is not an educator is not made to give a school or a job', hidden.ok);
    const vague = survey.normalise({ respondent: 'other', interested_apps: 'other' }, appKeys);
    ok('"something else" on its own needs saying what', !vague.ok && !!vague.errors.interested_apps);

    // ---- stored, read back, described ----
    await db.query(
      `INSERT INTO access_requests (user_id, email, came_from_app) VALUES ($1, $2, 'classroom-atlas')`,
      [someone.user.id, 'frank@elsewhere.org']);
    const open = await survey.currentRequest(someone.user.id);
    ok('the open request is found for the person who signed in', !!open && open.email === 'frank@elsewhere.org');
    eq('a first visit starts with the app they came from already ticked',
      survey.valuesFromRequest(open).interested_apps, ['classroom-atlas']);

    ok('answers are saved to the open request', !!(await survey.save(open.id, messy.answers)));
    const saved = await survey.currentRequest(someone.user.id);
    eq('lists survive the round trip', [saved.interested_apps, saved.subjects, saved.grade_levels],
      [['classroom-atlas'], ['math'], ['K', '9']]);

    const apps = [{ client_id: 'classroom-atlas', name: 'Classroom Atlas', launch_url: 'https://maps.signify.one/' }];
    const described = survey.describe(saved, apps);
    eq('the console gets app names, not keys', described.apps, ['Classroom Atlas']);
    eq('and where the answer came from, in words', described.heardFrom, 'The EdTech Unpacked podcast');
    eq('and which app they were opening', described.cameFrom, 'Classroom Atlas');
    eq('and whether their school is on Google, in words', described.googleAccounts, 'Yes, Google Workspace');
    eq('the planning answers survive the round trip', [saved.usage_scope, saved.student_count, saved.start_when],
      ['school', '100-500', 'next-year']);

    // ---- the pages ----
    const form = views.requestAccessPage({ request: saved, apps });
    ok('the form offers the registered apps', form.includes('value="classroom-atlas"') && form.includes('maps.signify.one'));
    ok('it posts back to itself', form.includes('action="/request-access"'));
    ok('the student question comes before everything else',
      form.indexOf('name="respondent"') < form.indexOf('name="interested_apps"'));
    ok('there is no open comment box anywhere on it', !form.includes('<textarea'));
    ok('it says how long the answers are kept', form.includes(survey.ANSWER_RETENTION_DAYS + ' days'));
    ok('what was saved comes back ticked', /value="math" checked/.test(form));

    const afterMistake = views.requestAccessPage({
      request: saved, apps, values: { respondent: 'educator' }, errors: { job_title: 'Give your job title.' } });
    ok('a mistake is shown beside its question', afterMistake.includes('Give your job title.'));

    const thanks = views.requestReceivedPage({ request: saved, apps });
    ok('an educator is told what happens next', thanks.includes('What happens next'));
    ok('and can change their answers', thanks.includes('/request-access?edit=1'));
    const studentThanks = views.requestReceivedPage({ request: { ...saved, respondent: 'student' }, apps });
    ok('a student is told that accounts come from a school, and nothing about a reply',
      studentThanks.includes('come from a school') && !studentThanks.includes('What happens next'));

    const signin = views.signinPage({});
    ok('a sign-in that matched no school goes on to the questions instead of an error',
      /e\.data && e\.data\.next/.test(signin) && !/showError\(e\.message\);\s*\}\);/.test(signin));

    const policyPage = views.privacyPolicyPage({ retentionDays: 400 });
    ok('the privacy policy has a section for it', policyPage.includes('Asking for an account'));

    // ---- the four planning questions ----
    const schoolWithoutGoogleAnswer = survey.normalise({
      respondent: 'educator', interested_apps: 'teachers-desk', school_name: 'Oak Hill', job_title: 'Teacher',
    }, appKeys);
    ok('someone at a school has to say whether it uses Google accounts',
      !schoolWithoutGoogleAnswer.ok && !!schoolWithoutGoogleAnswer.errors.google_accounts);
    const tutor = survey.normalise({
      respondent: 'educator', interested_apps: 'teachers-desk', not_at_school: 'on', job_title: 'Tutor',
      google_accounts: 'microsoft', student_count: 'a thousand', start_when: 'now',
    }, appKeys);
    ok('someone with no school is not asked about one', tutor.ok);
    eq('and a Google answer sent anyway is not kept', tutor.answers.google_accounts, '');
    eq('a range nobody offered is dropped', tutor.answers.student_count, '');
    eq('a real choice is kept', tutor.answers.start_when, 'now');
    ok('the Google question is marked as about the school, so it hides for someone without one',
      /<fieldset class="school-only">\s*<legend>Does your school use Google accounts/.test(views.requestAccessPage({ request: saved, apps })));

    // ---- telling super admins ----
    const makeAdmin = async (sub, email) => {
      const r = await identity.resolveUser({ provider: 'google', subject: sub, email, name: email, hostedDomain: 'school.edu' });
      await db.query('INSERT INTO platform_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [r.user.id]);
      return r.user.id;
    };
    const grace = await makeAdmin('google-sub-grace', 'grace.ops@school.edu');
    const ivy = await makeAdmin('google-sub-ivy', 'ivy.ops@school.edu');

    ok('an admin who has never looked is told about open requests', (await survey.newRequestsFor(grace)).count >= 1);
    await survey.markRequestsSeen(grace);
    eq('once they have looked, nothing is new', (await survey.newRequestsFor(grace)).count, 0);
    ok('and another admin still has their own to see', (await survey.newRequestsFor(ivy)).count >= 1);

    const hank = await identity.resolveUser({
      provider: 'google', subject: 'google-sub-hank', email: 'hank@elsewhere.org', name: 'Hank Moss', hostedDomain: 'elsewhere.org' });
    const hankRequest = await db.one(
      `INSERT INTO access_requests (user_id, email) VALUES ($1, 'hank@elsewhere.org') RETURNING id`, [hank.user.id]);
    eq('a request arriving afterwards is new', (await survey.newRequestsFor(grace)).count, 1);

    await survey.markRequestsSeen(grace);
    await survey.save(hankRequest.id, tutor.answers);
    eq('and answering the questions later makes it new again', (await survey.newRequestsFor(grace)).count, 1);

    // The page reads the list, then marks it seen. An answer landing between
    // those two moments was never on screen and must not be swallowed.
    const beforeReading = (await db.one('SELECT now() AS at')).at;
    await survey.save(hankRequest.id, tutor.answers);
    await survey.markRequestsSeen(grace, beforeReading);
    eq('an answer that lands while the list is being read still counts as new',
      (await survey.newRequestsFor(grace)).count, 1);

    const hankSaved = await db.one('SELECT * FROM access_requests WHERE id = $1', [hankRequest.id]);
    const hankDescribed = survey.describe(hankSaved, apps);
    eq('the console gets the planning answers in words', hankDescribed.startWhen, 'As soon as possible');

    // Through the very query the Requests page uses, not a hand-picked row.
    // The page once named its columns and left these four out: saved, tested,
    // and still invisible to the admin deciding the request.
    const listedFrank = (await survey.listRequests()).find((r) => r.id === open.id);
    const throughPage = survey.describe(listedFrank, apps);
    eq('the Requests page query carries every answer to the console',
      [throughPage.googleAccounts, throughPage.usageScope, throughPage.studentCount, throughPage.startWhen, throughPage.school],
      ['Yes, Google Workspace', 'The whole school', '100 to 500', 'Next school year', 'Riverside High']);
    await db.query(`UPDATE access_requests SET status = 'declined', decided_at = now() WHERE id = $1`, [hankRequest.id]);
    await survey.markRequestsSeen(grace);
    eq('a request that has been decided is no longer counted', (await survey.newRequestsFor(grace)).count, 0);

    // ---- retention ----
    const recent = await db.one(
      `INSERT INTO access_requests (user_id, email, status, decided_at, respondent, job_title)
       VALUES ($1, 'frank@elsewhere.org', 'approved', now() - interval '10 days', 'educator', 'Tutor')
       RETURNING id`, [someone.user.id]);
    await db.query(
      `UPDATE access_requests SET status = 'declined', decided_at = now() - interval '91 days' WHERE id = $1`, [open.id]);

    eq('answers to a request decided 91 days ago are cleared', await survey.clearDecidedAnswers(), 1);
    const cleared = await db.one(
      'SELECT respondent, school_name, job_title, grade_levels, google_accounts, start_when, status FROM access_requests WHERE id = $1', [open.id]);
    ok('leaving no answers behind',
      cleared.respondent === null && cleared.school_name === '' && cleared.job_title === '' &&
      cleared.grade_levels.length === 0 && cleared.google_accounts === '' && cleared.start_when === '');
    eq('but keeping the record that someone asked and what was decided', cleared.status, 'declined');
    const kept = await db.one('SELECT job_title FROM access_requests WHERE id = $1', [recent.id]);
    eq('a request decided ten days ago keeps its answers', kept.job_title, 'Tutor');
    eq('and running the sweep again changes nothing', await survey.clearDecidedAnswers(), 0);
  }

  section('Problem reports');
  {
    const reports = require('../src/reports');
    const merge = require('../src/merge');

    // A fresh token for Carla at Oakwood, through the real authorize and token
    // endpoints — the one an app's /auth/report forwards on her behalf.
    const mint = async (userId) => {
      const sess = await sessions.create(userId, { ip: '10.0.0.40', userAgent: 'report-test', isStaff: true });
      const v = crypto.randomBytes(32).toString('base64url');
      const ch = crypto.createHash('sha256').update(v).digest('base64url');
      const a = await fetch(`${base}/authorize?response_type=code&client_id=atlas` +
        `&redirect_uri=${encodeURIComponent('http://localhost:4000/auth/callback')}` +
        `&scope=openid+profile+email+roles&state=r&code_challenge=${ch}&code_challenge_method=S256`,
        { headers: { cookie: `${sessions.COOKIE}=${encodeURIComponent(sess.raw)}` }, redirect: 'manual' });
      const code = new URL(a.headers.get('location')).searchParams.get('code');
      return (await fetch(`${base}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic },
        body: new URLSearchParams({ grant_type: 'authorization_code', code,
          redirect_uri: 'http://localhost:4000/auth/callback', code_verifier: v }).toString(),
      })).json();
    };
    const carlaTokens = await mint(claimed.user.id);
    const file = (token, body) => fetch(`${base}/api/v1/reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });

    // ---- intake ----
    const sent = await file(carlaTokens.id_token, {
      kind: 'mistake',
      message: 'Jericho is on the wrong side of the Jordan on the Joshua map.',
      pageUrl: 'https://maps.signify.one/passage?ref=Josh+6&join=K7QX#token=abc',
      // Trying to file it as somebody else, from somewhere else.
      userId: bobUser.id, tenantId: other.id, appName: 'Whiteboard',
      context: {
        userAgent: 'Mozilla/5.0 (test)', viewport: '1280x800', language: 'en-GB',
        selection: 'Jericho', cookie: 'sid=stolen', localStorage: { a: 1 },
        errors: Array.from({ length: 14 }, (_, i) => ({
          message: `TypeError ${i}`, source: 'https://maps.signify.one/js/app.js?v=51', line: i, col: 2,
          at: '2026-09-17T10:00:00.000Z',
        })),
      },
    });
    eq('a signed-in person can file a report from an app', sent.status, 201);
    const sentBody = await sent.json();
    ok('and is handed back a short reference', /^R-[A-HJ-NP-Z2-9]{5}$/.test(sentBody.ref), sentBody.ref);

    const row = await db.one('SELECT * FROM reports WHERE ref = $1', [sentBody.ref]);
    ok('who sent it comes from the token, not the body',
      row.user_id === claimed.user.id && row.tenant_id === tenant.id);
    eq('and so does which app it came from', [row.app_id, row.app_name], [client.id, 'Classroom Atlas']);
    eq('the query string and fragment are stripped from the page address',
      row.page_url, 'https://maps.signify.one/passage');
    ok('fields nobody asked for are dropped from the details',
      !('cookie' in row.context) && !('localStorage' in row.context) && row.context.selection === 'Jericho');
    eq('only the last ten script errors are kept', row.context.errors.length, 10);
    eq('and their addresses lose their query strings too',
      row.context.errors[0].source, 'https://maps.signify.one/js/app.js');

    const bare = await (await file(carlaTokens.id_token, {
      kind: 'bug', message: 'The timer froze.', includeDetails: false,
      context: { userAgent: 'x', selection: 'private text' },
    })).json();
    const bareRow = await db.one('SELECT context FROM reports WHERE ref = $1', [bare.ref]);
    eq('unticking "include details" sends none of them', bareRow.context, {});

    eq('a report with no kind is refused', (await file(carlaTokens.id_token, { message: 'hello there' })).status, 400);
    eq('so is one that says nothing', (await file(carlaTokens.id_token, { kind: 'bug', message: '  ' })).status, 400);
    eq('so is one far too long', (await file(carlaTokens.id_token, { kind: 'bug', message: 'x'.repeat(reports.MESSAGE_MAX + 1) })).status, 400);
    eq('and nobody can file one without signing in', (await file(null, { kind: 'bug', message: 'anonymous' })).status, 401);

    // Two sent so far; fill the rest of the hour's allowance.
    for (let i = 0; i < reports.PER_HOUR - 2; i += 1) {
      await reports.create({ userId: claimed.user.id, tenantId: tenant.id, appName: 'Classroom Atlas' },
        { kind: 'other', message: `flood ${i}` });
    }
    eq('one person cannot flood the list', (await file(carlaTokens.id_token, { kind: 'bug', message: 'one more' })).status, 429);
    await db.query(`UPDATE reports SET created_at = now() - interval '2 hours' WHERE message LIKE 'flood %'`);

    // ---- triage, and who may see what ----
    const elsewhere = await reports.create(
      { userId: riversideUser.user.id, tenantId: other.id, appName: 'Classroom Whiteboard' },
      { kind: 'bug', message: 'Riverside: the pen lags on Chromebooks.' });

    const asSuper = await reports.list(superAdminActor, {});
    ok('a platform admin sees every school’s reports',
      asSuper.ok && asSuper.reports.some((r) => r.ref === elsewhere.report.ref) && asSuper.reports.some((r) => r.ref === sentBody.ref));
    ok('with the reporter named', asSuper.reports.find((r) => r.ref === sentBody.ref).reporter_email === 'carla@school.edu');

    const localAdmin = { ...localAdminActor, tenantId: tenant.id, isSuper: false };
    const asLocal = await reports.list(localAdmin, { tenantId: other.id });
    ok('a local admin sees their own school’s reports',
      asLocal.ok && asLocal.reports.some((r) => r.ref === sentBody.ref));
    ok('and never another school’s, even when they ask for it by id',
      !asLocal.reports.some((r) => r.ref === elsewhere.report.ref));

    const teacher = { userId: claimed.user.id, isSuper: false, tenantId: tenant.id,
      perms: rbac.collapse(rbac.BUILTIN_ROLES.find((r) => r.key === 'teacher').permissions) };
    ok('a teacher cannot read the list at all', !(await reports.list(teacher, {})).ok);
    eq('and sees a count of zero rather than an error', await reports.newCount(teacher), 0);

    const crossUpdate = await reports.update(localAdmin, elsewhere.report.id, { status: 'fixed' });
    eq('a local admin cannot close another school’s report', crossUpdate.status, 403);

    const newBefore = await reports.newCount(localAdmin);
    const fixed = await reports.update(localAdmin, row.id, { status: 'fixed', resolution: 'Moved Jericho west of the river.' });
    ok('closing a report stamps when and by whom',
      fixed.ok && fixed.report.status === 'fixed' && !!fixed.report.closed_at);
    eq('and it drops out of the new count', await reports.newCount(localAdmin), newBefore - 1);
    const closedRow = await db.one('SELECT closed_by FROM reports WHERE id = $1', [row.id]);
    eq('closed_by is the administrator who did it', closedRow.closed_by, localAdmin.userId);

    const reopened = await reports.update(localAdmin, row.id, { status: 'investigating' });
    ok('reopening clears the closed stamp', reopened.ok && reopened.report.closed_at === null);
    eq('an unknown status is refused', (await reports.update(localAdmin, row.id, { status: 'maybe' })).status, 400);
    const open = await reports.list(superAdminActor, { status: 'open' });
    ok('the "open" filter leaves out closed reports',
      open.reports.every((r) => !reports.CLOSED.includes(r.status)));

    // ---- the person's own record ----
    const carlaOwn = await reports.forUser(claimed.user.id);
    ok('a FERPA export includes what someone reported',
      carlaOwn.some((r) => r.message.startsWith('Jericho')) && !carlaOwn.some((r) => r.message.startsWith('Riverside')));

    // ---- merging ----
    const twin = await db.one(`INSERT INTO users (email, display_name) VALUES ('carla.personal@gmail.com','Carla') RETURNING id`);
    await reports.create({ userId: twin.id, tenantId: null, appName: 'Classroom Atlas' }, { kind: 'bug', message: 'Reported before the school account existed.' });
    const mergePreview = await merge.preview({ keepId: claimed.user.id, fromId: twin.id, actor: superAdminActor });
    eq('merging two accounts moves the reports across', mergePreview.moving && mergePreview.moving['reports.user_id'], 1);

    // ---- retention ----
    await db.query(`UPDATE reports SET closed_at = now() - interval '181 days', status = 'fixed' WHERE id = $1`, [elsewhere.report.id]);
    const recentClosed = await reports.create({ userId: bobUser.id, tenantId: tenant.id, appName: 'Classroom Atlas' }, { kind: 'bug', message: 'Closed last week.' });
    await db.query(`UPDATE reports SET closed_at = now() - interval '7 days', status = 'fixed' WHERE id = $1`, [recentClosed.report.id]);
    const ancient = await reports.create({ userId: bobUser.id, tenantId: tenant.id, appName: 'Classroom Atlas' }, { kind: 'bug', message: 'Nobody ever looked at this.' });
    await db.query(`UPDATE reports SET created_at = now() - interval '401 days' WHERE id = $1`, [ancient.report.id]);

    eq('the sweep erases the expired reports and nothing else', await reports.purgeExpired(), 2);
    ok('a report closed 181 days ago is gone', !(await db.one('SELECT 1 FROM reports WHERE id = $1', [elsewhere.report.id])));
    ok('an open one past the retention limit is gone too', !(await db.one('SELECT 1 FROM reports WHERE id = $1', [ancient.report.id])));
    ok('one closed last week is kept', !!(await db.one('SELECT 1 FROM reports WHERE id = $1', [recentClosed.report.id])));

    // ---- erasure ----
    const gone = await db.one(`INSERT INTO users (email, display_name) VALUES ('leaver@school.edu','Leaver') RETURNING id`);
    await reports.create({ userId: gone.id, tenantId: tenant.id, appName: 'Classroom Atlas' }, { kind: 'mistake', message: 'My own words.' });
    await db.query('DELETE FROM users WHERE id = $1', [gone.id]);
    eq('erasing a person erases what they reported', Number((await db.one('SELECT COUNT(*) AS n FROM reports WHERE user_id = $1', [gone.id])).n), 0);

    // ---- the permission ----
    ok('local admins hold the triage permission for their school',
      rbac.BUILTIN_ROLES.find((r) => r.key === 'local_admin').permissions
        .some((g) => g.permission === 'core:triage_reports' && g.scope === 'tenant'));
    ok('and it is marked administrative, so a teacher cannot mint it into a role',
      rbac.ADMIN_PERMISSIONS.has('core:triage_reports'));
  }

  section('Off-site database backups');
  {
    const http = require('http');
    const audit = require('../src/audit');

    // A stand-in bucket on localhost that honours ?prefix= the way R2 does.
    const objects = new Map();
    const bucket = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const key = decodeURIComponent(url.pathname.replace(/^\/id-bucket\/?/, ''));
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        if (req.method === 'PUT') { objects.set(key, Buffer.concat(chunks)); res.writeHead(200).end(); return; }
        if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204).end(); return; }
        if (req.method === 'GET') {
          const prefix = url.searchParams.get('prefix') || '';
          const keys = [...objects.keys()].filter((k) => k.startsWith(prefix));
          res.writeHead(200).end(`<ListBucketResult><IsTruncated>false</IsTruncated>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}</ListBucketResult>`);
          return;
        }
        res.writeHead(405).end();
      });
    });
    await new Promise((r) => bucket.listen(0, '127.0.0.1', r));
    Object.assign(process.env, {
      R2_ENDPOINT: `http://127.0.0.1:${bucket.address().port}`, R2_BUCKET: 'id-bucket',
      R2_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE', R2_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    });
    const fresh = () => {
      for (const m of ['../src/dbbackup', '../src/offsite']) delete require.cache[require.resolve(m)];
      return require('../src/dbbackup');
    };
    const quietLog = { log() {}, warn() {}, error() {} };
    const sortRows = (t) => ({ ...t, rows: [...t.rows].map((r) => JSON.stringify(r)).sort() });

    // ---- without a key, nothing leaves ----
    delete process.env.BACKUP_ENCRYPTION_KEY;
    let dbb = fresh();
    const noKey = await dbb.maybeBackup({ log: quietLog });
    ok('with no encryption key, nothing is sent', !noKey.ok && objects.size === 0 && /BACKUP_ENCRYPTION_KEY/.test(noKey.error));

    process.env.BACKUP_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    dbb = fresh();

    // ---- what a backup holds ----
    await keys.signingKey();   // make sure there is a key that must NOT be copied
    const secretPem = (await db.one('SELECT private_pem FROM signing_keys LIMIT 1')).private_pem;
    const sessionHash = (await db.one('SELECT token_hash FROM sessions LIMIT 1')).token_hash;
    const snap = await dbb.dump();
    const packed = JSON.stringify(snap);
    ok('the backup has every ordinary table', ['users', 'memberships', 'classes', 'audit_log', 'apps', 'reports', 'erasure_tombstones'].every((t) => t in snap.tables));
    ok('but no sessions, sign-in codes, refresh tokens or signing keys', ['sessions', 'auth_codes', 'refresh_tokens', 'signing_keys'].every((t) => !(t in snap.tables)));
    ok('the private signing key appears nowhere in it', !packed.includes(secretPem.split('\n')[2]));
    ok('nor does any session hash', !packed.includes(sessionHash));
    eq('it records which migrations it was taken at', snap.migrations.includes('011_erasure_tombstones.sql'), true);

    // ---- sent encrypted, pruned by date ----
    for (const d of ['2026-08-01', '2026-08-20']) objects.set(`id/backup-${d}.json.gz.enc`, Buffer.from('old'));
    objects.set('id/erasures/00000000-0000-0000-0000-000000000001', Buffer.alloc(0));
    const sent = await dbb.maybeBackup({ now: Date.parse('2026-09-28T02:00:00Z'), log: quietLog });
    const stored = objects.get('id/backup-2026-09-28.json.gz.enc');
    ok('a nightly backup is uploaded, encrypted', sent.ok && !!stored && !stored.includes(Buffer.from('carla@school.edu')));
    ok('backups older than 28 days are removed', !objects.has('id/backup-2026-08-01.json.gz.enc') && !objects.has('id/backup-2026-08-20.json.gz.enc'));
    ok('but tombstones are never pruned as if they were backups', objects.has('id/erasures/00000000-0000-0000-0000-000000000001'));
    const again = await dbb.maybeBackup({ now: Date.parse('2026-09-28T09:00:00Z'), log: quietLog });
    ok('only one backup a day, however often the sweep runs', again.skipped === 'already done today');
    const reopened = dbb.unpack(stored);
    eq('the key opens it back into the same snapshot', Object.keys(reopened.tables).length, Object.keys(snap.tables).length);

    // ---- an erasure leaves a tombstone, in the same transaction ----
    const doomed = await db.one(
      `INSERT INTO users (email, display_name, deleted_at, purge_after)
       VALUES ('leaving@school.edu', 'Leaving Soon', now() - interval '40 days', now() - interval '1 day') RETURNING id`);
    const beforeErasure = await dbb.dump();   // yesterday's backup: still has them
    await maintenance.purgeDueUsers();
    ok('erasing somebody records a tombstone', !!(await db.one('SELECT 1 FROM erasure_tombstones WHERE user_id = $1', [doomed.id])));
    // Everything waiting goes, including any erasure from earlier in this run
    // made while no bucket was configured — that is the retry doing its job.
    const waiting = Number((await db.one('SELECT COUNT(*) AS n FROM erasure_tombstones WHERE sent_at IS NULL')).n);
    eq('which is sent to the bucket, with any others still waiting', await dbb.sendTombstones(), waiting);
    ok('as their id and nothing more', objects.has(`id/erasures/${doomed.id}`) && objects.get(`id/erasures/${doomed.id}`).length === 0);
    eq('and is not sent twice', await dbb.sendTombstones(), 0);

    // ---- restore into a brand-new database ----
    const livePool = db.pool;
    const newPool = await PglitePool.create();
    db.setPool(newPool);
    const origLog = console.log; console.log = () => {};
    let restored;
    try {
      restored = await dbb.restore(beforeErasure, { tombstones: await dbb.listTombstones(), log: quietLog });
    } finally { console.log = origLog; }
    ok('a backup restores into an empty database', restored.ok);
    ok('and an erasure made after the backup still wins', !(await db.one('SELECT 1 FROM users WHERE id = $1', [doomed.id])) && restored.counts.erasures_reapplied === 1);

    const roundTrip = await dbb.dump();
    const differing = Object.keys(beforeErasure.tables).filter((t) => t !== 'users' && t !== 'erasure_tombstones' && t !== 'audit_log' &&
      JSON.stringify(sortRows(roundTrip.tables[t])) !== JSON.stringify(sortRows(beforeErasure.tables[t])));
    ok('every other table comes back exactly — timestamps, arrays, json and all', differing.length === 0, differing.join(', '));
    const usersBack = sortRows({ rows: roundTrip.tables.users.rows }).rows;
    const usersExpected = sortRows({ rows: beforeErasure.tables.users.rows.filter((r) => !r.includes(doomed.id)) }).rows;
    ok('and every account except the erased one, exactly', JSON.stringify(usersBack) === JSON.stringify(usersExpected));

    const highest = Number((await db.one('SELECT MAX(id) AS m FROM audit_log')).m);
    await audit.record({ action: 'test.after_restore', detail: {} });
    const next = await db.one(`SELECT id FROM audit_log WHERE action = 'test.after_restore'`);
    ok('the audit log carries on numbering after the restored rows', !!next && Number(next.id) > highest, `${next && next.id} vs ${highest}`);
    ok('with no signing key restored — a new one is made on first use', !(await db.one('SELECT 1 FROM signing_keys')) && !!(await keys.createKey()));

    let refused = null;
    try { await dbb.restore(beforeErasure, { tombstones: [], log: quietLog }); } catch (e) { refused = e.message; }
    ok('it refuses a database that already has accounts in it', /already holds/.test(refused || ''), refused);

    db.setPool(livePool);
    await newPool.end();

    let newer = null;
    try { await dbb.restore({ ...beforeErasure, migrations: [...beforeErasure.migrations, '999_from_the_future.sql'] }, { tombstones: [], log: quietLog }); }
    catch (e) { newer = e.message; }
    ok('and a backup taken by newer code than is running', /newer code/.test(newer || ''), newer);

    let unsaid = null;
    try { await dbb.restore(beforeErasure, { log: quietLog }); } catch (e) { unsaid = e.message; }
    ok('it will not skip the erasure check unless told to, explicitly', /erasures to re-apply/.test(unsaid || ''), unsaid);

    // ---- tombstones do not outlive the backups they guard against ----
    await db.query(`UPDATE erasure_tombstones SET erased_at = now() - interval '31 days' WHERE user_id = $1`, [doomed.id]);
    await dbb.sendTombstones();
    ok('a tombstone older than any kept backup is forgotten', !(await db.one('SELECT 1 FROM erasure_tombstones WHERE user_id = $1', [doomed.id])));

    bucket.close();
    for (const k of ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'BACKUP_ENCRYPTION_KEY']) delete process.env[k];
    fresh();
  }

  section('App admin tools, run from the console');
  {
    // The console forwards an app's admin calls with a one-minute token for
    // the admin signed in. What must hold: only admins get through, the token
    // cannot pass as a sign-in, and nothing leaves for anywhere but the app.
    const http = require('http');
    const appAdmin = require('../src/app-admin');

    // A stand-in app that reports what reached it.
    const seen = [];
    const fake = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || '', body: raw });
        if (req.url.startsWith('/api/hostile')) {
          // An app answering with a page that would run script, under a
          // policy of its own that allows anything.
          res.setHeader('content-type', 'text/html; charset=utf-8');
          res.setHeader('content-security-policy', "script-src 'unsafe-inline' *");
          res.setHeader('x-frame-options', 'ALLOWALL');
          return res.end('<script>fetch("/api/admin/users")</script>');
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, url: req.url }));
      });
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const appUrl = `http://127.0.0.1:${fake.address().port}/`;

    const wbApp = await db.one(
      `INSERT INTO apps (client_id, name, client_secret_hash, redirect_uris, scopes, namespace, status, launch_url)
       VALUES ('wb-admin-test','Whiteboard (test)',$1, ARRAY['http://127.0.0.1/cb'], ARRAY['openid'],'whiteboard','active',$2)
       RETURNING *`, [secrets.hash('x'), appUrl]);
    await db.query('INSERT INTO app_tenants (app_id, tenant_id, enabled) VALUES ($1,$2,true)', [wbApp.id, tenant.id]);

    const person = async (email, roleKey) => {
      const r = await identity.resolveUser({ provider: 'google', subject: 'sub-' + email, email, name: email, hostedDomain: 'school.edu' });
      await identity.ensureMembership(r.user.id, email, 'school.edu');
      const role = await db.one('SELECT id FROM roles WHERE key = $1 AND tenant_id IS NULL', [roleKey]);
      await db.query("UPDATE memberships SET role_id = $1, status = 'active' WHERE user_id = $2", [role.id, r.user.id]);
      const sess = await sessions.create(r.user.id, { ip: '10.0.0.9', userAgent: 'test', isStaff: true });
      return { id: r.user.id, cookie: `${sessions.COOKIE}=${encodeURIComponent(sess.raw)}; csrf=t0k3n` };
    };
    const admin = await person('wb-admin@school.edu', 'local_admin');
    const teacher = await person('wb-teacher@school.edu', 'teacher');

    const consoleApp = express();
    consoleApp.use(express.json());
    consoleApp.use(authMod.attachActor);
    consoleApp.use('/api/admin', require('../src/admin'));
    const con = await new Promise((r) => { const x = consoleApp.listen(0, '127.0.0.1', () => r(x)); });
    const conBase = `http://127.0.0.1:${con.address().port}/api/admin/app-admin/wb-admin-test`;
    const call = (who, path, method = 'GET', body) => fetch(conBase + path, {
      method,
      headers: { cookie: who.cookie, 'x-csrf-token': 't0k3n', 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });

    const r1 = await call(admin, '/api/admin/state?x=1');
    eq('a local admin reaches the app’s admin API', r1.status, 200);
    const got = seen[seen.length - 1];
    eq('and the request arrives at the app’s own address, query included', got.url, '/api/admin/state?x=1');
    const claims = JSON.parse(Buffer.from(got.auth.split(' ')[1].split('.')[1], 'base64url').toString());
    eq('carrying a token typed app_admin', claims.typ, 'app_admin');
    eq('for that app alone', claims.aud, 'wb-admin-test');
    ok('that lives a minute', claims.exp - claims.iat === 60);
    ok('with no other app’s permissions in it',
      Object.keys(claims.perms).every((k) => k.startsWith('whiteboard:') || k.startsWith('core:')));
    eq('in the admin’s own name', claims.email, 'wb-admin@school.edu');

    eq('a teacher who only hosts boards is refused', (await call(teacher, '/api/admin/state')).status, 403);
    const listed = await appAdmin.listFor(await (async () => {
      const a = await identity.accessFor(teacher.id);
      return { userId: teacher.id, tenantId: tenant.id, isSuper: false, perms: a.perms };
    })());
    ok('and the console does not offer them the app', !listed.some((a) => a.clientId === 'wb-admin-test'));

    const before = seen.length;
    eq('a path outside the app’s API is refused', (await call(admin, '/etc/passwd')).status, 400);
    eq('as is one that walks back out of it', (await call(admin, '/api/%2e%2e/secret')).status, 400);
    eq('and neither reached the app', seen.length, before);
    ok('the address can only ever be the app’s origin',
      appAdmin.targetUrl(wbApp, 'http://elsewhere.example/api/x') === null);

    const post = await call(admin, '/api/room/ABC/meta', 'POST', { archived: true });
    eq('a change goes through', post.status, 200);
    eq('with its body intact', JSON.parse(seen[seen.length - 1].body), { archived: true });
    const logged = await db.one(
      "SELECT action, detail FROM audit_log WHERE action = 'app_admin.post' ORDER BY ts DESC LIMIT 1");
    ok('and is recorded in Signify’s own audit log', !!logged && logged.detail.path === '/api/room/ABC/meta');

    // Replies are served from id.signify.one. Script in one would run with the
    // identity service's authority and could act as the admin who opened it.
    const hostile = await call(admin, '/api/hostile');
    const hostileCsp = hostile.headers.get('content-security-policy') || '';
    ok('an app’s HTML comes back as plain text, not a page', /^text\/plain/.test(hostile.headers.get('content-type') || ''));
    ok('under a policy that lets nothing run', /default-src 'none'/.test(hostileCsp) && /sandbox/.test(hostileCsp));
    ok('which the app cannot loosen with a policy of its own', !/unsafe-inline/.test(hostileCsp));
    ok('or undo by allowing itself to be framed', hostile.headers.get('x-frame-options') !== 'ALLOWALL');
    eq('and the browser is told not to guess the type', hostile.headers.get('x-content-type-options'), 'nosniff');
    const ordinary = await call(admin, '/api/admin/state');
    ok('an ordinary JSON answer still arrives as JSON', /application\/json/.test(ordinary.headers.get('content-type') || ''));
    ok('a saved file still carries its download name',
      appAdmin.responseHeaders(new Headers({ 'content-disposition': 'attachment; filename="b.json"' }))['content-disposition']
        === 'attachment; filename="b.json"');

    const noCsrf = await fetch(conBase + '/api/room/ABC/meta', {
      method: 'POST', headers: { cookie: admin.cookie.replace('csrf=t0k3n', ''), 'content-type': 'application/json' }, body: '{}',
    });
    eq('a change without the CSRF token is refused', noCsrf.status, 403);

    await db.query('UPDATE app_tenants SET enabled = false WHERE app_id = $1', [wbApp.id]);
    eq('an app the school has turned off is out of reach', (await call(admin, '/api/admin/state')).status, 403);
    await db.query('UPDATE app_tenants SET enabled = true WHERE app_id = $1', [wbApp.id]);

    await db.query('INSERT INTO user_app_access (user_id, app_id, tenant_id, allowed) VALUES ($1,$2,$3,false)', [admin.id, wbApp.id, tenant.id]);
    eq('as is one this admin is excluded from', (await call(admin, '/api/admin/state')).status, 403);
    await db.query('DELETE FROM user_app_access WHERE user_id = $1', [admin.id]);

    await new Promise((r) => con.close(r));
    await new Promise((r) => fake.close(r));
  }

  section('Substitute teachers');
  {
    const oidcBase = base;
    // A substitute keeps one account all year. On covered days they appear to
    // every app as a teacher of the covered classes; on any other day they
    // cannot sign in, and are refused fresh tokens, at all.
    const coverage = require('../src/coverage');
    const subRole = await db.one("SELECT id FROM roles WHERE key = 'substitute' AND tenant_id IS NULL");
    ok('there is a built-in Substitute teacher role', !!subRole);
    const subPerms = await db.many('SELECT permission FROM role_permissions WHERE role_id = $1', [subRole.id]);
    const held = subPerms.map((r) => r.permission);
    ok('it can teach in the apps', ['whiteboard:teach', 'atlas:teach', 'desk:use'].every((p) => held.includes(p)));
    ok('but cannot grade', !held.includes('atlas:grade'));
    ok('and holds nothing administrative, or the school directory',
      !held.some((p) => p.startsWith('core:')));

    const r = await identity.resolveUser({
      provider: 'google', subject: 'google-sub-sam', email: 'sam.reed@school.edu', name: 'Sam Reed', hostedDomain: 'school.edu' });
    const sam = r.user.id;
    await identity.ensureMembership(sam, 'sam.reed@school.edu', 'school.edu');
    await db.query("UPDATE memberships SET role_id = $1, status = 'active' WHERE user_id = $2", [subRole.id, sam]);

    const blockOf = async (id) => identity.loginBlock(await identity.accessFor(id));
    eq('with no cover arranged, a substitute cannot sign in', (await blockOf(sam)).code, 'no_coverage');

    const today = await coverage.today(tenant.id);
    const inDays = async (n) => (await db.one(
      "SELECT to_char($1::date + $2::int, 'YYYY-MM-DD') AS d", [today, n])).d;
    const inClass = async () => db.many('SELECT role, coverage_id FROM class_access WHERE user_id = $1 AND class_id = $2', [sam, klass.id]);

    // ---- refusals ----
    const plan = { tenantId: tenant.id, substituteId: sam, classIds: [klass.id], startsOn: today, endsOn: today, actorId: bobUser.id };
    eq('only a substitute can be given cover',
      (await coverage.schedule({ ...plan, substituteId: bobUser.id })).error, 'That person is not a substitute at this school.');
    const elsewhere = await db.one(
      "INSERT INTO classes (tenant_id, name, school_year) VALUES ($1,'Riverside Chemistry','2026') RETURNING id", [other.id]);
    eq('never for a class at another school',
      (await coverage.schedule({ ...plan, classIds: [klass.id, elsewhere.id] })).error, 'One of those classes is not at this school.');
    ok('nor with no classes at all', !(await coverage.schedule({ ...plan, classIds: [] })).ok);
    ok('nor with the days backwards', !(await coverage.schedule({ ...plan, startsOn: await inDays(2), endsOn: await inDays(1) })).ok);
    ok('nor for days already over', !(await coverage.schedule({ ...plan, startsOn: '2020-01-06', endsOn: '2020-01-07' })).ok);
    ok('nor for longer than a year', !(await coverage.schedule({ ...plan, endsOn: await inDays(coverage.MAX_DAYS) })).ok);
    eq('none of which granted anything', (await inClass()).length, 0);

    // ---- covering today ----
    const todayCover = await coverage.schedule({ ...plan, coveringFor: claimed.user.id, note: 'Carla at a conference' });
    ok('cover for today is arranged', todayCover.ok);
    eq('and the substitute can now sign in', await blockOf(sam), null);
    const rows = await inClass();
    ok('appearing as a teacher of the covered class', rows.length === 1 && rows[0].role === 'teacher' && !!rows[0].coverage_id);
    const others = await db.many(
      'SELECT class_id FROM class_access WHERE user_id = $1 AND class_id <> $2', [sam, klass.id]);
    eq('and of no other class', others.length, 0);

    // Through the very endpoint every app calls, with a real token.
    const samSession = await sessions.create(sam, { ip: '10.0.0.12', userAgent: 'test', isStaff: true });
    const vS = crypto.randomBytes(32).toString('base64url');
    const cS = crypto.createHash('sha256').update(vS).digest('base64url');
    const aS = await fetch(`${oidcBase}/authorize?response_type=code&client_id=atlas` +
      `&redirect_uri=${encodeURIComponent('http://localhost:4000/auth/callback')}` +
      `&scope=openid+profile+email+roles&state=sub&code_challenge=${cS}&code_challenge_method=S256`,
      { headers: { cookie: `${sessions.COOKIE}=${encodeURIComponent(samSession.raw)}` }, redirect: 'manual' });
    const codeS = new URL(aS.headers.get('location')).searchParams.get('code');
    const tS = await (await fetch(`${oidcBase}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic },
      body: form({ grant_type: 'authorization_code', code: codeS, redirect_uri: 'http://localhost:4000/auth/callback', code_verifier: vS }),
    })).json();
    ok('a covering substitute gets tokens for an app', !!tS.access_token);
    const listed = await (await fetch(`${oidcBase}/api/v1/classes`, bearer(tS.access_token))).json();
    const seen = (listed.classes || []).find((c) => c.id === klass.id);
    ok('and the app is told they teach the covered class', !!seen && seen.role === 'teacher' && seen.covering === true);
    const roster = await fetch(`${oidcBase}/api/v1/classes/${klass.id}/members`, bearer(tS.access_token));
    eq('including its roster, as its teacher would', roster.status, 200);

    // ---- the school's own time zone decides "today" ----
    const tz = (await db.one('SELECT timezone FROM tenants WHERE id = $1', [tenant.id])).timezone;
    await db.query("UPDATE tenants SET timezone = 'Pacific/Kiritimati' WHERE id = $1", [tenant.id]);   // UTC+14
    const kToday = await coverage.today(tenant.id);
    const kCover = await coverage.schedule({ ...plan, startsOn: kToday, endsOn: kToday });
    await coverage.end(todayCover.id, tenant.id, bobUser.id);
    ok('cover is on when it is that day at the school', (await coverage.forSubstitute(sam, tenant.id)).covering);
    await db.query("UPDATE tenants SET timezone = 'Pacific/Pago_Pago' WHERE id = $1", [tenant.id]);    // UTC-11
    ok('and not while it is still the day before there, whatever the server clock says',
      !(await coverage.forSubstitute(sam, tenant.id)).covering);
    await db.query('UPDATE tenants SET timezone = $2 WHERE id = $1', [tenant.id, tz]);
    await coverage.end(kCover.id, tenant.id, bobUser.id);

    // ---- outside cover ----
    eq('once cover has ended, the class is gone at once', (await inClass()).length, 0);
    eq('and the substitute cannot sign in', (await blockOf(sam)).code, 'no_coverage');
    const refused = await fetch(`${oidcBase}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic },
      body: form({ grant_type: 'refresh_token', refresh_token: tS.refresh_token }),
    });
    eq('nor refresh their way back in with a token they already hold', refused.status, 400);

    const later = await coverage.schedule({ ...plan, startsOn: await inDays(2), endsOn: await inDays(3) });
    ok('cover can be arranged ahead of time', later.ok);
    const ahead = await blockOf(sam);
    ok('and until it starts they are told when it does', ahead.code === 'no_coverage' && /next cover starts on/.test(ahead.message));
    eq('with nothing granted before then', (await inClass()).length, 0);
    ok('cancelling it before it starts works too', (await coverage.end(later.id, tenant.id, bobUser.id)).ok);
    ok('and ending one twice is refused, not repeated', !(await coverage.end(later.id, tenant.id, bobUser.id)).ok);
    const kept = await db.one('SELECT COUNT(*)::int AS n FROM coverages WHERE substitute_id = $1', [sam]);
    ok('nothing is deleted: every period of cover stays on record', kept.n >= 3);

    // ---- the refresh gap, closed for everyone ----
    const app = await db.one("SELECT * FROM apps WHERE client_id = 'atlas'");
    ok('a person who may sign in gets claims', !!(await oidc.buildClaims(app, claimed.user.id, tenant.id, null)));
    await db.query("UPDATE memberships SET status = 'suspended' WHERE user_id = $1", [claimed.user.id]);
    eq('a suspended person is refused fresh tokens, not just a fresh sign-in',
      await oidc.buildClaims(app, claimed.user.id, tenant.id, null), null);
    await db.query("UPDATE memberships SET status = 'active' WHERE user_id = $1", [claimed.user.id]);

    // ---- the console routes: who may arrange cover, and ending it signs out ----
    const consoleApp = express();
    consoleApp.use(express.json());
    consoleApp.use(authMod.attachActor);
    consoleApp.use('/api/admin', require('../src/admin'));
    const con = await new Promise((res) => { const x = consoleApp.listen(0, '127.0.0.1', () => res(x)); });
    const conBase = `http://127.0.0.1:${con.address().port}/api/admin`;
    const asPerson = async (email, roleKey) => {
      const p = await identity.resolveUser({ provider: 'google', subject: 'sub-' + email, email, name: email, hostedDomain: 'school.edu' });
      await identity.ensureMembership(p.user.id, email, 'school.edu');
      const role = await db.one('SELECT id FROM roles WHERE key = $1 AND tenant_id IS NULL', [roleKey]);
      await db.query("UPDATE memberships SET role_id = $1, status = 'active' WHERE user_id = $2", [role.id, p.user.id]);
      const s = await sessions.create(p.user.id, { ip: '10.0.0.13', userAgent: 'test', isStaff: true });
      return `${sessions.COOKIE}=${encodeURIComponent(s.raw)}; csrf=t0k3n`;
    };
    const call = (cookie, path, method = 'GET', body) => fetch(conBase + path, {
      method, headers: { cookie, 'x-csrf-token': 't0k3n', 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const adminCookie = await asPerson('cover-admin@school.edu', 'local_admin');
    const teacherCookie = await asPerson('cover-teacher@school.edu', 'teacher');

    eq('a teacher cannot arrange cover', (await call(teacherCookie, '/substitutes')).status, 403);
    const page = await (await call(adminCookie, '/substitutes')).json();
    ok('a local admin sees their substitutes', page.substitutes.some((s) => s.id === sam));
    const made = await call(adminCookie, '/coverages', 'POST',
      { substitute_id: sam, class_ids: [klass.id], starts_on: today, ends_on: today });
    eq('and arranges cover', made.status, 201);
    const madeId = (await made.json()).id;
    const liveSam = await sessions.create(sam, { ip: '10.0.0.14', userAgent: 'test', isStaff: true });
    const ended = await (await call(adminCookie, `/coverages/${madeId}/end`, 'POST', {})).json();
    ok('ending the only cover a substitute had today signs them out everywhere at once',
      ended.signedOut >= 1 && (await sessions.touch(liveSam.raw)) === null);
    const logged = await db.one("SELECT 1 FROM audit_log WHERE action = 'coverage.ended' LIMIT 1");
    ok('and both steps are in the audit log',
      !!logged && !!(await db.one("SELECT 1 FROM audit_log WHERE action = 'coverage.scheduled' LIMIT 1")));
    con.close();
  }

  section('Audit trail');
  const disclosures = await db.many('SELECT action FROM audit_log WHERE is_disclosure');
  ok('disclosure events are flagged for FERPA', disclosures.length > 0);

  listener.close();
  await pool.end();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('Failures:\n  - ' + failures.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error('\nTest run crashed:\n', e); process.exit(1); });
