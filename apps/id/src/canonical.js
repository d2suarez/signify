// ===================================================================
// Signify ID — canonical host
//
// The issuer is baked into every token and checked by every relying app, so
// the service has to be reached at exactly one hostname. Railway also serves
// this container on its own *.up.railway.app address; a sign-in that starts
// there would mint tokens whose issuer does not match the address the browser
// is on, and every verification would fail in a way that is tedious to trace.
//
// Redirect rather than refuse: a bookmarked Railway URL should keep working.
// ===================================================================

const { config } = require('./config');

// Internal traffic — Railway's health check, container-to-container calls,
// anything on localhost — arrives without the proxy's forwarded headers and
// must never be bounced.
function hostOf(url) {
  try { return new URL(url).host.toLowerCase(); } catch { return ''; }
}

function canonicalHost(req, res, next) {
  const canonical = hostOf(config.issuer);
  if (!canonical) return next();

  // Only a request that came through the public proxy is a candidate.
  if (!req.headers['x-forwarded-proto']) return next();

  const host = String(req.headers.host || '').toLowerCase();
  if (!host || host === canonical) return next();

  // Health checks may legitimately arrive on any hostname.
  if (req.path === '/healthz') return next();

  return res.redirect(301, `https://${canonical}${req.originalUrl}`);
}

module.exports = { canonicalHost, hostOf };
