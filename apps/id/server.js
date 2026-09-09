// ===================================================================
// Signify ID
// Central identity, roles and roster for the Signify classroom apps.
//
//   /authorize /token /userinfo   OpenID Connect, for the apps
//   /signin /logout               the sign-in pages people see
//   /admin                        the console
//   /api/admin/*                  everything the console calls
// ===================================================================

const path = require('path');
const express = require('express');
const compression = require('compression');

const { config, validate } = require('./src/config');
const db = require('./src/db');
const views = require('./src/views');
const auth = require('./src/auth');
const oidc = require('./src/oidc');
const adminApi = require('./src/admin');
const serviceApi = require('./src/api');
const maintenance = require('./src/maintenance');
const { canonicalHost } = require('./src/canonical');
const sessions = require('./src/sessions');
const seed = require('./src/seed');

// A single bad request must never take the service down — every app in the
// fleet depends on this one staying up.
process.on('uncaughtException', (e) => console.error('Uncaught exception (server kept alive):', (e && e.stack) || e));
process.on('unhandledRejection', (e) => console.error('Unhandled rejection (server kept alive):', (e && e.stack) || e));

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // behind Railway's proxy; needed for a correct req.ip

// Send public traffic arriving on any other hostname (the raw Railway URL, an
// old domain) to the issuer's host, before anything mints a token.
app.use(canonicalHost);

// ---------- security headers ----------
// Only Google's sign-in scripts are allowed in from outside. Nothing here may
// be framed: an identity provider inside somebody else's iframe is a
// clickjacked sign-in waiting to happen.
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' https://accounts.google.com https://apis.google.com",
  // Google Identity Services pulls its button stylesheet from
  // accounts.google.com/gsi/style. Without it the button renders as
  // unstyled, zero-height markup and nobody can sign in.
  "style-src 'self' 'unsafe-inline' https://accounts.google.com",
  "img-src 'self' data: https://*.googleusercontent.com https://*.gstatic.com",
  "connect-src 'self' https://accounts.google.com",
  "frame-src https://accounts.google.com",
].join('; ');

app.use((req, res, next) => {
  res.set('Content-Security-Policy', CSP);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  res.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=(), interest-cohort=()');
  if (config.production) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

app.use(compression());
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));

// ---------- rate limiting ----------
// In-memory and per-instance, which is proportionate here: it exists to blunt
// credential stuffing and runaway clients, not to survive a botnet.
function makeLimiter({ windowMs, max, name }) {
  const hits = new Map();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, v] of hits) if (v.start < cutoff) hits.delete(k);
  }, windowMs).unref?.();

  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    let rec = hits.get(key);
    if (!rec || now - rec.start > windowMs) rec = { start: now, n: 0 };
    rec.n += 1;
    hits.set(key, rec);
    if (rec.n > max) {
      res.set('Retry-After', String(Math.ceil((rec.start + windowMs - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests. Wait a moment and try again.' });
    }
    next();
  };
}

const signinLimiter = makeLimiter({ windowMs: 60_000, max: 20, name: 'signin' });
const tokenLimiter = makeLimiter({ windowMs: 60_000, max: 120, name: 'token' });
const apiLimiter = makeLimiter({ windowMs: 60_000, max: 600, name: 'api' });

app.use((req, res, next) => {
  if (req.path === '/auth/google' || req.path === '/auth/dev') return signinLimiter(req, res, next);
  if (req.path === '/token' || req.path === '/revoke') return tokenLimiter(req, res, next);
  if (req.path.startsWith('/api/')) return apiLimiter(req, res, next);
  next();
});

// ---------- routes ----------

app.get('/healthz', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ ok: true, issuer: config.issuer });
  } catch (e) {
    res.status(503).json({ ok: false, error: 'database unavailable' });
  }
});

// The console's HTML shell is served by the /admin route behind a session
// check, so it must not also be reachable as a plain file.
app.use((req, res, next) => (req.path === '/admin.html' ? res.redirect('/admin') : next()));

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: config.production ? '1y' : 0,
  setHeaders: (res, filePath) => {
    res.set('X-Content-Type-Options', 'nosniff');
    // The console's own code must revalidate on every load. A flat cache here
    // meant a deploy stayed invisible to anyone who had the console open
    // recently: they kept running the previous build and saw a shipped fix as
    // simply not working. An unchanged file still costs only a 304.
    if (/\.(?:html|js|css|map)$/i.test(filePath)) {
      res.set('Cache-Control', 'no-cache');
    }
  },
}));

// Session lookup runs before anything that needs to know who is asking.
app.use(auth.attachActor);

app.use(oidc.router);
app.use(auth.router);
app.use('/api/admin', adminApi);
app.use('/api/v1', serviceApi);

// The console itself. Anyone signed in may open it; what they can see inside
// is decided by the API, not by hiding the page.
app.get('/admin', (req, res) => {
  if (!req.actor) return res.redirect('/signin?continue=' + encodeURIComponent('/admin'));
  sessions.issueCsrf(res);
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/', (req, res) => {
  res.redirect(req.actor ? '/admin' : '/signin');
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
  res.status(404).send(views.errorPage({ title: 'Not found', message: 'There is nothing at that address.' }));
});

// Error handler. Never leak a stack trace to a browser.
app.use((err, req, res, next) => {
  console.error('Request failed:', req.method, req.path, err && err.stack ? err.stack : err);
  if (res.headersSent) return;
  if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'Something went wrong on our side.' });
  res.status(500).send(views.errorPage({ title: 'Something went wrong', message: 'The problem has been logged. Please try again.' }));
});

// ---------- boot ----------

(async () => {
  const { fatal, warn } = validate();
  for (const w of warn) console.warn('WARNING:', w);
  if (fatal.length) {
    console.error('Cannot start:\n  - ' + fatal.join('\n  - '));
    process.exit(1);
  }

  try {
    await db.migrate();
    await seed.ensureBuiltins();
  } catch (e) {
    console.error('Startup failed:', e.stack || e.message);
    process.exit(1);
  }

  maintenance.start();

  const server = app.listen(config.port, () => {
    console.log(`Signify ID listening on :${config.port}`);
    console.log(`  issuer   ${config.issuer}`);
    console.log(`  console  ${config.issuer}/admin`);
    if (!config.googleClientId) console.log('  NOTE: no GOOGLE_CLIENT_ID — Google sign-in is unavailable.');
  });

  const shutdown = (signal) => () => {
    console.log(`${signal} received, shutting down.`);
    server.close(() => db.pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', shutdown('SIGTERM'));
  process.on('SIGINT', shutdown('SIGINT'));
})();
