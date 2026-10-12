// ===================================================================
// Widget — Big message
//
// One line, as large as the screen will allow. For "Silent reading", "Line up
// at the door", "Pens down" — the instruction that wants to be on the board
// rather than said twice.
//
// The type size is computed from the text, so a short message fills the wall
// and a long one still fits. That is the whole widget: everything else is
// getting out of the way.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon, clamp } = Desk;

  const PRESETS = [
    'Silent reading', 'Pens down', 'Line up', 'Tidy up time',
    'Eyes this way', 'Hands up to answer', 'Work in pairs', 'Pack away',
  ];

  const STYLES = [
    { key: 'plain', label: 'Plain' },
    { key: 'accent', label: 'Colour' },
    { key: 'invert', label: 'Reversed' },
  ];

  Desk.widget({
    type: 'message',
    name: 'Big message',
    blurb: 'One line, as large as the screen allows. For the instruction you would otherwise say twice.',
    icon: 'message',
    category: 'board',
    guest: true,
    tone: 'block',
    size: { w: 4, h: 3 },
    min: { w: 2, h: 2 },

    init(s) {
      if (typeof s.text !== 'string') s.text = '';
      if (!STYLES.some((x) => x.key === s.style)) s.style = 'accent';
      if (typeof s.flash !== 'boolean') s.flash = false;
    },

    holdsContent: (s) => (s.text.trim() ? 'What it says goes with it.' : ''),

    mount(ctx) {
      const s = ctx.state;
      const shown = el('div.msg-text');
      const shell = el('div.msg', {}, shown);
      const controls = el('div.msg-controls');

      ctx.root.append(el('div.message', {}, [shell, controls]));

      /**
       * Fits the words to the box, in both directions.
       *
       * Guessing from the character count was not enough: it sized against
       * the width alone, and a short card ended up with 68px text in an 84px
       * box, clipped top and bottom. So it measures. Only on edit and on
       * resize, never per frame.
       */
      function fit() {
        const padding = 14;
        const boxW = shell.clientWidth - padding;
        const boxH = shell.clientHeight - padding;
        if (boxW < 20 || boxH < 20) return;

        const text = s.text || 'Type something';
        // Start from a generous guess, then shrink until it genuinely fits.
        let size = Math.min(boxH, (boxW / Math.max(5, text.length)) * 2.6);
        shown.style.fontSize = `${size}px`;

        let guard = 0;
        while ((shown.scrollHeight > boxH || shown.scrollWidth > boxW) && size > 9 && guard < 40) {
          size *= 0.88;
          shown.style.fontSize = `${size}px`;
          guard += 1;
        }
      }

      function paint() {
        shown.textContent = s.text || 'Type something';
        shown.classList.toggle('is-placeholder', !s.text);
        shell.dataset.style = s.style;
        shell.classList.toggle('is-flashing', !!s.flash && !!s.text);
        fit();
      }

      function drawControls() {
        Desk.clear(controls);

        controls.append(el('input.input', {
          type: 'text', value: s.text, maxlength: 120, placeholder: 'What should it say?',
          oninput: (e) => { s.text = e.target.value; ctx.save(); paint(); },
        }));

        if (!ctx.expanded) return;

        const chips = el('div.chips');
        for (const p of PRESETS) {
          chips.append(el('button.chip', { text: p, onclick: () => { s.text = p; ctx.save(); paint(); drawControls(); } }));
        }
        controls.append(chips);

        controls.append(
          el('div.plan-row', {}, [
            el('span.hint', { text: 'Look' }),
            el('div.seg', {}, STYLES.map((x) => el('button.seg-btn', {
              text: x.label,
              class: s.style === x.key ? 'is-on' : '',
              onclick: () => { s.style = x.key; ctx.save(); paint(); drawControls(); },
            }))),
          ]),
          el('label.check-inline', {}, [
            el('input', {
              type: 'checkbox', checked: s.flash,
              onchange: (e) => { s.flash = e.target.checked; ctx.save(); paint(); },
            }),
            el('span', { text: 'Pulse slowly, to catch an eye' }),
          ]),
        );
      }

      paint();
      drawControls();

      // The card can be resized by the teacher at any time, and the text has
      // to follow it.
      const observer = new ResizeObserver(fit);
      observer.observe(shell);

      return { destroy() { observer.disconnect(); } };
    },
  });
}(window.Desk));
