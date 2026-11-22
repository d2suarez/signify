/*
 * Colour audit for the desk — run it in a browser on a local dev desk
 * (npm run dev, then paste this into the console, or hand it to the
 * browser pane's javascript tool). It is NOT part of npm test: it needs a
 * real layout engine to know what colour things actually come out.
 *
 * For every tool, in its usual colour and in each of the four theme colours,
 * it looks for the three ways a recoloured tool goes wrong (DESIGN.md):
 *   contrast  – text that is hard to read on whatever is behind it (< 3:1)
 *   vanishes  – a tile painted the same colour as the card it sits on
 *   white     – a plain white patch on a coloured card's tinted sheet
 * and resolves to { checked, problems: [{ type, colour, check, what, detail }] }.
 * Every tool it adds is removed again afterwards. Pass { state: { classKey } }
 * to start every tool on a class list, so the class tools draw their names,
 * tiles and seats instead of an empty "choose a class" screen.
 */
(async function colourAudit({ types, settle = 350, state = {} } = {}) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // Computed colours come back in any syntax (rgb, color(srgb …), oklch …),
  // so let the browser turn each one into plain RGBA by painting a pixel.
  const px = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const memo = new Map();
  const rgb = (s) => {
    const t = String(s);
    if (memo.has(t)) return memo.get(t);
    px.clearRect(0, 0, 1, 1); px.fillStyle = '#000'; px.fillStyle = t; px.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = px.getImageData(0, 0, 1, 1).data;
    const out = [r, g, b, a / 255];
    memo.set(t, out);
    return out;
  };
  const opaque = (c) => c && (c.length < 4 || c[3] > 0.6);
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const near = (a, b) => a && b && Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 18;
  const name = (e) => e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
  const behind = (e, stop) => {
    for (let n = e; n && n !== stop.parentElement; n = n.parentElement) {
      const c = rgb(getComputedStyle(n).backgroundColor);
      if (opaque(c)) return c;
    }
    return rgb(getComputedStyle(stop).backgroundColor);
  };
  const visible = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.3; };

  function check(card, colour, type, out) {
    const cardBg = rgb(getComputedStyle(card).backgroundColor);
    const block = card.dataset.tone === 'block';
    // Only a working tool gets the tinted sheet; white buttons on a block are meant.
    const picked = card.hasAttribute('data-picked') && card.dataset.tone === 'card';
    const body = card.querySelector('.card-body');
    for (const e of card.querySelectorAll('*')) {
      if (!visible(e) || e.closest('svg, canvas, img, video, iframe, .bib-read[data-theme], .note-paper')) continue;
      const s = getComputedStyle(e);
      const own = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (own) {
        const fg = rgb(s.color), bg = behind(e, card);
        if (fg && bg && (fg.length < 4 || fg[3] > 0.5)) {
          const r = ratio(fg, bg);
          if (r < 3) out.push({ type, colour, check: 'contrast', what: name(e), detail: `${r.toFixed(2)}:1 "${e.textContent.trim().slice(0, 30)}" ${s.color} on ${bg.map(Math.round).join(',')}` });
        }
      }
      const area = e.getBoundingClientRect().width * e.getBoundingClientRect().height;
      const bg = rgb(s.backgroundColor);
      if (block && opaque(bg) && near(bg, cardBg) && area > 1200 && e !== body && !e.closest('.card-head') && s.borderTopStyle === 'none')
        out.push({ type, colour, check: 'vanishes', what: name(e), detail: 'same colour as the card' });
      if (picked && body.contains(e) && opaque(bg) && bg[0] > 253 && bg[1] > 253 && bg[2] > 253 && area > 2500)
        out.push({ type, colour, check: 'white', what: name(e), detail: 'plain white on a coloured card' });
    }
  }

  // Colours fade in over 120–200ms; measure the end state, not the fade.
  const still = document.createElement('style');
  still.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }';
  document.head.append(still);

  const list = (types || Desk.widgets.all().map((d) => d.type)).filter((t) => Desk.widgets.get(t));
  const problems = [];
  let checked = 0;
  for (const type of list) {
    if (!Desk.board.adopt([{ type, state: { ...state } }])) continue;
    const item = Desk.board.items()[Desk.board.items().length - 1];
    document.querySelector(`.card[data-id="${CSS.escape(item.id)}"]`)?.scrollIntoView({ block: 'center' });
    await wait(settle * 2);
    for (const colour of ['', 'p1', 'p2', 'p3', 'p4']) {
      Desk.board.setColour(item.id, colour);
      await wait(settle);
      const card = document.querySelector(`.card[data-id="${CSS.escape(item.id)}"]`);
      if (card) { check(card, colour || 'usual', type, problems); checked++; }
    }
    await Desk.board.removeItem(item.id, true);
    await wait(100);
  }
  still.remove();
  // One line per problem kind per tool, so a widget broken in all four colours reads as one fault.
  const seen = new Set();
  return { checked, problems: problems.filter((p) => { const k = p.type + p.check + p.what + p.colour; if (seen.has(k)) return false; seen.add(k); return true; }) };
})
