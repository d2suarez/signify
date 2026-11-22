'use strict';

// Lets Teacher's Desk ask /api/desk/* on a teacher's behalf.
//
// The desk server forwards the Signify ID token it already holds for that
// teacher. It is checked here exactly as signify-auth checks this app's own —
// signed by Signify ID, unexpired, an ID token — except that its audience is
// the desk (allowed by DESK_CLIENT_IDS), not this app.
//
// That token's permissions are the DESK's (Signify ID scopes perms to the app
// a token was minted for), so it says nothing about helpdesk:agent/admin. The
// person is marked vouchedBy, and lib/auth.ts keeps the help desk role it has
// on file instead of believing an empty perms list.

const crypto = require('crypto');
const signify = require('./signify-auth');

const DESK_CLIENT_IDS = (process.env.DESK_CLIENT_IDS || 'teachers-desk')
  .split(',').map((s) => s.trim()).filter(Boolean);

let jwks = { keys: [], fetchedAt: 0 };
async function keys(kid) {
  const fresh = Date.now() - jwks.fetchedAt < 10 * 60 * 1000;
  if (fresh && jwks.keys.some((k) => k.kid === kid)) return jwks.keys;
  try {
    const res = await fetch(`${signify.ISSUER}/.well-known/jwks.json`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) jwks = { keys: (await res.json()).keys || [], fetchedAt: Date.now() };
  } catch (e) {
    console.warn('desk-bearer: could not refresh JWKS —', e.message);
  }
  return jwks.keys;
}

async function verify(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch { return null; }
  if (header.alg !== 'RS256') return null;
  const jwk = (await keys(header.kid)).find((k) => k.kid === header.kid);
  if (!jwk) return null;
  try {
    const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`),
      crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
    if (!ok) return null;
  } catch { return null; }
  if (payload.iss !== signify.ISSUER) return null;
  if (!DESK_CLIENT_IDS.includes(payload.aud)) return null;
  if (!payload.exp || payload.exp * 1000 <= Date.now()) return null;
  if (payload.typ !== 'id') return null;
  return payload;
}

/** Express middleware for /api/desk: sets req.user from a desk's bearer token. */
async function middleware(req, res, next) {
  try {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    if (!req.user && m && signify.ENABLED) {
      const c = await verify(m[1]);
      if (c) {
        req.user = {
          id: c.sub, email: c.email, name: c.name, picture: c.picture,
          role: c.role, roleLabel: c.role_label,
          isSuper: !!c.is_super, isMinor: !!c.is_minor,
          tenant: c.tenant, tenantId: c.tenant_id, tenantName: c.tenant_name,
          tenantKind: c.tenant_kind || null,
          perms: {}, sessionId: c.sid,
          vouchedBy: c.aud,
        };
      }
    }
  } catch (e) {
    console.error('desk-bearer:', e.message);
  }
  next();
}

module.exports = { middleware, verify, DESK_CLIENT_IDS };
