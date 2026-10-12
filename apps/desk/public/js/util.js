// ===================================================================
// Teacher's Desk — small shared helpers
// No framework: a classroom tool board is a handful of widgets and a grid,
// and a build step would be the largest thing in the repository.
// ===================================================================

window.Desk = window.Desk || {};

(function (Desk) {
  'use strict';

  /**
   * el('div.card', { onclick }, [ ...children ])
   * Children may be nodes, strings (added as text, never as markup) or null.
   */
  function el(spec, props, children) {
    const [tagAndId, ...classes] = String(spec).split('.');
    const [tag, id] = tagAndId.split('#');
    const node = document.createElement(tag || 'div');
    if (id) node.id = id;
    if (classes.length) node.className = classes.join(' ');

    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = [node.className, v].filter(Boolean).join(' ');
      else if (k === 'text') node.textContent = v;
      else if (k === 'svg') node.innerHTML = v;            // only ever our own icon markup
      else if (k === 'style' && typeof v === 'object') setStyle(node, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'value') node.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'hidden') node[k] = !!v;
      else node.setAttribute(k, v);
    }

    for (const child of [].concat(children || [])) {
      if (child == null || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  /**
   * Object.assign onto a style object silently drops custom properties —
   * `style['--x'] = 3` does nothing whatsoever — so they have to go through
   * setProperty. Worth knowing: it fails without an error, and the element
   * simply draws in the wrong place.
   */
  function setStyle(node, styles) {
    for (const [k, v] of Object.entries(styles)) {
      if (v == null) continue;
      if (k.startsWith('--')) node.style.setProperty(k, String(v));
      else node.style[k] = v;
    }
  }

  const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); return node; };

  /**
   * node.append(), but a null or false child is skipped rather than rendered.
   *
   * The DOM's own append() stringifies them: `foot.append(x, cond ? y : null)`
   * puts the literal word "null" on the screen when cond is false. el() has
   * always filtered its children; this is the same courtesy for the times a
   * node is appended to directly.
   */
  function append(node, ...kids) {
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  /**
   * Runs a redraw without throwing away the field somebody is typing in.
   *
   * A handler that rebuilds its own container destroys the focused element
   * and creates a new one, so the caret lands back in the page and the next
   * keystroke goes nowhere. That is the "only one character at a time" bug.
   *
   * Where a rebuild genuinely has to happen — a checkbox that reveals other
   * controls, a time field that changes what is shown — this puts the caret
   * back afterwards. Position is by index among the controls inside `root`,
   * because a rebuild recreates the same structure in the same order, and an
   * id would have to be invented and threaded through every widget.
   *
   * Not a licence to rebuild on every keystroke: where the form does not need
   * to change, do not redraw it at all.
   */
  function keepFocus(root, redraw) {
    const SELECTOR = 'input, textarea, select, button';
    const active = document.activeElement;
    const inside = !!(root && active && root.contains(active) && active !== root);

    let index = -1;
    let start = null;
    let end = null;
    if (inside) {
      index = [...root.querySelectorAll(SELECTOR)].indexOf(active);
      // Only text-ish fields have a selection; the rest throw on access.
      try { start = active.selectionStart; end = active.selectionEnd; } catch { start = null; }
    }

    redraw();

    if (!inside || index < 0) return;
    const next = [...root.querySelectorAll(SELECTOR)][index];
    if (!next) return;
    try { next.focus({ preventScroll: true }); } catch { next.focus(); }
    if (start != null && typeof next.setSelectionRange === 'function') {
      try { next.setSelectionRange(start, end); } catch { /* type will not take one */ }
    }
  }

  // ---------- time ----------

  const pad = (n, w = 2) => String(Math.floor(Math.abs(n))).padStart(w, '0');

  /** 90_000 -> "1:30"; 3_725_000 -> "1:02:05" */
  function duration(ms, { tenths = false } = {}) {
    const neg = ms < 0;
    const total = Math.abs(ms);
    const h = Math.floor(total / 3600000);
    const m = Math.floor(total / 60000) % 60;
    const s = Math.floor(total / 1000) % 60;
    let out = h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
    if (tenths) out += `.${Math.floor((total % 1000) / 100)}`;
    return (neg ? '−' : '') + out;
  }

  const MAX_DURATION_MS = 24 * 3600_000;

  /**
   * Punctuates a run of digits the way a microwave keypad does: the last two
   * are always seconds, the two before that minutes.
   *
   *   "7"      -> "7"          one or two digits stay minutes
   *   "230"    -> "2:30"
   *   "1500"   -> "15:00"
   *   "13000"  -> "1:30:00"
   *
   * The timer field runs this on every keystroke, so the colon appears as
   * the teacher types rather than having to be reached for.
   */
  function groupDigits(digits) {
    const d = String(digits).replace(/\D/g, '').slice(0, 6);
    if (d.length <= 2) return d;
    if (d.length <= 4) return `${d.slice(0, -2)}:${d.slice(-2)}`;
    return `${d.slice(0, -4)}:${d.slice(-4, -2)}:${d.slice(-2)}`;
  }

  /**
   * Reads a length of time the way a teacher would type one, and returns
   * milliseconds — or null if it is not a time at all.
   *
   *   "7"        7 minutes      one or two digits are minutes, which is what
   *   "45"       45 minutes     somebody setting a classroom timer means
   *   "230"      2m 30s         three or more read like a microwave: the last
   *   "1500"     15 minutes     two digits are seconds
   *   "13000"    1h 30m
   *   "2.5"      2m 30s
   *   "1:30"     1m 30s
   *   "1:02:30"  1h 2m 30s
   *   "45s"      45 seconds
   *   "1h30m"    90 minutes
   *   "20 min"   20 minutes
   *
   * The jump at 99 → 100 (99 minutes, then one minute) is inherent to the
   * microwave convention and is what everyone already expects from one.
   *
   * Deliberately forgiving about spacing and case, and deliberately strict
   * about anything left over: "5pm" is a time of day, not a length, and
   * silently reading it as five minutes would be worse than refusing it.
   */
  function parseDuration(text) {
    const raw = String(text == null ? '' : text).trim().toLowerCase();
    if (!raw) return null;

    let ms = null;

    if (raw.includes(':')) {
      const parts = raw.split(':');
      if (parts.length > 3) return null;
      const nums = parts.map((p) => (p.trim() === '' ? NaN : Number(p)));
      if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
      // [h,m,s] or [m,s] — the last field is always seconds.
      const [h, m, s] = parts.length === 3 ? nums : [0, nums[0], nums[1]];
      ms = ((h * 60 + m) * 60 + s) * 1000;
    } else if (/^\d+$/.test(raw)) {
      // A run of digits, read the way a microwave reads one. groupDigits is
      // what the timer field types out live, so the two can never disagree.
      const grouped = groupDigits(raw);
      ms = grouped.includes(':') ? parseDuration(grouped) : Number(raw) * 60_000;
    } else if (/^[\d.]+$/.test(raw)) {
      // A decimal is always minutes: "2.5" is two and a half minutes.
      const n = Number(raw);
      if (!Number.isFinite(n)) return null;
      ms = n * 60_000;
    } else {
      // Unit form. Every part has to be consumed, so stray text is refused.
      const re = /(\d+(?:\.\d+)?)\s*(hours|hour|hrs|hr|h|minutes|minute|mins|min|m|seconds|second|secs|sec|s)/g;
      let total = 0;
      let found = false;
      let match;
      while ((match = re.exec(raw)) !== null) {
        found = true;
        const unit = match[2][0];                       // h, m or s
        total += Number(match[1]) * (unit === 'h' ? 3600_000 : unit === 'm' ? 60_000 : 1000);
      }
      if (!found) return null;
      // Whatever the units did not account for has to be nothing meaningful,
      // so "5pm" is refused rather than quietly read as five minutes.
      const leftover = raw.replace(re, '').replace(/[\s,]|and/g, '');
      if (leftover) return null;
      ms = total;
    }

    if (ms == null || !Number.isFinite(ms)) return null;
    ms = Math.round(ms);
    if (ms <= 0 || ms > MAX_DURATION_MS) return null;
    return ms;
  }

  /** Minutes past midnight -> "9:05 am", in the browser's own convention. */
  function clockTime(minutes) {
    const d = new Date();
    d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  const minutesNow = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };

  function when(ts) {
    const d = new Date(ts);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (ts >= today.getTime()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }

  // ---------- odds and ends ----------

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  /** Fisher–Yates, on a copy. */
  function shuffle(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  const initials = (name) => String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');

  function debounce(fn, ms) {
    let t = null;
    const out = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
    out.flush = () => { clearTimeout(t); fn(); };
    out.cancel = () => clearTimeout(t);
    return out;
  }

  /**
   * Asks for one file. Resolves with it, or null if they changed their mind.
   * A detached input rather than one in the page, so nothing has to own it.
   */
  function pickFile(accept) {
    return new Promise((resolve) => {
      const input = el('input', { type: 'file', accept: accept || '', hidden: true });
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        input.remove();
        resolve(file || null);
      });
      // A cancelled picker fires nothing in some browsers, so the input is
      // cleaned up on the next interaction rather than leaked.
      window.addEventListener('focus', () => setTimeout(() => {
        if (document.body.contains(input) && !(input.files && input.files.length)) { input.remove(); resolve(null); }
      }, 400), { once: true });
      document.body.append(input);
      input.click();
    });
  }

  // ---------- pupils' names ----------

  /**
   * Does this name show a family name in full?
   *
   * The test is the LAST word: one letter, with or without a full stop, is an
   * initial; anything longer is a surname. Everything before it is left alone,
   * because a child with two given names has two given names.
   *
   * Deliberately a hint and never a rule. "Mary Jo" reads as a surname to this
   * and is not one, plenty of families do not divide a name this way at all,
   * and a teacher of sixth-formers may have every reason to type names in
   * full. So it counts and offers; it does not correct anybody.
   */
  function showsFamilyName(name) {
    const parts = String(name == null ? '' : name).trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) return false;
    return parts[parts.length - 1].replace(/\.$/, '').length > 1;
  }

  /** "Ava Bennett" → "Ava B." Names already short come back untouched. */
  function shortenName(name) {
    const parts = String(name == null ? '' : name).trim().split(/\s+/).filter(Boolean);
    if (!showsFamilyName(parts.join(' '))) return parts.join(' ');
    const last = parts[parts.length - 1].replace(/\.$/, '');
    return [...parts.slice(0, -1), `${last[0].toUpperCase()}.`].join(' ');
  }

  // ---------- printing ----------

  /**
   * Prints one element, with a heading, and puts everything back afterwards.
   *
   * The page is not rebuilt or reparented for this. Moving a widget's DOM into
   * a print container would sever every listener on it and kill the
   * ResizeObserver the seating plan is sized by; instead the rest of the page
   * is made invisible for the duration and the chosen element is pulled to the
   * top-left of the sheet. Nothing that was working stops working.
   *
   * `prepare` runs before the dialog opens and `restore` after it closes —
   * that is where a widget resizes itself for paper and then back again.
   * `restore` runs on afterprint, and also on a timer, because a browser that
   * never fires afterprint (Safari has form here) must not leave the desk
   * stuck invisible.
   */
  function print(node, { title = '', subtitle = '', prepare = null, restore = null } = {}) {
    if (!node) return;

    const head = el('div.print-head', {}, [
      title ? el('h1.print-title', { text: title }) : null,
      el('div.print-meta', {
        text: [subtitle, new Date().toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' })]
          .filter(Boolean).join(' \u00b7 '),
      }),
    ].filter(Boolean));

    let done = false;
    const cleanUp = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      window.removeEventListener('afterprint', cleanUp);
      head.remove();
      node.classList.remove('is-print-target');
      document.documentElement.classList.remove('is-printing');
      try { restore && restore(); } catch (e) { console.error(e); }
    };

    try { prepare && prepare(); } catch (e) { console.error(e); }
    node.prepend(head);
    node.classList.add('is-print-target');
    document.documentElement.classList.add('is-printing');

    window.addEventListener('afterprint', cleanUp);
    const timer = setTimeout(cleanUp, 60_000);

    // A frame first, so the layout the widget just asked for has actually
    // happened before the browser snapshots the page.
    let started = false;
    const go = () => {
      if (started) return;
      started = true;
      try { window.print(); }
      catch (e) { console.error(e); cleanUp(); return; }
      // Chrome's dialog is modal and blocks here, so by this line the job is
      // usually done; afterprint still covers the browsers where it is not.
      setTimeout(cleanUp, 1000);
    };
    requestAnimationFrame(() => requestAnimationFrame(go));
    // Animation frames do not run in a backgrounded tab, and a Print button
    // that silently does nothing is worse than one that goes a frame early.
    setTimeout(go, 300);
  }

  // ---------- toast ----------

  let toastHost = null;

  /**
   * toast('Saved')
   * toast('Recorded for Ava', 'info', { actionLabel: 'Undo', onAction })
   *
   * The optional action is what makes a one-tap mistake recoverable without
   * a confirmation dialog in front of every ordinary action. It gets longer
   * on screen than a plain toast, because it is asking to be read.
   */
  function toast(message, kind = 'info', action = null) {
    if (!toastHost) {
      toastHost = el('div.toasts', { role: 'status', 'aria-live': 'polite' });
      document.body.append(toastHost);
    }

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      node.classList.add('toast--out');
      setTimeout(() => node.remove(), 300);
    };

    const node = el(`div.toast.toast--${kind}`, {}, el('span', { text: message }));
    if (action && action.actionLabel && typeof action.onAction === 'function') {
      node.classList.add('toast--action');
      node.append(el('button.toast-btn', {
        text: action.actionLabel,
        onclick: () => { close(); action.onAction(); },
      }));
    }

    toastHost.append(node);
    setTimeout(close, action ? 7000 : 3600);
    return close;
  }

  // ---------- a small modal that returns a promise ----------

  function ask({ title, body, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false }) {
    return new Promise((resolve) => {
      const done = (value) => { scrim.remove(); document.removeEventListener('keydown', onKey); resolve(value); };
      const onKey = (e) => { if (e.key === 'Escape') done(false); };

      const confirmBtn = el(`button.btn${danger ? '.btn--danger' : '.btn--primary'}`, { text: confirmLabel, onclick: () => done(true) });
      const dialog = el('div.dialog', { role: 'dialog', 'aria-modal': 'true' }, [
        el('h2.dialog-title', { text: title }),
        typeof body === 'string' ? el('p.dialog-body', { text: body }) : el('div.dialog-body', {}, body),
        el('div.dialog-actions', {}, [
          el('button.btn', { text: cancelLabel, onclick: () => done(false) }),
          confirmBtn,
        ]),
      ]);
      const scrim = el('div.scrim', { onclick: (e) => { if (e.target === scrim) done(false); } }, dialog);
      document.body.append(scrim);
      document.addEventListener('keydown', onKey);
      confirmBtn.focus();
    });
  }

  /**
   * Shrinks a piece of display type until it fits the box it is in.
   *
   * CSS can size text against the width of its card (`cqi`) but not against
   * the height: `container-type: size` collapses a grid item's width to
   * nothing, taking every container query with it. So the width is left to
   * CSS and the height is measured here — the stylesheet says how big the
   * type would LIKE to be, and this brings it down until it is inside.
   *
   * Cheap to call on every frame: it remembers the text and the box it last
   * fitted, and does nothing at all until one of them changes.
   */
  function fitText(node, box) {
    const area = box || node.parentElement;
    if (!node || !area) return;
    const mark = `${node.textContent}|${area.clientWidth}x${area.clientHeight}`;
    if (node.dataset.fitted === mark) return;

    node.style.fontSize = '';
    let size = parseFloat(getComputedStyle(node).fontSize) || 16;

    /* The TEXT is measured, not the element. Both of the obvious measurements
       lie here: `scrollWidth` says everything fits when the line simply
       spills out of a centred flex box, and the element's own rectangle says
       everything fits when the element has been squeezed to the width of its
       parent and the letters are being clipped instead. A range around the
       contents reports where the glyphs actually are. */
    const reach = () => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      range.detach && range.detach();
      return { w: Math.max(r.width, node.scrollWidth), h: Math.max(r.height, node.scrollHeight) };
    };

    for (let i = 0; i < 14; i += 1) {
      const text = reach();
      if (text.w <= area.clientWidth + 1 && text.h <= area.clientHeight + 1) break;
      size *= 0.92;
      node.style.fontSize = `${size}px`;
    }
    node.dataset.fitted = mark;
  }

  Object.assign(Desk, { el, setStyle, clear, append, keepFocus, pad, pickFile, duration, parseDuration, groupDigits, clockTime, minutesNow, when, clamp, shuffle, initials, debounce, toast, ask, print, showsFamilyName, shortenName, fitText });
}(window.Desk));
