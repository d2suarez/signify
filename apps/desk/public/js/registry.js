// ===================================================================
// Teacher's Desk — the widget registry
//
// This is the whole extension point. A new tool is one file in js/widgets/
// that calls Desk.widget({...}) and one <script> tag in index.html. Nothing
// on the server needs to know it exists: widget state is stored opaquely, so
// a tool can keep whatever it likes in ctx.state and call ctx.save().
//
//   Desk.widget({
//     type:  'timer',            // stable id — never rename it, it is in saved boards
//     name:  'Timer',
//     blurb: 'Count down to zero.',
//     icon:  'timer',            // a key from Desk.iconNames
//     category: 'time',          // which drawer of the catalogue it lives in
//     fills: true,               // needs the whole card; otherwise it hugs
//     size:  { w: 4, h: 5 },     // in grid cells, when first added
//     min:   { w: 3, h: 4 },
//     needsRoster: false,        // shown in the "needs a class list" group
//     permission: 'behaviour',   // optional: hide unless me.can[permission]
//     init(state) {},            // fill in defaults on a fresh or older state
//     mount(ctx) { return { destroy() {}, frame() {}, tick() {} }; },
//   });
//
// ctx is { root, state, save, item, expanded, present, board, me }.
//   root      the element to draw into
//   state     the widget's own persisted object — mutate it freely
//   save()    marks the board dirty; the write is debounced
//   expanded  true when drawing into the big stage rather than the card
//   frame()   called on every animation frame (smooth displays)
//   tick()    called twice a second, and while the tab is in the background
// ===================================================================

window.Desk = window.Desk || {};

(function (Desk) {
  'use strict';

  const registry = new Map();

  /**
   * The drawers of the catalogue, in the order they are shown.
   *
   * Grouped by what a teacher is trying to DO, not by how the widget is built
   * — somebody looking for the seating plan is thinking about their class, not
   * about the fact that it happens to render an SVG. The order is roughly how
   * often a primary classroom reaches for them.
   *
   * A widget with no category, or one naming a drawer that does not exist,
   * falls into the last one rather than vanishing from the catalogue.
   */
  /* Each category carries a colour and a shape, and a tool never has either of
     its own: a teacher learns "red circle means time" once, and it holds
     across the board, the filter chips and the readouts in the header. */
  const CATEGORIES = [
    { key: 'time', name: 'Time', role: 'p1', shape: 'circle', blurb: 'Counting down, counting up, and what time it is.' },
    { key: 'class', name: 'Your class', role: 'p2', shape: 'square', blurb: 'The tools that know who is in the room.' },
    { key: 'board', name: 'On the board', role: 'p3', shape: 'triangle', blurb: 'Things to put in front of thirty people.' },
    { key: 'calm', name: 'Sound and calm', role: 'p4', shape: 'arch', blurb: 'For settling a room, or livening one up.' },
    // Odds and ends are deliberately colourless — a fifth colour would make
    // the other four mean less.
    { key: 'other', name: 'Odds and ends', role: null, shape: 'ring', blurb: 'Everything else worth having to hand.' },
  ];
  const FALLBACK = CATEGORIES[CATEGORIES.length - 1].key;


  function widget(def) {
    if (!def || !def.type) throw new Error('A widget needs a type.');
    if (registry.has(def.type)) throw new Error(`Two widgets both call themselves "${def.type}".`);
    registry.set(def.type, Object.assign({
      name: def.type,
      blurb: '',
      icon: 'notes',
      size: { w: 4, h: 4 },
      min: { w: 2, h: 3 },
      needsRoster: false,
      permission: null,
      // Most tools are a handful of controls and should be no taller than
      // they are. The few that genuinely want the room they are given — a
      // seating plan, an embedded video, a clock face that scales — say so.
      fills: false,
      category: FALLBACK,
      // 'block' fills the whole card with its category colour — for the tools
      // that are read at a glance from the back of the room. 'card' is white
      // with a coloured marker, for the tools you lean in and work with.
      tone: 'card',
      init() {},
      mount() { return {}; },
    }, def));
    return def.type;
  }

  const get = (type) => registry.get(type) || null;
  const all = () => [...registry.values()];

  /** The catalogue for the "Add a tool" panel, minus anything this role cannot have. */
  function available(me) {
    return all().filter((d) => !d.permission || (me && me.can && me.can[d.permission]));
  }

  /**
   * The catalogue as drawers, in order, with empty ones left out.
   *
   * `match` is an optional search term; when it is given, only the widgets
   * that match come back, and a drawer with nothing left in it disappears
   * rather than sitting there as an empty heading.
   */
  function byCategory(me, match = '') {
    const needle = String(match || '').trim().toLowerCase();
    const hit = (d) => !needle || `${d.name} ${d.blurb} ${d.type}`.toLowerCase().includes(needle);

    const known = new Set(CATEGORIES.map((c) => c.key));
    return CATEGORIES.map((c) => ({
      ...c,
      widgets: available(me).filter((d) => (known.has(d.category) ? d.category : FALLBACK) === c.key).filter(hit),
    })).filter((c) => c.widgets.length);
  }

  const category = (key) => CATEGORIES.find((c) => c.key === key) || CATEGORIES[CATEGORIES.length - 1];

  /**
   * The little shape that says which family a tool belongs to. One element,
   * drawn entirely in CSS from the shape name, so it costs nothing to put one
   * on a card, a chip, a readout in the header or a heading in the catalogue.
   */
  function marker(categoryKey, size) {
    const c = category(categoryKey);
    return Desk.el('span.shape', {
      'data-shape': c.shape,
      'aria-hidden': 'true',
      style: size ? { '--shape-size': `${size}px` } : {},
    });
  }

  Object.assign(Desk, { widget, widgets: { get, all, available, byCategory, category, marker, CATEGORIES } });
}(window.Desk));
