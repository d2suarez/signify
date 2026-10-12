// ===================================================================
// Signify ID — register an application from the command line
//
//   railway run node src/register-app.js \
//     --name "Classroom Atlas" --namespace atlas \
//     --redirect https://maps.signify.one/auth/callback \
//     --enable-for "Oakwood School"
//
// The console can do this too. This exists because registering the first apps
// is a deployment step, not a click — and because it prints the secret once,
// to a terminal, rather than through a browser.
// ===================================================================

const db = require('./db');
const secrets = require('./secrets');
const audit = require('./audit');

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}
function argAll(name) {
  const out = [];
  process.argv.forEach((v, i) => {
    if (v === '--' + name && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
      out.push(process.argv[i + 1]);
    }
  });
  return out;
}
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/**
 * Where an app may send somebody after signing out.
 *
 * The client library asks to return to the app's own origin, and the identity
 * service will only honour an address the app registered. Nobody was
 * registering one, so every logout fell through to the "signed out" page here
 * and the sign-in link on it led to the console — leaving a teacher on the
 * identity site instead of the app they had just left.
 *
 * Deriving it from the redirect address keeps the two in step: they are the
 * same origin by definition, and an app that changes host cannot end up with a
 * stale one.
 */
function postLogoutFor(redirectUris, extra) {
  const out = new Set(extra || []);
  for (const uri of redirectUris) {
    try { out.add(new URL(uri).origin + '/'); } catch { /* ignore an unparseable address */ }
  }
  return [...out];
}

async function main() {
  const name = arg('name');
  const namespace = (arg('namespace') || '').replace(/[^a-z0-9]/g, '');
  const redirects = argAll('redirect');
  const postLogout = argAll('post-logout');
  const enableFor = argAll('enable-for');
  // Everything the app switcher needs to draw this app's tile.
  const launchUrl = arg('launch-url');
  const shortName = arg('short-name');
  const initials = arg('initials');
  const color = arg('color');
  const sortOrder = arg('sort-order');
  const rotate = process.argv.includes('--rotate');
  // Change an app's addresses or school access without issuing a new secret,
  // which would otherwise mean redeploying the app just to change a URL.
  const update = process.argv.includes('--update');
  const remove = process.argv.includes('--delete');

  if (!name || !namespace || (!redirects.length && !rotate && !update && !remove)) {
    console.error('Usage: node src/register-app.js --name "App Name" --namespace ns \\\n  --redirect https://.../auth/callback [--enable-for "School"] \\\n  [--post-logout https://app.example/] [--launch-url https://app.example] [--short-name Atlas] [--initials AT] [--color blue] [--sort-order 20] \\\n  [--rotate | --update | --delete]');
    process.exit(1);
  }

  for (const u of redirects) {
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(parsed.hostname)) {
        console.error(`Redirect addresses must use https (except on localhost): ${u}`);
        process.exit(1);
      }
    } catch { console.error(`Not a valid address: ${u}`); process.exit(1); }
  }

  const clientId = slugify(arg('client-id') || name);

  // Removing a registration. Guarded on actual use rather than on a prompt,
  // because the cascade takes its permissions, school access and every live
  // token with it.
  if (remove) {
    const target = await db.one('SELECT * FROM apps WHERE client_id = $1', [clientId]);
    if (!target) { console.error(`No app called "${clientId}".`); process.exit(1); }

    const used = await db.one(
      `SELECT (SELECT COUNT(*) FROM refresh_tokens WHERE app_id = $1) AS tokens,
              (SELECT COUNT(*) FROM auth_codes WHERE app_id = $1) AS codes`, [target.id]);
    const inUse = Number(used.tokens) + Number(used.codes);

    if (inUse > 0 && !process.argv.includes('--force')) {
      console.error(`"${clientId}" has been signed in to (${used.tokens} refresh tokens, ${used.codes} codes).`);
      console.error('Deleting it signs everyone out of that app and drops its permissions. Add --force if that is intended.');
      process.exit(1);
    }

    await db.query('DELETE FROM apps WHERE id = $1', [target.id]);
    await audit.record({
      action: 'app.deleted', targetType: 'app', targetId: clientId,
      detail: { via: 'cli', name: target.name, hadUsage: inUse },
    });
    console.log(`Deleted "${clientId}"${inUse ? ' (was in use)' : ' (never used)'}.`);
    await db.pool.end();
    return;
  }
  const secret = secrets.generate();

  const existing = await db.one('SELECT * FROM apps WHERE client_id = $1', [clientId]);

  let app;
  if (existing && update) {
    app = await db.one(
      `UPDATE apps SET name = $2, namespace = $3,
                       redirect_uris = CASE WHEN cardinality($4::text[]) > 0 THEN $4::text[] ELSE redirect_uris END,
                       post_logout_uris = CASE WHEN cardinality($5::text[]) > 0 THEN $5::text[] ELSE post_logout_uris END
        WHERE id = $1 RETURNING *`,
      [existing.id, name, namespace, redirects, postLogoutFor(redirects, postLogout)]);
    console.log(`Updated ${clientId}. The existing secret still works.`);
  } else if (existing) {
    if (!rotate) {
      console.error(`"${clientId}" is already registered. Add --rotate to issue a new secret (the old one stops working immediately).`);
      process.exit(1);
    }
    app = await db.one(
      `UPDATE apps SET client_secret_hash = $2, name = $3, namespace = $4,
                       redirect_uris = CASE WHEN cardinality($5::text[]) > 0 THEN $5::text[] ELSE redirect_uris END,
                       post_logout_uris = CASE WHEN cardinality($6::text[]) > 0 THEN $6::text[] ELSE post_logout_uris END
        WHERE id = $1 RETURNING *`,
      [existing.id, secrets.hash(secret), name, namespace, redirects, postLogoutFor(redirects, postLogout)]);
    console.log(`Rotated the secret for ${clientId}.`);
  } else {
    app = await db.one(
      `INSERT INTO apps (client_id, name, client_secret_hash, redirect_uris, post_logout_uris, namespace, scopes)
       VALUES ($1,$2,$3,$4,$5,$6, ARRAY['openid','profile','email','roles'])
       RETURNING *`,
      [clientId, name, secrets.hash(secret), redirects, postLogoutFor(redirects, postLogout), namespace]);
    console.log(`Registered ${name}.`);
  }


  // Launcher details, applied on create, update and rotate alike.
  if (launchUrl || shortName || initials || color || sortOrder) {
    await db.query(
      `UPDATE apps SET
         launch_url    = COALESCE($2, launch_url),
         short_name    = COALESCE($3, short_name),
         tile_initials = COALESCE($4, tile_initials),
         tile_color    = COALESCE($5, tile_color),
         sort_order    = COALESCE($6, sort_order)
       WHERE id = $1`,
      [app.id, launchUrl, shortName,
       initials ? initials.toUpperCase().slice(0, 2) : null,
       color, sortOrder ? Number(sortOrder) : null]);
    console.log(`  Switcher: ${launchUrl || '(url unchanged)'}`);
  }

  // An app is off for every school until somebody turns it on.
  for (const schoolName of enableFor) {
    const tenant = await db.one(
      'SELECT id, name FROM tenants WHERE lower(name) = lower($1) OR slug = lower($1)', [schoolName]);
    if (!tenant) { console.warn(`  No school called "${schoolName}" — skipped.`); continue; }
    await db.query(
      `INSERT INTO app_tenants (app_id, tenant_id, enabled) VALUES ($1,$2,true)
       ON CONFLICT (app_id, tenant_id) DO UPDATE SET enabled = true`,
      [app.id, tenant.id]);
    console.log(`  Enabled for ${tenant.name}.`);
  }

  const tenants = await db.many(
    `SELECT t.name FROM app_tenants at JOIN tenants t ON t.id = at.tenant_id
      WHERE at.app_id = $1 AND at.enabled`, [app.id]);
  if (!tenants.length) {
    console.log('  Not enabled for any school yet — nobody can sign in to it until it is.');
  }

  await audit.record({
    appId: app.id,
    action: existing ? 'app.secret_rotated' : 'app.created',
    targetType: 'app', targetId: app.client_id,
    detail: { via: 'cli', namespace, redirects },
  });

  if (update) {
    console.log(`Addresses: ${(app.redirect_uris || []).join(', ')}`);
  console.log(`After signing out: ${(app.post_logout_uris || []).join(', ') || '(none)'}`);
    await db.pool.end();
    return;
  }

  // Printed once. Nothing recoverable is stored.
  console.log('\n--- paste into the app\'s environment ---');
  console.log(`SIGNIFY_ISSUER=${process.env.ISSUER || 'https://id.signify.one'}`);
  console.log(`SIGNIFY_CLIENT_ID=${app.client_id}`);
  console.log(`SIGNIFY_CLIENT_SECRET=${secret}`);
  console.log(`SIGNIFY_REDIRECT_URI=${(app.redirect_uris || [])[0] || ''}`);
  console.log('SIGNIFY_COOKIE_SECRET=<generate with: openssl rand -hex 32>');
  console.log('----------------------------------------\n');

  await db.pool.end();
}

if (require.main === module) {
  main().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
}

module.exports = { postLogoutFor };
