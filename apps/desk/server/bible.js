// ===================================================================
// Teacher's Desk — Bible text for the Bible widget
//
// Asked through this server, like the weather, for two reasons:
//
//   * The keys stay here. API.Bible (NIV, NKJV, AMP and the rest) and
//     Crossway's ESV API are both keyed to the teacher's own account, and a
//     key handed to the browser would sit in every classroom machine's
//     developer tools. Set API_BIBLE_KEY and ESV_API_KEY on the service.
//   * Nothing the teacher typed goes out as typed. The widget sends a
//     canonical id (JHN.3.16-JHN.3.18), which public/js/bible-books.js checks
//     against the real books and chapter counts before any URL is built.
//
// With neither key set it still works: bible-api.com serves the KJV and the
// World English Bible with no key at all.
//
// Answers are either { kind: 'html', html } — the provider's own markup,
// which the widget reads with DOMParser and rebuilds from text alone, never
// inserting it — or { kind: 'verses', verses: [{ c, v, text }] }.
// ===================================================================

const books = require('../public/js/bible-books');

const ESV_URL = 'https://api.esv.org/v3/passage/html/';
// API.Bible moved to rest.api.bible in 2025 and kept the old host running.
// Whichever answers first is remembered.
const AB_HOSTS = ['https://rest.api.bible/v1/', 'https://api.scripture.api.bible/v1/'];
const FREE_URL = 'https://bible-api.com/';

const FREE = [
  { id: 'kjv', abbrev: 'KJV', name: 'King James Version', source: 'free' },
  { id: 'web', abbrev: 'WEB', name: 'World English Bible', source: 'free' },
];

// The translations a teacher is most likely to want, in this order, ahead of
// the long tail of everything else English on the key.
const PREFERRED = ['ESV', 'NIV', 'NKJV', 'KJV', 'NLT', 'CSB', 'NASB', 'AMP', 'NET', 'WEB'];

const TIMEOUT = 8000;
const PASSAGE_MS = 12 * 60 * 60 * 1000;
const LIST_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE = 400;

const cache = new Map();
let abList = null;           // { at, list }
let abHost = null;

const keys = () => ({ esv: (process.env.ESV_API_KEY || '').trim(), ab: (process.env.API_BIBLE_KEY || '').trim() });

class BibleError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

// Swappable so the tests can answer for the services without the network.
let fetcher = (...args) => fetch(...args);

async function get(url, headers) {
  return fetcher(url, {
    headers: { 'user-agent': "Teacher's Desk (desk.signify.one)", accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(TIMEOUT),
  });
}

/** An API.Bible request, trying the current host and then the old one. */
async function ab(pathAndQuery) {
  const key = keys().ab;
  const hosts = abHost ? [abHost, ...AB_HOSTS.filter((h) => h !== abHost)] : AB_HOSTS;
  let last = null;
  for (const host of hosts) {
    try {
      const res = await get(host + pathAndQuery, { 'api-key': key });
      // A refused key on one host may be a key only the other one knows.
      if (res.status === 401 && host !== hosts[hosts.length - 1]) { last = res; continue; }
      abHost = host;
      return res;
    } catch (e) { last = e; }
  }
  if (last && typeof last.status === 'number') return last;
  throw new BibleError('API.Bible could not be reached just now.');
}

const clean = (s, max) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);

async function apiBibleList() {
  if (!keys().ab) return [];
  if (abList && Date.now() - abList.at < LIST_MS) return abList.list;
  try {
    const res = await ab('bibles?language=eng');
    if (!res.ok) {
      console.error(`desk: API.Bible list refused (${res.status})`);
      abList = { at: Date.now() - LIST_MS + 10 * 60 * 1000, list: [] };   // ask again in 10 minutes
      return [];
    }
    const body = await res.json();
    const seen = new Set();
    const list = [];
    for (const b of body.data || []) {
      const id = String(b.id || '');
      if (!/^[A-Za-z0-9-]{4,64}$/.test(id)) continue;
      const abbrev = clean(b.abbreviationLocal || b.abbreviation, 16).toUpperCase();
      // The same translation is often listed twice (an edition with and
      // without notes); the first is enough.
      const name = clean(b.nameLocal || b.name, 100);
      const dedupe = `${abbrev}|${name}`;
      if (!abbrev || seen.has(dedupe)) continue;
      seen.add(dedupe);
      list.push({ id: `ab-${id}`, abbrev, name, source: 'ab', bibleId: id });
    }
    abList = { at: Date.now(), list };
    return list;
  } catch (e) {
    console.error('desk: API.Bible list failed —', e.message);
    return abList ? abList.list : [];
  }
}

const rank = (abbrev) => {
  const plain = abbrev.replace(/[^A-Z]/g, '');
  const i = PREFERRED.findIndex((p) => plain === p);
  return i < 0 ? PREFERRED.length : i;
};

/**
 * What this desk can read, best first, and which to start on.
 *
 * The ESV comes from Crossway; NIV and the rest from API.Bible; the KJV and
 * WEB from bible-api.com only when API.Bible does not already have them, so
 * the list never shows the same translation twice.
 */
async function versions() {
  const k = keys();
  const out = [];
  if (k.esv) out.push({ id: 'esv', abbrev: 'ESV', name: 'English Standard Version', source: 'esv' });
  const fromAb = (await apiBibleList()).filter((v) => v.abbrev !== 'ESV' || !k.esv);
  out.push(...fromAb);
  for (const f of FREE) if (!out.some((v) => v.abbrev === f.abbrev)) out.push(f);
  out.sort((a, b) => rank(a.abbrev) - rank(b.abbrev) || a.name.localeCompare(b.name));
  return {
    versions: out.map(({ id, abbrev, name }) => ({ id, abbrev, name })),
    default: out[0] ? out[0].id : 'kjv',
    keys: { esv: !!k.esv, apiBible: !!k.ab },
  };
}

async function findVersion(id) {
  const s = String(id || '');
  if (s === 'esv') return keys().esv ? { id: 'esv', abbrev: 'ESV', source: 'esv' } : null;
  const free = FREE.find((f) => f.id === s);
  if (free) return free;
  if (s.startsWith('ab-')) return (await apiBibleList()).find((v) => v.id === s) || null;
  return null;
}

function remember(key, value) {
  cache.set(key, { at: Date.now(), value });
  if (cache.size > MAX_CACHE) for (const k of [...cache.keys()].slice(0, 50)) cache.delete(k);
}

/** One passage, from whichever service carries that translation. */
async function passage(versionId, refId) {
  const ref = books.fromId(refId);
  if (!ref) throw new BibleError('That is not a passage the desk knows how to look up.', 400);
  const version = await findVersion(versionId);
  if (!version) throw new BibleError('That translation is not available on this desk.', 400);

  // Crossway's terms: at most half a book in one request (one- and
  // two-chapter books excepted), and no stored copy of the text. The ESV is
  // therefore never cached here; the limits (5,000 a day, 60 a minute) are
  // far above what one desk uses.
  const esv = version.source === 'esv';
  const book = books.bookOf(ref);
  if (esv && book.chapters > 2 && ref.c2 - ref.c1 + 1 > Math.floor(book.chapters / 2)) {
    throw new BibleError(`The ESV can be read at most half a book at a time — try fewer chapters of ${book.name}.`, 400);
  }

  const key = `${version.id}|${books.toId(ref)}`;
  const hit = !esv && cache.get(key);
  if (hit && Date.now() - hit.at < PASSAGE_MS) return hit.value;

  let value;
  if (version.source === 'esv') value = await fromEsv(ref);
  else if (version.source === 'ab') value = await fromApiBible(version, ref);
  else value = await fromFree(version, ref);
  value = { ...value, label: books.label(ref), ref: books.toId(ref), version: { id: version.id, abbrev: version.abbrev } };
  if (!esv) remember(key, value);
  return value;
}

async function fromEsv(ref) {
  const q = new URLSearchParams({
    q: books.toQuery(ref),
    'include-passage-references': 'false',
    'include-verse-numbers': 'true',
    'include-first-verse-numbers': 'true',
    'include-footnotes': 'false',
    'include-footnote-body': 'false',
    'include-headings': 'true',
    'include-subheadings': 'true',
    'include-surrounding-chapters': 'false',
    'include-surrounding-chapters-below': 'false',
    'include-word-ids': 'false',
    'include-audio-link': 'false',
    'include-short-copyright': 'false',
    'include-copyright': 'false',
    'include-book-titles': 'false',
    'include-chapter-numbers': 'true',
    'include-crossrefs': 'false',
    'include-css-link': 'false',
    'inline-styles': 'false',
    'wrapping-div': 'false',
  });
  let res;
  try { res = await get(`${ESV_URL}?${q}`, { authorization: `Token ${keys().esv}` }); }
  catch { throw new BibleError('The ESV could not be reached just now.'); }
  if (res.status === 401 || res.status === 403) {
    console.error(`desk: ESV API refused the key (${res.status})`);
    throw new BibleError('The ESV refused this desk’s key.');
  }
  if (res.status === 429) throw new BibleError('The ESV has had too many lookups this hour. Try another translation for now.', 429);
  if (!res.ok) throw new BibleError(`The ESV said ${res.status}.`);
  const body = await res.json();
  const html = (body.passages || []).join('\n').trim();
  if (!html) throw new BibleError('The ESV has nothing at that reference.', 404);
  return {
    kind: 'html',
    html: html.slice(0, 400000),
    copyright: 'Scripture quotations are from the ESV® Bible (The Holy Bible, English Standard Version®), © 2001 by Crossway, a publishing ministry of Good News Publishers. Used by permission. All rights reserved.',
    // Crossway asks for a link to esv.org on every page that shows the text.
    link: 'https://www.esv.org/',
  };
}

async function fromApiBible(version, ref) {
  const id = books.toId(ref);
  const params = 'content-type=html&include-notes=false&include-titles=true&include-chapter-numbers=false&include-verse-numbers=true&include-verse-spans=false';
  let res = await ab(`bibles/${encodeURIComponent(version.bibleId)}/passages/${encodeURIComponent(id)}?${params}`);
  // A whole chapter sometimes answers only on the chapters endpoint.
  if (!res.ok && res.status !== 401 && ref.v1 == null && ref.c1 === ref.c2) {
    res = await ab(`bibles/${encodeURIComponent(version.bibleId)}/chapters/${encodeURIComponent(id)}?${params}`);
  }
  if (res.status === 401) {
    console.error('desk: API.Bible refused the key (401)');
    throw new BibleError('API.Bible refused this desk’s key.');
  }
  if (res.status === 403) throw new BibleError(`${version.abbrev} is not included on this desk’s API.Bible key.`, 403);
  if (res.status === 404 || res.status === 400) throw new BibleError(`${version.abbrev} has nothing at ${books.label(ref)}.`, 404);
  if (!res.ok) throw new BibleError(`API.Bible said ${res.status}.`);
  const body = await res.json();
  const html = String((body.data && body.data.content) || '').trim();
  if (!html) throw new BibleError(`${version.abbrev} has nothing at ${books.label(ref)}.`, 404);
  return {
    kind: 'html',
    html: html.slice(0, 400000),
    copyright: clean(body.data && body.data.copyright, 400) || version.name || '',
  };
}

async function fromFree(version, ref) {
  // bible-api.com reads "John 3-4" as John 3:4, so whole chapters go one at a time.
  if (ref.v1 == null && ref.c2 !== ref.c1) {
    const parts = [];
    for (let c = ref.c1; c <= ref.c2; c++) parts.push(await fromFree(version, { ...ref, c1: c, c2: c }));
    return { kind: 'verses', verses: parts.flatMap((p) => p.verses), copyright: parts[0].copyright };
  }
  const url = `${FREE_URL}${encodeURIComponent(books.toQuery(ref))}?translation=${version.id}`;
  let res;
  try { res = await get(url); } catch { throw new BibleError('The Bible service could not be reached just now.'); }
  if (res.status === 429) throw new BibleError('Too many lookups in a row. Wait a few seconds and try again.', 429);
  let body = null;
  try { body = await res.json(); } catch { /* handled below */ }
  if (res.status === 404 || (body && body.error && !body.verses)) throw new BibleError(`${version.abbrev} has nothing at ${books.label(ref)}.`, 404);
  if (!res.ok || !body || !Array.isArray(body.verses)) throw new BibleError(`The Bible service said ${res.status}.`);
  return {
    kind: 'verses',
    verses: body.verses.slice(0, 600).map((v) => ({ c: +v.chapter, v: +v.verse, text: clean(v.text, 4000) })),
    copyright: `${body.translation_name || version.name} · ${body.translation_note || 'Public domain'}`,
  };
}

module.exports = {
  versions, passage, BibleError,
  _reset: () => { cache.clear(); abList = null; abHost = null; },
  _setFetch: (fn) => { fetcher = fn || ((...args) => fetch(...args)); },
};
