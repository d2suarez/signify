// ===================================================================
// Visitors — how much a signed-out browser may ask of the server
//
// A visitor can use the weather and the video titles, both of which the
// server looks up on their behalf from somebody else's service. Signed in,
// that is a teacher using their desk. Signed out, with no limit, it is a free
// relay that anyone could point a script at. So signed-out callers get an
// allowance per address: plenty for a lesson, useless for a scraper.
//
// The address is the LAST entry in X-Forwarded-For. Railway's edge appends
// the address it actually saw; anything to the left of that was written by
// the client and can say whatever the client likes.
// ===================================================================

'use strict';

const WINDOW_MS = 10 * 60 * 1000;
const LIMIT = 60;

const seen = new Map();   // `${bucket}:${address}` -> { count, resetAt }

function addressOf(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return forwarded.length ? forwarded[forwarded.length - 1] : String((req.socket && req.socket.remoteAddress) || 'unknown');
}

/**
 * True if this signed-out caller still has allowance in `bucket`; otherwise
 * answers 429 itself and returns false.
 */
function allow(req, res, bucket, now = Date.now()) {
  const key = `${bucket}:${addressOf(req)}`;
  let slot = seen.get(key);
  if (!slot || slot.resetAt <= now) {
    slot = { count: 0, resetAt: now + WINDOW_MS };
    seen.set(key, slot);
  }
  slot.count += 1;
  if (slot.count > LIMIT) {
    res.status(429).json({ error: 'That is a lot of asking for one computer. Try again in a few minutes, or log in.' });
    return false;
  }
  return true;
}

// Forget windows that have closed, so the map cannot grow for ever.
setInterval(() => {
  const now = Date.now();
  for (const [key, slot] of seen) if (slot.resetAt <= now) seen.delete(key);
}, WINDOW_MS).unref();

module.exports = { allow, addressOf, LIMIT, WINDOW_MS, _reset: () => seen.clear() };
