// ===================================================================
// Off-site backup — signing and round trip.
//   node test/offsite.js
//
// No network and no bucket: a stub S3 stands in, so this checks the parts
// that are actually easy to get wrong — the signature, the paths, and the
// pruning arithmetic — rather than checking that Cloudflare is up.
// ===================================================================

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

let passed = 0;
const check = (name, fn) => { try { fn(); passed += 1; console.log('  pass ', name); } catch (e) { console.error('  FAIL ', name, '\n   ', e.message); process.exitCode = 1; } };

// ---- 1. The signature, against AWS's own published example ----
// If this drifts, every request is rejected with a message that says nothing
// about which part was wrong — so it is pinned to a known-good answer.
(function referenceVector() {
  const sha256hex = (d) => crypto.createHash('sha256').update(d).digest('hex');
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  const amzDate = '20130524T000000Z';
  const dateStamp = '20130524';
  const region = 'us-east-1';
  const payloadHash = sha256hex('');
  const headers = { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9', 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(headers).sort();
  const canonical = ['GET', '/test.txt', '', names.map((h) => `${h}:${headers[h]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), 's3'), 'aws4_request');
  const sig = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  check('SigV4 matches the AWS reference vector', () =>
    assert.strictEqual(sig, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'));
})();

// ---- 2. A round trip against a stub bucket ----
const objects = new Map();
const seen = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  seen.push({ method: req.method, path: url.pathname, auth: req.headers.authorization || '', headers: req.headers });
  let body = [];
  req.on('data', (c) => body.push(c));
  req.on('end', () => {
    if (req.method === 'PUT') { objects.set(url.pathname, Buffer.concat(body)); res.writeHead(200).end(); return; }
    if (req.method === 'DELETE') { objects.delete(url.pathname); res.writeHead(204).end(); return; }
    if (req.method === 'GET') {
      const keys = [...objects.keys()].map((k) => k.replace('/test-bucket/', ''));
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(`<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}</ListBucketResult>`);
      return;
    }
    res.writeHead(405).end();
  });
});

server.listen(0, async () => {
  const port = server.address().port;
  process.env.R2_ENDPOINT = `http://127.0.0.1:${port}`;
  process.env.R2_BUCKET = 'test-bucket';
  process.env.R2_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
  process.env.R2_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  process.env.R2_PREFIX = 'whiteboard/';
  const offsite = require('../offsite');

  check('it is switched on once the four variables are set', () => assert.ok(offsite.enabled()));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-offsite-'));
  const file = path.join(tmp, 'backup-2026-09-08.tar.gz');
  fs.writeFileSync(file, Buffer.from('pretend this is a tarball'));

  try {
    // Eight nights of backups.
    for (let d = 1; d <= 8; d += 1) {
      const name = `backup-2026-09-0${d}.tar.gz`;
      await offsite.upload(file, name);
    }

    check('every backup lands under the prefix', () =>
      assert.ok([...objects.keys()].every((k) => k.startsWith('/test-bucket/whiteboard/backup-')), [...objects.keys()].join()));
    check('all eight are there', () => assert.strictEqual(objects.size, 8));
    check('the bytes arrive intact', () =>
      assert.strictEqual(objects.get('/test-bucket/whiteboard/backup-2026-09-01.tar.gz').toString(), 'pretend this is a tarball'));

    const put = seen.find((r) => r.method === 'PUT');
    check('the request is signed', () => assert.match(put.auth, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/));
    check('the payload hash is sent, not UNSIGNED-PAYLOAD', () =>
      assert.strictEqual(put.headers['x-amz-content-sha256'], crypto.createHash('sha256').update('pretend this is a tarball').digest('hex')));
    check('the secret itself never goes over the wire', () =>
      assert.ok(!JSON.stringify(seen).includes('wJalrXUtnFEMI')));

    // Keep three; the five oldest should go, chosen by name.
    const dropped = await offsite.prune(3);
    check('pruning removes exactly the surplus', () => assert.strictEqual(dropped, 5));
    check('and the three NEWEST are what survive', () => assert.deepStrictEqual(
      [...objects.keys()].map((k) => k.split('/').pop()).sort(),
      ['backup-2026-09-06.tar.gz', 'backup-2026-09-07.tar.gz', 'backup-2026-09-08.tar.gz']));

    const second = await offsite.prune(3);
    check('nothing is deleted when there is nothing surplus', () => assert.strictEqual(second, 0));
  } catch (e) {
    console.error('  FAIL  round trip:', e.message);
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    server.close();
    console.log(`\n${process.exitCode ? '✗' : '✓'} ${passed} checks passed`);
  }
});
