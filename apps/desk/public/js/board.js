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
  const STACK_BELOW = 820;

  const board = {
    rev: 0,
    items: [],
    prefs: null,
    me: null,
    root: null,
    instances: new Map(),      // item.id -> { def, item, api, node }
    stage: null,
  };

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

  // ---------- saving ----------

  let dirty = false;
  let saving = false;

  const flush = Desk.debounce(async () => {
    if (!dirty) return;
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
    if (!dirty) return;
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
    def.init(item.state);
    const api = def.mount({
      root: body,
      state: item.state,
      item,
      expanded: false,
      me: board.me,
      save: markDirty,
      expand: () => openStage(item.id),
    }) || {};
    board.instances.set(item.id, { def, item, api, node });
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
  }

  function position(node, item) {
    node.style.setProperty('--x', item.x);
    node.style.setProperty('--y', item.y);
    node.style.setProperty('--w', item.w);
    node.style.setProperty('--h', item.h);
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

    node.classList.add(mode === 'move' ? 'is-dragging' : 'is-resizing');
    document.body.classList.add('is-arranging');
    node.setPointerCapture(event.pointerId);
    event.preventDefault();

    const onMove = (e) => {
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;

      if (mode === 'move') {
        item.x = clamp(start.ix + Math.round(dx / pitchX), 0, COLUMNS - item.w);
        item.y = Math.max(0, start.iy + Math.round(dy / pitchY));
        // Follow the cursor between snaps, measured from wherever the card
        // has actually landed rather than from where it began.
        node.style.setProperty('--drag-x', `${dx - (item.x - start.ix) * pitchX}px`);
        node.style.setProperty('--drag-y', `${dy - (item.y - start.iy) * pitchY}px`);
      } else {
        item.w = clamp(start.iw + Math.round(dx / pitchX), def.min.w, COLUMNS - item.x);
        item.h = Math.max(def.min.h, start.ih + Math.round(dy / pitchY));
      }

      resolve(board.items, item);
      repositionAll();
      position(node, item);
    };

    const onUp = () => {
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
    render();
    markDirty();
    return changed;
  }

  function addItem(type) {
    const def = Desk.widgets.get(type);
    if (!def) return;
    const w = clamp(def.size.w, def.min.w, COLUMNS);
    const h = Math.max(def.size.h, def.min.h);
    const spot = findSpot(board.items, w, h);
    const item = { id: `w_${Math.random().toString(36).slice(2, 11)}`, type, state: {}, w, h, ...spot };
    board.items.push(item);
    render();
    markDirty();
    const node = board.instances.get(item.id)?.node;
    node?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    node?.classList.add('is-new');
    setTimeout(() => node?.classList.remove('is-new'), 1400);
    // Two frames later the card has drawn and can be measured, so a tool
    // arrives at the size it needs rather than at a guess from its manifest.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const need = rowsNeeded(item);
      if (need != null && need !== item.h) {
        item.h = Math.min(need, Math.max(item.h, TIDY_MAX_ROWS));
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

    unmountInstance(id);
    board.root.querySelector(`[data-id="${CSS.escape(id)}"]`)?.remove();
    board.items = board.items.filter((i) => i.id !== id);
    compact(board.items);
    render();
    markDirty();
  }

  // ---------- the big view ----------

  function openStage(id) {
    const item = board.items.find((i) => i.id === id);
    const def = item && Desk.widgets.get(item.type);
    if (!def) return;

    // Only one copy of a widget runs at a time, so a timer cannot tick twice.
    unmountInstance(id);
    board.root.querySelector(`[data-id="${CSS.escape(id)}"] .card-body`)?.replaceChildren();

    const body = el('div.stage-body');
    const title = el('h2.stage-title', {}, [el('span.card-icon', { svg: icon(def.icon, 22) }), el('span', { text: def.name })]);
    const presentBtn = el('button.btn.btn--ghost', { svg: icon('present', 16), title: 'Fill the screen for the class' }, ' Present');
    const closeBtn = el('button.icon-btn', { title: 'Back to the desk (Esc)', 'aria-label': 'Back to the desk', svg: icon('close', 20), onclick: close });

    const stage = el('div.stage', { role: 'dialog', 'aria-modal': 'true' }, [
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

    def.init(item.state);
    const api = def.mount({
      root: body, state: item.state, item, expanded: true, me: board.me,
      save: markDirty, close,
    }) || {};
    board.stage = { id, api, node: stage };

    function close() {
      if (document.fullscreenElement === stage) document.exitFullscreen().catch(() => {});
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFs);
      try { api.destroy && api.destroy(); } catch (e) { console.error(e); }
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

  function init({ root, data, me }) {
    board.root = root;
    board.me = me;
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

    let wasStacked = stacked();
    window.addEventListener('resize', Desk.debounce(() => {
      if (stacked() !== wasStacked) { wasStacked = stacked(); render(); }
    }, 150));
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

  Desk.board = {
    init, addItem, removeItem, reset, render, markDirty, openStage, setPrefs, tidy, COLUMNS,
    items: () => board.items,
    // The packing rules are the one piece of this file with no DOM in it, so
    // they are exported and tested directly rather than by dragging things.
    _geom: { hits, earlier, resolve, compact, findSpot },
  };
}(window.Desk));
