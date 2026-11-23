// ===================================================================
// Teacher's Desk — a few of your own cards, framed by another Signify app
//
// Signify Learning's left rail frames /embed?tools=timer,seating&class=<id>
// to show the person's REAL desk tools: the same cards as on their desk (the
// same timer, the same seating plans), drawn by the same widget code, saved
// by the same board save. To the server it is just another tab of the desk,
// so two of them never overwrite each other: a stale save is refused (409)
// and the frame reloads, exactly as a second desk tab does.
//
// Nothing here moves, resizes or removes a card; Open larger works, and each
// card has a way to the whole desk in a new window. A missing tool is put
// down below everything on the desk, never moving a card that is there.
// The framing app is told the frame's height and when a card opens larger,
// by postMessage to the origin it names (?from=), and only if that origin is
// one this server lets frame it (the page's frame-ancestors says the same).
// Opening larger sends where the card sits in the frame; the framing app
// grows the frame out of that spot, and on { stage: 'closing' } shrinks it
// back there and answers { closed: true } before the big view goes
// (board.js, openStage). Cards here are sized to their content at the
// frame's width (styles.css, .board--embed), not to their desk rows.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el } = Desk;
  const params = new URLSearchParams(location.search);
  const tools = (params.get('tools') || '').split(',').map((t) => t.trim()).filter((t) => /^[a-z]{2,30}$/.test(t)).slice(0, 12);
  const classId = (params.get('class') || '').trim();
  const classKey = /^[\w-]{1,80}$/.test(classId) ? `signify:${classId}` : '';
  const allowedFrom = (document.querySelector('meta[name="desk-embed-origins"]')?.content || '').split(' ').filter(Boolean);
  const from = params.get('from') || '';
  const parentOrigin = allowedFrom.includes(from) ? from : '';

  function tell(msg) {
    if (!parentOrigin || window.parent === window) return;
    try { window.parent.postMessage({ desk: 1, ...msg }, parentOrigin); } catch { /* not framed */ }
  }

  function note(title, body, link) {
    const root = document.getElementById('app');
    root.replaceChildren(el('div.embed-note', {}, [
      el('p', {}, [el('strong', { text: title })]),
      body ? el('p', { text: body }) : null,
      link ? el('a.btn.btn--primary.btn--small', { href: link.href, target: '_blank', rel: 'noopener' }, link.text) : null,
    ]));
    sendHeight();
  }

  // ---------- signed in by Learning (server/embed.js) ----------
  // No desk sign-in in this browser: the framing app's server vouches for the
  // person. We ask the parent for a one-use ticket, and trade it here for a
  // session cookie that only this page's requests use. Renewed shortly
  // before it ends, and on any 401 (api.js).
  let renewing = null;
  let renewTimer = null;
  function askParent() {
    return new Promise((resolve) => {
      const done = (v) => { clearTimeout(t); window.removeEventListener('message', on); resolve(v); };
      const on = (e) => {
        if (e.origin !== parentOrigin || e.source !== window.parent) return;
        const m = e.data;
        if (m && m.desk === 1 && 'ticket' in m) done(typeof m.ticket === 'string' ? m.ticket : null);
      };
      const t = setTimeout(() => done(null), 12000);
      window.addEventListener('message', on);
      tell({ want: 'session' });
    });
  }
  async function vouch() {
    if (!parentOrigin || window.parent === window) return false;
    const ticket = await askParent();
    if (!ticket) return false;
    try {
      const res = await fetch('/embed/session', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket }),
      });
      if (!res.ok) return false;
      const { until } = await res.json();
      clearTimeout(renewTimer);
      // A minute and a half early, but never sooner than in 20 seconds.
      const wait = Math.max(20000, Number(until) - Date.now() - 90000);
      if (Number.isFinite(wait)) renewTimer = setTimeout(() => { Desk.embedRenew(); }, wait);
      return true;
    } catch { return false; }
  }
  function renew() {
    if (!renewing) renewing = vouch().finally(() => { renewing = null; });
    return renewing;
  }

  let lastHeight = 0;
  function sendHeight() {
    const h = Math.ceil(document.getElementById('app').getBoundingClientRect().height) + 2;
    if (Math.abs(h - lastHeight) < 2) return;
    lastHeight = h;
    tell({ height: h });
  }

  async function start() {
    try {
      Desk.config = await Desk.api.config();
    } catch {
      return note('Teacher’s Desk is not answering.', 'Try again in a moment.');
    }
    let me;
    try {
      me = (await Desk.api.me()).user;
    } catch (e) {
      if (e.status !== 401) return note('Teacher’s Desk is not answering.', 'Try again in a moment.');
      // Learning signs the person in for us when it can.
      if (await renew()) {
        Desk.embedRenew = renew;
        try { me = (await Desk.api.me()).user; } catch { me = null; }
      }
    }
    if (!me) {
      // Signing in can't happen inside a frame (Signify ID refuses to be framed).
      return note('Sign in to Teacher’s Desk to use your tools here.', 'It opens in a new window; come back to this page afterwards.',
        { href: (Desk.config && Desk.config.signInUrl) || '/auth/login', text: 'Sign in' });
    }
    if (!me.can.desk) return note('Your school hasn’t given your role Teacher’s Desk.', '');

    const data = await Desk.api.board();
    Desk.theme.init({ prefs: data.prefs, save: (prefs) => Desk.board.setPrefs(prefs) });
    const board = el('main#board.board.board--embed', { 'aria-label': 'Your desk tools' });
    document.getElementById('app').replaceChildren(board);
    Desk.board.init({ root: board, data, me, only: tools, classKey, parentOrigin });
    if (!Desk.board.items().length || !board.querySelector('.card')) {
      note('None of these tools are on for you.', 'Your school decides which desk tools each role has.');
    }

    if (typeof ResizeObserver === 'function') new ResizeObserver(sendHeight).observe(document.getElementById('app'));
    sendHeight();
  }

  start().catch((e) => { console.error(e); note('Something went wrong opening your desk tools.', 'Reload the page to try again.'); });
}(window.Desk));
