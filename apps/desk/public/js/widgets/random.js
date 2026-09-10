// ===================================================================
// Widget — Random number
//
// A number in a range, a roll of dice, or a coin. One widget rather than
// three, because they are the same gesture with different faces on it, and a
// board with three near-identical cards is a board nobody can scan.
//
// "No repeats" is here for the same reason it is on the student randomiser:
// a picker that lands on 7 three times running is one a class stops trusting,
// however fair it actually was.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon, clamp, shuffle, toast } = Desk;

  const MODES = [
    { key: 'number', label: 'Number' },
    { key: 'dice', label: 'Dice' },
    { key: 'coin', label: 'Coin' },
  ];

  // Pips, as unit coordinates on a die face.
  const PIPS = {
    1: [[.5, .5]],
    2: [[.28, .28], [.72, .72]],
    3: [[.28, .28], [.5, .5], [.72, .72]],
    4: [[.28, .28], [.72, .28], [.28, .72], [.72, .72]],
    5: [[.28, .28], [.72, .28], [.5, .5], [.28, .72], [.72, .72]],
    6: [[.28, .25], [.72, .25], [.28, .5], [.72, .5], [.28, .75], [.72, .75]],
  };

  /** A coin, with the initial on its face. */
  function coinFace(side) {
    return `<svg viewBox="0 0 100 100" class="coin-svg" role="img" aria-label="${side}">
      <circle cx="50" cy="50" r="45" fill="currentColor" opacity=".14"/>
      <circle cx="50" cy="50" r="45" fill="none" stroke="currentColor" stroke-width="4"/>
      <circle cx="50" cy="50" r="36" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".45"/>
      <text x="50" y="50" class="coin-letter">${side[0]}</text>
    </svg>`;
  }

  function dieFace(n) {
    const pips = (PIPS[n] || []).map(([x, y]) =>
      `<circle cx="${x * 100}" cy="${y * 100}" r="9" fill="currentColor"/>`).join('');
    return `<svg viewBox="0 0 100 100" class="die" aria-label="${n}">
      <rect x="3" y="3" width="94" height="94" rx="18" fill="none" stroke="currentColor" stroke-width="4"/>
      ${pips}</svg>`;
  }

  Desk.widget({
    type: 'random',
    name: 'Random number',
    blurb: 'A number in any range, a roll of dice, or a coin — with an option not to repeat itself.',
    icon: 'dice',
    category: 'other',
    size: { w: 3, h: 4 },
    min: { w: 2, h: 3 },

    init(s) {
      if (!MODES.some((m) => m.key === s.mode)) s.mode = 'number';
      if (typeof s.min !== 'number') s.min = 1;
      if (typeof s.max !== 'number') s.max = 30;
      if (typeof s.dice !== 'number') s.dice = 2;
      if (typeof s.sides !== 'number') s.sides = 6;
      if (typeof s.noRepeats !== 'boolean') s.noRepeats = false;
      if (!Array.isArray(s.drawn)) s.drawn = [];
      if (typeof s.last !== 'string') s.last = '';
    },

    holdsContent: (s) => (s.drawn.length ? `${s.drawn.length} already drawn.` : ''),

    mount(ctx) {
      const s = ctx.state;
      let rolling = null;

      const display = el('div.rnd-display');
      const note = el('div.rnd-note');
      const rollBtn = el('button.btn.btn--primary.btn--wide', { onclick: () => roll() });
      const extra = el('div.rnd-extra');
      const modeSeg = el('div.seg.seg--tiny');

      ctx.root.append(el('div.random', {}, [modeSeg, el('div.rnd-face', {}, [display, note]), rollBtn, extra]));

      // ---------- what a result looks like ----------

      function show(value) {
        Desk.clear(display);
        if (s.mode === 'dice') {
          const faces = String(value).split(',').map(Number);
          display.append(el('div.dice-row', { svg: faces.map(dieFace).join('') }));
          if (faces.length > 1) display.append(el('div.dice-total', { text: `${faces.reduce((a, b) => a + b, 0)}` }));
        } else if (s.mode === 'coin') {
          display.append(
            el('div.coin', { svg: coinFace(value) }),
            el('div.coin-word', { text: value }),
          );
        } else {
          display.append(el('div.rnd-number', { text: value }));
        }
      }

      // ---------- rolling ----------

      const pool = () => {
        const lo = Math.min(s.min, s.max);
        const hi = Math.max(s.min, s.max);
        const all = [];
        for (let n = lo; n <= hi && all.length < 5000; n += 1) all.push(String(n));
        return s.noRepeats ? all.filter((n) => !s.drawn.includes(n)) : all;
      };

      function pickValue() {
        if (s.mode === 'coin') return Math.random() < 0.5 ? 'Heads' : 'Tails';
        if (s.mode === 'dice') {
          return Array.from({ length: clamp(s.dice, 1, 6) },
            () => 1 + Math.floor(Math.random() * clamp(s.sides, 2, 20))).join(',');
        }
        let options = pool();
        if (!options.length) {
          // Every number has come up. Start the next round rather than stop.
          s.drawn = [];
          options = pool();
          toast('Every number has come up — starting again.');
        }
        return options[Math.floor(Math.random() * options.length)];
      }

      function roll() {
        Desk.sound.unlock();
        if (rolling) return;
        const lo = Math.min(s.min, s.max);
        const hi = Math.max(s.min, s.max);
        if (s.mode === 'number' && hi - lo > 100000) { toast('That range is too wide.', 'warn'); return; }

        const landed = pickValue();
        const started = performance.now();
        const RUN = 900;
        let nextAt = 0;
        rollBtn.disabled = true;
        display.classList.add('is-rolling');

        rolling = (now) => {
          const t = Math.min(1, (now - started) / RUN);
          if (t >= 1) {
            rolling = null;
            rollBtn.disabled = false;
            display.classList.remove('is-rolling');
            s.last = landed;
            if (s.mode === 'number' && s.noRepeats && !s.drawn.includes(landed)) s.drawn.push(landed);
            ctx.save();
            show(landed);
            display.classList.add('is-landed');
            setTimeout(() => display.classList.remove('is-landed'), 700);
            Desk.sound.play('rise');
            paintNote();
            drawExtra();
            return;
          }
          if (now >= nextAt) {
            nextAt = now + 40 + 180 * (t * t);
            show(pickValue());
            Desk.sound.play('tick');
          }
        };
      }

      // ---------- chrome ----------

      function paintNote() {
        if (s.mode === 'coin') { note.textContent = ''; return; }
        if (s.mode === 'dice') {
          note.textContent = `${clamp(s.dice, 1, 6)} × d${clamp(s.sides, 2, 20)}`;
          return;
        }
        const lo = Math.min(s.min, s.max);
        const hi = Math.max(s.min, s.max);
        note.textContent = s.noRepeats
          ? `${pool().length} of ${hi - lo + 1} left`
          : `${lo} to ${hi}`;
      }

      function drawModes() {
        Desk.clear(modeSeg);
        for (const m of MODES) {
          modeSeg.append(el('button.seg-btn', {
            text: m.label,
            class: s.mode === m.key ? 'is-on' : '',
            onclick: () => {
              s.mode = m.key;
              s.last = '';
              ctx.save();
              Desk.clear(display).append(el('div.rnd-number', { text: '?' }));
              paintNote(); drawExtra(); drawModes();
            },
          }));
        }
      }

      function stepper(label, value, lo, hi, onChange) {
        return el('div.plan-row', {}, [
          el('span.hint', { text: label }),
          el('div.stepper', {}, [
            el('button.icon-btn', { svg: icon('minus', 15), 'aria-label': `Fewer ${label}`, onclick: () => onChange(clamp(value - 1, lo, hi)) }),
            el('span.stepper-value', { text: String(value) }),
            el('button.icon-btn', { svg: icon('plus', 15), 'aria-label': `More ${label}`, onclick: () => onChange(clamp(value + 1, lo, hi)) }),
          ]),
        ]);
      }

      function drawExtra() {
        Desk.clear(extra);

        if (s.mode === 'number') {
          const num = (key, label) => el('label.field.field--row', {}, [
            el('span.field-label', { text: label }),
            el('input.input.input--num', {
              type: 'number', value: s[key], min: -100000, max: 100000,
              onchange: (e) => {
                const n = Math.round(Number(e.target.value));
                if (Number.isFinite(n)) { s[key] = n; s.drawn = []; ctx.save(); paintNote(); }
              },
            }),
          ]);
          extra.append(el('div.rnd-range', {}, [num('min', 'From'), num('max', 'To')]));
          extra.append(el('label.check-inline', {}, [
            el('input', {
              type: 'checkbox', checked: s.noRepeats,
              onchange: (e) => { s.noRepeats = e.target.checked; s.drawn = []; ctx.save(); paintNote(); Desk.keepFocus(ctx.root, drawExtra); },
            }),
            el('span', { text: 'No repeats until they have all come up' }),
          ]));
          if (s.noRepeats && s.drawn.length) {
            extra.append(el('button.btn.btn--small', {
              svg: icon('reset', 14),
              onclick: () => { s.drawn = []; ctx.save(); paintNote(); drawExtra(); },
            }, ' Start the round again'));
          }
        }

        if (s.mode === 'dice' && ctx.expanded) {
          extra.append(
            stepper('How many', clamp(s.dice, 1, 6), 1, 6, (v) => { s.dice = v; ctx.save(); paintNote(); drawExtra(); }),
            stepper('Sides', clamp(s.sides, 2, 20), 2, 20, (v) => { s.sides = v; ctx.save(); paintNote(); drawExtra(); }),
          );
        }
      }

      drawModes();
      if (s.last) show(s.last); else Desk.clear(display).append(el('div.rnd-number', { text: '?' }));
      paintNote();
      drawExtra();
      Desk.clear(rollBtn).append(el('span', { svg: icon('shuffle', 16) }), document.createTextNode(' Roll'));

      return {
        frame() { if (rolling) rolling(performance.now()); },
        // Animation frames stop in a background tab, so a roll started just
        // before switching away would hang mid-spin with the button disabled.
        // The half-second tick keeps running, so it always lands.
        tick() { if (rolling) rolling(performance.now()); },
      };
    },
  });
}(window.Desk));
