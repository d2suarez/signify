// ===================================================================
// Teacher's Desk — boot
//
// Works out who is here, then either shows the sign-in page, explains why
// the desk is closed to them, or draws the board.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon } = Desk;

  const app = {};
  let config = null;
  let me = null;

  async function start() {
    const shell = document.getElementById('app');
    try {
      config = await Desk.api.config();
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
      el('button.menu-item', { svg: icon('list', 16), onclick: () => { hideMenu(); Desk.roster.manage(); } }, ' Class lists'),
      el('button.menu-item', { svg: icon('palette', 16), onclick: () => { hideMenu(); Desk.theme.open(); } }, ' Appearance'),
      el('button.menu-item', { svg: icon('reset', 16), onclick: () => { hideMenu(); Desk.board.reset(); } }, ' Reset my desk'),
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

    const bar = el('header.topbar', {}, [
      el('div.brand', {}, [el('span.brand-mark', { svg: icon('timer', 20) }), el('span', { text: 'Teacher’s Desk' })]),
      el('div.topbar-spacer'),
      muteBtn,
      el('button.btn.btn--primary', { svg: icon('plus', 16), onclick: openCatalogue }, ' Add a tool'),
      el('div.user', {}, [userBtn, menu]),
    ]);

    function toggleMenu() { menu.hidden = !menu.hidden; if (!menu.hidden) setTimeout(() => document.addEventListener('pointerdown', away), 0); }
    function hideMenu() { menu.hidden = true; document.removeEventListener('pointerdown', away); }
    function away(e) { if (!menu.contains(e.target) && e.target !== userBtn) hideMenu(); }

    shell.replaceChildren(bar, el('main#board.board', { 'aria-label': 'Your desk' }));
    document.getElementById('board').style.setProperty('--cols', String(Desk.board.COLUMNS));
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
  Desk.app = app;

  start().catch((e) => {
    console.error(e);
    document.getElementById('app').replaceChildren(message('Something went wrong', e.message));
  });
}(window.Desk));
