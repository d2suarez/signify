// ===================================================================
// Signify ID — running an app's admin tools from the console
//
// Some administration is about an app's own data rather than about people:
// the whiteboard's classrooms, template library, feature switches and live
// sessions. That data lives in the app, so the console cannot hold it; what
// it can do is be the one place admins go. The console calls
//
//   /api/admin/app-admin/<client_id>/api/...
//
// and this module forwards the request to that app, on the registered app's
// own address and nowhere else, carrying a token minted for the person signed
// in to the console. The app then decides what they may do exactly as it
// would if they had signed in to it directly — the token holds the same
// claims an ordinary sign-in would — so moving a tool here changes where it
// lives, never who may use it.
//
// The token is typed `app_admin` and lives 60 seconds, so an app can accept it
// for its admin API without it ever working as a browser session, and a copy
// that leaks is useless almost at once.
// ===================================================================

const { Readable } = require('stream');
const db = require('./db');
const audit = require('./audit');
const guards = require('./guards');
const oidc = require('./oidc');
const catalog = require('./catalog');

const fail = (res, code, msg) => res.status(code).json({ error: msg });

// An app's reply is passed back, but never as something that can run.
//
// Replies are served from id.signify.one, so a script in one would run with
// the identity service's own authority: reading the console's CSRF cookie and
// acting as whichever admin opened a crafted link. The apps are trusted to
// answer about their own data, not to run code here. So headers about the hop
// are dropped, and so are any that would let an app loosen this origin's
// protections; anything a browser would render as a live page is served as
// plain text; and every reply carries a policy under which nothing runs.
const DROPPED = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length', 'set-cookie',
  'content-security-policy', 'content-security-policy-report-only', 'x-frame-options',
  'x-content-type-options', 'refresh', 'access-control-allow-origin', 'access-control-allow-credentials',
]);

// Types a browser renders as a document that can carry script.
const ACTIVE_TYPES = /^\s*(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml)\b/i;

// allow-downloads so a backup file still saves; nothing here allows script.
const PROXIED_CSP = "default-src 'none'; sandbox allow-downloads; frame-ancestors 'none'";

function responseHeaders(replyHeaders) {
  const out = {};
  replyHeaders.forEach((value, key) => {
    const k = key.toLowerCase();
    if (!DROPPED.has(k)) out[k] = value;
  });
  if (out['content-type'] && ACTIVE_TYPES.test(out['content-type'])) {
    out['content-type'] = 'text/plain; charset=utf-8';
  }
  out['content-security-policy'] = PROXIED_CSP;
  out['x-content-type-options'] = 'nosniff';
  out['cache-control'] = 'no-store';
  return out;
}

/**
 * The app, if this person may administer it from here: the app is active, has
 * an address to send to, is turned on for their school (a super admin reaches
 * every app), they are not individually excluded from it, and they hold at
 * least one of its permissions. The last test keeps the console from offering
 * an app's tools to someone the app would refuse anyway.
 */
async function appFor(actor, clientId) {
  const app = await db.one(
    "SELECT * FROM apps WHERE client_id = $1 AND status = 'active'", [clientId]);
  if (!app || !app.launch_url) return null;
  if (actor.isSuper) return app;

  const enabled = await db.one(
    'SELECT enabled FROM app_tenants WHERE app_id = $1 AND tenant_id = $2', [app.id, actor.tenantId]);
  if (!enabled || !enabled.enabled) return null;
  const perPerson = await db.one(
    'SELECT allowed FROM user_app_access WHERE user_id = $1 AND app_id = $2', [actor.userId, app.id]);
  if (perPerson && !perPerson.allowed) return null;

  // Admin tools are for admins: an admin permission of the app's own (the
  // whiteboard's "manage all boards", say), or managing people in a school
  // that uses it. Every teacher holds some of an app's permissions — "host a
  // board" — and that alone must not open its admin tools.
  const prefix = app.namespace + ':';
  const held = Object.keys(actor.perms || {}).filter((p) => p.startsWith(prefix));
  if (!held.length) return null;
  const adminKeys = await catalog.adminKeys();
  const isAppAdmin = held.some((p) => adminKeys.has(p)) || !!(actor.perms || {})['core:manage_users'];
  return isAppAdmin ? app : null;
}

// Only ever the app's own origin: a registered address is the one thing here
// an admin cannot change from a request.
function targetUrl(app, path, query) {
  const base = new URL(app.launch_url);
  const url = new URL(path, base.origin);
  if (url.origin !== base.origin) return null;
  for (const [k, v] of Object.entries(query || {})) {
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
    else url.searchParams.set(k, v);
  }
  return url;
}

async function handle(req, res) {
  const actor = guards.requireActor(req, res);
  if (!actor) return;

  const clientId = req.params.clientId;
  const path = '/' + (req.params[0] || '');
  // An app's API, and nothing that walks back out of it.
  if (!path.startsWith('/api/') || path.includes('..') || path.includes('//')) {
    return fail(res, 400, 'That is not an address this console can send to.');
  }

  const app = await appFor(actor, clientId);
  if (!app) return fail(res, 403, 'You cannot manage that app from here.');

  // Deleting an app's data is the one thing here that cannot be undone, so it
  // asks for the same recent sign-in as the console's other destructive steps.
  if (req.method === 'DELETE' && !(await guards.requireFreshSession(req, res, 30))) return;

  const token = await oidc.mintAppAdminToken(app, actor.userId, actor.tenantId, actor.sessionId);
  if (!token) return fail(res, 403, 'Your account cannot act in that app.');

  const url = targetUrl(app, path, req.query);
  if (!url) return fail(res, 400, 'That is not an address this console can send to.');

  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  let reply;
  try {
    reply = await fetch(url, {
      method: req.method,
      headers: {
        authorization: 'Bearer ' + token,
        accept: req.get('accept') || 'application/json',
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
      },
      body: hasBody ? JSON.stringify(req.body || {}) : undefined,
      signal: ctl.signal,
      redirect: 'manual',
    });
  } catch (e) {
    clearTimeout(timer);
    return fail(res, 502, `${app.name} did not answer. Try again in a moment.`);
  }

  // Anything that changes the app's data is recorded here as well as in the
  // app, so one log shows what an admin did from the console.
  if (hasBody && reply.ok) {
    await audit.from(req, {
      tenantId: actor.tenantId, action: 'app_admin.' + req.method.toLowerCase(),
      targetType: 'app', targetId: app.id,
      detail: { app: app.client_id, path },
    });
  }

  res.status(reply.status);
  for (const [key, value] of Object.entries(responseHeaders(reply.headers))) res.setHeader(key, value);
  if (!reply.body) { clearTimeout(timer); return res.end(); }
  // Streamed rather than buffered: a backup download is a large file.
  const stream = Readable.fromWeb(reply.body);
  stream.on('end', () => clearTimeout(timer));
  stream.on('error', () => { clearTimeout(timer); res.end(); });
  stream.pipe(res);
}

// The apps this person can run admin tools for from the console, for its nav.
async function listFor(actor) {
  const rows = await db.many(
    `SELECT client_id FROM apps
      WHERE status = 'active' AND launch_url IS NOT NULL AND launch_url <> ''
      ORDER BY sort_order NULLS LAST, name`);
  const out = [];
  for (const r of rows) {
    const app = await appFor(actor, r.client_id);
    if (app) {
      out.push({
        clientId: app.client_id, name: app.short_name || app.name,
        namespace: app.namespace, url: new URL(app.launch_url).origin,
      });
    }
  }
  return out;
}

module.exports = { handle, appFor, targetUrl, listFor, responseHeaders };
