// ===================================================================
// Widget — Passage grader
//
// For marking a memorised passage — a verse, a poem, a speech — that pupils
// have typed out from memory. The teacher sets the passage once, pastes each
// pupil's answer, and sees how many of the words they got right out of how
// many there are, with the passage marked up word by word: right, misspelled,
// missing, and anything they added.
//
// The marking rules are the teacher's: whether punctuation counts, whether
// capitals do, and how hard spelling is marked. Every saved answer is kept, so
// changing a rule re-marks the whole class, not just the next pupil.
//
// How the matching works: both texts are cut into words (and punctuation
// marks, if they count), then lined up with each other the way a teacher
// would with a red pen — the longest run of agreement, in order. A word the
// pupil skipped does not knock every word after it out of place, and a word
// typed twice is simply one extra.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon, toast, append } = Desk;

  const MAX_PASSAGE = 3000;       // about 550 words — more than a term's verses
  const MAX_ANSWER = 3000;
  const MAX_RESULTS = 40;         // a class, with room for the odd resit
  const MAX_TOKENS = 1200;        // the line-up is n×m; this keeps it instant

  const RULES = {
    punctuation: [
      { key: 'ignore', label: 'Ignore', say: 'punctuation ignored' },
      { key: 'count', label: 'Mark it', say: 'punctuation marked' },
    ],
    capitals: [
      { key: 'ignore', label: 'Ignore', say: 'capitals ignored' },
      { key: 'count', label: 'Mark them', say: 'capitals marked' },
    ],
    spelling: [
      { key: 'exact', label: 'Exact', say: 'spelling exact' },
      { key: 'half', label: 'Half credit', say: 'half credit for near misses' },
      { key: 'forgive', label: 'Forgive typos', say: 'small typos forgiven' },
    ],
  };

  // ---------- hidden characters ----------
  //
  // A teacher can hand out a copy of the passage with letters swapped for ones
  // that look identical — a Cyrillic "\u0430" for an "a", a capital I for an "l" —
  // or with invisible characters tucked inside words. A pupil who types the
  // passage never produces them; one who pastes it does. Marking sees through
  // them (a pasted word is still the right word) and reports them separately.

  // Each look-alike letter from another alphabet, followed by the Latin letter
  // it passes for: pairs of two characters.
  const LOOKALIKES = '\u0430a\u0435e\u043Eo\u0440p\u0441c\u0445x\u0443y\u0456i\u0458j\u0455s\u0501d\u051Bq\u051Dw\u04BBh\u04CFl\u0410A\u0412B\u0421C\u0415E\u041DH\u0406I\u0408J\u041AK\u041CM\u041EO\u0420P\u0405S\u0422T\u0425X\u0423Y\u03BFo\u03BDv\u039FO\u0391A\u0392B\u0395E\u0396Z\u0397H\u0399I\u039AK\u039CM\u039DN\u03A1P\u03A4T\u03A5Y\u03A7X';
  const FOLD = {};
  for (let i = 0; i < LOOKALIKES.length; i += 2) FOLD[LOOKALIKES[i]] = LOOKALIKES[i + 1];
  const UNFOLD = {};
  for (const [odd, plain] of Object.entries(FOLD)) if (!UNFOLD[plain]) UNFOLD[plain] = odd;

  // Zero-width spaces and joiners, soft hyphens, direction marks, the byte-order mark.
  const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
  const isInvisible = (ch) => { INVISIBLE.lastIndex = 0; return INVISIBLE.test(ch); };

  /** The text as it reads: invisible characters dropped, look-alikes made the letters they imitate. */
  function deconfuse(text) {
    let out = '';
    for (const ch of String(text == null ? '' : text).replace(INVISIBLE, '')) out += FOLD[ch] || ch;
    return out;
  }

  // Letters that pass for one another in most fonts, as they are typed: I and l, l and 1, O and 0.
  const LOOK_PAIRS = ['il', 'l1', 'o0'];
  const alike = (a, b) => a === b || LOOK_PAIRS.some((p) => p.includes(a) && p.includes(b));
  function looksAlike(a, b) {
    if (a.length !== b.length || a === b) return false;
    for (let i = 0; i < a.length; i += 1) if (!alike(a[i], b[i])) return false;
    return true;
  }

  // ---------- reading the two texts ----------

  /** Curly quotes, long dashes and ellipses typed a dozen ways, made one way. */
  function normalise(text) {
    return deconfuse(String(text == null ? '' : text).normalize('NFC'))
      .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
      .replace(/\u2026/g, '...')
      // A long dash is a mark between words, never part of one — even
      // unspaced — so "said—and" reads as two words and a dash.
      .replace(/\s*(?:[\u2013\u2014\u2015]|--+)\s*/g, ' - ')
      .replace(/[\u2010\u2011]/g, '-');
  }

  // A word keeps an inner apostrophe or hyphen (Lord's, well-being). Anything
  // else that is not a letter, digit or space is a mark; a run of the same
  // mark ("...", "!!") is one.
  const TOKEN = /([\p{L}\p{M}\p{N}]+(?:['-][\p{L}\p{M}\p{N}]+)*)|(([^\s\p{L}\p{M}\p{N}])\3*)/gu;

  // A scripture reference — "Proverbs 3:7, 8", "1 John 2:15-17", "Song of
  // Solomon 2:4" — is three points, not four or five: the book, the chapter and
  // the verses. The verses ("7, 8", "7-8", "7 and 8") are one unit, and so is a
  // book of several words. It has to be the colon form; a bare "Proverbs 3 7"
  // is read as ordinary words.
  const REFERENCE = /((?:[123]\s*)?\p{L}+(?:\s+of\s+\p{L}+)?)\s+(\d{1,3})\s*:\s*(\d{1,3}(?:\s*(?:[-,&]|and)\s*\d{1,3})*)/giu;

  function tokenize(text, rules) {
    const out = [];
    const src = normalise(text);
    const full = () => out.length >= MAX_TOKENS;
    const caps = (k) => (rules.capitals !== 'count' ? k.toLocaleLowerCase() : k);

    const scan = (chunk) => {
      for (const m of chunk.matchAll(TOKEN)) {
        if (full()) return;
        if (m[1]) {
          let key = m[1];
          // Ignoring punctuation means the apostrophe in "Lord's" and the hyphen
          // in "well-being" do not count either — "Lords" and "wellbeing" are
          // right.
          if (rules.punctuation !== 'count') key = key.replace(/['-]/g, '');
          out.push({ kind: 'word', text: m[1], key: caps(key) });
        } else if (rules.punctuation === 'count') {
          out.push({ kind: 'mark', text: m[2], key: m[3] });
        }
      }
    };

    let last = 0;
    for (const r of src.matchAll(REFERENCE)) {
      scan(src.slice(last, r.index));
      const verses = r[3].replace(/\s+/g, '').replace(/and|&/gi, ',');
      out.push({ kind: 'word', text: r[1], key: caps(r[1].replace(/\s+/g, '')) });
      out.push({ kind: 'word', text: r[2], key: r[2] });
      out.push({ kind: 'word', text: r[3].replace(/\s+/g, ' '), key: verses });
      last = r.index + r[0].length;
    }
    scan(src.slice(last));
    return out.slice(0, MAX_TOKENS);
  }

  // ---------- how close is close ----------

  /** Edits between two words, a swapped pair of letters counting as one. */
  function distance(a, b) {
    if (a === b) return 0;
    const n = a.length;
    const m = b.length;
    if (Math.abs(n - m) > 2) return 3;             // never close; skip the work
    let prev2 = null;
    let prev = Array.from({ length: m + 1 }, (_, j) => j);
    for (let i = 1; i <= n; i += 1) {
      const row = [i];
      for (let j = 1; j <= m; j += 1) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
        if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
        row.push(v);
      }
      prev2 = prev;
      prev = row;
    }
    return prev[m];
  }

  /**
   * How a typed word stands to the word it should have been: 'exact',
   * 'capital' (right but for capitals), 'lookalike' (an l for an I), 'spelling'
   * (a near miss), or null — a different word.
   *
   * Near is judged against the length of the real word: one slip in a word
   * of four to seven letters, two from eight up. Short words get no slack at
   * all bar two letters swapped ("teh"), because one letter is the whole
   * difference between "is" and "it".
   */
  function kinship(want, got) {
    if (want === got) return 'exact';
    const a = want.toLocaleLowerCase();
    const b = got.toLocaleLowerCase();
    if (a === b) return 'capital';
    if (looksAlike(a, b)) return 'lookalike';
    const d = distance(a, b);
    const allowed = a.length >= 8 ? 2 : a.length >= 4 ? 1 : 0;
    if (d <= allowed) return 'spelling';
    if (d === 1 && a.length === b.length && [...a].sort().join('') === [...b].sort().join('')) return 'spelling';
    return null;
  }

  const WEIGHT = { exact: 8, lookalike: 6, capital: 4, spelling: 2 };

  function relation(want, got) {
    if (want.kind !== got.kind) return null;
    if (want.kind === 'mark') return want.key === got.key ? 'exact' : null;
    return kinship(want.key, got.key);
  }

  /**
   * Lines the pupil's words up against the passage: the in-order pairing
   * with the most agreement, exact matches worth more than near ones. Returns
   * the passage as a list of steps — each word of it matched, near-matched
   * or missing — with the pupil's extra words in the places they typed them.
   */
  function align(want, got) {
    const n = want.length;
    const m = got.length;
    const W = m + 1;
    const T = new Int32Array((n + 1) * (m + 1));
    for (let i = 1; i <= n; i += 1) {
      for (let j = 1; j <= m; j += 1) {
        let best = Math.max(T[(i - 1) * W + j], T[i * W + j - 1]);
        const r = relation(want[i - 1], got[j - 1]);
        if (r) best = Math.max(best, T[(i - 1) * W + j - 1] + WEIGHT[r]);
        T[i * W + j] = best;
      }
    }
    const steps = [];
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
      const here = T[i * W + j];
      const r = i > 0 && j > 0 ? relation(want[i - 1], got[j - 1]) : null;
      if (r && here === T[(i - 1) * W + j - 1] + WEIGHT[r]) {
        steps.push({ is: r, want: want[i - 1], got: got[j - 1] }); i -= 1; j -= 1;
      } else if (i > 0 && here === T[(i - 1) * W + j]) {
        steps.push({ is: 'missing', want: want[i - 1] }); i -= 1;
      } else {
        steps.push({ is: 'extra', got: got[j - 1] }); j -= 1;
      }
    }
    return steps.reverse();
  }

  /** What each kind of step earns, under these rules. */
  function credit(step, rules) {
    // A look-alike letter is the right word: it is reported, not marked down.
    if (step.is === 'exact' || step.is === 'lookalike') return 1;
    // Near misses — a slip of spelling, or of capitals when capitals count —
    // are what the spelling rule decides. Forgiving typos does not forgive
    // capitals: if the teacher is marking capitals, a lower-case "lord" is
    // the thing being marked.
    if (step.is === 'spelling') return rules.spelling === 'forgive' ? 1 : rules.spelling === 'half' ? 0.5 : 0;
    if (step.is === 'capital') return rules.spelling === 'half' ? 0.5 : 0;
    return 0;
  }

  /**
   * The whole mark for one answer. `total` is every word (and mark, if they
   * count) in the passage; `score` is what was earned of it. Words the pupil
   * added are shown but cost nothing — the mark is how much of the passage
   * they have, which is what memorising is.
   */
  /**
   * `overrides` is the teacher's own word on a word: { position: 1 or 0 },
   * right or wrong whatever the rules said. A position is the word's place in
   * the passage — "w12" is its twelfth word, "m3" its third punctuation mark —
   * so the decision stays on that word when the rules change, which counting
   * steps would not (marking punctuation adds steps between the words).
   *
   * A word the pupil ADDED costs nothing unless the teacher says it does:
   * { "x5": 1 } counts the sixth word of their answer against them ("y" for
   * a punctuation mark). Those are placed in the answer, not the passage,
   * because an added word is not in the passage to be placed.
   */
  function grade(passage, answer, rules, overrides = {}) {
    const want = tokenize(passage, rules);
    const got = tokenize(answer, rules);
    const steps = align(want, got);
    const tally = { exact: 0, lookalike: 0, capital: 0, spelling: 0, missing: 0, extra: 0, changed: 0 };
    const words = { got: 0, total: 0 };
    const marks = { got: 0, total: 0 };
    let w = 0;
    let m = 0;
    let gw = 0;                 // place in the pupil's answer, words and marks apart
    let gm = 0;
    let cost = 0;
    const has = (k) => !!overrides && Object.prototype.hasOwnProperty.call(overrides, k);
    for (const step of steps) {
      tally[step.is] += 1;
      const at = step.got ? (step.got.kind === 'mark' ? `y${gm++}` : `x${gw++}`) : null;
      if (step.is === 'extra') {
        step.pos = at;
        step.auto = 0;
        step.credit = has(at) && overrides[at] === 1 ? -1 : 0;
        if (step.credit) { cost += 1; tally.changed += 1; }
        continue;
      }
      step.pos = step.want.kind === 'mark' ? `m${m++}` : `w${w++}`;
      step.auto = credit(step, rules);
      // Only a word the rules marked down can be put right, and put back.
      const mine = step.is !== 'exact' && has(step.pos)
        ? (overrides[step.pos] ? 1 : 0) : null;
      const c = mine === null || mine === step.auto ? step.auto : mine;
      if (c !== step.auto) tally.changed += 1;
      step.credit = c;
      const bucket = step.want.kind === 'mark' ? marks : words;
      bucket.total += 1;
      bucket.got += c;
    }
    // Added words counted against the pupil come off the whole mark, never
    // below nothing.
    const score = Math.max(0, words.got + marks.got - cost);
    const total = words.total + marks.total;
    return { steps, tally, words, marks, cost, score, total, percent: total ? Math.round((score / total) * 100) : 0 };
  }

  /** Positions like "w12" or "m3", each 1 or 0; anything else dropped. */
  function cleanOverrides(o) {
    const out = {};
    if (!o || typeof o !== 'object') return out;
    for (const [k, v] of Object.entries(o)) {
      if (/^[wmxy]\d{1,4}$/.test(k) && (v === 0 || v === 1)) out[k] = v;
      if (Object.keys(out).length >= MAX_TOKENS) break;
    }
    return out;
  }

  /** Words only — no punctuation, whatever the rules — for the counts shown beside each text. */
  const wordCount = (text) => tokenize(text, { punctuation: 'ignore', capitals: 'ignore' }).length;
  const words = (n) => `${n} word${n === 1 ? '' : 's'}`;

  /** 46.5 as "46½" — a half mark is common here, and a decimal reads as fussy. */
  const half = (n) => (Number.isInteger(n) ? String(n) : `${Math.floor(n)}½`);

  // ---------- anti-copy versions ----------

  const STRENGTH = [
    { key: 'light', label: 'Light', every: 10, say: 'about one word in ten' },
    { key: 'medium', label: 'Medium', every: 5, say: 'about one word in five' },
    { key: 'heavy', label: 'Heavy', every: 2.5, say: 'about two words in five' },
  ];
  const MAX_COPIES = 40;
  const GHOSTS = ['​', '‌', '⁠'];

  /** Letters and digits only, look-alikes read as what they imitate: the word, as a key. */
  const plain = (text) => deconfuse(text).toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const isAlnum = (ch) => /[\p{L}\p{N}]/u.test(ch);
  /** One planted character, named by the word it sits in, where, and what it is. */
  const markId = (key, at, ch) => `${key}:${at}:${ch.codePointAt(0).toString(16)}`;

  function seeded(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * One version of the passage that reads the same and is not: in a scattering
   * of words, a letter from another alphabet, an I swapped for an l (or back),
   * or an invisible character tucked between two letters. The same passage,
   * seed and strength always make the same version — so a copy never has to
   * be stored, and a pasted answer can be traced back to the copy it came from.
   * `ids` names every planted character, which is that trace.
   */
  function makeCopy(passage, seed, strength) {
    const base = deconfuse(String(passage || '').normalize('NFC'));
    const rand = seeded(seed);
    const level = STRENGTH.find((x) => x.key === strength) || STRENGTH[1];
    const found = [...base.matchAll(/\S+/g)];
    const want = Math.min(found.length, Math.max(3, Math.round(found.length / level.every)));
    const order = found.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const edits = [];
    const ids = new Set();
    for (const n of order) {
      if (edits.length >= want) break;
      const { 0: word, index } = found[n];
      const glyphs = [];
      const swaps = [];
      const ghosts = [];
      for (let j = 0; j < word.length; j += 1) {
        const ch = word[j];
        if (UNFOLD[ch] && /[A-Za-z]/.test(ch)) glyphs.push(j);
        if (ch === 'I' || ch === 'l') swaps.push(j);
        if (j > 0 && isAlnum(word[j - 1]) && isAlnum(ch)) ghosts.push(j);
      }
      const kinds = [['glyph', glyphs], ['swap', swaps], ['ghost', ghosts]].filter(([, at]) => at.length);
      if (!kinds.length) continue;
      const [kind, spots] = kinds[Math.floor(rand() * kinds.length)];
      const j = spots[Math.floor(rand() * spots.length)];
      const key = plain(word);
      const before = [...word.slice(0, j)].filter(isAlnum).length;
      if (kind === 'glyph') {
        const ch = UNFOLD[word[j]];
        edits.push({ at: index + j, drop: 1, put: ch });
        ids.add(markId(key, before, ch));
      } else if (kind === 'swap') {
        const ch = word[j] === 'I' ? 'l' : 'I';
        edits.push({ at: index + j, drop: 1, put: ch });
        ids.add(markId(key, before, ch.toLocaleLowerCase()));
      } else {
        const ch = GHOSTS[Math.floor(rand() * GHOSTS.length)];
        edits.push({ at: index + j, drop: 0, put: ch });
        ids.add(markId(key, before, ch));
      }
    }
    let text = base;
    for (const e of edits.sort((a, b) => b.at - a.at)) text = text.slice(0, e.at) + e.put + text.slice(e.at + e.drop);
    return { text, ids, count: edits.length };
  }

  /**
   * What in a pasted answer a keyboard would not have produced: invisible
   * characters and look-alike letters from another alphabet (`hidden`), and,
   * from the marking, an I where an l belongs or the like (`looks`). `ids`
   * names each one the way makeCopy does, to be matched against the copies.
   */
  function inspect(answer, result) {
    const ids = new Set();
    let hidden = 0;
    for (const m of String(answer || '').normalize('NFC').matchAll(/\S+/g)) {
      const key = plain(m[0]);
      let at = 0;
      for (const ch of m[0]) {
        if (isInvisible(ch) || FOLD[ch]) {
          hidden += 1;
          if (key) ids.add(markId(key, at, ch));
        }
        if (isAlnum(FOLD[ch] || ch)) at += 1;
      }
    }
    let looks = 0;
    for (const step of result ? result.steps : []) {
      if (step.is !== 'lookalike') continue;
      looks += 1;
      const a = plain(step.want.text);
      const b = plain(step.got.text);
      const at = [...a].findIndex((c, i) => c !== b[i]);
      if (at >= 0) ids.add(markId(a, at, b[at]));
    }
    return { hidden, looks, ids };
  }

  /** The copies a set of planted characters came from, best first: [{ index, hits }]. */
  function tracedTo(ids, versions) {
    if (!ids.size) return [];
    const need = Math.max(2, Math.ceil(ids.size / 2));
    const hits = versions.map((v, index) => {
      let n = 0;
      for (const id of ids) if (v.ids.has(id)) n += 1;
      return { index, hits: n };
    }).filter((x) => x.hits >= Math.min(need, ids.size));
    const top = Math.max(0, ...hits.map((x) => x.hits));
    return hits.filter((x) => x.hits === top);
  }

  // ---------- the widget ----------

  Desk.widget({
    type: 'passage',
    added: '2026-09-29',
    news: 'Paste a pupil’s memorised passage and see, word by word, how much they got right.',
    name: 'Passage grader',
    blurb: 'Mark a memorised passage: paste each pupil’s typed answer and see how many words they got right, word by word.',
    icon: 'check',
    category: 'class',
    tone: 'card',
    guest: true,
    size: { w: 6, h: 9 },
    min: { w: 4, h: 6 },

    init(s) {
      if (typeof s.title !== 'string') s.title = '';
      if (typeof s.passage !== 'string') s.passage = '';
      // Half credit for near misses to start: the kindest rule that still
      // tells a pupil which words to go back to.
      if (!RULES.spelling.some((o) => o.key === s.spelling)) s.spelling = 'half';
      if (!RULES.punctuation.some((o) => o.key === s.punctuation)) s.punctuation = 'ignore';
      if (!RULES.capitals.some((o) => o.key === s.capitals)) s.capitals = 'ignore';
      if (typeof s.classKey !== 'string') s.classKey = '';
      if (!s.draft || typeof s.draft !== 'object') s.draft = { name: '', answer: '', id: '', overrides: {} };
      if (typeof s.draft.name !== 'string') s.draft.name = '';
      if (typeof s.draft.answer !== 'string') s.draft.answer = '';
      if (typeof s.draft.id !== 'string') s.draft.id = '';
      s.draft.overrides = cleanOverrides(s.draft.overrides);
      if (!STRENGTH.some((x) => x.key === s.copyStrength)) s.copyStrength = 'medium';
      s.copyCount = Math.min(MAX_COPIES, Math.max(1, Math.round(Number(s.copyCount)) || 1));
      // The copies handed out: the passage they were made from, and a seed for
      // each — the copies themselves are made again from those, never stored.
      const c = s.copies;
      s.copies = c && typeof c === 'object' && typeof c.passage === 'string' && Array.isArray(c.seeds) && c.seeds.length
        ? {
          passage: c.passage.slice(0, MAX_PASSAGE),
          strength: STRENGTH.some((x) => x.key === c.strength) ? c.strength : 'medium',
          seeds: c.seeds.slice(0, MAX_COPIES).map((n) => (Number(n) >>> 0)),
          names: (Array.isArray(c.names) ? c.names : []).slice(0, MAX_COPIES).map((n) => String(n || '').slice(0, 60)),
        }
        : null;
      if (!Array.isArray(s.results)) s.results = [];
      s.results = s.results
        .filter((r) => r && typeof r.answer === 'string')
        .map((r) => ({ id: String(r.id || ''), name: String(r.name || '').slice(0, 60), answer: r.answer.slice(0, MAX_ANSWER), at: Number(r.at) || 0, overrides: cleanOverrides(r.overrides) }))
        .filter((r) => r.id)
        .slice(0, MAX_RESULTS);
    },

    holdsContent: (s) => (s.results.length
      ? `${s.results.length} saved score${s.results.length === 1 ? '' : 's'} go with it.`
      : (s.passage.trim() ? 'The passage goes with it.' : '')),

    mount(ctx) {
      const s = ctx.state;
      const rules = () => ({ punctuation: s.punctuation, capitals: s.capitals, spelling: s.spelling });
      let editingPassage = !s.passage.trim();
      // A saved answer opened back up to look at or fix. Kept with the draft,
      // so opening the tool larger does not turn a correction into a duplicate.
      let editingId = s.results.some((r) => r.id === s.draft.id) ? s.draft.id : null;
      let pupils = [];

      /* Two layouts from the same parts. On the card, one column: passage,
         rules, answer, mark. Opened large, the passage and the pupil's answer
         sit side by side under headings that line up, so the teacher reads
         straight across from one to the other; the marked passage and the
         saved scores sit underneath. */
      const wide = !!ctx.expanded;
      const wrap = el(wide ? 'div.pg.pg--wide' : 'div.pg');
      const passageHead = el('div.pg-head.pg-passage-head');     // wide only
      const whoHead = el('div.pg-head.pg-who-head');             // wide only
      const passageBox = el('section.pg-passage');
      const rulesBox = el('details.pg-rules', { open: wide ? true : null });
      const copiesBox = el('details.pg-rules.pg-copies');
      const gradeBox = el('section.pg-grade');
      const resultBox = el('section.pg-result', { 'aria-live': 'polite' });
      const savedBox = el('section.pg-saved');
      if (wide) {
        wrap.append(
          el('div.pg-pair', {}, [passageHead, whoHead, passageBox, gradeBox]),
          el('div.pg-below', {}, [resultBox, el('div.pg-side', {}, [savedBox, rulesBox, copiesBox])]),
        );
      } else {
        wrap.append(
          el('div.pg-left', {}, [passageBox, rulesBox, copiesBox, gradeBox]),
          el('div.pg-right', {}, [resultBox, savedBox]),
        );
      }
      ctx.root.append(wrap);

      // ---------- the passage ----------

      function drawPassage() {
        Desk.clear(passageBox);
        if (wide) { drawPassageWide(); return; }
        if (editingPassage) {
          const title = el('input.input.pg-title', {
            type: 'text', maxlength: '80', value: s.title, placeholder: 'Name it (optional) — e.g. Psalm 23',
            'aria-label': 'Name of the passage',
          });
          const text = el('textarea.textarea.pg-passage-text', {
            rows: ctx.expanded ? 9 : 5, maxlength: String(MAX_PASSAGE), value: s.passage,
            placeholder: 'Paste the passage exactly as the pupils learned it.', 'aria-label': 'The passage',
          });
          const done = () => {
            if (!text.value.trim()) { toast('Paste the passage first.', 'warn'); text.focus(); return; }
            const changed = text.value !== s.passage;
            s.title = title.value.trim().slice(0, 80);
            s.passage = text.value.slice(0, MAX_PASSAGE);
            editingPassage = false;
            // Every decision about a word was about the old passage's words.
            if (changed) {
              s.draft.overrides = {};
              for (const r of s.results) r.overrides = {};
            }
            ctx.save();
            drawPassage();
            paint();
            if (changed && s.results.length) toast('The saved scores have been re-marked against the new passage.');
          };
          const typing = el('span.hint.pg-count', { text: words(wordCount(s.passage)) });
          text.addEventListener('input', () => { typing.textContent = words(wordCount(text.value)); });
          append(passageBox,
            el('div.pg-row', {}, [el('div.pg-label', { text: 'The passage' }), typing]),
            title, text,
            el('div.pg-row', {}, [
              el('button.btn.btn--primary.btn--small', { svg: icon('check', 14), onclick: done }, ' Use this passage'),
              s.passage.trim() ? el('button.btn.btn--small.btn--ghost', { text: 'Cancel', onclick: () => { editingPassage = false; drawPassage(); } }) : null,
            ]),
          );
          return;
        }
        const count = wordCount(s.passage);
        passageBox.append(el('div.pg-row.pg-passage-set', {}, [
          el('div.pg-passage-name', {}, [
            el('strong', { text: s.title || 'The passage' }),
            el('span.hint.pg-count', { text: words(count) }),
          ]),
          el('button.btn.btn--small.btn--ghost', { text: 'Change', onclick: () => { editingPassage = true; drawPassage(); } }),
        ]));
      }

      /** Opened large: the heading above, the whole passage below it. */
      function drawPassageWide() {
        Desk.clear(passageHead);
        const count = wordCount(s.passage);
        if (editingPassage) {
          const title = el('input.input.pg-title', {
            type: 'text', maxlength: '80', value: s.title, placeholder: 'Name it (optional) — e.g. Psalm 23',
            'aria-label': 'Name of the passage',
          });
          const text = el('textarea.textarea.pg-passage-text', {
            maxlength: String(MAX_PASSAGE), value: s.passage,
            placeholder: 'Paste the passage exactly as the pupils learned it.', 'aria-label': 'The passage',
          });
          const done = () => {
            if (!text.value.trim()) { toast('Paste the passage first.', 'warn'); text.focus(); return; }
            const changed = text.value !== s.passage;
            s.title = title.value.trim().slice(0, 80);
            s.passage = text.value.slice(0, MAX_PASSAGE);
            editingPassage = false;
            // Every decision about a word was about the old passage's words.
            if (changed) {
              s.draft.overrides = {};
              for (const r of s.results) r.overrides = {};
            }
            ctx.save();
            drawPassage();
            paint();
            if (changed && s.results.length) toast('The saved scores have been re-marked against the new passage.');
          };
          const typing = el('span.hint.pg-count', { text: words(wordCount(s.passage)) });
          text.addEventListener('input', () => { typing.textContent = words(wordCount(text.value)); });
          append(passageHead, el('span.pg-label', { text: 'The passage' }), title, typing);
          append(passageBox, text, el('div.pg-row', {}, [
            el('button.btn.btn--primary.btn--small', { svg: icon('check', 14), onclick: done }, ' Use this passage'),
            s.passage.trim() ? el('button.btn.btn--small.btn--ghost', { text: 'Cancel', onclick: () => { editingPassage = false; drawPassage(); } }) : null,
          ]));
          return;
        }
        append(passageHead,
          el('span.pg-label', { text: 'The passage' }),
          el('div.pg-passage-name', {}, [
            el('strong', { text: s.title || 'Untitled' }),
            el('span.hint.pg-count', { text: words(count) }),
          ]),
          el('button.btn.btn--small.btn--ghost', { text: 'Change', onclick: () => { editingPassage = true; drawPassage(); } }),
        );
        passageBox.append(el('div.pg-original', { text: s.passage }));
      }

      // ---------- the rules ----------

      function drawRules() {
        Desk.clear(rulesBox);
        const say = Object.entries(RULES).map(([k, opts]) => opts.find((o) => o.key === s[k]).say).join(' · ');
        rulesBox.append(el('summary', {}, [el('span.pg-label', { text: 'Marking' }), el('span.pg-rules-say', { text: say })]));
        const row = (label, key, hint) => el('div.pg-rule', {}, [
          el('span.pg-rule-name', { text: label }),
          el('div.seg.seg--tiny', {}, RULES[key].map((o) => el('button.seg-btn', {
            text: o.label, class: s[key] === o.key ? 'is-on' : '', 'aria-pressed': String(s[key] === o.key),
            onclick: () => { s[key] = o.key; ctx.save(); drawRules(); rulesBox.open = true; paint(); },
          }))),
          hint ? el('p.hint.pg-rule-hint', { text: hint }) : null,
        ]);
        rulesBox.append(
          row('Punctuation', 'punctuation', s.punctuation === 'count' ? 'Each comma, full stop and quotation mark is a point of its own.' : ''),
          row('Capitals', 'capitals', ''),
          row('Spelling', 'spelling', {
            exact: 'A misspelled word earns nothing.',
            half: 'A near miss — one slip in a short word, two in a long one — earns half.',
            forgive: 'A near miss earns the full word. A different word still earns nothing.',
          }[s.spelling]),
        );
      }

      // ---------- anti-copy versions ----------

      // The versions are made again from their seeds when needed, and kept
      // only for as long as this card is open.
      const built = new Map();
      const versionOf = (i) => {
        const c = s.copies;
        const key = `${c.seeds[i]}|${c.strength}`;
        if (!built.has(key)) built.set(key, makeCopy(c.passage, c.seeds[i], c.strength));
        return built.get(key);
      };
      const copyLabel = (i) => `Copy ${i + 1}${s.copies.names[i] ? ` — ${s.copies.names[i]}` : ''}`;

      function makeCopies() {
        if (!s.passage.trim()) { toast('Set the passage first.', 'warn'); return; }
        const n = s.copyCount;
        const seeds = Array.from({ length: n }, () => Math.floor(Math.random() * 2 ** 31) + 1);
        // With a class chosen, the copies go to its pupils in the order they are listed, so
        // a pasted answer can be traced back to who was given that copy.
        const names = seeds.map((_, i) => (pupils[i] ? pupils[i].name : ''));
        s.copies = { passage: s.passage, strength: s.copyStrength, seeds, names };
        built.clear();
        ctx.save();
        drawCopies();
        copiesBox.open = true;
        paint();
      }

      function drawCopies() {
        const open = copiesBox.open;
        Desk.clear(copiesBox);
        const c = s.copies;
        copiesBox.append(el('summary', {}, [
          el('span.pg-label', { text: 'Anti-copy versions' }),
          el('span.pg-rules-say', { text: c ? `${c.seeds.length} version${c.seeds.length === 1 ? '' : 's'} made` : 'Catch pasted answers' }),
        ]));
        const level = STRENGTH.find((x) => x.key === s.copyStrength);
        const count = el('input.input.pg-copy-count', {
          type: 'number', min: '1', max: String(MAX_COPIES), value: String(s.copyCount), 'aria-label': 'How many versions',
          oninput: (e) => { s.copyCount = Math.min(MAX_COPIES, Math.max(1, Math.round(Number(e.target.value)) || 1)); ctx.save(); },
        });
        copiesBox.append(
          el('p.hint', { text: 'Hand out a version that reads exactly like the passage but hides characters a keyboard would not type — letters from other alphabets, an I for an l, invisible marks. A pasted answer carries them in, and is flagged when you mark it.' }),
          el('div.pg-rule', {}, [
            el('span.pg-rule-name', { text: 'How many hidden marks' }),
            el('div.seg.seg--tiny', {}, STRENGTH.map((o) => el('button.seg-btn', {
              text: o.label, class: s.copyStrength === o.key ? 'is-on' : '', 'aria-pressed': String(s.copyStrength === o.key),
              onclick: () => { s.copyStrength = o.key; ctx.save(); drawCopies(); copiesBox.open = true; },
            }))),
            el('p.hint.pg-rule-hint', { text: `${level.say[0].toUpperCase()}${level.say.slice(1)} is changed.` }),
          ]),
          el('div.pg-row', {}, [
            el('label.hint', { text: 'Versions' }), count,
            el('button.btn.btn--small.btn--primary', { svg: icon('check', 14), onclick: makeCopies }, c ? ' Make new ones' : ' Make versions'),
            pupils.length ? el('button.btn.btn--small', { onclick: () => { s.copyCount = Math.min(MAX_COPIES, pupils.length); makeCopies(); } }, ` One for each of the ${Math.min(MAX_COPIES, pupils.length)} pupils`) : null,
          ]),
          pupils.length ? el('p.hint.pg-rule-hint', { text: `With ${pupils.length} pupils in the class chosen below, the first ${Math.min(pupils.length, s.copyCount)} versions are named for them, so a pasted answer can be traced to who it came from.` }) : null,
        );
        if (c) {
          if (c.passage !== s.passage) copiesBox.append(el('p.hint.pg-rule-hint', { text: 'These were made from the passage as it was before you changed it. They still trace answers back; make new ones to hand out the new passage.' }));
          const list = el('ul.pg-copy-list');
          c.seeds.forEach((_, i) => list.append(el('li.pg-copy', {}, [
            el('span.pg-copy-name', { text: copyLabel(i) }),
            el('button.btn.btn--small', { svg: icon('copy', 14), 'aria-label': `Copy ${copyLabel(i)}`, onclick: async () => {
              toast(await copyText(versionOf(i).text) ? `${copyLabel(i)} copied — paste it where you hand it out.` : 'Could not copy. Try again from a click.');
            } }, ' Copy'),
          ])));
          copiesBox.append(list, el('div.pg-row', {}, [
            el('button.btn.btn--small.btn--ghost', { svg: icon('copy', 14), onclick: async () => {
              const all = c.seeds.map((_, i) => `${copyLabel(i)}\n${versionOf(i).text}`).join('\n\n');
              toast(await copyText(all) ? 'All the versions copied, one after another.' : 'Could not copy. Try again from a click.');
            } }, ' Copy all'),
          ]));
        }
        copiesBox.open = open;
      }

      /** What is odd about an answer, in words: null when it reads as typed. */
      function hiddenReport(answer, result, name) {
        const { hidden, looks, ids } = inspect(answer, result);
        if (!hidden && !looks) return null;
        const bits = [
          hidden ? `${hidden} hidden character${hidden === 1 ? '' : 's'} (invisible, or from another alphabet)` : '',
          looks ? `${looks} look-alike letter${looks === 1 ? '' : 's'} (an I for an l, or the like)` : '',
        ].filter(Boolean).join(' and ');
        const likely = hidden || looks > 1;
        let trace = '';
        if (s.copies && ids.size) {
          const found = tracedTo(ids, s.copies.seeds.map((_, i) => versionOf(i)));
          if (found.length) {
            const who = (x) => s.copies.names[x.index] || '';
            const own = found.some((x) => who(x) && name && who(x).trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase());
            trace = `It matches ${found.map((x) => copyLabel(x.index)).join(' or ')}${found.length === 1 ? ` (${found[0].hits} of ${ids.size} marks)` : ''}${own ? ' — their own copy.' : found.some(who) && name ? ' — not the copy they were given.' : '.'}`;
          } else trace = 'It does not match any version you made here.';
        }
        return { likely, bits, trace, tag: likely ? 'pasted' : 'check' };
      }

      // ---------- grading one answer ----------

      const pupilList = el('datalist', { id: `pg-pupils-${ctx.item.id}${ctx.expanded ? '-big' : ''}` });
      const nameBox = el('input.input.pg-name', {
        type: 'text', maxlength: '60', value: s.draft.name, placeholder: 'Pupil’s name',
        list: pupilList.id, 'aria-label': 'Pupil’s name', autocomplete: 'off',
        oninput: (e) => { s.draft.name = e.target.value; ctx.save(); },
      });
      const answerBox = el('textarea.textarea.pg-answer', {
        rows: 4, maxlength: String(MAX_ANSWER), value: s.draft.answer,
        placeholder: 'Paste the pupil’s answer here. It is marked as you paste.', 'aria-label': 'The pupil’s answer',
        spellcheck: 'false',
        oninput: (e) => {
          s.draft.answer = e.target.value;
          // The words are lined up again from scratch, so a decision made
          // about the old answer may no longer be about the same word.
          if (Object.keys(s.draft.overrides).length) {
            s.draft.overrides = {};
            toast('The answer changed, so the words you had counted right or wrong went back to the marking rules.');
          }
          ctx.save(); paintCount(); paintSoon();
        },
      });
      const leftHint = el('span.hint.pg-left-count');
      // How long the answer is against how long the passage is: the first
      // thing a teacher checks when a score looks wrong.
      const answerCount = el('span.hint.pg-count');
      function paintCount() { answerCount.textContent = words(wordCount(s.draft.answer)); }

      function drawGrade() {
        const picker = Desk.roster.picker({
          value: s.classKey,
          onPick: (key) => {
            if (key !== s.classKey) { s.classKey = key; ctx.save(); }
            loadPupils();
          },
        });
        picker.classList.add('pg-class');
        if (wide) {
          append(whoHead, el('span.pg-label', { text: 'Pupil’s answer' }), answerCount, nameBox, picker, pupilList);
          gradeBox.append(answerBox);
          return;
        }
        gradeBox.append(
          el('div.pg-row', {}, [el('div.pg-label', { text: 'Pupil’s answer' }), answerCount]),
          el('div.pg-row.pg-who', {}, [nameBox, picker]),
          pupilList,
          answerBox,
        );
      }

      async function loadPupils() {
        pupils = [];
        if (s.classKey) {
          try { pupils = await Desk.roster.members(s.classKey); } catch { pupils = []; }
        }
        Desk.clear(pupilList);
        for (const p of pupils) pupilList.append(el('option', { value: p.name }));
        paintLeft();
        drawCopies();
      }

      /** Who in the chosen class has not been marked yet — the question while marking a pile. */
      function paintLeft() {
        if (!pupils.length) { leftHint.textContent = ''; return; }
        const done = new Set(s.results.map((r) => r.name.trim().toLocaleLowerCase()));
        const left = pupils.filter((p) => !done.has(p.name.trim().toLocaleLowerCase()));
        leftHint.textContent = left.length ? `${left.length} of ${pupils.length} still to mark` : `All ${pupils.length} marked`;
        leftHint.title = left.length ? `Still to mark: ${left.map((p) => p.name).join(', ')}` : '';
      }

      // ---------- the result ----------

      let soon = 0;
      const paintSoon = () => { clearTimeout(soon); soon = setTimeout(paint, 180); };

      function paint() {
        paintCount();
        paintResult();
        paintSaved();
        paintLeft();
      }

      function marked(result) {
        const box = el('div.pg-marked');
        // Spaces go where the passage has them: none before a full stop or
        // comma, none after an opening bracket or quotation mark. Straight
        // quotes open and close in turn, which is how they are used.
        const quotes = {};
        let glue = true;                  // no space before the very first
        const put = (node, token) => {
          let opens = false;
          let closes = false;
          if (token.kind === 'mark') {
            const c = token.key;
            if (c === '"' || c === "'") {
              quotes[c] = !quotes[c];
              opens = quotes[c];
              closes = !opens;
            } else if ('([{'.includes(c)) opens = true;
            else closes = true;
          }
          if (!glue && !closes) box.append(' ');
          box.append(node);
          glue = opens;
        };
        for (const step of result.steps) {
          if (step.is === 'extra') { put(overrulable(step), step.got); continue; }
          const w = step.want;
          if (step.is === 'exact') { put(el('span.pg-w.pg-ok', { text: w.text }), w); continue; }
          if (step.is === 'lookalike') {
            put(el('span.pg-w.pg-ok.pg-look', { title: `They wrote “${step.got.text}” — a letter that looks like the right one. Counted right.` }, [w.text, el('small', { text: step.got.text })]), w);
            continue;
          }
          put(overrulable(step), w);
        }
        return box;
      }

      /**
       * A word the rules marked down, as a button: the teacher has the last
       * word. Each click moves it on — counted right, then counted wrong (for
       * a half-credit word), then back to what the rules said — so no choice
       * is ever more than two clicks from being undone.
       */
      function overrulable(step) {
        if (step.is === 'extra') return addedWord(step);
        const w = step.want;
        const mine = step.credit !== step.auto;
        const said = step.is === 'missing' ? 'Missing'
          : `${step.is === 'capital' ? 'Capitals' : 'Spelling'}: they wrote “${step.got.text}”`;
        const now = mine
          ? (step.credit ? 'you counted it right' : 'you counted it wrong')
          : (step.auto === 1 ? 'forgiven' : step.auto ? 'half credit' : 'no credit');
        const next = nextOverride(step);
        const nextSay = next === null ? 'go back to the marking rules' : next ? 'count it right' : 'count it wrong';
        const kind = step.is === 'missing' ? '.pg-miss' : '.pg-near';
        const state = mine ? (step.credit ? '.is-mine-right' : '.is-mine-wrong') : (step.auto === 1 ? '.is-forgiven' : '');
        return el(`button.pg-w.pg-flip${kind}${state}`, {
          type: 'button',
          title: `${said} — ${now}. Click to ${nextSay}.`,
          'aria-label': `${w.text}: ${said}, ${now}. Click to ${nextSay}.`,
          'data-pos': step.pos,
          onclick: () => overrule(step),
        }, step.is === 'missing' ? [w.text] : [w.text, el('small', { text: step.got.text })]);
      }

      /** A word the pupil added: free, until the teacher counts it against them. */
      function addedWord(step) {
        const counted = step.credit < 0;
        const now = counted ? 'you counted it against them — minus one' : 'not counted';
        const next = counted ? 'stop counting it' : 'count it against them';
        return el(`button.pg-w.pg-flip.pg-extra${counted ? '.is-mine-wrong' : ''}`, {
          type: 'button',
          'data-pos': step.pos,
          title: `Added — not in the passage. ${now[0].toUpperCase()}${now.slice(1)}. Click to ${next}.`,
          'aria-label': `${step.got.text}: added, ${now}. Click to ${next}.`,
          onclick: () => overrule(step),
        }, [step.got.text]);
      }

      /** What a click on this word makes it: 1 right, 0 wrong, null back to the rules. */
      function nextOverride(step) {
        const o = s.draft.overrides;
        // For an added word, 1 means "counts against them", and it toggles.
        if (step.is === 'extra') return Object.prototype.hasOwnProperty.call(o, step.pos) ? null : 1;
        if (!Object.prototype.hasOwnProperty.call(o, step.pos)) return step.auto === 1 ? 0 : 1;
        if (o[step.pos] === 1 && step.auto > 0 && step.auto < 1) return 0;
        return null;
      }

      function overrule(step) {
        const next = nextOverride(step);
        if (next === null) delete s.draft.overrides[step.pos];
        else s.draft.overrides[step.pos] = next;
        // Looking back over a saved answer and putting a word right is a
        // correction to that pupil's score, not a new draft to remember to
        // save — so it goes straight onto the saved score.
        const saved = editingId ? s.results.find((r) => r.id === editingId) : null;
        if (saved && saved.answer === s.draft.answer) saved.overrides = { ...s.draft.overrides };
        ctx.save();
        paint();
        resultBox.querySelector(`.pg-flip[data-pos="${step.pos}"]`)?.focus();
      }

      function hiddenFlag(result, answer, name) {
        const rep = hiddenReport(answer, result, name);
        if (!rep) return null;
        return el(`div.pg-alert${rep.likely ? '' : '.is-soft'}`, { role: 'status' }, [
          el('strong', { text: rep.likely ? 'This answer looks pasted, not typed.' : 'One look-alike letter — pasted, or a typo?' }),
          el('span', { text: ` It has ${rep.bits}.${rep.trace ? ` ${rep.trace}` : ''}` }),
        ]);
      }

      function paintResult() {
        Desk.clear(resultBox);
        if (!s.passage.trim()) {
          resultBox.append(el('p.hint.pg-empty', { text: 'Set the passage, then paste a pupil’s answer to mark it.' }));
          return;
        }
        if (!s.draft.answer.trim()) {
          resultBox.append(el('p.hint.pg-empty', { text: 'Paste a pupil’s answer to mark it.' }));
          return;
        }
        const r = grade(s.passage, s.draft.answer, rules(), s.draft.overrides);
        const t = r.tally;
        const bits = [
          `${t.exact} right`,
          t.spelling ? `${t.spelling} misspelled` : '',
          t.capital ? `${t.capital} capital${t.capital === 1 ? '' : 's'}` : '',
          t.missing ? `${t.missing} missing` : '',
          t.extra ? `${t.extra} added${r.cost ? ` (${r.cost} counted against)` : ''}` : '',
          t.changed ? `${t.changed} changed by you` : '',
        ].filter(Boolean);
        const save = el('button.btn.btn--primary.btn--small', { svg: icon('save', 14), onclick: saveResult },
          editingId ? ' Update score' : ' Save score');
        append(resultBox,
          el('div.pg-score', {}, [
            el('span.pg-score-num', { text: `${half(r.score)} / ${r.total}` }),
            el('span.pg-score-pct', { text: `${r.percent}%` }),
          ]),
          el('p.hint.pg-tally', { text: bits.join(' · ') }),
          s.punctuation === 'count' && r.marks.total
            ? el('p.hint.pg-tally', { text: `Words ${half(r.words.got)} / ${r.words.total} · Punctuation ${half(r.marks.got)} / ${r.marks.total}` })
            : null,
          hiddenFlag(r, s.draft.answer, s.draft.name),
          marked(r),
          r.steps.some((x) => x.is !== 'exact')
            ? el('p.hint.pg-flip-hint', { text: 'Click a marked word to count it right or wrong, or an added word to count it against them.' }) : null,
          el('div.pg-row.pg-actions', {}, [
            save,
            el('button.btn.btn--small.btn--ghost', { text: editingId ? 'Close' : 'Clear', onclick: clearDraft }),
            leftHint,
          ]),
        );
      }

      function saveResult() {
        const name = s.draft.name.trim().slice(0, 60);
        if (!name) { toast('Add the pupil’s name, so the score is theirs.', 'warn'); nameBox.focus(); return; }
        const existing = editingId ? s.results.find((r) => r.id === editingId) : null;
        if (existing) {
          existing.name = name;
          existing.answer = s.draft.answer.slice(0, MAX_ANSWER);
          existing.overrides = { ...s.draft.overrides };
        } else {
          if (s.results.length >= MAX_RESULTS) { toast(`That is ${MAX_RESULTS} scores — copy them out and clear the list to mark more.`, 'warn'); return; }
          s.results.push({ id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name, answer: s.draft.answer.slice(0, MAX_ANSWER), at: Date.now(), overrides: { ...s.draft.overrides } });
        }
        s.draft = { name: '', answer: '', id: '', overrides: {} };
        editingId = null;
        nameBox.value = '';
        answerBox.value = '';
        ctx.save();
        paint();
        nameBox.focus();
      }

      function clearDraft() {
        s.draft = { name: '', answer: '', id: '', overrides: {} };
        editingId = null;
        nameBox.value = '';
        answerBox.value = '';
        ctx.save();
        paint();
      }

      // ---------- saved scores ----------

      function savedFlag(r, g) {
        const rep = g ? hiddenReport(r.answer, g, r.name) : null;
        return rep ? el('em.pg-tag', { text: rep.tag, title: `${rep.bits}. ${rep.trace}`.trim() }) : null;
      }

      function paintSaved() {
        Desk.clear(savedBox);
        if (!s.results.length) return;
        const marks = s.results.map((r) => ({ r, g: s.passage.trim() ? grade(s.passage, r.answer, rules(), r.overrides) : null }));
        const list = el('ul.pg-list');
        for (const { r, g } of marks) {
          list.append(el(`li.pg-item${r.id === editingId ? '.is-open' : ''}`, {}, [
            el('button.pg-open', {
              title: 'Show how this answer was marked',
              onclick: () => {
                editingId = r.id;
                s.draft = { name: r.name, answer: r.answer, id: r.id, overrides: { ...r.overrides } };
                nameBox.value = r.name;
                answerBox.value = r.answer;
                ctx.save();
                paint();
              },
            }, [
              el('span.pg-item-name', {}, [r.name, savedFlag(r, g)]),
              el('span.pg-item-score', { text: g ? `${half(g.score)} / ${g.total}` : '—' }),
              el('span.pg-item-pct', { text: g ? `${g.percent}%` : '' }),
            ]),
            el('button.icon-btn.icon-btn--danger', {
              title: `Remove ${r.name}’s score`, 'aria-label': `Remove ${r.name}’s score`, svg: icon('close', 14),
              onclick: () => {
                s.results = s.results.filter((x) => x.id !== r.id);
                if (editingId === r.id) editingId = null;
                ctx.save();
                paint();
              },
            }),
          ]));
        }
        const avg = marks.filter((m) => m.g).reduce((n, m) => n + m.g.percent, 0) / Math.max(1, marks.filter((m) => m.g).length);
        savedBox.append(
          el('div.pg-row.pg-saved-head', {}, [
            el('span.pg-label', { text: `Saved scores (${s.results.length})` }),
            el('span.hint', { text: `Class average ${Math.round(avg)}%` }),
          ]),
          list,
          el('div.pg-row', {}, [
            el('button.btn.btn--small', { svg: icon('copy', 14), onclick: () => copyOut(marks) }, ' Copy for gradebook'),
            el('button.btn.btn--small.btn--ghost', {
              svg: icon('trash', 14),
              onclick: async () => {
                if (!await Desk.ask({ title: 'Clear the saved scores?', body: `All ${s.results.length} saved answers and scores are removed. Copy them out first if you need them.`, confirmLabel: 'Clear them', danger: true })) return;
                s.results = [];
                editingId = null;
                ctx.save();
                paint();
              },
            }, ' Clear'),
          ]),
        );
      }

      /** Name, score, out of, percent — tab-separated, which pastes straight into a spreadsheet or gradebook. */
      async function copyText(text) {
        let ok = false;
        try {
          if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); ok = true; }
        } catch { ok = false; }
        if (!ok) {
          try {
            const box = el('textarea', { value: text, style: { position: 'fixed', top: '-1000px', opacity: '0' } });
            document.body.append(box);
            box.select();
            ok = document.execCommand('copy');
            box.remove();
          } catch { ok = false; }
        }
        return ok;
      }

      async function copyOut(marks) {
        const rows = [['Name', 'Score', 'Out of', 'Percent'].join('\t')]
          .concat(marks.map(({ r, g }) => [r.name.replace(/\t/g, ' '), g ? g.score : '', g ? g.total : '', g ? `${g.percent}%` : ''].join('\t')));
        const ok = await copyText(rows.join('\n'));
        toast(ok ? `${marks.length} score${marks.length === 1 ? '' : 's'} copied — paste into your gradebook or a spreadsheet.` : 'Could not copy. Try again from a click.', ok ? undefined : 'warn');
      }

      drawPassage();
      drawRules();
      drawCopies();
      drawGrade();
      paint();

      return {
        destroy() { clearTimeout(soon); },
      };
    },

    // Exposed for the tests: the marking is the part a teacher has to trust.
    _grade: grade,
    _tokenize: tokenize,
    _makeCopy: makeCopy,
    _inspect: inspect,
    _tracedTo: tracedTo,
    _kinship: kinship,
    _wordCount: wordCount,
    _cleanOverrides: cleanOverrides,
  });
}(window.Desk));
