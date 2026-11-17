// ===================================================================
// Teacher's Desk — LTI 1.3 tool (Schoology opens a student desk)
//
// Schoology is where students are known. A student who opens Teacher's Desk
// from a Schoology course gets a desk of their own, kept here under a HASH
// of Schoology's opaque id (`sub`): no name, no email, no Signify account,
// and not even Schoology's own id in plain form. Names the platform may send
// are ignored and never stored (a test checks this).
//
// Which tools they get, in order (each can only take tools away):
//   1. tools that work with no account at all (`guest: true`), minus any that
//      send you on to another app's sign-in (the whiteboard);
//   2. the school's choice for the Student role in Signify ID (Tools by role),
//      when LTI_TENANT_ID says which school this Schoology is;
//   3. the teacher's choice for that Schoology course, made on the page
//      Schoology shows them when they open the link.
//
// Google sign-in will not run inside a frame, and a desk is a full-window
// thing anyway, so the framed page only offers a button that opens the desk
// in a new window. Teachers get their usual desk (normal Signify sign-in)
// from the same page.
//
// Flow (IMS LTI 1.3 core, resource links only):
//   GET|POST /lti/login    platform starts OIDC login → redirect to its auth URL
//   POST     /lti/launch   signed id_token → checked → session → 303 /lti/app#t=…
//   GET      /lti/app      the small framed page (open desk / teacher settings)
//   GET      /lti/desk     the desk itself, in a new window, in "LTI mode"
//   /lti/api/*            what the framed page calls (header x-desk-lti)
//   /api/*                the desk's usual API, reached with the same header
//   GET      /lti/jwks     our public key
//
// Nothing here uses cookies: a frame's cookies are third-party and blocked.
// ===================================================================

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');

const store = require('./store');
const tools = require('./tools');
const policy = require('./policy');

const SCHOOLOGY = {
  issuer: 'https://schoology.schoology.com',
  authUrl: 'https://lti-service.svc.schoology.com/lti-service/authorize-redirect',
  tokenUrl: 'https://lti-service.svc.schoology.com/lti-service/access-token',
  jwksUrl: 'https://lti-service.svc.schoology.com/lti-service/.well-known/jwks',
};

const C = {
  MSG: 'https://purl.imsglobal.org/spec/lti/claim/message_type',
  VER: 'https://purl.imsglobal.org/spec/lti/claim/version',
  DEP: 'https://purl.imsglobal.org/spec/lti/claim/deployment_id',
  ROLES: 'https://purl.imsglobal.org/spec/lti/claim/roles',
  CTX: 'https://purl.imsglobal.org/spec/lti/claim/context',
  RL: 'https://purl.imsglobal.org/spec/lti/claim/resource_link',
};

const SKEW_S = 60;
const STATE_TTL_MS = 10 * 60 * 1000;
// A school day, with room either side: a desk window left open from first
// period is still working at the end of the day.
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const HEADER = 'x-desk-lti';

// Tools that work with no account but still send you to another app's own
// sign-in, which an LTI student does not have.
const NEEDS_ACCOUNT = new Set(['whiteboard']);

// What an LTI desk may call on the desk's own API. Everything else (class
// lists, behaviour, uploads, rooms, groupings) answers 403 whatever the tools.
const API_ALLOWED = [
  /^GET \/api\/config$/, /^GET \/api\/me$/,
  /^(GET|PUT) \/api\/board$/, /^POST \/api\/board\/reset$/,
  /^GET \/api\/board\/history$/, /^POST \/api\/board\/history\/\d+\/restore$/,
  /^GET \/api\/weather(\/search)?$/, /^GET \/api\/video\/[^/]+$/,
];

// ---------------- configuration ----------------

function config(env = process.env) {
  const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
  return {
    clientId: String(env.LTI_CLIENT_ID || '').trim(),
    deploymentIds: list(env.LTI_DEPLOYMENT_IDS),            // empty = any
    issuer: env.LTI_ISSUER || SCHOOLOGY.issuer,
    authUrl: env.LTI_AUTH_URL || SCHOOLOGY.authUrl,
    jwksUrl: env.LTI_JWKS_URL || SCHOOLOGY.jwksUrl,
    frameOrigins: list(env.LTI_FRAME_ORIGINS).length ? list(env.LTI_FRAME_ORIGINS) : ['https://*.schoology.com'],
    // The Signify ID school whose Student "Tools by role" applies. Empty =
    // the defaults Signify ID would apply.
    tenantId: String(env.LTI_TENANT_ID || '').trim(),
    retentionDays: Math.max(30, Math.min(730, Number(env.LTI_RETENTION_DAYS) || 365)),
  };
}

// ---------------- small JWT helpers (RS256 only) ----------------

const b64u = (buf) => Buffer.from(buf).toString('base64url');
function b64json(part) {
  try {
    const v = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

// Our key, made once and kept on the volume. Nothing is signed with it today
// (no grades, no deep links), but Schoology asks for a JWKS URL when the
// tool is registered, and having one makes adding either later a code change.
let toolKey = null;
function key() {
  if (toolKey) return toolKey;
  const file = path.join(store.DATA_DIR, 'lti-key.json');
  let pem = null;
  try { pem = JSON.parse(fs.readFileSync(file, 'utf8')).privateKey; } catch { /* first run */ }
  if (!pem) {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    fs.mkdirSync(store.DATA_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ privateKey: pem, createdAt: Date.now() }), { mode: 0o600 });
  }
  const privateKey = crypto.createPrivateKey(pem);
  const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
  const kid = crypto.createHash('sha256').update(jwk.n).digest('base64url').slice(0, 16);
  toolKey = { privateKey, kid, jwk: { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', use: 'sig', kid } };
  return toolKey;
}

// Platform keys, cached; an unknown kid triggers one refetch (key rotation).
let fetchImpl = (...a) => fetch(...a);
const jwksCache = new Map();
async function platformKey(url, kid) {
  for (const fresh of [false, true]) {
    let hit = jwksCache.get(url);
    if (fresh || !hit || Date.now() - hit.at > 10 * 60 * 1000) {
      const r = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
      if (!r.ok) throw new Error('jwks ' + r.status);
      hit = { at: Date.now(), jwks: await r.json() };
      jwksCache.set(url, hit);
    }
    const keys = ((hit.jwks && hit.jwks.keys) || []).filter((k) => k.kty === 'RSA');
    const k = kid ? keys.find((x) => x.kid === kid) : (keys.length === 1 ? keys[0] : null);
    if (k) return crypto.createPublicKey({ key: { kty: 'RSA', n: k.n, e: k.e }, format: 'jwk' });
    if (fresh) break;
  }
  return null;
}

// ---------------- state (login → launch), in memory ----------------

const states = new Map();     // state -> { nonce, until }
const usedNonces = new Map(); // nonce -> until
function prune() {
  const now = Date.now();
  for (const [k, v] of states) if (v.until < now) states.delete(k);
  for (const [k, v] of usedNonces) if (v < now) usedNonces.delete(k);
  const db = store.load();
  let changed = false;
  for (const [k, s] of Object.entries(db.ltiSessions || {})) if (s.until < now) { delete db.ltiSessions[k]; changed = true; }
  if (changed) store.save();
}

// ---------------- the launch check ----------------

/**
 * Checks a posted id_token. Returns { ok:true, claims } or { ok:false, error }.
 * The signature is checked BEFORE any other claim is believed.
 */
async function checkLaunch(cfg, idToken, state, now = Date.now()) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3 || idToken.length > 30000) return { ok: false, error: 'That launch was not readable.' };
  const header = b64json(parts[0]);
  const claims = b64json(parts[1]);
  if (!header || !claims || header.alg !== 'RS256') return { ok: false, error: 'That launch was not readable.' };

  if (claims.iss !== cfg.issuer) return { ok: false, error: 'This launch came from a platform Teacher’s Desk does not know.' };

  let pk;
  try { pk = await platformKey(cfg.jwksUrl, typeof header.kid === 'string' ? header.kid : undefined); }
  catch { return { ok: false, error: 'Could not reach Schoology to check this launch. Try again in a moment.' }; }
  if (!pk) return { ok: false, error: 'This launch was not signed by Schoology.' };
  const good = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), pk, Buffer.from(parts[2], 'base64url'));
  if (!good) return { ok: false, error: 'This launch was not signed by Schoology.' };

  const aud = Array.isArray(claims.aud) ? claims.aud.map(String) : [String(claims.aud || '')];
  if (!aud.includes(cfg.clientId) || (aud.length > 1 && claims.azp !== cfg.clientId)) {
    return { ok: false, error: 'This launch was meant for a different tool.' };
  }
  const nowS = Math.floor(now / 1000);
  const exp = Number(claims.exp), iat = Number(claims.iat);
  if (!Number.isFinite(exp) || exp + SKEW_S < nowS || !Number.isFinite(iat) || iat - SKEW_S > nowS || nowS - iat > 3600) {
    return { ok: false, error: 'That launch has expired. Open the desk again from Schoology.' };
  }

  const st = states.get(String(state || ''));
  states.delete(String(state || ''));            // single use, either way
  if (!st || st.until < now) return { ok: false, error: 'That launch has expired. Open the desk again from Schoology.' };
  if (!claims.nonce || claims.nonce !== st.nonce || usedNonces.has(claims.nonce)) {
    return { ok: false, error: 'That launch was already used. Open the desk again from Schoology.' };
  }
  usedNonces.set(claims.nonce, now + 2 * 3600 * 1000);

  if (claims[C.VER] !== '1.3.0') return { ok: false, error: 'Teacher’s Desk needs LTI 1.3.' };
  if (claims[C.MSG] !== 'LtiResourceLinkRequest') return { ok: false, error: 'Add Teacher’s Desk to a course as a link (External Tool), not through “choose content”.' };
  const dep = String(claims[C.DEP] || '');
  if (!dep || (cfg.deploymentIds.length && !cfg.deploymentIds.includes(dep))) return { ok: false, error: 'This Schoology installation is not the one Teacher’s Desk was set up for.' };
  if (typeof claims.sub !== 'string' || !claims.sub) return { ok: false, error: 'Schoology did not say who is opening the desk.' };
  const ctx = claims[C.CTX];
  if (!ctx || !ctx.id) return { ok: false, error: 'Open the desk from inside a Schoology course.' };
  if (!(claims[C.RL] && claims[C.RL].id)) return { ok: false, error: 'That launch did not say which link was opened.' };
  return { ok: true, claims };
}

const TEACHER_ROLE = /#(Instructor|Administrator|ContentDeveloper|TeachingAssistant|Mentor)$/;
const isTeacherRoles = (roles) => (Array.isArray(roles) ? roles : []).some((r) => TEACHER_ROLE.test(String(r)));

// ---------------- who, and which course, without keeping either ----------------

const hash = (...parts) => crypto.createHash('sha256').update(parts.map(String).join('\u0000')).digest('base64url');
/** The desk's own id for a Schoology person. Not reversible to their Schoology id. */
const uidFor = (iss, dep, sub) => 'lti_' + hash('person', iss, dep, sub).slice(0, 32);
const courseFor = (iss, dep, ctx) => 'ltc_' + hash('course', iss, dep, ctx).slice(0, 32);
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('base64url');

function openSession(cfg, claims) {
  const db = store.load();
  const token = crypto.randomBytes(32).toString('base64url');
  const dep = String(claims[C.DEP]);
  const ctx = claims[C.CTX] || {};
  db.ltiSessions[hashToken(token)] = {
    uid: uidFor(claims.iss, dep, claims.sub),
    course: courseFor(claims.iss, dep, ctx.id),
    teacher: isTeacherRoles(claims[C.ROLES]),
    // The course title, for the teacher's settings heading only. It is the
    // name of a class ("7th Grade Science"), not of a child.
    courseTitle: String(ctx.title || ctx.label || '').slice(0, 120),
    until: Date.now() + SESSION_TTL_MS,
  };
  store.save();
  return token;
}

function sessionFrom(req) {
  const t = req.get(HEADER);
  if (!t) return null;
  const s = store.load().ltiSessions[hashToken(t)];
  return s && s.until > Date.now() ? s : null;
}

// ---------------- which tools ----------------

/** Every tool an LTI desk could ever have: works with no account at all. */
const CAPABLE = tools.TOOLS.filter((t) => t.guest && !t.readsRoster && !t.permission && !NEEDS_ACCOUNT.has(t.type)).map((t) => t.type);

/** The school's ceiling: what the Student role gets, within CAPABLE. */
async function schoolAllows(cfg) {
  const roles = cfg.tenantId ? await policy.rolesFor(cfg.tenantId) : null;
  const student = policy.resolve(policy.STUDENT_ROLE, roles && roles[policy.STUDENT_ROLE]);
  return CAPABLE.filter((t) => student.has(t));
}

/** What a desk opened from this course gets: the school's list less the teacher's "off". */
function courseAllows(schoolList, course) {
  const c = store.load().ltiCourses[course];
  const off = new Set((c && c.off) || []);
  return new Set(schoolList.filter((t) => !off.has(t)));
}

// ---------------- retention ----------------

/** LTI desks nobody has opened in `days` go, with their history. */
function sweep(cfg, now = Date.now()) {
  const db = store.load();
  const cutoff = now - cfg.retentionDays * 864e5;
  let gone = 0;
  for (const [uid, b] of Object.entries(db.boards)) {
    if (!uid.startsWith('lti_')) continue;
    const seen = (db.users[uid] && db.users[uid].lastSeen) || b.updatedAt || 0;
    if (seen < cutoff) {
      delete db.boards[uid]; delete db.boardHistory[uid]; delete db.users[uid];
      gone += 1;
    }
  }
  if (gone) { store.save(); console.log(`desk lti: removed ${gone} Schoology desk(s) unopened for ${cfg.retentionDays} days`); }
  return gone;
}

// ---------------- routes ----------------

/**
 * Mounts the LTI routes. Returns two middlewares for server.js to put in the
 * chain: `identify` after signify.middleware (an LTI header wins over any
 * Signify cookie in the same browser), and `narrow` after policy.attach.
 */
function mount(app, { canonicalHost, indexFile }) {
  const cfg = config();
  const db = store.load();
  for (const k of ['ltiSessions', 'ltiCourses']) if (!db[k]) db[k] = {};

  const origin = (req) => process.env.LTI_ORIGIN || (canonicalHost ? `https://${canonicalHost}` : `${req.protocol}://${req.get('host')}`);
  const form = express.urlencoded({ extended: false, limit: '64kb' });

  // A page Schoology may show inside its own frame.
  const frameable = (res) => {
    res.removeHeader('X-Frame-Options');
    const csp = String(res.getHeader('Content-Security-Policy') || '')
      .replace("frame-ancestors 'none'", 'frame-ancestors ' + cfg.frameOrigins.join(' '));
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('Cache-Control', 'no-store');
  };
  const problem = (res, code, msg) => {
    frameable(res);
    res.status(code).type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Teacher’s Desk</title><body style="font:16px system-ui,sans-serif;background:#f1effa;margin:0;padding:40px 16px">
<div style="max-width:520px;margin:auto;background:#fff;border-radius:20px;padding:24px 28px;box-shadow:0 6px 24px rgba(0,0,0,.08)">
<h1 style="font-size:20px;margin:0 0 8px">Teacher’s Desk</h1><p style="margin:0;color:#333">${String(msg).replace(/</g, '&lt;')}</p></div>`);
  };

  app.get('/lti/jwks', (req, res) => res.json({ keys: [key().jwk] }));
  app.get('/.well-known/jwks.json', (req, res) => res.json({ keys: [key().jwk] }));

  // Step 1: Schoology starts the login.
  const login = (req, res) => {
    const p = Object.assign({}, req.query, req.body || {});
    if (!cfg.clientId) return problem(res, 503, 'Teacher’s Desk is not connected to Schoology yet.');
    if (p.iss !== cfg.issuer || !p.login_hint) return problem(res, 400, 'This launch came from a platform Teacher’s Desk does not know.');
    if (p.client_id && p.client_id !== cfg.clientId) return problem(res, 400, 'This launch was meant for a different tool.');
    if (p.target_link_uri) {
      try { if (new URL(p.target_link_uri).origin !== origin(req)) return problem(res, 400, 'This link points somewhere other than Teacher’s Desk.'); }
      catch { return problem(res, 400, 'This link is not readable.'); }
    }
    prune();
    const state = crypto.randomBytes(24).toString('base64url');
    const nonce = crypto.randomBytes(24).toString('base64url');
    states.set(state, { nonce, until: Date.now() + STATE_TTL_MS });
    const u = new URL(cfg.authUrl);
    const q = {
      scope: 'openid', response_type: 'id_token', response_mode: 'form_post', prompt: 'none',
      client_id: cfg.clientId, redirect_uri: `${origin(req)}/lti/launch`,
      login_hint: p.login_hint, state, nonce,
    };
    if (p.lti_message_hint) q.lti_message_hint = p.lti_message_hint;
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, u.toString());
  };
  app.get('/lti/login', login);
  app.post('/lti/login', form, login);

  // Step 2: the signed launch.
  app.post('/lti/launch', form, async (req, res) => {
    if (!cfg.clientId) return problem(res, 503, 'Teacher’s Desk is not connected to Schoology yet.');
    if (req.body && req.body.error) return problem(res, 400, 'Schoology could not open the desk: ' + String(req.body.error_description || req.body.error).slice(0, 200));
    const out = await checkLaunch(cfg, req.body && req.body.id_token, req.body && req.body.state);
    if (!out.ok) return problem(res, 400, out.error);
    const token = openSession(cfg, out.claims);
    frameable(res);
    // The token goes in the fragment: never sent to a server, never in a Referer.
    res.redirect(303, '/lti/app#t=' + token);
  });

  // The small framed page.
  app.get('/lti/app', (req, res) => {
    frameable(res);
    res.type('html').send(LAUNCH_PAGE);
  });

  // The desk itself, top-level in its own window, in LTI mode: no Signify
  // sign-in, no app switcher.
  let shell = null;
  app.get('/lti/desk', (req, res) => {
    if (!shell) {
      shell = fs.readFileSync(indexFile, 'utf8')
        .replace(/<script src="\/js\/util\.js/, '<script src="/js/lti-boot.js?v=1"></script>\n$&')
        .replace(/\s*<script src="\/vendor\/signify-switcher\.js"[^>]*><\/script>/, '');
    }
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(shell);
  });

  // ---------- what the framed page calls ----------
  const api = express.Router();
  api.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const s = sessionFrom(req);
    if (!s) return res.status(401).json({ error: 'This session has ended. Open the desk again from Schoology.' });
    req.lti = s;
    next();
  });

  api.get('/state', async (req, res) => {
    const s = req.lti;
    const out = { role: s.teacher ? 'teacher' : 'student', deskUrl: `${origin(req)}/` };
    if (s.teacher) {
      const school = await schoolAllows(cfg).catch(() => []);
      const on = courseAllows(school, s.course);
      out.courseTitle = s.courseTitle;
      out.schoolSet = !!cfg.tenantId;
      out.tools = school.map((t) => {
        const d = tools.BY_TYPE.get(t);
        return { type: t, name: d.name, blurb: d.blurb, category: d.category, on: on.has(t) };
      }).sort((a, b) => a.name.localeCompare(b.name));
    }
    res.json(out);
  });

  api.put('/course', async (req, res) => {
    const s = req.lti;
    if (!s.teacher) return res.status(403).json({ error: 'Only a teacher can do that.' });
    const school = await schoolAllows(cfg).catch(() => null);
    if (!school) return res.status(503).json({ error: 'Could not check the school’s tools. Try again.' });
    const want = new Set(Array.isArray(req.body && req.body.on) ? req.body.on.map(String) : []);
    const dbx = store.load();
    dbx.ltiCourses[s.course] = { off: school.filter((t) => !want.has(t)), updatedAt: Date.now() };
    store.save();
    res.json({ on: school.filter((t) => want.has(t)) });
  });

  app.use('/lti/api', express.json({ limit: '16kb' }), api);

  // ---------- the desk's own API, for an LTI desk ----------

  // After signify.middleware: a valid header turns this request into the
  // Schoology person's desk, whatever Signify cookie the browser carries.
  const identify = (req, res, next) => {
    if (!req.get(HEADER) || !req.path.startsWith('/api/')) return next();
    const s = sessionFrom(req);
    if (!s) return res.status(401).json({ error: 'This session has ended. Open the desk again from Schoology.', lti: true });
    const line = `${req.method} ${req.path}`;
    if (!API_ALLOWED.some((re) => re.test(line))) {
      return res.status(403).json({ error: 'That is not part of a desk opened from Schoology.' });
    }
    req.lti = s;
    req.signifyExpired = false;
    req.signifyToken = null;
    req.user = {
      id: s.uid, email: '', name: s.teacher ? 'Student desk preview' : 'My desk', picture: '',
      role: policy.STUDENT_ROLE, roleLabel: 'Student', isSuper: false, isMinor: true,
      tenantId: null, tenantName: null, perms: {}, sessionId: null, lti: true,
    };
    // A first visit gets an empty desk, not the teacher's starter tools.
    const dbx = store.load();
    if (!dbx.boards[s.uid]) {
      dbx.boards[s.uid] = { uid: s.uid, rev: 1, items: [], prefs: null, updatedAt: Date.now() };
      store.save();
    }
    next();
  };

  // After policy.attach: the tools are the course's list, full stop.
  const narrow = async (req, res, next) => {
    if (!req.lti) return next();
    try {
      req.deskTools = courseAllows(await schoolAllows(cfg), req.lti.course);
    } catch {
      req.deskTools = new Set();
    }
    next();
  };

  sweep(cfg);
  setInterval(() => { prune(); sweep(cfg); }, 6 * 60 * 60 * 1000).unref();
  return { cfg, identify, narrow };
}

// The framed page. Script is external (CSP: script-src 'self').
const LAUNCH_PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Teacher’s Desk</title>
<link rel="stylesheet" href="/lti/launch.css?v=1">
</head><body>
<main id="lti" class="lti" aria-live="polite"><p class="lti-wait">Opening…</p></main>
<script src="/lti/launch.js?v=1"></script>
</body></html>`;

module.exports = {
  mount, config, checkLaunch, sweep, SCHOOLOGY, CAPABLE, HEADER,
  _schoolAllows: schoolAllows,
  _uidFor: uidFor, _courseFor: courseFor,
  _setFetch: (f) => { fetchImpl = f; jwksCache.clear(); },
};
