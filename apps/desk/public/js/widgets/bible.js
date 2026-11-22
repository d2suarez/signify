// ===================================================================
// Widget — Bible
//
// A Bible to read from the front of the room. Type one reference or several
// ("John 3:16, Rom 8:28-30; Ps 23"), or pick a book and chapter, and read it
// on the card, larger, or across the whole screen. A highlighter marks words
// for the class, and every passage and verse opens on Blue Letter Bible for
// the lexicons and commentaries.
//
// Signed-in only: the text comes through this desk's server (server/bible.js),
// which holds the ESV and API.Bible keys so no classroom browser ever does.
//
// The services' HTML is never put on the page. It is read with DOMParser into
// an inert document, and the reader is rebuilt from its text alone — so a
// passage can carry no script, link or style of anybody else's.
//
// Highlights are kept per translation and verse, by word position
// (`s.marks['<version>|JHN.3.16'] = [[from, to, colour], ...]`), so they come
// back on the same passage whichever way it was looked up — "John 3:16",
// "John 3", or the next-chapter arrow from John 2.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon, toast } = Desk;
  const B = () => window.DeskBible;

  const PENS = [
    { key: 'y', name: 'Yellow' },
    { key: 'g', name: 'Green' },
    { key: 'b', name: 'Blue' },
    { key: 'p', name: 'Pink' },
  ];
  const PEN_KEYS = new Set(PENS.map((p) => p.key));
  const THEMES = [
    { key: 'page', name: 'Like the desk' },
    { key: 'paper', name: 'Paper' },
    { key: 'night', name: 'Dark' },
  ];
  const MAX_MARKED_VERSES = 2500;
  const MAX_RECENT = 8;

  // One copy of each passage per page, shared by the card and its big view,
  // so opening the reader larger does not ask the server again.
  const passages = new Map();
  let versionList = null;
  // The card's Full screen button opens the big view and asks it to fill the
  // screen; this is how the one tells the other, inside the same click.
  let fullscreenFor = null;

  function fetchVersions() {
    if (!versionList) {
      versionList = Desk.api.bibleVersions().catch((e) => { versionList = null; throw e; });
    }
    return versionList;
  }

  function fetchPassage(version, refId) {
    const key = `${version}|${refId}`;
    if (!passages.has(key)) {
      const p = Desk.api.biblePassage(version, refId).catch((e) => { passages.delete(key); throw e; });
      passages.set(key, p);
      if (passages.size > 200) passages.delete(passages.keys().next().value);
    }
    return passages.get(key);
  }

  // ---------- highlights (pure, tested) ----------

  /** [[from, to, colour]] into { word: colour }. */
  function expand(ranges) {
    const out = {};
    for (const r of ranges || []) {
      if (!Array.isArray(r) || r.length < 3) continue;
      const a = Math.max(0, Math.floor(r[0]));
      const b = Math.min(a + 2000, Math.floor(r[1]));
      if (!PEN_KEYS.has(r[2]) || !Number.isFinite(a) || !Number.isFinite(b)) continue;
      for (let w = a; w <= b; w++) out[w] = r[2];
    }
    return out;
  }

  /** { word: colour } back into the fewest ranges, in order. */
  function compress(words) {
    const keys = Object.keys(words).map(Number).filter(Number.isFinite).sort((x, y) => x - y);
    const out = [];
    for (const w of keys) {
      const last = out[out.length - 1];
      if (last && last[1] === w - 1 && last[2] === words[w]) last[1] = w;
      else out.push([w, w, words[w]]);
    }
    return out;
  }

  /** Colour words from..to (or rub them out, colour null), merging with what is there. */
  function mark(ranges, from, to, colour) {
    const words = expand(ranges);
    const [a, b] = from <= to ? [from, to] : [to, from];
    for (let w = a; w <= b; w++) {
      if (colour) words[w] = colour;
      else delete words[w];
    }
    return compress(words);
  }

  // ---------- turning an answer into something to read ----------
  //
  // Blocks: { t: 'h', text } a heading, or
  // { t: 'p', poetry, indent, pieces: [{ c, v, num, br, text }] } a paragraph.
  // Chapter labels are the reader's business, from each piece's `c`.
  // A verse can run across paragraphs; `num` marks the piece that begins it.

  function fromVerses(verses) {
    const blocks = [];
    let para = null;
    let chapter = null;
    for (const x of verses || []) {
      if (x.c !== chapter) {
        chapter = x.c;
        para = { t: 'p', poetry: false, indent: 0, pieces: [] };
        blocks.push(para);
      }
      para.pieces.push({ c: x.c, v: x.v, num: true, br: false, text: String(x.text || '').replace(/\s+/g, ' ').trim() });
    }
    return blocks;
  }

  const SKIP = /(^|\s)(note|notes|f|fe|x|r|sr|mr|fr|ft|fq|fqa|xo|xt|cl|cp|footnote|footnotes|crossref|crossrefs|audio|mp3link|extra_text|copyright|esv-copyright)(\s|$)/;
  const HEADING = /^(s\d?|ms\d?|mt\d?|d|sp|qa)$/;
  const POETRY = /^(q\d?|qc|qr|qm\d?|pi\d?|li\d?)$/;

  function fromHtml(html, ref) {
    const doc = new DOMParser().parseFromString(`<div id="bib-root">${html}</div>`, 'text/html');
    const rootNode = doc.getElementById('bib-root');
    const blocks = [];
    let c = ref.c1;
    let v = ref.v1 || 0;

    const clean = (t) => String(t).replace(/ /g, ' ').replace(/\s+/g, ' ');
    const classOf = (n) => String(n.getAttribute('class') || '').trim();

    function verseMarker(n) {
      const cls = classOf(n);
      if (n.tagName === 'B' && /(^|\s)(verse-num|chapter-num)(\s|$)/.test(cls)) {
        // ESV: id="v43003016-1" is book, chapter, verse.
        const m = /^v\d{2}(\d{3})(\d{3})/.exec(n.id || '');
        if (m) return { c: +m[1], v: +m[2] };
        const t = clean(n.textContent).trim();
        const cv = /^(\d+):(\d+)/.exec(t);
        if (cv) return { c: +cv[1], v: +cv[2] };
        return /^\d+$/.test(t) ? { c, v: +t } : null;
      }
      if (/(^|\s)v(\s|$)/.test(cls) || n.hasAttribute('data-number') && n.hasAttribute('data-sid')) {
        // API.Bible: <span data-number="16" data-sid="JHN 3:16" class="v">.
        const sid = /(\d+):(\d+)/.exec(n.getAttribute('data-sid') || '');
        if (sid) return { c: +sid[1], v: +sid[2] };
        const num = parseInt(n.getAttribute('data-number') || n.textContent, 10);
        return Number.isFinite(num) ? { c, v: num } : null;
      }
      return null;
    }

    function paragraph(node, poetry, indent) {
      const para = { t: 'p', poetry, indent, pieces: [] };
      let piece = null;
      let breakNext = false;

      const start = (num) => {
        piece = { c, v, num, br: breakNext && para.pieces.length > 0, text: '' };
        breakNext = false;
        para.pieces.push(piece);
      };

      (function walk(n) {
        for (const k of n.childNodes) {
          if (k.nodeType === 3) {
            const t = clean(k.nodeValue);
            if (!t.trim() && !piece) continue;
            if (!piece || breakNext) start(false);
            piece.text += t;
            continue;
          }
          if (k.nodeType !== 1) continue;
          const tag = k.tagName;
          const cls = classOf(k);
          if (tag === 'BR') { breakNext = true; continue; }
          const marker = verseMarker(k);
          if (marker) {
            c = marker.c; v = marker.v;
            start(true);
            continue;
          }
          if (tag === 'SUP' || tag === 'SCRIPT' || tag === 'STYLE' || SKIP.test(cls)) continue;
          // ESV poetry: each <span class="line"> is a line of its own.
          if (/(^|\s)line(\s|$)/.test(cls) && para.pieces.length) breakNext = true;
          walk(k);
        }
      }(node));

      for (const p of para.pieces) p.text = p.text.replace(/^\s+/, p.br || p === para.pieces[0] ? '' : ' ');
      para.pieces = para.pieces.filter((p) => p.num || p.text.trim());
      return para;
    }

    (function blocksOf(container) {
      for (const n of container.children) {
        const tag = n.tagName;
        const cls = classOf(n);
        const first = cls.split(/\s+/)[0] || '';
        if (tag === 'SCRIPT' || tag === 'STYLE' || SKIP.test(cls)) continue;
        if (tag === 'DIV' || tag === 'SECTION') { blocksOf(n); continue; }
        if (/^H[1-6]$/.test(tag) || HEADING.test(first)) {
          // A psalm's title ("A Psalm of David") carries a verse number in
          // some editions; that one is read, not shown as a heading.
          if (n.querySelector('.v, [data-number], b.verse-num')) { push(paragraph(n, false, 0)); continue; }
          const text = clean(n.textContent).trim();
          if (text) blocks.push({ t: 'h', text });
          continue;
        }
        const poetry = POETRY.test(first) || !!n.querySelector('.line') || /block-indent/.test(cls);
        const indent = poetry ? Math.max(1, parseInt((/\d/.exec(first) || ['1'])[0], 10)) : 0;
        push(paragraph(n, poetry, indent));
      }
    }(rootNode));

    function push(para) { if (para.pieces.length) blocks.push(para); }

    return blocks;
  }

  // ---------- the widget ----------

  Desk.widget({
    type: 'bible',
    name: 'Bible',
    blurb: 'Look up verses and chapters, read them full screen, and highlight for the class.',
    icon: 'book',
    category: 'board',
    fills: true,
    students: true,
    size: { w: 5, h: 6 },
    min: { w: 3, h: 4 },
    added: '2026-11-21',
    news: 'Look up several verses at once, read them full screen, and highlight for the class — ESV, NIV and more.',

    _mark: mark,
    _expand: expand,
    _compress: compress,
    _fromVerses: fromVerses,
    _fromHtml: fromHtml,          // browser only: needs DOMParser

    init(s) {
      if (typeof s.query !== 'string') s.query = '';
      s.query = s.query.slice(0, 300);
      if (typeof s.version !== 'string') s.version = '';
      if (typeof s.size !== 'number' || !Number.isFinite(s.size)) s.size = 1;
      s.size = Math.min(3, Math.max(0.6, s.size));
      if (!THEMES.some((t) => t.key === s.theme)) s.theme = 'page';
      if (typeof s.numbers !== 'boolean') s.numbers = true;
      if (typeof s.headings !== 'boolean') s.headings = true;
      if (!s.marks || typeof s.marks !== 'object' || Array.isArray(s.marks)) s.marks = {};
      for (const [k, v] of Object.entries(s.marks)) {
        if (!/^[\w-]{1,80}\|[1-3A-Z]{3}\.\d{1,3}\.\d{1,3}$/.test(k) || !Array.isArray(v)) { delete s.marks[k]; continue; }
        const tidy = compress(expand(v));
        if (tidy.length) s.marks[k] = tidy; else delete s.marks[k];
      }
      if (!Array.isArray(s.recent)) s.recent = [];
      s.recent = s.recent.filter((q) => typeof q === 'string' && q.trim()).map((q) => q.slice(0, 120)).slice(0, MAX_RECENT);
    },

    holdsContent: (s) => (Object.keys(s.marks || {}).length ? 'Your highlights go with it.' : ''),

    mount(ctx) {
      const s = ctx.state;
      let versions = null;           // { versions, default, keys }
      let shown = [];                // [{ ref, data|error }]
      let pen = null;                // a PEN key, 'erase', or null
      let picking = null;            // null, 'books', or a book code
      let loadSeq = 0;
      let loading = false;
      let words = [];                // every word on the page, in order
      let drag = null;

      const docs = [];               // document listeners to take down
      const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); docs.push(() => target.removeEventListener(type, fn, opts)); };

      // ----- the frame -----
      const query = el('input.input.bib-q', {
        type: 'search', maxlength: 300, value: s.query, enterkeyhint: 'search',
        placeholder: 'John 3:16, Rom 8:28-30; Ps 23',
        'aria-label': 'Bible references, separated by commas',
        onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); go(query.value); } },
      });
      const versionSel = el('select.input.bib-ver', { 'aria-label': 'Translation', onchange: () => { s.version = versionSel.value; ctx.save(); lookup(); } });
      const goBtn = el('button.btn.btn--small.bib-go', { title: 'Look it up', onclick: () => go(query.value) }, 'Go');

      const tools = el('div.bib-tools');
      const picker = el('div.bib-picker', { hidden: true });
      const reader = el('div.bib-read', { tabindex: '0' });
      const status = el('p.bib-status', { 'aria-live': 'polite' });
      const recent = el('div.bib-recent');

      const wrap = el('div.bib', { 'data-theme': s.theme }, [
        el('div.bib-bar', {}, [query, versionSel, goBtn]),
        ctx.expanded ? recent : null,
        tools,
        status,
        picker,
        reader,
      ].filter(Boolean));
      ctx.root.append(wrap);

      const applySize = () => wrap.style.setProperty('--bib-scale', String(s.size));
      applySize();

      // ----- versions -----
      async function loadVersions() {
        try {
          versions = await fetchVersions();
        } catch (e) {
          versions = { versions: [{ id: 'kjv', abbrev: 'KJV', name: 'King James Version' }], default: 'kjv', keys: {} };
          status.textContent = e.message || 'Could not load the translations.';
        }
        const ids = new Set(versions.versions.map((v) => v.id));
        if (!ids.has(s.version)) s.version = versions.default;
        Desk.clear(versionSel);
        for (const v of versions.versions) {
          versionSel.append(el('option', { value: v.id, text: v.abbrev, title: v.name }));
        }
        versionSel.value = s.version;
      }

      const abbrev = () => {
        const v = versions && versions.versions.find((x) => x.id === s.version);
        return v ? v.abbrev : s.version.toUpperCase();
      };

      // ----- looking up -----
      function go(text) {
        s.query = String(text || '').trim().slice(0, 300);
        query.value = s.query;
        if (s.query) {
          s.recent = [s.query, ...s.recent.filter((q) => q.toLowerCase() !== s.query.toLowerCase())].slice(0, MAX_RECENT);
        }
        picking = null;
        ctx.save();
        lookup();
      }

      function openRef(ref) { go(B().label(ref)); }

      async function lookup() {
        const mine = ++loadSeq;
        drawPicker();
        if (!s.query) {
          shown = [];
          loading = false;
          status.textContent = '';
          drawTools();
          drawReader();
          return;
        }
        if (!versions) await loadVersions();
        if (mine !== loadSeq) return;
        const { refs, errors } = B().parse(s.query);
        loading = true;
        status.textContent = errors.join(' ');
        drawTools();
        if (!refs.length) { shown = []; loading = false; drawReader(); return; }
        drawReader();
        const version = s.version;
        // The ESV may not be kept: only the passages on screen stay in memory.
        const wanted = new Set(refs.map((r) => `${version}|${B().toId(r)}`));
        for (const k of [...passages.keys()]) if (k.startsWith('esv|') && !wanted.has(k)) passages.delete(k);
        const got = await Promise.all(refs.map((ref) => fetchPassage(version, B().toId(ref))
          .then((data) => ({ ref, data }), (e) => ({ ref, error: e.message || 'Could not load that passage.' }))));
        if (mine !== loadSeq) return;
        shown = got;
        loading = false;
        drawTools();
        drawReader();
        reader.scrollTop = 0;
      }

      // ----- the toolbar -----
      const tbtn = (name, title, onclick, extra = {}) => el('button.icon-btn.bib-tbtn', {
        title, 'aria-label': title, svg: icon(name, 18), onclick, ...extra,
      });

      function chapterSpan() {
        const refs = shown.length ? shown.map((x) => x.ref) : [];
        if (!refs.length) return null;
        return { first: refs[0], last: refs[refs.length - 1] };
      }

      function drawTools() {
        Desk.clear(tools);
        const span = chapterSpan();
        const prev = span && B().adjacent(span.first.code, span.first.c1, -1);
        const next = span && B().adjacent(span.last.code, span.last.c2, +1);
        const single = shown.length === 1 && shown[0].ref.v1 != null ? shown[0].ref : null;

        const books = el('button.btn.btn--small.bib-books', {
          'aria-expanded': picking ? 'true' : 'false',
          onclick: () => { picking = picking ? null : 'books'; drawPicker(); drawTools(); },
        }, [el('span', { svg: icon('book', 15) }), ' Books']);

        const nav = el('span.bib-group', {}, [
          tbtn('chevron', prev ? `Back to ${B().label(prev)}` : 'Previous chapter', () => prev && openRef(prev), { disabled: !prev, class: 'bib-prev' }),
          tbtn('chevron', next ? `On to ${B().label(next)}` : 'Next chapter', () => next && openRef(next), { disabled: !next, class: 'bib-next' }),
          single ? el('button.btn.btn--small', {
            title: `Read all of ${B().bookOf(single).name} ${single.c1}`,
            onclick: () => openRef({ code: single.code, c1: single.c1, v1: null, c2: single.c2, v2: null }),
          }, 'Whole chapter') : null,
        ].filter(Boolean));

        const size = el('span.bib-group', {}, [
          el('button.icon-btn.bib-tbtn.bib-size', { title: 'Smaller text', 'aria-label': 'Smaller text', onclick: () => resize(1 / 1.15) }, 'A−'),
          el('button.icon-btn.bib-tbtn.bib-size', { title: 'Larger text', 'aria-label': 'Larger text', onclick: () => resize(1.15) }, 'A+'),
        ]);

        const pens = el('span.bib-group.bib-pens', { role: 'group', 'aria-label': 'Highlighter' }, [
          ...PENS.map((p) => el(`button.bib-pen.bib-pen--${p.key}`, {
            title: `${p.name} highlighter`, 'aria-label': `${p.name} highlighter`, 'aria-pressed': pen === p.key ? 'true' : 'false',
            onclick: () => setPen(pen === p.key ? null : p.key),
          })),
          el('button.icon-btn.bib-tbtn.bib-erase', {
            title: 'Rub out highlights', 'aria-label': 'Rub out highlights', 'aria-pressed': pen === 'erase' ? 'true' : 'false',
            svg: eraser, onclick: () => setPen(pen === 'erase' ? null : 'erase'),
          }),
        ]);

        const theme = THEMES.find((t) => t.key === s.theme);
        const view = el('span.bib-group', {}, [
          el('button.btn.btn--small', {
            title: 'Change the page colour',
            onclick: () => {
              const i = THEMES.findIndex((t) => t.key === s.theme);
              s.theme = THEMES[(i + 1) % THEMES.length].key;
              wrap.dataset.theme = s.theme;
              ctx.save();
              drawTools();
            },
          }, theme.name),
          ctx.expanded ? el('button.btn.btn--small', {
            'aria-pressed': s.numbers ? 'true' : 'false',
            onclick: () => { s.numbers = !s.numbers; ctx.save(); drawTools(); drawReader(); },
          }, 'Verse numbers') : null,
          ctx.expanded ? el('button.btn.btn--small', {
            'aria-pressed': s.headings ? 'true' : 'false',
            onclick: () => { s.headings = !s.headings; ctx.save(); drawTools(); drawReader(); },
          }, 'Headings') : null,
        ].filter(Boolean));

        const out = el('span.bib-group', {}, [
          span ? el('a.btn.btn--small.bib-blb', {
            href: B().blbUrl(span.first, abbrev()), target: '_blank', rel: 'noopener noreferrer',
            title: 'Open on Blue Letter Bible',
          }, [el('span', { svg: icon('external', 14) }), ' Blue Letter Bible']) : null,
          tbtn(isFull() ? 'collapse' : 'expand', isFull() ? 'Leave full screen (Esc)' : 'Read full screen', toggleFull),
        ].filter(Boolean));

        Desk.append(tools, books, nav, size, pens, view, out);

        if (ctx.expanded) {
          Desk.clear(recent);
          for (const q of s.recent) {
            recent.append(el('button.chip.bib-chip', { onclick: () => go(q), title: `Look up ${q}` }, q));
          }
          recent.hidden = !s.recent.length;
        }
      }

      const eraser = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 21-4-4a2 2 0 0 1 0-2.8L13.2 4a2 2 0 0 1 2.8 0l4 4a2 2 0 0 1 0 2.8L10 21z"/><path d="M21 21H7M8.5 8.5l7 7"/></svg>';

      function resize(by) {
        s.size = Math.round(Math.min(3, Math.max(0.6, s.size * by)) * 100) / 100;
        applySize();
        ctx.save();
      }

      function setPen(next) {
        pen = next;
        wrap.classList.toggle('is-pen', !!pen);
        wrap.dataset.pen = pen || '';
        drawTools();
      }

      // ----- full screen -----
      // Reading mode fills the window by itself, and asks the browser for the
      // whole screen on top — which it is allowed to refuse (inside a frame,
      // say) without the button doing nothing. Same idea as the desk's Present.
      let full = false;
      const isFull = () => full;
      function setFull(onOff) {
        full = onOff;
        wrap.classList.toggle('is-full', onOff);
        drawTools();
        if (onOff) {
          if (wrap.requestFullscreen) wrap.requestFullscreen().catch(() => {});
          reader.focus({ preventScroll: true });
        } else if (document.fullscreenElement === wrap) {
          document.exitFullscreen().catch(() => {});
        }
      }
      function toggleFull() {
        if (!ctx.expanded) {
          // Into the big view first, which goes straight into reading mode.
          fullscreenFor = ctx.item && ctx.item.id;
          if (ctx.expand) ctx.expand();
          return;
        }
        setFull(!full);
      }
      // Esc out of the browser's full screen leaves reading mode too.
      on(document, 'fullscreenchange', () => { if (full && document.fullscreenElement !== wrap) setFull(false); });
      // Esc in reading mode steps back to the big view, not all the way out
      // to the desk: caught on the way down, before the big view hears it.
      on(window, 'keydown', (e) => {
        if (full && e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); setFull(false); }
      }, true);

      // ----- picking a book and chapter -----
      function drawPicker() {
        Desk.clear(picker);
        const empty = !s.query;
        const mode = picking || (empty ? 'books' : null);
        picker.hidden = !mode;
        reader.hidden = !!picking;
        if (!mode) return;

        if (mode === 'books') {
          for (const testament of ['old', 'new']) {
            picker.append(el('p.bib-pick-head', { text: testament === 'old' ? 'Old Testament' : 'New Testament' }));
            picker.append(el('div.bib-grid.bib-grid--books', {}, B().BOOKS.filter((b) => b.testament === testament).map((b) => el('button.bib-cell', {
              title: b.name,
              onclick: () => {
                if (b.chapters === 1) { openRef({ code: b.code, c1: 1, v1: null, c2: 1, v2: null }); return; }
                picking = b.code; drawPicker(); drawTools();
              },
            }, b.short))));
          }
          if (empty) picker.append(el('p.hint', { text: 'Or type references above — several at once, separated by commas.' }));
          return;
        }

        const book = B().BY_CODE.get(mode);
        picker.append(el('div.bib-pick-top', {}, [
          el('button.btn.btn--small', { onclick: () => { picking = 'books'; drawPicker(); } }, '← Books'),
          el('p.bib-pick-head', { text: book.name }),
        ]));
        const cells = [];
        for (let c = 1; c <= book.chapters; c++) {
          cells.push(el('button.bib-cell.bib-cell--num', { onclick: () => openRef({ code: book.code, c1: c, v1: null, c2: c, v2: null }) }, String(c)));
        }
        picker.append(el('div.bib-grid.bib-grid--chapters', {}, cells));
      }

      // ----- the reader -----
      function drawReader() {
        Desk.clear(reader);
        words = [];
        if (loading) { reader.append(el('p.bib-wait', { text: 'Looking it up…' })); return; }
        if (!s.query) return;
        if (!shown.length) return;

        const copyrights = new Set();
        const links = new Set();
        // Crossway's page limit: no more than 500 ESV verses, or half of any
        // book, on one page. Passages past it are named but not shown.
        let esvVerses = 0;
        const esvChapters = new Map();
        for (const { ref, data, error } of shown) {
          const book = B().bookOf(ref);
          const section = el('section.bib-pass');
          section.append(el('header.bib-pass-head', {}, [
            el('h3.bib-ref', { text: B().label(ref) }),
            el('span.bib-ver-tag', { text: data ? data.version.abbrev : abbrev() }),
            el('a.bib-pass-blb', {
              href: B().blbUrl(ref, data ? data.version.abbrev : abbrev()), target: '_blank', rel: 'noopener noreferrer',
              title: `${B().label(ref)} on Blue Letter Bible`, 'aria-label': `${B().label(ref)} on Blue Letter Bible`, svg: icon('external', 14),
            }),
          ]));
          if (error) {
            section.append(el('p.bib-error', { text: error }));
            reader.append(section);
            continue;
          }
          let blocks;
          try { blocks = data.kind === 'html' ? fromHtml(data.html, ref) : fromVerses(data.verses); }
          catch (e) { console.error(e); blocks = []; }
          if (data.version.id === 'esv') {
            const verses = new Set();
            const chs = esvChapters.get(ref.code) || new Set();
            for (const b of blocks) for (const p of b.pieces || []) if (p.num) { verses.add(`${p.c}.${p.v}`); chs.add(p.c); }
            const half = book.chapters > 2 ? Math.floor(book.chapters / 2) : book.chapters;
            if (esvVerses + verses.size > 500 || chs.size > half) {
              section.append(el('p.bib-error', { text: 'The ESV allows 500 verses, or half of a book, on screen at once. Look this one up on its own.' }));
              reader.append(section);
              continue;
            }
            esvVerses += verses.size;
            esvChapters.set(ref.code, chs);
          }
          if (!blocks.length) section.append(el('p.bib-error', { text: 'That passage came back empty.' }));
          const ver = data.version.id;
          const count = new Map();     // words seen so far in each verse

          const body = el('div.bib-text');
          const many = ref.c2 !== ref.c1;
          let lastC = ref.c1;
          for (const blk of blocks) {
            if (blk.t === 'h') { if (s.headings) body.append(el('h4.bib-h', { text: blk.text })); continue; }
            const c0 = blk.pieces[0] && blk.pieces[0].c;
            if (many && c0 > lastC) { body.append(el('p.bib-chap', { text: `${book.name} ${c0}` })); lastC = c0; }
            const p = el(`p.bib-p${blk.poetry ? '.bib-poem' : ''}`, blk.indent > 1 ? { style: { '--indent': blk.indent } } : {});
            blk.pieces.forEach((piece, i) => {
              if (piece.br && i > 0) p.append(el('br'));
              else if (i > 0 && piece.num) p.append(document.createTextNode(' '));
              const key = `${ver}|${ref.code}.${piece.c}.${piece.v}`;
              if (piece.num && piece.v > 0 && s.numbers) {
                p.append(el('a.bib-vn', {
                  href: B().blbUrl(ref, data.version.abbrev, piece.c, piece.v),
                  target: '_blank', rel: 'noopener noreferrer',
                  title: `${book.name} ${piece.c}:${piece.v} on Blue Letter Bible`,
                  'data-k': key,
                }, piece.c > lastC ? `${piece.c}:${piece.v}` : String(piece.v)));
                if (piece.c > lastC) lastC = piece.c;
              }
              let n = count.get(key) || 0;
              for (const part of piece.text.split(/(\s+)/)) {
                if (!part) continue;
                if (/^\s+$/.test(part)) {
                  // A space of its own, so a highlight can run across it
                  // when the words either side share a colour.
                  const sp = el('span.bib-sp', {}, ' ');
                  if (words.length) words[words.length - 1].bibSpace = sp;
                  p.append(sp);
                  continue;
                }
                const w = el('span.bib-w', { 'data-k': key, 'data-w': String(n) }, part);
                w.dataset.i = String(words.length);
                words.push(w);
                p.append(w);
                n += 1;
              }
              count.set(key, n);
            });
            body.append(p);
          }
          section.append(body);
          reader.append(section);
          if (data.copyright) copyrights.add(data.copyright);
          if (data.link) links.add(data.link);
        }
        if (copyrights.size || links.size) {
          reader.append(el('footer.bib-copy', {}, [
            ...[...copyrights].map((t) => el('p', { text: t })),
            ...[...links].map((href) => el('p', {}, [el('a', { href, target: '_blank', rel: 'noopener noreferrer', text: href.replace(/^https:\/\/(www\.)?|\/$/g, '') })])),
          ]));
        }
        paint();
      }

      /** Puts the saved highlights on the words now drawn. */
      function paint() {
        const cache = new Map();
        const colourOf = (w) => {
          const k = w.dataset.k;
          if (!cache.has(k)) cache.set(k, expand(s.marks[k]));
          return cache.get(k)[w.dataset.w] || '';
        };
        words.forEach((w, i) => {
          const colour = colourOf(w);
          w.className = colour ? `bib-w hl-${colour}` : 'bib-w';
          if (w.bibSpace) {
            const next = words[i + 1];
            const joined = colour && next && colourOf(next) === colour;
            w.bibSpace.className = joined ? `bib-sp hl-${colour}` : 'bib-sp';
          }
        });
      }

      function commit(list, colour) {
        const byKey = new Map();
        for (const w of list) {
          const k = w.dataset.k;
          const n = +w.dataset.w;
          const r = byKey.get(k) || [n, n];
          byKey.set(k, [Math.min(r[0], n), Math.max(r[1], n)]);
        }
        for (const [k, [a, b]] of byKey) {
          const next = mark(s.marks[k], a, b, colour);
          if (next.length) s.marks[k] = next; else delete s.marks[k];
        }
        const keys = Object.keys(s.marks);
        if (keys.length > MAX_MARKED_VERSES) {
          for (const k of keys.slice(0, keys.length - MAX_MARKED_VERSES)) delete s.marks[k];
          toast('The oldest highlights were let go to make room.', 'warn');
        }
        ctx.save();
        paint();
      }

      // ----- the highlighter -----
      const wordAt = (x, y) => {
        const hit = document.elementFromPoint(x, y);
        const w = hit && hit.closest && hit.closest('.bib-w');
        return w && reader.contains(w) ? w : null;
      };

      function preview() {
        for (const w of reader.querySelectorAll('.is-pending')) w.classList.remove('is-pending');
        if (!drag) return;
        const [a, b] = [drag.from, drag.to].sort((x, y) => x - y);
        for (let i = a; i <= b; i++) words[i].classList.add('is-pending');
      }

      reader.addEventListener('pointerdown', (e) => {
        if (!pen || e.button > 0) return;
        const vn = e.target.closest && e.target.closest('.bib-vn');
        if (vn) {
          // With a pen in hand, a verse number marks the whole verse.
          e.preventDefault();
          commit(words.filter((w) => w.dataset.k === vn.dataset.k), pen === 'erase' ? null : pen);
          return;
        }
        const w = e.target.closest && e.target.closest('.bib-w');
        if (!w) return;
        e.preventDefault();
        drag = { from: +w.dataset.i, to: +w.dataset.i, id: e.pointerId };
        try { reader.setPointerCapture(e.pointerId); } catch { /* fine without */ }
        preview();
      });
      reader.addEventListener('pointermove', (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const w = wordAt(e.clientX, e.clientY);
        if (w && +w.dataset.i !== drag.to) { drag.to = +w.dataset.i; preview(); }
      });
      const finish = (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const [a, b] = [drag.from, drag.to].sort((x, y) => x - y);
        drag = null;
        preview();
        if (e.type === 'pointercancel') return;
        commit(words.slice(a, b + 1), pen === 'erase' ? null : pen);
      };
      reader.addEventListener('pointerup', finish);
      reader.addEventListener('pointercancel', finish);
      // Verse numbers are links to Blue Letter Bible — except while marking.
      reader.addEventListener('click', (e) => { if (pen && e.target.closest && e.target.closest('.bib-vn')) e.preventDefault(); });

      // ----- keys, in the big view -----
      if (ctx.expanded) {
        on(document, 'keydown', (e) => {
          if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
          if (e.metaKey || e.ctrlKey || e.altKey) return;
          const span = chapterSpan();
          if (e.key === 'ArrowRight' && span) { const n = B().adjacent(span.last.code, span.last.c2, 1); if (n) { e.preventDefault(); openRef(n); } }
          else if (e.key === 'ArrowLeft' && span) { const p = B().adjacent(span.first.code, span.first.c1, -1); if (p) { e.preventDefault(); openRef(p); } }
          else if (e.key === '+' || e.key === '=') resize(1.15);
          else if (e.key === '-' || e.key === '_') resize(1 / 1.15);
          else if (e.key === 'f' || e.key === 'F') toggleFull();
        });
      }

      // ----- start -----
      drawTools();
      drawPicker();
      loadVersions().then(() => lookup());
      if (ctx.expanded && fullscreenFor && ctx.item && fullscreenFor === ctx.item.id) {
        fullscreenFor = null;
        setFull(true);
      }

      return {
        destroy() {
          loadSeq += 1;
          for (const off of docs) off();
          if (document.fullscreenElement === wrap) document.exitFullscreen().catch(() => {});
        },
      };
    },
  });
}(window.Desk));
