// Stand-alone migration entry point: npm run migrate
const { validate } = require('./config');
const db = require('./db');

(async () => {
  const { fatal } = validate();
  // Only DATABASE_URL matters for a migration run.
  const blocking = fatal.filter((m) => m.includes('DATABASE_URL'));
  if (blocking.length) { console.error(blocking.join('\n')); process.exit(1); }
  try {
    await db.migrate();
    await db.pool.end();
  } catch (e) {
    console.error('Migration failed:', e.message);
    process.exit(1);
  }
})();
