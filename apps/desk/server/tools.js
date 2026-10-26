// ===================================================================
// Teacher's Desk — the server's list of tools
//
// The widgets are defined in the browser (public/js/widgets/), and that stays
// the one place a tool is described. The server needs a few facts about each
// one — its name, whether students get it by default, whether it reads class
// lists — to tell Signify ID what the desk's tools are and to refuse what a
// school has turned off. So it reads the same files at boot, in a sandbox
// with just enough of a browser for them to call Desk.widget({...}).
// ===================================================================

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WIDGETS = path.join(__dirname, '..', 'public', 'js', 'widgets');

// The registry's own drawer names, so Signify ID groups tools as the
// catalogue does. Kept in step by a test.
const GROUPS = { time: 'Time', class: 'Your class', board: 'On the board', calm: 'Sound and calm', other: 'Odds and ends' };

function load() {
  const defs = [];
  const noop = () => {};
  const node = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : node()), apply: () => node() });
  const sandbox = { console, setTimeout, clearTimeout, setInterval, clearInterval, URL, URLSearchParams, TextEncoder };
  sandbox.window = sandbox;
  sandbox.document = node();
  sandbox.Desk = new Proxy({ widget: (def) => { defs.push(def); } }, {
    get: (t, k) => (k in t ? t[k] : node()),
  });
  vm.createContext(sandbox);
  const readsRoster = new Set();
  for (const f of fs.readdirSync(WIDGETS).filter((x) => x.endsWith('.js')).sort()) {
    const src = fs.readFileSync(path.join(WIDGETS, f), 'utf8');
    const before = defs.length;
    vm.runInContext(src, sandbox, { filename: f });
    // Some tools read class lists without needing one (the passage grader
    // offers a pupil picker). Read from the source so a new tool is covered
    // without anyone remembering to list it.
    if (/Desk\.roster\b/.test(src)) for (const d of defs.slice(before)) readsRoster.add(d.type);
  }
  return defs.map((d) => ({
    type: d.type,
    name: d.name || d.type,
    blurb: d.blurb || '',
    category: GROUPS[d.category] ? d.category : 'other',
    students: d.students === true,
    readsRoster: !!d.needsRoster || readsRoster.has(d.type),
    permission: d.permission || null,
  }));
}

const TOOLS = load();
const BY_TYPE = new Map(TOOLS.map((t) => [t.type, t]));

/** What the desk declares to Signify ID as its features, drawer by drawer. */
const ORDER = Object.keys(GROUPS);
const FEATURES = [...TOOLS].sort((a, b) => ORDER.indexOf(a.category) - ORDER.indexOf(b.category) || a.name.localeCompare(b.name)).map((t) => ({
  key: t.type, label: t.name, description: t.blurb.slice(0, 200), group: GROUPS[t.category], students: t.students,
}));

// The tools behind the class-list routes; the routes refuse anyone with none.
const ROSTER_TOOLS = TOOLS.filter((t) => t.readsRoster).map((t) => t.type);

module.exports = { TOOLS, BY_TYPE, FEATURES, ROSTER_TOOLS, GROUPS };
