// ===================================================================
// Widget — Flashcards
//
// Sets of cards that nest: a class holds units, a unit holds chapters, and
// every level can hold cards of its own. Studying a set studies everything
// inside it too, so the same cards can be revised a chapter at a time or a
// whole course at once.
//
// Cards go in one at a time, or pasted in bulk (a card per line, the two
// sides split by a tab, comma or semicolon — a spreadsheet column pair or a
// Quizlet export both work) or loaded from a CSV file.
//
// State is plain data inside the board, so it follows the person, teacher or
// student, and costs the server nothing. The board has a size cap shared by
// every tool, so this one keeps to a share of it (MAX_BYTES) and says so
// rather than letting a big paste make the whole board refuse to save.
// Holds nothing about pupils and calls no API, so visitors may use it.
//
//   state.nodes = [{ id, name, parent: id|null, cards: [{ id, f, b, k }] }]
//     f/b  front and back text
//     k    0-3, how well it is known; a "Got it" adds one, "Again" resets it
//   state.at    the set being looked at (null = the top level)
//   state.opts  { shuffle, side: 'front'|'back'|'mixed', weak }
// ===================================================================

(function (Desk) {
  'use strict';

  const { el } = Desk;

  const MAX_BYTES = 150 * 1024;      // this tool's share of the 256KB board
  const MAX_SIDE = 400;              // characters per side of a card
  const MAX_NAME = 80;
  const KNOWN = 3;                   // k at which a card counts as learned

  // ---------- pure helpers (exported for the tests) ----------

  const clip = (s, n) => String(s == null ? '' : s).replace(/\r\n?/g, '\n').trim().slice(0, n);

  let counter = 0;
  function newId(taken) {
    let id;
    do { id = `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 5)}`; }
    while (taken && taken.has(id));
    return id;
  }

  const byId = (nodes, id) => nodes.find((n) => n.id === id) || null;
  const childrenOf = (nodes, pid) => nodes.filter((n) => n.parent === pid);

  /** Ids of a set and everything inside it. `null` means the whole library. */
  function treeIds(nodes, id) {
    if (id == null) return nodes.map((n) => n.id);
    const out = [];
    const stack = [id];
    const seen = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (byId(nodes, cur)) out.push(cur);
      for (const c of childrenOf(nodes, cur)) stack.push(c.id);
    }
    return out;
  }

  /** Every card in a set and in the sets inside it. */
  function cardsUnder(nodes, id) {
    const ids = new Set(treeIds(nodes, id));
    const out = [];
    for (const n of nodes) if (ids.has(n.id)) out.push(...n.cards);
    return out;
  }

  /** A set may not move into itself or anything inside itself. */
  function canMove(nodes, id, parentId) {
    if (parentId == null) return true;
    if (!byId(nodes, parentId)) return false;
    return !treeIds(nodes, id).includes(parentId);
  }

  function removeTree(nodes, id) {
    const gone = new Set(treeIds(nodes, id));
    return nodes.filter((n) => !gone.has(n.id));
  }

  /** The path of names from the top down to a set, for breadcrumbs. */
  function pathTo(nodes, id) {
    const out = [];
    const seen = new Set();
    let cur = byId(nodes, id);
    while (cur && !seen.has(cur.id)) { seen.add(cur.id); out.unshift(cur); cur = cur.parent == null ? null : byId(nodes, cur.parent); }
    return out;
  }

  const bytesOf = (nodes) => new TextEncoder().encode(JSON.stringify(nodes)).length;

  /**
   * Splits delimited text into rows of cells. Understands "quoted, cells",
   * "" for a quote inside one, and line breaks inside quotes — so a CSV that
   * came out of a spreadsheet survives intact.
   */
  function splitRows(text, delim) {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    const src = String(text || '').replace(/^﻿/, '');
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (quoted) {
        if (c === '"') {
          if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
        } else cell += c;
      } else if (c === '"' && cell === '') {
        quoted = true;
      } else if (c === delim) {
        row.push(cell); cell = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && src[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        rows.push(row); row = [];
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  /** Which separator does this text use? Tabs win; then whichever of , ; is commoner. */
  function guessSeparator(text) {
    const t = String(text || '');
    if (t.includes('\t')) return 'tab';
    const first = t.split(/\r?\n/).find((l) => l.trim()) || '';
    const commas = (first.match(/,/g) || []).length;
    const semis = (first.match(/;/g) || []).length;
    return semis > commas ? 'semi' : 'comma';
  }

  const DELIMS = { tab: '\t', comma: ',', semi: ';' };
  const HEAD_FRONT = new Set(['front', 'term', 'question', 'word', 'prompt', 'side 1', 'side1']);
  const HEAD_BACK = new Set(['back', 'definition', 'answer', 'meaning', 'side 2', 'side2']);

  /**
   * Pasted or file text → cards. Returns { cards: [{f, b}], skipped, header, sep }.
   * A line with only one filled cell is skipped (and counted), not guessed at.
   * With three or more columns the extras are joined back onto the back with
   * ", " — an unquoted definition that happens to contain a comma should not
   * lose the end of itself.
   */
  function parseCards(text, sep = 'auto') {
    const use = sep === 'auto' || !DELIMS[sep] ? guessSeparator(text) : sep;
    const delim = DELIMS[use];
    let rows = splitRows(text, delim).filter((r) => r.some((c) => c.trim()));
    let header = false;
    if (rows.length && rows[0].length >= 2
      && HEAD_FRONT.has(rows[0][0].trim().toLowerCase()) && HEAD_BACK.has(rows[0][1].trim().toLowerCase())) {
      header = true;
      rows = rows.slice(1);
    }
    const cards = [];
    let skipped = 0;
    for (const r of rows) {
      const f = clip(r[0], MAX_SIDE);
      const b = clip(r.slice(1).map((c) => c.trim()).filter(Boolean).join(delim === '\t' ? ' ' : ', '), MAX_SIDE);
      if (f && b) cards.push({ f, b }); else skipped++;
    }
    return { cards, skipped, header, sep: use };
  }

  function toCsv(cards) {
    const q = (s) => (/[",\n\r]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
    return `${['front', 'back'].map(q).join(',')}\n${cards.map((c) => `${q(c.f)},${q(c.b)}`).join('\n')}\n`;
  }

  /** Make a saved state safe to use: right shapes, no dangling parents or cycles. */
  function tidy(s) {
    const taken = new Set();
    const nodes = [];
    for (const n of Array.isArray(s.nodes) ? s.nodes : []) {
      if (!n || typeof n.id !== 'string' || taken.has(n.id)) continue;
      taken.add(n.id);
      const cards = [];
      const seenCards = new Set();
      for (const c of Array.isArray(n.cards) ? n.cards : []) {
        if (!c || typeof c.id !== 'string' || seenCards.has(c.id)) continue;
        seenCards.add(c.id);
        cards.push({ id: c.id, f: clip(c.f, MAX_SIDE), b: clip(c.b, MAX_SIDE), k: Number.isInteger(c.k) ? Math.min(KNOWN, Math.max(0, c.k)) : 0 });
      }
      nodes.push({ id: n.id, name: clip(n.name, MAX_NAME) || 'Untitled set', parent: typeof n.parent === 'string' ? n.parent : null, cards });
    }
    // Orphans go to the top; a loop is cut by reaching the top the long way round.
    for (const n of nodes) {
      if (n.parent != null && !byId(nodes, n.parent)) n.parent = null;
    }
    for (const n of nodes) {
      const seen = new Set([n.id]);
      let cur = n.parent == null ? null : byId(nodes, n.parent);
      while (cur) {
        if (seen.has(cur.id)) { n.parent = null; break; }
        seen.add(cur.id);
        cur = cur.parent == null ? null : byId(nodes, cur.parent);
      }
    }
    s.nodes = nodes;
    if (s.at != null && !byId(nodes, s.at)) s.at = null;
    if (s.at === undefined) s.at = null;
    const o = s.opts && typeof s.opts === 'object' ? s.opts : {};
    s.opts = {
      shuffle: o.shuffle !== false,
      side: ['front', 'back', 'mixed'].includes(o.side) ? o.side : 'front',
      weak: o.weak === true,
    };
  }

  /** The cards a study session starts with, as { card, side } in order. */
  function buildQueue(cards, opts, rnd = Math.random) {
    let pool = opts.weak ? cards.filter((c) => c.k < KNOWN) : cards.slice();
    if (opts.shuffle) {
      for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    }
    return pool.map((card) => ({ id: card.id, side: opts.side === 'mixed' ? (rnd() < 0.5 ? 'front' : 'back') : opts.side }));
  }

  /** Where a card answered "Again" goes back in: a few cards on, not straight away. */
  const reinsertAt = (length) => Math.min(length, 3);

  // ---------- the widget ----------

  const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

  Desk.widget({
    type: 'flashcards',
    name: 'Flashcards',
    blurb: 'Sets of flashcards that nest: a class, its units, their chapters. Paste cards in bulk or load a CSV, then study any level.',
    icon: 'copy',
    category: 'class',
    students: true,
    guest: true,                   // keeps cards in the board itself and calls no API
    fills: true,
    tone: 'card',
    size: { w: 5, h: 6 },
    min: { w: 3, h: 4 },

    init(s) { tidy(s); },

    mount(ctx) {
      const s = ctx.state;
      tidy(s);

      let view = 'browse';          // browse | import | study
      let editing = null;           // card id being edited
      let focusFront = false;
      let draftText = '';           // import view, kept across redraws
      let draftSep = 'auto';
      let sess = null;              // the study session

      const root = ctx.root;
      const here = () => (s.at == null ? null : byId(s.nodes, s.at));
      const commit = () => ctx.save();

      // ---------- small dialogs ----------

      async function askName(title, initial = '', confirmLabel = 'Save') {
        const input = el('input.input', { type: 'text', value: initial, maxlength: MAX_NAME, 'aria-label': 'Name' });
        const ok = await Desk.ask({ title, body: [input], confirmLabel });
        return ok ? clip(input.value, MAX_NAME) : null;
      }

      function treeOptions(excludeId) {
        const out = [{ id: null, label: 'Top level', depth: 0 }];
        const walk = (pid, depth) => {
          for (const n of childrenOf(s.nodes, pid)) {
            if (excludeId && !canMove(s.nodes, excludeId, n.id)) continue;
            out.push({ id: n.id, label: n.name, depth });
            walk(n.id, depth + 1);
          }
        };
        walk(null, 1);
        return out;
      }

      async function moveSet(node) {
        const opts = treeOptions(node.id);
        const sel = el('select.select', { 'aria-label': 'Move into' },
          opts.map((o, i) => el('option', { value: String(i), text: `${' '.repeat(o.depth)}${o.label}`, selected: o.id === node.parent })));
        const ok = await Desk.ask({ title: `Move “${node.name}”`, body: [el('p.hint', { text: 'Pick where it should go. Its cards and the sets inside it go with it.' }), sel], confirmLabel: 'Move' });
        if (!ok) return;
        const target = opts[Number(sel.value)];
        if (!target || !canMove(s.nodes, node.id, target.id)) return;
        node.parent = target.id;
        commit();
        draw();
      }

      async function removeSet(node) {
        const ids = treeIds(s.nodes, node.id);
        const cards = cardsUnder(s.nodes, node.id).length;
        const inside = ids.length - 1;
        const what = [inside ? plural(inside, 'set', 'sets') + ' inside it' : '', cards ? plural(cards, 'card', 'cards') : ''].filter(Boolean).join(' and ');
        if (what) {
          const ok = await Desk.ask({ title: `Delete “${node.name}”?`, body: `This also deletes ${what}. It cannot be undone.`, confirmLabel: 'Delete', danger: true });
          if (!ok) return;
        }
        s.nodes = removeTree(s.nodes, node.id);
        if (s.at != null && !byId(s.nodes, s.at)) s.at = node.parent && byId(s.nodes, node.parent) ? node.parent : null;
        commit();
        draw();
      }

      function exportCsv(node) {
        const cards = cardsUnder(s.nodes, node ? node.id : null);
        if (!cards.length) { Desk.toast('No cards to export yet.'); return; }
        const blob = new Blob([toCsv(cards)], { type: 'text/csv;charset=utf-8' });
        const a = el('a', { href: URL.createObjectURL(blob), download: `${(node ? node.name : 'flashcards').replace(/[^\w\- ]+/g, '').trim() || 'flashcards'}.csv` });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      }

      /** Adds cards to a set, stopping at this tool's share of the board. */
      function addCards(node, list) {
        const taken = new Set(s.nodes.flatMap((n) => n.cards.map((c) => c.id)));
        let added = 0;
        for (const c of list) {
          const card = { id: newId(taken), f: c.f, b: c.b, k: 0 };
          taken.add(card.id);
          node.cards.push(card);
          if (bytesOf(s.nodes) > MAX_BYTES) { node.cards.pop(); break; }
          added++;
        }
        if (added) commit();
        return added;
      }

      // ---------- browse ----------

      function drawBrowse() {
        const node = here();
        const kids = childrenOf(s.nodes, node ? node.id : null);
        const total = cardsUnder(s.nodes, node ? node.id : null);
        const learning = total.filter((c) => c.k < KNOWN).length;
        const parts = [];

        // Where am I
        const crumbs = el('nav.fc-crumbs', { 'aria-label': 'Where you are' });
        const crumb = (label, id, current) => el('button.fc-crumb', { type: 'button', text: label, 'aria-current': current ? 'true' : null, onclick: () => { s.at = id; commit(); editing = null; draw(); } });
        crumbs.append(crumb('All sets', null, !node));
        for (const p of pathTo(s.nodes, node && node.id)) {
          crumbs.append(el('span.fc-sep', { text: '›', 'aria-hidden': 'true' }), crumb(p.name, p.id, p.id === node.id));
        }
        const head = el('div.fc-head', {}, [crumbs]);
        if (node) {
          head.append(el('div.fc-tools', {}, [
            el('button.btn.btn--small', { type: 'button', text: 'Rename', onclick: async () => { const n = await askName('Rename set', node.name); if (n) { node.name = n; commit(); draw(); } } }),
            el('button.btn.btn--small', { type: 'button', text: 'Move', onclick: () => moveSet(node) }),
            el('button.btn.btn--small', { type: 'button', text: 'Export CSV', onclick: () => exportCsv(node) }),
            el('button.btn.btn--small.btn--ghost', { type: 'button', text: 'Delete', onclick: () => removeSet(node) }),
          ]));
        }
        parts.push(head);

        // Study this level
        const o = s.opts;
        const study = el('div.fc-study', {}, [
          el('div.fc-study-top', {}, [
            el('div', {}, [
              el('div.fc-count', { text: plural(total.length, 'card', 'cards') }),
              el('div.hint', { text: total.length
                ? `${node ? 'In this set and everything inside it' : 'Across every set'} · ${learning} still learning`
                : (node ? 'Nothing here yet. Add cards below, or paste many at once.' : 'Make a set to begin.') }),
            ]),
            el('button.btn.btn--primary', {
              type: 'button', text: node ? 'Study this set' : 'Study everything', disabled: !total.length,
              onclick: () => startStudy(node ? node.id : null),
            }),
          ]),
          el('div.fc-opts', {}, [
            check('Shuffle', o.shuffle, (v) => { o.shuffle = v; }),
            check('Only ones still learning', o.weak, (v) => { o.weak = v; }),
            el('label.fc-opt', {}, [
              'Show first ',
              el('select.select.select--small', { 'aria-label': 'Show first', onchange: (e) => { o.side = e.target.value; commit(); } },
                [['front', 'the front'], ['back', 'the back'], ['mixed', 'either']].map(([v, t]) => el('option', { value: v, text: t, selected: o.side === v }))),
            ]),
          ]),
        ]);
        parts.push(study);

        // Sets inside
        const list = el('ul.fc-sets');
        for (const k of kids) {
          const n = cardsUnder(s.nodes, k.id).length;
          const subs = treeIds(s.nodes, k.id).length - 1;
          list.append(el('li.fc-set', {}, [
            el('button.fc-open', { type: 'button', onclick: () => { s.at = k.id; commit(); editing = null; draw(); } }, [
              el('span.fc-name', { text: k.name }),
              el('span.fc-meta', { text: [plural(n, 'card', 'cards'), subs ? plural(subs, 'set', 'sets') + ' inside' : ''].filter(Boolean).join(' · ') }),
            ]),
            el('button.btn.btn--small', { type: 'button', text: 'Study', disabled: !n, 'aria-label': `Study ${k.name}`, onclick: () => startStudy(k.id) }),
          ]));
        }
        const newInput = el('input.input', {
          type: 'text', maxlength: MAX_NAME, placeholder: node ? `New set inside ${node.name}` : 'New set, e.g. a class or a subject', 'aria-label': 'New set name',
          onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); addSet(); } },
        });
        function addSet() {
          const name = clip(newInput.value, MAX_NAME);
          if (!name) { newInput.focus(); return; }
          const n = { id: newId(new Set(s.nodes.map((x) => x.id))), name, parent: node ? node.id : null, cards: [] };
          s.nodes.push(n);
          if (bytesOf(s.nodes) > MAX_BYTES) { s.nodes.pop(); Desk.toast('This tool is full. Delete something first.', 'error'); return; }
          s.at = n.id;                // step into it, ready for cards or sub-sets
          commit();
          focusFront = true;
          draw();
        }
        parts.push(el('section.fc-block', {}, [
          el('h3.fc-h', { text: node ? 'Sets inside' : 'Your sets' }),
          kids.length ? list : el('p.hint', { text: node ? 'No sets inside yet. Add one for a unit or chapter, or just put cards straight into this set.' : 'Start with a set for a class or subject. Put units and chapters inside it, then cards inside those.' }),
          el('div.fc-add-row', {}, [newInput, el('button.btn', { type: 'button', text: 'Add set', onclick: addSet })]),
        ]));

        // Cards in this set
        if (node) parts.push(drawCards(node));

        const used = bytesOf(s.nodes);
        if (used > MAX_BYTES * 0.4) {
          parts.push(el('p.hint.fc-space', { text: `Flashcards are using ${Math.round((used / MAX_BYTES) * 100)}% of the space this tool has on your desk.` }));
        }

        return el('div.fc-scroll', {}, parts);
      }

      function check(label, on, set) {
        return el('label.fc-opt', {}, [
          el('input', { type: 'checkbox', checked: on, onchange: (e) => { set(e.target.checked); commit(); } }),
          ` ${label}`,
        ]);
      }

      function drawCards(node) {
        const front = el('input.input.fc-front-in', { type: 'text', maxlength: MAX_SIDE, placeholder: 'Front (term or question)', 'aria-label': 'Front of the new card' });
        const back = el('textarea.textarea.fc-back-in', { rows: 2, maxlength: MAX_SIDE, placeholder: 'Back (answer)', 'aria-label': 'Back of the new card' });
        function add() {
          const f = clip(front.value, MAX_SIDE);
          const b = clip(back.value, MAX_SIDE);
          if (!f || !b) { (f ? back : front).focus(); return; }
          if (!addCards(node, [{ f, b }])) { Desk.toast('This tool is full. Delete something first.', 'error'); return; }
          focusFront = true;
          draw();
        }
        front.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); back.focus(); } });
        back.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); add(); } });

        const rows = el('ul.fc-cards');
        for (const c of node.cards) rows.append(c.id === editing ? editRow(node, c) : cardRow(node, c));

        return el('section.fc-block', {}, [
          el('div.fc-h-row', {}, [
            el('h3.fc-h', { text: `Cards in this set (${node.cards.length})` }),
            el('button.btn.btn--small', { type: 'button', text: 'Paste many or load a CSV', onclick: () => { view = 'import'; draw(); } }),
          ]),
          el('div.fc-new', {}, [front, back, el('button.btn.btn--primary', { type: 'button', text: 'Add card', onclick: add })]),
          node.cards.length ? rows : el('p.hint', { text: 'No cards directly in this set yet.' }),
        ]);
      }

      function dots(k) {
        return el('span.fc-dots', { role: 'img', 'aria-label': k >= KNOWN ? 'Learned' : k ? 'Getting there' : 'New or missed' },
          [0, 1, 2].map((i) => el('span.fc-dot', { class: i < k ? 'is-on' : '' })));
      }

      function cardRow(node, c) {
        return el('li.fc-row', {}, [
          el('div.fc-sides', {}, [el('div.fc-f', { text: c.f }), el('div.fc-b', { text: c.b })]),
          dots(c.k),
          el('button.icon-btn', { type: 'button', 'aria-label': 'Edit card', title: 'Edit', onclick: () => { editing = c.id; draw(); }, svg: Desk.icon('settings', 16) }),
          el('button.icon-btn.icon-btn--danger', { type: 'button', 'aria-label': 'Delete card', title: 'Delete', onclick: () => { node.cards = node.cards.filter((x) => x.id !== c.id); commit(); draw(); }, svg: Desk.icon('trash', 16) }),
        ]);
      }

      function editRow(node, c) {
        const f = el('input.input', { type: 'text', value: c.f, maxlength: MAX_SIDE, 'aria-label': 'Front' });
        const b = el('textarea.textarea', { rows: 2, value: c.b, maxlength: MAX_SIDE, 'aria-label': 'Back' });
        function save() {
          const nf = clip(f.value, MAX_SIDE);
          const nb = clip(b.value, MAX_SIDE);
          if (!nf || !nb) { (nf ? b : f).focus(); return; }
          c.f = nf; c.b = nb;
          editing = null;
          commit();
          draw();
        }
        b.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); } if (e.key === 'Escape') { editing = null; draw(); } });
        f.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); b.focus(); } if (e.key === 'Escape') { editing = null; draw(); } });
        setTimeout(() => f.focus(), 0);
        return el('li.fc-row.is-editing', {}, [
          el('div.fc-sides', {}, [f, b]),
          el('button.btn.btn--small.btn--primary', { type: 'button', text: 'Save', onclick: save }),
          el('button.btn.btn--small', { type: 'button', text: 'Cancel', onclick: () => { editing = null; draw(); } }),
        ]);
      }

      // ---------- import ----------

      function drawImport() {
        const node = here();
        if (!node) { view = 'browse'; return drawBrowse(); }
        const box = el('textarea.textarea.fc-paste', {
          placeholder: 'mitosis\tcell division that makes two identical cells\nmeiosis\tcell division that makes four different cells\n\nOne card per line. Split front from back with a tab, comma or semicolon.',
          'aria-label': 'Cards to add', value: draftText,
        });
        const sep = el('select.select.select--small', { 'aria-label': 'Separator', onchange: (e) => { draftSep = e.target.value; preview(); } },
          [['auto', 'Detect it'], ['tab', 'Tab'], ['comma', 'Comma'], ['semi', 'Semicolon']].map(([v, t]) => el('option', { value: v, text: t, selected: draftSep === v })));
        const info = el('p.fc-found', { 'aria-live': 'polite' });
        const sample = el('ul.fc-sample');
        const go = el('button.btn.btn--primary', { type: 'button', text: 'Add cards', disabled: true });
        let found = [];

        function preview() {
          draftText = box.value;
          const r = parseCards(draftText, draftSep);
          found = r.cards;
          const bits = [plural(found.length, 'card', 'cards') + ' found'];
          if (r.skipped) bits.push(`${plural(r.skipped, 'line', 'lines')} skipped (needs both a front and a back)`);
          if (r.header) bits.push('first row looked like a header, so it was left out');
          info.textContent = draftText.trim() ? bits.join(' · ') : '';
          sample.replaceChildren(...found.slice(0, 3).map((c) => el('li', {}, [el('strong', { text: c.f }), ' → ', c.b])));
          go.disabled = !found.length;
          go.textContent = found.length ? `Add ${plural(found.length, 'card', 'cards')}` : 'Add cards';
        }
        box.addEventListener('input', preview);
        go.addEventListener('click', () => {
          const added = addCards(node, found);
          if (added < found.length) Desk.toast(`Added ${added} of ${found.length}. This tool is full, so the rest were left out.`, 'error');
          else Desk.toast(`Added ${plural(added, 'card', 'cards')} to ${node.name}.`);
          draftText = ''; draftSep = 'auto'; view = 'browse';
          draw();
        });

        const page = el('div.fc-scroll', {}, [
          el('div.fc-head', {}, [
            el('button.btn.btn--small', { type: 'button', text: '← Back', onclick: () => { view = 'browse'; draw(); } }),
            el('h3.fc-h', { text: `Add cards to “${node.name}”` }),
          ]),
          el('p.hint', { text: 'Paste from a spreadsheet, a Quizlet export or a CSV, one card per line. Or load a file.' }),
          box,
          el('div.fc-import-row', {}, [
            el('label.fc-opt', {}, ['Separator ', sep]),
            el('button.btn.btn--small', {
              type: 'button', text: 'Load a CSV or text file',
              onclick: async () => {
                const file = await Desk.pickFile('.csv,.tsv,.txt,text/csv,text/plain,text/tab-separated-values');
                if (!file) return;
                if (file.size > 600 * 1024) { Desk.toast('That file is too big for this tool.', 'error'); return; }
                box.value = await file.text();
                preview();
              },
            }),
          ]),
          info, sample,
          el('div.fc-actions', {}, [el('button.btn', { type: 'button', text: 'Cancel', onclick: () => { view = 'browse'; draw(); } }), go]),
        ]);
        preview();
        setTimeout(() => box.focus(), 0);
        return page;
      }

      // ---------- study ----------

      function startStudy(id) {
        const cards = cardsUnder(s.nodes, id);
        const queue = buildQueue(cards, s.opts);
        if (!queue.length) { Desk.toast(s.opts.weak ? 'Everything here is already learned. Turn off “Only ones still learning” to go through it anyway.' : 'No cards to study.'); return; }
        const node = id == null ? null : byId(s.nodes, id);
        sess = { title: node ? node.name : 'Everything', queue, total: queue.length, missed: new Set(), got: 0, flipped: false, done: false };
        view = 'study';
        draw();
      }

      const find = (id) => { for (const n of s.nodes) { const c = n.cards.find((x) => x.id === id); if (c) return c; } return null; };

      function answer(right) {
        if (!sess || sess.done || !sess.flipped) return;
        const item = sess.queue.shift();
        const card = find(item.id);
        if (card) card.k = right ? Math.min(KNOWN, card.k + 1) : 0;
        if (right) sess.got++;
        else { sess.missed.add(item.id); sess.queue.splice(reinsertAt(sess.queue.length), 0, item); }
        sess.flipped = false;
        if (!sess.queue.length) sess.done = true;
        commit();
        draw();
      }

      function flip() { if (sess && !sess.done) { sess.flipped = !sess.flipped; draw(); } }

      function leave() { sess = null; view = 'browse'; draw(); }

      function sizeClass(text) {
        const n = text.length;
        return n > 220 ? 'is-xs' : n > 110 ? 'is-s' : n > 45 ? 'is-m' : 'is-l';
      }

      function drawStudy() {
        if (!sess) { view = 'browse'; return drawBrowse(); }
        const bar = (pct) => el('div.fc-bar', { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(pct) }, el('div.fc-bar-fill', { style: { width: `${pct}%` } }));

        if (sess.done) {
          const first = sess.total - sess.missed.size;
          const wrap = el('div.fc-study-view.fc-done', { tabindex: '-1' }, [
            el('div.fc-head', {}, [el('h3.fc-h', { text: sess.title })]),
            bar(100),
            el('div.fc-summary', {}, [
              el('div.fc-big', { text: `${first} of ${sess.total}` }),
              el('div.hint', { text: sess.missed.size ? `right the first time. ${plural(sess.missed.size, 'card', 'cards')} to look at again.` : 'right the first time. Nothing missed.' }),
            ]),
            el('div.fc-actions', {}, [
              sess.missed.size ? el('button.btn', { type: 'button', text: 'Practise the missed ones', onclick: () => {
                const ids = [...sess.missed];
                const queue = buildQueue(ids.map(find).filter(Boolean), { ...s.opts, weak: false });
                sess = { title: sess.title, queue, total: queue.length, missed: new Set(), got: 0, flipped: false, done: false };
                draw();
              } }) : null,
              el('button.btn.btn--primary', { type: 'button', text: 'Back to the sets', onclick: leave }),
            ]),
          ]);
          wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') leave(); });
          return wrap;
        }

        const item = sess.queue[0];
        const card = find(item.id);
        if (!card) { sess.queue.shift(); if (!sess.queue.length) sess.done = true; return drawStudy(); }
        const showing = sess.flipped ? (item.side === 'front' ? 'back' : 'front') : item.side;
        const text = showing === 'front' ? card.f : card.b;
        const left = sess.queue.length;
        const learned = sess.total - new Set(sess.queue.map((q) => q.id)).size;

        const face = el('button.fc-face', { type: 'button', class: `${showing === 'front' ? '' : 'is-back'} ${sizeClass(text)}`, 'aria-label': `${showing === 'front' ? 'Front' : 'Back'}: ${text}. Press to turn over.`, onclick: flip }, [
          el('span.fc-side', { text: showing === 'front' ? 'Front' : 'Back' }),
          el('span.fc-text', { text }),
        ]);

        const wrap = el('div.fc-study-view', { tabindex: '-1' }, [
          el('div.fc-head', {}, [
            el('button.btn.btn--small', { type: 'button', text: '← Stop', onclick: leave }),
            el('h3.fc-h', { text: sess.title }),
            el('span.fc-left', { text: `${left} to go` }),
          ]),
          bar((learned / sess.total) * 100),
          face,
          sess.flipped
            ? el('div.fc-answer', {}, [
              el('button.btn.fc-again', { type: 'button', onclick: () => answer(false) }, ['Again ', el('kbd', { text: '←' })]),
              el('button.btn.btn--primary.fc-got', { type: 'button', onclick: () => answer(true) }, ['Got it ', el('kbd', { text: '→' })]),
            ])
            : el('div.fc-answer', {}, [el('button.btn.btn--primary', { type: 'button', onclick: flip }, ['Turn over ', el('kbd', { text: 'Space' })])]),
          el('p.hint.fc-keys', { text: 'Space turns the card. Arrow keys: left for Again, right for Got it.' }),
        ]);
        wrap.addEventListener('keydown', (e) => {
          if (e.target.closest && e.target.closest('input, textarea, select')) return;
          if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); }
          else if (e.key === 'ArrowRight') { e.preventDefault(); if (sess.flipped) answer(true); else flip(); }
          else if (e.key === 'ArrowLeft') { e.preventDefault(); if (sess.flipped) answer(false); }
          else if (e.key === 'Escape') leave();
        });
        return wrap;
      }

      // ---------- draw ----------

      function draw() {
        root.replaceChildren();
        const page = view === 'study' ? drawStudy() : view === 'import' ? drawImport() : drawBrowse();
        root.append(el('div.flashcards', {}, page));
        // Typing goes to the new-card box after an add; keys go to the study card.
        if (focusFront) {
          focusFront = false;
          const f = root.querySelector('.fc-front-in');
          if (f) f.focus();
        }
        const study = root.querySelector('.fc-study-view');
        if (study) study.focus();
      }

      draw();
      return { destroy() { sess = null; } };
    },

    // Exposed for the tests.
    _parseCards: parseCards,
    _toCsv: toCsv,
    _splitRows: splitRows,
    _guessSeparator: guessSeparator,
    _treeIds: treeIds,
    _cardsUnder: cardsUnder,
    _canMove: canMove,
    _removeTree: removeTree,
    _pathTo: pathTo,
    _tidy: tidy,
    _buildQueue: buildQueue,
    _reinsertAt: reinsertAt,
    _bytesOf: bytesOf,
    _limits: { MAX_BYTES, MAX_SIDE, MAX_NAME, KNOWN },
  });

}(window.Desk));
