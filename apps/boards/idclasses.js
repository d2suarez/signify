// ===================================================================
// Classes come from Signify ID.
//
// ID already knows which classes a teacher teaches and who is in them, so the
// whiteboard gives each ID class its own classroom rather than asking teachers
// to set one up by hand. Every call is made with the SIGNED-IN USER'S OWN
// token, never a service credential: ID only returns classes that person is
// actually in, and only hands out email addresses to staff on that class, so
// the whiteboard can never read a roster its user isn't entitled to — and ID
// records its own audit entry whenever a roster is read.
//
// Same approach as the atlas (classroom-atlas/server/idclasses.js).
// ===================================================================

const ISSUER = (process.env.SIGNIFY_ISSUER || '').replace(/\/+$/, '');

// Part of signify-auth.js's contract; that file is shared verbatim across the
// fleet, so it isn't forked to export this.
const TOKEN_COOKIE = 'sfy_id';

function fromCookieHeader(raw) {
  for (const part of String(raw || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === TOKEN_COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// The ID token lives about ten minutes. When it has expired, signify-auth's
// middleware renews it and writes the new one to the RESPONSE; the request
// still carries the old one. Prefer the freshly set cookie, or the first call
// after any idle spell would be refused.
function bearer(req, res) {
  let set = res && res.getHeader && res.getHeader('set-cookie');
  if (set) {
    if (!Array.isArray(set)) set = [set];
    for (const line of set) {
      const t = fromCookieHeader(String(line).split(';')[0]);
      if (t) return t;
    }
  }
  return fromCookieHeader(req.headers.cookie);
}

async function idFetch(req, res, path) {
  if (!ISSUER) throw new Error('Signify ID is not configured on this server.');
  const token = bearer(req, res);
  if (!token) throw new Error('Please sign in again.');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  let reply;
  try {
    reply = await fetch(ISSUER + '/api/v1' + path, {
      headers: { authorization: 'Bearer ' + token, accept: 'application/json' },
      signal: ctl.signal,
    });
  } catch {
    throw new Error('Could not reach Signify ID.');
  } finally {
    clearTimeout(timer);
  }
  if (reply.status === 401) throw new Error('Your sign-in has expired. Reload the page.');
  if (reply.status === 403) throw new Error('Signify ID would not share that class.');
  if (!reply.ok) throw new Error(`Signify ID returned ${reply.status}.`);
  return reply.json();
}

const TEACHING = new Set(['teacher', 'aide']);

// Every class this person is in, teaching or learning.
async function myClasses(req, res) {
  const data = await idFetch(req, res, '/classes');
  return (data.classes || []).map((c) => {
    const role = String(c.role || '').toLowerCase();
    return {
      idClassId: String(c.id),
      name: String(c.name || 'Class').slice(0, 50),
      subject: c.subject || '',
      teaching: TEACHING.has(role),
    };
  });
}

// The pupils in one class, with the names ID has for them. Only staff on the
// class get email addresses, and the whiteboard keys pupils by email, so a
// pupil without one is counted rather than silently dropped.
async function students(req, res, idClassId) {
  const data = await idFetch(req, res, `/classes/${encodeURIComponent(idClassId)}/members`);
  const list = [];
  let withheld = 0;
  for (const m of data.members || []) {
    if (String(m.role || '').toLowerCase() !== 'student') continue;
    const email = String(m.email || '').trim().toLowerCase();
    if (email) list.push({ email, name: m.display_name || email });
    else withheld++;
  }
  return { students: list, withheld };
}

module.exports = { ISSUER, myClasses, students };
