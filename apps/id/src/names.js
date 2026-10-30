// ===================================================================
// Signify ID — official names and display names
//
// The official name is the school's record (FACTS, at Richmond): first,
// middle, last, suffix. It is set by a school admin, one person at a time or
// from a CSV the office exported, and it is what grade lists in last-name
// order use. Signify never talks to FACTS; somebody brings the file.
//
// The display name is what apps show. It follows Google until the school
// sets it, or the person does where the school allows (tenants.settings
// .names.self_display). Every change to either is kept in name_changes.
//
// The CSV import works like the roster import: `analyse` explains what each
// row would do, `apply` runs the same analysis again and writes it in one
// transaction, so a preview cannot go stale and nothing is half-applied.
// ===================================================================

const db = require('./db');
const csv = require('./csv');
const identity = require('./identity');

const MAX_PART = 80;
const MAX_DISPLAY = 120;
const MAX_ROWS = 3000;

// Trimmed, inner spaces collapsed, control characters gone, capped.
function cleanPart(v, max = MAX_PART) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// { given, middle, family, suffix } or an error. First and last are both
// required: an official name with half of it missing would sort wrongly.
function cleanOfficial(o) {
  const out = {
    given: cleanPart(o && o.given),
    middle: cleanPart(o && o.middle),
    family: cleanPart(o && o.family),
    suffix: cleanPart(o && o.suffix, 20),
  };
  if (!out.given || !out.family) return { ok: false, error: 'An official name needs both a first and a last name.' };
  return { ok: true, official: out };
}

function officialOf(u) {
  if (!u || !u.official_family_name) return null;
  return {
    given: u.official_given_name || '',
    middle: u.official_middle_name || '',
    family: u.official_family_name || '',
    suffix: u.official_suffix || '',
  };
}

const sameOfficial = (a, b) => !!a && !!b
  && a.given === b.given && a.middle === b.middle && a.family === b.family && a.suffix === b.suffix;

// "Given Middle Family Suffix", for showing an official name in one line.
function fullOfficial(o) {
  if (!o) return '';
  return [o.given, o.middle, o.family, o.suffix].filter(Boolean).join(' ');
}

function selfDisplayAllowed(settings) {
  return !!(settings && settings.names && settings.names.self_display === true);
}

// ---------- writing one person ----------

// `q` is a client inside a transaction, or the pool.
async function writeOfficial(q, { userId, tenantId, official, source, actorId }) {
  const cur = (await q.query('SELECT * FROM users WHERE id = $1', [userId])).rows[0];
  if (!cur) return { ok: false, error: 'That account no longer exists.' };
  const before = officialOf(cur);
  if (sameOfficial(before, official)) return { ok: true, changed: false };
  await q.query(
    `UPDATE users SET official_given_name = $2, official_middle_name = NULLIF($3, ''),
                      official_family_name = $4, official_suffix = NULLIF($5, ''),
                      official_name_source = $6, official_name_at = now()
      WHERE id = $1`,
    [userId, official.given, official.middle, official.family, official.suffix, source]);
  await q.query(
    `INSERT INTO name_changes (user_id, tenant_id, kind, before, after, source, changed_by)
     VALUES ($1,$2,'official',$3,$4,$5,$6)`,
    [userId, tenantId || null, before ? JSON.stringify(before) : null, JSON.stringify(official), source, actorId || null]);
  return { ok: true, changed: true };
}

async function clearOfficial(q, { userId, tenantId, actorId }) {
  const cur = (await q.query('SELECT * FROM users WHERE id = $1', [userId])).rows[0];
  if (!cur) return { ok: false, error: 'That account no longer exists.' };
  const before = officialOf(cur);
  if (!before) return { ok: true, changed: false };
  await q.query(
    `UPDATE users SET official_given_name = NULL, official_middle_name = NULL, official_family_name = NULL,
                      official_suffix = NULL, official_name_source = NULL, official_name_at = now()
      WHERE id = $1`, [userId]);
  await q.query(
    `INSERT INTO name_changes (user_id, tenant_id, kind, before, after, source, changed_by)
     VALUES ($1,$2,'official',$3,NULL,'admin',$4)`,
    [userId, tenantId || null, JSON.stringify(before), actorId || null]);
  return { ok: true, changed: true };
}

// source: 'school' (an admin) or 'self'. Reset hands the name back to
// Google: it is set from the official name if there is one (so it is not
// left as a nickname nobody chose any more), and the next sign-in follows
// the Google profile again.
async function writeDisplay(q, { userId, tenantId, name, source, actorId, reset = false, how = null }) {
  const cur = (await q.query('SELECT * FROM users WHERE id = $1', [userId])).rows[0];
  if (!cur) return { ok: false, error: 'That account no longer exists.' };
  let next, nextSource;
  if (reset) {
    const off = officialOf(cur);
    next = off ? [off.given, off.family].join(' ') : (cur.display_name || '');
    if (!off && cur.given_name && cur.family_name) next = `${cur.given_name} ${cur.family_name}`;
    nextSource = 'google';
  } else {
    next = cleanPart(name, MAX_DISPLAY);
    if (!next) return { ok: false, error: 'Enter a name to show.' };
    nextSource = source;
  }
  if (next === cur.display_name && nextSource === cur.display_name_source) return { ok: true, changed: false };
  await q.query('UPDATE users SET display_name = $2, display_name_source = $3 WHERE id = $1', [userId, next, nextSource]);
  await q.query(
    `INSERT INTO name_changes (user_id, tenant_id, kind, before, after, source, changed_by)
     VALUES ($1,$2,'display',$3,$4,$5,$6)`,
    [userId, tenantId || null,
     JSON.stringify({ name: cur.display_name, source: cur.display_name_source }),
     JSON.stringify({ name: next, source: nextSource }),
     how || (reset ? 'reset' : (source === 'self' ? 'self' : 'admin')), actorId || null]);
  return { ok: true, changed: true, name: next };
}

const pool = { query: (text, params) => db.query(text, params) };

async function forPerson(userId) {
  const u = await db.one('SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [userId]);
  if (!u) return null;
  const history = await db.many(
    `SELECT n.kind, n.before, n.after, n.source, n.created_at, c.display_name AS changed_by_name
       FROM name_changes n LEFT JOIN users c ON c.id = n.changed_by
      WHERE n.user_id = $1 ORDER BY n.created_at DESC LIMIT 50`, [userId]);
  return {
    id: u.id,
    display_name: u.display_name,
    display_name_source: u.display_name_source,
    google: { given: u.given_name || '', family: u.family_name || '' },
    official: officialOf(u),
    official_source: u.official_name_source,
    official_at: u.official_name_at,
    history,
  };
}

// ---------- the CSV import ----------

const NAME_ALIASES = {
  first_name: ['firstname', 'first', 'givenname', 'given', 'forename', 'legalfirstname', 'studentfirstname', 'officialfirstname'],
  middle_name: ['middlename', 'middle', 'mi', 'middleinitial', 'legalmiddlename', 'studentmiddlename'],
  last_name: ['lastname', 'last', 'familyname', 'family', 'surname', 'legallastname', 'studentlastname', 'officiallastname'],
  suffix: ['suffix', 'namesuffix', 'generation'],
  full_name: ['name', 'fullname', 'studentname', 'legalname', 'lastfirst', 'lastnamefirstname'],
  display_name: ['displayname', 'preferredname', 'nickname', 'nickname1', 'goesby', 'preferred'],
  email: ['email', 'emailaddress', 'schoolemail', 'studentemail', 'mail', 'username', 'googleaccount', 'emailaddress1'],
  signify_id: ['signifyid', 'id', 'userid', 'accountid'],
};

function mapNameHeaders(headerRow) {
  const map = {};
  const unknown = [];
  headerRow.forEach((h, idx) => {
    const n = csv.normalise(h);
    if (!n) return;
    const hit = Object.entries(NAME_ALIASES).find(([, aliases]) => aliases.includes(n));
    if (hit) { if (!(hit[0] in map)) map[hit[0]] = idx; } else unknown.push(h);
  });
  return { map, unknown };
}

const SUFFIXES = /^(jr|sr|ii|iii|iv|v)\.?$/i;

// "Last, First Middle Suffix" (how FACTS prints a name in one column).
// Without a comma the name is not split: guessing which word is the last
// name is the mistake this whole feature exists to stop making.
function splitLastFirst(s) {
  const text = cleanPart(s, 200);
  const comma = text.indexOf(',');
  if (comma < 0) return null;
  const family = text.slice(0, comma).trim();
  const words = text.slice(comma + 1).trim().split(' ').filter(Boolean);
  let suffix = '';
  if (words.length > 1 && SUFFIXES.test(words[words.length - 1])) suffix = words.pop();
  const given = words.shift() || '';
  return { given, middle: words.join(' '), family, suffix };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function analyse({ text, tenantId }) {
  const parsed = csv.parse(text);
  if (!parsed.length) return { ok: false, error: 'That file has no rows in it.' };
  const { map, unknown } = mapNameHeaders(parsed[0]);
  if (map.email === undefined && map.signify_id === undefined) {
    return { ok: false, error: 'No email column found. The file needs a heading like "Email" (or "Signify ID") to say who each row is.' };
  }
  const hasParts = map.first_name !== undefined && map.last_name !== undefined;
  if (!hasParts && map.full_name === undefined) {
    return { ok: false, error: 'No name columns found. The file needs "First name" and "Last name" headings, or one "Name" column written Last, First.' };
  }
  const body = parsed.slice(1);
  if (body.length > MAX_ROWS) return { ok: false, error: `That file has ${body.length} rows. Split it into files of ${MAX_ROWS} or fewer.` };

  const tenant = await db.one('SELECT id, name, kind, settings FROM tenants WHERE id = $1', [tenantId]);
  if (!tenant) return { ok: false, error: 'That school no longer exists.' };
  if (tenant.kind === 'independent') return { ok: false, error: 'Official names come from a school.' };

  // Everyone at the school, once, so a 500-row file is two queries.
  const people = await db.many(
    `SELECT u.* FROM users u JOIN memberships m ON m.user_id = u.id
      WHERE m.tenant_id = $1 AND u.deleted_at IS NULL`, [tenantId]);
  const byEmail = new Map(people.map((p) => [p.email, p]));
  const byId = new Map(people.map((p) => [p.id, p]));

  const cell = (row, key) => (map[key] === undefined ? '' : cleanPart(row[map[key]], 200));
  const seen = new Map();
  const rows = [];
  for (let i = 0; i < body.length; i += 1) {
    const raw = body[i];
    const line = i + 2;
    const email = identity.lower(cell(raw, 'email'));
    const sid = cell(raw, 'signify_id');
    const problems = [];

    let person = null;
    if (sid && UUID.test(sid)) person = byId.get(sid.toLowerCase()) || null;
    if (!person && email) person = byEmail.get(email) || null;
    if (!person) problems.push(email || sid ? 'Nobody at this school has that email address.' : 'No email address on this row.');

    let off = hasParts
      ? { given: cell(raw, 'first_name'), middle: cell(raw, 'middle_name'), family: cell(raw, 'last_name'), suffix: cell(raw, 'suffix') }
      : null;
    if (!hasParts || (!off.given && !off.family && map.full_name !== undefined)) {
      const split = splitLastFirst(cell(raw, 'full_name'));
      if (split) off = { ...split, suffix: split.suffix || (off ? off.suffix : '') };
      else if (!off) off = { given: '', middle: '', family: '', suffix: '' };
    }
    const checked = cleanOfficial(off);
    if (!checked.ok) problems.push(hasParts ? 'First or last name is missing.' : 'The name is not written Last, First.');

    if (person) {
      if (seen.has(person.id)) problems.push(`The same person is also on line ${seen.get(person.id)}.`);
      else seen.set(person.id, line);
    }

    const row = {
      line, email: person ? person.email : email, userId: person ? person.id : null,
      currentDisplay: person ? person.display_name : null,
      currentOfficial: person ? officialOf(person) : null,
      official: checked.ok ? checked.official : null,
      problems,
    };
    if (!problems.length) {
      row.officialChange = !sameOfficial(row.currentOfficial, row.official);
      const disp = cell(raw, 'display_name');
      if (disp && disp !== person.display_name) {
        // A name the person chose for themselves wins over the office's
        // nickname column; the preview says so.
        if (person.display_name_source === 'self') row.displayKept = disp;
        else row.display = cleanPart(disp, MAX_DISPLAY);
      }
      row.action = row.officialChange || row.display ? 'update' : 'same';
    } else {
      row.action = 'error';
    }
    rows.push(row);
  }

  const summary = {
    rows: rows.length,
    update: rows.filter((r) => r.action === 'update').length,
    same: rows.filter((r) => r.action === 'same').length,
    errors: rows.filter((r) => r.action === 'error').length,
    displayChanges: rows.filter((r) => r.display).length,
    // People at the school the file did not mention: worth knowing before a
    // grade list is built from it, but nothing happens to them.
    notInFile: people.filter((p) => !seen.has(p.id)).length,
  };
  return { ok: true, tenant: { id: tenant.id, name: tenant.name }, unknownColumns: unknown, rows, summary };
}

async function apply({ text, tenantId, actorId }) {
  const result = await analyse({ text, tenantId });
  if (!result.ok) return result;
  const todo = result.rows.filter((r) => r.action === 'update');
  let official = 0, display = 0;
  await db.tx(async (client) => {
    for (const r of todo) {
      if (r.officialChange) {
        const w = await writeOfficial(client, { userId: r.userId, tenantId, official: r.official, source: 'import', actorId });
        if (w.changed) official += 1;
      }
      if (r.display) {
        const w = await writeDisplay(client, { userId: r.userId, tenantId, name: r.display, source: 'school', actorId, how: 'import' });
        if (w.changed) display += 1;
      }
    }
  });
  return { ok: true, summary: { ...result.summary, officialWritten: official, displayWritten: display }, rows: result.rows };
}

function template() {
  const rows = [
    ['Email', 'First name', 'Middle name', 'Last name', 'Suffix', 'Display name'],
    ['ada.fielding@school.edu', 'Ada', 'Grace', 'Fielding', '', 'Ada'],
    ['ben.okafor@school.edu', 'Benjamin', '', 'Okafor', 'Jr.', 'Ben Okafor'],
    ['m.delarosa@school.edu', 'María', 'José', 'de la Rosa', '', ''],
  ];
  return rows.map((r) => r.map(csv.escapeCell).join(',')).join('\r\n') + '\r\n';
}

async function recent(tenantId, limit = 40) {
  return db.many(
    `SELECT n.kind, n.before, n.after, n.source, n.created_at,
            u.display_name AS person_name, u.email AS person_email, c.display_name AS changed_by_name
       FROM name_changes n
       JOIN users u ON u.id = n.user_id
       LEFT JOIN users c ON c.id = n.changed_by
      WHERE n.tenant_id = $1 AND u.deleted_at IS NULL
      ORDER BY n.created_at DESC LIMIT $2`, [tenantId, limit]);
}

module.exports = {
  cleanPart, cleanOfficial, officialOf, fullOfficial, selfDisplayAllowed, splitLastFirst,
  writeOfficial, clearOfficial, writeDisplay, forPerson, analyse, apply, template, recent, pool,
  MAX_ROWS,
};
