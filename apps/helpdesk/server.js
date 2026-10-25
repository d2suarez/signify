// ===================================================================
// Signify Help Desk — server
//
// Next.js renders every page; this thin Express layer in front of it exists
// for one reason: sign-in. The help desk does not talk to Google, keep
// passwords or mint sessions any more. Signify ID does all of that, through
// the same signify-auth.js every app in the fleet carries, unchanged.
//
// The person signify-auth works out is handed to Next on a request header
// (x-signify-user). Anything a browser sends under that name is thrown away
// first, so the only way to set it is to be this file.
// ===================================================================

'use strict';

const express = require('express');
const compression = require('compression');
const next = require('next');
const signify = require('./signify-auth');

const PORT = parseInt(process.env.PORT || '3000', 10);
const PRODUCTION = !!process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production';
const DEV = process.env.NEXT_DEV === '1';
const CANONICAL_HOST = process.env.CANONICAL_HOST || '';
const USER_HEADER = 'x-signify-user';
const DESK_ORIGINS = (process.env.DESK_ORIGINS || (PRODUCTION ? 'https://desk.signify.one' : 'http://localhost:8770'))
  .split(',').map((s) => s.trim()).filter(Boolean);

// Two permissions. Everybody at the school can ask for help and plan
// projects without one; these are for the people who answer.
const PERMISSIONS = [
  { key: 'helpdesk:agent', label: 'Work the help desk: answer tickets, devices, recurring jobs, help articles' },
  { key: 'helpdesk:admin', label: 'Run the help desk: request forms and settings', admin: true },
];

// ---------- local development ----------
// Signing in needs the identity service, a Google client and https. This is
// how the help desk gets worked on without any of that. It refuses to exist
// in a hosted environment, the same stance Signify ID's own dev login takes.
const DEV_ROLES = {
  admin: { role: 'admin', roleLabel: 'School admin', perms: { 'helpdesk:agent': 'tenant', 'helpdesk:admin': 'tenant' } },
  agent: { role: 'tech', roleLabel: 'Technician', perms: { 'helpdesk:agent': 'tenant' } },
  staff: { role: 'teacher', roleLabel: 'Teacher', perms: {} },
  student: { role: 'student', roleLabel: 'Student', perms: {} },
};
const DEV_PEOPLE = {
  admin: { id: 'dev-admin-0000', email: 'dev.admin@example.school', name: 'Dev Admin' },
  agent: { id: 'dev-agent-0000', email: 'dev.tech@example.school', name: 'Dev Technician' },
  staff: { id: 'dev-teacher-0000', email: 'dev.teacher@example.school', name: 'Dev Teacher' },
  student: { id: 'dev-student-0000', email: 'dev.student@example.school', name: 'Dev Student' },
};
const DEV_DEFAULT = process.env.HELPDESK_DEV_USER || '';
if (DEV_DEFAULT && PRODUCTION) {
  throw new Error('HELPDESK_DEV_USER is set in a hosted environment. Refusing to start.');
}
if (DEV_DEFAULT) console.warn(`\n  ⚠  HELPDESK_DEV_USER is on: every request is signed in as a made-up ${DEV_DEFAULT}. Switch with /dev/as/<admin|agent|staff|student>.\n`);

function devUser(req) {
  const m = /(?:^|;\s*)hd_dev_as=(\w+)/.exec(req.headers.cookie || '');
  const key = (m && DEV_ROLES[m[1]]) ? m[1] : (DEV_ROLES[DEV_DEFAULT] ? DEV_DEFAULT : 'admin');
  return {
    ...DEV_PEOPLE[key], ...DEV_ROLES[key], picture: '', isSuper: false, isMinor: key === 'student',
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
    // Where to come back to after signing in, for pages Next renders.
    req.headers['x-helpdesk-path'] = req.originalUrl;
    nextFn();
  });

  // Google only accepts OAuth origins on an authorised domain, so sign-in
  // works on help.signify.one and not on the *.up.railway.app host. Send
  // everything to the real one — except the health check.
  app.use((req, res, nextFn) => {
    const proto = req.headers['x-forwarded-proto'];
    const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    if (CANONICAL_HOST && proto && host && host !== CANONICAL_HOST && req.path !== '/healthz') {
      return res.redirect(301, `https://${CANONICAL_HOST}${req.originalUrl}`);
    }
    nextFn();
  });

  // signify-auth renews an expired ID token by adding a Set-Cookie before Next
  // ever sees the request. Next sets cookies of its own (the language toggle)
  // with setHeader, which would REPLACE the renewal — and the browser would
  // keep a refresh token the identity service has already spent, which ends
  // the session everywhere. So a Set-Cookie written later is added to the
  // ones already there, never written over them.
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

  // /auth/login, /auth/callback, /auth/logout, /auth/me, /auth/apps, /auth/report
  signify.mount(app, {
    permissions: PERMISSIONS,
    postLogoutUri: CANONICAL_HOST ? `https://${CANONICAL_HOST}/` : undefined,
  });
  app.use(signify.middleware);

  if (DEV_DEFAULT) {
    app.get('/dev/as/:who', (req, res) => {
      const who = DEV_ROLES[req.params.who] ? req.params.who : 'admin';
      res.setHeader('Set-Cookie', `hd_dev_as=${who}; Path=/; SameSite=Lax`);
      res.redirect(String(req.query.return || '/'));
    });
    app.use((req, res, nextFn) => { if (!req.user) req.user = devUser(req); nextFn(); });
  }

  // The ticket box on Teacher's Desk calls /api/desk/* from desk.signify.one.
  // Same site, so the browser sends this app's own sign-in cookie with it;
  // only the origins named here may read the answer or send JSON at all.
  app.use('/api/desk', (req, res, nextFn) => {
    const origin = req.headers.origin;
    if (origin && DESK_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
      res.setHeader('Access-Control-Max-Age', '600');
      res.setHeader('Vary', 'Origin');
    } else if (origin) {
      return res.status(403).json({ error: 'Not allowed from that site.' });
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    nextFn();
  });

  // Hand whoever this is to Next, then let Next render.
  app.use((req, res, nextFn) => {
    if (req.user) {
      req.headers[USER_HEADER] = Buffer.from(JSON.stringify(req.user)).toString('base64url');
    }
    nextFn();
  });

  app.all('*', (req, res) => handle(req, res));

  app.listen(PORT, () => {
    console.log(`help desk listening on :${PORT}${DEV ? ' (next dev)' : ''}`);
    if (PRODUCTION) require('./offsite-backup').start();
  });
}

main().catch((e) => {
  console.error('help desk failed to start —', e);
  process.exit(1);
});
