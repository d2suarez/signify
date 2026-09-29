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

  // ---------- reading the two texts ----------

  /** Curly quotes, long dashes and ellipses typed a dozen ways, made one way. */
  function normalise(text) {
    return String(text == null ? '' : text).normalize('NFC')
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

  function tokenize(text, rules) {
    const out = [];
    for (const m of normalise(text).matchAll(TOKEN)) {
      if (m[1]) {
        let key = m[1];
        // Ignoring punctuation means the apostrophe in "Lord's" and the hyphen
        // in "well-being" do not count either — "Lords" and "wellbeing" are
        // right.
        if (rules.punctuation !== 'count') key = key.replace(/['-]/g, '');
        if (rules.capitals !== 'count') key = key.toLocaleLowerCase();
        out.push({ kind: 'word', text: m[1], key });
      } else if (rules.punctuation === 'count') {
        out.push({ kind: 'mark', text: m[2], key: m[3] });
      }
      if (out.length >= MAX_TOKENS) break;
    }
    return out;
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
   * 'capital' (right but for capitals), 'spelling' (a near miss), or null —
   * a different word.
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
    const d = distance(a, b);
    const allowed = a.length >= 8 ? 2 : a.length >= 4 ? 1 : 0;
    if (d <= allowed) return 'spelling';
    if (d === 1 && a.length === b.length && [...a].sort().join('') === [...b].sort().join('')) return 'spelling';
    return null;
  }

  const WEIGHT = { exact: 4, capital: 3, spelling: 2 };

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
    if (step.is === 'exact') return 1;
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
  function grade(passage, answer, rules) {
    const want = tokenize(passage, rules);
    const got = tokenize(answer, rules);
    const steps = align(want, got);
    const tally = { exact: 0, capital: 0, spelling: 0, missing: 0, extra: 0 };
    const words = { got: 0, total: 0 };
    const marks = { got: 0, total: 0 };
    for (const step of steps) {
      tally[step.is] += 1;
      if (step.is === 'extra') continue;
      const c = credit(step, rules);
      step.credit = c;
      const bucket = step.want.kind === 'mark' ? marks : words;
      bucket.total += 1;
      bucket.got += c;
    }
    const score = words.got + marks.got;
    const total = words.total + marks.total;
    return { steps, tally, words, marks, score, total, percent: total ? Math.round((score / total) * 100) : 0 };
  }

  /** 46.5 as "46½" — a half mark is common here, and a decimal reads as fussy. */
  const half = (n) => (Number.isInteger(n) ? String(n) : `${Math.floor(n)}½`);

  // ---------- the widget ----------

  Desk.widget({
    type: 'passage',
    name: 'Passage grader',
    blurb: 'Mark a memorised passage: paste each pupil’s typed answer and see how many words they got right, word by word.',
    icon: 'check',
    category: 'class',
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
      if (!s.draft || typeof s.draft !== 'object') s.draft = { name: '', answer: '', id: '' };
      if (typeof s.draft.name !== 'string') s.draft.name = '';
      if (typeof s.draft.answer !== 'string') s.draft.answer = '';
      if (typeof s.draft.id !== 'string') s.draft.id = '';
      if (!Array.isArray(s.results)) s.results = [];
      s.results = s.results
        .filter((r) => r && typeof r.answer === 'string')
        .map((r) => ({ id: String(r.id || ''), name: String(r.name || '').slice(0, 60), answer: r.answer.slice(0, MAX_ANSWER), at: Number(r.at) || 0 }))
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

      const wrap = el('div.pg');
      const passageBox = el('section.pg-passage');
      const rulesBox = el('details.pg-rules', { open: ctx.expanded ? true : null });
      const gradeBox = el('section.pg-grade');
      const resultBox = el('section.pg-result', { 'aria-live': 'polite' });
      const savedBox = el('section.pg-saved');
      wrap.append(
        el('div.pg-left', {}, [passageBox, rulesBox, gradeBox]),
        el('div.pg-right', {}, [resultBox, savedBox]),
      );
      ctx.root.append(wrap);

      // ---------- the passage ----------

      function drawPassage() {
        Desk.clear(passageBox);
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
            ctx.save();
            drawPassage();
            paint();
            if (changed && s.results.length) toast('The saved scores have been re-marked against the new passage.');
          };
          append(passageBox,
            el('div.pg-label', { text: 'The passage' }),
            title, text,
            el('div.pg-row', {}, [
              el('button.btn.btn--primary.btn--small', { svg: icon('check', 14), onclick: done }, ' Use this passage'),
              s.passage.trim() ? el('button.btn.btn--small.btn--ghost', { text: 'Cancel', onclick: () => { editingPassage = false; drawPassage(); } }) : null,
            ]),
          );
          return;
        }
        const count = tokenize(s.passage, { punctuation: 'ignore', capitals: 'ignore' }).length;
        passageBox.append(el('div.pg-row.pg-passage-set', {}, [
          el('div.pg-passage-name', {}, [
            el('strong', { text: s.title || 'The passage' }),
            el('span.hint', { text: `${count} word${count === 1 ? '' : 's'}` }),
          ]),
          el('button.btn.btn--small.btn--ghost', { text: 'Change', onclick: () => { editingPassage = true; drawPassage(); } }),
        ]));
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

      // ---------- grading one answer ----------

      const pupilList = el('datalist', { id: `pg-pupils-${ctx.item.id}${ctx.expanded ? '-big' : ''}` });
      const nameBox = el('input.input.pg-name', {
        type: 'text', maxlength: '60', value: s.draft.name, placeholder: 'Pupil’s name',
        list: pupilList.id, 'aria-label': 'Pupil’s name', autocomplete: 'off',
        oninput: (e) => { s.draft.name = e.target.value; ctx.save(); },
      });
      const answerBox = el('textarea.textarea.pg-answer', {
        rows: ctx.expanded ? 9 : 4, maxlength: String(MAX_ANSWER), value: s.draft.answer,
        placeholder: 'Paste the pupil’s answer here. It is marked as you paste.', 'aria-label': 'The pupil’s answer',
        spellcheck: 'false',
        oninput: (e) => { s.draft.answer = e.target.value; ctx.save(); paintSoon(); },
      });
      const leftHint = el('span.hint.pg-left-count');

      function drawGrade() {
        const picker = Desk.roster.picker({
          value: s.classKey,
          onPick: (key) => {
            if (key !== s.classKey) { s.classKey = key; ctx.save(); }
            loadPupils();
          },
        });
        picker.classList.add('pg-class');
        gradeBox.append(
          el('div.pg-label', { text: 'Pupil’s answer' }),
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
          if (step.is === 'extra') {
            put(el('span.pg-w.pg-extra', { text: step.got.text, title: 'Added — not in the passage' }), step.got);
            continue;
          }
          const w = step.want;
          if (step.is === 'exact') { put(el('span.pg-w.pg-ok', { text: w.text }), w); continue; }
          if (step.is === 'missing') { put(el('span.pg-w.pg-miss', { text: w.text, title: 'Missing' }), w); continue; }
          // A near miss shows the right word, with what was typed under it.
          const what = step.is === 'capital' ? 'Capitals' : 'Spelling';
          put(el(`span.pg-w.pg-near${step.credit === 1 ? '.is-forgiven' : ''}`, {
            title: `${what}: they wrote “${step.got.text}”${step.credit === 1 ? ' — forgiven' : step.credit ? ' — half credit' : ''}`,
          }, [w.text, el('small', { text: step.got.text })]), w);
        }
        return box;
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
        const r = grade(s.passage, s.draft.answer, rules());
        const t = r.tally;
        const bits = [
          `${t.exact} right`,
          t.spelling ? `${t.spelling} misspelled` : '',
          t.capital ? `${t.capital} capital${t.capital === 1 ? '' : 's'}` : '',
          t.missing ? `${t.missing} missing` : '',
          t.extra ? `${t.extra} added` : '',
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
          marked(r),
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
        } else {
          if (s.results.length >= MAX_RESULTS) { toast(`That is ${MAX_RESULTS} scores — copy them out and clear the list to mark more.`, 'warn'); return; }
          s.results.push({ id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, name, answer: s.draft.answer.slice(0, MAX_ANSWER), at: Date.now() });
        }
        s.draft = { name: '', answer: '', id: '' };
        editingId = null;
        nameBox.value = '';
        answerBox.value = '';
        ctx.save();
        paint();
        nameBox.focus();
      }

      function clearDraft() {
        s.draft = { name: '', answer: '', id: '' };
        editingId = null;
        nameBox.value = '';
        answerBox.value = '';
        ctx.save();
        paint();
      }

      // ---------- saved scores ----------

      function paintSaved() {
        Desk.clear(savedBox);
        if (!s.results.length) return;
        const marks = s.results.map((r) => ({ r, g: s.passage.trim() ? grade(s.passage, r.answer, rules()) : null }));
        const list = el('ul.pg-list');
        for (const { r, g } of marks) {
          list.append(el(`li.pg-item${r.id === editingId ? '.is-open' : ''}`, {}, [
            el('button.pg-open', {
              title: 'Show how this answer was marked',
              onclick: () => {
                editingId = r.id;
                s.draft = { name: r.name, answer: r.answer, id: r.id };
                nameBox.value = r.name;
                answerBox.value = r.answer;
                ctx.save();
                paint();
              },
            }, [
              el('span.pg-item-name', { text: r.name }),
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
      async function copyOut(marks) {
        const rows = [['Name', 'Score', 'Out of', 'Percent'].join('\t')]
          .concat(marks.map(({ r, g }) => [r.name.replace(/\t/g, ' '), g ? g.score : '', g ? g.total : '', g ? `${g.percent}%` : ''].join('\t')));
        const text = rows.join('\n');
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
        toast(ok ? `${marks.length} score${marks.length === 1 ? '' : 's'} copied — paste into your gradebook or a spreadsheet.` : 'Could not copy. Try again from a click.', ok ? undefined : 'warn');
      }

      drawPassage();
      drawRules();
      drawGrade();
      paint();

      return {
        destroy() { clearTimeout(soon); },
      };
    },

    // Exposed for the tests: the marking is the part a teacher has to trust.
    _grade: grade,
    _tokenize: tokenize,
    _kinship: kinship,
  });
}(window.Desk));
