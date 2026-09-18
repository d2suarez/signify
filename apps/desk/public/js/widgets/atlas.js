// ===================================================================
// Widget — Classroom Atlas
//
// The teaching map, on the desk. maps.signify.one sets no frame restriction,
// so it can be worked in place rather than only linked to — and because it is
// a sibling on the same site, the teacher's session comes with it and they do
// not sign in again.
//
// The card is a launcher; the embed only appears at full size. A map in a
// card the size of a postcard is not a map anybody can use, and loading one
// into every small card on the board would be a waste of a classroom's
// bandwidth.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon } = Desk;

  const URL_BASE = 'https://maps.signify.one/';

  Desk.widget({
    type: 'atlas',
    name: 'Classroom Atlas',
    blurb: 'The teaching map — Bible, history and world data. Opens right here on the desk.',
    icon: 'globe',
    category: 'other',
    fills: true,
    size: { w: 5, h: 5 },
    min: { w: 2, h: 3 },

    init(s) {
      if (typeof s.loaded !== 'boolean') s.loaded = false;
    },

    mount(ctx) {
      const root = el('div.embed');
      ctx.root.append(root);

      function draw() {
        Desk.clear(root);

        if (!ctx.expanded) {
          root.append(el('button.embed-card', { onclick: () => ctx.expand && ctx.expand() }, [
            el('span.embed-icon', { svg: icon('globe', 30) }),
            el('span.embed-name', { text: 'Classroom Atlas' }),
            el('span.embed-blurb', { text: 'Bible, history and world data on a teaching map.' }),
            el('span.embed-go', { svg: icon('expand', 15) }, ' Open it here'),
          ]));
          root.append(el('a.hint.embed-link', {
            href: URL_BASE, target: '_blank', rel: 'noopener noreferrer',
          }, 'or open it in its own tab'));
          return;
        }

        root.append(
          el('div.embed-bar', {}, [
            el('span.embed-bar-name', { text: 'Classroom Atlas' }),
            el('a.btn.btn--small', {
              href: URL_BASE, target: '_blank', rel: 'noopener noreferrer', svg: icon('external', 13),
            }, ' Open in a tab'),
          ]),
          el('iframe.embed-frame', {
            src: URL_BASE,
            title: 'Classroom Atlas',
            referrerpolicy: 'same-origin',
          }),
        );
      }

      draw();
      return {};
    },
  });
}(window.Desk));
