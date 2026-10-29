// ===================================================================
// Signify Learning — whole-database backups, off-site
//
// Once a day, every table, encrypted and sent to this app's backup bucket
// (offsite.js, shared byte for byte with the other Signify apps), so losing
// the database does not lose a year of lessons, work and grades. Same shape
// as Signify ID's src/dbbackup.js.
//
// Left out on purpose:
//   * lti_keys — our private signing keys. A stolen backup must not let
//     anyone speak to Schoology as Signify Learning. After a restore each
//     school's key is made again on first use (lti.ts toolKey) and Schoology
//     picks up the new public key from our JWKS by its new kid.
//   * lti_states, lti_nonces, lti_launches, lti_tool_logins, lti_tool_nonces,
//     lti_tool_picks — minutes-long sign-in leftovers; lti_tool_tokens — tools'
//     access tokens (hashed, an hour long; tools just ask again).
//   * schema_migrations — a restore rebuilds it by running the migrations.
//
// People are never stored here (Signify ID is the authority), so there are
// no erasure tombstones to re-apply: a person erased in ID can't be signed
// in to, and nothing here names them except by id.
//
// Every value is read as Postgres's own text form and written back through a
// cast to the column's real type, so timestamps, numerics and jsonb come back
// exactly as they were.
// ===================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const offsite = require('./offsite').configure({ prefix: 'learning/' });

const FORMAT = 'signify-learning-db/1';
const EXCLUDED = ['schema_migrations', 'lti_keys', 'lti_states', 'lti_nonces', 'lti_launches',
  'lti_tool_logins', 'lti_tool_nonces', 'lti_tool_picks', 'lti_tool_tokens'];
// Deleted records must leave backups within 30 days (privacy policy); the
// bucket's lifecycle rule says the same even if this service is down.
const KEEP_DAYS = 28;
const MIGRATIONS = path.join(__dirname, 'migrations');

const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;
const day = (t) => new Date(t).toISOString().slice(0, 10);

/**
 * The database as this module wants it: query(text, params) → rows,
 * exec(script), and tx(fn) running fn({query}) on one connection inside
 * BEGIN/COMMIT. A pg Pool
 * goes through pgDb(); src/lib/db.ts's Db (PGlite in tests) already fits.
 */
function pgDb(pool) {
  return {
    query: async (t, p) => (await pool.query(t, p)).rows,
    // A script of several statements, no parameters (migrations).
    exec: async (sql) => { await pool.query(sql); },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn({ query: async (t, p) => (await client.query(t, p)).rows });
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

/** Every ordinary table, with its columns and exact types. */
async function describeSchema(q) {
  const rows = await q.query(
    `SELECT c.relname AS table_name, a.attname AS column_name,
            format_type(a.atttypid, a.atttypmod) AS type,
            pg_get_expr(d.adbin, d.adrelid) AS default_expr
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
      ORDER BY c.relname, a.attnum`, []);
  const tables = new Map();
  for (const r of rows) {
    if (!tables.has(r.table_name)) tables.set(r.table_name, []);
    tables.get(r.table_name).push({ name: r.column_name, type: r.type, default: r.default_expr });
  }
  return tables;
}

/** Tables in an order that satisfies every foreign key among them. */
async function loadOrder(q, names) {
  const rows = await q.query(
    `SELECT tc.table_name AS child, ccu.table_name AS parent
       FROM information_schema.table_constraints tc
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`, []);
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

/** The whole database, minus the excluded tables, as one consistent snapshot. */
async function dump(db) {
  return db.tx(async (t) => {
    // One snapshot for every table, so a grade and its assignment are always from the same moment.
    await t.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY', []);
    const schema = await describeSchema(t);
    const tables = {};
    for (const [name, columns] of schema) {
      if (EXCLUDED.includes(name)) continue;
      const list = columns.map((c, i) => `${ident(c.name)}::text AS c${i}`).join(', ');
      const rows = await t.query(`SELECT ${list} FROM ${ident(name)}`, []);
      tables[name] = {
        columns: columns.map((c) => ({ name: c.name, type: c.type })),
        rows: rows.map((r) => columns.map((_, i) => r[`c${i}`])),
      };
    }
    const migrations = (await t.query('SELECT name FROM schema_migrations ORDER BY name', [])).map((r) => r.name);
    return { format: FORMAT, dumpedAt: new Date().toISOString(), migrations, excluded: EXCLUDED, tables };
  });
}

/** Rows per table, for the log line and for checking a restore. */
const counts = (snapshot) => Object.fromEntries(Object.entries(snapshot.tables).map(([n, t]) => [n, t.rows.length]));

const pack = (snapshot) => zlib.gzipSync(Buffer.from(JSON.stringify(snapshot)));

/** A backup file's bytes, encrypted or not, back to the snapshot. */
function unpack(bytes, key) {
  let raw = bytes;
  if (raw.subarray(0, 16).toString() === 'SIGNIFY-BACKUP-1') raw = key ? offsite.decrypt(raw, key) : offsite.decrypt(raw);
  const snapshot = JSON.parse(zlib.gunzipSync(raw).toString('utf8'));
  if (snapshot.format !== FORMAT) throw new Error(`Not a Signify Learning database backup (format "${snapshot.format}").`);
  return snapshot;
}

let lastBackupDay = null;

/** Takes today's backup if there isn't one yet. Called hourly; a failure is tried again next hour. */
async function maybeBackup(db, { now = Date.now(), log = console } = {}) {
  if (!offsite.enabled()) return { ok: false, skipped: 'R2 is not configured' };
  const today = day(now);
  if (lastBackupDay === today) return { ok: true, skipped: 'already done today' };

  const name = `backup-${today}.json.gz`;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sl-backup-')), name);
  try {
    const snapshot = await dump(db);
    fs.writeFileSync(file, pack(snapshot));
    await offsite.upload(file, name);
    const pruned = await offsite.prune(KEEP_DAYS, { maxAgeDays: KEEP_DAYS, now });
    lastBackupDay = today;
    const n = counts(snapshot);
    const rows = Object.values(n).reduce((a, b) => a + b, 0);
    // Per-table counts in the log, so a restore can be checked against what was sent.
    log.log(`Database backup mirrored off-site: ${name} (${rows} rows${pruned ? `, ${pruned} older removed` : ''}) ${JSON.stringify(n)}`);
    return { ok: true, name, rows, pruned };
  } catch (e) {
    log.error('Database backup failed (will retry next hour):', e.message);
    return { ok: false, error: e.message };
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

/** Runs maybeBackup now and every hour. For server.js; does nothing without R2. */
function start(db, log = console) {
  if (!offsite.enabled()) { log.log('Off-site database backup: off (R2 is not configured)'); return null; }
  log.log(`Off-site database backup: ${offsite.describe()}`);
  const run = () => maybeBackup(db, { log }).catch((e) => log.error('Database backup failed:', e.message));
  setTimeout(run, 60_000).unref();
  return setInterval(run, 3600_000).unref();
}

// ---------------- restoring ----------------

/** Applies every migration not yet applied, as src/lib/db.ts does. */
async function migrate(db) {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())', []);
  const done = new Set((await db.query('SELECT name FROM schema_migrations', [])).map((r) => r.name));
  for (const f of fs.readdirSync(MIGRATIONS).filter((x) => /^\d+_.*\.sql$/.test(x)).sort()) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
    // The file name is digits, letters and underscores (checked above), so it is safe inline.
    await db.exec(`BEGIN;\n${sql}\n;INSERT INTO schema_migrations (name) VALUES ('${f}');\nCOMMIT;`);
  }
}

/**
 * Loads a snapshot into an EMPTY database (migrated first). Refuses one that
 * already has courses: this stands the service back up after a loss; it
 * never rolls a live one backwards.
 */
async function restore(db, snapshot, { log = console } = {}) {
  const known = new Set(fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')));
  const unknown = snapshot.migrations.filter((m) => !known.has(m));
  if (unknown.length) throw new Error(`This backup was taken by newer code (it has ${unknown.join(', ')}). Use that version to restore.`);

  await migrate(db);
  const [{ n: existing }] = await db.query('SELECT count(*)::int AS n FROM courses', []);
  if (existing > 0) throw new Error(`This database already holds ${existing} course(s). Restore only into a new, empty database.`);

  const loaded = {};
  await db.tx(async (t) => {
    const schema = await describeSchema(t);
    const names = Object.keys(snapshot.tables).filter((n) => schema.has(n));
    const missing = Object.keys(snapshot.tables).filter((n) => !schema.has(n));
    if (missing.length) log.warn(`Tables in the backup that no longer exist, skipped: ${missing.join(', ')}`);

    const every = [...schema.keys()].filter((n) => n !== 'schema_migrations');
    if (every.length) await t.query(`TRUNCATE ${every.map(ident).join(', ')} RESTART IDENTITY CASCADE`, []);

    for (const name of await loadOrder(t, names)) {
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
        await t.query(`INSERT INTO ${ident(name)} (${cols.map((c) => ident(c.name)).join(', ')}) VALUES ${tuples.join(', ')}`, params);
      }
      const [{ n }] = await t.query(`SELECT count(*)::int AS n FROM ${ident(name)}`, []);
      if (n !== rows.length) throw new Error(`${name}: loaded ${n} of ${rows.length} rows.`);
      loaded[name] = n;

      // Sequences carry on from the highest id restored, not from 1.
      for (const c of schema.get(name)) {
        if (!/nextval\(/.test(c.default || '')) continue;
        await t.query(
          `SELECT setval(pg_get_serial_sequence($1, $2), GREATEST(COALESCE(MAX(${ident(c.name)}), 0), 1), MAX(${ident(c.name)}) IS NOT NULL)
             FROM ${ident(name)}`, [name, c.name]);
      }
    }
  });
  return { ok: true, counts: loaded, dumpedAt: snapshot.dumpedAt };
}

module.exports = {
  FORMAT, EXCLUDED, KEEP_DAYS,
  pgDb, dump, counts, pack, unpack, maybeBackup, start, migrate, restore,
  _resetForTests: () => { lastBackupDay = null; },
};
