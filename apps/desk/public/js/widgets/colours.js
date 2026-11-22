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
  // The ways to choose a colour, shown as tabs above the swatch.
  const MODES = [
    { key: 'wheel', name: 'Wheel' },
    { key: 'sliders', name: 'Sliders' },
    { key: 'photo', name: 'Photo' },
  ];

  // A photo to pick from lives here, per card, for as long as the page is
  // open. It is never put in the board's state: it could be a pupil's photo,
  // and it would not fit anyway.
  const photos = new Map();

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


  // ---------- HSV, the wheel, and names (pure, tested) ----------

  /** Hue 0–360, saturation and value 0–100, unrounded so the wheel does not drift. */
  function toHsv(hex) {
    const { r, g, b } = toRgb(hex);
    const R = r / 255, G = g / 255, B = b / 255;
    const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
    let h = 0;
    if (d) {
      if (max === R) h = ((G - B) / d) % 6;
      else if (max === G) h = (B - R) / d + 2;
      else h = (R - G) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return { h, s: max ? (d / max) * 100 : 0, v: max * 100 };
  }

  function fromHsv({ h, s, v }) {
    const H = (((h % 360) + 360) % 360) / 60, S = clamp(s, 0, 100) / 100, V = clamp(v, 0, 100) / 100;
    const c = V * S, x = c * (1 - Math.abs((H % 2) - 1)), m = V - c;
    const [r, g, b] = H < 1 ? [c, x, 0] : H < 2 ? [x, c, 0] : H < 3 ? [0, c, x] : H < 4 ? [0, x, c] : H < 5 ? [x, 0, c] : [c, 0, x];
    return toHex({ r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 });
  }

  /* The wheel: red at the top, hues running clockwise, grey in the middle and
     full colour at the rim. Positions are in a unit circle, -1 to 1. */
  function wheelPoint(h, s) {
    const a = (h * Math.PI) / 180, r = clamp(s, 0, 100) / 100;
    return { x: Math.sin(a) * r, y: -Math.cos(a) * r };
  }

  function wheelAt(x, y) {
    let h = (Math.atan2(x, -y) * 180) / Math.PI;
    if (h < 0) h += 360;
    return { h, s: Math.min(1, Math.hypot(x, y)) * 100 };
  }

  // CSS's named colours (one of each pair of duplicates), so a colour can be
  // called something a person would say.
  const NAMES = ('alice blue f0f8ff,antique white faebd7,aqua 00ffff,aquamarine 7fffd4,azure f0ffff,beige f5f5dc,bisque ffe4c4,black 000000,' +
    'blanched almond ffebcd,blue 0000ff,blue violet 8a2be2,brown a52a2a,burlywood deb887,cadet blue 5f9ea0,chartreuse 7fff00,chocolate d2691e,' +
    'coral ff7f50,cornflower blue 6495ed,cornsilk fff8dc,crimson dc143c,dark blue 00008b,dark cyan 008b8b,dark goldenrod b8860b,dark grey a9a9a9,' +
    'dark green 006400,dark khaki bdb76b,dark magenta 8b008b,dark olive green 556b2f,dark orange ff8c00,dark orchid 9932cc,dark red 8b0000,' +
    'dark salmon e9967a,dark sea green 8fbc8f,dark slate blue 483d8b,dark slate grey 2f4f4f,dark turquoise 00ced1,dark violet 9400d3,deep pink ff1493,' +
    'deep sky blue 00bfff,dim grey 696969,dodger blue 1e90ff,firebrick b22222,floral white fffaf0,forest green 228b22,gainsboro dcdcdc,ghost white f8f8ff,' +
    'gold ffd700,goldenrod daa520,grey 808080,green 008000,green yellow adff2f,honeydew f0fff0,hot pink ff69b4,indian red cd5c5c,indigo 4b0082,' +
    'ivory fffff0,khaki f0e68c,lavender e6e6fa,lavender blush fff0f5,lawn green 7cfc00,lemon chiffon fffacd,light blue add8e6,light coral f08080,' +
    'light cyan e0ffff,light goldenrod yellow fafad2,light grey d3d3d3,light green 90ee90,light pink ffb6c1,light salmon ffa07a,light sea green 20b2aa,' +
    'light sky blue 87cefa,light slate grey 778899,light steel blue b0c4de,light yellow ffffe0,lime 00ff00,lime green 32cd32,linen faf0e6,magenta ff00ff,' +
    'maroon 800000,medium aquamarine 66cdaa,medium blue 0000cd,medium orchid ba55d3,medium purple 9370db,medium sea green 3cb371,medium slate blue 7b68ee,' +
    'medium spring green 00fa9a,medium turquoise 48d1cc,medium violet red c71585,midnight blue 191970,mint cream f5fffa,misty rose ffe4e1,moccasin ffe4b5,' +
    'navajo white ffdead,navy 000080,old lace fdf5e6,olive 808000,olive drab 6b8e23,orange ffa500,orange red ff4500,orchid da70d6,pale goldenrod eee8aa,' +
    'pale green 98fb98,pale turquoise afeeee,pale violet red db7093,papaya whip ffefd5,peach puff ffdab9,peru cd853f,pink ffc0cb,plum dda0dd,' +
    'powder blue b0e0e6,purple 800080,rebecca purple 663399,red ff0000,rosy brown bc8f8f,royal blue 4169e1,saddle brown 8b4513,salmon fa8072,' +
    'sandy brown f4a460,sea green 2e8b57,seashell fff5ee,sienna a0522d,silver c0c0c0,sky blue 87ceeb,slate blue 6a5acd,slate grey 708090,snow fffafa,' +
    'spring green 00ff7f,steel blue 4682b4,tan d2b48c,teal 008080,thistle d8bfd8,tomato ff6347,turquoise 40e0d0,violet ee82ee,wheat f5deb3,white ffffff,' +
    'white smoke f5f5f5,yellow ffff00,yellow green 9acd32')
    .split(',').map((pair) => { const i = pair.lastIndexOf(' '); return { name: pair.slice(0, i), hex: '#' + pair.slice(i + 1) }; });

  /** CIE Lab, so "closest" means closest to the eye rather than in RGB numbers. */
  function toLab(hex) {
    const { r, g, b } = toRgb(hex);
    const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const R = lin(r), G = lin(g), B = lin(b);
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const X = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047);
    const Y = f(R * 0.2126 + G * 0.7152 + B * 0.0722);
    const Z = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
    return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
  }

  /** The nearest named colour, and whether it is close enough to say "is" rather than "is close to". */
  function nearestName(hex) {
    const a = toLab(hex);
    let best = null;
    for (const n of NAMES) {
      const b = n.lab || (n.lab = toLab(n.hex));
      const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      if (!best || d < best.d) best = { name: n.name, hex: n.hex, d };
    }
    return { name: best.name, hex: best.hex, exact: best.d < 2.5 };
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
    news: 'Pick a colour from a wheel, sliders or a photo, copy its HEX, RGB or HSL code, and see the colours that go with it.',
    name: 'Colours',
    blurb: 'A colour wheel, sliders and a photo picker. Copy HEX, RGB or HSL codes and find colours that go together.',
    icon: 'palette',
    category: 'other',
    guest: true,                   // keeps only colours, calls no API
    students: true,                // turned on for students at Desmond's request, 2026-11-22
    tone: 'card',
    size: { w: 4, h: 15 },
    min: { w: 3, h: 5 },

    init(s) {
      s.hex = parse(s.hex) || '#1f4fd1';
      if (!HARMONIES.some((h) => h.key === s.harmony)) s.harmony = 'complementary';
      if (!MODES.some((m) => m.key === s.mode)) s.mode = 'wheel';
      if (s.sliders !== 'hsl') s.sliders = 'rgb';
      s.saved = (Array.isArray(s.saved) ? s.saved : []).map(parse).filter(Boolean).slice(0, MAX_SAVED);
    },

    readout(s) { return s.hex ? s.hex.toUpperCase() : ''; },

    mount(ctx) {
      const s = ctx.state;
      const key = ctx.item && ctx.item.id;

      // The wheel and the HSL sliders keep their own unrounded numbers while
      // they are being dragged. Going through a HEX code on every move would
      // round them, and a grey has no hue at all: the knob would jump about.
      let hsv = toHsv(s.hex);
      let hsl = toHsl(s.hex);

      /** `from` names the control that made the change, so it is not repainted under the pointer. */
      const set = (hex, { keepTyping = false, from = '' } = {}) => {
        const h = parse(hex);
        if (!h) return false;
        s.hex = h;
        if (from !== 'wheel') {
          const next = toHsv(h);
          // A grey or black has no hue of its own; keep the one the wheel had.
          hsv = next.s < 0.5 || next.v < 0.5 ? { ...next, h: hsv.h } : next;
        }
        if (from !== 'hsl') { const next = toHsl(h); hsl = next.s === 0 ? { ...next, h: hsl.h } : next; }
        ctx.save();
        paint({ keepTyping, from });
        return true;
      };

      // ---- how to choose: tabs ----
      const tabs = el('div.seg.cp-modes', { role: 'tablist', 'aria-label': 'How to choose a colour' }, MODES.map((m) => el('button.seg-btn', {
        type: 'button', role: 'tab', 'data-mode': m.key,
        onclick: () => { s.mode = m.key; ctx.save(); paint(); },
      }, m.name)));

      // ---- the wheel ----
      const wheelCanvas = el('canvas.cp-wheel-canvas', { width: 512, height: 512, 'aria-hidden': 'true' });
      const wheelShade = el('div.cp-wheel-shade');
      const wheelLines = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      wheelLines.setAttribute('viewBox', '-1 -1 2 2');
      wheelLines.setAttribute('class', 'cp-wheel-lines');
      wheelLines.setAttribute('aria-hidden', 'true');
      const wheelDots = el('div.cp-wheel-dots');
      const wheel = el('div.cp-wheel', {
        tabindex: '0', role: 'application',
        'aria-label': 'Colour wheel. Drag to choose. Arrow keys: left and right change the colour, up and down how strong it is.',
      }, [wheelCanvas, wheelShade, wheelLines, wheelDots]);
      const brightness = el('input.cp-range', {
        type: 'range', min: 0, max: 100, step: 1, 'aria-label': 'Brightness',
        oninput: (e) => { hsv = { ...hsv, v: Number(e.target.value) }; set(fromHsv(hsv), { from: 'wheel' }); },
      });
      const wheelPanel = el('div.cp-panel', { 'data-panel': 'wheel' }, [
        wheel,
        el('label.cp-slider-row', {}, [el('span.cp-slider-name', { text: 'Brightness' }), brightness]),
      ]);

      (function drawWheel() {
        // Drawn once at full brightness; the brightness slider darkens it with
        // a black layer on top, which is exactly what lowering HSV value does.
        const g = wheelCanvas.getContext('2d');
        const n = wheelCanvas.width, half = n / 2;
        const img = g.createImageData(n, n);
        for (let y = 0; y < n; y++) {
          for (let x = 0; x < n; x++) {
            const dx = (x + 0.5 - half) / half, dy = (y + 0.5 - half) / half;
            if (Math.hypot(dx, dy) > 1) continue;
            const { h, s: sat } = wheelAt(dx, dy);
            const { r, g: gg, b } = toRgb(fromHsv({ h, s: sat, v: 100 }));
            const i = (y * n + x) * 4;
            img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = 255;
          }
        }
        g.putImageData(img, 0, 0);
      }());

      const pickOnWheel = (e) => {
        const r = wheel.getBoundingClientRect();
        const x = ((e.clientX - r.left) / r.width) * 2 - 1, y = ((e.clientY - r.top) / r.height) * 2 - 1;
        const at = wheelAt(x, y);
        // Picking a hue from a black colour would pick black again; lift it.
        hsv = { h: at.h, s: at.s, v: hsv.v < 15 ? 100 : hsv.v };
        set(fromHsv(hsv), { from: 'wheel' });
      };
      wheel.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        try { wheel.setPointerCapture(e.pointerId); } catch { /* a pointer the browser no longer tracks */ }
        wheel.focus({ preventScroll: true });
        pickOnWheel(e);
        const move = (ev) => pickOnWheel(ev);
        const up = () => { wheel.removeEventListener('pointermove', move); wheel.removeEventListener('pointerup', up); wheel.removeEventListener('pointercancel', up); };
        wheel.addEventListener('pointermove', move);
        wheel.addEventListener('pointerup', up);
        wheel.addEventListener('pointercancel', up);
      });
      wheel.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 15 : 5;
        const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
        if (!moves[e.key]) return;
        e.preventDefault();
        hsv = { h: (hsv.h + moves[e.key][0] + 360) % 360, s: clamp(hsv.s + moves[e.key][1], 0, 100), v: hsv.v };
        set(fromHsv(hsv), { from: 'wheel' });
      });

      // ---- sliders ----
      const sliderKind = el('div.seg.cp-slider-kind', { role: 'group', 'aria-label': 'Which sliders' }, ['rgb', 'hsl'].map((k) => el('button.seg-btn', {
        type: 'button', 'data-kind': k, onclick: () => { s.sliders = k; ctx.save(); paint(); },
      }, k.toUpperCase())));
      const sliderRows = el('div.cp-sliders');
      const SLIDERS = {
        rgb: [{ k: 'r', name: 'Red', max: 255 }, { k: 'g', name: 'Green', max: 255 }, { k: 'b', name: 'Blue', max: 255 }],
        hsl: [{ k: 'h', name: 'Hue', max: 359 }, { k: 's', name: 'Saturation', max: 100 }, { k: 'l', name: 'Lightness', max: 100 }],
      };
      const sliderInputs = {};
      function buildSliders() {
        const kind = s.sliders;
        sliderRows.replaceChildren(...SLIDERS[kind].map((d) => {
          const apply = (v) => {
            const n = clamp(Math.round(Number(v) || 0), 0, d.max);
            if (kind === 'rgb') set(toHex({ ...toRgb(s.hex), [d.k]: n }), { from: 'rgb' });
            else { hsl = { ...hsl, [d.k]: n }; set(toHex(fromHsl(hsl)), { from: 'hsl' }); }
          };
          const range = el('input.cp-range', { type: 'range', min: 0, max: d.max, step: 1, 'aria-label': d.name, oninput: (e) => { num.value = e.target.value; apply(e.target.value); } });
          const num = el('input.input.cp-num', { type: 'number', min: 0, max: d.max, step: 1, 'aria-label': `${d.name} number`, oninput: (e) => { if (e.target.value !== '') { range.value = e.target.value; apply(e.target.value); } } });
          sliderInputs[d.k] = { range, num };
          return el('div.cp-slider-row', {}, [el('span.cp-slider-name', { text: d.name }), range, num]);
        }));
        sliderRows.dataset.kind = kind;
      }
      const sliderPanel = el('div.cp-panel', { 'data-panel': 'sliders' }, [sliderKind, sliderRows]);

      // ---- a photo ----
      const photoCanvas = el('canvas.cp-photo-canvas', { 'aria-label': 'Your photo. Click or drag on it to pick a colour.' });
      const photoMark = el('div.cp-photo-mark', { hidden: true });
      const photoFile = el('input', { type: 'file', accept: 'image/*', hidden: true, onchange: (e) => { const f = e.target.files && e.target.files[0]; if (f) loadPhoto(f); e.target.value = ''; } });
      const photoEmpty = el('div.cp-photo-empty', {}, [
        el('button.btn.btn--small', { type: 'button', onclick: () => photoFile.click() }, 'Choose a photo'),
        el('p.hint', { text: 'Or drop one here. Then click on it to pick any colour in it. The photo stays on this screen and is not saved.' }),
      ]);
      const photoStage = el('div.cp-photo-stage', { hidden: true }, [photoCanvas, photoMark]);
      const photoAgain = el('button.btn.btn--small.btn--ghost', { type: 'button', hidden: true, onclick: () => photoFile.click() }, 'Another photo');
      const photoPanel = el('div.cp-panel.cp-photo', { 'data-panel': 'photo' }, [photoEmpty, photoStage, photoAgain, photoFile]);

      function showPhoto(img) {
        // Kept at a sensible size: enough to pick from, small enough to read pixels quickly.
        const scale = Math.min(1, 900 / Math.max(img.naturalWidth, img.naturalHeight));
        photoCanvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        photoCanvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        photoCanvas.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0, photoCanvas.width, photoCanvas.height);
        photoEmpty.hidden = true; photoStage.hidden = false; photoAgain.hidden = false; photoMark.hidden = true;
      }
      function loadPhoto(file) {
        if (!/^image\//.test(file.type)) { toast('That is not a picture this browser can open'); return; }
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); photos.set(key, img); showPhoto(img); };
        img.onerror = () => { URL.revokeObjectURL(url); toast('That picture would not open. Try a JPG or PNG.'); };
        img.src = url;
      }
      const pickOnPhoto = (e) => {
        const r = photoCanvas.getBoundingClientRect();
        const fx = clamp((e.clientX - r.left) / r.width, 0, 0.9999), fy = clamp((e.clientY - r.top) / r.height, 0, 0.9999);
        const [R, G, B] = photoCanvas.getContext('2d', { willReadFrequently: true })
          .getImageData(Math.floor(fx * photoCanvas.width), Math.floor(fy * photoCanvas.height), 1, 1).data;
        photoMark.hidden = false;
        photoMark.style.left = `${fx * 100}%`;
        photoMark.style.top = `${fy * 100}%`;
        set(toHex({ r: R, g: G, b: B }), { from: 'photo' });
      };
      photoCanvas.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        try { photoCanvas.setPointerCapture(e.pointerId); } catch { /* a pointer the browser no longer tracks */ }
        pickOnPhoto(e);
        const move = (ev) => pickOnPhoto(ev);
        const up = () => { photoCanvas.removeEventListener('pointermove', move); photoCanvas.removeEventListener('pointerup', up); photoCanvas.removeEventListener('pointercancel', up); };
        photoCanvas.addEventListener('pointermove', move);
        photoCanvas.addEventListener('pointerup', up);
        photoCanvas.addEventListener('pointercancel', up);
      });
      photoPanel.addEventListener('dragover', (e) => { e.preventDefault(); photoPanel.classList.add('is-drop'); });
      photoPanel.addEventListener('dragleave', () => photoPanel.classList.remove('is-drop'));
      photoPanel.addEventListener('drop', (e) => {
        e.preventDefault();
        photoPanel.classList.remove('is-drop');
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) loadPhoto(f);
      });
      if (photos.has(key)) { const img = photos.get(key); if (img.complete) showPhoto(img); }

      // ---- the chosen colour ----
      // A big swatch you can click for the system picker.
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

      const nameLine = el('p.cp-name');
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
        tabs,
        wheelPanel, sliderPanel, photoPanel,
        el('div.cp-top', {}, [big, el('div.cp-side', {}, [field, nameLine, tools])]),
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

      function paintWheel(list) {
        const pct = (v) => `${((v + 1) / 2) * 100}%`;
        wheelShade.style.opacity = String(1 - hsv.v / 100);
        const pts = list.map((h, i) => {
          // The main colour sits where the wheel says it is; the matches where their own hue and strength put them.
          const c = i === 0 ? hsv : toHsv(h);
          return { hex: h, main: i === 0, ...wheelPoint(c.h, c.s) };
        });
        wheelDots.replaceChildren(...pts.map((p) => el('span.cp-wheel-dot', {
          class: p.main ? 'is-main' : '', style: { left: pct(p.x), top: pct(p.y), background: p.hex },
        })));
        // Lines from the middle to each colour, and round them: the shape of the harmony.
        const ring = pts.length > 2 ? `<polygon points="${pts.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(' ')}"/>` : '';
        wheelLines.innerHTML = pts.map((p) => `<line x1="0" y1="0" x2="${p.x.toFixed(3)}" y2="${p.y.toFixed(3)}"/>`).join('') + ring;
        brightness.value = String(Math.round(hsv.v));
        brightness.style.setProperty('--track', `linear-gradient(to right, #000, ${fromHsv({ h: hsv.h, s: hsv.s, v: 100 })})`);
      }

      function paintSliders(from) {
        if (sliderRows.dataset.kind !== s.sliders) buildSliders();
        const kind = s.sliders;
        const { r, g, b } = toRgb(s.hex);
        const vals = kind === 'rgb' ? { r, g, b } : { h: Math.round(hsl.h), s: Math.round(hsl.s), l: Math.round(hsl.l) };
        const tracks = kind === 'rgb' ? {
          r: `linear-gradient(to right, rgb(0,${g},${b}), rgb(255,${g},${b}))`,
          g: `linear-gradient(to right, rgb(${r},0,${b}), rgb(${r},255,${b}))`,
          b: `linear-gradient(to right, rgb(${r},${g},0), rgb(${r},${g},255))`,
        } : {
          h: `linear-gradient(to right, ${[0, 60, 120, 180, 240, 300, 360].map((d) => `hsl(${d}, ${hsl.s}%, ${hsl.l}%)`).join(', ')})`,
          s: `linear-gradient(to right, hsl(${hsl.h}, 0%, ${hsl.l}%), hsl(${hsl.h}, 100%, ${hsl.l}%))`,
          l: `linear-gradient(to right, #000, hsl(${hsl.h}, ${hsl.s}%, 50%), #fff)`,
        };
        for (const [k, v] of Object.entries(vals)) {
          const pair = sliderInputs[k];
          if (!pair) continue;
          pair.range.style.setProperty('--track', tracks[k]);
          // Leave alone the number someone is typing in.
          if (document.activeElement !== pair.num || from !== kind) pair.num.value = String(v);
          if (from !== kind || document.activeElement !== pair.range) pair.range.value = String(v);
        }
        for (const b2 of sliderKind.children) b2.classList.toggle('is-on', b2.dataset.kind === kind);
      }

      function paint({ keepTyping = false, from = '' } = {}) {
        const hex = s.hex;
        for (const t of tabs.children) { const on = t.dataset.mode === s.mode; t.classList.toggle('is-on', on); t.setAttribute('aria-selected', String(on)); }
        for (const panel of [wheelPanel, sliderPanel, photoPanel]) panel.hidden = panel.dataset.panel !== s.mode;

        native.value = hex;
        big.style.background = hex;
        big.style.color = textOn(hex);
        big.querySelector('.cp-big-hex').textContent = hex.toUpperCase();
        if (!keepTyping) field.value = hex.toUpperCase();

        const named = nearestName(hex);
        const cap = named.name.charAt(0).toUpperCase() + named.name.slice(1);
        nameLine.replaceChildren(
          el('span.cp-name-dot', { style: { background: named.hex }, 'aria-hidden': 'true' }),
          el('span', { text: named.exact ? cap : `Close to ${named.name}` }),
        );
        nameLine.title = `${cap} is ${named.hex.toUpperCase()}`;

        codes.replaceChildren(...formats(hex).map((f) => el('div.cp-code', {}, [
          el('span.cp-code-label', { text: f.label }),
          el('code.cp-code-text', { text: f.text }),
          el('button.icon-btn', { title: `Copy ${f.label}`, 'aria-label': `Copy ${f.label}`, svg: icon('copy', 16), onclick: () => copy(f.text) }),
        ])));

        harmonySelect.value = s.harmony;
        harmonyNote.textContent = (HARMONIES.find((h) => h.key === s.harmony) || HARMONIES[0]).note;
        const list = harmony(hex, s.harmony);
        matches.replaceChildren(...list.map((h) => chip(h, { main: h === hex })));

        if (s.mode === 'wheel') paintWheel(s.harmony === 'shades' ? [hex] : list);
        if (s.mode === 'sliders') paintSliders(from);

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
    _colour: { parse, toRgb, toHex, toHsl, fromHsl, toHsv, fromHsv, wheelPoint, wheelAt, nearestName, harmony, contrast, textOn, formats, randomColour, HARMONIES, NAMES },
  });

}(window.Desk));
