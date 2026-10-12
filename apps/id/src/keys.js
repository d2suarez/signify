// ===================================================================
// Signify ID — token signing keys
// RS256 keypairs live in the database so every replica signs with the same
// key and a restart does not invalidate outstanding tokens. Relying apps only
// ever hold the public half, fetched from /.well-known/jwks.json.
// ===================================================================

const crypto = require('crypto');
const { generateKeyPair, exportJWK, importPKCS8, calculateJwkThumbprint } = require('jose');
const db = require('./db');

const ALG = 'RS256';
// Keys older than this stop signing new tokens but stay published until every
// token they signed has expired.
const ROTATE_AFTER_DAYS = 90;
const PUBLISH_AFTER_RETIRE_HOURS = 48;

let cache = null;          // { active, all: [{kid, alg, publicJwk, privateKey}] }
let cacheAt = 0;
const CACHE_MS = 60_000;

async function createKey() {
  const { publicKey, privateKey } = await generateKeyPair(ALG, { modulusLength: 2048, extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  publicJwk.kid = kid;
  publicJwk.alg = ALG;
  publicJwk.use = 'sig';
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  await db.query(
    'INSERT INTO signing_keys (kid, alg, public_jwk, private_pem) VALUES ($1,$2,$3,$4) ON CONFLICT (kid) DO NOTHING',
    [kid, ALG, JSON.stringify(publicJwk), privatePem]
  );
  cache = null;
  return kid;
}

async function load() {
  if (cache && Date.now() - cacheAt < CACHE_MS) return cache;

  let rows = await db.many('SELECT kid, alg, public_jwk, private_pem, created_at, retired_at FROM signing_keys ORDER BY created_at DESC');
  if (!rows.length) {
    await createKey();
    rows = await db.many('SELECT kid, alg, public_jwk, private_pem, created_at, retired_at FROM signing_keys ORDER BY created_at DESC');
  }

  const all = [];
  for (const r of rows) {
    all.push({
      kid: r.kid,
      alg: r.alg,
      publicJwk: r.public_jwk,
      privateKey: await importPKCS8(r.private_pem, r.alg),
      createdAt: r.created_at,
      retiredAt: r.retired_at,
    });
  }

  const active = all.find((k) => !k.retiredAt) || all[0];
  cache = { active, all };
  cacheAt = Date.now();
  return cache;
}

async function signingKey() {
  return (await load()).active;
}

// Public key set. Retired keys linger briefly so tokens minted just before a
// rotation still verify.
async function jwks() {
  const { all } = await load();
  const cutoff = Date.now() - PUBLISH_AFTER_RETIRE_HOURS * 3600 * 1000;
  return {
    keys: all
      .filter((k) => !k.retiredAt || new Date(k.retiredAt).getTime() > cutoff)
      .map((k) => k.publicJwk),
  };
}

// Called from the maintenance sweep.
async function rotateIfDue() {
  const { active } = await load();
  const ageDays = (Date.now() - new Date(active.createdAt).getTime()) / 864e5;
  if (ageDays < ROTATE_AFTER_DAYS) return null;
  await db.query('UPDATE signing_keys SET retired_at = now() WHERE kid = $1 AND retired_at IS NULL', [active.kid]);
  const kid = await createKey();
  console.log(`Signing key rotated: ${active.kid} retired, ${kid} active.`);
  return kid;
}

// Opaque secrets (session cookies, auth codes, refresh tokens) are stored as
// hashes so a database leak does not hand over live credentials.
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

module.exports = { ALG, load, signingKey, jwks, createKey, rotateIfDue, sha256, randomToken };
