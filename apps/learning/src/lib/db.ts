import fs from "node:fs";
import path from "node:path";

/**
 * The database: plain Postgres in production (DATABASE_URL), and PGlite —
 * Postgres compiled to WebAssembly, in-process — everywhere else, so the app
 * runs and its tests pass on a machine with no database installed. Both speak
 * the same SQL; nothing here uses a provider-specific feature.
 *
 * One instance per process, kept on globalThis: Next bundles server code into
 * several chunks, and each would otherwise open its own copy (PGlite refuses
 * to open one data folder twice).
 */

export type Row = Record<string, unknown>;

export interface Queryable {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  /** Runs a script of several statements, no parameters (migrations). */
  exec(sql: string): Promise<void>;
  /**
   * Runs `fn` in one transaction on one connection. With a pool, BEGIN and
   * COMMIT sent as separate pool queries can land on different connections,
   * which is no transaction at all — so this is the only way to get one.
   */
  tx<T>(fn: (q: Queryable & { exec(sql: string): Promise<void> }) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

type Holder = { db?: Promise<Db> };
const holder = ((globalThis as unknown as { __learningDb?: Holder }).__learningDb ??= {});

const MIGRATIONS_DIR = path.join(process.cwd(), "migrations");

export function getDb(): Promise<Db> {
  return (holder.db ??= open());
}

async function open(): Promise<Db> {
  const db = process.env.DATABASE_URL
    ? await openPostgres(process.env.DATABASE_URL)
    : await openPglite(process.env.PGLITE_DIR || path.join(process.cwd(), "data", "pglite"));
  await migrate(db);
  return db;
}

async function openPostgres(url: string): Promise<Db> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: url, max: 10 });
  return {
    async query(sql, params = []) {
      return (await pool.query(sql, params as unknown[])).rows;
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn({
          query: async (sql, params = []) => (await client.query(sql, params as unknown[])).rows,
          exec: async (sql) => { await client.query(sql); },
        });
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** `dir` of "memory://" gives a throwaway in-memory database (tests). */
export async function openPglite(dir: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  if (!dir.startsWith("memory://")) fs.mkdirSync(dir, { recursive: true });
  const pg = new PGlite(dir);
  return {
    async query(sql, params = []) {
      return (await pg.query(sql, params as unknown[])).rows as never;
    },
    async exec(sql) {
      await pg.exec(sql);
    },
    tx(fn) {
      return pg.transaction((t) => fn({
        query: async (sql, params = []) => (await t.query(sql, params as unknown[])).rows as never,
        exec: async (sql) => { await t.exec(sql); },
      }));
    },
    close: () => pg.close(),
  };
}

/** Applies every migrations/NNN_*.sql not yet applied, in order, once each. */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.query<{ name: string }>("SELECT name FROM schema_migrations")).map((r) => r.name));
  const files = fs.readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    try {
      await db.tx(async (t) => {
        await t.exec(sql);
        await t.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
      });
    } catch (e) {
      throw new Error(`migration ${f} failed: ${(e as Error).message}`);
    }
    applied.push(f);
  }
  return applied;
}

/** For tests: use this database instead of opening one. */
export function useDb(db: Db) {
  holder.db = Promise.resolve(db);
}
