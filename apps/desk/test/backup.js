// ===================================================================
// Backups — server/backup.js and server/offsite.js, end to end
//
// Real tar, real files, and a stand-in S3 bucket on localhost that honours
// ?prefix= the way R2 does. Shared, byte for byte, with Classroom Atlas.
//   node test/backup.js
// ===================================================================

'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SERVER = path.join(__dirname, '..', 'server');
const DAY = 864e5;
const T0 = Date.parse('2026-09-01T12:00:00Z');
const at = (n) => () => T0 + n * DAY;              // day n after T0
const iso = (n) => new Date(T0 + n * DAY).toISOString().slice(0, 10);
const quiet = { log() {}, warn() {}, error() {} };

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed += 1; console.log('  pass ', name); }
  catch (e) { failed += 1; console.log('  FAIL ', name, '\n       ', e.message); }
}

// A fresh copy of both modules, so each phase reads its own environment.
function load() {
  for (const m of ['backup', 'offsite']) delete require.cache[require.resolve(path.join(SERVER, m))];
  return require(path.join(SERVER, 'backup'));
}

function makeDataDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-test-'));
  fs.writeFileSync(path.join(d, 'store.json'), JSON.stringify({ notes: ['kept'] }));
  fs.mkdirSync(path.join(d, 'uploads'));
  fs.writeFileSync(path.join(d, 'uploads', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(d, 'store.json.123.tmp'), '{"half-written');
  fs.mkdirSync(path.join(d, 'lost+found'));
  return d;
}

const listing = (file) => execFileSync('tar', ['-tzf', file]).toString().split('\n').filter(Boolean);

(async () => {
  for (const k of ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT', 'R2_PREFIX', 'BACKUP_ENCRYPTION_KEY']) delete process.env[k];

  // ---------------- without R2 ----------------
  console.log('\nOn the volume only');
  {
    const dataDir = makeDataDir();
    let b = load()({ dataDir, prefix: 'desk/', keepLocal: 3, now: at(0), log: quiet });
    const r = await b.run();
    await check('an archive is written with no bucket configured', () =>
      assert.ok(r.ok && !r.offsite && fs.existsSync(path.join(b.dir, `backup-${iso(0)}.tar.gz`))));

    const files = listing(path.join(b.dir, `backup-${iso(0)}.tar.gz`));
    await check('it holds the store and the uploads', () =>
      assert.ok(files.includes('./store.json') && files.includes('./uploads/a.png'), files.join(', ')));
    await check('but not a half-written temp file', () =>
      assert.ok(!files.some((f) => f.endsWith('.tmp')), files.join(', ')));
    await check('nor the backups folder or lost+found', () =>
      assert.ok(!files.some((f) => f.startsWith('./backups') || f.startsWith('./lost+found')), files.join(', ')));

    for (const n of [1, 2, 3, 4]) {
      b = load()({ dataDir, prefix: 'desk/', keepLocal: 3, now: at(n), log: quiet });
      await b.run();
    }
    await check('only the newest three are kept on the volume', () =>
      assert.deepStrictEqual(b.localNames(), [2, 3, 4].map((n) => `backup-${iso(n)}.tar.gz`)));

    b = load()({ dataDir, prefix: 'desk/', keepLocal: 3, maxAgeDays: 7, now: at(30), log: quiet });
    await b.run();
    await check('an age limit clears anything older than it, locally too', () =>
      assert.deepStrictEqual(b.localNames(), [`backup-${iso(30)}.tar.gz`]));

    fs.writeFileSync(path.join(b.dir, `backup-${iso(31)}.tar.gz.tmp`), 'interrupted');
    b = load()({ dataDir, prefix: 'desk/', now: at(31), log: quiet });
    await b.run();
    await check('a leftover from an interrupted run is cleaned up', () =>
      assert.ok(!fs.readdirSync(b.dir).some((f) => f.endsWith('.tmp'))));
  }

  // ---------------- with a bucket ----------------
  const objects = new Map();            // key (no bucket) -> Buffer
  let failPuts = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const key = decodeURIComponent(url.pathname.replace(/^\/test-bucket\/?/, ''));
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (!/^AWS4-HMAC-SHA256 Credential=/.test(req.headers.authorization || '')) { res.writeHead(403).end(); return; }
      if (req.method === 'PUT') {
        if (failPuts) { res.writeHead(500).end('stub is down'); return; }
        objects.set(key, Buffer.concat(chunks)); res.writeHead(200).end(); return;
      }
      if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204).end(); return; }
      if (req.method === 'GET') {
        const prefix = url.searchParams.get('prefix') || '';
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix));
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(`<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}</ListBucketResult>`);
        return;
      }
      res.writeHead(405).end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  Object.assign(process.env, {
    R2_ENDPOINT: `http://127.0.0.1:${server.address().port}`,
    R2_BUCKET: 'test-bucket',
    R2_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    R2_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  });

  console.log('\nWith a bucket but no encryption key');
  {
    const dataDir = makeDataDir();
    const b = load()({ dataDir, prefix: 'desk/', keepLocal: 3, now: at(0), log: quiet });
    const r = await b.run();
    await check('nothing at all is sent without a key', () => assert.strictEqual(objects.size, 0));
    await check('the run says why, rather than failing quietly', () =>
      assert.ok(!r.ok && /BACKUP_ENCRYPTION_KEY/.test(r.error)));
    await check('and the archive is still kept on the volume', () => assert.strictEqual(b.localNames().length, 1));
    process.env.BACKUP_ENCRYPTION_KEY = 'not-hex-and-too-short';
    const r2 = await load()({ dataDir, prefix: 'desk/', now: at(1), log: quiet }).run();
    await check('a malformed key is refused just the same', () =>
      assert.ok(!r2.ok && /64 hex/.test(r2.error) && objects.size === 0));
  }

  process.env.BACKUP_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('hex');

  console.log('\nMirrored to a bucket');
  {
    const dataDir = makeDataDir();
    // Two weeks of this app's history, plus another app sharing the bucket.
    for (let n = 0; n < 14; n += 1) objects.set(`desk/backup-${iso(n)}.tar.gz.enc`, Buffer.from('old'));
    objects.set(`atlas/backup-${iso(0)}.tar.gz.enc`, Buffer.from('someone else'));

    const b = load()({ dataDir, prefix: 'desk/', keep: 7, maxAgeDays: 7, now: at(20), log: quiet });
    const r = await b.run();
    const sent = objects.get(`desk/backup-${iso(20)}.tar.gz.enc`);
    await check('the archive is uploaded, encrypted, under this app’s folder', () =>
      assert.ok(r.ok && r.offsite && sent));
    await check('what the bucket holds is not readable as an archive', () =>
      assert.ok(sent[0] !== 0x1f && !sent.includes(Buffer.from('store.json'))));
    const opened = path.join(dataDir, 'opened.tar.gz');
    fs.writeFileSync(opened, require(path.join(SERVER, 'offsite')).decrypt(sent));
    await check('and the key opens it back into the real archive', () =>
      assert.ok(listing(opened).includes('./store.json') && listing(opened).includes('./uploads/a.png')));
    fs.rmSync(opened);

    const desk = [...objects.keys()].filter((k) => k.startsWith('desk/')).sort();
    await check('anything older than seven days is removed from the bucket', () =>
      assert.deepStrictEqual(desk, [13, 20].map((n) => `desk/backup-${iso(n)}.tar.gz.enc`)));
    await check('another app’s folder is never touched', () =>
      assert.ok(objects.has(`atlas/backup-${iso(0)}.tar.gz.enc`)));
    await check('the volume keeps a single copy once the bucket has it', () =>
      assert.deepStrictEqual(b.localNames(), [`backup-${iso(20)}.tar.gz`]));

    // A holiday: nothing for months, then the app wakes up.
    objects.clear();
    objects.set(`desk/backup-${iso(0)}.tar.gz.enc`, Buffer.from('only copy'));
    const offsite = require(path.join(SERVER, 'offsite'));
    await offsite.prune(7, { maxAgeDays: 7, now: T0 + 200 * DAY });
    await check('the newest copy is never removed on age alone', () =>
      assert.ok(objects.has(`desk/backup-${iso(0)}.tar.gz.enc`)));

    const counted = load()({ dataDir, prefix: 'atlas/', keep: 3, now: at(40), log: quiet });
    for (let n = 30; n < 40; n += 1) objects.set(`atlas/backup-${iso(n)}.tar.gz.enc`, Buffer.from('x'));
    // An unencrypted copy from before encryption existed.
    objects.set(`atlas/backup-${iso(39)}.tar.gz`, Buffer.from('plain'));
    await counted.run();
    await check('without an age limit, the newest `keep` copies stay', () =>
      assert.deepStrictEqual([...objects.keys()].filter((k) => k.startsWith('atlas/')).sort(),
        [38, 39, 40].map((n) => `atlas/backup-${iso(n)}.tar.gz.enc`)));
    await check('and an old unencrypted copy is cleared away with the rest', () =>
      assert.ok(!objects.has(`atlas/backup-${iso(39)}.tar.gz`)));

    failPuts = true;
    for (const n of [41, 42]) await load()({ dataDir, prefix: 'desk/', keepLocal: 3, now: at(n), log: quiet }).run();
    const down = load()({ dataDir, prefix: 'desk/', keepLocal: 3, now: at(43), log: quiet });
    const bad = await down.run();
    await check('a failed upload is reported, not hidden', () =>
      assert.ok(!bad.ok && bad.offsite && /500/.test(bad.error)));
    await check('and the volume keeps its full set rather than one copy', () =>
      assert.strictEqual(down.localNames().length, 3));
  }

  server.close();
  console.log(`\n${failed ? '✗' : '✓'} ${passed}/${passed + failed} backup checks passed`);
  if (failed) process.exit(1);
})().catch((e) => { console.error('Backup test crashed:', e); process.exit(1); });
