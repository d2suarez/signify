// ===================================================================
// Teacher's Desk — the board
//
// A twelve-column grid of cards. Each card is one widget; drag its header to
// move it, drag the corner to resize it, and anything in the way slides down
// and then settles back up. Positions are saved per teacher.
//
// Below about 820px there is not enough width for twelve columns to mean
// anything, so the board stacks into a single column and rearranging is
// switched off — deliberately, because the alternative is a teacher on an
// iPad quietly flattening the layout they set up on their laptop.
// ===================================================================

window.Desk = window.Desk || {};

(function (Desk) {
  'use strict';

  const { el, icon, clamp, toast } = Desk;

  const COLUMNS = 12;
  const STACK_BELOW = 520;

  /* How many columns the board has, decided by the board's own width rather
     than the window's — the same desk in a narrower app is a narrower desk.
     Twelve is the layout the teacher arranged; eight and four are packings of
     it. */
  const WIDE_AT = 1280;
  const MEDIUM_AT = 880;
  function columnsFor(width) {
    if (width >= WIDE_AT) return 12;
    if (width >= MEDIUM_AT) return 8;
    return 4;
  }

  const board = {
    rev: 0,
    items: [],
    prefs: null,
    me: null,
    root: null,
    instances: new Map(),      // item.id -> { def, item, api, node }
    stage: null,
    // A visitor who has not signed in. Their board lives in this browser
    // only and never reaches the server — there is no account to keep it in.
    guest: false,
  };

  // Versioned: a visitor who has only ever seen the first, jumbled guest
  // layout starts again on the tidy one rather than keeping the jumble.
  const GUEST_KEY = 'desk:guest-board:v4';

  /** Whether this tool is locked for whoever is looking. */
  const locked = (def) => board.guest && def && !def.guest;

  // ---------- geometry ----------

  const hits = (a, b) => !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
  const earlier = (a, b) => (a.y !== b.y ? a.y < b.y : a.x < b.x);

  /**
   * Pushes overlapping cards downwards until nothing overlaps. `pinned` (the
   * one under the cursor) never moves — everything gives way to it instead.
   */
  function resolve(items, pinned) {
    for (let pass = 0; pass < items.length * 6 + 8; pass += 1) {
      let moved = false;
      for (const a of items) {
        for (const b of items) {
          if (a === b || !hits(a, b)) continue;
          // Decide which of the pair yields.
          let loser;
          if (a === pinned) loser = b;
          else if (b === pinned) loser = a;
          else loser = earlier(a, b) ? b : a;
          const winner = loser === a ? b : a;
          loser.y = winner.y + winner.h;
          moved = true;
        }
      }
      if (!moved) return;
    }
  }

  /** Lets every card fall as far up as it can, so deleting one closes the gap. */
  function compact(items, skip) {
    const order = items.slice().sort((a, b) => a.y - b.y || a.x - b.x);
    for (const it of order) {
      if (it === skip) continue;
      while (it.y > 0) {
        const probe = { x: it.x, y: it.y - 1, w: it.w, h: it.h };
        if (order.some((o) => o !== it && hits(o, probe))) break;
        it.y -= 1;
      }
    }
  }

  /** The first place a new card of this size fits. */
  function findSpot(items, w, h) {
    for (let y = 0; y < 400; y += 1) {
      for (let x = 0; x + w <= COLUMNS; x += 1) {
        const probe = { x, y, w, h };
        if (!items.some((o) => hits(o, probe))) return { x, y };
      }
    }
    return { x: 0, y: 0 };
  }

  const stacked = () => window.innerWidth < STACK_BELOW;
  /* Cards only stay where they were put while all twelve columns are there. */
  const packing = () => !stacked() && board.root && columnsFor(board.root.clientWidth) < COLUMNS;

  // ---------- saving ----------

  let dirty = false;
  let saving = false;

  const flush = Desk.debounce(async () => {
    if (!dirty) return;
    if (board.guest) {
      // Kept in the browser, on this machine only. If it cannot be kept —
      // a private window, storage switched off — the board still works for
      // as long as the tab is open, which is all a visitor was promised.
      dirty = false;
      try { (board.storage || localStorage).setItem(GUEST_KEY, JSON.stringify({ items: board.items, prefs: board.prefs })); } catch { /* not kept */ }
      return;
    }
    // Never two saves at once. The second would still be carrying the
    // revision the first is about to move on from, and would come back as a
    // conflict with itself — on a slow connection that would look to the
    // teacher like their desk being reloaded at random.
    if (saving) { flush(); return; }

    saving = true;
    dirty = false;
    try {
      const res = await Desk.api.saveBoard({ rev: board.rev, items: board.items, prefs: board.prefs || undefined });
      board.rev = res.rev;
    } catch (e) {
      if (e.status === 409) {
        toast('This desk was changed in another tab. Reloading it.', 'warn');
        setTimeout(() => window.location.reload(), 1200);
        return;
      }
      dirty = true;                      // try again on the next change
      toast(e.message, 'warn');
    } finally {
      saving = false;
      if (dirty) flush();
    }
  }, 700);

  function markDirty() { dirty = true; flush(); }

  window.addEventListener('pagehide', () => {
    if (!dirty || board.guest) return;
    // A beacon survives the page going away; a fetch does not.
    navigator.sendBeacon?.('/api/board', new Blob(
      [JSON.stringify({ rev: board.rev, items: board.items, prefs: board.prefs || undefined })], { type: 'application/json' }));
  });

  // ---------- widget lifecycle ----------

  function mountInstance(item, node) {
    const def = Desk.widgets.get(item.type);
    const body = node.querySelector('.card-body');
    if (!def) {
      body.append(el('div.empty', {}, [
        el('p', { text: `This desk has a “${item.type}” widget, which this version does not know about.` }),
        el('button.btn.btn--small', { text: 'Remove it', onclick: () => removeItem(item.id, true) }),
      ]));
      return;
    }
    if (locked(def)) {
      // Not mounted at all. A locked tool would ask the server for class
      // lists and saved plans it has no account to ask for, so what a visitor
      // sees is a picture of the tool, blurred, with the way in on top of it.
      body.append(lockedPreview(def));
      board.instances.set(item.id, { def, item, api: {}, node });
      return;
    }
    def.init(item.state);
    const api = def.mount({
      root: body,
      state: item.state,
      item,
      expanded: false,
      me: board.me,
      guest: board.guest,
      save: markDirty,
      expand: () => openStage(item.id),
    }) || {};
    board.instances.set(item.id, { def, item, api, node });
  }

  /**
   * What a locked tool looks like to a visitor: the shape of an interface —
   * a picker, a few rows, a button — in the tool's own colour, blurred, under
   * one line saying how to get it. Not the real tool drawn and then hidden:
   * the real tool would go looking for a class list.
   */
  function lockedPreview(def) {
    const lines = [];
    lines.push(el('span.ghost-bar.ghost-bar--pick'));
    for (let i = 0; i < 4; i += 1) lines.push(el('span.ghost-bar', { style: { '--len': `${55 + ((i * 29) % 40)}%` } }));
    lines.push(el('span.ghost-bar.ghost-bar--button'));
    return el('div.locked', {}, [
      el('div.locked-ghost', { 'aria-hidden': 'true' }, lines),
      el('div.locked-over', {}, [
        el('span.locked-icon', { svg: icon('lock', 18) }),
        el('a.btn.btn--primary.btn--small.locked-cta', {
          href: (Desk.config && Desk.config.signInUrl) || '/auth/login',
          title: `${def.name} needs a school account`,
        }, 'Log in to use'),
      ]),
    ]);
  }

  function unmountInstance(id) {
    const inst = board.instances.get(id);
    if (!inst) return;
    try { inst.api.destroy && inst.api.destroy(); } catch (e) { console.error(e); }
    board.instances.delete(id);
  }

  // ---------- drawing ----------

  function cardFor(item) {
    const def = Desk.widgets.get(item.type);
    const node = el('section.card', {
      'data-id': item.id, 'data-type': item.type,
      // The category decides the colour and the shape; the tone decides
      // whether that colour fills the card or just marks it. Both are written
      // here so the stylesheet can do the rest without a line of JavaScript.
      'data-category': def ? def.category : 'other',
      'data-role': def && def.role ? def.role : '',
      'data-tone': def ? def.tone : 'card',
      // A card is only as tall as what is in it, unless the widget says it
      // needs the room. That is the difference between a board of tools and a
      // board of boxes with a tool floating in the middle of each.
      class: def && def.fills ? 'is-fluid' : '',
    });
    node.style.setProperty('--x', item.x);
    node.style.setProperty('--y', item.y);
    node.style.setProperty('--w', item.w);
    node.style.setProperty('--h', item.h);

    const head = el('header.card-head', {}, [
      el('span.card-grip', { svg: icon('drag', 16), title: 'Drag to move' }),
      // The shape says which family the tool belongs to. It replaces the
      // per-tool icon: thirty different icons taught nothing, four shapes do.
      Desk.widgets.marker(def ? def.category : 'other'),
      el('h2.card-title', { text: def ? def.name : item.type }),
      el('div.card-actions', {}, [
        el('button.icon-btn', { title: 'Open larger', 'aria-label': 'Open larger', svg: icon('expand', 16), onclick: () => openStage(item.id) }),
        el('button.icon-btn.icon-btn--danger', { title: 'Remove from the desk', 'aria-label': 'Remove from the desk', svg: icon('close', 16), onclick: () => removeItem(item.id) }),
      ]),
    ]);

    node.append(head, el('div.card-body'), el('div.card-resize', { title: 'Drag to resize' }));
    head.addEventListener('pointerdown', (e) => startDrag(e, item, node, 'move'));
    node.querySelector('.card-resize').addEventListener('pointerdown', (e) => startDrag(e, item, node, 'resize'));
    return node;
  }

  function render() {
    const root = board.root;
    document.body.classList.toggle('is-stacked', stacked());
    const cols = stacked() ? 1 : columnsFor(root.clientWidth);
    root.dataset.cols = String(cols);
    root.style.setProperty('--cols', String(cols));

    const order = board.items.slice().sort((a, b) => a.y - b.y || a.x - b.x);
    const present = new Set(order.map((i) => i.id));

    for (const id of [...board.instances.keys()]) {
      if (!present.has(id)) { unmountInstance(id); root.querySelector(`[data-id="${CSS.escape(id)}"]`)?.remove(); }
    }

    for (const item of order) {
      let inst = board.instances.get(item.id);
      if (!inst) {
        const node = cardFor(item);
        root.append(node);
        mountInstance(item, node);
        inst = board.instances.get(item.id);
        if (!inst) board.instances.set(item.id, { def: null, item, api: {}, node });
      } else {
        position(inst.node, item);
      }
      // Stacked mode reads the DOM order, so keep it matching the layout.
      root.append(board.instances.get(item.id).node);
    }

    root.querySelector('.board-empty')?.remove();
    if (!board.items.length) {
      root.append(el('div.board-empty', {}, [
        el('p', { text: 'Your desk is empty.' }),
        el('button.btn.btn--primary', { text: 'Add a tool', onclick: () => Desk.app.openCatalogue() }),
      ]));
    }

    // Said once, here, so anything that decorates cards — the filter chips,
    // for one — can catch the ones that have only just been created.
    document.dispatchEvent(new CustomEvent('desk:rendered'));
  }

  function position(node, item) {
    node.style.setProperty('--x', item.x);
    node.style.setProperty('--y', item.y);
    node.style.setProperty('--w', item.w);
    node.style.setProperty('--h', item.h);
  }

  // ---------- motion ----------

  /** Somebody who has asked their computer for less movement gets none. */
  const calm = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const EASE = 'cubic-bezier(.2,.7,.2,1)';

  /**
   * Makes a change to the board and lets every card that moved GLIDE to its
   * new place instead of jumping there.
   *
   * The grid puts a card in its new cell instantly; there is nothing to
   * transition. So each card's position is noted before the change, and after
   * it the card is drawn back where it was and let go — the browser eases it
   * home. Only the position moves: a card that changed size simply is its new
   * size, because stretching its contents on the way would look broken.
   *
   * `skip` is the card in the teacher's hand, which follows the pointer and
   * must not be pulled about by anything else.
   */
  function glide(change, { skip = null, duration = 260 } = {}) {
    if (calm() || !board.root) { change(); return; }
    const before = new Map();
    for (const node of board.root.querySelectorAll('.card')) {
      if (node !== skip && node.offsetParent) before.set(node, node.getBoundingClientRect());
    }
    change();
    for (const [node, was] of before) {
      if (!node.isConnected || !node.offsetParent) continue;
      const now = node.getBoundingClientRect();
      const dx = was.left - now.left;
      const dy = was.top - now.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      node.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
        { duration, easing: EASE },
      );
    }
  }

  /**
   * The big view grows out of the card it belongs to, and shrinks back into
   * it — so opening a tool reads as the same tool coming closer, not as a
   * new page replacing the board. The screen is drawn at the card's size and
   * place and eased out to fill the window; its contents fade in once it is
   * most of the way there, because text stretched mid-flight looks broken.
   */
  function stageMotion(stage, card, direction) {
    if (calm() || !card || !card.isConnected) return Promise.resolve();
    const from = card.getBoundingClientRect();
    const to = stage.getBoundingClientRect();
    if (!from.width || !to.width) return Promise.resolve();
    const small = {
      transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`,
      borderRadius: '14px',
    };
    const big = { transform: 'translate(0, 0) scale(1, 1)', borderRadius: '0px' };
    stage.style.transformOrigin = '0 0';
    const opening = direction === 'open';
    const duration = opening ? 340 : 260;
    const run = stage.animate(opening ? [small, big] : [big, small], {
      duration, easing: EASE, fill: opening ? 'none' : 'forwards',
    });
    const fade = opening
      ? [{ opacity: 0 }, { opacity: 0, offset: 0.4 }, { opacity: 1 }]
      : [{ opacity: 1 }, { opacity: 0, offset: 0.5 }, { opacity: 0 }];
    for (const part of stage.querySelectorAll(':scope > .stage-head, :scope > .stage-body')) {
      part.animate(fade, { duration, fill: opening ? 'none' : 'forwards' });
    }
    // Animations are paused in a background tab, and a paused one never
    // finishes — which would leave the big view on screen for ever, waiting.
    // So the wait is capped at a little longer than the animation itself.
    return Promise.race([run.finished.catch(() => {}), new Promise((done) => setTimeout(done, duration + 120))]);
  }

  function repositionAll() {
    for (const { item, node } of board.instances.values()) position(node, item);
  }

  // ---------- dragging and resizing ----------

  function startDrag(event, item, node, mode) {
    if (stacked()) return;
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    if (mode === 'move' && event.target.closest('button')) return;

    const def = Desk.widgets.get(item.type) || { min: { w: 2, h: 3 } };
    const rect = board.root.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(board.root).gap) || 14;
    const rowH = parseFloat(getComputedStyle(board.root).getPropertyValue('--row')) || 54;
    const colW = (rect.width - gap * (COLUMNS - 1)) / COLUMNS;
    const pitchX = colW + gap;
    const pitchY = rowH + gap;

    const start = { x: event.clientX, y: event.clientY, ix: item.x, iy: item.y, iw: item.w, ih: item.h };
    const before = board.items.map((i) => ({ ...i }));
    /* Where everything else was when the drag began. Each update puts the
       other cards BACK here before working out who is in the way, so being
       shoved aside is never cumulative: carry a card across four columns and
       the ones it passes step aside and then step back, instead of being
       pushed down the board again on every frame. That accumulation is what
       sent a card to the bottom of the desk when it was only passed over. */
    const origin = new Map(board.items.map((i) => [i.id, { x: i.x, y: i.y }]));

    /* Lays the board out again around the card in hand.
       
       Every other card starts from where it was when the drag began and is
       placed in that same order, sliding down only as far as it must to clear
       what is already down. Two things follow, and both are the difference
       between a board that helps and one that panics:
       
       nothing accumulates — a card passed over twice is not pushed twice, it
       is placed once from its original home; and the order holds — the card
       that was at the top of a column is still the card at the top of that
       column, instead of being sent to the bottom of the desk because two
       cards momentarily tied for the same row. */
    const relayout = () => {
      const others = board.items.filter((i) => i !== item);
      others.sort((a, b) => {
        const oa = origin.get(a.id) || a;
        const ob = origin.get(b.id) || b;
        return oa.y - ob.y || oa.x - ob.x;
      });

      const placed = [item];
      for (const other of others) {
        const o = origin.get(other.id) || { x: other.x, y: other.y };
        other.x = o.x;
        other.y = o.y;
        // Straight down until it is clear. A card only ever gives way
        // downwards, so the shape of the board a teacher built is kept.
        while (placed.some((p) => hits(p, other))) other.y += 1;
        placed.push(other);
      }

      // The cards being moved aside step out of the way rather than jump.
      glide(() => { repositionAll(); position(node, item); }, { skip: node });
    };

    node.classList.add(mode === 'move' ? 'is-dragging' : 'is-resizing');
    document.body.classList.add('is-arranging');
    node.setPointerCapture(event.pointerId);
    event.preventDefault();

    /* Moving a card used to rearrange the board on every pixel: the moment
       the cursor crossed a column the neighbours leapt, and crossing three
       columns quickly threw them across the desk. Two rules calm it down.

       One: a new position has to be MEANT. The card follows the cursor
       immediately — that is the teacher's own hand — but the rest of the
       board does not answer until the cursor has settled on a cell for a
       moment.

       Two: when the board does answer, it moves a single column and a single
       row at a time. Drag a card four columns across and its neighbours walk
       aside one step at a time rather than teleporting. */
    const SETTLE_MS = 160;
    let want = { x: start.ix, y: start.iy };
    let wantAt = 0;
    let pointer = { dx: 0, dy: 0 };
    let ticking = 0;

    const drawGhost = () => {
      // Measured from where the card has actually landed, so it sits under
      // the cursor however far behind the committed position has fallen.
      node.style.setProperty('--drag-x', `${pointer.dx - (item.x - start.ix) * pitchX}px`);
      node.style.setProperty('--drag-y', `${pointer.dy - (item.y - start.iy) * pitchY}px`);
    };

    const stepTowards = () => {
      const towards = (from, to) => (to === from ? from : from + Math.sign(to - from));
      const nx = towards(item.x, want.x);
      const ny = towards(item.y, want.y);
      if (nx === item.x && ny === item.y) return false;
      item.x = nx;
      item.y = ny;
      relayout();
      return true;
    };

    const tick = () => {
      ticking = requestAnimationFrame(tick);
      if (mode !== 'move') return;
      if (performance.now() - wantAt < SETTLE_MS) return;
      if (stepTowards()) { wantAt = performance.now(); drawGhost(); }
    };
    ticking = requestAnimationFrame(tick);

    const onMove = (e) => {
      pointer = { dx: e.clientX - start.x, dy: e.clientY - start.y };

      if (mode === 'move') {
        const x = clamp(start.ix + Math.round(pointer.dx / pitchX), 0, COLUMNS - item.w);
        const y = Math.max(0, start.iy + Math.round(pointer.dy / pitchY));
        if (x !== want.x || y !== want.y) { want = { x, y }; wantAt = performance.now(); }
        drawGhost();
        return;
      }

      // Resizing is the teacher sizing their own card, so it answers at once.
      item.w = clamp(start.iw + Math.round(pointer.dx / pitchX), def.min.w, COLUMNS - item.x);
      item.h = Math.max(def.min.h, start.ih + Math.round(pointer.dy / pitchY));
      relayout();
    };

    const onUp = () => {
      cancelAnimationFrame(ticking);
      // Wherever the cursor was let go is where the card belongs, however far
      // the one-step-at-a-time walk had got to.
      if (mode === 'move') { item.x = want.x; item.y = want.y; relayout(); }
      node.releasePointerCapture(event.pointerId);
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerup', onUp);
      node.removeEventListener('pointercancel', onUp);
      node.classList.remove('is-dragging', 'is-resizing');
      document.body.classList.remove('is-arranging');
      node.style.removeProperty('--drag-x');
      node.style.removeProperty('--drag-y');

      compact(board.items);
      repositionAll();

      const changed = board.items.some((i, n) => {
        const was = before.find((b) => b.id === i.id) || {};
        return was.x !== i.x || was.y !== i.y || was.w !== i.w || was.h !== i.h;
      });
      if (changed) markDirty();
    };

    node.addEventListener('pointermove', onMove);
    node.addEventListener('pointerup', onUp);
    node.addEventListener('pointercancel', onUp);
  }

  // ---------- adding and removing ----------

  /**
   * How many grid rows a card actually needs, from what is in it.
   *
   * A card that hugs its content has already collapsed to its natural height
   * by the time this runs, so the measurement is simply what it is on screen.
   * The arithmetic is the grid's own: n rows stand `n * row + (n - 1) * gap`
   * tall, so the number of rows is that, solved for n and rounded up.
   *
   * Returns null for a card that fills — there is nothing to measure, because
   * its height is whatever it was given.
   */
  function rowsNeeded(item) {
    const inst = board.instances.get(item.id);
    const def = Desk.widgets.get(item.type);
    if (!inst || !inst.node || (def && def.fills)) return null;

    const style = getComputedStyle(board.root);
    const row = parseFloat(style.getPropertyValue('--row')) || 54;
    const gap = parseFloat(style.gap) || 14;

    // The CONTENT's height, not the card's. The card is capped at its slot so
    // that it can never draw over its neighbour, which means measuring the
    // card itself can only ever report "it fits" — it would never notice a
    // widget that had outgrown its slot and was quietly scrolling inside.
    const head = inst.node.querySelector('.card-head');
    const body = inst.node.querySelector('.card-body');
    if (!body) return null;
    // The card's own padding counts: it is the difference between a tool that
    // fits and one that scrolls inside a card that believes it fits.
    const box = getComputedStyle(inst.node);
    const pad = parseFloat(box.paddingTop) + parseFloat(box.paddingBottom);
    const height = (head ? head.offsetHeight : 0) + body.scrollHeight + pad + 2;
    if (height < 4) return null;

    const n = Math.ceil((height + gap) / (row + gap));
    return clamp(n, def ? def.min.h : 2, 40);
  }

  /**
   * Fits every card to the height it actually needs, then lets the board fall
   * together.
   *
   * Both ways. Shrinking is the point — a tool should not sit in the middle of
   * a box of air — but a card whose content has outgrown its slot is scrolling
   * inside itself, which is worse, so this grows those too. Growth is capped
   * so that a behaviour tracker with thirty names on it does not take the
   * whole desk.
   */
  const TIDY_MAX_ROWS = 12;

  function tidy() {
    if (stacked()) return 0;
    let changed = 0;
    for (const item of board.items) {
      const need = rowsNeeded(item);
      if (need == null || need === item.h) continue;
      item.h = need > item.h ? Math.min(need, Math.max(item.h, TIDY_MAX_ROWS)) : need;
      changed += 1;
    }
    if (!changed) return 0;
    resolve(board.items, null);
    compact(board.items);
    glide(() => render());
    markDirty();
    return changed;
  }

  /**
   * A card keeps the size it was given. It is set once, when the tool is
   * first put down, and after that only the teacher changes it — by dragging
   * the corner, or by asking the desk to tidy.
   *
   * It is tempting to have cards follow their contents, and an earlier
   * version did. But a randomiser that picks a name with a descender, or a
   * list that gains a row, would resize itself mid-lesson and shove its
   * neighbours down the board. A tool that reflows while you are looking at
   * it is worse than a tool that is slightly the wrong size, so what the
   * contents do inside the card is the widget's business: the display sizes
   * are measured against the card, which is why they fit it.
   */
  function sizeOnce(item) {
    const need = rowsNeeded(item);
    if (need == null || need === item.h) return false;
    item.h = Math.min(need, Math.max(item.h, TIDY_MAX_ROWS));
    return true;
  }

  function addItem(type) {
    const def = Desk.widgets.get(type);
    if (!def) return;
    const w = clamp(def.size.w, def.min.w, COLUMNS);
    const h = Math.max(def.size.h, def.min.h);
    const spot = findSpot(board.items, w, h);
    const item = { id: `w_${Math.random().toString(36).slice(2, 11)}`, type, state: {}, w, h, ...spot };
    board.items.push(item);
    glide(() => render());
    markDirty();
    const node = board.instances.get(item.id)?.node;
    node?.scrollIntoView({ behavior: calm() ? 'auto' : 'smooth', block: 'nearest' });
    node?.classList.add('is-new');
    setTimeout(() => node?.classList.remove('is-new'), 900);
    // Two frames later the card has drawn and can be measured, so a tool
    // arrives at the size it needs rather than at a guess from its manifest.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (sizeOnce(item)) {
        resolve(board.items, null);
        compact(board.items);
        render();
        markDirty();
      }
    }));
    return item;
  }

  async function removeItem(id, skipConfirm) {
    const item = board.items.find((i) => i.id === id);
    if (!item) return;
    const def = Desk.widgets.get(item.type);
    const holds = def && def.holdsContent && def.holdsContent(item.state);

    if (!skipConfirm) {
      const okToGo = await Desk.ask({
        title: `Remove ${def ? def.name : 'this tool'}?`,
        body: holds
          ? `${holds} It goes with the widget.`
          : 'You can add it back at any time.',
        confirmLabel: 'Remove',
        danger: !!holds,
      });
      if (!okToGo) return;
    }

    const leaving = board.root.querySelector(`[data-id="${CSS.escape(id)}"]`);
    // It shrinks away first, so the eye sees where it went before the rest
    // of the board closes up behind it.
    if (leaving && !calm()) {
      const going = leaving.animate(
        [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.9)' }],
        { duration: 180, easing: EASE, fill: 'forwards' },
      );
      await Promise.race([going.finished.catch(() => {}), new Promise((done) => setTimeout(done, 300))]);
    }
    unmountInstance(id);
    leaving?.remove();
    board.items = board.items.filter((i) => i.id !== id);
    compact(board.items);
    glide(() => render());
    markDirty();
  }

  // ---------- the big view ----------

  function openStage(id) {
    const item = board.items.find((i) => i.id === id);
    const def = item && Desk.widgets.get(item.type);
    if (!def) return;
    if (locked(def)) { toast(`${def.name} needs a school account. Log in to use it.`); return; }

    // Only one copy of a widget runs at a time, so a timer cannot tick twice.
    unmountInstance(id);
    board.root.querySelector(`[data-id="${CSS.escape(id)}"] .card-body`)?.replaceChildren();

    const body = el('div.stage-body');
    // The same shape, name and colour the tool wears on the board: opening a
    // tool larger should look like the same tool, only larger.
    const title = el('h2.stage-title', {}, [Desk.widgets.marker(def.category, 16), el('span', { text: def.name })]);
    const presentBtn = el('button.btn.btn--ghost', { svg: icon('present', 16), title: 'Fill the screen for the class' }, ' Present');
    const closeBtn = el('button.icon-btn', { title: 'Back to the desk (Esc)', 'aria-label': 'Back to the desk', svg: icon('close', 20), onclick: close });

    const stage = el('div.stage', {
      role: 'dialog', 'aria-modal': 'true',
      // Everything the stylesheet knows about a card's family and tone, so a
      // red timer is still a red timer when it fills the screen.
      'data-type': item.type,
      'data-category': def.category,
      'data-role': def.role || '',
      'data-tone': def.tone,
    }, [
      el('header.stage-head', {}, [title, el('div.stage-actions', {}, [presentBtn, closeBtn])]),
      body,
    ]);

    // Presenting is a class on the stage; real fullscreen is asked for on top
    // of it and allowed to fail. Browsers refuse fullscreen in plenty of
    // ordinary situations, and a Present button that does nothing at all when
    // it is refused is worse than one that simply fills the window.
    let presenting = false;
    const setPresenting = (on) => {
      presenting = on;
      stage.classList.toggle('is-present', on);
      presentBtn.classList.toggle('is-on', on);
    };
    presentBtn.addEventListener('click', () => {
      const next = !presenting;
      setPresenting(next);
      if (next) stage.requestFullscreen?.().catch(() => {});
      else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    });
    // Leaving fullscreen with Esc should leave presenting too.
    const onFs = () => { if (presenting && !document.fullscreenElement) setPresenting(false); };
    document.addEventListener('fullscreenchange', onFs);

    const onKey = (e) => { if (e.key === 'Escape' && !document.fullscreenElement) close(); };
    document.addEventListener('keydown', onKey);

    document.body.append(stage);
    document.body.classList.add('has-stage');
    const cardNode = board.root.querySelector(`[data-id="${CSS.escape(id)}"]`);
    stageMotion(stage, cardNode, 'open');

    def.init(item.state);
    const api = def.mount({
      root: body, state: item.state, item, expanded: true, me: board.me,
      save: markDirty, close,
    }) || {};
    board.stage = { id, api, node: stage };

    let closing = false;
    async function close() {
      if (closing) return;           // Esc and the close button in one go
      closing = true;
      if (document.fullscreenElement === stage) document.exitFullscreen().catch(() => {});
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFs);
      try { api.destroy && api.destroy(); } catch (e) { console.error(e); }
      await stageMotion(stage, board.root.querySelector(`[data-id="${CSS.escape(id)}"]`), 'close');
      stage.remove();
      document.body.classList.remove('has-stage');
      board.stage = null;
      // Put the card back the way the big view left things.
      const node = board.root.querySelector(`[data-id="${CSS.escape(id)}"]`);
      if (node) mountInstance(item, node);
    }
  }

  // ---------- the two clocks every widget can hang off ----------

  function startClocks() {
    const frame = () => {
      for (const inst of board.instances.values()) { try { inst.api.frame && inst.api.frame(); } catch (e) { console.error(e); } }
      if (board.stage) { try { board.stage.api.frame && board.stage.api.frame(); } catch (e) { console.error(e); } }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);

    // Animation frames stop when the tab is in the background; an alarm that
    // only rings on a visible tab is not an alarm, so anything that must
    // happen on time hangs off this instead.
    setInterval(() => {
      for (const inst of board.instances.values()) { try { inst.api.tick && inst.api.tick(); } catch (e) { console.error(e); } }
      if (board.stage) { try { board.stage.api.tick && board.stage.api.tick(); } catch (e) { console.error(e); } }
    }, 500);
  }

  function select(card) {
    for (const c of board.root.querySelectorAll('.card.is-selected')) {
      if (c !== card) c.classList.remove('is-selected');
    }
    if (card) card.classList.add('is-selected');
  }

  // ---------- boot ----------

  function init({ root, data, me, guest = false, storage = null }) {
    board.root = root;
    board.me = me;
    board.guest = guest;
    board.storage = storage;
    board.rev = data.rev;
    board.prefs = data.prefs || null;
    board.items = (data.items || []).map((i) => ({ ...i, state: i.state || {} }))
      // Anything this role may not have (behaviour, say) simply is not drawn.
      .filter((i) => { const d = Desk.widgets.get(i.type); return !d || !d.permission || (me.can && me.can[d.permission]); });
    render();
    startClocks();

    // The tool you are using is the one that shows its controls. Pointing at
    // a tool does nothing — that flickered as the mouse crossed the board.
    // Touching it (clicking a button, tapping the clock) selects it; touching
    // the desk, or Escape, puts the controls away again.
    document.addEventListener('pointerdown', (e) => {
      const card = e.target.closest && e.target.closest('.card');
      if (card && board.root.contains(card)) select(card);
      else if (!e.target.closest('.stage, .modal, .scrim, .menu, .toast')) select(null);
    });
    document.addEventListener('focusin', (e) => {
      const card = e.target.closest && e.target.closest('.card');
      if (card && board.root.contains(card)) select(card);
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') select(null); });

    // Redraw when the shape of the board changes, not on every pixel of a
    // window drag: the layout only actually differs at the two breakpoints.
    let shape = `${stacked()}:${columnsFor(root.clientWidth)}`;
    const watchShape = Desk.debounce(() => {
      const now = `${stacked()}:${columnsFor(root.clientWidth)}`;
      if (now !== shape) { shape = now; render(); }
    }, 150);
    window.addEventListener('resize', watchShape);
    if (typeof ResizeObserver === 'function') new ResizeObserver(watchShape).observe(root);
  }

  async function reset() {
    if (!await Desk.ask({
      title: 'Start the desk again?',
      body: 'Every widget goes back to the starting set, and anything they were holding — notes, timers you had set up — goes with them.',
      confirmLabel: 'Start again', danger: true,
    })) return;
    const data = await Desk.api.resetBoard();
    for (const id of [...board.instances.keys()]) unmountInstance(id);
    Desk.clear(board.root);
    board.rev = data.rev;
    board.items = data.items;
    render();
    toast('Your desk is back to the starting set.');
  }

  /** Colour and background live on the same document as the widgets. */
  function setPrefs(prefs) { board.prefs = prefs; markDirty(); }

  /**
   * What the tools on this board have to say, for the island at the top: the
   * first of each kind that offers a readout and actually has something to
   * report. Board order decides, so a teacher with two timers sees the one
   * they put down first.
   */
  function readouts(limit = 4) {
    const out = [];
    const seen = new Set();
    const order = board.items.slice().sort((a, b) => a.y - b.y || a.x - b.x);
    for (const item of order) {
      const def = Desk.widgets.get(item.type);
      if (!def || !def.readout || seen.has(item.type)) continue;
      let said = null;
      try { said = def.readout(item.state); } catch (e) { console.error(e); }
      if (!said || !said.value) continue;
      seen.add(item.type);
      out.push({ ...said, type: item.type, category: def.category, id: item.id });
      if (out.length >= limit) break;
    }
    return out;
  }

  Desk.board = {
    init, addItem, removeItem, reset, render, markDirty, openStage, setPrefs, tidy, readouts, glide, COLUMNS, GUEST_KEY,
    isGuest: () => board.guest,
    items: () => board.items,
    // The packing rules are the one piece of this file with no DOM in it, so
    // they are exported and tested directly rather than by dragging things.
    _geom: { hits, earlier, resolve, compact, findSpot },
  };
}(window.Desk));
