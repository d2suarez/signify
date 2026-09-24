// ===================================================================
// Widget — Calm down
//
// A shape that grows and shrinks, and a word telling you what to do with it.
// For settling a class after break, or one child who needs a minute.
//
// Two things it deliberately is not: it does not measure anybody, and it does
// not tell anybody how they are feeling. It is a paced-breathing animation,
// which is all a classroom tool has any business being.
//
// It also honours prefers-reduced-motion, where the circle stops moving and
// the words carry the pace instead. Somebody who is already overwhelmed is
// exactly who that setting exists for.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon } = Desk;

  // Each pattern is [in, hold, out, hold] in seconds.
  const PATTERNS = [
    { key: 'box', label: 'Square', steps: [4, 4, 4, 4], blurb: 'Four in, four hold, four out, four hold.' },
    { key: 'calm', label: 'Settle', steps: [4, 0, 6, 0], blurb: 'In for four, out for six. Good for winding down.' },
    { key: 'quick', label: 'Quick', steps: [3, 0, 3, 0], blurb: 'A short one, for the end of break.' },
  ];

  const WORDS = ['Breathe in', 'Hold', 'Breathe out', 'Hold'];

  Desk.widget({
    type: 'breathing',
    name: 'Calm down',
    blurb: 'A shape to breathe along with, for settling a class or one child who needs a minute.',
    icon: 'heart',
    category: 'calm',
    tone: 'block',
    fills: true,
    size: { w: 3, h: 4 },
    min: { w: 2, h: 3 },

    init(s) {
      if (!PATTERNS.some((p) => p.key === s.pattern)) s.pattern = 'box';
      if (typeof s.rounds !== 'number') s.rounds = 5;
      if (typeof s.chime !== 'boolean') s.chime = false;
    },

    mount(ctx) {
      const s = ctx.state;

      let running = false;
      let startedAt = 0;
      let lastStep = -1;

      const circle = el('div.breathe-circle');
      const word = el('div.breathe-word');
      const count = el('div.breathe-count');
      const button = el('button.btn.btn--primary.btn--wide');
      const settings = el('div.breathe-settings');

      ctx.root.append(el('div.breathing', {}, [
        el('div.breathe-stage', {}, [circle, el('div.breathe-text', {}, [word, count])]),
        button, settings,
      ]));

      const pattern = () => PATTERNS.find((p) => p.key === s.pattern) || PATTERNS[0];
      const cycle = () => pattern().steps.reduce((a, b) => a + b, 0);
      const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      function stop() {
        running = false;
        lastStep = -1;
        circle.style.transform = '';
        word.textContent = 'Ready';
        count.textContent = pattern().blurb;
        paintButton();
      }

      function start() {
        running = true;
        startedAt = performance.now();
        lastStep = -1;
        paintButton();
      }

      function paintButton() {
        Desk.clear(button).append(
          el('span', { svg: icon(running ? 'pause' : 'play', 16) }),
          document.createTextNode(running ? ' Stop' : ' Start'),
        );
        button.classList.toggle('btn--danger', running);
      }

      function frame() {
        if (!running) return;
        const steps = pattern().steps;
        const total = cycle();
        const elapsed = (performance.now() - startedAt) / 1000;
        const round = Math.floor(elapsed / total);

        if (s.rounds && round >= s.rounds) {
          stop();
          word.textContent = 'Well done';
          count.textContent = '';
          if (s.chime) Desk.sound.play('quiet');
          return;
        }

        let t = elapsed % total;
        let step = 0;
        while (step < steps.length && t >= steps[step]) { t -= steps[step]; step += 1; }
        step = Math.min(step, steps.length - 1);

        const span = steps[step] || 1;
        const progress = span ? t / span : 1;

        // The circle is big on the in-breath and small on the out, and simply
        // holds where it is during a hold.
        let scale = 1;
        if (step === 0) scale = 0.45 + 0.55 * progress;
        else if (step === 1) scale = 1;
        else if (step === 2) scale = 1 - 0.55 * progress;
        else scale = 0.45;

        if (!reduced()) circle.style.transform = `scale(${scale.toFixed(3)})`;

        if (step !== lastStep) {
          lastStep = step;
          word.textContent = WORDS[step];
          if (s.chime) Desk.sound.play('tick');
        }
        count.textContent = `${Math.ceil(span - t)}` + (s.rounds ? ` · round ${round + 1} of ${s.rounds}` : '');
      }

      function drawSettings() {
        Desk.clear(settings);
        if (!ctx.expanded) return;

        Desk.append(settings,
          el('div.seg', {}, PATTERNS.map((p) => el('button.seg-btn', {
            text: p.label,
            class: s.pattern === p.key ? 'is-on' : '',
            onclick: () => { s.pattern = p.key; ctx.save(); stop(); drawSettings(); },
          }))),
          el('div.plan-row', {}, [
            el('span.hint', { text: 'Rounds' }),
            el('div.stepper', {}, [
              el('button.icon-btn', { svg: icon('minus', 15), 'aria-label': 'Fewer', onclick: () => { s.rounds = Math.max(1, s.rounds - 1); ctx.save(); drawSettings(); } }),
              el('span.stepper-value', { text: String(s.rounds) }),
              el('button.icon-btn', { svg: icon('plus', 15), 'aria-label': 'More', onclick: () => { s.rounds = Math.min(20, s.rounds + 1); ctx.save(); drawSettings(); } }),
            ]),
          ]),
          el('label.check-inline', {}, [
            el('input', {
              type: 'checkbox', checked: s.chime,
              onchange: (e) => { s.chime = e.target.checked; ctx.save(); },
            }),
            el('span', { text: 'A soft sound on each change' }),
          ]),
          reduced() ? el('p.hint', { text: 'Your machine asks for less motion, so the circle stays still and the words keep the pace.' }) : null,
        );
      }

      button.addEventListener('click', () => (running ? stop() : start()));

      stop();
      drawSettings();

      return { frame, destroy() { running = false; } };
    },
  });
}(window.Desk));
