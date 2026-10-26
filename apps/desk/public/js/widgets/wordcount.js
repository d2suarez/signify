// ===================================================================
// Widget — Word count
//
// Paste or type, read the numbers: words, characters, sentences, paragraphs,
// reading time, and an optional goal with a progress bar.
//
// The TEXT is deliberately not saved to the board. It is very likely a pupil's
// writing, and the board is stored on the server (and guest boards in the
// browser). It lives in memory for the life of the page, keyed by card, so
// opening the expanded view and closing it again does not lose it. Only the
// goal — a number — is state.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el } = Desk;

  const WPM = 238;                 // average adult silent reading speed

  /** Pure: every figure the widget shows, from a string. */
  function count(text) {
    const t = String(text || '');
    const words = (t.trim().match(/\S+/g) || []).length;
    const sentences = (t.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) || []).filter((x) => x.trim()).length;
    const paragraphs = t.split(/\n\s*\n/).filter((x) => x.trim()).length;
    return {
      words,
      chars: t.length,
      charsNoSpaces: t.replace(/\s/g, '').length,
      sentences,
      paragraphs,
      seconds: Math.round((words / WPM) * 60),
    };
  }

  function readingTime(seconds) {
    return seconds < 60 ? `${seconds} sec` : `${Math.round(seconds / 60)} min`;
  }

  // Text per card, in memory only (see the header).
  const drafts = new Map();

  Desk.widget({
    type: 'wordcount',
    added: '2026-10-07',
    news: 'Paste a piece of writing to see its words, sentences and reading time against a goal.',
    name: 'Word count',
    blurb: 'Paste or type to count words, characters, sentences and reading time, with an optional word goal.',
    icon: 'notes',
    category: 'class',
    students: true,
    guest: true,                   // holds nothing (text is never saved) and calls no API
    tone: 'card',
    size: { w: 4, h: 4 },
    min: { w: 3, h: 3 },

    init(s) {
      if (!Number.isInteger(s.goal) || s.goal < 0) s.goal = 0;
    },

    readout(s) { return s.goal ? `${s.goal} word goal` : ''; },

    mount(ctx) {
      const s = ctx.state;
      const key = ctx.item && ctx.item.id;

      const box = el('textarea.textarea.wc-text', {
        placeholder: 'Type or paste text here. It is counted on this screen only and is not saved.',
        value: drafts.get(key) || '',
        oninput: () => { drafts.set(key, box.value); paint(); },
      });

      const figs = {};
      const grid = el('div.wc-grid');
      const defs = [
        ['words', 'Words'], ['chars', 'Characters'], ['charsNoSpaces', 'No spaces'],
        ['sentences', 'Sentences'], ['paragraphs', 'Paragraphs'], ['time', 'Reading time'],
      ];
      for (const [k, label] of defs) {
        figs[k] = el('div.wc-num', { text: '0' });
        grid.append(el('div.wc-fig', {}, [el('div.wc-label', { text: label }), figs[k]]));
      }

      const bar = el('div.wc-bar-fill');
      const goalLabel = el('span.hint');
      const goalInput = el('input.input.wc-goal', {
        type: 'number', min: 0, step: 1, placeholder: '500',
        value: s.goal ? String(s.goal) : '',
        oninput: (e) => {
          const n = parseInt(e.target.value, 10);
          s.goal = Number.isInteger(n) && n > 0 ? Math.min(n, 1000000) : 0;
          ctx.save();
          paint();
        },
      });
      const clear = el('button.btn', {
        text: 'Clear',
        onclick: () => { box.value = ''; drafts.delete(key); paint(); box.focus(); },
      });

      ctx.root.append(el('div.wordcount', {}, [
        box,
        grid,
        el('div.wc-goal-row', {}, [
          el('label.hint', { text: 'Word goal' }), goalInput,
          el('div.wc-bar', {}, bar), goalLabel, clear,
        ]),
      ]));

      function paint() {
        const c = count(box.value);
        figs.words.textContent = c.words.toLocaleString();
        figs.chars.textContent = c.chars.toLocaleString();
        figs.charsNoSpaces.textContent = c.charsNoSpaces.toLocaleString();
        figs.sentences.textContent = String(c.sentences);
        figs.paragraphs.textContent = String(c.paragraphs);
        figs.time.textContent = readingTime(c.seconds);
        const pct = s.goal ? Math.min(100, Math.round((c.words / s.goal) * 100)) : 0;
        bar.style.width = `${pct}%`;
        goalLabel.textContent = s.goal ? `${c.words} / ${s.goal}` : '';
      }

      paint();
      return {};
    },

    // Exposed for the tests.
    _count: count,
  });

}(window.Desk));
