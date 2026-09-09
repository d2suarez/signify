#!/usr/bin/env node
// ===================================================================
// Signify ID — "why can't I find this person?"
//
//   node src/whois.js char
//   node src/whois.js heston.charles@rasda.org
//
// Answers the support question the console cannot: a person missing from a
// class search is usually not missing at all — they hold no membership in
// that school, or they are already on the roster. This prints the whole
// picture for anyone matching the term, so the answer takes one look.
// ===================================================================

const db = require('./db');

async function whois(term) {
  const like = '%' + String(term).toLowerCase().replace(/[%_\\]/g, (c) => '\\' + c) + '%';

  const people = await db.many(
    `SELECT u.id, u.email, u.display_name, u.status AS account_status, u.deleted_at
       FROM users u
      WHERE lower(u.display_name) LIKE $1 ESCAPE '\\' OR u.email LIKE $1 ESCAPE '\\'
      ORDER BY u.display_name`, [like]);

  if (!people.length) {
    console.log(`No account anywhere matches "${term}".`);
    console.log('Nobody by that name or address has ever signed in or been imported.');
    return;
  }

  for (const p of people) {
    console.log('');
    console.log(`${p.display_name}  <${p.email}>`);
    console.log(`  account   ${p.deleted_at ? 'ERASED on ' + p.deleted_at : p.account_status}`);

    const memberships = await db.many(
      `SELECT t.name, t.slug, m.status, r.label AS role
         FROM memberships m JOIN tenants t ON t.id = m.tenant_id
         LEFT JOIN roles r ON r.id = m.role_id
        WHERE m.user_id = $1`, [p.id]);

    if (!memberships.length) {
      console.log('  school    NONE — this is why no class search finds them.');
      console.log('            Console: Requests -> Not in any school, then assign them.');
    } else {
      for (const m of memberships) {
        console.log(`  school    ${m.name} (${m.slug}) — ${m.status}, ${m.role || 'no role'}`);
      }
    }

    const recent = await db.many(
      `SELECT ts, action, detail FROM audit_log
        WHERE actor_user_id = $1 ORDER BY ts DESC LIMIT 12`, [p.id]);
    for (const a of recent) {
      console.log(`  log       ${new Date(a.ts).toISOString()}  ${a.action}  ${JSON.stringify(a.detail || {})}`);
    }

    const classes = await db.many(
      `SELECT c.name, c.archived, cm.role, t.name AS school
         FROM class_members cm JOIN classes c ON c.id = cm.class_id
         JOIN tenants t ON t.id = c.tenant_id
        WHERE cm.user_id = $1 ORDER BY c.name`, [p.id]);
    for (const c of classes) {
      console.log(`  class     ${c.name} (${c.school}) as ${c.role}${c.archived ? ' [archived]' : ''}`);
    }
    if (classes.length) {
      console.log('            A class listed above will not appear in its own search — ' +
        'people already on a roster are left out of it.');
    }
  }
}

// Runs the real class search, so a disagreement between "this person exists
// in the school" and "the box finds them" is visible in one place.
async function trySearch(term, className) {
  const directory = require('./directory');
  const classes = await db.many(
    `SELECT c.id, c.name, c.tenant_id, t.name AS school
       FROM classes c JOIN tenants t ON t.id = c.tenant_id
      WHERE c.name ILIKE $1`, ['%' + className + '%']);
  if (!classes.length) { console.log(`\nNo class matches "${className}".`); return; }

  for (const c of classes) {
    console.log(`\nSearching "${term}" in ${c.name} (${c.school}):`);
    const hits = await directory.classCandidates({
      tenantId: c.tenant_id, classId: c.id, q: term,
    });
    if (!hits.length) console.log('  nothing');
    for (const h of hits) console.log(`  ${h.display_name} <${h.email}> ${h.role_label || ''}`);
  }
}

async function main() {
  const term = process.argv[2];
  if (!term) {
    console.error('Usage: node src/whois.js <name or email fragment> [class name]');
    process.exit(1);
  }
  await whois(term);
  if (process.argv[3]) await trySearch(term, process.argv[3]);

  console.log('');
  console.log('Apps, and the schools each is turned on for:');
  const apps = await db.many(
    `SELECT a.client_id, a.name, a.status, t.name AS school, at.enabled
       FROM apps a
       LEFT JOIN app_tenants at ON at.app_id = a.id
       LEFT JOIN tenants t ON t.id = at.tenant_id
      ORDER BY a.name, t.name`);
  let lastApp = null;
  for (const a of apps) {
    if (a.name !== lastApp) { console.log(`  ${a.name} (${a.client_id}) — ${a.status}`); lastApp = a.name; }
    console.log(`      ${a.school || 'NO SCHOOL ENABLED — /authorize will refuse everyone but a super admin'}` +
      (a.school ? (a.enabled ? ' — enabled' : ' — present but DISABLED') : ''));
  }

  console.log('');
  console.log('Schools and the domains that join people to them:');
  const domains = await db.many(
    `SELECT t.name, t.slug, d.domain
       FROM tenants t LEFT JOIN tenant_domains d ON d.tenant_id = t.id
      ORDER BY t.name, d.domain`);
  let last = null;
  for (const d of domains) {
    if (d.name !== last) { console.log(`  ${d.name} (${d.slug})`); last = d.name; }
    console.log(`      ${d.domain || '(no domain registered)'}`);
  }
  process.exit(0);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { whois };
