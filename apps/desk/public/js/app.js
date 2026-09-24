// ===================================================================
// Teacher's Desk — boot
//
// Works out who is here, then either shows the sign-in page, explains why
// the desk is closed to them, or draws the board.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon, toast } = Desk;

  const app = {};
  let config = null;
  let me = null;

  async function start() {
    const shell = document.getElementById('app');
    try {
      config = await Desk.api.config();
      // Shared, so other modules can link to the identity service without
      // fetching it again — the class-list dialog needs it to say WHERE a
      // centrally managed class is actually edited.
      Desk.config = config;
    } catch {
      shell.replaceChildren(message('The desk is not answering', 'Try again in a moment.'));
      return;
    }

    try {
      me = (await Desk.api.me()).user;
    } catch (e) {
      if (e.status === 401) return signInScreen(shell);
      throw e;
    }

    if (!me.can.desk) return closedScreen(shell);

    const data = await Desk.api.board();
    // Paint before the board is drawn, so nothing flashes in the wrong colour.
    Desk.theme.init({ prefs: data.prefs, save: (prefs) => Desk.board.setPrefs(prefs) });
    drawChrome(shell);
    Desk.board.init({ root: document.getElementById('board'), data, me });
    if (location.hash === '#versions') openHistory();
  }

  // ---------- the screens before the board ----------

  function message(title, body, actions) {
    return el('div.centre', {}, [
      el('div.centre-card', {}, [
        el('h1.centre-title', { text: title }),
        el('p.centre-body', { text: body }),
        actions ? el('div.centre-actions', {}, actions) : null,
      ]),
    ]);
  }

  function signInScreen(shell) {
    const actions = [];
    if (config.authEnabled) {
      actions.push(el('a.btn.btn--primary.btn--wide', { href: config.signInUrl }, 'Sign in with your school account'));
    }
    shell.replaceChildren(el('div.centre', {}, [
      el('div.centre-card', {}, [
        el('div.brand.brand--big', {}, [el('span.brand-mark', { svg: icon('timer', 26) }), el('span', { text: 'Teacher’s Desk' })]),
        el('p.centre-body', {
          text: config.authEnabled
            ? 'Timers, alarms, notes, groups and a private behaviour tally — on one board that stays as you leave it.'
            : 'Sign-in is not configured on this server yet.',
        }),
        actions.length ? el('div.centre-actions', {}, actions) : null,
        config.identityUrl
          ? el('p.centre-note', {}, [
            document.createTextNode('Your account is managed at '),
            el('a', { href: config.identityUrl, rel: 'noreferrer' }, new URL(config.identityUrl).host),
            document.createTextNode('.'),
          ])
          : null,
      ]),
    ]));
  }

  function closedScreen(shell) {
    shell.replaceChildren(message(
      'Your role does not include the desk',
      'Ask whoever administers your school in Signify ID to add the “Use the teacher’s desk” permission to your role.',
      [el('a.btn', { href: config.signOutUrl }, 'Sign out')],
    ));
  }

  // ---------- the board's chrome ----------

  function drawChrome(shell) {
    const avatar = me.picture
      ? el('img.avatar', { src: me.picture, alt: '', referrerpolicy: 'no-referrer' })
      : el('span.avatar.avatar--initials', { text: Desk.initials(me.name) });

    const menu = el('div.menu', { hidden: true }, [
      el('div.menu-head', {}, [
        el('strong', { text: me.name }),
        el('span.hint', { text: me.email }),
        me.school ? el('span.tag', { text: me.school }) : null,
        me.role ? el('span.hint', { text: me.role }) : null,
      ]),
      el('button.menu-item', { svg: icon('palette', 16), onclick: () => { hideMenu(); Desk.theme.open(); } }, ' Appearance'),
      // Only ever shrinks and closes gaps, so it is safe to offer without a
      // confirmation: nothing a teacher has placed moves sideways, and no
      // card grows under anything.
      el('button.menu-item', { svg: icon('collapse', 16), onclick: () => {
        hideMenu();
        const n = Desk.board.tidy();
        toast(n ? `${n} card${n === 1 ? '' : 's'} pulled in to fit.` : 'Everything already fits.');
      } }, ' Tidy up the desk'),
      el('button.menu-item', { svg: icon('reset', 16), onclick: () => { hideMenu(); Desk.board.reset(); } }, ' Reset my desk'),
      // A link rather than a dialog, so it can be sent to somebody who does
      // not have an account here — which is usually who is asking.
      el('a.menu-item', { href: '/what-is-held', target: '_blank', rel: 'noreferrer', svg: icon('lock', 16) }, ' What this holds about pupils'),
      config.identityUrl ? el('a.menu-item', { href: config.identityUrl, rel: 'noreferrer', svg: icon('person', 16) }, ' My account') : null,
      el('a.menu-item.menu-item--danger', { href: config.signOutUrl, svg: icon('close', 16) }, ' Sign out'),
    ]);

    const userBtn = el('button.user-btn', { 'aria-haspopup': 'menu', onclick: toggleMenu }, [avatar, el('span.user-name', { text: me.name })]);

    // One switch over every sound in the app. It sits in the top bar rather
    // than in a menu because it is reached mid-lesson, and it stays visibly
    // "on" while muted so that a timer running out in silence reads as a
    // choice somebody made rather than as the app being broken.
    const muteBtn = el('button.btn.mute-btn', { onclick: () => Desk.sound.setMuted(!Desk.sound.isMuted()) });
    function paintMute() {
      const off = Desk.sound.isMuted();
      Desk.clear(muteBtn).append(
        el('span', { svg: icon(off ? 'muted' : 'sound', 16) }),
        el('span.mute-label', { text: off ? 'Muted' : 'Sound' }),
      );
      muteBtn.classList.toggle('is-muted', off);
      muteBtn.setAttribute('aria-pressed', String(off));
      muteBtn.title = off
        ? 'Every sound is off — timers and alarms will not ring. Turn them back on.'
        : 'Turn every sound off';
    }
    paintMute();
    Desk.sound.onChange(paintMute);

    // Class lists sits in the bar rather than in the menu: it is reached
    // between lessons, by somebody who is looking at the desk rather than at
    // their own account.
    const listsBtn = el('button.btn.lists-btn', {
      title: 'Class lists',
      onclick: () => Desk.roster.manage(),
    }, [el('span', { svg: icon('list', 16) }), el('span.lists-label', { text: 'Classes' })]);

    // The mark is the three shapes the board itself uses — time, your class,
    // the board — rather than a picture of a clock. Same alphabet everywhere.
    const brand = el('div.brand', {}, [
      el('span.brand-mark', {}, [
        el('span.shape', { 'data-shape': 'circle', style: { '--role': 'var(--p1)' } }),
        el('span.shape', { 'data-shape': 'square', style: { '--role': 'var(--p2)' } }),
        el('span.shape', { 'data-shape': 'triangle', style: { '--role': 'var(--p3)' } }),
      ]),
      el('span.brand-word', { text: 'Teacher’s Desk' }),
    ]);

    const island = el('div.island', { 'aria-label': 'What your tools are saying', role: 'status' });

    const bar = el('header.topbar', {}, [
      brand,
      island,
      el('div.topbar-tools', {}, [
        listsBtn,
        muteBtn,
        el('button.btn.btn--primary.add-btn', { svg: icon('plus', 16), onclick: openCatalogue }, ' Add a tool'),
        el('div.user', {}, [userBtn, menu]),
      ]),
    ]);

    /* The island is the board read from across the room: whatever the tools
       are saying, gathered into one pill. It is rebuilt rather than patched
       because there are at most four items in it — and a readout that has
       stopped being worth showing has to be able to leave. */
    function paintIsland() {
      const said = Desk.board.readouts(islandRoom());
      // Nothing running, nothing to say. An empty pill is furniture.
      if (!said.length) { island.replaceChildren(); island.hidden = true; return; }
      island.hidden = false;
      const parts = [];
      said.forEach((r, i) => {
        if (i) parts.push(el('span.island-rule', { 'aria-hidden': 'true' }));
        parts.push(el('button.island-item', {
          title: `${r.caption} — open it`,
          onclick: () => Desk.board.openStage(r.id),
        }, [
          Desk.widgets.marker(r.category, 10),
          el('span.island-text', {}, [
            el('span.island-value', { text: r.value }),
            r.caption ? el('span.island-caption', { text: r.caption }) : null,
          ]),
          typeof r.progress === 'number'
            ? el('span.island-bar', { style: { '--fill': r.progress }, 'aria-hidden': 'true' })
            : null,
        ]));
      });
      island.replaceChildren(...parts);
    }

    // As the window narrows the island gives things up rather than shrinking
    // them: the timer and the last pick are what survive.
    function islandRoom() {
      const w = window.innerWidth;
      if (w < 880) return 2;
      if (w < 1280) return 3;
      return 4;
    }

    setInterval(paintIsland, 1000);
    paintIsland();

    function toggleMenu() { menu.hidden = !menu.hidden; if (!menu.hidden) setTimeout(() => document.addEventListener('pointerdown', away), 0); }
    function hideMenu() { menu.hidden = true; document.removeEventListener('pointerdown', away); }
    function away(e) { if (!menu.contains(e.target) && e.target !== userBtn) hideMenu(); }

    /* The chips are a way of quietening the board, not of rearranging it:
       choosing one hides the cards that are not that family, and the layout
       underneath is untouched. Nothing is saved — a filter is for the next
       minute, not for the next term. */
    const filters = el('nav.filters', { 'aria-label': 'Show one kind of tool' });
    let showing = 'all';

    function paintFilters() {
      const pick = (key) => () => { showing = key; paintFilters(); applyFilter(); };
      const chips = [el('button.filter.is-on', {
        class: showing === 'all' ? 'filter is-on' : 'filter',
        'aria-pressed': String(showing === 'all'), onclick: pick('all'),
      }, el('span', { text: 'All tools' }))];
      for (const c of Desk.widgets.CATEGORIES) {
        if (c.key === 'other') continue;
        chips.push(el('button.filter', {
          class: showing === c.key ? 'filter is-on' : 'filter',
          'aria-pressed': String(showing === c.key), onclick: pick(c.key),
        }, [Desk.widgets.marker(c.key, 12), el('span', { text: c.name })]));
      }
      filters.replaceChildren(...chips);
    }

    function applyFilter() {
      for (const card of document.querySelectorAll('.card')) {
        const def = Desk.widgets.get(card.dataset.type);
        const mine = showing === 'all' || (def && def.category === showing);
        card.classList.toggle('is-filtered-out', !mine);
      }
    }

    paintFilters();
    document.addEventListener('desk:rendered', applyFilter);

    shell.replaceChildren(bar, filters, el('main#board.board', { 'aria-label': 'Your desk' }));
    document.getElementById('board').style.setProperty('--cols', String(Desk.board.COLUMNS));
  }

  // ---------- getting an earlier desk back ----------

  /**
   * Every version of this desk the server kept, newest first.
   *
   * Deliberately NOT in the menu. "Earlier versions of this desk" is a
   * developer's idea of a feature, and a teacher opening it mid-lesson is
   * more likely to be confused by it than helped. It stays reachable at
   * `/#versions`, and as `Desk.app.openHistory()`, so a desk that has lost
   * something can still be put right — the copies themselves are taken on the
   * server whether or not anybody ever opens this.
   *
   * The server takes a copy on its way past any save that would remove seated
   * pupils, which is the shape every loss here has had. This is how a teacher
   * gets their afternoon back without anybody looking at a JSON file.
   */
  async function openHistory() {
    const list = el('div.catalogue');
    const scrim = el('div.scrim', { onclick: (e) => { if (e.target === scrim) close(); } }, [
      el('div.dialog.dialog--wide', { role: 'dialog', 'aria-modal': 'true' }, [
        el('h2.dialog-title', { text: 'Earlier versions of this desk' }),
        el('p.dialog-note', {
          text: 'A copy is kept whenever something is about to remove pupils from a seating plan, and every half hour besides. Putting one back keeps the desk as it stands now, so you can change your mind.',
        }),
        list,
        el('div.dialog-actions', {}, [el('button.btn', { text: 'Close', onclick: () => close() })]),
      ]),
    ]);
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    function close() { scrim.remove(); document.removeEventListener('keydown', onKey); }
    document.addEventListener('keydown', onKey);
    document.body.append(scrim);

    list.append(el('p.hint', { text: 'Looking…' }));
    let versions = [];
    try { versions = (await Desk.api.boardHistory()).versions || []; }
    catch (e) { Desk.clear(list).append(el('p.hint', { text: e.message })); return; }

    Desk.clear(list);
    if (!versions.length) {
      list.append(el('p.hint', { text: 'Nothing kept yet. One will be as soon as there is anything worth keeping.' }));
      return;
    }

    for (const v of versions) {
      list.append(el('div.saved-row', {}, [
        el('div.saved-what', {}, [
          el('span.saved-name', { text: Desk.when(v.at) }),
          el('span.hint', { text: `${v.seated} seated across ${v.plans} plan${v.plans === 1 ? '' : 's'} · ${v.why}` }),
        ]),
        el('button.btn.btn--small', {
          text: 'Put this back',
          onclick: async () => {
            const sure = await Desk.ask({
              title: `Go back to the desk as it was at ${Desk.when(v.at)}?`,
              body: `It had ${v.seated} pupils seated. The desk as it stands now is kept too, so this is not a one-way door.`,
              confirmLabel: 'Put it back',
            });
            if (!sure) return;
            try {
              await Desk.api.restoreBoard(v.rev);
              close();
              window.location.reload();
            } catch (e) { toast(e.message, 'warn'); }
          },
        }),
      ]));
    }
  }

  // ---------- adding a tool ----------

  function openCatalogue() {
    const onDesk = new Map();
    for (const it of Desk.board.items()) onDesk.set(it.type, (onDesk.get(it.type) || 0) + 1);

    const list = el('div.catalogue');
    const count = el('p.dialog-note.cat-count');
    let firstMatch = null;                 // what Enter in the search box adds

    /** One row in the catalogue. */
    function row(def) {
      const already = onDesk.get(def.type) || 0;
      return el('button.cat-item', {
        onclick: () => { Desk.board.addItem(def.type); close(); },
      }, [
        el('span.cat-icon', { svg: icon(def.icon, 22) }),
        el('span.cat-text', {}, [
          el('span.cat-name', {}, [
            document.createTextNode(def.name),
            already ? el('span.tag.tag--quiet', { text: `${already} on the desk` }) : null,
          ]),
          el('span.cat-blurb', { text: def.blurb }),
        ]),
        el('span.cat-plus', { svg: icon('plus', 18) }),
      ]);
    }

    function draw(term) {
      Desk.clear(list);
      firstMatch = null;

      const drawers = Desk.widgets.byCategory(me, term);
      const found = drawers.reduce((n, d) => n + d.widgets.length, 0);

      if (!found) {
        list.append(el('p.hint.cat-empty', { text: `Nothing matches “${term}”. Try a word from what it does — “time”, “random”, “sound”.` }));
        count.textContent = '';
        return;
      }

      // Searching flattens the drawers: somebody who has typed a word is
      // looking for one tool, and headings between three results are noise.
      if (term.trim()) {
        count.textContent = `${found} ${found === 1 ? 'tool matches' : 'tools match'} “${term.trim()}”.`;
        for (const drawer of drawers) {
          for (const def of drawer.widgets) {
            if (!firstMatch) firstMatch = def;
            list.append(row(def));
          }
        }
        return;
      }

      count.textContent = '';
      for (const drawer of drawers) {
        list.append(el('div.cat-head', {}, [
          el('h3.cat-head-name', { text: drawer.name }),
          el('span.cat-head-blurb', { text: drawer.blurb }),
        ]));
        for (const def of drawer.widgets) {
          if (!firstMatch) firstMatch = def;
          list.append(row(def));
        }
      }
    }

    const search = el('input.input.cat-search', {
      type: 'search',
      placeholder: 'Search the tools\u2026',
      'aria-label': 'Search the tools',
      autocomplete: 'off',
      // Only the list is rebuilt, never this input — otherwise the caret is
      // lost after the first letter, which is the bug this app has already
      // fixed in nine other places.
      oninput: (e) => draw(e.target.value),
      onkeydown: (e) => {
        if (e.key !== 'Enter' || !firstMatch) return;
        e.preventDefault();
        Desk.board.addItem(firstMatch.type);
        close();
      },
    });

    draw('');

    const scrim = el('div.scrim', { onclick: (e) => { if (e.target === scrim) close(); } }, [
      el('div.dialog.dialog--wide', { role: 'dialog', 'aria-modal': 'true' }, [
        el('h2.dialog-title', { text: 'Add a tool' }),
        el('p.dialog-note', { text: 'Add as many as you like — two timers, three notes. Drag a card by its top edge to move it, and by its bottom-right corner to resize it.' }),
        search,
        count,
        list,
        el('div.dialog-actions', {}, [el('button.btn', { text: 'Close', onclick: () => close() })]),
      ]),
    ]);
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    function close() { scrim.remove(); document.removeEventListener('keydown', onKey); }
    document.addEventListener('keydown', onKey);
    document.body.append(scrim);
    // Straight into the search box on a keyboard, but not on a touch screen,
    // where it would throw a keyboard over the list somebody wants to browse.
    if (!window.matchMedia('(pointer: coarse)').matches) search.focus();
  }

  app.openCatalogue = openCatalogue;
  app.openHistory = openHistory;

  // A way back for a desk that has lost something, without a menu item that
  // would puzzle everybody who has not lost anything.
  window.addEventListener('hashchange', () => { if (location.hash === '#versions') openHistory(); });
  Desk.app = app;

  start().catch((e) => {
    console.error(e);
    document.getElementById('app').replaceChildren(message('Something went wrong', e.message));
  });
}(window.Desk));
