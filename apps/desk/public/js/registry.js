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

  Object.assign(Desk, { widget, widgets: { get, all, available } });
}(window.Desk));
