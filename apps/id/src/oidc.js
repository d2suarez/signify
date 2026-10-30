// ===================================================================
// Signify ID — OAuth 2.0 / OpenID Connect provider
//
// Authorization code with PKCE, RS256 ID tokens, rotating refresh tokens.
// Standard wire protocol on purpose: the relying apps are plain OIDC clients,
// so this implementation can be swapped for an off-the-shelf provider later
// without touching a single app.
//
// The one deliberate departure from "just do OIDC" is claim filtering. An app
// receives `core:` claims plus its own namespace and nothing else, so
// centralising identity does not quietly create a cross-app dossier on a
// child.
// ===================================================================

const { SignJWT, jwtVerify, createLocalJWKSet } = require('jose');
const express = require('express');
const db = require('./db');
const keys = require('./keys');
const rbac = require('./rbac');
const audit = require('./audit');
const secrets = require('./secrets');
const sessions = require('./sessions');
const identity = require('./identity');
const views = require('./views');
const { config } = require('./config');

const CODE_TTL_SECONDS = 60;
const REFRESH_TTL_DAYS = 30;
const SUPPORTED_SCOPES = ['openid', 'profile', 'email', 'roles', 'roster'];

const router = express.Router();

// ---------- discovery ----------

router.get('/.well-known/openid-configuration', (req, res) => {
  res.json({
    issuer: config.issuer,
    authorization_endpoint: `${config.issuer}/authorize`,
    token_endpoint: `${config.issuer}/token`,
    userinfo_endpoint: `${config.issuer}/userinfo`,
    jwks_uri: `${config.issuer}/.well-known/jwks.json`,
    revocation_endpoint: `${config.issuer}/revoke`,
    end_session_endpoint: `${config.issuer}/logout`,
    scopes_supported: SUPPORTED_SCOPES,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    code_challenge_methods_supported: ['S256'],
    claims_supported: [
      'sub', 'iss', 'aud', 'exp', 'iat', 'nonce', 'sid',
      'email', 'email_verified', 'name', 'given_name', 'family_name', 'middle_name', 'official_name', 'picture',
      'tenant', 'tenant_name', 'tenant_kind', 'role', 'role_label', 'perms', 'is_minor', 'grade_level',
    ],
  });
});

router.get('/.well-known/jwks.json', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json(await keys.jwks());
});

// ---------- helpers ----------

async function appByClientId(clientId) {
  return db.one('SELECT * FROM apps WHERE client_id = $1', [String(clientId || '')]);
}

// Exact-match only. Prefix or wildcard matching on redirect URIs is how
// authorization codes get delivered to somebody else's server.
function redirectAllowed(app, uri) {
  return Array.isArray(app.redirect_uris) && app.redirect_uris.includes(uri);
}

function errorRedirect(res, redirectUri, state, error, description) {
  const u = new URL(redirectUri);
  u.searchParams.set('error', error);
  if (description) u.searchParams.set('error_description', description);
  if (state) u.searchParams.set('state', state);
  res.redirect(u.toString());
}

// Client authentication, either Basic or POST body.
async function authenticateClient(req) {
  let clientId = req.body.client_id;
  let clientSecret = req.body.client_secret;

  const auth = req.get('authorization') || '';
  if (/^basic /i.test(auth)) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i > 0) {
      clientId = decodeURIComponent(decoded.slice(0, i));
      clientSecret = decodeURIComponent(decoded.slice(i + 1));
    }
  }

  const app = await appByClientId(clientId);
  if (!app || app.status !== 'active') return null;
  if (!app.client_secret_hash) return null;
  if (!secrets.verify(clientSecret || '', app.client_secret_hash)) return null;
  return app;
}

// ---------- /authorize ----------

router.get('/authorize', async (req, res) => {
  const q = req.query;
  const app = await appByClientId(q.client_id);

  // Anything wrong with the client or redirect URI must be shown to the user,
  // never bounced to an unvalidated address.
  if (!app || app.status !== 'active') {
    return res.status(400).send(views.errorPage({ title: 'Unknown application', message: 'That application is not registered with Signify ID.' }));
  }
  const redirectUri = String(q.redirect_uri || '');
  if (!redirectAllowed(app, redirectUri)) {
    return res.status(400).send(views.errorPage({
      title: 'Sign-in address not recognised',
      message: `“${app.name}” asked to return to an address that is not on its approved list. Nothing has been shared.`,
    }));
  }

  const state = q.state ? String(q.state) : '';
  if (String(q.response_type || '') !== 'code') {
    return errorRedirect(res, redirectUri, state, 'unsupported_response_type', 'Only the authorization code flow is supported.');
  }
  if (String(q.code_challenge_method || '') !== 'S256' || !q.code_challenge) {
    return errorRedirect(res, redirectUri, state, 'invalid_request', 'PKCE with S256 is required.');
  }

  const requested = String(q.scope || 'openid profile email roles').split(/\s+/).filter(Boolean);
  const granted = requested.filter((s) => SUPPORTED_SCOPES.includes(s) && app.scopes.includes(s));
  if (!granted.includes('openid')) {
    return errorRedirect(res, redirectUri, state, 'invalid_scope', 'The openid scope is required.');
  }

  // Is somebody signed in here already?
  const cookies = sessions.parseCookies(req);
  const session = await sessions.touch(cookies[sessions.COOKIE]);
  if (!session) {
    // Park the request and send them to the sign-in page. The full original
    // query string comes back afterwards.
    // (Held back 2026-10-18: drawing the sign-in page right here, from
    // 0c4bd48, is not live yet and waits on Desmond's OK. Revert this to ship it.)
    const back = `/authorize?${new URLSearchParams(q).toString()}`;
    return res.redirect(`/signin?continue=${encodeURIComponent(back)}`);
  }

  const access = await identity.accessFor(session.user_id);
  const block = identity.loginBlock(access);
  if (block) {
    return res.status(403).send(views.errorPage({ title: 'Not signed in', message: block.message, signout: true }));
  }

  // Is this school allowed to use this app at all?
  const tenantId = access.membership ? access.membership.tenant_id : null;
  if (!access.isSuper) {
    const allowed = await db.one(
      'SELECT enabled FROM app_tenants WHERE app_id = $1 AND tenant_id = $2',
      [app.id, tenantId]
    );
    if (!allowed || !allowed.enabled) {
      return res.status(403).send(views.errorPage({
        title: 'Not available',
        message: `“${app.name}” has not been turned on for your school.`,
      }));
    }

    // A school can also exclude one person from an app it otherwise allows.
    // No row means "whatever the school allows", so this only ever narrows.
    const perPerson = await db.one(
      'SELECT allowed FROM user_app_access WHERE user_id = $1 AND app_id = $2',
      [session.user_id, app.id]
    );
    if (perPerson && !perPerson.allowed) {
      return res.status(403).send(views.errorPage({
        title: 'Not available',
        message: `Your school has not given your account access to “${app.name}”.`,
      }));
    }
  }

  const rawCode = keys.randomToken(32);
  await db.query(
    `INSERT INTO auth_codes (code_hash, app_id, user_id, session_id, tenant_id, redirect_uri,
                             code_challenge, scope, nonce, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + ($10 || ' seconds')::interval)`,
    [keys.sha256(rawCode), app.id, session.user_id, session.id, tenantId, redirectUri,
     String(q.code_challenge), granted.join(' '), q.nonce ? String(q.nonce) : null, String(CODE_TTL_SECONDS)]
  );

  await audit.record({
    actorUserId: session.user_id, actorEmail: access.user.email, tenantId, appId: app.id,
    action: 'oidc.authorize', targetType: 'app', targetId: app.client_id,
    detail: { scope: granted.join(' ') }, ip: req.ip, userAgent: req.get('user-agent'),
    // Handing an app a student's identity and role is a disclosure of an
    // education record, so it belongs in the FERPA-visible part of the log.
    disclosure: access.user.isMinor,
  });

  const out = new URL(redirectUri);
  out.searchParams.set('code', rawCode);
  if (state) out.searchParams.set('state', state);
  res.redirect(out.toString());
});

// ---------- token minting ----------

async function buildClaims(app, userId, tenantId, sessionId) {
  const access = await identity.accessFor(userId, tenantId);
  if (!access) return null;
  // Nothing for someone who may not sign in right now. /authorize always
  // checked this, but a refresh did not, so a person an administrator had
  // blocked or suspended — or a substitute whose cover had ended — went on
  // being handed fresh tokens for as long as their refresh token lasted.
  if (identity.loginBlock(access)) return null;

  const m = access.membership;
  // Filtered even for a super admin: an app has no business being handed
  // another app's permission set.
  const scopedPerms = rbac.forNamespace(access.perms, app.namespace);

  return {
    sub: access.user.id,
    email: access.user.email,
    email_verified: true,
    // name = the display name (what to show). given_name / family_name are
    // the school's official name where it has one, else Google's.
    name: access.user.name,
    given_name: access.user.givenName || undefined,
    family_name: access.user.familyName || undefined,
    middle_name: access.user.middleName || undefined,
    official_name: access.user.officialName,
    picture: access.user.picture || undefined,
    is_minor: access.user.isMinor,
    sid: sessionId,
    tenant: m ? m.tenant_slug : null,
    tenant_id: m ? m.tenant_id : null,
    tenant_name: m ? m.tenant_name : null,
    // 'independent' means no school: an app must not offer "share with my
    // school" to these people, since the rest of the tenant are strangers.
    tenant_kind: m ? m.tenant_kind : null,
    role: access.isSuper ? 'super_admin' : (m ? m.role_key : null),
    role_label: access.isSuper ? 'Super admin' : (m ? m.role_label : null),
    grade_level: m ? m.grade_level : null,
    perms: scopedPerms,
    is_super: access.isSuper,
  };
}

async function signToken(payload, audience, ttlSeconds, type) {
  const key = await keys.signingKey();
  return new SignJWT({ ...payload, typ: type })
    .setProtectedHeader({ alg: key.alg, kid: key.kid, typ: 'JWT' })
    .setIssuer(config.issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key.privateKey);
}

/**
 * A short-lived token that lets the console act in one app on behalf of the
 * person signed in to it (see src/app-admin.js). It carries the same claims
 * that app gets from an ordinary sign-in, so it reaches nothing the person
 * could not already reach there. The distinct `typ` lets the app accept it for
 * its admin API without it ever passing as a browser session, and it expires
 * in a minute.
 */
async function mintAppAdminToken(app, userId, tenantId, sessionId) {
  const claims = await buildClaims(app, userId, tenantId, sessionId);
  if (!claims) return null;
  return signToken(claims, app.client_id, 60, 'app_admin');
}

/**
 * How long after a rotation the same token may be presented again without it
 * being read as theft.
 *
 * Sized for one page load, not for a user's patience: a browser opening a
 * board fires its requests inside a few hundred milliseconds, and every one
 * of them renews the same expired ID token. Two seconds covers that with room
 * for a slow round trip, and is far shorter than any window in which a stolen
 * token is worth replaying.
 */
const REFRESH_GRACE_MS = 2000;

/**
 * Refresh exchanges currently running, or finished within the grace window,
 * keyed by app and token. Sharing the promise is what makes a browser's
 * parallel requests one exchange instead of a race — see the refresh_token
 * grant below.
 */
const refreshesInFlight = new Map();


async function issueTokenSet(app, userId, tenantId, sessionId, scope, nonce) {
  const claims = await buildClaims(app, userId, tenantId, sessionId);
  if (!claims) return null;

  const accessTtl = Math.max(2, app.access_token_ttl) * 60;
  const idToken = await signToken(
    nonce ? { ...claims, nonce } : claims,
    app.client_id, accessTtl, 'id'
  );
  const accessToken = await signToken(
    { sub: claims.sub, sid: sessionId, scope, tenant_id: claims.tenant_id, perms: claims.perms },
    app.client_id, accessTtl, 'at'
  );

  const rawRefresh = keys.randomToken(48);
  const refresh = await db.one(
    `INSERT INTO refresh_tokens (token_hash, app_id, user_id, session_id, expires_at)
     VALUES ($1,$2,$3,$4, now() + ($5 || ' days')::interval) RETURNING id`,
    [keys.sha256(rawRefresh), app.id, userId, sessionId, String(REFRESH_TTL_DAYS)]
  );

  return {
    token_type: 'Bearer',
    expires_in: accessTtl,
    access_token: accessToken,
    id_token: idToken,
    refresh_token: rawRefresh,
    scope,
    _refreshId: refresh.id,
  };
}

/**
 * One refresh exchange, as {status, body} rather than written to a response,
 * so that every request holding the same token can await the same answer.
 */
async function refreshGrant(app, tokenHash, req) {
  const refused = (description) => ({
    status: 400,
    body: description ? { error: 'invalid_grant', error_description: description } : { error: 'invalid_grant' },
  });

  // FOR UPDATE serialises this against another INSTANCE of the service doing
  // the same thing; the in-flight map above covers this one. Both are needed:
  // the map cannot see another container, and the lock cannot hand back the
  // tokens the other container minted.
  const claim = await db.tx(async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE', [tokenHash]);
    const found = rows[0];
    if (!found || found.app_id !== app.id) return { verdict: 'unknown' };
    if (new Date(found.expires_at) <= new Date()) return { verdict: 'expired' };

    if (found.rotated_to || found.revoked_at) {
      // Already exchanged. Whether that is theft or the second half of one
      // page load is a question of WHEN: a browser's parallel requests land
      // within a few hundred milliseconds of each other; somebody replaying a
      // captured token does not. revoked_at is stamped at the moment of
      // rotation, so it is the when.
      const at = found.revoked_at;
      const fresh = at && Date.now() - new Date(at).getTime() <= REFRESH_GRACE_MS;
      return { verdict: fresh ? 'straggler' : 'replay', row: found };
    }

    // Claimed inside the lock, so a second instance reading this row next
    // sees it taken rather than racing to mint a rival child.
    await client.query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [found.id]);
    return { verdict: 'rotate', row: found };
  });

  if (claim.verdict === 'unknown' || claim.verdict === 'expired') return refused();

  if (claim.verdict === 'straggler') {
    // Another instance handled it, so its tokens cannot be reproduced here.
    // Refuse this one exchange and pointedly do NOT revoke: the caller has a
    // sibling request holding a live token, and destroying a classroom's
    // session over a two-second-old rotation is the bug being fixed, not the
    // protection being kept.
    return refused('That refresh has just been used. Try again.');
  }

  if (claim.verdict === 'replay') {
    // Re-use detection proper: a long-rotated token is the signature of a
    // stolen one, so the whole session goes.
    await sessions.revoke(claim.row.session_id, 'refresh_replay');
    await audit.record({
      actorUserId: claim.row.user_id, appId: app.id,
      action: 'oidc.refresh_replay', targetType: 'app', targetId: app.client_id,
      detail: { note: 'Rotated refresh token reused; session revoked.' }, ip: req.ip,
    });
    return refused();
  }

  const row = claim.row;

  /**
   * From here on the parent is already spent, so anything that goes wrong
   * unexpectedly has to give it back. Otherwise a momentary database hiccup
   * between claiming the token and issuing its replacement burns the only
   * credential the browser has, and a classroom is signed out by a blip.
   * A deliberate refusal below is different — the session really is over, and
   * the token should stay spent.
   */
  try {
    return await issueFrom(app, row);
  } catch (e) {
    await db.query('UPDATE refresh_tokens SET revoked_at = NULL WHERE id = $1 AND rotated_to IS NULL', [row.id])
      .catch(() => { /* the retry will fail honestly rather than silently */ });
    throw e;
  }
}

/** The second half of a refresh, once the token has been claimed. */
async function issueFrom(app, row) {
  const refused = (description) => ({
    status: 400,
    body: description ? { error: 'invalid_grant', error_description: description } : { error: 'invalid_grant' },
  });

  // Slid, not merely checked. This used to test the absolute clock only,
  // which let an app refresh its tokens forever against a session the API had
  // already given up on for idleness — signed in over here, refused over
  // there. Refreshing is using the session, so it counts as activity; and a
  // session that has genuinely gone idle now ends here, honestly, rather than
  // half-working.
  const live = await sessions.slide(row.session_id);
  if (!live) return refused('That sign-in is no longer valid.');

  const codeRow = await db.one(
    'SELECT tenant_id, scope FROM auth_codes WHERE session_id = $1 AND app_id = $2 ORDER BY expires_at DESC LIMIT 1',
    [row.session_id, app.id]);
  const tokens = await issueTokenSet(
    app, row.user_id, codeRow ? codeRow.tenant_id : null, row.session_id,
    codeRow ? codeRow.scope : 'openid profile email roles', null);
  if (!tokens) return refused();

  await db.query('UPDATE refresh_tokens SET rotated_to = $2 WHERE id = $1', [row.id, tokens._refreshId]);
  delete tokens._refreshId;
  return { status: 200, body: tokens };
}

// ---------- /token ----------

router.post('/token', async (req, res) => {
  const app = await authenticateClient(req);
  if (!app) {
    res.set('WWW-Authenticate', 'Basic realm="signify-id"');
    return res.status(401).json({ error: 'invalid_client' });
  }

  const grantType = String(req.body.grant_type || '');

  // --- authorization_code ---
  if (grantType === 'authorization_code') {
    const codeHash = keys.sha256(String(req.body.code || ''));
    const row = await db.one('SELECT * FROM auth_codes WHERE code_hash = $1', [codeHash]);

    if (!row) return res.status(400).json({ error: 'invalid_grant' });

    // A code presented twice means it leaked. Kill the session it belongs to
    // rather than just refusing the second attempt.
    if (row.used_at) {
      await sessions.revoke(row.session_id, 'code_replay');
      await audit.record({
        actorUserId: row.user_id, tenantId: row.tenant_id, appId: app.id,
        action: 'oidc.code_replay', targetType: 'app', targetId: app.client_id,
        detail: { note: 'Authorization code reused; session revoked.' }, ip: req.ip,
      });
      return res.status(400).json({ error: 'invalid_grant' });
    }
    if (row.app_id !== app.id) return res.status(400).json({ error: 'invalid_grant' });
    if (new Date(row.expires_at) <= new Date()) return res.status(400).json({ error: 'invalid_grant', error_description: 'The code has expired.' });
    if (row.redirect_uri !== String(req.body.redirect_uri || '')) return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch.' });

    const verifier = String(req.body.code_verifier || '');
    const challenge = require('crypto').createHash('sha256').update(verifier).digest('base64url');
    if (!verifier || challenge !== row.code_challenge) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed.' });
    }

    await db.query('UPDATE auth_codes SET used_at = now() WHERE code_hash = $1', [codeHash]);

    // The session must still be alive — an administrator may have blocked the
    // account in the seconds since the code was issued.
    const live = await db.one(
      `SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
          AND u.deleted_at IS NULL AND u.status NOT IN ('blocked','suspended')`,
      [row.session_id]
    );
    if (!live) return res.status(400).json({ error: 'invalid_grant', error_description: 'That sign-in is no longer valid.' });

    const tokens = await issueTokenSet(app, row.user_id, row.tenant_id, row.session_id, row.scope, row.nonce);
    if (!tokens) return res.status(400).json({ error: 'invalid_grant' });
    delete tokens._refreshId;
    res.set('Cache-Control', 'no-store');
    return res.json(tokens);
  }

  // --- refresh_token ---
  //
  // One exchange at a time per token, however many requests arrive holding
  // it. A browser opening a board fires half a dozen requests at once and
  // every one of them renews the same expired ID token; before this they
  // raced, two of them minted rival children one millisecond apart, and the
  // orphaned branch came back forty minutes later looking exactly like a
  // stolen token — so the session was destroyed, mid-lesson, as a theft.
  //
  // The answer is memoised for the grace window as well as shared while it is
  // in flight, so a straggler that arrives just after the winner finishes is
  // handed the same tokens rather than a fresh pair. That matters: the
  // browser keeps whichever Set-Cookie landed last, and it has to be a live
  // one.
  if (grantType === 'refresh_token') {
    const tokenHash = keys.sha256(String(req.body.refresh_token || ''));
    const key = `${app.id}:${tokenHash}`;

    let job = refreshesInFlight.get(key);
    if (!job) {
      job = refreshGrant(app, tokenHash, req);
      refreshesInFlight.set(key, job);
      const forget = () => {
        const timer = setTimeout(() => refreshesInFlight.delete(key), REFRESH_GRACE_MS);
        if (timer.unref) timer.unref();     // never hold a process open for this
      };
      job.then(forget, forget);
    }

    const out = await job;
    if (out.status === 200) res.set('Cache-Control', 'no-store');
    return res.status(out.status).json(out.body);
  }

  return res.status(400).json({ error: 'unsupported_grant_type' });
});

// ---------- /userinfo ----------

let localJwks = null;
async function verifyAccessToken(token) {
  const set = await keys.jwks();
  localJwks = createLocalJWKSet(set);
  const { payload } = await jwtVerify(token, localJwks, { issuer: config.issuer });
  if (payload.typ !== 'at') throw new Error('Not an access token.');
  return payload;
}

router.get('/userinfo', async (req, res) => {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  let payload;
  try { payload = await verifyAccessToken(token); }
  catch { res.set('WWW-Authenticate', 'Bearer error="invalid_token"'); return res.status(401).json({ error: 'invalid_token' }); }

  // Cheap tokens, live check: a 10-minute access token is still checked
  // against the session row so a block bites within seconds, not minutes.
  const live = await sessions.slide(payload.sid);
  if (!live) return res.status(401).json({ error: 'invalid_token', error_description: 'That sign-in has ended.' });

  const app = await db.one('SELECT * FROM apps WHERE client_id = $1', [String(payload.aud)]);
  if (!app) return res.status(401).json({ error: 'invalid_token' });

  const claims = await buildClaims(app, payload.sub, payload.tenant_id, payload.sid);
  res.set('Cache-Control', 'no-store');
  res.json(claims);
});

// ---------- /revoke ----------

router.post('/revoke', async (req, res) => {
  const app = await authenticateClient(req);
  if (!app) return res.status(401).json({ error: 'invalid_client' });
  const tokenHash = keys.sha256(String(req.body.token || ''));
  await db.query(
    'UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND app_id = $2 AND revoked_at IS NULL',
    [tokenHash, app.id]
  );
  // RFC 7009: always 200, so a caller cannot probe which tokens exist.
  res.status(200).end();
});

module.exports = {
  router, verifyAccessToken, buildClaims, mintAppAdminToken, authenticateClient, SUPPORTED_SCOPES,
  // For the tests: lets them step past the grace window without sleeping
  // through it, so re-use detection can be exercised in its own right.
  _forgetRecentRefreshes: () => refreshesInFlight.clear(),
  REFRESH_GRACE_MS,
};
