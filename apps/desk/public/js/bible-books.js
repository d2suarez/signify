// ===================================================================
// Teacher's Desk — the books of the Bible, and reading a reference
//
// One file for both ends. The Bible widget parses what the teacher types
// ("Jn 3:16, Rom 8:28-30; Ps 23") into references, and the server reads the
// same table to turn a reference back into what each Bible service wants. A
// reference crosses the wire only as a short canonical id (JHN.3.16-JHN.3.18),
// which the server checks against this table, so nothing the teacher typed
// is ever passed through to another service as it was typed.
//
// Loaded as a plain script in the browser (window.DeskBible) and with
// require() on the server.
// ===================================================================

(function (root) {
  'use strict';

  // [name, API.Bible/USFM code, chapters, Blue Letter Bible code, short name, other spellings]
  const RAW = [
    ['Genesis', 'GEN', 50, 'gen', 'Gen', ['ge', 'gn']],
    ['Exodus', 'EXO', 40, 'exo', 'Exod', ['ex', 'exd']],
    ['Leviticus', 'LEV', 27, 'lev', 'Lev', ['le', 'lv']],
    ['Numbers', 'NUM', 36, 'num', 'Num', ['nu', 'nm', 'nb']],
    ['Deuteronomy', 'DEU', 34, 'deu', 'Deut', ['dt', 'de']],
    ['Joshua', 'JOS', 24, 'jos', 'Josh', ['jsh']],
    ['Judges', 'JDG', 21, 'jdg', 'Judg', ['jg', 'jdgs']],
    ['Ruth', 'RUT', 4, 'rth', 'Ruth', ['rut', 'ru']],
    ['1 Samuel', '1SA', 31, '1sa', '1 Sam', ['1sm', '1s']],
    ['2 Samuel', '2SA', 24, '2sa', '2 Sam', ['2sm', '2s']],
    ['1 Kings', '1KI', 22, '1ki', '1 Kgs', ['1kin', '1k']],
    ['2 Kings', '2KI', 25, '2ki', '2 Kgs', ['2kin', '2k']],
    ['1 Chronicles', '1CH', 29, '1ch', '1 Chr', ['1chron']],
    ['2 Chronicles', '2CH', 36, '2ch', '2 Chr', ['2chron']],
    ['Ezra', 'EZR', 10, 'ezr', 'Ezra', []],
    ['Nehemiah', 'NEH', 13, 'neh', 'Neh', ['ne']],
    ['Esther', 'EST', 10, 'est', 'Esth', ['es']],
    ['Job', 'JOB', 42, 'job', 'Job', ['jb']],
    ['Psalms', 'PSA', 150, 'psa', 'Ps', ['psalm', 'pss', 'psm']],
    ['Proverbs', 'PRO', 31, 'pro', 'Prov', ['prv', 'pr']],
    ['Ecclesiastes', 'ECC', 12, 'ecc', 'Eccl', ['ec', 'qoh', 'qoheleth']],
    ['Song of Solomon', 'SNG', 8, 'sng', 'Song', ['songofsongs', 'sos', 'ss', 'cant', 'canticles']],
    ['Isaiah', 'ISA', 66, 'isa', 'Isa', ['is']],
    ['Jeremiah', 'JER', 52, 'jer', 'Jer', ['je', 'jr']],
    ['Lamentations', 'LAM', 5, 'lam', 'Lam', ['la']],
    ['Ezekiel', 'EZK', 48, 'eze', 'Ezek', ['ezk']],
    ['Daniel', 'DAN', 12, 'dan', 'Dan', ['da', 'dn']],
    ['Hosea', 'HOS', 14, 'hos', 'Hos', ['ho']],
    ['Joel', 'JOL', 3, 'joe', 'Joel', ['jl']],
    ['Amos', 'AMO', 9, 'amo', 'Amos', ['am']],
    ['Obadiah', 'OBA', 1, 'oba', 'Obad', ['ob']],
    ['Jonah', 'JON', 4, 'jon', 'Jonah', ['jnh']],
    ['Micah', 'MIC', 7, 'mic', 'Mic', ['mc']],
    ['Nahum', 'NAM', 3, 'nah', 'Nah', ['na']],
    ['Habakkuk', 'HAB', 3, 'hab', 'Hab', ['hb']],
    ['Zephaniah', 'ZEP', 3, 'zep', 'Zeph', ['zp']],
    ['Haggai', 'HAG', 2, 'hag', 'Hag', ['hg']],
    ['Zechariah', 'ZEC', 14, 'zec', 'Zech', ['zc']],
    ['Malachi', 'MAL', 4, 'mal', 'Mal', ['ml']],
    ['Matthew', 'MAT', 28, 'mat', 'Matt', ['mt']],
    ['Mark', 'MRK', 16, 'mar', 'Mark', ['mk', 'mr']],
    ['Luke', 'LUK', 24, 'luk', 'Luke', ['lk', 'lu']],
    ['John', 'JHN', 21, 'jhn', 'John', ['jn', 'joh']],
    ['Acts', 'ACT', 28, 'act', 'Acts', ['ac']],
    ['Romans', 'ROM', 16, 'rom', 'Rom', ['ro', 'rm']],
    ['1 Corinthians', '1CO', 16, '1co', '1 Cor', []],
    ['2 Corinthians', '2CO', 13, '2co', '2 Cor', []],
    ['Galatians', 'GAL', 6, 'gal', 'Gal', ['ga']],
    ['Ephesians', 'EPH', 6, 'eph', 'Eph', ['ep']],
    ['Philippians', 'PHP', 4, 'phl', 'Phil', ['philip', 'phl']],
    ['Colossians', 'COL', 4, 'col', 'Col', []],
    ['1 Thessalonians', '1TH', 5, '1th', '1 Thess', ['1thes']],
    ['2 Thessalonians', '2TH', 3, '2th', '2 Thess', ['2thes']],
    ['1 Timothy', '1TI', 6, '1ti', '1 Tim', []],
    ['2 Timothy', '2TI', 4, '2ti', '2 Tim', []],
    ['Titus', 'TIT', 3, 'tit', 'Titus', ['ti']],
    ['Philemon', 'PHM', 1, 'phm', 'Phlm', ['philem', 'pm']],
    ['Hebrews', 'HEB', 13, 'heb', 'Heb', ['he']],
    ['James', 'JAS', 5, 'jas', 'Jas', ['jam', 'jm']],
    ['1 Peter', '1PE', 5, '1pe', '1 Pet', ['1pt', '1p']],
    ['2 Peter', '2PE', 3, '2pe', '2 Pet', ['2pt', '2p']],
    ['1 John', '1JN', 5, '1jo', '1 John', ['1jhn', '1j']],
    ['2 John', '2JN', 1, '2jo', '2 John', ['2jhn', '2j']],
    ['3 John', '3JN', 1, '3jo', '3 John', ['3jhn', '3j']],
    ['Jude', 'JUD', 1, 'jde', 'Jude', ['jud']],
    ['Revelation', 'REV', 22, 'rev', 'Rev', ['revelations', 're', 'apocalypse']],
  ];

  const BOOKS = RAW.map(([name, code, chapters, blb, short], index) => ({
    name, code, chapters, blb, short, index, testament: index < 39 ? 'old' : 'new',
  }));
  const BY_CODE = new Map(BOOKS.map((b) => [b.code, b]));

  const norm = (s) => String(s).toLowerCase().replace(/[\s.]+/g, '');
  const LOOKUP = new Map();
  RAW.forEach(([name, code, , blb, short, more], i) => {
    const keys = new Set([name, code, blb, short, ...more].map(norm));
    // Roman numerals for numbered books: "I John", "II Kings".
    for (const k of [...keys]) {
      const m = /^([123])(.+)$/.exec(k);
      if (m) { keys.add('iii'.slice(0, +m[1]) + m[2]); keys.add(['first', 'second', 'third'][m[1] - 1] + m[2]); }
    }
    for (const k of keys) if (!LOOKUP.has(k)) LOOKUP.set(k, BOOKS[i]);
  });

  /**
   * The book a teacher meant. Exact spellings first, then a unique prefix
   * ("phile" is Philemon, "phi" is not anything yet), so whatever abbreviation
   * they learned works without anyone listing it.
   */
  function findBook(raw) {
    const k = norm(raw);
    if (!k) return null;
    if (LOOKUP.has(k)) return LOOKUP.get(k);
    if (k.length < 3) return null;
    const hits = new Set();
    for (const [key, book] of LOOKUP) if (key.startsWith(k)) hits.add(book);
    return hits.size === 1 ? [...hits][0] : null;
  }

  // At most this many references in one lookup, and this many chapters in
  // one of them: a lesson's worth, and well inside what the Bible services
  // allow a single request to return.
  const MAX_REFS = 12;
  const MAX_CHAPTERS = 3;

  /**
   * Free text into references.
   *
   * "John 3:16-18, 20; Rom 8:28, Ps 23" gives four. A comma or semicolon
   * starts a new one; a bare number after a comma carries on in the same
   * book and chapter ("John 3:16, 18" is two verses of John 3), and "4:2"
   * carries on in the same book.
   *
   * A reference is { code, c1, v1, c2, v2 } — v1/v2 null for whole chapters.
   */
  function parse(input) {
    const refs = [];
    const errors = [];
    let ctx = null;
    const tokens = String(input || '').split(/[;,\n]+/).map((t) => t.trim()).filter(Boolean);
    for (const tok of tokens) {
      if (refs.length >= MAX_REFS) { errors.push(`Only the first ${MAX_REFS} passages are shown at once.`); break; }
      let book;
      let nums;
      if (/[a-z]/i.test(tok)) {
        const m = /^((?:[1-3]|i{1,3})?\s*[a-z][a-z\s.]*?)[\s.]*(\d[\d\s:.\-–—abc]*)?$/i.exec(tok);
        book = m && findBook(m[1]);
        if (!book) { errors.push(`Could not find a book called “${tok}”.`); ctx = null; continue; }
        nums = m[2] || '';
        ctx = null;
      } else {
        if (!ctx) { errors.push(`“${tok}” needs a book in front of it.`); continue; }
        book = ctx.book;
        nums = tok;
      }
      const r = numbers(nums, book, ctx);
      if (r.error) { errors.push(r.error); continue; }
      refs.push(r.ref);
      ctx = { book, chapter: r.ref.c2, hadVerse: r.ref.v1 != null };
    }
    return { refs, errors };
  }

  function numbers(raw, book, ctx) {
    const s = String(raw).replace(/[–—]/g, '-').replace(/\./g, ':').replace(/(\d)[abc]\b/gi, '$1')
      .replace(/\s+/g, '').replace(/[:-]+$/, '');
    const mk = (c1, v1, c2, v2) => ({ code: book.code, c1, v1, c2, v2 });
    if (!s) return { ref: mk(1, null, 1, null) };

    const m = /^(\d+)(?::(\d+))?(?:-(\d+)(?::(\d+))?)?$/.exec(s);
    if (!m) return { error: `Could not read “${book.name} ${raw}”.` };
    const a = +m[1];
    const b = m[2] != null ? +m[2] : null;
    const c = m[3] != null ? +m[3] : null;
    const d = m[4] != null ? +m[4] : null;

    let ref;
    if (ctx && ctx.hadVerse && b == null) ref = mk(ctx.chapter, a, ctx.chapter, c != null ? c : a);    // ", 18" or ", 18-20"
    else if (book.chapters === 1 && b == null && (a > 1 || c != null)) ref = mk(1, a, 1, c != null ? c : a); // Jude 5
    else if (b != null && d != null) ref = mk(a, b, c, d);      // 3:16-4:2
    else if (b != null && c != null) ref = mk(a, b, a, c);      // 3:16-18
    else if (b != null) ref = mk(a, b, a, b);                   // 3:16
    else if (c != null && d != null) ref = mk(a, 1, c, d);      // 3-4:2
    else if (c != null) ref = mk(a, null, c, null);             // 3-5
    else ref = mk(a, null, a, null);                            // 3

    if (ref.c2 < ref.c1) return { error: `${book.name} ${raw} runs backwards.` };
    if (ref.c1 === ref.c2 && ref.v1 != null && ref.v2 < ref.v1) [ref.v1, ref.v2] = [ref.v2, ref.v1];
    if (ref.c1 < 1 || ref.c2 > book.chapters) {
      return { error: `${book.name} has ${book.chapters} chapter${book.chapters > 1 ? 's' : ''}.` };
    }
    if ((ref.v1 != null && ref.v1 < 1) || ref.v2 === 0) return { error: `There is no verse 0 in ${book.name}.` };
    if (ref.c2 - ref.c1 + 1 > MAX_CHAPTERS) {
      return { error: `${book.name} ${raw} is more than ${MAX_CHAPTERS} chapters — look up a few at a time.` };
    }
    return { ref };
  }

  const bookOf = (ref) => BY_CODE.get(ref && ref.code) || null;

  /** "John 3:16–18", "Psalms 23", "Jude 5". */
  function label(ref) {
    const b = bookOf(ref);
    if (!b) return '';
    const D = '–';
    if (ref.v1 == null) return ref.c2 !== ref.c1 ? `${b.name} ${ref.c1}${D}${ref.c2}` : `${b.name} ${ref.c1}`;
    const head = b.chapters === 1 ? `${b.name} ` : `${b.name} ${ref.c1}:`;
    if (ref.c2 !== ref.c1) return `${b.name} ${ref.c1}:${ref.v1}${D}${ref.c2}:${ref.v2}`;
    return ref.v2 !== ref.v1 ? `${head}${ref.v1}${D}${ref.v2}` : `${head}${ref.v1}`;
  }

  /** The canonical id: JHN.3, JHN.3-JHN.4, JHN.3.16, JHN.3.16-JHN.3.18. */
  function toId(ref) {
    const c = ref.code;
    if (ref.v1 == null) return ref.c2 !== ref.c1 ? `${c}.${ref.c1}-${c}.${ref.c2}` : `${c}.${ref.c1}`;
    const start = `${c}.${ref.c1}.${ref.v1}`;
    return ref.c2 !== ref.c1 || ref.v2 !== ref.v1 ? `${start}-${c}.${ref.c2}.${ref.v2}` : start;
  }

  const ID = /^([1-3A-Z]{3})\.(\d{1,3})(?:\.(\d{1,3}))?(?:-([1-3A-Z]{3})\.(\d{1,3})(?:\.(\d{1,3}))?)?$/;

  /**
   * An id back into a reference, or null — the server's gate. It accepts only
   * what toId() can produce, for a real book, inside the same book, within
   * the chapter limit.
   */
  function fromId(id) {
    const m = ID.exec(String(id || ''));
    if (!m) return null;
    const book = BY_CODE.get(m[1]);
    if (!book || (m[4] && m[4] !== m[1])) return null;
    const c1 = +m[2];
    const v1 = m[3] != null ? +m[3] : null;
    const c2 = m[5] != null ? +m[5] : c1;
    const v2 = m[6] != null ? +m[6] : (m[5] != null ? null : v1);
    if ((v1 == null) !== (v2 == null)) return null;
    if (c1 < 1 || c2 < c1 || c2 > book.chapters || c2 - c1 + 1 > MAX_CHAPTERS) return null;
    if (v1 != null && (v1 < 1 || v2 < 1 || (c1 === c2 && v2 < v1))) return null;
    return { code: book.code, c1, v1, c2, v2 };
  }

  /** "John 3:16-18" — how Crossway and bible-api.com like to be asked. */
  function toQuery(ref) {
    const n = bookOf(ref).name;
    if (ref.v1 == null) return ref.c2 !== ref.c1 ? `${n} ${ref.c1}-${ref.c2}` : `${n} ${ref.c1}`;
    if (ref.c2 !== ref.c1) return `${n} ${ref.c1}:${ref.v1}-${ref.c2}:${ref.v2}`;
    return ref.v2 !== ref.v1 ? `${n} ${ref.c1}:${ref.v1}-${ref.v2}` : `${n} ${ref.c1}:${ref.v1}`;
  }

  // Blue Letter Bible's own names for the translations it carries. Anything
  // else opens there in the KJV, which every page of theirs has.
  const BLB_VERSIONS = {
    ESV: 'esv', NIV: 'niv', NKJV: 'nkjv', KJV: 'kjv', NLT: 'nlt', CSB: 'csb', NASB: 'nasb20', NASB2020: 'nasb20',
    NASB1995: 'nasb95', NASB95: 'nasb95', LSB: 'lsb', AMP: 'amp', NET: 'net', RSV: 'rsv', ASV: 'asv', YLT: 'ylt', WEB: 'web',
  };

  /**
   * The same passage on Blue Letter Bible: the chapter, scrolled to the first
   * verse. `verse` narrows it to one verse of the chapter given.
   */
  function blbUrl(ref, versionAbbrev, chapter, verse) {
    const b = bookOf(ref);
    if (!b) return 'https://www.blueletterbible.org/';
    const v = BLB_VERSIONS[String(versionAbbrev || '').toUpperCase().replace(/[^A-Z0-9]/g, '')] || 'kjv';
    const c = chapter || ref.c1;
    const at = verse || (chapter ? 1 : ref.v1 || 1);
    return `https://www.blueletterbible.org/${v}/${b.blb}/${c}/${at}/`;
  }

  /** The chapter before or after, across book boundaries; null at either end. */
  function adjacent(code, chapter, dir) {
    const book = BY_CODE.get(code);
    if (!book) return null;
    const c = chapter + dir;
    if (c >= 1 && c <= book.chapters) return { code, c1: c, v1: null, c2: c, v2: null };
    const next = BOOKS[book.index + dir];
    if (!next) return null;
    const nc = dir < 0 ? next.chapters : 1;
    return { code: next.code, c1: nc, v1: null, c2: nc, v2: null };
  }

  const api = { BOOKS, BY_CODE, findBook, parse, label, toId, fromId, toQuery, blbUrl, adjacent, bookOf, MAX_REFS, MAX_CHAPTERS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DeskBible = api;
}(typeof window !== 'undefined' ? window : this));
