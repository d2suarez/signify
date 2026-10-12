// ===================================================================
// Teacher's Desk — what a YouTube video is called
//
// Asked through this server rather than from the browser, for the same reason
// the weather is: the widget deliberately does not touch YouTube until the
// teacher presses play, and a title lookup fired from thirty classroom
// machines would throw that away — YouTube would learn every teacher's IP and
// what they were about to show, before anybody had watched anything.
//
// oEmbed, not the Data API: no key, no quota, no project to keep alive, and
// it returns exactly the two fields worth having. The answer is cached hard,
// because a video's title does not change.
// ===================================================================

const OEMBED = 'https://www.youtube.com/oembed';

// Eleven characters of YouTube's own alphabet. The widget parses the id out
// of whatever was pasted; this is the second gate, so nothing else can be
// appended to the outgoing URL whatever arrives here.
const ID = /^[A-Za-z0-9_-]{11}$/;

const CACHE_MS = 7 * 24 * 60 * 60 * 1000;
const MISS_MS = 10 * 60 * 1000;          // a private or deleted video, briefly
const cache = new Map();

const clean = (s, max) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * The title and channel for a video id, or null when YouTube will not say —
 * a private video, an age-gated one, a deleted one, or a bad id.
 *
 * Never throws: a title is a convenience, and the widget has to keep working
 * without one.
 */
async function titleFor(id) {
  if (!ID.test(String(id || ''))) return null;

  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < (hit.value ? CACHE_MS : MISS_MS)) return hit.value;

  let value = null;
  try {
    const url = `${OEMBED}?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`;
    const res = await fetch(url, {
      headers: { 'user-agent': "Teacher's Desk (desk.signify.one)" },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const body = await res.json();
      const title = clean(body.title, 120);
      if (title) value = { title, channel: clean(body.author_name, 80) };
    }
  } catch { /* left null; the widget carries on without a title */ }

  cache.set(id, { at: Date.now(), value });
  if (cache.size > 500) for (const k of [...cache.keys()].slice(0, 100)) cache.delete(k);
  return value;
}

module.exports = { titleFor };
