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

  // A browser that has signed in here before goes straight to sign-in rather
  // than waiting on a button. The marker cookie is set on sign-in and removed
  // on sign-out; the timestamp stops a refused or abandoned sign-in from
  // bouncing the page in a loop.
  function autoSignIn(signInUrl) {
    try {
      if (!/(?:^|; )sfy_ret=1/.test(document.cookie)) return false;
      const last = Number(sessionStorage.getItem('sfy_auto')) || 0;
      if (Date.now() - last < 120000) return false;
      sessionStorage.setItem('sfy_auto', String(Date.now()));
      window.location.replace(signInUrl + '?return=' +
        encodeURIComponent(window.location.pathname + window.location.search));
      return true;
    } catch (e) { return false; }
  }

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
      if (e.status !== 401) throw e;
      // Not signed in. If this server can sign people in at all, they get a
      // working desk with the tools that need no account, and the rest shown
      // but locked. If it cannot, there is nothing to offer beyond saying so.
      if (config.authEnabled && autoSignIn(config.signInUrl)) return;
      return config.authEnabled ? guestDesk(shell) : signInScreen(shell);
    }

    if (!me.can.desk) return closedScreen(shell);

    const data = await Desk.api.board();
    // Paint before the board is drawn, so nothing flashes in the wrong colour.
    Desk.theme.init({ prefs: data.prefs, save: (prefs) => Desk.board.setPrefs(prefs) });
    drawChrome(shell);
    Desk.board.init({ root: document.getElementById('board'), data, me });
    if (location.hash === '#versions') openHistory();
    offerVisitorDesk();
    announceNew();
  }

  /**
   * "Log in to keep it" has to be true. If class lists or tools were set up
   * in this browser before signing in, offer to move them into the account.
   *
   * The desk a teacher has built while signed in is the thing to protect, so
   * the rules are strict. Nothing happens by itself: it is offered once a
   * session and only moves on a yes, with a plain warning, because on a
   * shared classroom computer what is here may be somebody else's. Nothing
   * is replaced: lists are added alongside the teacher's own, tools are set
   * down BELOW everything already on the desk, and not one card that was
   * there moves. And nothing is lost: the copy in this browser is removed
   * only once the account has confirmed it has everything.
   */
  async function offerVisitorDesk() {
    let storage;
    try { storage = window.localStorage; } catch { return; }
    const local = Desk.localApi.make(storage);
    const lists = local.lists().filter((l) => l.students && l.students.length);
    let saved = null;
    try { saved = JSON.parse(storage.getItem(Desk.board.GUEST_KEY) || 'null'); } catch { /* none */ }
    // Only tools a visitor could actually use; the locked ones were never set up.
    const visitorItems = (saved && Array.isArray(saved.items) ? saved.items : [])
      .filter((i) => { const d = i && Desk.widgets.get(i.type); return d && d.guest; });

    // What would come if every list comes with it — which is what is asked.
    const identity = new Map(lists.map((l) => [l.id, { id: l.id, students: new Map(l.students.map((p) => [p.id, p.id])) }]));
    const tools = Desk.localApi.carryOver(visitorItems, { moved: identity, worth: holdsSomething });
    if (!lists.length && !tools.length) return;
    // Ask only about what has not been asked about yet: the first time, or
    // when lists or tool contents have changed since the last offer. A "Not
    // now" is remembered against exactly what was on offer, so the same
    // things are never asked twice. Stored under the visitor prefix, so
    // clearing or expiring the visitor desk resets it too.
    const sigKey = `${Desk.localApi.PREFIX}:offered`;
    const signature = JSON.stringify([
      lists.map((l) => [l.id, l.name, l.students.map((p) => p.name)]),
      tools.map((t) => [t.type, t.state]),
    ]);
    try {
      if (storage.getItem(sigKey) === signature) return;
      if (sessionStorage.getItem('desk:offered-visitor-lists')) return;
      sessionStorage.setItem('desk:offered-visitor-lists', '1');
    } catch { /* ask anyway */ }

    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const names = [...new Set(tools.map((t) => Desk.widgets.get(t.type).name))];
    const body = el('div.carry-over', {}, [
      el('p', { text: 'Before you logged in, this browser kept:' }),
      el('ul', {}, [
        ...lists.map((l) => el('li', { text: `${l.name} — ${plural(l.students.length, 'pupil', 'pupils')}` })),
        tools.length ? el('li', { text: `${plural(tools.length, 'tool', 'tools')}: ${names.join(', ')}` }) : null,
      ]),
      el('p', { text: tools.length
        ? 'They are added to your account: class lists alongside yours, and tools below everything already on your desk. Nothing on your desk now is moved, changed or replaced.'
        : 'They are added alongside the class lists already in your account.' }),
      el('p.hint', { text: 'Once your account has them they are removed from this computer. If they are not yours — this is a shared computer — choose Not now.' }),
    ]);
    try { storage.setItem(sigKey, signature); } catch { /* ask again next time */ }
    if (!await Desk.ask({ title: 'Keep what you made before logging in?', body, confirmLabel: 'Add to my account', cancelLabel: 'Not now' })) return;

    // The lists first: the tools need to know the lists' new ids.
    const moved = new Map();
    for (const l of lists) {
      try {
        const made = await Desk.api.createList(l.name, l.students.map((p) => p.name));
        // The account gives every pupil a new id, in the same order as sent.
        // If the counts disagree the pairing cannot be trusted, and the
        // tools tied to this list are treated as if it had not come.
        const students = new Map();
        if (made && Array.isArray(made.students) && made.students.length === l.students.length) {
          l.students.forEach((p, i) => students.set(p.id, made.students[i].id));
        }
        moved.set(l.id, { id: made.id, students });
      } catch (e) { toast(e.message, 'warn'); break; }
    }
    if (moved.size) Desk.roster.invalidate();

    const arriving = Desk.localApi.carryOver(visitorItems, { moved, worth: holdsSomething });
    const added = Desk.board.adopt(arriving);
    const safe = added ? await Desk.board.whenSaved() : true;

    const said = [];
    if (moved.size) said.push(plural(moved.size, 'class list', 'class lists'));
    if (added) said.push(plural(added, 'tool', 'tools'));
    if (said.length) toast(`${said.join(' and ')} added to your account${added ? ' — the tools are at the bottom of your desk' : ''}.`);
    if (added < arriving.length) toast(`${plural(arriving.length - added, 'tool', 'tools')} did not fit — a desk holds forty.`, 'warn');

    // This browser's copy goes only when the account has all of it. Half a
    // move leaves the originals exactly where they were.
    if (moved.size === lists.length && safe) local.clearAll();
    else if (moved.size === lists.length) local.forgetLists();
  }

  /** Whether a tool holds something of the teacher's — its own measure of it. */
  function holdsSomething(item) {
    const def = Desk.widgets.get(item.type);
    if (!def || !def.holdsContent) return false;
    try {
      const state = JSON.parse(JSON.stringify(item.state || {}));
      def.init(state);
      return !!def.holdsContent(state);
    } catch { return false; }
  }

  // ---------- the desk without an account ----------

  /**
   * A visitor who has not signed in.
   *
   * They get the tools that hold nothing about pupils and never ask the
   * server for anything — timers, the clock, a random number, a big message,
   * the calculator, emoji and a scoreboard — working, and arranged the way
   * they leave them in this browser. The tools that need a class list are on
   * the board too, locked, so a visitor can see what signing in is for.
   */
  async function guestDesk(shell) {
    me = { name: 'Guest', can: {} };

    // Where a visitor's things are kept: this browser, if it will let us.
    // A private window or blocked storage still gets a working desk — it just
    // forgets everything when the tab closes, which is what it would do anyway.
    let storage;
    try { storage = window.localStorage; storage.setItem('desk:probe', '1'); storage.removeItem('desk:probe'); }
    catch { storage = memoryStorage(); }
    const local = Desk.localApi.make(storage);
    const expired = local.expireIfStale();
    // A made-up class of twenty, the first time this desk is opened, so the
    // randomiser, groups and seating plan have somebody to work with before a
    // visitor has typed a single name.
    const example = local.seedExample(Desk.localApi.exampleNames(20));
    // From here on, the class lists, saved groups and saved rooms that the
    // tools ask for are answered from this browser instead of the server.
    Object.assign(Desk.api, local.api);
    app.guestStore = local;
    for (const old of ['desk:guest-board', 'desk:guest-board:v2', 'desk:guest-board:v3']) {
      try { storage.removeItem(old); } catch { /* fine */ }
    }

    let saved = null;
    try { saved = JSON.parse(storage.getItem(Desk.board.GUEST_KEY) || 'null'); } catch { /* none */ }
    const data = {
      rev: 0,
      prefs: (saved && saved.prefs) || null,
      items: saved && Array.isArray(saved.items) && saved.items.length
        ? saved.items
        : guestStarter(example ? `list:${example.id}` : ''),
    };

    Desk.theme.init({ prefs: data.prefs, save: (prefs) => Desk.board.setPrefs(prefs) });
    drawChrome(shell, { guest: true });
    Desk.board.init({ root: document.getElementById('board'), data, me, guest: true, storage });
    announceNew();
    shell.append(signInPrompt());
    if (expired) toast(`Your earlier desk on this computer was cleared — nobody had opened it for ${Desk.localApi.EXPIRY_DAYS} days.`);
  }

  /** Storage that lasts as long as the tab, for browsers that allow no other. */
  function memoryStorage() {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => { m.set(k, String(v)); },
      removeItem: (k) => { m.delete(k); },
      key: (i) => [...m.keys()][i] || null,
      get length() { return m.size; },
    };
  }

  /**
   * What a visitor is told about where their things are, in full: opened
   * from the "Not saved" note in the header. Plain about all of it — this
   * computer only, this browser only, cleared after a month unopened — and
   * the one way to keep it, which is to log in.
   */
  async function guestInfo() {
    const days = Desk.localApi.EXPIRY_DAYS;
    const body = el('div.guest-info', {}, [
      el('p', { text: 'You are using the desk without logging in. Everything works, but nothing you set up is saved to an account.' }),
      el('ul', {}, [
        el('li', { text: 'Your tools, class lists, seating plans and notes are kept in this browser, on this computer only.' }),
        el('li', { text: `They are cleared if nobody opens this desk for ${days} days, or if this browser's data is cleared.` }),
        el('li', { text: 'Anyone who uses this computer can see them — worth remembering if you type in pupils’ names.' }),
      ]),
      el('p', { text: 'Log in to keep everything in your account, on any computer. Your class lists come with you.' }),
      el('button.btn.btn--small.btn--ghost.guest-forget', {
        svg: icon('trash', 14), onclick: () => forgetGuestDesk(),
      }, ' Clear this desk from this computer'),
    ]);
    const choice = await Desk.ask({ title: 'Not saved to an account', body, confirmLabel: 'Log in', cancelLabel: 'Keep going' });
    if (choice) window.location.href = config.signInUrl;
  }

  /** Wipes everything a visitor kept on this computer, after asking. */
  async function forgetGuestDesk() {
    if (!await Desk.ask({
      title: 'Clear this desk from this computer?',
      body: 'Every tool, class list, seating plan and note you set up here is removed from this browser. This cannot be undone.',
      confirmLabel: 'Clear it', danger: true,
    })) return;
    app.guestStore.clearAll();
    window.location.reload();
  }

  /**
   * The first board a visitor sees, laid out as a plain grid: every tool the
   * same width, four to a row, and every tool in a row the same height, so the
   * board reads as a set of tools rather than a pile of them.
   *
   * The ones a visitor can use come first, filling the top rows. The locked
   * ones come after, on rows of their own, so the line between "yours now"
   * and "yours with an account" is a line on the page.
   */
  const GUEST_ROWS = [
    // A line of big figures or big words and a couple of buttons each — they
    // need less height than the rest, and at the full five rows they sat in a
    // lot of empty card. The scoreboard's four teams do need the room, so it
    // sits on the second row.
    { h: 4, tools: ['timer', 'stopwatch', 'clock', 'message'] },
    { h: 5, tools: ['calculator', 'scoreboard', 'random', 'emoji'] },
    // The tools that work from a class list. A visitor makes their lists in
    // this browser, so these work too.
    { h: 5, tools: ['randomiser', 'groups', 'notes', 'seating'] },
    // The two that stay locked, on a row of their own at the bottom: the line
    // between "yours now" and "yours with an account" is a line on the page.
    { h: 5, tools: ['picture', 'soundboard'] },
  ];
  const GUEST_W = 3;

  // The tools that work from a class list, and so start on the example one.
  const CLASS_TOOLS = new Set(['randomiser', 'groups', 'seating', 'jobs']);

  function guestStarter(exampleKey = '') {
    const items = [];
    let y = 0;
    for (const row of GUEST_ROWS) {
      const tools = row.tools.filter((type) => Desk.widgets.get(type));
      tools.forEach((type, i) => {
        const def = Desk.widgets.get(type);
        // Never smaller than the tool can be drawn at, whatever the grid says.
        const w = Math.max(GUEST_W, def.min.w);
        const h = Math.max(row.h, def.min.h);
        const state = exampleKey && CLASS_TOOLS.has(type) ? { classKey: exampleKey } : {};
        items.push({ id: `g_${type}`, type, state, x: i * GUEST_W, y, w, h });
      });
      if (tools.length) y += Math.max(row.h, ...tools.map((t) => Desk.widgets.get(t).min.h));
    }
    return items;
  }

  /**
   * The way in: a card in the middle of the screen over a dimmed page, so a
   * teacher whose sign-in has timed out cannot miss it. "Keep going without
   * logging in" folds it down to a small button for visitors who want the
   * account-free tools; it comes back on the next load.
   */
  function signInPrompt() {
    const href = config.signInUrl;
    const gate = el('div.guest-gate', {}, [
      el('aside.guest-prompt', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Log in' }, [
        el('div.guest-prompt-text', {}, [
          el('strong', { text: 'You’re not logged in.' }),
          el('span', { text: `Log in to get your desk and class lists back. Anything you set up without logging in stays in this browser only, and is cleared after ${Desk.localApi.EXPIRY_DAYS} days unused.` }),
        ]),
        el('a.btn.btn--primary.guest-prompt-btn', { href }, 'Log in'),
        el('button.btn.btn--ghost.guest-prompt-skip', {
          type: 'button', onclick: () => gate.classList.add('is-folded'),
        }, 'Keep going without logging in'),
      ]),
      el('a.btn.btn--primary.guest-prompt-mini', { href }, 'Log in'),
    ]);
    return gate;
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
        // The same three shapes as the board's own mark: the sign-in screen is
        // the first thing a teacher sees, and it should be the same app.
        el('div.brand.brand--big', {}, [
          el('span.brand-mark', {}, [
            el('span.shape', { 'data-shape': 'circle', style: { '--role': 'var(--p1)' } }),
            el('span.shape', { 'data-shape': 'square', style: { '--role': 'var(--p2)' } }),
            el('span.shape', { 'data-shape': 'triangle', style: { '--role': 'var(--p3)' } }),
          ]),
          el('span.brand-word', { text: 'Teacher’s Desk' }),
        ]),
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

  function drawChrome(shell, { guest = false } = {}) {
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
        // A visitor's class lists live in this browser, and the button is the
        // same one — so is the dialog behind it.
        listsBtn,
        // Always in view for a visitor: a quiet, honest note that nothing
        // here is saved to an account, which opens the whole story.
        guest ? el('button.btn.guest-pill', {
          title: 'Kept on this computer only — find out more',
          onclick: () => guestInfo(),
        }, [el('span', { svg: icon('info', 15) }), el('span.guest-pill-label', { text: 'Not saved' })]) : null,
        muteBtn,
        el('button.btn.btn--primary.add-btn', { svg: icon('plus', 16), onclick: openCatalogue }, ' Add a tool'),
        guest ? null : el('div.user', {}, [userBtn, menu]),
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
      // It eases down into the header when a tool starts saying something,
      // rather than blinking into being.
      if (island.hidden) {
        island.classList.remove('is-arriving');
        void island.offsetWidth;
        island.classList.add('is-arriving');
      }
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
       choosing one hides the cards that are not that family and gathers the
       rest at the top of the desk, in the order they sit on it. The layout
       underneath is untouched and comes back with "All tools". Nothing is
       saved — a filter is for the next minute, not for the next term. */
    const filters = el('nav.filters', { 'aria-label': 'Show one kind of tool' });
    let showing = 'all';

    function paintFilters() {
      const pick = (key) => () => {
        showing = key;
        paintFilters();
        applyFilter();
        // The family has just gathered at the top; a teacher scrolled halfway
        // down the desk would otherwise be looking at the empty space below it.
        if (key !== 'all') window.scrollTo({ top: 0, behavior: Desk.board.calm() ? 'auto' : 'smooth' });
      };
      // Plain 'button': the class comes from `class` alone. el() adds that to
      // any classes in the spec, so a spec of 'button.filter.is-on' left
      // "All tools" lit whichever chip was chosen.
      const chips = [el('button', {
        class: showing === 'all' ? 'filter is-on' : 'filter',
        'aria-pressed': String(showing === 'all'), onclick: pick('all'),
      }, el('span', { text: 'All tools' }))];
      for (const c of Desk.widgets.CATEGORIES) {
        if (c.key === 'other') continue;
        chips.push(el('button', {
          class: showing === c.key ? 'filter is-on' : 'filter',
          'aria-pressed': String(showing === c.key), onclick: pick(c.key),
        }, [Desk.widgets.marker(c.key, 12), el('span', { text: c.name })]));
      }
      filters.replaceChildren(...chips);
    }

    function applyFilter() {
      const appearing = [];
      // The cards that stay glide to where the filter puts them; the ones
      // coming back fade up into their places, so choosing a family reads as
      // the board rearranging itself rather than as a page being redrawn.
      Desk.board.glide(() => {
        document.getElementById('board')?.classList.toggle('is-filtered', showing !== 'all');
        for (const card of document.querySelectorAll('.card')) {
          const def = Desk.widgets.get(card.dataset.type);
          const mine = showing === 'all' || (def && def.category === showing);
          if (mine && card.classList.contains('is-filtered-out')) appearing.push(card);
          card.classList.toggle('is-filtered-out', !mine);
        }
      });
      const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (still) return;
      appearing.forEach((card, i) => card.animate(
        [{ opacity: 0, transform: 'scale(.94)' }, { opacity: 1, transform: 'scale(1)' }],
        { duration: 260, delay: Math.min(i, 8) * 30, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'backwards' },
      ));
    }

    paintFilters();
    document.addEventListener('desk:rendered', applyFilter);

    shell.replaceChildren(bar, filters, el('main#board.board', { 'aria-label': 'Your desk' }));
    // The board decides its own column count from its width, in render().
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

    const guest = Desk.board.isGuest();

    // Which tools to list: all of them, or only the ones not on the desk yet.
    // Remembered on this computer, like the sound setting.
    let view = 'all';
    try { if (window.localStorage.getItem(CAT_VIEW_KEY) === 'missing') view = 'missing'; } catch { /* default */ }
    const missingCount = Desk.widgets.available(me).filter((d) => !onDesk.has(d.type)).length;
    const viewBtn = (key, label) => el(`button.seg-btn${view === key ? '.is-on' : ''}`, {
      type: 'button',
      'aria-pressed': String(view === key),
      'data-view': key,
      onclick: () => {
        view = key;
        try { window.localStorage.setItem(CAT_VIEW_KEY, key); } catch { /* not kept */ }
        for (const b of views.children) {
          b.classList.toggle('is-on', b.dataset.view === key);
          b.setAttribute('aria-pressed', String(b.dataset.view === key));
        }
        draw(search.value);
      },
    }, label);
    const views = el('div.seg.cat-views', { role: 'group', 'aria-label': 'Which tools to show' }, [
      viewBtn('all', 'All tools'),
      viewBtn('missing', `Not on my desk (${missingCount})`),
    ]);

    /** One row in the catalogue. */
    function row(def) {
      const already = onDesk.get(def.type) || 0;
      // A visitor sees every tool, because the list is the best description
      // of what an account is for — but the locked ones lead to signing in
      // rather than onto the board.
      if (guest && !def.guest) {
        return el('a.cat-item.is-locked', { href: config.signInUrl, title: `${def.name} needs a school account` }, [
          el('span.cat-icon', { svg: icon(def.icon, 22) }),
          el('span.cat-text', {}, [
            el('span.cat-name', {}, [
              document.createTextNode(def.name),
              Desk.widgets.isNew(def) ? el('span.tag.tag--new', { text: 'New' }) : null,
              el('span.tag.tag--quiet', { text: 'Log in to use' }),
            ]),
            el('span.cat-blurb', { text: def.blurb }),
          ]),
          el('span.cat-plus', { svg: icon('lock', 18) }),
        ]);
      }
      return el('button.cat-item', {
        onclick: () => { Desk.board.addItem(def.type); close(); },
      }, [
        el('span.cat-icon', { svg: icon(def.icon, 22) }),
        el('span.cat-text', {}, [
          el('span.cat-name', {}, [
            document.createTextNode(def.name),
            Desk.widgets.isNew(def) ? el('span.tag.tag--new', { text: 'New' }) : null,
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

      const skip = view === 'missing' ? new Set(onDesk.keys()) : null;
      const drawers = Desk.widgets.byCategory(me, term, { skip });
      const found = drawers.reduce((n, d) => n + d.widgets.length, 0);

      if (!found && skip && !term.trim()) {
        list.append(el('p.hint.cat-empty', { text: 'Every tool is already on your desk.' }));
        count.textContent = '';
        return;
      }
      if (!found && skip) {
        list.append(el('p.hint.cat-empty', { text: `Nothing that isn’t already on your desk matches “${term}”.` }));
        count.textContent = '';
        return;
      }
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
            if (!firstMatch && !(guest && !def.guest)) firstMatch = def;
            list.append(row(def));
          }
        }
        return;
      }

      count.textContent = '';
      for (const drawer of drawers) {
        list.append(el('div.cat-head', {}, [
          Desk.widgets.marker(drawer.key, 12),
          el('h3.cat-head-name', { text: drawer.name }),
          el('span.cat-head-blurb', { text: drawer.blurb }),
        ]));
        for (const def of drawer.widgets) {
          if (!firstMatch && !(guest && !def.guest)) firstMatch = def;
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
        views,
        count,
        list,
        el('div.dialog-actions', {}, [el('button.btn', { text: 'Close', onclick: () => close() })]),
      ]),
    ]);
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    function close() { scrim.remove(); document.removeEventListener('keydown', onKey); }
    document.addEventListener('keydown', onKey);
    dismissNews();
    document.body.append(scrim);
    // Straight into the search box on a keyboard, but not on a touch screen,
    // where it would throw a keyboard over the list somebody wants to browse.
    if (!window.matchMedia('(pointer: coarse)').matches) search.focus();
  }

  // ---------- telling a teacher about a new tool ----------

  const CAT_VIEW_KEY = 'desk:catalogue-view';
  const SEEN_KEY = 'desk:seen-new';
  let newsNote = null;

  function seenNews() {
    try { return new Set(JSON.parse(window.localStorage.getItem(SEEN_KEY) || '[]')); } catch { return new Set(); }
  }
  function markSeen(types) {
    const seen = seenNews();
    for (const t of types) seen.add(t);
    try { window.localStorage.setItem(SEEN_KEY, JSON.stringify([...seen])); } catch { /* shown again next time */ }
  }

  /**
   * A small note under "Add a tool" when a tool has gone live that this
   * teacher has not been told about: a picture and one line. Never a dialog —
   * it must not get between a teacher and a lesson that has already started —
   * and each tool is announced once per computer. Opening the catalogue counts
   * as having seen it, since that is where the note was pointing anyway.
   */
  function announceNew() {
    const onDesk = new Set(Desk.board.items().map((i) => i.type));
    const guest = Desk.board.isGuest();
    const fresh = Desk.widgets.announce(me, { seen: seenNews(), onDesk, usable: (d) => !guest || d.guest });
    if (!fresh.length) return;

    // Let the desk settle, and stay out of the way of anything already asking
    // a question (the offer to bring a visitor's desk over, for one).
    setTimeout(() => {
      if (document.querySelector('.scrim') || newsNote) return;
      const anchor = document.querySelector('.add-btn');
      if (!anchor) return;
      showNews(fresh, anchor);
    }, 1200);
  }

  function showNews(fresh, anchor) {
    let at = 0;
    const pic = el('img.news-shot', { alt: '', loading: 'lazy' });
    const name = el('strong.news-name');
    const line = el('p.news-line');
    const pager = el('span.news-pager');
    const nextBtn = el('button.btn.btn--small', { type: 'button', text: 'Next', onclick: () => { at += 1; paint(); } });
    const addBtn = el('button.btn.btn--small.btn--primary', {
      type: 'button',
      onclick: () => {
        const def = fresh[at];
        Desk.board.addItem(def.type);
        markSeen([def.type]);
        fresh.splice(at, 1);
        if (!fresh.length) return dismissNews();
        if (at >= fresh.length) at = 0;
        paint();
      },
    });

    function paint() {
      const def = fresh[at];
      pic.hidden = false;
      pic.onerror = () => { pic.hidden = true; };   // a missing picture is not worth a broken icon
      pic.src = `/img/new/${def.type}.png`;
      name.textContent = def.name;
      line.textContent = def.news;
      addBtn.textContent = 'Add it';
      pager.textContent = fresh.length > 1 ? `${at + 1} of ${fresh.length}` : '';
      nextBtn.hidden = at >= fresh.length - 1;
    }

    newsNote = el('aside.news', { role: 'status', 'aria-label': 'New on the desk' }, [
      el('div.news-head', {}, [
        el('span.tag.tag--new', { text: 'New tool' }),
        pager,
        el('button.news-close', {
          type: 'button', 'aria-label': 'Dismiss', title: 'Dismiss', svg: icon('close', 16),
          onclick: () => dismissNews(),
        }),
      ]),
      pic,
      name,
      line,
      el('div.news-actions', {}, [nextBtn, addBtn]),
    ]);
    // Everything it could have shown counts as seen once it is put away, so
    // a teacher who says "not now" is not asked again tomorrow.
    newsNote.dataset.types = fresh.map((d) => d.type).join(' ');
    paint();
    document.body.append(newsNote);

    const place = () => {
      if (!newsNote) return;
      const r = anchor.getBoundingClientRect();
      newsNote.style.top = `${Math.round(r.bottom + 10)}px`;
      newsNote.style.right = `${Math.max(12, Math.round(window.innerWidth - r.right))}px`;
      newsNote.style.setProperty('--tail-right', `${Math.round(r.width / 2)}px`);
    };
    place();
    window.addEventListener('resize', place);
    newsNote._unplace = () => window.removeEventListener('resize', place);
  }

  function dismissNews() {
    if (!newsNote) return;
    markSeen((newsNote.dataset.types || '').split(' ').filter(Boolean));
    newsNote._unplace();
    newsNote.remove();
    newsNote = null;
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
