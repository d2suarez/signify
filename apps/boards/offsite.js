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
const PREFIX = process.env.R2_PREFIX || 'whiteboard/';

const enabled = () => !!(ENDPOINT && BUCKET && KEY_ID && SECRET);

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

/** Puts one backup archive in the bucket. */
async function upload(filePath, name) {
  await send({
    method: 'PUT',
    key: `${PREFIX}${name}`,
    body: fs.readFileSync(filePath),
    contentType: 'application/gzip',
  });
}

/**
 * Drops the oldest archives so only `keep` remain.
 *
 * Sorted by name rather than by the storage's own timestamps: the names are
 * `backup-YYYY-MM-DD.tar.gz`, which sort chronologically as plain strings and
 * do not care what any clock thinks.
 */
async function prune(keep) {
  const res = await send({
    method: 'GET',
    query: { 'list-type': '2', prefix: PREFIX, 'max-keys': '1000' },
  });
  const names = [...res.body.matchAll(/<Key>([^<]+)<\/Key>/g)]
    .map((m) => m[1])
    .filter((k) => k.includes('backup-'))
    .sort();

  const doomed = names.slice(0, Math.max(0, names.length - keep));
  // The listing gives full keys, prefix included, and send() puts whatever it
  // is given straight after the bucket — so they go back exactly as they came.
  for (const key of doomed) await send({ method: 'DELETE', key });
  return doomed.length;
}

/** A short description for the boot log, so it is obvious what is on. */
const describe = () => `${ENDPOINT.replace(/^https:\/\//, '')}/${BUCKET}/${PREFIX}`;

module.exports = { enabled, upload, prune, describe, _send: send };
