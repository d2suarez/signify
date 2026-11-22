// ===================================================================
// Widget — Colours
//
// A colour picker that hands back codes and suggests colours that go with
// it. Pick a colour (the system picker, a typed code, the eyedropper where
// the browser has one, or a random one), read it as HEX / RGB / HSL with a
// copy button each, see the matching colours for a chosen harmony, check
// whether white or black text reads on it, and keep a short row of saved
// colours.
//
// The swatches are CONTENT colours, the one exception DESIGN.md allows: they
// show the colour itself, whatever colour the card is. Everything else is
// painted with the desk's tokens.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon, toast } = Desk;

  const MAX_SAVED = 12;
  const HARMONIES = [
    { key: 'complementary', name: 'Complementary', note: 'Opposite on the colour wheel. Strong contrast.' },
    { key: 'analogous', name: 'Analogous', note: 'Neighbours on the wheel. Calm and close.' },
    { key: 'triadic', name: 'Triadic', note: 'Three evenly spaced. Bright and balanced.' },
    { key: 'split', name: 'Split complementary', note: 'The two either side of the opposite. Contrast that is easier on the eye.' },
    { key: 'square', name: 'Square', note: 'Four evenly spaced. Lots of variety.' },
    { key: 'shades', name: 'Shades', note: 'The same colour, lighter and darker.' },
  ];

  // ---------- colour maths (pure, tested) ----------

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  /** Reads #abc, #aabbcc, abc, aabbcc, rgb(1, 2, 3) or hsl(1, 2%, 3%). Gives #rrggbb or null. */
  function parse(input) {
    const t = String(input == null ? '' : input).trim().toLowerCase();
    let m = t.match(/^#?([0-9a-f]{3})$/);
    if (m) return '#' + m[1].split('').map((c) => c + c).join('');
    m = t.match(/^#?([0-9a-f]{6})$/);
    if (m) return '#' + m[1];
    m = t.match(/^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/);
    if (m) {
      const [r, g, b] = m.slice(1, 4).map(Number);
      if ([r, g, b].some((v) => v > 255)) return null;
      return toHex({ r, g, b });
    }
    m = t.match(/^hsla?\(\s*(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/);
    if (m) {
      const [h, s, l] = m.slice(1, 4).map(Number);
      if (s > 100 || l > 100) return null;
      return toHex(fromHsl({ h, s, l }));
    }
    return null;
  }

  function toRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function toHex({ r, g, b }) {
    return '#' + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
  }

  function toHsl(hex) {
    const { r, g, b } = toRgb(hex);
    const R = r / 255, G = g / 255, B = b / 255;
    const max = Math.max(R, G, B), min = Math.min(R, G, B);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === R) h = (G - B) / d + (G < B ? 6 : 0);
      else if (max === G) h = (B - R) / d + 2;
      else h = (R - G) / d + 4;
      h *= 60;
    }
    return { h: Math.round(h) % 360, s: Math.round(s * 100), l: Math.round(l * 100) };
  }

  function fromHsl({ h, s, l }) {
    const H = (((h % 360) + 360) % 360) / 360, S = clamp(s, 0, 100) / 100, L = clamp(l, 0, 100) / 100;
    if (S === 0) { const v = L * 255; return { r: v, g: v, b: v }; }
    const q = L < 0.5 ? L * (1 + S) : L + S - L * S;
    const p = 2 * L - q;
    const f = (t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return { r: f(H + 1 / 3) * 255, g: f(H) * 255, b: f(H - 1 / 3) * 255 };
  }

  /** The colours that go with `hex` under a harmony, the colour itself first. */
  function harmony(hex, kind) {
    const { h, s, l } = toHsl(hex);
    const turn = (deg) => toHex(fromHsl({ h: h + deg, s, l }));
    switch (kind) {
      case 'analogous': return [hex, turn(-30), turn(30)];
      case 'triadic': return [hex, turn(120), turn(240)];
      case 'split': return [hex, turn(150), turn(210)];
      case 'square': return [hex, turn(90), turn(180), turn(270)];
      case 'shades': {
        // Five steps from dark to light, with the colour itself in its place.
        const steps = [15, 30, 45, 60, 75, 90].filter((x) => Math.abs(x - l) > 7);
        return [...steps.map((x) => ({ x, hex: toHex(fromHsl({ h, s, l: x })) })), { x: l, hex }]
          .sort((a, b) => a.x - b.x).map((o) => o.hex);
      }
      default: return [hex, turn(180)];
    }
  }

  function luminance(hex) {
    const { r, g, b } = toRgb(hex);
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }

  /** WCAG contrast ratio between two colours, 1 to 21. */
  function contrast(a, b) {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  }

  /** The text colour that reads best on `hex`: white or near-black. */
  function textOn(hex) {
    return contrast(hex, '#ffffff') >= contrast(hex, '#201e1d') ? '#ffffff' : '#201e1d';
  }

  function formats(hex) {
    const { r, g, b } = toRgb(hex);
    const { h, s, l } = toHsl(hex);
    return [
      { key: 'hex', label: 'HEX', text: hex.toUpperCase() },
      { key: 'rgb', label: 'RGB', text: `rgb(${r}, ${g}, ${b})` },
      { key: 'hsl', label: 'HSL', text: `hsl(${h}, ${s}%, ${l}%)` },
    ];
  }

  function randomColour(rand = Math.random) {
    // Random hue, but saturation and lightness kept where colours look like
    // colours, not mud or near-white.
    return toHex(fromHsl({ h: Math.floor(rand() * 360), s: 55 + Math.floor(rand() * 35), l: 38 + Math.floor(rand() * 24) }));
  }

  // ---------- copying ----------

  /** Copies and says so. Same fallback as the emoji tool, for older school browsers. */
  async function copy(text) {
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
    toast(ok ? `Copied ${text}` : `Could not copy. The code is ${text}`);
    return ok;
  }

  // ---------- the widget ----------

  Desk.widget({
    type: 'colours',
    added: '2026-11-22',
    news: 'Pick a colour and get its HEX, RGB and HSL codes, plus colours that go with it.',
    name: 'Colours',
    blurb: 'Pick a colour, copy its HEX, RGB or HSL code, and find colours that go with it.',
    icon: 'palette',
    category: 'other',
    guest: true,                   // keeps only colours, calls no API
    students: false,               // new tools stay off for students until Desmond says otherwise
    tone: 'card',
    size: { w: 4, h: 10 },
    min: { w: 3, h: 5 },

    init(s) {
      s.hex = parse(s.hex) || '#1f4fd1';
      if (!HARMONIES.some((h) => h.key === s.harmony)) s.harmony = 'complementary';
      s.saved = (Array.isArray(s.saved) ? s.saved : []).map(parse).filter(Boolean).slice(0, MAX_SAVED);
    },

    readout(s) { return s.hex ? s.hex.toUpperCase() : ''; },

    mount(ctx) {
      const s = ctx.state;

      const set = (hex, { keepTyping = false } = {}) => {
        const h = parse(hex);
        if (!h) return false;
        s.hex = h;
        ctx.save();
        paint({ keepTyping });
        return true;
      };

      // The chosen colour: a big swatch you can click for the system picker.
      const native = el('input.cp-native', { type: 'color', value: s.hex, 'aria-label': 'Choose a colour', oninput: (e) => set(e.target.value) });
      const big = el('label.cp-big', { title: 'Click to choose a colour' }, [native, el('span.cp-big-hex')]);

      const field = el('input.input.cp-field', {
        type: 'text', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Colour code',
        placeholder: '#1F4FD1 or rgb(31, 79, 209)',
        oninput: (e) => { field.classList.toggle('is-bad', !set(e.target.value, { keepTyping: true }) && e.target.value.trim() !== ''); },
        onchange: () => { field.classList.remove('is-bad'); field.value = s.hex.toUpperCase(); },
      });

      const tools = el('div.cp-tools', {}, [
        'EyeDropper' in window ? el('button.btn.btn--small', {
          title: 'Pick a colour from anywhere on the screen',
          onclick: async () => {
            try { const r = await new window.EyeDropper().open(); set(r.sRGBHex); } catch { /* they pressed Escape */ }
          },
        }, 'Pick from screen') : null,
        el('button.btn.btn--small', { onclick: () => set(randomColour()) }, 'Random'),
        el('button.btn.btn--small', {
          onclick: () => {
            if (s.saved.includes(s.hex)) { toast('That colour is already saved'); return; }
            s.saved = [s.hex, ...s.saved].slice(0, MAX_SAVED);
            ctx.save();
            paint();
          },
        }, 'Save'),
      ]);

      const codes = el('div.cp-codes');

      const harmonySelect = el('select.select.select--small.cp-harmony', {
        'aria-label': 'Kind of match',
        onchange: (e) => { s.harmony = e.target.value; ctx.save(); paint(); },
      }, HARMONIES.map((h) => el('option', { value: h.key, text: h.name })));
      const harmonyNote = el('p.hint.cp-note');
      const matches = el('div.cp-matches');

      const read = el('div.cp-read');

      const savedRow = el('div.cp-saved');
      const savedHead = el('div.cp-head', {}, [
        el('span.cp-label', { text: 'Saved' }),
        el('button.btn.btn--small.btn--ghost', { onclick: () => s.saved.length && copy(s.saved.map((h) => h.toUpperCase()).join(', ')) }, 'Copy all'),
      ]);

      ctx.root.append(el('div.cp', {}, [
        el('div.cp-top', {}, [big, el('div.cp-side', {}, [field, tools])]),
        codes,
        el('div.cp-head', {}, [el('span.cp-label', { text: 'Goes with' }), harmonySelect]),
        harmonyNote,
        matches,
        el('div.cp-head', {}, [el('span.cp-label', { text: 'Text on this colour' })]),
        read,
        savedHead,
        savedRow,
      ]));

      function chip(hex, { main = false } = {}) {
        return el('div.cp-swatch', { class: main ? 'is-main' : '' }, [
          el('button.cp-chip', {
            style: { background: hex, color: textOn(hex) },
            title: `Copy ${hex.toUpperCase()}`,
            onclick: () => copy(hex.toUpperCase()),
          }, [el('span', { text: hex.toUpperCase() })]),
          main ? el('span.cp-chip-tag', { text: 'Main' }) : el('button.cp-use', { title: 'Make this the main colour', onclick: () => set(hex) }, 'Use'),
        ]);
      }

      function paint({ keepTyping = false } = {}) {
        const hex = s.hex;
        native.value = hex;
        big.style.background = hex;
        big.style.color = textOn(hex);
        big.querySelector('.cp-big-hex').textContent = hex.toUpperCase();
        if (!keepTyping) field.value = hex.toUpperCase();

        codes.replaceChildren(...formats(hex).map((f) => el('div.cp-code', {}, [
          el('span.cp-code-label', { text: f.label }),
          el('code.cp-code-text', { text: f.text }),
          el('button.icon-btn', { title: `Copy ${f.label}`, 'aria-label': `Copy ${f.label}`, svg: icon('copy', 16), onclick: () => copy(f.text) }),
        ])));

        harmonySelect.value = s.harmony;
        harmonyNote.textContent = (HARMONIES.find((h) => h.key === s.harmony) || HARMONIES[0]).note;
        matches.replaceChildren(...harmony(hex, s.harmony).map((h) => chip(h, { main: h === hex })));

        read.replaceChildren(...['#ffffff', '#201e1d'].map((ink) => {
          const r = contrast(hex, ink);
          const verdict = r >= 7 ? 'Easy to read' : r >= 4.5 ? 'Readable' : r >= 3 ? 'Big text only' : 'Hard to read';
          // A hard-to-read sample is the point of this row, so the colour audit skips it.
          return el('div.cp-sample', { style: { background: hex, color: ink }, class: r >= 4.5 ? 'is-good' : '', 'data-audit': 'skip' }, [
            el('span.cp-sample-text', { text: ink === '#ffffff' ? 'White text' : 'Black text' }),
            el('span.cp-sample-score', { text: `${r.toFixed(1)}:1 · ${verdict}` }),
          ]);
        }));

        savedRow.replaceChildren(...(s.saved.length ? s.saved.map((h) => el('div.cp-saved-item', {}, [
          el('button.cp-saved-chip', { style: { background: h }, title: `${h.toUpperCase()}: make it the main colour`, 'aria-label': `Use ${h.toUpperCase()}`, onclick: () => set(h) }),
          el('button.cp-saved-x', {
            title: 'Remove', 'aria-label': `Remove ${h.toUpperCase()}`,
            onclick: () => { s.saved = s.saved.filter((x) => x !== h); ctx.save(); paint(); },
          }, '×'),
        ])) : [el('p.hint', { text: 'Press Save to keep a colour here.' })]));
      }

      paint();
      return {};
    },

    // Exposed for the tests.
    _colour: { parse, toRgb, toHex, toHsl, fromHsl, harmony, contrast, textOn, formats, randomColour, HARMONIES },
  });

}(window.Desk));
