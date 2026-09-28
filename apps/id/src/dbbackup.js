// ===================================================================
// Signify ID — whole-database backups, off-site
//
// Not the same thing as src/backup.js. That is one school's roster, signed,
// for a school to download and merge back. This is the disaster copy: every
// table, once a day, encrypted and sent to the backup bucket (see offsite.js),
// so that losing the database does not lose every school.
//
// Three things it deliberately does NOT carry:
//
//   * Live credentials — sessions, sign-in codes, refresh tokens — and above
//     all the SIGNING KEYS that vouch for every sign-in in every app. A stolen
//     backup must not be a way to sign in as anybody. After a restore a new
//     signing key is made and everybody simply signs in again.
//   * The migration ledger, which a restore rebuilds by running migrations.
//   * Anything that has since been erased. The privacy policy promises an
//     erased person is never brought back "even if an older backup is later
//     loaded", so each erasure leaves a tombstone in the bucket (the account's
//     id and nothing else) and a restore applies them all before it finishes.
//
// Every value is read as Postgres's own text form and written back through a
// cast to the column's real type, so timestamps keep their microseconds and
// inet, arrays and jsonb come back exactly as they were.
// ===================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const db = require('./db');
const offsite = require('./offsite').configure({ prefix: 'id/' });
const { config } = require('./config');

const FORMAT = 'signify-id-db/1';
const EXCLUDED = ['sessions', 'auth_codes', 'refresh_tokens', 'signing_keys', 'schema_migrations'];
// Deleted records must leave backups within 30 days (privacy policy). The
// bucket's own lifecycle rule enforces the same 28 days even if this service
// is down; this is the rule applied from here.
const KEEP_DAYS = 28;
const TOMBSTONE_DAYS = 30;
const tombstoneFolder = () => `${offsite.prefix()}erasures/`;

const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;
const day = (t) => new Date(t).toISOString().slice(0, 10);

/** Every ordinary table in the schema, with its columns and exact types. */
async function describeSchema(q) {
  const { rows } = await q(
    `SELECT c.relname AS table_name, a.attname AS column_name,
            format_type(a.atttypid, a.atttypmod) AS type,
            pg_get_expr(d.adbin, d.adrelid) AS default_expr
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
      ORDER BY c.relname, a.attnum`);
  const tables = new Map();
  for (const r of rows) {
    if (!tables.has(r.table_name)) tables.set(r.table_name, []);
    tables.get(r.table_name).push({ name: r.column_name, type: r.type, default: r.default_expr });
  }
  return tables;
}

/** Tables in an order that satisfies every foreign key among them. */
async function loadOrder(q, names) {
  const { rows } = await q(
    `SELECT tc.table_name AS child, ccu.table_name AS parent
       FROM information_schema.table_constraints tc
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`);
  const wanted = new Set(names);
  const needs = new Map(names.map((n) => [n, new Set()]));
  for (const { child, parent } of rows) {
    if (child !== parent && wanted.has(child) && wanted.has(parent)) needs.get(child).add(parent);
  }
  const order = [];
  const placed = new Set();
  while (order.length < names.length) {
    const ready = names.filter((n) => !placed.has(n) && [...needs.get(n)].every((p) => placed.has(p))).sort();
    if (!ready.length) throw new Error('The tables reference each other in a cycle; cannot choose a load order.');
    for (const n of ready) { order.push(n); placed.add(n); }
  }
  return order;
}

// ---------------- taking a backup ----------------

/** The whole database, minus credentials, as one consistent snapshot. */
async function dump() {
  return db.tx(async (client) => {
    // One snapshot for every table, so a row and whatever it points at are
    // always from the same moment.
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const q = (t, p) => client.query(t, p);
    const schema = await describeSchema(q);
    const tables = {};
    for (const [name, columns] of schema) {
      if (EXCLUDED.includes(name)) continue;
      // Positional aliases rather than pg's rowMode, so this reads the same
      // through the test suite's in-process Postgres as through the real one.
      const list = columns.map((c, i) => `${ident(c.name)}::text AS c${i}`).join(', ');
      const { rows } = await client.query(`SELECT ${list} FROM ${ident(name)}`, []);
      tables[name] = {
        columns: columns.map((c) => ({ name: c.name, type: c.type })),
        rows: rows.map((r) => columns.map((_, i) => r[`c${i}`])),
      };
    }
    const migrations = (await client.query('SELECT filename FROM schema_migrations ORDER BY filename')).rows.map((r) => r.filename);
    return { format: FORMAT, dumpedAt: new Date().toISOString(), issuer: config.issuer, migrations, excluded: EXCLUDED, tables };
  });
}

const pack = (snapshot) => zlib.gzipSync(Buffer.from(JSON.stringify(snapshot)));

let lastBackupDay = null;

/**
 * Takes today's backup if there is not one yet. Called from the hourly
 * maintenance sweep; a failure is simply tried again next hour.
 */
async function maybeBackup({ now = Date.now(), log = console } = {}) {
  if (!offsite.enabled()) return { ok: false, skipped: 'R2 is not configured' };
  const today = day(now);
  if (lastBackupDay === today) return { ok: true, skipped: 'already done today' };

  const name = `backup-${today}.json.gz`;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sid-backup-')), name);
  try {
    const snapshot = await dump();
    fs.writeFileSync(file, pack(snapshot));
    await offsite.upload(file, name);
    const pruned = await offsite.prune(KEEP_DAYS, { maxAgeDays: KEEP_DAYS, now });
    lastBackupDay = today;
    const rows = Object.values(snapshot.tables).reduce((n, t) => n + t.rows.length, 0);
    log.log(`Database backup mirrored off-site: ${name} (${rows} rows${pruned ? `, ${pruned} older removed` : ''})`);
    return { ok: true, name, rows, pruned };
  } catch (e) {
    log.error('Database backup failed (will retry next hour):', e.message);
    return { ok: false, error: e.message };
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

// ---------------- tombstones ----------------

/** Called inside the transaction that erases somebody, so neither happens without the other. */
async function recordErasure(client, userId) {
  await client.query(
    'INSERT INTO erasure_tombstones (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
}

/** Copies waiting tombstones to the bucket, and forgets ones no backup can outlive. */
async function sendTombstones() {
  // Older than any backup still kept, so nothing is left for them to protect
  // against. Sent or not: if nothing was sent, there were no backups either.
  await db.query(`DELETE FROM erasure_tombstones WHERE erased_at < now() - ($1 || ' days')::interval`,
    [String(TOMBSTONE_DAYS)]);
  if (!offsite.enabled()) return 0;

  const waiting = await db.many(
    'SELECT user_id FROM erasure_tombstones WHERE sent_at IS NULL ORDER BY erased_at LIMIT 500');
  let sent = 0;
  for (const { user_id: id } of waiting) {
    await offsite._send({ method: 'PUT', key: `${tombstoneFolder()}${id}`, body: Buffer.alloc(0), contentType: 'text/plain' });
    await db.query('UPDATE erasure_tombstones SET sent_at = now() WHERE user_id = $1', [id]);
    sent += 1;
  }
  return sent;
}

/** Every tombstone in the bucket, as account ids. */
async function listTombstones() {
  const ids = [];
  let token = null;
  do {
    const query = { 'list-type': '2', prefix: tombstoneFolder(), 'max-keys': '1000' };
    if (token) query['continuation-token'] = token;
    const res = await offsite._send({ method: 'GET', query });
    for (const m of res.body.matchAll(/<Key>([^<]+)<\/Key>/g)) {
      const id = m[1].slice(tombstoneFolder().length);
      if (/^[0-9a-f-]{36}$/i.test(id)) ids.push(id);
    }
    const next = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(res.body);
    token = /<IsTruncated>true<\/IsTruncated>/.test(res.body) && next ? next[1] : null;
  } while (token);
  return ids;
}

// ---------------- restoring ----------------

/** A backup file's bytes — encrypted or not — back to the snapshot object. */
function unpack(bytes) {
  let raw = bytes;
  if (raw.subarray(0, 16).toString() === 'SIGNIFY-BACKUP-1') raw = offsite.decrypt(raw);
  const snapshot = JSON.parse(zlib.gunzipSync(raw).toString('utf8'));
  if (snapshot.format !== FORMAT) throw new Error(`Not a Signify ID database backup (format "${snapshot.format}").`);
  return snapshot;
}

/**
 * Loads a snapshot into an EMPTY database, then re-applies erasures.
 *
 * Refuses a database that already has people in it: this is for standing the
 * service back up after a loss, not for rolling a live one backwards. For that
 * there is the per-school backup in src/backup.js.
 *
 * `tombstones` is the list of erased account ids to apply; pass null only when
 * it is certain there were none since the backup was taken.
 */
async function restore(snapshot, { tombstones, log = console } = {}) {
  if (!Array.isArray(tombstones) && tombstones !== null) {
    throw new Error('Say which erasures to re-apply (the tombstones from the bucket), or pass null to skip them knowingly.');
  }

  const applied = new Set(fs.readdirSync(path.join(__dirname, '..', 'migrations')).filter((f) => f.endsWith('.sql')));
  const unknown = snapshot.migrations.filter((m) => !applied.has(m));
  if (unknown.length) {
    throw new Error(`This backup was taken by newer code (it has ${unknown.join(', ')}). Deploy that version first, then restore.`);
  }

  await db.migrate();
  const existing = await db.one('SELECT COUNT(*)::int AS n FROM users');
  if (existing.n > 0) {
    throw new Error(`This database already holds ${existing.n} account(s). Restore only into a new, empty database.`);
  }

  const counts = {};
  await db.tx(async (client) => {
    const q = (t, p) => client.query(t, p);
    const schema = await describeSchema(q);
    const names = Object.keys(snapshot.tables).filter((n) => schema.has(n));
    const missing = Object.keys(snapshot.tables).filter((n) => !schema.has(n));
    if (missing.length) log.warn(`Tables in the backup that no longer exist, skipped: ${missing.join(', ')}`);

    // Migrations may seed rows (built-in roles, for instance); the backup has
    // its own copies of those, so the tables start empty.
    const every = [...schema.keys()].filter((n) => n !== 'schema_migrations');
    await client.query(`TRUNCATE ${every.map(ident).join(', ')} RESTART IDENTITY CASCADE`);

    for (const name of await loadOrder(q, names)) {
      const current = new Map(schema.get(name).map((c) => [c.name, c]));
      const cols = snapshot.tables[name].columns.map((c, i) => ({ ...c, i })).filter((c) => current.has(c.name));
      const rows = snapshot.tables[name].rows;
      for (let start = 0; start < rows.length; start += 200) {
        const batch = rows.slice(start, start + 200);
        const params = [];
        const tuples = batch.map((row) => `(${cols.map((c) => {
          params.push(row[c.i]);
          return `$${params.length}::${current.get(c.name).type}`;
        }).join(', ')})`);
        await client.query(
          `INSERT INTO ${ident(name)} (${cols.map((c) => ident(c.name)).join(', ')}) VALUES ${tuples.join(', ')}`, params);
      }
      const { rows: [{ n }] } = await client.query(`SELECT COUNT(*)::int AS n FROM ${ident(name)}`);
      if (n !== rows.length) throw new Error(`${name}: loaded ${n} of ${rows.length} rows.`);
      counts[name] = n;

      // Sequences carry on from the highest id restored, not from 1.
      for (const c of schema.get(name)) {
        if (!/nextval\(/.test(c.default || '')) continue;
        await client.query(
          `SELECT setval(pg_get_serial_sequence($1, $2), GREATEST(COALESCE(MAX(${ident(c.name)}), 0), 1), MAX(${ident(c.name)}) IS NOT NULL)
             FROM ${ident(name)}`, [name, c.name]);
      }
    }

    // The promise: an erasure outlives any backup that is loaded.
    if (tombstones && tombstones.length) {
      const gone = await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [tombstones]);
      await client.query(
        `INSERT INTO erasure_tombstones (user_id, sent_at)
         SELECT unnest($1::uuid[]), now() ON CONFLICT (user_id) DO NOTHING`, [tombstones]);
      counts.erasures_reapplied = gone.rowCount || 0;
    }
  });

  return { ok: true, counts, dumpedAt: snapshot.dumpedAt };
}

module.exports = {
  FORMAT, EXCLUDED, KEEP_DAYS,
  dump, pack, unpack, maybeBackup, restore,
  recordErasure, sendTombstones, listTombstones,
  _resetForTests: () => { lastBackupDay = null; },
};
