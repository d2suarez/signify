// ===================================================================
// Signify Learning — server
//
// Next.js renders every page. This Express layer in front of it does two
// things Next cannot:
//
//   1. Sign-in, through Signify ID, with the same signify-auth.js every app
//      in the fleet carries unchanged. The person it works out is handed to
//      Next on x-signify-user, and the token valid for this request on
//      x-signify-token; any copy a browser sends of either is deleted first.
//
//   2. Live lessons, over socket.io. A teacher presents; every student's
//      screen follows. State lives in memory (one process for now; see
//      live.js for what changes when there are several).
// ===================================================================

'use strict';

const http = require('http');
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const next = require('next');
const signify = require('./signify-auth');
const live = require('./live');

const PORT = parseInt(process.env.PORT || '3000', 10);
const PRODUCTION = !!process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production';
const DEV = process.env.NEXT_DEV === '1';
const CANONICAL_HOST = process.env.CANONICAL_HOST || '';
const USER_HEADER = 'x-signify-user';
const TOKEN_HEADER = 'x-signify-token';

// Live tickets are signed by Next (src/lib/live-ticket.ts) and checked here.
// Both run in this one process, so a secret made at boot is enough; a fixed
// one can be set for when there are several processes.
process.env.LEARNING_LIVE_SECRET ||= crypto.randomBytes(32).toString('hex');

// Signify Learning declares no permissions yet: who teaches a course and who
// learns in it come from class membership in Signify ID, not from roles.
const PERMISSIONS = [];

// ---------- local development ----------
// Signing in needs the identity service, a Google client and https. This is
// how the app gets worked on without any of that. It refuses to exist in a
// hosted environment.
const DEV_PEOPLE = {
  teacher: { id: 'dev-teacher-0000', email: 'dev.teacher@example.school', name: 'Dev Teacher', role: 'teacher', roleLabel: 'Teacher' },
  admin: { id: 'dev-admin-0000', email: 'dev.admin@example.school', name: 'Dev Admin', role: 'admin', roleLabel: 'Admin' },
  student: { id: 'dev-student-0000', email: 'dev.student@example.school', name: 'Dev Student', role: 'student', roleLabel: 'Student' },
};
const DEV_DEFAULT = process.env.LEARNING_DEV_USER || '';
if (DEV_DEFAULT && PRODUCTION) {
  throw new Error('LEARNING_DEV_USER is set in a hosted environment. Refusing to start.');
}
if (DEV_DEFAULT) console.warn(`\n  ⚠  LEARNING_DEV_USER is on: every request is signed in as a made-up ${DEV_DEFAULT}. Switch with /dev/as/<teacher|admin|student>.\n`);

function devUser(cookieHeader) {
  const m = /(?:^|;\s*)sl_dev_as=(\w+)/.exec(cookieHeader || '');
  const key = (m && DEV_PEOPLE[m[1]]) ? m[1] : (DEV_PEOPLE[DEV_DEFAULT] ? DEV_DEFAULT : 'teacher');
  return {
    ...DEV_PEOPLE[key], picture: '', isSuper: false, isMinor: false, perms: {},
    tenant: 'dev-school', tenantId: 'dev-school', tenantName: 'Development School', sessionId: 'dev-session',
  };
}

// ---------- the app ----------

async function main() {
  const nextApp = next({ dev: DEV, dir: __dirname, port: PORT });
  const handle = nextApp.getRequestHandler();
  await nextApp.prepare();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(compression());

  // Never believe a browser that claims to be somebody.
  app.use((req, res, nextFn) => {
    delete req.headers[USER_HEADER];
    delete req.headers[TOKEN_HEADER];
    req.headers['x-learning-path'] = req.originalUrl;
    nextFn();
  });

  app.use((req, res, nextFn) => {
    const proto = req.headers['x-forwarded-proto'];
    const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    if (CANONICAL_HOST && proto && host && host !== CANONICAL_HOST && req.path !== '/healthz') {
      return res.redirect(301, `https://${CANONICAL_HOST}${req.originalUrl}`);
    }
    nextFn();
  });

  // signify-auth renews an expired ID token by adding a Set-Cookie before
  // Next sees the request. A later setHeader('Set-Cookie') from Next would
  // REPLACE it, and the browser would keep a refresh token the identity
  // service has already spent, ending the session everywhere. So later
  // Set-Cookie writes are added to the ones already there.
  app.use((req, res, nextFn) => {
    const original = res.setHeader.bind(res);
    res.setHeader = (name, value) => {
      if (String(name).toLowerCase() === 'set-cookie') {
        const prev = res.getHeader('set-cookie');
        if (prev) value = [].concat(prev, value);
      }
      return original(name, value);
    };
    nextFn();
  });

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  signify.mount(app, {
    permissions: PERMISSIONS,
    postLogoutUri: CANONICAL_HOST ? `https://${CANONICAL_HOST}/` : undefined,
  });
  app.use(signify.middleware);

  if (DEV_DEFAULT) {
    app.get('/dev/as/:who', (req, res) => {
      const who = DEV_PEOPLE[req.params.who] ? req.params.who : 'teacher';
      res.setHeader('Set-Cookie', `sl_dev_as=${who}; Path=/; SameSite=Lax`);
      res.redirect(String(req.query.return || '/'));
    });
    app.use((req, res, nextFn) => { if (!req.user) req.user = devUser(req.headers.cookie); nextFn(); });
  }

  // Hand whoever this is to Next, then let Next render.
  app.use((req, res, nextFn) => {
    if (req.user) {
      req.headers[USER_HEADER] = Buffer.from(JSON.stringify(req.user)).toString('base64url');
      const tok = req.signifyToken || '';
      if (tok) req.headers[TOKEN_HEADER] = tok;
    }
    nextFn();
  });

  app.all('*', (req, res) => handle(req, res));

  const server = http.createServer(app);
  live.attach(server, {
    secret: process.env.LEARNING_LIVE_SECRET,
    // Who is on the other end of a socket: their Signify session from the
    // handshake cookie, or the made-up person in local development.
    async whoIs(cookieHeader) {
      const user = await signify.verifyCookieSession(cookieHeader);
      if (user) return user;
      return DEV_DEFAULT ? devUser(cookieHeader) : null;
    },
  });

  server.listen(PORT, () => {
    console.log(`signify learning listening on :${PORT}${DEV ? ' (next dev)' : ''}`);
  });
}

main().catch((e) => {
  console.error('signify learning failed to start —', e);
  process.exit(1);
});
