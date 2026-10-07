// ===================================================================
// Widget — Saved links
//
// The handful of pages a teacher opens every lesson — the reading site, the
// quiz, the class's shared folder — one tap away instead of a hunt through
// bookmarks on a machine that is not theirs. Each opens in a new tab, so the
// desk stays where it was.
//
// Only web addresses. Whatever was typed is parsed and put back together
// from its parts, and anything that is not http or https is refused — both
// when it is saved and again when it is drawn, because a board's saved state
// is only as trustworthy as the last thing that wrote it.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon, toast } = Desk;

  const MAX_LINKS = 40;
  const MAX_TITLE = 80;
  const MAX_URL = 2000;

  /**
   * A web address worth saving, or null.
   *
   * "bbc.co.uk/bitesize" is what people actually type, so a bare address is
   * given https:// rather than refused. A `javascript:` or `data:` address is
   * refused outright: a link on the board is something a teacher taps in
   * front of a class, and it must only ever go to a web page.
   */
  function cleanUrl(input) {
    let text = String(input == null ? '' : input).trim();
    if (!text || text.length > MAX_URL) return null;
    // Anything with a scheme of its own keeps it, and is judged on it. A
    // bare "example.com" has none, and is taken to mean the web.
    if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`;
    let url;
    try { url = new URL(text); } catch { return null; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    // A host with no dot is a typo or somebody's intranet shortcut, neither
    // of which will open from a classroom machine. "localhost" is the one
    // exception worth keeping for a teacher who builds things.
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null;
    // Passwords in the address would sit in the board's saved state and be
    // shown on the projector. Nobody means to save one.
    if (url.username || url.password) return null;
    return url.href;
  }

  /** What to call a link nobody named: the site, without the www. */
  function nameFor(href) {
    try {
      const url = new URL(href);
      const host = url.hostname.replace(/^www\./, '');
      const path = url.pathname.replace(/\/+$/, '');
      return path && path !== '/' ? `${host}${path}` : host;
    } catch { return href; }
  }

  const cleanTitle = (t) => String(t == null ? '' : t).replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);

  Desk.widget({
    type: 'links',
    name: 'Saved links',
    blurb: 'The pages you open every lesson, one tap away. Each opens in a new tab.',
    icon: 'external',
    category: 'board',
    tone: 'block',
    guest: true,
    size: { w: 4, h: 5 },
    min: { w: 3, h: 3 },

    init(s) {
      if (!Array.isArray(s.links)) s.links = [];
      // Whatever was saved is judged again on the way in. A link that no
      // longer passes is dropped rather than drawn.
      s.links = s.links
        .map((l) => ({ id: String(l && l.id || ''), url: cleanUrl(l && l.url), title: cleanTitle(l && l.title) }))
        .filter((l) => l.id && l.url)
        .slice(0, MAX_LINKS);
    },

    holdsContent: (s) => (s.links.length ? `${s.links.length} saved link${s.links.length === 1 ? '' : 's'}.` : ''),

    mount(ctx) {
      const s = ctx.state;
      const list = el('ul.link-list');
      const urlBox = el('input.input.link-url', {
        type: 'url', inputmode: 'url', placeholder: 'Paste or type an address',
        'aria-label': 'Web address', maxlength: String(MAX_URL), spellcheck: 'false',
        onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } },
      });
      const nameBox = el('input.input.link-name', {
        type: 'text', placeholder: 'Name (optional)', 'aria-label': 'Name for the link',
        maxlength: String(MAX_TITLE),
        onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } },
      });

      ctx.root.append(el('div.links', {}, [
        list,
        el('div.link-add', {}, [
          urlBox,
          // Naming a link is worth the room in the big view; on the card it
          // would crowd out the links themselves, and the site's own name is
          // usually good enough.
          ctx.expanded ? nameBox : null,
          el('button.btn.btn--primary.btn--small', { svg: icon('plus', 14), onclick: add }, ' Add'),
        ]),
      ]));

      function add() {
        const url = cleanUrl(urlBox.value);
        if (!url) {
          toast(urlBox.value.trim() ? 'That does not look like a web address.' : 'Type or paste an address first.', 'warn');
          urlBox.focus();
          return;
        }
        if (s.links.length >= MAX_LINKS) { toast('That is as many links as one card holds.', 'warn'); return; }
        if (s.links.some((l) => l.url === url)) { toast('That link is already here.', 'warn'); return; }
        s.links.push({ id: `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, url, title: cleanTitle(nameBox.value) });
        urlBox.value = '';
        nameBox.value = '';
        ctx.save();
        draw();
        urlBox.focus();
      }

      function remove(id) {
        s.links = s.links.filter((l) => l.id !== id);
        ctx.save();
        draw();
      }

      function move(id, by) {
        const i = s.links.findIndex((l) => l.id === id);
        const j = i + by;
        if (i < 0 || j < 0 || j >= s.links.length) return;
        [s.links[i], s.links[j]] = [s.links[j], s.links[i]];
        ctx.save();
        draw();
      }

      function rename(id, title) {
        const link = s.links.find((l) => l.id === id);
        if (!link) return;
        link.title = cleanTitle(title);
        ctx.save();
      }

      function draw() {
        Desk.clear(list);
        if (!s.links.length) {
          list.append(el('li.hint.link-empty', { text: 'No links yet. Paste an address below.' }));
          return;
        }
        s.links.forEach((link, i) => {
          // Judged again here, at the moment it becomes a real link on the
          // page: this is the line that actually matters.
          const href = cleanUrl(link.url);
          if (!href) return;
          const label = link.title || nameFor(href);
          list.append(el('li.link-row', {}, [
            el('a.link-open', {
              href, target: '_blank', rel: 'noopener noreferrer',
              title: `Open ${href} in a new tab`,
            }, [
              el('span.link-icon', { svg: icon('external', 14) }),
              el('span.link-text', {}, [
                ctx.expanded
                  ? el('input.link-title', {
                    value: link.title, placeholder: nameFor(href), 'aria-label': 'Name for this link',
                    maxlength: String(MAX_TITLE),
                    // The row is a link; typing in its name must not follow it.
                    onclick: (e) => e.preventDefault(),
                    onchange: (e) => rename(link.id, e.target.value),
                  })
                  : el('span.link-label', { text: label }),
                el('span.link-host', { text: new URL(href).hostname.replace(/^www\./, '') }),
              ]),
            ]),
            ctx.expanded ? el('button.icon-btn', {
              title: 'Move up', 'aria-label': 'Move up', text: '↑',
              disabled: i === 0, onclick: () => move(link.id, -1),
            }) : null,
            ctx.expanded ? el('button.icon-btn', {
              title: 'Move down', 'aria-label': 'Move down', text: '↓',
              disabled: i === s.links.length - 1, onclick: () => move(link.id, 1),
            }) : null,
            el('button.icon-btn.icon-btn--danger.link-remove', {
              title: 'Remove this link', 'aria-label': `Remove ${label}`,
              svg: icon('close', 14), onclick: () => remove(link.id),
            }),
          ]));
        });
      }

      draw();
      return {};
    },

    // Exposed for the tests: the address rules are the part that matters.
    _cleanUrl: cleanUrl,
    _nameFor: nameFor,
  });
}(window.Desk));
