// ===================================================================
// Teacher's Desk — how the desk looks
//
// Colour and what sits behind the board. Kept on the teacher's board record
// rather than in the browser, because somebody who sets their room up wants
// it on the laptop AND on the machine driving the projector.
//
// Applying it is only ever two attributes and two custom properties on the
// root element; the stylesheet does the rest. Nothing here knows what any of
// the colours actually are.
// ===================================================================

window.Desk = window.Desk || {};

(function (Desk) {
  'use strict';

  const { el, icon, toast } = Desk;

  const ACCENTS = [
    { key: 'blue', label: 'Blue' },
    { key: 'green', label: 'Green' },
    { key: 'teal', label: 'Teal' },
    { key: 'purple', label: 'Purple' },
    { key: 'pink', label: 'Pink' },
    { key: 'red', label: 'Red' },
    { key: 'orange', label: 'Orange' },
    { key: 'slate', label: 'Slate' },
  ];

  const MODES = [
    { key: 'auto', label: 'Match my computer' },
    { key: 'light', label: 'Light' },
    { key: 'dark', label: 'Dark' },
  ];

  const PATTERNS = [
    { key: '', label: 'Plain' },
    { key: 'dots', label: 'Dots' },
    { key: 'grid', label: 'Grid' },
  ];

  const FITS = [
    { key: 'cover', label: 'Fill' },
    { key: 'contain', label: 'Fit' },
    { key: 'tile', label: 'Tile' },
  ];

  const DEFAULTS = { theme: 'auto', accent: 'blue', accentHex: '#1d4ed8', chrome: 'card', background: '', backgroundFit: 'cover', backgroundDim: 40 };

  const HEX = /^#[0-9a-f]{6}$/i;

  let current = { ...DEFAULTS };
  let backdrop = null;
  let onSave = () => {};

  /** Paints the whole page from a prefs object. */
  function apply(prefs) {
    current = { ...DEFAULTS, ...(prefs || {}) };
    const root = document.documentElement;

    if (current.theme === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', current.theme);
    root.setAttribute('data-accent', current.accent);
    root.setAttribute('data-chrome', current.chrome);
    // The chosen colour goes in as its own property and the stylesheet decides
    // what to do with it — including lifting it in dark mode, where a colour
    // picked against white is usually too dense to read.
    if (current.accent === 'custom' && HEX.test(current.accentHex || '')) {
      root.style.setProperty('--accent-pick', current.accentHex);
    } else {
      root.style.removeProperty('--accent-pick');
    }

    if (!backdrop) {
      backdrop = el('div#backdrop', { 'aria-hidden': 'true' });
      document.body.prepend(backdrop);
    }

    const bg = current.background || '';
    const isUpload = bg.startsWith('asset:');
    backdrop.style.setProperty('--backdrop-dim', String(current.backgroundDim));

    if (isUpload) {
      backdrop.removeAttribute('data-pattern');
      backdrop.dataset.fit = current.backgroundFit;
      backdrop.style.backgroundImage = `url("/api/assets/${encodeURIComponent(bg.slice(6))}")`;
    } else {
      backdrop.style.backgroundImage = '';
      backdrop.removeAttribute('data-fit');
      if (bg) backdrop.dataset.pattern = bg; else backdrop.removeAttribute('data-pattern');
    }

    document.body.classList.toggle('has-backdrop', !!isUpload);
  }

  const get = () => ({ ...current });
  const init = ({ prefs, save }) => { onSave = save || onSave; apply(prefs); };

  function set(patch) {
    apply({ ...current, ...patch });
    onSave(get());
  }

  // ---------------- the panel ----------------

  function open() {
    const body = el('div.appearance');

    function draw() {
      Desk.clear(body);

      body.append(el('h3.section-title', { text: 'Colour' }));
      const swatches = el('div.accents');
      for (const a of ACCENTS) {
        swatches.append(el('button.accent', {
          'data-accent-swatch': a.key,
          title: a.label, 'aria-label': a.label,
          'aria-pressed': String(current.accent === a.key),
          class: current.accent === a.key ? 'is-on' : '',
          onclick: () => { set({ accent: a.key }); draw(); },
        }));
      }
      // ...and one more that is whatever the teacher wants. The swatch shows
      // the colour it would apply, so the row reads as nine choices rather
      // than eight and a setting.
      swatches.append(el('button.accent.accent--custom', {
        'data-accent-swatch': 'custom',
        title: 'A colour of your own', 'aria-label': 'A colour of your own',
        'aria-pressed': String(current.accent === 'custom'),
        class: current.accent === 'custom' ? 'is-on' : '',
        style: { '--accent-pick': current.accentHex || DEFAULTS.accentHex },
        onclick: () => { set({ accent: 'custom' }); draw(); },
      }, el('span', { svg: icon('palette', 13) })));

      body.append(swatches);

      if (current.accent === 'custom') {
        const hexBox = el('input.input.accent-hex', {
          type: 'text', value: current.accentHex || DEFAULTS.accentHex, maxlength: 7,
          spellcheck: 'false', 'aria-label': 'Colour as a hex code',
          // Only on leaving the field: a half-typed "#1d4" is not a colour,
          // and repainting the whole desk on every keystroke is a strobe.
          onchange: (e) => {
            const v = e.target.value.trim();
            if (!HEX.test(v)) { e.target.value = current.accentHex; toast('A colour looks like #1D4ED8.', 'warn'); return; }
            set({ accent: 'custom', accentHex: v.toLowerCase() });
            draw();
          },
        });

        body.append(el('div.accent-custom', {}, [
          el('input.accent-picker', {
            type: 'color', value: current.accentHex || DEFAULTS.accentHex,
            'aria-label': 'Pick a colour',
            // `input` fires continuously while the picker is dragged, which is
            // exactly what makes it feel live — the desk recolours under the
            // dialog as you move. Only the save is held back.
            oninput: (e) => { apply({ ...current, accent: 'custom', accentHex: e.target.value }); hexBox.value = e.target.value; },
            onchange: (e) => { set({ accent: 'custom', accentHex: e.target.value }); draw(); },
          }),
          hexBox,
        ]));
      }

      body.append(el('h3.section-title', { text: 'How the tools sit' }));
      const chromes = el('div.seg');
      for (const c of [
        { key: 'card', label: 'On cards', blurb: 'Each tool in a panel with its name at the top.' },
        { key: 'bare', label: 'Floating', blurb: 'No panel and no title bar — the tool itself is the object.' },
      ]) {
        chromes.append(el('button.seg-btn', {
          text: c.label, title: c.blurb,
          class: current.chrome === c.key ? 'is-on' : '',
          onclick: () => { set({ chrome: c.key }); draw(); },
        }));
      }
      body.append(chromes);
      body.append(el('p.hint', {
        text: current.chrome === 'bare'
          ? 'Names, and the buttons to open or remove a tool, appear when you point at it.'
          : 'The familiar arrangement: a panel round each tool, with its name and buttons along the top.',
      }));

      body.append(el('h3.section-title', { text: 'Light or dark' }));
      const modes = el('div.seg');
      for (const m of MODES) {
        modes.append(el('button.seg-btn', {
          text: m.label,
          class: current.theme === m.key ? 'is-on' : '',
          onclick: () => { set({ theme: m.key }); draw(); },
        }));
      }
      body.append(modes);

      body.append(el('h3.section-title', { text: 'Behind the board' }));
      const patterns = el('div.starter-row');
      for (const p of PATTERNS) {
        patterns.append(el('button.btn.btn--small', {
          text: p.label,
          class: current.background === p.key ? 'is-on' : '',
          onclick: () => { set({ background: p.key }); draw(); },
        }));
      }
      patterns.append(el('button.btn.btn--small', { svg: icon('plus', 14), onclick: pickImage }, ' Picture'));
      body.append(patterns);

      body.append(el('div.picture-list'));
      drawPictures(body.querySelector('.picture-list'));

      if (current.background.startsWith('asset:')) {
        body.append(
          el('h3.section-title', { text: 'How it sits' }),
          el('div.seg', {}, FITS.map((f) => el('button.seg-btn', {
            text: f.label,
            class: current.backgroundFit === f.key ? 'is-on' : '',
            onclick: () => { set({ backgroundFit: f.key }); draw(); },
          }))),
          el('label.field', {}, [
            el('span.field-label', { text: 'Fade it back, so the cards stay readable' }),
            el('input.range', {
              type: 'range', min: 0, max: 90, step: 5, value: current.backgroundDim,
              oninput: (e) => set({ backgroundDim: Number(e.target.value) }),
            }),
          ]),
        );
      }
    }

    async function drawPictures(host) {
      let mine = [];
      try { mine = (await Desk.api.assets('image')).assets || []; }
      catch { return; }
      if (!mine.length) return;

      Desk.clear(host).append(el('p.hint', { text: 'Your pictures' }));
      const row = el('div.picture-row');
      for (const a of mine) {
        const on = current.background === `asset:${a.id}`;
        row.append(el('button.picture', {
          class: on ? 'is-on' : '',
          title: a.label,
          style: { backgroundImage: `url("/api/assets/${a.id}")` },
          onclick: () => { set({ background: `asset:${a.id}` }); draw(); },
        }, el('span.picture-x', {
          svg: icon('close', 12),
          title: `Remove ${a.label}`,
          onclick: async (e) => {
            e.stopPropagation();
            await Desk.api.deleteAsset(a.id);
            if (on) set({ background: '' });
            draw();
          },
        })));
      }
      host.append(row);
    }

    async function pickImage() {
      const file = await Desk.pickFile('image/*');
      if (!file) return;
      try {
        const saved = await Desk.api.uploadAsset(file);
        if (saved.kind !== 'image') { toast('That was not a picture.', 'warn'); return; }
        set({ background: `asset:${saved.id}` });
        draw();
      } catch (e) { toast(e.message, 'warn'); }
    }

    draw();

    const scrim = el('div.scrim', { onclick: (e) => { if (e.target === scrim) close(); } }, [
      el('div.dialog', { role: 'dialog', 'aria-modal': 'true' }, [
        el('h2.dialog-title', { text: 'Appearance' }),
        el('p.dialog-note', { text: 'This follows you to whichever computer you sign in on — including the one driving the projector.' }),
        body,
        el('div.dialog-actions', {}, [
          el('button.btn', { text: 'Reset', onclick: () => { set({ ...DEFAULTS }); draw(); } }),
          el('button.btn.btn--primary', { text: 'Done', onclick: () => close() }),
        ]),
      ]),
    ]);
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    function close() { scrim.remove(); document.removeEventListener('keydown', onKey); }
    document.addEventListener('keydown', onKey);
    document.body.append(scrim);
  }

  Desk.theme = { init, apply, get, set, open, ACCENTS, DEFAULTS };
}(window.Desk));
