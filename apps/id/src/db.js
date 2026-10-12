// ===================================================================
// Signify ID — Postgres access
// A thin wrapper over pg: a pool, a query helper, a transaction helper and a
// forward-only migration runner. No ORM — the schema is small and the queries
// benefit from being readable as SQL.
// ===================================================================

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { config } = require('./config');

let pool = new Pool({
  connectionString: config.databaseUrl,
  // Railway's managed Postgres presents a certificate the default CA bundle
  // does not chain to. The connection is still TLS-encrypted.
  ssl: /\bsslmode=disable\b/.test(config.databaseUrl) || /localhost|127\.0\.0\.1/.test(config.databaseUrl)
    ? false
    : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  // An idle client erroring out must not take the process down with it.
  console.error('Postgres idle client error:', err.message);
});

// Tests swap in an in-process Postgres so the whole stack can be exercised
// without a server. Nothing else should ever call this.
function setPool(replacement) {
  pool = replacement;
  module.exports.pool = pool;
}

async function query(text, params) {
  return pool.query(text, params);
}

// Convenience: first row or null.
async function one(text, params) {
  const { rows } = await pool.query(text, params);
  return rows[0] || null;
}

async function many(text, params) {
  const { rows } = await pool.query(text, params);
  return rows;
}

// Runs fn inside a transaction, rolling back on any throw. Used wherever a
// half-applied change would leave a person in an ambiguous state — creating a
// user plus their identity plus their membership, for instance.
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

// ---------- migrations ----------

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set(
    (await pool.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename)
  );

  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const ran = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    // Each migration is one transaction: it applies completely or not at all.
    await tx(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    });
    ran.push(file);
    console.log(`Migration applied: ${file}`);
  }

  if (!ran.length) console.log('Migrations: already up to date.');
  return ran;
}

module.exports = { pool, query, one, many, tx, migrate, setPool };
