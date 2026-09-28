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

  /* The five palettes. Every one carries all four roles, so p1 is always time
     and p2 is always the class — a palette moves the hues, never the meaning. */
  const PALETTES = [
    { key: 'primary', label: 'Primary', note: 'Default', p: ['#ec3013', '#1f4fd1', '#f5c400', '#0e7f89'] },
    { key: 'garden', label: 'Garden', p: ['#1f8a4c', '#0f6f80', '#f2b233', '#e0643a'] },
    { key: 'berry', label: 'Berry', p: ['#7a3fd1', '#d63c72', '#f28c28', '#0f8a7e'] },
    { key: 'ocean', label: 'Ocean', p: ['#1d4ed8', '#0e7f89', '#ffc83d', '#ef6f5c'] },
    { key: 'mono-red', label: 'Mono red', p: ['#ec3013', '#7c1405', '#ffc4b8', '#b8220c'] },
  ];

  /* What a teacher chose under the old eight-accent scheme, in the palette that
     carries the same feeling. Their saved pref is rewritten the first time
     they load the new board, so nobody has to choose again. */
  const ACCENT_TO_PALETTE = {
    blue: 'primary', slate: 'primary',
    green: 'garden', orange: 'garden',
    teal: 'ocean',
    purple: 'berry', pink: 'berry',
    red: 'mono-red',
    custom: 'custom',
  };

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

  const DEFAULTS = { theme: 'auto', palette: 'primary', accentHex: '#ec3013', background: '', backgroundFit: 'cover', backgroundDim: 40 };

  const HEX = /^#[0-9a-f]{6}$/i;

  let current = { ...DEFAULTS };
  let backdrop = null;
  let onSave = () => {};

  /**
   * The ink that reads on a colour. Relative luminance above .35 is light
   * enough that near-black type wins; below it, white does. The threshold is
   * the handoff's, and it is what keeps a teacher's own colour legible from
   * the back of a room.
   */
  function inkFor(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lin = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const L = 0.2126 * lin(n >> 16 & 255) + 0.7152 * lin(n >> 8 & 255) + 0.0722 * lin(n & 255);
    return { ink: L > 0.35 ? '#201e1d' : '#ffffff', luminance: L };
  }

  /** Contrast between a colour and its ink, for warning about a hard-to-read pick. */
  function contrast(hex) {
    const { ink, luminance } = inkFor(hex);
    const other = ink === '#ffffff' ? 1 : 0.0138;   // luminance of #fff and #201e1d
    const [hi, lo] = luminance > other ? [luminance, other] : [other, luminance];
    return (hi + 0.05) / (lo + 0.05);
  }

  /** Paints the whole page from a prefs object. */
  function apply(prefs) {
    current = { ...DEFAULTS, ...(prefs || {}) };
    // A board saved under the old scheme still says `accent`. Read it once, in
    // the palette that carries the same feeling, rather than dropping them
    // back to the default.
    if (!prefs || !prefs.palette) {
      const was = prefs && prefs.accent;
      current.palette = (was && ACCENT_TO_PALETTE[was]) || DEFAULTS.palette;
    }
    const root = document.documentElement;

    if (current.theme === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', current.theme);
    root.setAttribute('data-palette', current.palette);
    // Floating mode is gone; a page left over from it keeps no trace.
    root.removeAttribute('data-chrome');
    // A colour of their own replaces p1 only, and brings its own ink with it.
    if (current.palette === 'custom' && HEX.test(current.accentHex || '')) {
      root.style.setProperty('--accent-pick', current.accentHex);
      root.style.setProperty('--accent-pick-ink', inkFor(current.accentHex).ink);
    } else {
      root.style.removeProperty('--accent-pick');
      root.style.removeProperty('--accent-pick-ink');
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
      const tiles = el('div.palettes');
      for (const pal of PALETTES) {
        const on = current.palette === pal.key;
        tiles.append(el('button.palette', {
          'aria-pressed': String(on), class: on ? 'is-on' : '',
          onclick: () => { set({ palette: pal.key }); draw(); },
        }, [
          // The strip is weighted 2:1:1:1 because p1 leads — it is the colour
          // a teacher sees most, on the timer.
          el('span.palette-strip', {}, pal.p.map((hex) => el('span', { style: { background: hex } }))),
          el('span.palette-name', { text: pal.label }),
          pal.note ? el('span.palette-note', { text: pal.note }) : null,
        ]));
      }
      // ...and one that is whatever the teacher wants. Their colour takes the
      // lead role; the other three keep the Primary hues, so a board stays
      // readable whatever they pick.
      const customOn = current.palette === 'custom';
      tiles.append(el('button.palette.palette--custom', {
        'aria-pressed': String(customOn), class: customOn ? 'is-on' : '',
        onclick: () => { set({ palette: 'custom' }); draw(); },
      }, [
        el('span.palette-strip', {}, [
          el('span', { style: { background: current.accentHex || DEFAULTS.accentHex } }),
          el('span', { style: { background: '#1f4fd1' } }),
          el('span', { style: { background: '#f5c400' } }),
          el('span', { style: { background: '#0e7f89' } }),
        ]),
        el('span.palette-name', { text: 'A colour of your own' }),
      ]));
      body.append(tiles);

      if (customOn) {
        const hexBox = el('input.input.accent-hex', {
          type: 'text', value: current.accentHex || DEFAULTS.accentHex, maxlength: 7,
          spellcheck: 'false', 'aria-label': 'Colour as a hex code',
          // Only on leaving the field: a half-typed "#1d4" is not a colour,
          // and repainting the whole desk on every keystroke is a strobe.
          onchange: (e) => {
            const v = e.target.value.trim();
            if (!HEX.test(v)) { e.target.value = current.accentHex; toast('A colour looks like #EC3013.', 'warn'); return; }
            set({ palette: 'custom', accentHex: v.toLowerCase() });
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
            oninput: (e) => { apply({ ...current, palette: 'custom', accentHex: e.target.value }); hexBox.value = e.target.value; },
            onchange: (e) => { set({ palette: 'custom', accentHex: e.target.value }); draw(); },
          }),
          hexBox,
        ]));
        // Said once, at the moment of choosing, rather than left for the
        // teacher to discover from the back of their own classroom.
        if (contrast(current.accentHex || DEFAULTS.accentHex) < 3) {
          body.append(el('p.hint', { text: 'This colour is hard to read on the board.' }));
        }
      }

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

  Desk.theme = { init, apply, get, set, open, PALETTES, ACCENT_TO_PALETTE, DEFAULTS, inkFor, contrast };
}(window.Desk));
