// ===================================================================
// Widget — QR code
//
// Puts a link on the board for thirty devices to point at. Faster and far
// more accurate than reading a URL out loud, which is the alternative.
//
// Drawn as an SVG rather than a canvas, so it stays crisp when the card is
// opened onto a projector — a blurry QR is one nobody's phone will read.
//
// The encoder is vendored from Kazuhiko Arase's reference implementation;
// see public/vendor/QRCODE-LICENCE.txt.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon, toast } = Desk;

  // Level M — roughly 15% of the code can be damaged and still read. It is
  // what most generators default to, and it is the right trade for a code on
  // a whiteboard: enough robustness for a dim projector or a hand across the
  // corner, without the density that makes a long link hard to scan from the
  // back of the room. Not worth putting in front of a teacher as a choice.
  const LEVEL = 'M';

  /** The encoded code itself, or null if it will not fit. */
  function encode(text) {
    if (!window.qrcode) return null;
    let qr;
    try {
      // Version 0 lets the library pick the smallest that fits.
      qr = window.qrcode(0, LEVEL);
      qr.addData(text);
      qr.make();
    } catch { return null; }
    return qr;
  }

  /**
   * The code as SVG, for the screen. One <path> of squares rather than a rect
   * per module: a version-10 code is 3,600 modules, and 3,600 elements makes
   * the board crawl every time it redraws.
   */
  function render(text) {
    const qr = encode(text);
    if (!qr) return null;

    const n = qr.getModuleCount();
    const quiet = 4;                       // the margin the spec requires
    const size = n + quiet * 2;
    let d = '';
    for (let row = 0; row < n; row += 1) {
      for (let col = 0; col < n; col += 1) {
        if (qr.isDark(row, col)) d += `M${col + quiet} ${row + quiet}h1v1h-1z`;
      }
    }
    return `<svg viewBox="0 0 ${size} ${size}" class="qr-svg" shape-rendering="crispEdges" role="img" aria-label="QR code">
      <rect width="${size}" height="${size}" fill="var(--qr-bg, #fff)"/>
      <path d="${d}" fill="var(--qr-ink, #000)"/>
    </svg>`;
  }

  Desk.widget({
    type: 'qr',
    name: 'QR code',
    blurb: 'Put a link on the board for thirty devices to point at, instead of reading a URL out loud.',
    icon: 'qr',
    size: { w: 3, h: 4 },
    min: { w: 2, h: 3 },

    init(s) {
      if (typeof s.text !== 'string') s.text = '';
      if (typeof s.label !== 'string') s.label = '';
      delete s.level;                       // used to be a picker; now fixed
    },

    holdsContent: (s) => (s.text.trim() ? 'The link goes with it.' : ''),

    mount(ctx) {
      const s = ctx.state;
      const face = el('div.qr-face');
      const caption = el('div.qr-caption');
      const controls = el('div.qr-controls');

      ctx.root.append(el('div.qr', {}, [face, caption, controls]));

      function paint() {
        Desk.clear(face);
        const text = s.text.trim();

        if (!text) {
          face.append(el('p.hint', { text: 'Paste a link, and it becomes a code they can point a camera at.' }));
          caption.textContent = '';
          return;
        }

        const svg = render(text);
        if (!svg) {
          face.append(el('p.hint', { text: 'That is too long to fit in a QR code. Try a shorter link.' }));
          caption.textContent = '';
          return;
        }
        face.append(el('div.qr-holder', { svg }));
        caption.textContent = s.label || text;
      }

      function drawControls() {
        Desk.clear(controls);

        controls.append(el('input.input', {
          type: 'text', value: s.text, maxlength: 900,
          placeholder: 'https://…  or any text',
          oninput: (e) => { s.text = e.target.value; ctx.save(); paint(); },
        }));

        if (!ctx.expanded) return;

        controls.append(
          el('label.field', {}, [
            el('span.field-label', { text: 'What to call it' }),
            el('input.input', {
              type: 'text', value: s.label, maxlength: 60, placeholder: 'e.g. Today’s quiz',
              oninput: (e) => { s.label = e.target.value; ctx.save(); paint(); },
            }),
          ]),
          el('div.starter-row', {}, [
            el('button.btn.btn--small.btn--primary', { svg: icon('download', 14), onclick: download }, ' Download PNG'),
            el('button.btn.btn--small', {
              svg: icon('copy', 14),
              onclick: async () => {
                try { await navigator.clipboard.writeText(s.text); toast('Link copied.'); }
                catch { toast('Could not reach the clipboard.', 'warn'); }
              },
            }, ' Copy the link'),
            el('button.btn.btn--small', {
              svg: icon('expand', 14),
              onclick: () => { if (s.text.trim()) window.open(s.text, '_blank', 'noopener,noreferrer'); },
            }, ' Open it'),
          ]),
        );
      }

      /**
       * Saves the code as a PNG.
       *
       * Drawn straight onto a canvas from the modules rather than rasterising
       * the SVG: an SVG that uses CSS variables for its colours does not carry
       * them into an <img>, so that route produces a blank square. Black on
       * white and a generous 16px per module, so it survives being pasted into
       * a worksheet and printed.
       */
      async function download() {
        const text = s.text.trim();
        if (!text) { toast('Nothing to save yet.', 'warn'); return; }

        const qr = encode(text);
        if (!qr) { toast('That is too long to fit in a QR code.', 'warn'); return; }

        const n = qr.getModuleCount();
        const quiet = 4;
        const scale = 16;
        const side = (n + quiet * 2) * scale;

        const canvas = document.createElement('canvas');
        canvas.width = side;
        canvas.height = side;
        const g = canvas.getContext('2d');
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, side, side);
        g.fillStyle = '#000000';
        for (let row = 0; row < n; row += 1) {
          for (let col = 0; col < n; col += 1) {
            if (qr.isDark(row, col)) {
              g.fillRect((col + quiet) * scale, (row + quiet) * scale, scale, scale);
            }
          }
        }

        const name = `${(s.label || 'qr-code').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'qr-code'}.png`;
        const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
        if (!blob) { toast('Could not make the picture.', 'warn'); return; }

        const href = URL.createObjectURL(blob);
        const a = el('a', { href, download: name });
        document.body.append(a);
        a.click();
        a.remove();
        // Freed on the next tick; revoking immediately can beat the download.
        setTimeout(() => URL.revokeObjectURL(href), 10_000);
        toast(`Saved as ${name}`);
      }

      paint();
      drawControls();
      return {};
    },
  });
}(window.Desk));
