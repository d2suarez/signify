// ===================================================================
// signify-auth.js — drop-in Signify ID client for an Express app
//
// Copy this one file into an app, set four environment variables, and call
// mount(). It has no dependencies beyond Node's own crypto, so it never drags
// a version conflict into a project.
//
//   const signify = require('./signify-auth');
//   signify.mount(app);                       // adds /auth/login, /auth/callback, /auth/logout
//   app.use(signify.middleware);              // sets req.user on every request
//   app.get('/api/x', signify.requireUser, ...);
//   app.post('/api/y', signify.requirePerm('atlas:grade', 'class'), ...);
//
// Environment:
//   SIGNIFY_ISSUER          https://id.signify.one
//   SIGNIFY_CLIENT_ID       from the Applications page
//   SIGNIFY_CLIENT_SECRET   shown once when the app is registered
//   SIGNIFY_REDIRECT_URI    https://your-app/auth/callback
//   SIGNIFY_COOKIE_SECRET   openssl rand -hex 32   (signs the state cookie)
// ===================================================================

'use strict';

const crypto = require('crypto');

const ISSUER = (process.env.SIGNIFY_ISSUER || '').replace(/\/+$/, '');
const CLIENT_ID = process.env.SIGNIFY_CLIENT_ID || '';
const CLIENT_SECRET = process.env.SIGNIFY_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.SIGNIFY_REDIRECT_URI || '';
const COOKIE_SECRET = process.env.SIGNIFY_COOKIE_SECRET || '';
const PRODUCTION = !!process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production';

const ENABLED = !!(ISSUER && CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);

const TOKEN_COOKIE = 'sfy_id';
const REFRESH_COOKIE = 'sfy_rt';
const STATE_COOKIE = 'sfy_st';

const SCOPE_RANK = { own: 1, class: 2, tenant: 3, global: 4 };

if (!ENABLED) {
  console.warn('signify-auth: not configured (SIGNIFY_ISSUER / CLIENT_ID / CLIENT_SECRET / REDIRECT_URI). Sign-in is disabled.');
}
if (ENABLED && PRODUCTION && !COOKIE_SECRET) {
  throw new Error('signify-auth: SIGNIFY_COOKIE_SECRET must be set in production.');
}

const secretKey = COOKIE_SECRET || crypto.randomBytes(32).toString('hex');

// ---------- small helpers ----------

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (v) => crypto.createHash('sha256').update(v).digest();

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); }
    catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

function setCookie(res, name, value, maxAgeMs) {
  const bits = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (PRODUCTION) bits.push('Secure');
  appendHeader(res, 'Set-Cookie', bits.join('; '));
}

function clearCookie(res, name) {
  appendHeader(res, 'Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${PRODUCTION ? '; Secure' : ''}`);
}

function appendHeader(res, name, value) {
  const prev = res.getHeader(name);
  if (!prev) res.setHeader(name, [value]);
  else res.setHeader(name, Array.isArray(prev) ? prev.concat(value) : [prev, value]);
}

// The state cookie carries the PKCE verifier through the round trip to Google
// and back. Signed so it cannot be swapped for an attacker's.
function sign(payload) {
  const body = b64u(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', secretKey).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function unsign(token) {
  try {
    const [body, mac] = String(token || '').split('.');
    if (!body || !mac) return null;
    const expect = crypto.createHmac('sha256', secretKey).update(body).digest('base64url');
    const a = Buffer.from(mac), b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch { return null; }
}

// ---------- JWKS ----------
// Cached, with the previous copy kept as a fallback: if Signify ID is briefly
// unreachable, already-issued tokens keep verifying instead of every app in
// the fleet going down together.

let jwksCache = { keys: [], fetchedAt: 0 };
const JWKS_TTL_MS = 10 * 60 * 1000;

async function getKeys(forceKid) {
  const fresh = Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS;
  const known = forceKid ? jwksCache.keys.some((k) => k.kid === forceKid) : true;
  if (fresh && known && jwksCache.keys.length) return jwksCache.keys;

  try {
    const res = await fetch(`${ISSUER}/.well-known/jwks.json`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`JWKS responded ${res.status}`);
    const body = await res.json();
    if (Array.isArray(body.keys) && body.keys.length) {
      jwksCache = { keys: body.keys, fetchedAt: Date.now() };
    }
  } catch (e) {
    // Keep serving from the stale cache rather than logging everyone out.
    console.warn('signify-auth: could not refresh JWKS —', e.message);
  }
  return jwksCache.keys;
}

async function verifyJwt(token, expectedType) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;

  let header, payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch { return null; }

  if (header.alg !== 'RS256') return null; // never trust an alg the token names for itself beyond this
  const keys = await getKeys(header.kid);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;

  let ok = false;
  try {
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    ok = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      key,
      Buffer.from(parts[2], 'base64url')
    );
  } catch { return null; }
  if (!ok) return null;

  if (payload.iss !== ISSUER) return null;
  if (payload.aud !== CLIENT_ID) return null;
  if (!payload.exp || payload.exp * 1000 <= Date.now()) return null;
  if (expectedType && payload.typ !== expectedType) return null;
  return payload;
}

// ---------- token endpoint ----------

async function tokenRequest(body) {
  const res = await fetch(`${ISSUER}/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: 'Basic ' + Buffer.from(`${encodeURIComponent(CLIENT_ID)}:${encodeURIComponent(CLIENT_SECRET)}`).toString('base64'),
    },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || `token endpoint returned ${res.status}`);
  return data;
}

function storeTokens(res, tokens) {
  // The ID token is short-lived by design; the refresh token is what actually
  // keeps someone signed in, and it is checked against a live session on the
  // identity service every time it is used.
  setCookie(res, TOKEN_COOKIE, tokens.id_token, (tokens.expires_in || 600) * 1000);
  if (tokens.refresh_token) setCookie(res, REFRESH_COOKIE, tokens.refresh_token, 30 * 864e5);
}

// ---------- declaring what this app can do ----------

/**
 * Tells Signify ID which permissions this app has, so they can be put into
 * roles. Safe to call on every boot — it is an upsert, and a permission the
 * app stops declaring is retired rather than deleted.
 *
 * Keys must begin with this app's namespace; the server refuses anything
 * else, which is why an app is allowed to write here at all.
 *
 *   signify.declarePermissions([
 *     { key: 'atlas:teach', label: 'Create maps and assignments' },
 *     { key: 'atlas:grade', label: 'Grade and override scores' },
 *     { key: 'atlas:moderate', label: 'Remove any map', admin: true },
 *   ]);
 */
async function declarePermissions(permissions, { retries = 3 } = {}) {
  if (!ENABLED) return { ok: false, error: 'signify-auth is not configured.' };

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(`${ISSUER}/api/v1/declare`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Basic ' + Buffer.from(
            `${encodeURIComponent(CLIENT_ID)}:${encodeURIComponent(CLIENT_SECRET)}`).toString('base64'),
        },
        body: JSON.stringify({ permissions }),
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // A rejected declaration is a mistake in this app's manifest and will
        // not fix itself, so say so loudly and stop retrying.
        console.error('signify-auth: permission declaration rejected —', data.error);
        return { ok: false, error: data.error };
      }
      console.log(`signify-auth: declared ${data.declared.length} permission(s)` +
        (data.retired && data.retired.length ? `, retired ${data.retired.length}` : ''));
      return data;
    } catch (e) {
      // Identity may simply not be up yet. Back off and try again rather than
      // failing the app's boot over it.
      if (attempt === retries) {
        console.warn('signify-auth: could not declare permissions —', e.message);
        return { ok: false, error: e.message };
      }
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
}

// ---------- routes ----------

// Where to land after sign-in. Only ever a path on this app.
//
// Rejecting a leading "//" is not enough on its own: browsers normalise a
// backslash to a forward slash while parsing a URL, so "/\\evil.example" is
// read as "//evil.example" and the sign-in flow hands the person to somebody
// else's site. Control characters are stripped during parsing for the same
// reason. A single leading slash and ordinary path characters, or nothing.
function safeReturn(value) {
  const v = String(value || '/');
  if (!v.startsWith('/') || v.startsWith('//')) return '/';
  // eslint-disable-next-line no-control-regex
  if (/[\\\x00-\x1f\x7f]/.test(v)) return '/';
  return v;
}

function mount(app, options = {}) {
  const prefix = options.prefix || '/auth';

  // Declaring at mount time keeps an app's permissions in its own repo, next
  // to the code that checks them.
  if (options.permissions) {
    declarePermissions(options.permissions).catch(() => {});
  }

  app.get(`${prefix}/login`, (req, res) => {
    if (!ENABLED) return res.status(503).send('Sign-in is not configured on this server.');

    const verifier = b64u(crypto.randomBytes(32));
    const challenge = b64u(sha256(verifier));
    const stateValue = b64u(crypto.randomBytes(16));
    const nonce = b64u(crypto.randomBytes(16));

    setCookie(res, STATE_COOKIE, sign({
      v: verifier, s: stateValue, n: nonce,
      r: safeReturn(req.query.return),
      exp: Date.now() + 10 * 60 * 1000,
    }), 10 * 60 * 1000);

    const url = new URL(`${ISSUER}/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('scope', options.scope || 'openid profile email roles');
    url.searchParams.set('state', stateValue);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    res.redirect(url.toString());
  });

  app.get(`${prefix}/callback`, async (req, res) => {
    const parked = unsign(parseCookies(req)[STATE_COOKIE]);
    clearCookie(res, STATE_COOKIE);

    if (req.query.error) {
      return res.status(400).send(`Sign-in was refused: ${String(req.query.error_description || req.query.error)}`);
    }
    if (!parked) return res.redirect(`${prefix}/login`); // expired; just start again
    if (String(req.query.state || '') !== parked.s) return res.status(400).send('Sign-in could not be completed. Please try again.');

    try {
      const tokens = await tokenRequest({
        grant_type: 'authorization_code',
        code: String(req.query.code || ''),
        redirect_uri: REDIRECT_URI,
        code_verifier: parked.v,
      });
      const claims = await verifyJwt(tokens.id_token, 'id');
      if (!claims) return res.status(502).send('Sign-in could not be verified. Please try again.');
      if (parked.n && claims.nonce !== parked.n) return res.status(400).send('Sign-in could not be verified. Please try again.');

      storeTokens(res, tokens);
      if (options.onSignIn) await options.onSignIn(claims, req, res);
      res.redirect(parked.r || '/');
    } catch (e) {
      console.error('signify-auth: callback failed —', e.message);
      res.status(502).send('Could not complete sign-in. Please try again.');
    }
  });

  app.get(`${prefix}/logout`, (req, res) => {
    clearCookie(res, TOKEN_COOKIE);
    clearCookie(res, REFRESH_COOKIE);
    clearCookie(res, STATE_COOKIE);
    // Ending the session centrally as well, so every other app drops too.
    const url = new URL(`${ISSUER}/logout`);
    if (options.postLogoutUri) url.searchParams.set('post_logout_redirect_uri', options.postLogoutUri);
    res.redirect(url.toString());
  });

  // The apps this person may open, for the switcher.
  //
  // Proxied through this app's own origin rather than fetched from Signify ID
  // by the browser. A cross-origin request would not carry the session cookie
  // — browsers stopped sending those in third-party contexts — so the server
  // asks on the page's behalf with the token it already holds.
  app.get(`${prefix}/apps`, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not signed in.' });
    try {
      const upstream = await fetch(`${ISSUER}/api/v1/my-apps`, {
        headers: { authorization: `Bearer ${parseCookies(req)[TOKEN_COOKIE] || ''}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!upstream.ok) return res.status(502).json({ error: 'Could not reach Signify ID.' });
      const body = await upstream.json();
      res.set('Cache-Control', 'private, max-age=60');
      res.json(body);
    } catch (e) {
      // The switcher is a convenience; if identity is briefly unreachable the
      // app itself must carry on working.
      res.status(502).json({ error: 'Could not reach Signify ID.' });
    }
  });

  // Handy for the browser: who am I, in JSON.
  app.get(`${prefix}/me`, (req, res) => {
    if (!req.user) return res.status(401).json({ signedIn: false });
    res.json({ signedIn: true, user: req.user });
  });
}

/**
 * One renewal at a time per refresh token, shared by every request that turns
 * up holding it.
 *
 * A browser opening a page fires half a dozen requests at once, and when the
 * ID token has expired every one of them lands here wanting to renew. Without
 * this they each POST the same refresh token: the identity service rotates
 * it for the first and sees the rest presenting a spent token, which is the
 * signature of a stolen one — so the session is destroyed and a teacher loses
 * their class lists in the middle of a lesson. That is not a hypothetical; it
 * is what the production audit log showed, twice in an afternoon.
 *
 * The service has its own defence against this now, but the request that
 * should never have been sent is the one that cannot go wrong.
 */
const renewals = new Map();

function renew(refreshToken) {
  const existing = renewals.get(refreshToken);
  if (existing) return existing;

  const job = tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  renewals.set(refreshToken, job);
  // Held only while it is in flight — the token is spent afterwards, so a
  // later request arrives with the new one and starts its own.
  const done = () => renewals.delete(refreshToken);
  job.then(done, done);
  return job;
}

// ---------- middleware ----------

async function middleware(req, res, next) {
  if (!ENABLED) return next();
  try {
    const cookies = parseCookies(req);
    let claims = await verifyJwt(cookies[TOKEN_COOKIE], 'id');

    // Expired ID token but a refresh token in hand: renew silently. This is
    // also the moment a block or role change on the identity service takes
    // effect, because the refresh is checked against the live session.
    if (!claims && cookies[REFRESH_COOKIE]) {
      try {
        const tokens = await renew(cookies[REFRESH_COOKIE]);
        claims = await verifyJwt(tokens.id_token, 'id');
        if (claims) storeTokens(res, tokens);
      } catch (e) {
        // Refused refresh means the session is genuinely over.
        clearCookie(res, TOKEN_COOKIE);
        clearCookie(res, REFRESH_COOKIE);
      }
    }

    if (claims) {
      req.user = {
        id: claims.sub,
        email: claims.email,
        name: claims.name,
        picture: claims.picture,
        role: claims.role,
        roleLabel: claims.role_label,
        isSuper: !!claims.is_super,
        isMinor: !!claims.is_minor,
        tenant: claims.tenant,
        tenantId: claims.tenant_id,
        tenantName: claims.tenant_name,
        gradeLevel: claims.grade_level,
        perms: claims.perms || {},
        sessionId: claims.sid,
      };
    }
  } catch (e) {
    console.error('signify-auth: middleware error —', e.message);
  }
  next();
}

/**
 * Verifies a session straight from a Cookie header, for connections that are
 * not express requests — a WebSocket handshake, most obviously.
 *
 * socket.io sends the browser's cookies on the handshake for a same-origin
 * connection, so this is how a realtime app authenticates without the client
 * having to hold a token it could leak. Returns the same user shape the
 * middleware puts on req.user, or null.
 *
 *   io.use(async (socket, next) => {
 *     const user = await signify.verifyCookieSession(socket.handshake.headers.cookie);
 *     if (!user) return next(new Error('unauthorized'));
 *     socket.data.user = user;
 *     next();
 *   });
 *
 * Note there is no refresh here: an expired ID token means the socket is
 * refused and the browser reconnects after the next page request renews it.
 */
async function verifyCookieSession(cookieHeader) {
  if (!ENABLED) return null;
  const cookies = parseCookies({ headers: { cookie: cookieHeader || '' } });
  const claims = await verifyJwt(cookies[TOKEN_COOKIE], 'id');
  if (!claims) return null;
  return {
    id: claims.sub,
    email: claims.email,
    name: claims.name,
    picture: claims.picture,
    role: claims.role,
    roleLabel: claims.role_label,
    isSuper: !!claims.is_super,
    isMinor: !!claims.is_minor,
    tenant: claims.tenant,
    tenantId: claims.tenant_id,
    tenantName: claims.tenant_name,
    gradeLevel: claims.grade_level,
    perms: claims.perms || {},
    sessionId: claims.sid,
  };
}

// ---------- guards ----------

function has(user, permission, scope = 'own') {
  if (!user) return false;
  if (user.isSuper) return true;
  const held = user.perms[permission];
  return !!held && SCOPE_RANK[held] >= SCOPE_RANK[scope];
}

function wantsJson(req) {
  return req.xhr || req.path.startsWith('/api/') || /application\/json/.test(req.get('accept') || '');
}

function requireUser(req, res, next) {
  if (req.user) return next();
  if (wantsJson(req)) return res.status(401).json({ error: 'Please sign in.' });
  res.redirect('/auth/login?return=' + encodeURIComponent(req.originalUrl));
}

function requirePerm(permission, scope = 'own') {
  return (req, res, next) => {
    if (!req.user) return requireUser(req, res, next);
    if (has(req.user, permission, scope)) return next();
    if (wantsJson(req)) return res.status(403).json({ error: 'Your role does not allow that.' });
    res.status(403).send('Your role does not allow that.');
  };
}

// Teachers act on their own classes; this is the roster question an app asks
// before showing one child's work to an adult.
async function isInSameClass(req, otherUserId) {
  if (!req.user) return false;
  try {
    const res = await fetch(`${ISSUER}/api/v1/shares-class?a=${encodeURIComponent(req.user.id)}&b=${encodeURIComponent(otherUserId)}`, {
      headers: { authorization: `Bearer ${parseCookies(req)[TOKEN_COOKIE] || ''}` },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return false;
    const body = await res.json();
    return !!body.shares;
  } catch { return false; }
}

module.exports = {
  mount, middleware, requireUser, requirePerm, has, isInSameClass, declarePermissions,
  verifyCookieSession,
  ENABLED, ISSUER, CLIENT_ID,
  _internal: { verifyJwt, parseCookies, sign, unsign },
};
