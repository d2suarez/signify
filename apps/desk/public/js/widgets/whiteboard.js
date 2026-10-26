// ===================================================================
// Widget — Whiteboard
//
// A card that opens draw.signify.one in its own tab.
//
// It is not embedded, and that is deliberate rather than unfinished:
// draw.signify.one sends `frame-ancestors 'self'` and `X-Frame-Options:
// SAMEORIGIN`. That is clickjacking protection on an authenticated drawing
// surface — a page that can be framed can be framed invisibly over something
// else, and a shared board is exactly the sort of thing worth protecting.
// Weakening it so this widget could show a picture would be trading a real
// protection for a nicer-looking card.
//
// So this is an honest launcher, and it says why.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon } = Desk;

  const URL_BASE = 'https://draw.signify.one/';

  Desk.widget({
    type: 'whiteboard',
    name: 'Whiteboard',
    blurb: 'The shared drawing board. Opens in its own tab.',
    icon: 'notes',
    category: 'other',
    students: true,
    role: 'p1',
    guest: true,
    fills: true,
    size: { w: 3, h: 3 },
    min: { w: 2, h: 2 },

    init() {},

    mount(ctx) {
      const root = el('div.embed');
      ctx.root.append(root);

      root.append(el('a.embed-card.embed-card--green', {
        href: URL_BASE, target: '_blank', rel: 'noopener noreferrer',
      }, [
        el('span.embed-icon', { svg: icon('notes', 30) }),
        el('span.embed-name', { text: 'Whiteboard' }),
        el('span.embed-blurb', { text: 'The shared drawing board.' }),
        el('span.embed-go', { svg: icon('external', 15) }, ' Open in a tab'),
      ]));

      if (ctx.expanded) {
        root.append(el('p.hint', {
          text: 'The whiteboard refuses to be shown inside another page, which is the right call for a drawing board you are signed into — so it opens in a tab of its own rather than here.',
        }));
      }

      return {};
    },
  });
}(window.Desk));
