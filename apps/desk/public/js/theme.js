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

  const DEFAULTS = { theme: 'auto', accent: 'blue', background: '', backgroundFit: 'cover', backgroundDim: 40 };

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
      body.append(swatches);

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
