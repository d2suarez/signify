// Client secret hashing. scrypt with a per-secret salt; the plaintext is shown
// once at registration and never stored.
const crypto = require('crypto');

const N = 16384, r = 8, p = 1, KEYLEN = 32;

function hash(secret) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(secret), salt, KEYLEN, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

function verify(secret, stored) {
  try {
    const [scheme, n, rr, pp, salt, key] = String(stored || '').split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(key, 'base64');
    const actual = crypto.scryptSync(String(secret), Buffer.from(salt, 'base64'), expected.length,
      { N: Number(n), r: Number(rr), p: Number(pp) });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch { return false; }
}

const generate = () => crypto.randomBytes(32).toString('base64url');

module.exports = { hash, verify, generate };
