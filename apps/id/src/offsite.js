// ===================================================================
// Classroom Whiteboard — off-site backups, to S3-compatible storage
//
// The volume this app writes to is one disk in one region, and a backup that
// lives on the disk it is protecting is not a backup. So each night's archive
// is also pushed somewhere else.
//
// Cloudflare R2 by default, but this speaks plain S3, so Backblaze B2 or S3
// itself work by changing the endpoint.
//
// Shared, byte for byte, by every app that backs up off-site: the Whiteboard,
// Teacher's Desk and Classroom Atlas (server/offsite.js) and Signify ID
// (src/offsite.js). Change one, copy it to the others.
//
// Every archive is ENCRYPTED HERE, before it leaves Railway (AES-256-GCM,
// BACKUP_ENCRYPTION_KEY, 64 hex characters from `openssl rand -hex 32`). The
// storage company holds bytes it cannot read, and the key lives only in this
// service and in the operator's password manager. With no valid key, nothing
// is sent at all: an unencrypted copy is not a fallback, it is a leak.
//
// To open one:
//   read -rs BACKUP_ENCRYPTION_KEY && export BACKUP_ENCRYPTION_KEY
//   node offsite.js decrypt backup-2026-09-28.tar.gz.enc backup-2026-09-28.tar.gz
//
// Two things about the choice, because they are the whole reason it is this
// and not Google Drive:
//
//   * The credential is scoped to ONE BUCKET. If it leaked it would reach the
//     backups and nothing else — not a personal Drive, not a school account,
//     nothing with a life attached to it.
//   * No SDK. SigV4 is a hash chain and about a hundred lines; the AWS client
//     is a few hundred packages. This app's manifest is three dependencies and
//     that is worth keeping.
// ===================================================================

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const http = require('http');

const ACCOUNT = process.env.R2_ACCOUNT_ID || '';
const BUCKET = process.env.R2_BUCKET || '';
const KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
const SECRET = process.env.R2_SECRET_ACCESS_KEY || '';
// Set this to point at B2 or S3 instead. R2's is derived from the account id.
const ENDPOINT = (process.env.R2_ENDPOINT || (ACCOUNT ? `https://${ACCOUNT}.r2.cloudflarestorage.com` : '')).replace(/\/+$/, '');
// R2 has no regions; 'auto' is what it expects in the signature.
const REGION = process.env.R2_REGION || 'auto';
// The folder inside the bucket. Each app names its own with configure(), so
// two apps pointed at one bucket can never prune each other's archives; the
// environment variable, if set, still wins.
let PREFIX = process.env.R2_PREFIX || 'backups/';

function configure({ prefix } = {}) {
  if (prefix && !process.env.R2_PREFIX) PREFIX = String(prefix).replace(/\/*$/, '/');
  return module.exports;
}

const enabled = () => !!(ENDPOINT && BUCKET && KEY_ID && SECRET);

// ---------- encryption ----------
// Format: MAGIC (16 bytes) | IV (12) | ciphertext | GCM tag (16). The tag
// means a wrong key or a single altered byte fails loudly instead of
// producing a subtly broken archive.
const MAGIC = Buffer.from('SIGNIFY-BACKUP-1');
const keyFrom = (hex) => (/^[0-9a-f]{64}$/i.test(String(hex || '').trim()) ? Buffer.from(String(hex).trim(), 'hex') : null);
const RAW_KEY = process.env.BACKUP_ENCRYPTION_KEY || '';
const ENC_KEY = keyFrom(RAW_KEY);
const encrypted = () => !!ENC_KEY;

function encrypt(plain, key = ENC_KEY) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, body, cipher.getAuthTag()]);
}

function decrypt(blob, key = ENC_KEY) {
  if (!key) throw new Error('No decryption key: set BACKUP_ENCRYPTION_KEY to the 64 hex characters saved for this app.');
  if (blob.length < MAGIC.length + 28 || !blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Not a Signify backup: the file does not start with the expected header.');
  }
  const iv = blob.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = blob.subarray(blob.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(blob.subarray(MAGIC.length + 12, blob.length - 16)), decipher.final()]);
  } catch {
    throw new Error('Could not decrypt: wrong key for this app, or the file has been altered.');
  }
}

const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// Percent-encodes everything but the unreserved set. Slashes survive in a
// path and are escaped in a query value, which is the one difference S3 cares
// about between the two.
const escape = (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
const uriEncodePath = (str) => String(str).replace(/[^A-Za-z0-9\-._~/]/g, escape);
const uriEncode = (str) => String(str).replace(/[^A-Za-z0-9\-._~]/g, escape);

/**
 * Signs a request the way S3 wants it and sends it.
 *
 * The order of everything here is load-bearing — headers sorted, the payload
 * hash present in both the header and the canonical request, the query string
 * sorted by key. A signature mismatch tells you nothing about which of those
 * was wrong, which is why this is one small function rather than spread out.
 */
function send({ method, key = '', query = {}, body = null, contentType }) {
  const url = new URL(`${ENDPOINT}/${BUCKET}${key ? `/${key}` : ''}`);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');   // 20260908T234500Z
  const dateStamp = amzDate.slice(0, 8);
  const payload = body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body);
  const payloadHash = sha256hex(payload);

  const canonicalQuery = Object.keys(query).sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`).join('&');

  const headers = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (contentType) headers['content-type'] = contentType;
  if (payload.length) headers['content-length'] = String(payload.length);

  const signedHeaders = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaders.map((h) => `${h}:${String(headers[h]).trim()}\n`).join('');
  const signedHeaderList = signedHeaders.join(';');

  const canonicalRequest = [
    method,
    uriEncodePath(url.pathname),
    canonicalQuery,
    canonicalHeaders,
    signedHeaderList,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${REGION}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');

  // The signing key is the secret walked through date, region and service, so
  // a leaked signature is only ever good for one day in one place.
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${SECRET}`, dateStamp), REGION), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  headers.authorization = `AWS4-HMAC-SHA256 Credential=${KEY_ID}/${scope}, SignedHeaders=${signedHeaderList}, Signature=${signature}`;

  return new Promise((resolve, reject) => {
    // http as well as https, so this can be pointed at a local MinIO — or at
    // the stub the tests run against — without a second code path.
    const transport = url.protocol === 'http:' ? http : https;
    const req = transport.request(
      `${url.origin}${url.pathname}${canonicalQuery ? `?${canonicalQuery}` : ''}`,
      { method, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve({ status: res.statusCode, body: data });
          else reject(new Error(`${method} ${key || BUCKET} → HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
        });
      },
    );
    req.on('error', reject);
    if (payload.length) req.write(payload);
    req.end();
  });
}

/** Encrypts one backup archive and puts it in the bucket, as <name>.enc. */
async function upload(filePath, name) {
  if (!ENC_KEY) {
    throw new Error(RAW_KEY
      ? 'BACKUP_ENCRYPTION_KEY is not 64 hex characters, so nothing was sent. Generate one with `openssl rand -hex 32`.'
      : 'BACKUP_ENCRYPTION_KEY is not set, so nothing was sent. Backups only leave this service encrypted.');
  }
  await send({
    method: 'PUT',
    key: `${PREFIX}${name}.enc`,
    body: encrypt(fs.readFileSync(filePath)),
    contentType: 'application/octet-stream',
  });
}

/**
 * Drops the oldest archives so only `keep` remain — and, given maxAgeDays,
 * any dated earlier than that many days ago as well.
 *
 * The age limit is for data that has been promised a deletion date. Counting
 * copies alone is not enough for that: these apps sleep when nobody is using
 * them, so seven copies can stretch across a whole summer holiday. The newest
 * archive is never removed on age alone, so a long quiet spell ends with one
 * good copy rather than none.
 *
 * Sorted by name rather than by the storage's own timestamps: the names are
 * `backup-YYYY-MM-DD.tar.gz`, which sort chronologically as plain strings and
 * do not care what any clock thinks.
 */
async function prune(keep, { maxAgeDays = null, now = Date.now() } = {}) {
  const res = await send({
    method: 'GET',
    query: { 'list-type': '2', prefix: PREFIX, 'max-keys': '1000' },
  });
  const names = [...res.body.matchAll(/<Key>([^<]+)<\/Key>/g)]
    .map((m) => m[1])
    .filter((k) => k.includes('backup-'))
    .sort();

  // Once archives are encrypted, any unencrypted one left from before goes
  // at the first opportunity — whatever the count or its age.
  const doomed = new Set(ENC_KEY ? names.filter((k) => !k.endsWith('.enc')) : []);
  const kept = ENC_KEY ? names.filter((k) => k.endsWith('.enc')) : names;
  for (const k of kept.slice(0, Math.max(0, kept.length - Math.max(1, keep)))) doomed.add(k);
  if (maxAgeDays) {
    const cutoff = new Date(now - maxAgeDays * 864e5).toISOString().slice(0, 10);
    for (const key of kept.slice(0, -1)) {
      const m = /backup-(\d{4}-\d{2}-\d{2})/.exec(key);
      if (m && m[1] < cutoff) doomed.add(key);
    }
  }
  // The listing gives full keys, prefix included, and send() puts whatever it
  // is given straight after the bucket — so they go back exactly as they came.
  for (const key of doomed) await send({ method: 'DELETE', key });
  return doomed.size;
}

/** A short description for the boot log, so it is obvious what is on. */
const describe = () => `${ENDPOINT.replace(/^https:\/\//, '')}/${BUCKET}/${PREFIX}` +
  (ENC_KEY ? ' (encrypted)' : ' — NOT SENDING: BACKUP_ENCRYPTION_KEY is missing or malformed');

const prefix = () => PREFIX;

module.exports = { enabled, encrypted, configure, prefix, upload, prune, describe, encrypt, decrypt, keyFrom, _send: send };

// ---------- opening a backup by hand ----------
if (require.main === module) {
  const [cmd, input, output] = process.argv.slice(2);
  if (cmd !== 'decrypt' || !input) {
    console.error('Usage: node offsite.js decrypt <backup.tar.gz.enc> [output]   (key in BACKUP_ENCRYPTION_KEY)');
    process.exit(2);
  }
  try {
    const out = output || input.replace(/\.enc$/, '');
    if (out === input) throw new Error('Name an output file.');
    fs.writeFileSync(out, decrypt(fs.readFileSync(input)));
    console.log(`Decrypted to ${out}`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
