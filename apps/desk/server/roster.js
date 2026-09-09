// ===================================================================
// Teacher's Desk — where the class lists come from
//
// Two sources, deliberately:
//
//   signify:<classId>  a real class from Signify ID. The desk never stores
//                      the names; it asks each time and caches for a minute,
//                      so removing a pupil there removes them here.
//   list:<id>          a list the teacher typed in themselves. For the supply
//                      teacher, the after-school club, the class that has not
//                      been imported yet — a tool nobody can use on day one is
//                      not a tool.
//
// Both come back in one shape so the randomiser and the group maker never
// have to care which they were given.
// ===================================================================

const signify = require('../signify-auth');
const store = require('./store');

// The cookie signify-auth sets. Reading it here is what lets the desk ask
// Signify ID a question *as the teacher*, so the roster rules are enforced
// there rather than trusted here.
const TOKEN_COOKIE = 'sfy_id';

const cache = new Map();          // key -> { at, value }
const CACHE_MS = 60_000;

function cached(key, produce) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.value);
  return produce().then((value) => {
    // Never cache a failure. A minute of "you have no classes" after one bad
    // response turns a blip into something a teacher reports as broken.
    if (value != null) cache.set(key, { at: Date.now(), value });
    return value;
  });
}

function forget(prefix) {
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
}

/**
 * The ID token to ask Signify ID with.
 *
 * This has to be the token as of NOW, not the one the browser sent. When an
 * ID token expires, signify-auth's middleware silently renews it and puts the
 * new one in a Set-Cookie on the *response* — but `req.headers.cookie` still
 * holds the old, expired one for the rest of that request. Asking with that
 * gets a 401, and the teacher sees "no class lists yet" instead of their
 * classes, roughly on the first page load after every expiry.
 *
 * `req.signifyToken` is set in server.js from the response header when a
 * renewal has just happened; the cookie is the fallback.
 */
function tokenFor(req) {
  return req.signifyToken || signify._internal.parseCookies(req)[TOKEN_COOKIE] || '';
}

async function ask(req, pathname) {
  if (!signify.ENABLED) return null;
  const token = tokenFor(req);
  if (!token) {
    console.warn(`desk: no sign-in token to ask ${pathname} with`);
    return null;
  }
  try {
    const res = await fetch(`${signify.ISSUER}${pathname}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      // Said out loud, with the status. A silent null here is what made this
      // look like "the teacher has no classes" rather than "the request was
      // refused", and cost an afternoon.
      const detail = await res.text().catch(() => '');
      console.warn(`desk: ${pathname} refused (${res.status}) ${detail.slice(0, 200)}`);
      // A 401 means Signify ID no longer recognises this sign-in, whatever
      // this app still believes. Recorded so the request can end the desk's
      // own session too: a desk that thinks you are signed in but cannot see
      // a single class list is worse than one that just asks you to sign in
      // again, which is what a teacher ends up doing by hand anyway.
      if (res.status === 401) req.signifyExpired = true;
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn('desk: roster request failed —', e.message);
    return null;
  }
}

const clean = (s, max = 80) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);

// ---------- the two sources, in one shape ----------

/**
 * Every class list this teacher can pick from, without the pupil names.
 *
 * Reports whether the lookup against Signify ID actually succeeded, because
 * "your classes could not be fetched" and "you teach no classes" are entirely
 * different things to put in front of a teacher, and showing the second when
 * the first is true reads as their data having been lost.
 */
async function classesFor(req, user) {
  const out = [];

  const body = await cached(`classes:${user.uid}`, () => ask(req, '/api/v1/classes'));
  const signifyOk = !signify.ENABLED || body != null;
  for (const c of (body && body.classes) || []) {
    // Somebody's own child's class, where they are the parent, is not a class
    // they teach. Only show lists this person stands in front of.
    if (c.role && !['teacher', 'aide', 'admin'].includes(c.role)) continue;
    out.push({
      key: `signify:${c.id}`,
      name: c.name,
      subject: c.subject || '',
      source: 'signify',
      editable: false,
    });
  }

  const db = store.load();
  for (const list of Object.values(db.rosters)) {
    if (list.ownerUid !== user.uid) continue;
    out.push({
      key: `list:${list.id}`,
      name: list.name,
      subject: '',
      source: 'list',
      editable: true,
      size: (list.students || []).length,
    });
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return { classes: out, signifyOk };
}

/** The pupils in one list. Returns null when this teacher may not see it. */
async function membersOf(req, user, key) {
  if (key.startsWith('list:')) {
    const list = store.load().rosters[key.slice(5)];
    if (!list || list.ownerUid !== user.uid) return null;
    return { name: list.name, source: 'list', editable: true, students: list.students.map((s) => ({ ...s })) };
  }

  if (key.startsWith('signify:')) {
    const id = key.slice(8);
    const body = await cached(`members:${user.uid}:${id}`, () => ask(req, `/api/v1/classes/${encodeURIComponent(id)}/members`));
    if (!body || !Array.isArray(body.members)) return null;
    const students = body.members
      .filter((m) => m.role === 'student')
      .map((m) => ({ id: m.id, name: m.display_name || m.email || 'Unnamed', picture: m.picture_url || '' }));
    return { name: '', source: 'signify', editable: false, students };
  }

  return null;
}

// ---------- lists the teacher types in ----------

function createList(user, name, students) {
  const db = store.load();
  const mine = Object.values(db.rosters).filter((r) => r.ownerUid === user.uid);
  if (mine.length >= 40) throw new Error('That is as many lists as one desk can hold.');
  const now = Date.now();
  const list = {
    id: store.id('list'),
    ownerUid: user.uid,
    tenantId: user.tenantId || null,
    name: clean(name, 60) || 'Untitled list',
    students: normaliseStudents(students),
    createdAt: now,
    updatedAt: now,
  };
  db.rosters[list.id] = list;
  store.save();
  forget(`classes:${user.uid}`);
  return list;
}

function updateList(user, id, patch) {
  const db = store.load();
  const list = db.rosters[id];
  if (!list || list.ownerUid !== user.uid) return null;
  if (patch.name != null) list.name = clean(patch.name, 60) || list.name;
  if (patch.students != null) list.students = normaliseStudents(patch.students, list.students);
  list.updatedAt = Date.now();
  store.save();
  forget(`classes:${user.uid}`);
  return list;
}

function deleteList(user, id) {
  const db = store.load();
  const list = db.rosters[id];
  if (!list || list.ownerUid !== user.uid) return false;
  delete db.rosters[id];
  store.save();
  forget(`classes:${user.uid}`);
  return true;
}

/**
 * Keeps a pupil's id stable across an edit, so behaviour notes and saved
 * groups stay attached to the same person when a name is corrected.
 */
function normaliseStudents(input, previous = []) {
  const byId = new Map(previous.map((s) => [s.id, s]));
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(input) ? input : []) {
    const name = clean(typeof raw === 'string' ? raw : raw && raw.name);
    if (!name) continue;
    const id = (raw && raw.id && byId.has(raw.id)) ? raw.id : store.id('s');
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name });
    if (out.length >= 200) break;
  }
  return out;
}

module.exports = { classesFor, membersOf, createList, updateList, deleteList, _forget: forget };
