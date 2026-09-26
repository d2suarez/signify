// ===================================================================
// Widget — Calculator
//
// A calculator for the front of the room: big enough to read from the back,
// and it shows the SUM as well as the answer. That second part is the whole
// reason this is not just a phone calculator — a class watching a teacher
// work something out needs to see what was typed, not only what came out.
//
// It also does times and divide before plus and minus, which a phone
// calculator usually does not. In a maths lesson that is not a preference,
// it is the thing being taught.
//
// No eval, ever. The expression is tokenised and worked out here, so the only
// thing that can come out of a string of digits is a number.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon, toast } = Desk;

  const OPS = {
    '+': { rank: 1, apply: (a, b) => a + b },
    '−': { rank: 1, apply: (a, b) => a - b },
    '×': { rank: 2, apply: (a, b) => a * b },
    '÷': { rank: 2, apply: (a, b) => (b === 0 ? NaN : a / b) },
  };

  /** Splits an expression into numbers and operators. Null if it is malformed. */
  function tokenise(text) {
    const out = [];
    let i = 0;
    const raw = String(text || '');

    while (i < raw.length) {
      const c = raw[i];
      if (c === ' ') { i += 1; continue; }

      // Whether a number has just been read. Almost every rule below turns on
      // this: the same character means different things either side of it.
      const afterNumber = out.length > 0 && typeof out[out.length - 1] === 'number';

      if (OPS[c]) {
        // An operator is only an operator BETWEEN two numbers. A minus
        // anywhere else is the sign of the number that follows it, which the
        // number branch reads; any other operator in that position is
        // malformed and there is nothing sensible to guess.
        if (afterNumber) { out.push(c); i += 1; continue; }
        if (c !== '−') return null;
      } else if (afterNumber) {
        // Two numbers running together with nothing to join them — "2 3".
        return null;
      }

      const rest = raw.slice(i);
      const m = /^(−?)(\d*\.?\d+)(%?)/.exec(rest);
      if (!m) return null;
      let n = Number(m[2]);
      if (!Number.isFinite(n)) return null;
      if (m[1]) n = -n;
      if (m[3]) n /= 100;
      out.push(n);
      i += m[0].length;
    }

    if (!out.length || typeof out[out.length - 1] !== 'number') return null;
    return out;
  }

  /**
   * Works out a tokenised expression, times and divide first.
   *
   * Two passes rather than a parser: the grammar is four infix operators and
   * two precedence levels, and a shunting yard here would be more machinery
   * than the problem has.
   */
  function evaluate(text) {
    const tokens = tokenise(text);
    if (!tokens) return null;

    const pass = (rank) => {
      for (let i = 1; i < tokens.length; i += 2) {
        const op = OPS[tokens[i]];
        if (!op || op.rank !== rank) continue;
        const value = op.apply(tokens[i - 1], tokens[i + 1]);
        tokens.splice(i - 1, 3, value);
        i -= 2;
      }
    };
    pass(2);
    pass(1);

    const answer = tokens[0];
    return Number.isFinite(answer) ? answer : null;
  }

  /** Enough digits to be exact, without 0.30000000000000004 on the board. */
  function show(n) {
    if (n == null) return '';
    const rounded = Number(n.toPrecision(12));
    if (Math.abs(rounded) >= 1e12 || (rounded !== 0 && Math.abs(rounded) < 1e-9)) {
      return rounded.toExponential(6).replace('e', ' × 10^');
    }
    return String(rounded);
  }

  const KEYS = [
    ['AC', 'clear'], ['⌫', 'back'], ['%', 'percent'], ['÷', 'op'],
    ['7', 'num'], ['8', 'num'], ['9', 'num'], ['×', 'op'],
    ['4', 'num'], ['5', 'num'], ['6', 'num'], ['−', 'op'],
    ['1', 'num'], ['2', 'num'], ['3', 'num'], ['+', 'op'],
    ['0', 'num'], ['.', 'num'], ['±', 'sign'], ['=', 'equals'],
  ];

  Desk.widget({
    type: 'calculator',
    name: 'Calculator',
    blurb: 'Big enough to read from the back, and it shows the sum as well as the answer.',
    icon: 'calculator',
    category: 'other',
    guest: true,
    size: { w: 3, h: 6 },
    min: { w: 2, h: 5 },

    init(s) {
      if (typeof s.expr !== 'string') s.expr = '';
      if (typeof s.answer !== 'string') s.answer = '';
      if (!Array.isArray(s.tape)) s.tape = [];
    },

    holdsContent: (s) => (s.tape.length ? `${s.tape.length} worked out.` : ''),

    mount(ctx) {
      const s = ctx.state;
      const sum = el('div.calc-sum');
      const out = el('div.calc-answer');
      const pad = el('div.calc-pad');
      const tape = el('div.calc-tape');

      ctx.root.append(el('div.calculator', {}, [
        el('div.calc-screen', {}, [sum, out]), pad, tape,
      ]));

      function paint() {
        sum.textContent = s.expr || '0';
        out.textContent = s.answer;
        out.classList.toggle('is-shown', !!s.answer);
        drawTape();
      }

      function press(label, kind) {
        if (kind === 'clear') { s.expr = ''; s.answer = ''; }
        else if (kind === 'back') { s.expr = s.expr.slice(0, -1); s.answer = ''; }
        else if (kind === 'sign') {
          // Flips the sign of the number being typed, not of the whole sum.
          const m = /(−?)(\d*\.?\d+)$/.exec(s.expr);
          if (m) {
            s.expr = s.expr.slice(0, m.index) + (m[1] ? '' : '−') + m[2];
            s.answer = '';
          }
        } else if (kind === 'equals') {
          const value = evaluate(s.expr);
          if (value == null) { toast('That sum is not finished.', 'warn'); return; }
          s.answer = show(value);
          s.tape.unshift({ expr: s.expr, answer: s.answer });
          s.tape.length = Math.min(s.tape.length, 20);
          // Carrying the answer forward is how somebody actually uses one of
          // these: work out a total, then keep going with it.
          s.expr = s.answer.replace('-', '−');
        } else {
          // Starting a new sum after an answer replaces it; continuing with an
          // operator carries the answer on.
          if (s.answer && kind === 'num') { s.expr = ''; s.answer = ''; }
          else if (s.answer) s.answer = '';
          s.expr += label;
        }
        ctx.save();
        paint();
      }

      for (const [label, kind] of KEYS) {
        pad.append(el('button.calc-key', {
          text: label,
          'data-kind': kind,
          'aria-label': label === 'AC' ? 'Clear' : label === '⌫' ? 'Backspace' : label,
          onclick: () => press(label, kind),
        }));
      }

      function drawTape() {
        Desk.clear(tape);
        if (!ctx.expanded || !s.tape.length) return;
        tape.append(el('div.calc-tape-head', {}, [
          el('span.hint', { text: 'Worked out' }),
          el('button.btn.btn--small', {
            onclick: () => { s.tape = []; ctx.save(); paint(); },
          }, 'Clear'),
        ]));
        for (const row of s.tape) {
          tape.append(el('div.calc-tape-row', {}, [
            el('span.calc-tape-sum', { text: row.expr }),
            el('span.calc-tape-eq', { text: `= ${row.answer}` }),
          ]));
        }
      }

      /**
       * The keyboard, which is how anybody standing at a board actually types
       * a sum. Only when this card is the one open, so a stray key does not
       * land in a calculator nobody is looking at.
       */
      function onKey(e) {
        if (!ctx.expanded) return;
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const tag = (document.activeElement || {}).tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;

        const k = e.key;
        const map = { '*': '×', x: '×', '/': '÷', '-': '−' };
        if (/^[0-9.]$/.test(k)) press(k, 'num');
        else if (map[k]) press(map[k], 'op');
        else if (k === '+') press('+', 'op');
        else if (k === '%') press('%', 'percent');
        else if (k === 'Enter' || k === '=') press('=', 'equals');
        else if (k === 'Backspace') press('⌫', 'back');
        else if (k === 'Escape') press('AC', 'clear');
        else return;
        e.preventDefault();
      }
      window.addEventListener('keydown', onKey);

      paint();
      return { destroy() { window.removeEventListener('keydown', onKey); } };
    },

    // Pure, and the only place a string of characters turns into a number —
    // so it is exported and tested directly rather than through the buttons.
    _evaluate: evaluate,
    _tokenise: tokenise,
    _show: show,
  });
}(window.Desk));
