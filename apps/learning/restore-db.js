#!/usr/bin/env node
// ===================================================================
// Signify Learning — restore a whole-database backup (see dbbackup.js)
//
//   read -rs BACKUP_ENCRYPTION_KEY && export BACKUP_ENCRYPTION_KEY
//   node restore-db.js backup-2026-10-30.json.gz.enc            # into DATABASE_URL
//   node restore-db.js backup-2026-10-30.json.gz.enc --pglite data/restore-test
//   node restore-db.js --latest --pglite data/restore-test      # newest in the bucket (needs R2_*)
//
// The target must be a new, empty database; it is migrated first. Prints the
// rows per table in the backup and in the restored database, side by side.
// ===================================================================

'use strict';

const fs = require('fs');
const dbbackup = require('./dbbackup');
const offsite = require('./offsite').configure({ prefix: 'learning/' });

async function latestFromBucket() {
  if (!offsite.enabled()) throw new Error('--latest needs R2_ENDPOINT (or R2_ACCOUNT_ID), R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.');
  const res = await offsite._send({ method: 'GET', query: { 'list-type': '2', prefix: offsite.prefix(), 'max-keys': '1000' } });
  const keys = [...res.body.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]).filter((k) => /backup-.*\.enc$/.test(k)).sort();
  if (!keys.length) throw new Error(`No backups in the bucket under ${offsite.prefix()}.`);
  const key = keys.at(-1);
  return { name: key, bytes: await getBinary(key) };
}

/**
 * GET one object as bytes. offsite.js reads every answer as text (all it
 * ever needs) and stays byte-identical across the apps, so this is its
 * signing, for a GET with no body, kept here.
 */
function getBinary(key) {
  const crypto = require('crypto');
  const https = require('https');
  const http = require('http');
  const env = process.env;
  const endpoint = (env.R2_ENDPOINT || `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`).replace(/\/+$/, '');
  const region = env.R2_REGION || 'auto';
  const url = new URL(`${endpoint}/${env.R2_BUCKET}/${key}`);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const sha = (d) => crypto.createHash('sha256').update(d).digest('hex');
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const payloadHash = sha('');
  const headers = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const signed = Object.keys(headers).sort();
  const path = url.pathname.replace(/[^A-Za-z0-9\-._~/]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
  const canonical = ['GET', path, '', signed.map((h) => `${h}:${headers[h]}\n`).join(''), signed.join(';'), payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha(canonical)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${env.R2_SECRET_ACCESS_KEY}`, dateStamp), region), 's3'), 'aws4_request');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${env.R2_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${crypto.createHmac('sha256', signingKey).update(toSign).digest('hex')}`;
  return new Promise((resolve, reject) => {
    (url.protocol === 'http:' ? http : https).get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => (res.statusCode === 200 ? resolve(Buffer.concat(chunks)) : reject(new Error(`GET ${key} → HTTP ${res.statusCode}`))));
    }).on('error', reject);
  });
}

async function pgliteDb(dir) {
  const { PGlite } = await import('@electric-sql/pglite');
  fs.mkdirSync(dir, { recursive: true });
  const pg = new PGlite(dir);
  const wrap = (q) => ({ query: async (t, p) => (await q.query(t, p)).rows });
  return {
    ...wrap(pg),
    exec: async (sql) => { await pg.exec(sql); },
    tx: (fn) => pg.transaction((t) => fn(wrap(t))),
    close: () => pg.close(),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--pglite');
  const pgliteDir = at >= 0 ? args[at + 1] : null;
  const file = args.find((a, i) => !a.startsWith('--') && i !== at + 1);

  let name, bytes;
  if (args.includes('--latest')) ({ name, bytes } = await latestFromBucket());
  else if (file) { name = file; bytes = fs.readFileSync(file); }
  else throw new Error('Name a backup file, or --latest.');

  const snapshot = dbbackup.unpack(bytes);
  let db, pool;
  if (pgliteDir) db = await pgliteDb(pgliteDir);
  else {
    if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to the new, empty database, or use --pglite <dir>.');
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    db = dbbackup.pgDb(pool);
  }
  try {
    const result = await dbbackup.restore(db, snapshot);
    const want = dbbackup.counts(snapshot);
    console.log(`Restored ${name} (taken ${snapshot.dumpedAt}).`);
    let bad = 0;
    for (const t of Object.keys(want).sort()) {
      const ok = result.counts[t] === want[t];
      if (!ok) bad++;
      console.log(`${ok ? 'ok ' : 'BAD'} ${t.padEnd(24)} backup ${String(want[t]).padStart(6)}  restored ${String(result.counts[t] ?? '-').padStart(6)}`);
    }
    console.log(bad ? `${bad} table(s) differ.` : 'Every table matches the backup.');
    process.exitCode = bad ? 1 : 0;
  } finally {
    if (db.close) await db.close();
    if (pool) await pool.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
