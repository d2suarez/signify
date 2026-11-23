// ===================================================================
// Teacher's Desk — server
//
// Serves the board and a small API. Identity, roles and the class lists all
// come from Signify ID; what lives here is the desk itself — which widgets a
// teacher has, where they sit, and the handful of things they hold.
// ===================================================================

const path = require('path');
const express = require('express');
const compression = require('compression');

const store = require('./server/store');
const signify = require('./signify-auth');
const auth = require('./server/auth');
const board = require('./server/board');
const roster = require('./server/roster');
const behaviour = require('./server/behaviour');
const groups = require('./server/groups');
const templates = require('./server/templates');
const assets = require('./server/assets');
const video = require('./server/video');
const bible = require('./server/bible');
const inventory = require('./server/inventory');
const weather = require('./server/weather');
const visitors = require('./server/visitors');
const tools = require('./server/tools');
const policy = require('./server/policy');
const learning = require('./server/learning');
const embed = require('./server/embed');
const createBackups = require('./server/backup');
const lti = require('./server/lti');

const PORT = process.env.PORT || 8770;
const CANONICAL_HOST = process.env.CANONICAL_HOST || '';

store.load();

// Daily backups of the whole data directory, mirrored to R2 once the four
// R2_* variables are set (see server/backup.js). Kept for BACKUP_DAYS by AGE,
// not by count: behaviour notes carry a deletion date the page promises, and
// a backup must not quietly outlive it by more than this. Seven days means a
// note is gone from every copy about a week after it is deleted here.
const BACKUP_DAYS = Math.max(1, Math.min(90, Number(process.env.BACKUP_DAYS) || 7));
const backups = createBackups({
  dataDir: store.DATA_DIR,
  prefix: 'desk/',
  keep: BACKUP_DAYS,
  maxAgeDays: BACKUP_DAYS,
});

// The Signify help desk, for the ticket box widget. Its own origin, never a
// path: the browser talks to it directly, so CSP has to name it.
const HELPDESK_ORIGIN = (() => {
  const raw = process.env.HELPDESK_URL || (process.env.RAILWAY_ENVIRONMENT ? 'https://help.signify.one' : 'http://localhost:3110');
  try { return new URL(raw).origin; } catch { return 'https://help.signify.one'; }
})();

const app = express();
app.disable('x-powered-by');
app.use(compression());
app.use(express.json({ limit: '512kb' }));

// Google only accepts OAuth origins on an authorised domain, so sign-in works
// on desk.signify.one and not on the *.up.railway.app host. Send everything
// to the real one — except the health check, which Railway probes by IP.
app.use((req, res, next) => {
  const proto = req.headers['x-forwarded-proto'];
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (CANONICAL_HOST && proto && host && host !== CANONICAL_HOST && req.path !== '/healthz') {
    return res.redirect(301, `https://${CANONICAL_HOST}${req.originalUrl}`);
  }
  next();
});

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    // blob: is for things this page makes itself — the QR code it rasterises
    // for download. A blob URL can only ever point at data this document
    // created, so it grants no reach anywhere new.
    "img-src 'self' data: blob: https://lh3.googleusercontent.com",
    "font-src 'self'",
    // The help desk box sends requests to the help desk itself, a sibling on
    // the same site, with that app's own sign-in cookie.
    `connect-src 'self' blob: ${HELPDESK_ORIGIN}`,
    // The converter's iPhone-photo (HEIC) decoder runs in a worker it builds
    // from a blob of its own code, and pdf.js runs its worker from /vendor.
    // Same reasoning as img-src: a blob URL can only hold what this page made.
    "worker-src 'self' blob:",
    // The only things allowed to be framed on this desk: a sibling app that
    // permits it, Google's calendar embed, and YouTube's no-cookie player —
    // the last of which is not put on the page at all until somebody presses
    // play, so an idle board contacts none of them.
    // Each one is a music or document embed the teacher has to ask for by
    // pasting a link, and none of them is loaded until Play is pressed.
    "frame-src https://maps.signify.one https://calendar.google.com https://www.youtube-nocookie.com https://docs.google.com https://open.spotify.com https://embed.music.apple.com https://w.soundcloud.com",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '));
  next();
});

// /auth/login, /auth/callback, /auth/logout, /auth/me — and req.user after.
// The permission list travels with the app, so adding one is a change here
// rather than in the identity service.
signify.mount(app, {
  permissions: auth.PERMISSIONS,
  postLogoutUri: CANONICAL_HOST ? `https://${CANONICAL_HOST}/` : undefined,
});
app.use(signify.middleware);
// The tools, so a school can choose which roles get which (Signify ID, Tools
// by role). Students get only the ones marked `students: true`.
policy.declare().catch(() => {});

/**
 * Carries a just-renewed ID token forward within the same request.
 *
 * signify-auth renews an expired ID token during its middleware and puts the
 * new one in a Set-Cookie on the response. The request's own cookie header is
 * never rewritten, so anything later in the chain that reads it — the roster
 * lookups in server/roster.js — would be holding an expired token and get a
 * 401 from Signify ID. That showed up as a teacher's classes vanishing from
 * every picker on the first load after each expiry.
 */
app.use((req, res, next) => {
  const set = res.getHeader('Set-Cookie');
  for (const line of [].concat(set || [])) {
    const m = /^sfy_id=([^;]*)/.exec(String(line));
    if (m) { req.signifyToken = decodeURIComponent(m[1]); break; }
  }
  next();
});

// Schoology (LTI 1.3): its routes, and a desk opened from it. A request that
// carries an LTI session header is that Schoology person's desk, whatever
// Signify cookie the browser also has (server/lti.js).
const ltiTool = lti.mount(app, { canonicalHost: CANONICAL_HOST, indexFile: path.join(__dirname, 'public', 'index.html') });
app.use(ltiTool.identify);

// Learning's rail frame, signed in automatically (server/embed.js): a cookie
// that counts only on requests the /embed page makes, when there is no desk
// sign-in of its own.
app.use(embed.identify);

// Signify Learning's server, asking for a teacher's seating plan with the
// token it holds for them (server/learning.js). Before the tool policy, which
// reads req.user.
app.use('/api/learning', learning.bearer);

app.use(auth.devMiddleware);

// Which tools this person may have (server/policy.js): their school's Tools
// by role setting in Signify ID, or its defaults. Every /api route after this
// can read req.deskTools.
app.use('/api', policy.attach({ canBehaviour: (req) => auth.can(req, 'desk:behaviour', 'class') }));
app.use('/api', ltiTool.narrow);

const ok = (res, data) => res.json(data);

/**
 * For the few lookups a signed-out visitor may make. A signed-in caller is
 * held to the usual desk permission; a signed-out one to an allowance per
 * address (server/visitors.js), so the desk is not a free relay to other
 * people's services.
 */
function deskOrVisitor(req, res, bucket) {
  if (auth.userFromReq(req)) return !!auth.requireDesk(req, res);
  return visitors.allow(req, res, bucket);
}
const bad = (res, code, msg) => res.status(code).json({ error: msg });
/**
 * Ends this desk's own sign-in when Signify ID has stopped recognising it.
 *
 * The two can disagree: signify-auth only checks that the ID token is signed
 * and unexpired, so a session that has been revoked or has lapsed at the
 * identity service still looks perfectly good here. The teacher stays "signed
 * in" to a desk that cannot fetch a single class list — which is exactly the
 * state they got out of by signing out and back in. So do that for them, and
 * answer 401 so the page reloads into the sign-in.
 */
function endStaleSession(req, res) {
  if (!req.signifyExpired) return false;
  for (const name of ['sfy_id', 'sfy_rt']) {
    res.clearCookie(name, { path: '/', httpOnly: true, sameSite: 'lax', secure: !!process.env.RAILWAY_ENVIRONMENT });
  }
  res.status(401).json({ error: 'That sign-in has ended. Signing you back in\u2026', signedOut: true });
  return true;
}

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error(`desk: ${req.method} ${req.path} —`, e.message);
  if (!res.headersSent) bad(res, 500, 'Something went wrong on our side.');
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---------------- who am I ----------------

app.get('/api/config', (req, res) => ok(res, {
  authEnabled: auth.ENABLED,
  lti: !!req.lti,
  devUser: auth.DEV,
  signInUrl: '/auth/login',
  signOutUrl: '/auth/logout',
  identityUrl: signify.ISSUER || '',
  helpDeskUrl: HELPDESK_ORIGIN,
  behaviourRetentionDays: behaviour.RETENTION_DAYS,
  backupDays: BACKUP_DAYS,
  columns: board.COLUMNS,
}));

app.get('/api/me', (req, res) => {
  const u = auth.userFromReq(req);
  if (!u) return bad(res, 401, 'Not signed in.');
  ok(res, {
    user: {
      name: u.name, email: u.email, picture: u.picture,
      role: u.roleLabel || u.role, school: u.tenantName, isSuper: u.isSuper,
      lti: !!req.lti,
      can: {
        desk: auth.canOpen(req),
        behaviour: auth.can(req, 'desk:behaviour', 'class'),
        // Any tool that reads class lists, so the bar's Class lists button
        // is not offered to somebody with none.
        classLists: tools.ROSTER_TOOLS.some((t) => req.deskTools && req.deskTools.has(t)),
      },
      // The tool types this person may have; the catalogue and board show no
      // others.
      tools: [...(req.deskTools || [])],
    },
  });
});

// ---------------- the board ----------------

app.get('/api/board', (req, res) => {
  const u = auth.requireDesk(req, res); if (!u) return;
  ok(res, board.visibleTo(board.boardFor(u, req.deskTools), req.deskTools));
});

app.put('/api/board', (req, res) => {
  const u = auth.requireDesk(req, res); if (!u) return;
  const result = board.saveBoard(u, req.body || {}, req.deskTools);
  if (result.tooBig) return bad(res, 413, 'This desk is holding too much to save. Try shortening a note.');
  if (result.conflict) {
    // Logged because a conflict makes the browser reload, and a reload throws
    // away whatever had not been saved. Two tabs quietly fighting looks
    // exactly like work disappearing on its own, and nothing recorded it.
    console.warn(`desk: board ${u.uid} save refused — sent rev ${req.body && req.body.rev}, current ${result.board.rev}`);
    return res.status(409).json({ error: 'This desk was changed somewhere else.', board: board.visibleTo(result.board, req.deskTools) });
  }
  ok(res, result);
});

app.get('/api/board/history', (req, res) => {
  const u = auth.requireDesk(req, res); if (!u) return;
  ok(res, { versions: board.listHistory(u) });
});

app.post('/api/board/history/:rev/restore', (req, res) => {
  const u = auth.requireDesk(req, res); if (!u) return;
  const result = board.restoreHistory(u, req.params.rev);
  if (!result) return bad(res, 404, 'There is no kept version with that number.');
  ok(res, result);
});

app.post('/api/board/reset', (req, res) => {
  const u = auth.requireDesk(req, res); if (!u) return;
  // A desk opened from Schoology starts blank, and resets to blank.
  ok(res, board.visibleTo(board.resetBoard(u, req.deskTools, { blank: !!req.lti }), req.deskTools));
});

// ---------------- class lists ----------------

app.get('/api/classes', wrap(async (req, res) => {
  const u = auth.requireTool(req, res, tools.ROSTER_TOOLS); if (!u) return;
  // Carries signifyOk, so the browser can say "could not load your classes"
  // rather than "you have none" when the lookup was refused.
  const result = await roster.classesFor(req, u);
  if (endStaleSession(req, res)) return;
  ok(res, result);
}));

app.get('/api/classes/:key/members', wrap(async (req, res) => {
  const u = auth.requireTool(req, res, tools.ROSTER_TOOLS); if (!u) return;
  const result = await roster.membersOf(req, u, req.params.key);
  if (endStaleSession(req, res)) return;
  if (!result) return bad(res, 404, 'That class list is not available.');
  ok(res, result);
}));

app.post('/api/lists', (req, res) => {
  const u = auth.requireTool(req, res, tools.ROSTER_TOOLS); if (!u) return;
  try { ok(res, roster.createList(u, req.body && req.body.name, req.body && req.body.students)); }
  catch (e) { bad(res, 400, e.message); }
});

app.put('/api/lists/:id', (req, res) => {
  const u = auth.requireTool(req, res, tools.ROSTER_TOOLS); if (!u) return;
  const list = roster.updateList(u, req.params.id, req.body || {});
  if (!list) return bad(res, 404, 'That list is not yours.');
  ok(res, list);
});

app.delete('/api/lists/:id', (req, res) => {
  const u = auth.requireTool(req, res, tools.ROSTER_TOOLS); if (!u) return;
  if (!roster.deleteList(u, req.params.id)) return bad(res, 404, 'That list is not yours.');
  ok(res, { deleted: true });
});

// ---------------- behaviour ----------------
// Every route here is scoped to the signed-in teacher inside behaviour.js.
// There is no route that reads somebody else's notes, on purpose.

app.get('/api/behaviour/reasons', (req, res) => {
  const u = auth.requireBehaviour(req, res); if (!u) return;
  ok(res, { reasons: behaviour.reasonsFor(u.uid) });
});

app.put('/api/behaviour/reasons', (req, res) => {
  const u = auth.requireBehaviour(req, res); if (!u) return;
  ok(res, { reasons: behaviour.setReasons(u.uid, req.body && req.body.reasons) });
});

app.get('/api/behaviour', (req, res) => {
  const u = auth.requireBehaviour(req, res); if (!u) return;
  const key = String(req.query.classKey || '');
  if (!key) return bad(res, 400, 'Which class?');
  ok(res, { ...behaviour.forClass(u, key, req.query.since), backupDays: BACKUP_DAYS });
});

app.post('/api/behaviour', (req, res) => {
  const u = auth.requireBehaviour(req, res); if (!u) return;
  try { ok(res, behaviour.record(u, req.body || {})); }
  catch (e) { bad(res, 400, e.message); }
});

app.delete('/api/behaviour/:id', (req, res) => {
  const u = auth.requireBehaviour(req, res); if (!u) return;
  if (!behaviour.remove(u, req.params.id)) return bad(res, 404, 'That note is not yours.');
  ok(res, { deleted: true });
});

// ---------------- saved groupings ----------------

app.get('/api/groupings', (req, res) => {
  const u = auth.requireTool(req, res, ['groups', 'scoreboard']); if (!u) return;
  ok(res, { groupings: groups.listFor(u, req.query.classKey ? String(req.query.classKey) : '') });
});

app.post('/api/groupings', (req, res) => {
  const u = auth.requireTool(req, res, 'groups'); if (!u) return;
  try { ok(res, groups.create(u, req.body || {})); }
  catch (e) { bad(res, 400, e.message); }
});

app.delete('/api/groupings/:id', (req, res) => {
  const u = auth.requireTool(req, res, 'groups'); if (!u) return;
  if (!groups.remove(u, req.params.id)) return bad(res, 404, 'That grouping is not yours.');
  ok(res, { deleted: true });
});

// ---------------- seating plans, for Signify Learning ----------------
// A lesson slide shows the teacher's own plan for the class and moves a seat
// back here (server/learning.js). Only Learning's server, for a teacher of
// that class, per Signify ID.
app.get('/api/learning/seating/:classId', wrap(learning.getSeating));
app.put('/api/learning/seating/:classId', wrap(learning.putSeating));
// The rail frame's ticket (server/embed.js): Learning's server asks, the frame trades it.
app.post('/api/learning/embed-ticket', wrap(embed.mintTicket));
app.post('/embed/session', express.json({ limit: '2kb' }), embed.redeem);

// ---------------- room templates ----------------
// Furniture without pupils, so a teacher sets their room up once and seats
// every class in it.

app.get('/api/templates', (req, res) => {
  const u = auth.requireTool(req, res, 'seating'); if (!u) return;
  ok(res, { templates: templates.listFor(u) });
});

app.post('/api/templates', (req, res) => {
  const u = auth.requireTool(req, res, 'seating'); if (!u) return;
  try { ok(res, templates.create(u, req.body || {})); }
  catch (e) { bad(res, 400, e.message); }
});

app.put('/api/templates/:id', (req, res) => {
  const u = auth.requireTool(req, res, 'seating'); if (!u) return;
  const row = templates.rename(u, req.params.id, req.body && req.body.name);
  if (!row) return bad(res, 404, 'That room is not yours.');
  ok(res, row);
});

app.delete('/api/templates/:id', (req, res) => {
  const u = auth.requireTool(req, res, 'seating'); if (!u) return;
  if (!templates.remove(u, req.params.id)) return bad(res, 404, 'That room is not yours.');
  ok(res, { deleted: true });
});

// ---------------- help desk ----------------
// The help desk box asks through the desk, which vouches for the teacher with
// the Signify ID token it already holds. The help desk's own sign-in cookie
// lives on help.signify.one and ends with each day's Signify ID session, so
// asking the browser to carry it meant "Connect" again every morning.
// (A desk with no token of its own — opened from Schoology — answers
// noVouch, and the box falls back to asking the help desk directly.)
const HELPDESK_PATHS = new Set(['me', 'tickets']);
app.all('/api/helpdesk/:what', wrap(async (req, res) => {
  if (!HELPDESK_PATHS.has(req.params.what)) return bad(res, 404, 'Not found.');
  if (!['GET', 'POST'].includes(req.method)) return bad(res, 405, 'Not allowed.');
  const u = auth.requireTool(req, res, 'helpdesk'); if (!u) return;
  if (!req.signifyToken || req.lti) return res.status(401).json({ error: 'Not signed in here.', noVouch: true });
  let upstream;
  try {
    upstream = await fetch(`${HELPDESK_ORIGIN}/api/desk/${req.params.what}`, {
      method: req.method,
      headers: {
        authorization: `Bearer ${req.signifyToken}`,
        ...(req.method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      body: req.method === 'POST' ? JSON.stringify(req.body || {}) : undefined,
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    console.error('desk: help desk unreachable —', e.message);
    return bad(res, 502, 'The help desk could not be reached.');
  }
  const data = await upstream.json().catch(() => ({}));
  if (upstream.status === 401) console.warn('desk: help desk refused the desk\'s token (401)');
  res.set('Cache-Control', 'no-store');
  res.status(upstream.status).json(upstream.status === 401 ? { ...data, noVouch: true } : data);
}));

// ---------------- weather ----------------
// Proxied so the browsers never talk to a third party; see server/weather.js.

app.get('/api/weather/search', wrap(async (req, res) => {
  if (!deskOrVisitor(req, res, 'weather')) return;
  try { ok(res, { places: await weather.search(req.query.q) }); }
  catch (e) { bad(res, 502, 'Could not look that place up just now.'); }
}));

app.get('/api/weather', wrap(async (req, res) => {
  if (!deskOrVisitor(req, res, 'weather')) return;
  try { ok(res, await weather.forecast(req.query.lat, req.query.lon, req.query.units)); }
  catch (e) { bad(res, 502, 'Could not get the forecast just now.'); }
}));

app.get('/api/video/:id', wrap(async (req, res) => {
  if (!deskOrVisitor(req, res, 'video')) return;
  const found = await video.titleFor(req.params.id);
  // 200 with nothing rather than 404: "YouTube would not tell us" is an
  // ordinary answer here, not an error the widget should show anybody.
  ok(res, found || {});
}));

// ---------------- Bible ----------------
// Signed-in only: the ESV and API.Bible keys are the teacher's own, so the
// desk is not a free relay for visitors. See server/bible.js.

app.get('/api/bible/versions', wrap(async (req, res) => {
  if (!auth.requireTool(req, res, 'bible')) return;
  ok(res, await bible.versions());
}));

app.get('/api/bible/passage', wrap(async (req, res) => {
  if (!auth.requireTool(req, res, 'bible')) return;
  try { ok(res, await bible.passage(req.query.v, req.query.r)); }
  catch (e) {
    if (!(e instanceof bible.BibleError)) throw e;
    bad(res, e.status, e.message);
  }
}));

// ---------------- uploads ----------------
// Sounds for the soundboard, a picture behind the board. server/assets.js is
// where the care lives — type is sniffed from the bytes, never trusted from
// the request.

app.get('/api/assets', (req, res) => {
  const u = auth.requireDesk(req, res); if (!u) return;
  ok(res, { assets: assets.listFor(u, req.query.kind ? String(req.query.kind) : ''), usage: assets.usage(u) });
});

// Raw body rather than multipart: one file, one request, no parser to get
// wrong. The name rides along in a header.
app.post('/api/assets', express.raw({ type: '*/*', limit: assets.MAX_BYTES + 1024 }), (req, res) => {
  const u = auth.requireDesk(req, res); if (!u) return;
  try {
    ok(res, assets.save(u, req.body, decodeURIComponent(String(req.get('x-file-name') || 'Untitled'))));
  } catch (e) { bad(res, 400, e.message); }
});

app.get('/api/assets/:id', (req, res) => {
  const u = auth.requireDesk(req, res); if (!u) return;
  const row = assets.get(u, req.params.id);
  if (!row) return bad(res, 404, 'That file is not yours.');
  res.set({
    'Content-Type': row.type,
    'Content-Length': String(row.bytes),
    'X-Content-Type-Options': 'nosniff',
    // Uploaded bytes are never a page on this origin, whatever they contain.
    'Content-Disposition': 'attachment',
    'Cache-Control': 'private, max-age=31536000, immutable',
  });
  require('fs').createReadStream(row.path).on('error', () => res.end()).pipe(res);
});

app.put('/api/assets/:id', (req, res) => {
  const u = auth.requireDesk(req, res); if (!u) return;
  const row = assets.rename(u, req.params.id, req.body && req.body.label);
  if (!row) return bad(res, 404, 'That file is not yours.');
  ok(res, row);
});

app.delete('/api/assets/:id', (req, res) => {
  const u = auth.requireDesk(req, res); if (!u) return;
  if (!assets.remove(u, req.params.id)) return bad(res, 404, 'That file is not yours.');
  ok(res, { deleted: true });
});

// What this app holds about pupils. Deliberately open: an administrator
// asking the question should not need an account to read the answer.
app.get('/what-is-held', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.type('html').send(inventory.page({ host: CANONICAL_HOST || req.get('host') }));
});

// ---------------- framed by another Signify app ----------------

// Signify Learning's left rail frames /embed: the person's own desk cards,
// with their own desk sign-in (a sibling on signify.one, so the cookie
// comes). Only these origins may frame it; everything else stays
// frame-ancestors 'none'. EMBED_FRAME_ORIGINS (space separated) overrides.
const EMBED_ORIGINS = (process.env.EMBED_FRAME_ORIGINS
  || (process.env.RAILWAY_ENVIRONMENT ? 'https://learn.signify.one'
    : 'https://learn.signify.one http://localhost:3120 http://localhost:3121 http://localhost:3127'))
  .split(/[\s,]+/).filter((o) => /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o));
let embedPage = null;
app.get('/embed', (req, res) => {
  if (!embedPage) {
    embedPage = require('fs').readFileSync(path.join(__dirname, 'public', 'embed.html'), 'utf8')
      .replace('__EMBED_ORIGINS__', EMBED_ORIGINS.join(' '));
  }
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', String(res.getHeader('Content-Security-Policy'))
    .replace("frame-ancestors 'none'", `frame-ancestors ${EMBED_ORIGINS.join(' ') || "'none'"}`));
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(embedPage);
});

// ---------------- static ----------------

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (/\.woff2$/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    else if (/\.html$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  },
}));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return bad(res, 404, 'Not found.');
  // Anything that looks like a file is a genuine miss. Handing back the page
  // shell for a missing .js means a stale tab gets HTML where it expected
  // a script, and fails with a syntax error rather than an honest 404.
  if (/\.[a-z0-9]{2,5}$/i.test(req.path)) return res.status(404).type('txt').send('Not found');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------- boot ----------------

behaviour.startSweeping();
backups.start();

const server = app.listen(PORT, () => {
  console.log(`Teacher's Desk on http://localhost:${PORT}`);
  console.log(`  sign-in:   ${auth.ENABLED ? signify.ISSUER : auth.DEV ? 'development user' : 'NOT CONFIGURED'}`);
  console.log(`  store:     ${store.FILE}`);
  console.log(`  retention: behaviour notes for ${behaviour.RETENTION_DAYS} days`);
  console.log(`  backups:   daily, kept ${BACKUP_DAYS} days${require('./server/offsite').enabled() ? ', mirrored to R2' : ' on the volume only (R2 not configured)'}`);
});

function shutdown(signal) {
  console.log(`\n${signal} — flushing the store.`);
  store.flushSync();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
