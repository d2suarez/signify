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
const weather = require('./server/weather');

const PORT = process.env.PORT || 8770;
const CANONICAL_HOST = process.env.CANONICAL_HOST || '';

store.load();

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
    "connect-src 'self' blob:",
    // The only things allowed to be framed on this desk: a sibling app that
    // permits it, Google's calendar embed, and YouTube's no-cookie player —
    // the last of which is not put on the page at all until somebody presses
    // play, so an idle board contacts none of them.
    "frame-src https://maps.signify.one https://calendar.google.com https://www.youtube-nocookie.com",
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

app.use(auth.devMiddleware);

const ok = (res, data) => res.json(data);
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
  devUser: auth.DEV,
  signInUrl: '/auth/login',
  signOutUrl: '/auth/logout',
  identityUrl: signify.ISSUER || '',
  behaviourRetentionDays: behaviour.RETENTION_DAYS,
  columns: board.COLUMNS,
}));

app.get('/api/me', (req, res) => {
  const u = auth.userFromReq(req);
  if (!u) return bad(res, 401, 'Not signed in.');
  ok(res, {
    user: {
      name: u.name, email: u.email, picture: u.picture,
      role: u.roleLabel || u.role, school: u.tenantName, isSuper: u.isSuper,
      can: {
        desk: auth.can(req, 'desk:use', 'own'),
        behaviour: auth.can(req, 'desk:behaviour', 'class'),
      },
    },
  });
});

// ---------------- the board ----------------

app.get('/api/board', (req, res) => {
  const u = auth.requireDesk(req, res); if (!u) return;
  ok(res, board.boardFor(u));
});

app.put('/api/board', (req, res) => {
  const u = auth.requireDesk(req, res); if (!u) return;
  const result = board.saveBoard(u, req.body || {});
  if (result.tooBig) return bad(res, 413, 'This desk is holding too much to save. Try shortening a note.');
  if (result.conflict) return res.status(409).json({ error: 'This desk was changed somewhere else.', board: result.board });
  ok(res, result);
});

app.post('/api/board/reset', (req, res) => {
  const u = auth.requireDesk(req, res); if (!u) return;
  ok(res, board.resetBoard(u));
});

// ---------------- class lists ----------------

app.get('/api/classes', wrap(async (req, res) => {
  const u = auth.requireDesk(req, res); if (!u) return;
  // Carries signifyOk, so the browser can say "could not load your classes"
  // rather than "you have none" when the lookup was refused.
  const result = await roster.classesFor(req, u);
  if (endStaleSession(req, res)) return;
  ok(res, result);
}));

app.get('/api/classes/:key/members', wrap(async (req, res) => {
  const u = auth.requireDesk(req, res); if (!u) return;
  const result = await roster.membersOf(req, u, req.params.key);
  if (endStaleSession(req, res)) return;
  if (!result) return bad(res, 404, 'That class list is not available.');
  ok(res, result);
}));

app.post('/api/lists', (req, res) => {
  const u = auth.requireDesk(req, res); if (!u) return;
  try { ok(res, roster.createList(u, req.body && req.body.name, req.body && req.body.students)); }
  catch (e) { bad(res, 400, e.message); }
});

app.put('/api/lists/:id', (req, res) => {
  const u = auth.requireDesk(req, res); if (!u) return;
  const list = roster.updateList(u, req.params.id, req.body || {});
  if (!list) return bad(res, 404, 'That list is not yours.');
  ok(res, list);
});

app.delete('/api/lists/:id', (req, res) => {
  const u = auth.requireDesk(req, res); if (!u) return;
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
  ok(res, behaviour.forClass(u, key, req.query.since));
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
  const u = auth.requireDesk(req, res); if (!u) return;
  ok(res, { groupings: groups.listFor(u, req.query.classKey ? String(req.query.classKey) : '') });
});

app.post('/api/groupings', (req, res) => {
  const u = auth.requireDesk(req, res); if (!u) return;
  try { ok(res, groups.create(u, req.body || {})); }
  catch (e) { bad(res, 400, e.message); }
});

app.delete('/api/groupings/:id', (req, res) => {
  const u = auth.requireDesk(req, res); if (!u) return;
  if (!groups.remove(u, req.params.id)) return bad(res, 404, 'That grouping is not yours.');
  ok(res, { deleted: true });
});

// ---------------- room templates ----------------
// Furniture without pupils, so a teacher sets their room up once and seats
// every class in it.

app.get('/api/templates', (req, res) => {
  const u = auth.requireDesk(req, res); if (!u) return;
  ok(res, { templates: templates.listFor(u) });
});

app.post('/api/templates', (req, res) => {
  const u = auth.requireDesk(req, res); if (!u) return;
  try { ok(res, templates.create(u, req.body || {})); }
  catch (e) { bad(res, 400, e.message); }
});

app.put('/api/templates/:id', (req, res) => {
  const u = auth.requireDesk(req, res); if (!u) return;
  const row = templates.rename(u, req.params.id, req.body && req.body.name);
  if (!row) return bad(res, 404, 'That room is not yours.');
  ok(res, row);
});

app.delete('/api/templates/:id', (req, res) => {
  const u = auth.requireDesk(req, res); if (!u) return;
  if (!templates.remove(u, req.params.id)) return bad(res, 404, 'That room is not yours.');
  ok(res, { deleted: true });
});

// ---------------- weather ----------------
// Proxied so the browsers never talk to a third party; see server/weather.js.

app.get('/api/weather/search', wrap(async (req, res) => {
  const u = auth.requireDesk(req, res); if (!u) return;
  try { ok(res, { places: await weather.search(req.query.q) }); }
  catch (e) { bad(res, 502, 'Could not look that place up just now.'); }
}));

app.get('/api/weather', wrap(async (req, res) => {
  const u = auth.requireDesk(req, res); if (!u) return;
  try { ok(res, await weather.forecast(req.query.lat, req.query.lon, req.query.units)); }
  catch (e) { bad(res, 502, 'Could not get the forecast just now.'); }
}));

app.get('/api/video/:id', wrap(async (req, res) => {
  const u = auth.requireDesk(req, res); if (!u) return;
  const found = await video.titleFor(req.params.id);
  // 200 with nothing rather than 404: "YouTube would not tell us" is an
  // ordinary answer here, not an error the widget should show anybody.
  ok(res, found || {});
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

const server = app.listen(PORT, () => {
  console.log(`Teacher's Desk on http://localhost:${PORT}`);
  console.log(`  sign-in:   ${auth.ENABLED ? signify.ISSUER : auth.DEV ? 'development user' : 'NOT CONFIGURED'}`);
  console.log(`  store:     ${store.FILE}`);
  console.log(`  retention: behaviour notes for ${behaviour.RETENTION_DAYS} days`);
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
