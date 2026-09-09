// A pg-compatible facade over PGlite, so the test suite can run the real
// schema and the real queries without a Postgres server.
const { PGlite } = require('@electric-sql/pglite');

class PglitePool {
  constructor(pglite) { this.db = pglite; }

  static async create() {
    const pglite = await PGlite.create();
    return new PglitePool(pglite);
  }

  async query(text, params) {
    // Migrations and transaction control arrive as multi-statement strings
    // with no parameters; PGlite needs exec() for those.
    if (params === undefined) {
      const results = await this.db.exec(text);
      const last = results[results.length - 1] || {};
      return { rows: last.rows || [], rowCount: last.affectedRows != null ? last.affectedRows : (last.rows || []).length };
    }
    const res = await this.db.query(text, params);
    return { rows: res.rows || [], rowCount: res.affectedRows != null ? res.affectedRows : (res.rows || []).length };
  }

  async connect() {
    const self = this;
    return {
      query: (t, p) => self.query(t, p),
      release() {},
    };
  }

  on() {}
  async end() { await this.db.close(); }
}

module.exports = { PglitePool };
