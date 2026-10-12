// Quick operational read-out of registered applications. Read-only.
const db = require('./db');
(async () => {
  const apps = await db.many(`
    SELECT a.client_id, a.name, a.namespace, a.status, a.redirect_uris, a.created_at,
           (SELECT COUNT(*) FROM app_permissions ap WHERE ap.app_id = a.id AND NOT ap.deprecated) AS perms,
           (SELECT COUNT(*) FROM refresh_tokens rt WHERE rt.app_id = a.id) AS tokens,
           (SELECT COUNT(*) FROM auth_codes ac WHERE ac.app_id = a.id) AS codes,
           (SELECT string_agg(t.name, ', ') FROM app_tenants at JOIN tenants t ON t.id = at.tenant_id
             WHERE at.app_id = a.id AND at.enabled) AS schools
      FROM apps a ORDER BY a.created_at`);
  for (const a of apps) {
    console.log(`client_id   ${a.client_id}`);
    console.log(`  name        ${a.name}`);
    console.log(`  namespace   ${a.namespace}   status ${a.status}`);
    console.log(`  redirects   ${(a.redirect_uris || []).join(', ') || '(none)'}`);
    console.log(`  schools     ${a.schools || '(none - nobody can sign in)'}`);
    console.log(`  declared    ${a.perms} permissions`);
    console.log(`  in use      ${a.tokens} refresh tokens, ${a.codes} auth codes`);
    console.log(`  created     ${new Date(a.created_at).toISOString().slice(0, 19)}`);
    console.log('');
  }
  await db.pool.end();
})().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
