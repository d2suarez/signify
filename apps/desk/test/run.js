// ===================================================================
// Teacher's Desk — tests
//   node test/run.js
//
// No server and no database: the store is pointed at a throwaway directory
// and the grid engine is loaded into a stub of just enough browser.
// ===================================================================

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-test-'));
process.env.DATA_DIR = TMP;
process.env.BEHAVIOUR_RETENTION_DAYS = '30';
delete process.env.RAILWAY_ENVIRONMENT;
process.env.NODE_ENV = 'test';

const { describe, it, assert, equal, throws, report } = require('./harness');

const store = require('../server/store');
const board = require('../server/board');
const behaviour = require('../server/behaviour');
const groups = require('../server/groups');
const roster = require('../server/roster');
const visitors = require('../server/visitors');
const templates = require('../server/templates');
const assets = require('../server/assets');

const alice = { uid: 'u-alice', email: 'alice@school.test', tenantId: 't1' };
const bruno = { uid: 'u-bruno', email: 'bruno@school.test', tenantId: 't1' };

// ===================================================================
describe('the board', () => {
  it('gives a new teacher a desk with tools already on it', () => {
    const b = board.boardFor(alice);
    assert(b.items.length > 0, 'a new desk should not be empty');
    assert(b.items.every((i) => i.id && i.type), 'every item needs an id and a type');
    assert(b.rev === 1, 'a new board starts at revision 1');
  });

  it('keeps two teachers apart', () => {
    const a = board.boardFor(alice);
    const b = board.boardFor(bruno);
    assert(a !== b, 'each teacher has their own board');
    assert(a.items[0].id !== b.items[0].id, 'the items are not shared either');
  });

  it('saves, and moves the revision on', () => {
    // boardFor hands back the live record, so read the revision before saving
    // rather than holding a reference that the save then bumps underneath you.
    const was = board.boardFor(alice).rev;
    const res = board.saveBoard(alice, { rev: was, items: [{ id: 'w1', type: 'timer', x: 2, y: 3, w: 4, h: 5, state: { a: 1 } }] });
    assert(res.ok, 'the save should be accepted');
    equal(res.rev, was + 1, 'the revision moves on');
    equal(board.boardFor(alice).items.length, 1, 'the board is what was sent');
  });

  it('refuses a save from a stale copy rather than clobbering', () => {
    const current = board.boardFor(alice);
    const res = board.saveBoard(alice, { rev: current.rev - 1, items: [] });
    assert(res.conflict, 'a stale revision is a conflict');
    assert(board.boardFor(alice).items.length === 1, 'and nothing was overwritten');
  });

  it('pulls impossible geometry back into the grid', () => {
    const rev = board.boardFor(alice).rev;
    board.saveBoard(alice, { rev, items: [{ id: 'w1', type: 'timer', x: -5, y: -2, w: 99, h: 0 }] });
    const item = board.boardFor(alice).items[0];
    equal(item.w, board.COLUMNS, 'width is capped at the number of columns');
    equal(item.x, 0, 'x cannot be negative');
    equal(item.y, 0, 'y cannot be negative');
    assert(item.h >= 1, 'height is at least one row');
  });

  it('will not let one widget push another off the right edge', () => {
    const rev = board.boardFor(alice).rev;
    board.saveBoard(alice, { rev, items: [{ id: 'w1', type: 'timer', x: 10, y: 0, w: 6, h: 3 }] });
    const item = board.boardFor(alice).items[0];
    assert(item.x + item.w <= board.COLUMNS, 'the widget stays inside the grid');
  });

  it('drops a widget with no type, and de-duplicates ids', () => {
    const rev = board.boardFor(alice).rev;
    board.saveBoard(alice, { rev, items: [
      { id: 'a', type: 'timer', x: 0, y: 0, w: 3, h: 3 },
      { id: 'a', type: 'notes', x: 3, y: 0, w: 3, h: 3 },
      { id: 'b', x: 6, y: 0, w: 3, h: 3 },
    ] });
    const items = board.boardFor(alice).items;
    equal(items.length, 1, 'only the first of the repeated ids survives, and the typeless one is dropped');
    equal(items[0].type, 'timer');
  });

  it('refuses a board too big to be a board', () => {
    const rev = board.boardFor(alice).rev;
    const fat = { id: 'w1', type: 'notes', x: 0, y: 0, w: 3, h: 3, state: { text: 'x'.repeat(300 * 1024) } };
    const res = board.saveBoard(alice, { rev, items: [fat] });
    assert(res.tooBig, 'an oversized board is refused');
    assert(!res.ok, 'and definitely not saved');
  });

  it('resets to the starting set', () => {
    const b = board.resetBoard(alice);
    equal(b.items.length, board.STARTER.length, 'the starting tools are back');
    assert(b.items.every((i) => Object.keys(i.state).length === 0), 'and they are empty');
  });
});

// ===================================================================
describe('behaviour notes', () => {
  it('records a note against the teacher who wrote it', () => {
    const row = behaviour.record(alice, { classKey: 'list:1', studentKey: 's1', studentName: 'Ava', kind: 'positive', reason: 'Great effort' });
    equal(row.teacherUid, alice.uid);
    equal(row.kind, 'positive');
  });

  it('needs a pupil and a class', () => {
    throws(() => behaviour.record(alice, { studentKey: 's1', kind: 'positive' }), 'a note with no class is refused');
    throws(() => behaviour.record(alice, { classKey: 'list:1', kind: 'positive' }), 'a note with no pupil is refused');
  });

  it('treats an unknown kind as positive rather than storing it', () => {
    const row = behaviour.record(alice, { classKey: 'list:1', studentKey: 's2', studentName: 'Noah', kind: 'meltdown' });
    equal(row.kind, 'positive');
  });

  it('never shows one teacher another teacher’s notes', () => {
    behaviour.record(bruno, { classKey: 'list:1', studentKey: 's1', studentName: 'Ava', kind: 'concern', reason: 'Off task' });
    const mine = behaviour.forClass(alice, 'list:1', 0);
    assert(mine.entries.every((e) => e.teacherUid === alice.uid), 'only my own notes come back');
    assert(mine.totals.s1.concern === 0, 'and the other teacher’s concern is not in my tally');
  });

  it('will not delete somebody else’s note', () => {
    const theirs = behaviour.forClass(bruno, 'list:1', 0).entries[0];
    equal(behaviour.remove(alice, theirs.id), false, 'refused');
    equal(behaviour.forClass(bruno, 'list:1', 0).entries.length, 1, 'and it is still there');
  });

  it('tallies per pupil', () => {
    behaviour.record(alice, { classKey: 'list:1', studentKey: 's1', studentName: 'Ava', kind: 'positive' });
    behaviour.record(alice, { classKey: 'list:1', studentKey: 's1', studentName: 'Ava', kind: 'concern' });
    const { totals } = behaviour.forClass(alice, 'list:1', 0);
    equal(totals.s1.positive, 2);
    equal(totals.s1.concern, 1);
  });

  it('honours the window it is asked for', () => {
    const db = store.load();
    const old = Object.values(db.behaviour).find((b) => b.teacherUid === alice.uid);
    old.at = Date.now() - 10 * 864e5;
    const recent = behaviour.forClass(alice, 'list:1', Date.now() - 864e5);
    assert(!recent.entries.some((e) => e.id === old.id), 'the old one is outside today');
  });

  it('deletes everything past its date', () => {
    const db = store.load();
    const target = Object.values(db.behaviour)[0];
    target.at = Date.now() - 400 * 864e5;
    const before = Object.keys(db.behaviour).length;
    behaviour.sweep();
    equal(Object.keys(db.behaviour).length, before - 1, 'exactly the expired one went');
  });

  it('gives every teacher their own chips, positive ones first', () => {
    const chips = behaviour.reasonsFor(alice.uid);
    assert(chips.length > 0, 'there are chips to start with');
    equal(chips[0].kind, 'positive', 'the first chip is a good one');
    assert(chips.filter((c) => c.kind === 'positive').length > chips.filter((c) => c.kind === 'concern').length,
      'there are more ways to record what went right than what went wrong');
  });

  it('drops a blank chip and caps the rest', () => {
    const saved = behaviour.setReasons(alice.uid, [
      { id: 'x', kind: 'positive', label: 'Kind' },
      { id: 'y', kind: 'concern', label: '   ' },
      ...Array.from({ length: 40 }, (_, i) => ({ id: `z${i}`, kind: 'positive', label: `Chip ${i}` })),
    ]);
    assert(!saved.some((r) => !r.label), 'nothing blank is stored');
    assert(saved.length <= 24, 'the list has a ceiling');
  });
});

// ===================================================================
// The net under everything else. Twice now a term of seating plans has gone
// and there was no way back and nothing in the log; these are the tests for
// not being in that position a third time.
describe('keeping earlier versions of a board', () => {
  const seating = (id, plans) => ({ id, type: 'seating', x: 0, y: 0, w: 6, h: 7, state: { plans } });
  const withSeats = (n) => ({ desks: [{ id: 'd1', seats: 30 }], seats: Object.fromEntries(
    Array.from({ length: n }, (_, i) => [`d1#${i}`, `pupil-${i}`])), objects: [], front: 'top' });

  it('counts who is seated, per widget and per class', () => {
    const counts = board._seatCounts([seating('w1', { '9REL': withSeats(23), '12GOVT': withSeats(18) })]);
    equal(counts, { 'w1:9REL': 23, 'w1:12GOVT': 18 });
  });

  it('notices a save that would empty a plan', () => {
    const before = [seating('w1', { '9REL': withSeats(23) })];
    const after = [seating('w1', { '9REL': withSeats(0) })];
    equal(board._seatsLost(before, after), [{ key: 'w1:9REL', was: 23, now: 0 }]);
  });

  it('notices a plan that vanishes entirely, not just one that empties', () => {
    const before = [seating('w1', { '9REL': withSeats(23) })];
    equal(board._seatsLost(before, [seating('w1', {})]), [{ key: 'w1:9REL', was: 23, now: 0 }]);
    equal(board._seatsLost(before, []), [{ key: 'w1:9REL', was: 23, now: 0 }]);
  });

  it('says nothing when seats are added or unchanged', () => {
    const before = [seating('w1', { '9REL': withSeats(10) })];
    equal(board._seatsLost(before, [seating('w1', { '9REL': withSeats(20) })]), []);
    equal(board._seatsLost(before, before), []);
  });

  it('keeps the previous board when a save would lose seats', () => {
    const teacher = { uid: 'u-keeper', email: 'k@school.test', tenantId: 't1' };
    let b = board.boardFor(teacher);
    board.saveBoard(teacher, { rev: b.rev, items: [seating('w1', { '9REL': withSeats(23) })] });

    const before = board.listHistory(teacher).length;
    b = board.boardFor(teacher);
    board.saveBoard(teacher, { rev: b.rev, items: [seating('w1', { '9REL': withSeats(0) })] });

    const kept = board.listHistory(teacher);
    assert(kept.length > before, 'a version was kept on the way past');
    equal(kept[0].seated, 23, 'and it is the one with everybody still in it');
  });

  it('puts an earlier board back, and keeps the current one on the way', () => {
    const teacher = { uid: 'u-restorer', email: 'r@school.test', tenantId: 't1' };
    let b = board.boardFor(teacher);
    board.saveBoard(teacher, { rev: b.rev, items: [seating('w1', { '9REL': withSeats(18) })] });
    b = board.boardFor(teacher);
    board.saveBoard(teacher, { rev: b.rev, items: [seating('w1', { '9REL': withSeats(0) })] });

    const kept = board.listHistory(teacher).find((h) => h.seated === 18);
    assert(!!kept, 'the full one is in the list');
    const res = board.restoreHistory(teacher, kept.rev);
    assert(res && res.ok, 'it restores');

    const now = board.boardFor(teacher);
    equal(Object.keys(now.items[0].state.plans['9REL'].seats).length, 18, 'everybody is back');
    assert(board.listHistory(teacher).some((h) => h.why.includes('putting an earlier desk back')),
      'and the emptied one is kept too, so this is undoable as well');
  });

  it('refuses a version number it does not have', () => {
    equal(board.restoreHistory({ uid: 'u-restorer' }, 99999), null);
  });
});

// ===================================================================
describe('how the tools sit', () => {
  it('forgets the floating mode that used to be a choice', () => {
    equal(board.cleanPrefs({ chrome: 'bare' }).chrome, undefined);
    equal(board.cleanPrefs({ chrome: 'bare', theme: 'dark' }).theme, 'dark', 'and keeps everything else');
  });
});

// ===================================================================
describe('a colour of your own', () => {
  it('keeps a real hex colour', () => {
    equal(board.cleanPrefs({ palette: 'custom', accentHex: '#FF8800' }).accentHex, '#ff8800');
    equal(board.cleanPrefs({ palette: 'custom', accentHex: '#ff8800' }).palette, 'custom');
  });

  it('refuses anything that is not six hex digits', () => {
    // The value goes straight into a CSS custom property, so this is the gate
    // that stops a saved preference carrying anything but a colour into the
    // stylesheet.
    for (const bad of ['red', '#abc', '#ff88000', 'red; background:url(//x)', '', null, 12, '#ff88 00']) {
      equal(board.cleanPrefs({ palette: 'custom', accentHex: bad }).accentHex, '#EC3013', String(bad));
    }
  });

  it('still refuses a palette name it does not know', () => {
    equal(board.cleanPrefs({ palette: 'chartreuse' }).palette, 'primary');
    equal(board.cleanPrefs({ palette: 'custom' }).palette, 'custom');
  });

  it('carries a board saved under the old accents into its palette', () => {
    // Nobody should have to choose their colours again because the scheme
    // underneath them changed.
    equal(board.cleanPrefs({ accent: 'teal' }).palette, 'ocean');
    equal(board.cleanPrefs({ accent: 'pink' }).palette, 'berry');
    equal(board.cleanPrefs({ accent: 'red' }).palette, 'mono-red');
    equal(board.cleanPrefs({ accent: 'slate' }).palette, 'primary');
    equal(board.cleanPrefs({ accent: 'custom', accentHex: '#ff8800' }).palette, 'custom',
      'and a colour of their own is still their own');
  });
});

// ===================================================================
describe('what this holds about pupils', () => {
  const inventory = require('../server/inventory');

  it('describes every collection the store actually has', () => {
    // The point of the test: a privacy note that drifts away from the software
    // is worse than none, so gaining a new store without saying what is in it
    // fails here rather than quietly shipping.
    const documented = new Set(inventory.sections().map((x) => x.key));
    const missing = inventory.collections().filter((k) => !documented.has(k));
    equal(missing, [], `undocumented store(s): ${missing.join(', ')}`);
  });

  it('invents nothing that does not exist', () => {
    const real = new Set(inventory.collections());
    const extra = inventory.sections().map((x) => x.key).filter((k) => !real.has(k));
    equal(extra, [], `documented but not real: ${extra.join(', ')}`);
  });

  it('says what each one holds, what it says about pupils, and for how long', () => {
    for (const s of inventory.sections()) {
      assert(s.title && s.holds && s.pupils && s.kept, `${s.key} is missing an answer`);
    }
  });

  it('quotes the retention window from the code, not from memory', () => {
    const notes = inventory.sections().find((x) => x.key === 'behaviour');
    assert(notes.kept.includes(String(require('../server/behaviour').RETENTION_DAYS)),
      'the number on the page is the number the sweep uses');
  });

  it('renders a page that needs no sign-in and no JavaScript', () => {
    const html = inventory.page({ host: 'desk.example' });
    assert(html.startsWith('<!doctype html>'), 'a real page');
    assert(!/<script/i.test(html), 'nothing to run');
    for (const s of inventory.sections()) assert(html.includes(s.title), `${s.title} is on it`);
  });

  it('escapes what it renders, so a section cannot inject markup', () => {
    const html = inventory.page({
      only: [{ key: 'x', title: '<script>bad()</script>', holds: 'a & b', pupils: '**safe**', kept: 'c' }],
    });
    assert(!html.includes('<script>bad()'), 'the tag is escaped, not run');
    assert(html.includes('&lt;script&gt;bad()&lt;/script&gt;'), 'and shown as text');
    assert(html.includes('a &amp; b'), 'ampersands too');
    assert(html.includes('<strong>safe</strong>'), 'but the one bit of markup it does allow still works');
  });
});

// ===================================================================
describe('class lists', () => {
  let list;

  it('makes a list and gives every pupil a stable id', () => {
    list = roster.createList(alice, ' 4B Maths ', ['Ava Bennett', { name: 'Noah Clarke' }, '  ', 'Ava Bennett']);
    equal(list.name, '4B Maths', 'the name is tidied');
    equal(list.students.length, 3, 'blank lines go; repeated names are two different children');
    assert(list.students.every((s) => s.id), 'each has an id');
  });

  it('keeps a pupil’s id when their name is corrected', () => {
    const wasId = list.students[0].id;
    const updated = roster.updateList(alice, list.id, {
      students: [{ id: wasId, name: 'Ava Bennett-Shaw' }, ...list.students.slice(1)],
    });
    equal(updated.students[0].id, wasId, 'the same child, spelled better');
    equal(updated.students[0].name, 'Ava Bennett-Shaw');
  });

  it('will not hand somebody else’s list over, or let them change it', () => {
    equal(roster.updateList(bruno, list.id, { name: 'Mine now' }), null);
    equal(roster.deleteList(bruno, list.id), false);
    equal(store.load().rosters[list.id].name, '4B Maths', 'untouched');
  });

  it('caps how many pupils one list can hold', () => {
    const big = roster.createList(alice, 'Everyone', Array.from({ length: 500 }, (_, i) => `Pupil ${i}`));
    assert(big.students.length <= 200, 'a class list is not a school roll');
    roster.deleteList(alice, big.id);
  });

  it('deletes only on the owner’s say-so', () => {
    equal(roster.deleteList(alice, list.id), true);
    equal(store.load().rosters[list.id], undefined);
  });
});

// ===================================================================
// The failure that had a teacher signing out and back in to get their class
// lists returned: Signify ID stops recognising the sign-in, but this app's
// own check — signature and expiry, no round trip — still says they are
// signed in. A desk that believes you are here and cannot see one class is
// the worst of both, so a 401 from the roster ends the session outright.
describe('when the sign-in has ended upstream', () => {
  const signify = require('../signify-auth');
  const realFetch = global.fetch;
  const wasEnabled = signify.ENABLED;
  const wasIssuer = signify.ISSUER;

  const withUpstream = async (status, body) => {
    signify.ENABLED = true;
    signify.ISSUER = 'https://id.test';
    global.fetch = async () => ({ ok: false, status, text: async () => body, json: async () => ({}) });
    const req = { headers: {}, signifyToken: 'a-token-this-app-still-believes-in' };
    const result = await roster.classesFor(req, alice);
    return { req, result };
  };

  const restore = () => {
    global.fetch = realFetch;
    signify.ENABLED = wasEnabled;
    signify.ISSUER = wasIssuer;
    roster._forget('');
  };

  it('marks the request so the session can be ended', async () => {
    try {
      const { req, result } = await withUpstream(401, '{"error":"invalid_token"}');
      equal(req.signifyExpired, true, 'the request knows the sign-in is over');
      equal(result.signifyOk, false, 'and it is not reported as "you have no classes"');
    } finally { restore(); }
  });

  it('does not sign anybody out over a wobble at the other end', async () => {
    try {
      const { req, result } = await withUpstream(503, 'upstream is having a moment');
      equal(req.signifyExpired, undefined, 'a 503 is not an ended session');
      equal(result.signifyOk, false, 'but the lookup still failed, and says so');
    } finally { restore(); }
  });

  it('never caches a refusal, so the next try is a real one', async () => {
    try {
      await withUpstream(401, '{}');
      let asked = 0;
      signify.ENABLED = true;
      signify.ISSUER = 'https://id.test';
      global.fetch = async () => { asked += 1; return { ok: true, status: 200, json: async () => ({ classes: [] }) }; };
      await roster.classesFor({ headers: {}, signifyToken: 't' }, alice);
      equal(asked, 1, 'it asked again rather than serving the refusal back');
    } finally { restore(); }
  });
});

// ===================================================================
describe('kept groupings', () => {
  let saved;

  it('saves an arrangement', () => {
    saved = groups.create(alice, {
      classKey: 'list:1', name: 'Science', groups: [
        { label: 'Group A', members: [{ key: 's1', name: 'Ava' }, { key: 's2', name: 'Noah' }] },
        { label: 'Group B', members: [{ key: 's3', name: 'Mia' }] },
      ],
    });
    equal(saved.groups.length, 2);
    equal(saved.groups[0].members.length, 2);
  });

  it('refuses an empty one', () => {
    throws(() => groups.create(alice, { classKey: 'list:1', groups: [] }));
  });

  it('lists only the owner’s, and only for the class asked about', () => {
    equal(groups.listFor(bruno, 'list:1').length, 0, 'not Bruno’s');
    equal(groups.listFor(alice, 'list:1').length, 1, 'but it is Alice’s');
    equal(groups.listFor(alice, 'list:other').length, 0, 'and only for that class');
  });

  it('will not let anyone else delete it', () => {
    equal(groups.remove(bruno, saved.id), false);
    equal(groups.remove(alice, saved.id), true);
  });
});

// ===================================================================
describe('reading a typed time', () => {
  const parse = loadUtil().parseDuration;
  const cases = [
    // One or two digits are minutes: that is what somebody setting a
    // classroom timer means when they type "7".
    ['7', 7 * 60_000], ['90', 90 * 60_000], ['2.5', 150_000],
    // Three or more read like a microwave keypad — the last two are seconds.
    ['230', 150_000], ['130', 90_000], ['100', 60_000], ['045', 45_000],
    ['1500', 15 * 60_000], ['13000', 90 * 60_000], ['120000', 12 * 3600_000],
    ['1:30', 90_000], ['0:45', 45_000], ['12:00', 12 * 60_000],
    ['1:02:30', 3_750_000],
    ['45s', 45_000], ['20m', 20 * 60_000], ['1h', 3_600_000],
    ['1h30m', 90 * 60_000], ['1 min 30 sec', 90_000], ['20 minutes', 20 * 60_000],
    ['  5  ', 5 * 60_000], ['1H30M', 90 * 60_000],
  ];

  for (const [input, want] of cases) {
    it(`reads ${JSON.stringify(input)}`, () => equal(parse(input), want));
  }

  const refused = ['', '   ', 'abc', '5pm', '0', '-5', '1:2:3:4', '10:', ':30', '25h', '0:00', 'half an hour', '000', '0000'];
  for (const input of refused) {
    it(`refuses ${JSON.stringify(input)}`, () => equal(parse(input), null, 'should not be read as a length of time'));
  }

  it('punctuates digits as they are typed', () => {
    const group = loadUtil().groupDigits;
    equal(group('7'), '7');
    equal(group('45'), '45');
    equal(group('230'), '2:30');
    equal(group('1500'), '15:00');
    equal(group('13000'), '1:30:00');
    equal(group('120000'), '12:00:00');
    equal(group(''), '');
  });

  it('types out exactly what it later reads back', () => {
    // The field punctuates with groupDigits and the commit goes through
    // parseDuration. If those two ever disagreed, a teacher would watch the
    // timer set itself to something other than what the field showed them.
    const { groupDigits, parseDuration } = loadUtil();
    for (const digits of ['7', '45', '230', '130', '1500', '13000', '120000']) {
      equal(parseDuration(groupDigits(digits)), parseDuration(digits), `"${digits}" reads the same punctuated or not`);
    }
  });
});

// ===================================================================
describe('building bits of page', () => {
  const { el, append, clear, _doc: document } = loadUtil();

  it('skips a child that is not there', () => {
    // The DOM's own append() renders null as the word "null". That put a
    // literal "null" under the classroom jobs rota, so conditional children
    // go through this instead.
    const node = el('div');
    append(node, el('span', { text: 'kept' }), null, false, undefined);
    equal(node.childNodes.length, 1, 'only the real child is added');
    equal(node.textContent, 'kept', 'and nothing is stringified into the page');
  });

  it('still takes plain text and arrays', () => {
    const node = el('div');
    append(node, 'hello ', [null, el('b', { text: 'there' })]);
    equal(node.textContent, 'hello there');
  });

  it('puts the caret back after a rebuild', () => {
    // The "only one character at a time" bug: a handler rebuilt the container
    // its own field lived in, so focus landed back on the page and the next
    // keystroke went nowhere.
    const { keepFocus, el: mk, clear: wipe, _doc: doc } = loadUtil();
    const root = doc.createElement('div');
    const build = () => {
      wipe(root);
      root.append(mk('input', {}), mk('input', {}), mk('button', {}));
    };
    build();

    const second = root.querySelectorAll('input')[1];
    second.setSelectionRange(3, 3);
    second.focus();
    equal(doc.activeElement === second, true, 'the second field has the caret');

    keepFocus(root, build);

    const after = root.querySelectorAll('input')[1];
    assert(after !== second, 'the rebuild really did replace the element');
    equal(doc.activeElement === after, true, 'and the caret moved to its replacement');
    equal(after.selectionStart, 3, 'at the same position in the text');
  });

  it('leaves focus alone when it was somewhere else', () => {
    const { keepFocus, el: mk, clear: wipe, _doc: doc } = loadUtil();
    const root = doc.createElement('div');
    root.append(mk('input', {}));
    const outside = doc.createElement('input');
    outside.focus();
    keepFocus(root, () => { wipe(root); root.append(mk('input', {})); });
    equal(doc.activeElement === outside, true, 'a field outside the redraw keeps the caret');
  });

  it('el() has always filtered its own children', () => {
    equal(el('div', {}, [el('i', { text: 'a' }), null, false]).childNodes.length, 1);
  });
});

// ===================================================================
describe('files a teacher uploads', () => {
  // Real magic bytes, because that is the only thing the server trusts.
  const PNG = Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(64)]);
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
  const MP3 = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.alloc(64)]);
  const M4A = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A ', 'latin1'), Buffer.alloc(64)]);
  const OGG = Buffer.concat([Buffer.from('OggS', 'latin1'), Buffer.alloc(64)]);
  const HTML = Buffer.from('<html><script>alert(1)</script></html>                    ', 'latin1');

  it('knows what a file is from its bytes', () => {
    equal(assets.sniff(PNG), 'image/png');
    equal(assets.sniff(JPEG), 'image/jpeg');
    equal(assets.sniff(MP3), 'audio/mpeg');
    equal(assets.sniff(M4A), 'audio/mp4');
    equal(assets.sniff(OGG), 'audio/ogg');
  });

  it('refuses a page dressed up as a picture', () => {
    // The whole attack: a correct-looking name and Content-Type on a file
    // that is really markup. Neither is consulted.
    equal(assets.sniff(HTML), null);
    throws(() => assets.save(alice, HTML, 'innocent.png'), 'an HTML "png" is refused');
    throws(() => assets.save(alice, Buffer.from('%PDF-1.4 ....................', 'latin1'), 'notes.mp3'), 'a PDF "mp3" is refused');
    throws(() => assets.save(alice, Buffer.alloc(0), 'empty.png'), 'an empty file is refused');
  });

  it('refuses a video pretending to be a sound', () => {
    // Same ftyp container as M4A, different brand. Video is not on the list.
    const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypavc1', 'latin1'), Buffer.alloc(64)]);
    equal(assets.sniff(MP4), null);
  });

  it('stores it under a generated name, never the one given', () => {
    const saved = assets.save(alice, PNG, '../../etc/passwd.png');
    assert(!saved.path, 'the path never leaves the server');
    const row = assets.get(alice, saved.id);
    assert(row.path.includes(saved.id), 'the file on disk is named by id');
    assert(!row.path.includes('passwd'), 'nothing from the given name reaches the filesystem');
    equal(saved.label, '../../etc/passwd', 'the name survives only as a label');
    assets.remove(alice, saved.id);
  });

  it('is private to whoever uploaded it', () => {
    const saved = assets.save(alice, MP3, 'mine.mp3');
    equal(assets.get(bruno, saved.id), null, 'not Bruno’s to read');
    equal(assets.remove(bruno, saved.id), false, 'nor to delete');
    equal(assets.listFor(bruno).length, 0);
    equal(assets.listFor(alice).some((a) => a.id === saved.id), true);
    equal(assets.remove(alice, saved.id), true);
  });

  it('filters by what the file is', () => {
    const pic = assets.save(alice, PNG, 'a.png');
    const snd = assets.save(alice, OGG, 'b.ogg');
    equal(assets.listFor(alice, 'image').map((a) => a.id), [pic.id]);
    equal(assets.listFor(alice, 'audio').map((a) => a.id), [snd.id]);
    assets.remove(alice, pic.id);
    assets.remove(alice, snd.id);
  });

  it('refuses a file bigger than the limit', () => {
    const huge = Buffer.concat([PNG, Buffer.alloc(assets.MAX_BYTES + 1)]);
    throws(() => assets.save(alice, huge, 'huge.png'));
  });
});

// ===================================================================
describe('how the desk looks', () => {
  it('starts on the defaults', () => {
    const b = board.boardFor(bruno);
    equal(b.prefs.theme, 'auto');
    equal(b.prefs.palette, 'primary');
  });

  it('keeps only colours it actually has', () => {
    const p = board.cleanPrefs({ theme: 'midnight', palette: 'chartreuse', backgroundDim: 500 });
    equal(p.theme, 'auto', 'an unknown mode falls back');
    equal(p.palette, 'primary', 'so does an unknown palette');
    equal(p.backgroundDim, 90, 'and the scrim is clamped');
  });

  it('never lets the background be a URL', () => {
    // A background that can point anywhere is a background that reports every
    // teacher's IP to somebody else's server.
    equal(board.cleanPrefs({ background: 'https://evil.test/a.png' }).background, 'httpseviltestapng');
    equal(board.cleanPrefs({ background: 'javascript:alert(1)' }).background, 'javascriptalert1');
    equal(board.cleanPrefs({ background: 'asset:a_abc123' }).background, 'asseta_abc123');
  });

  it('saves alongside the widgets, and survives a reset of the board', () => {
    const rev = board.boardFor(bruno).rev;
    board.saveBoard(bruno, { rev, items: [], prefs: { theme: 'dark', palette: 'ocean' } });
    equal(board.boardFor(bruno).prefs.palette, 'ocean');
    board.resetBoard(bruno);
    equal(board.boardFor(bruno).prefs.palette, 'ocean', 'resetting the tools does not repaint the room');
  });
});

// ===================================================================
describe('seating a class at random', () => {
  const shareOut = loadWidget('seating')._shareOut;

  /** Final headcount at each desk. */
  const finals = (caps, already, n) => {
    const { add, standing } = shareOut(caps, already, n);
    return { seats: caps.map((c, i) => already[i] + add[i]), standing };
  };
  const alone = (seats) => seats.filter((n) => n === 1).length;

  const prunePlan = loadWidget('seating')._prunePlan;

  /** A plan with two two-seat desks and four pupils in them. */
  const fullPlan = () => ({
    desks: [{ id: 'd1', seats: 2 }, { id: 'd2', seats: 2 }],
    seats: { 'd1#0': 'ava', 'd1#1': 'noah', 'd2#0': 'mia', 'd2#1': 'leo' },
    objects: [], front: 'top',
  });

  const seatingDef = loadWidget('seating');
  const keepHistory = seatingDef._keepHistory;
  const KEEP = seatingDef._KEEP_HISTORY;

  it('keeps a copy of an arrangement before anything destroys it', () => {
    const h = {};
    keepHistory(h, '9REL', fullPlan(), 'before emptying the seats');
    equal(h['9REL'].length, 1);
    equal(Object.keys(h['9REL'][0].plan.seats).length, 4, 'the whole arrangement, not a reference');
    equal(h['9REL'][0].why, 'before emptying the seats');
  });

  it('snapshots a copy, so changing the plan afterwards cannot rewrite history', () => {
    const h = {};
    const live = fullPlan();
    keepHistory(h, '9REL', live, '');
    live.seats = {};                       // the destruction the snapshot was for
    equal(Object.keys(h['9REL'][0].plan.seats).length, 4, 'the copy is untouched');
  });

  it('does not fill the list with identical copies', () => {
    const h = {};
    keepHistory(h, '9REL', fullPlan(), 'a');
    keepHistory(h, '9REL', fullPlan(), 'b');
    equal(h['9REL'].length, 1, 'putting one back twice is not two snapshots');
  });

  it('does not bother keeping an empty room', () => {
    const h = {};
    keepHistory(h, '9REL', { desks: [], seats: {}, objects: [], front: 'top' }, '');
    equal(h['9REL'], undefined, 'there is nothing there to want back');
  });

  it('keeps the newest and lets the oldest go', () => {
    const h = {};
    for (let i = 0; i < KEEP + 6; i += 1) {
      const p = fullPlan();
      p.seats['d1#0'] = `pupil-${i}`;      // each one different
      keepHistory(h, '9REL', p, `change ${i}`);
    }
    equal(h['9REL'].length, KEEP, 'the list has a ceiling');
    equal(h['9REL'][0].why, `change ${KEEP + 5}`, 'newest first');
  });

  it('keeps each class\u2019s history to itself', () => {
    const h = {};
    keepHistory(h, '9REL', fullPlan(), '');
    keepHistory(h, '11REL', fullPlan(), '');
    equal(Object.keys(h).sort(), ['11REL', '9REL']);
  });

  it('survives two loads racing, which is what opening a card does', async () => {
    // The bug the tests missed: `students` was a closure variable, load()
    // awaits twice, and expanding a card mounts a SECOND copy of the widget
    // whose load() reset that variable while the first was still waiting.
    // The first then pruned against an empty list with rosterKnown still true
    // and emptied the plan. This models the same shape: locals per call, and
    // a stale call bows out.
    const plan = fullPlan();
    let seq = 0;
    let shared = [];
    const roster = () => new Promise((r) => setTimeout(() => r(['ava', 'noah', 'mia', 'leo']), 5));
    const name = () => new Promise((r) => setTimeout(() => r('4B'), 5));

    async function load() {
      const mine = ++seq;
      let got = [];
      let known = false;
      try { got = await roster(); known = true; } catch { /* refused */ }
      await name();
      if (mine !== seq) return;            // a newer load owns the state
      shared = got;
      prunePlan(plan, shared.map((x) => x), known);
    }

    await Promise.all([load(), load()]);   // card and stage, together
    equal(Object.keys(plan.seats).length, 4, 'nobody was pruned away by the race');
  });

  it('NEVER empties a plan because the class list could not be fetched', () => {
    // The bug that lost a term of seating plans: a refused roster lookup
    // returns nobody, and "nobody is in this class" was read as "everybody
    // has left". Four classes were wiped and the teacher had clicked nothing.
    const p = prunePlan(fullPlan(), [], false);
    equal(Object.keys(p.seats).length, 4, 'silence is not an empty class');
  });

  it('does drop a pupil who really has left, when the list actually loaded', () => {
    const p = prunePlan(fullPlan(), ['ava', 'noah', 'mia'], true);
    equal(Object.keys(p.seats).sort(), ['d1#0', 'd1#1', 'd2#0'], 'Leo has gone, the rest stay');
  });

  it('gives up seats a shrunken desk no longer has, either way', () => {
    // This one depends on the furniture, not the roster, so it is safe even
    // when the lookup failed.
    const shrunk = fullPlan();
    shrunk.desks[1].seats = 1;
    equal(Object.keys(prunePlan(shrunk, [], false).seats).sort(), ['d1#0', 'd1#1', 'd2#0']);
  });

  it('empties the plan when the class genuinely has nobody in it', () => {
    const p = prunePlan(fullPlan(), [], true);
    equal(Object.keys(p.seats).length, 0, 'an empty class that we asked about is empty');
  });

  it('seats seven across three threes without stranding anybody', () => {
    // The reported bug: filling seats in order gives 3,3,1 and that last
    // child sits on their own all lesson.
    const { seats, standing } = finals([3, 3, 3], [0, 0, 0], 7);
    equal(seats.reduce((a, b) => a + b, 0), 7, 'everybody is seated');
    equal(standing, 0);
    equal(alone(seats), 0, 'nobody is on their own');
  });

  const empties = (seats) => seats.filter((n) => n === 0).length;

  /**
   * The best a room can be done by, by brute force over every way of
   * splitting the class across the desks — as the pair [pupils sitting alone,
   * desks left empty], compared in that order.
   *
   * Asked for as the best POSSIBLE rather than as zero, because some rooms
   * make both unavoidable: three pupils across four two-seat desks is an odd
   * number into even desks, and four pupils across three threes cannot fill
   * every table without sitting two of them on their own. Testing against the
   * genuine optimum is also what keeps the two rules honestly ordered — a
   * change that started quietly trading a lone child for a fuller room would
   * fail here rather than pass by looking plausible.
   */
  const bestPair = (caps, n) => {
    let best = null;
    const better = (a, b) => b === null || a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
    const walk = (i, left, lone, empty) => {
      if (i === caps.length) {
        if (left === 0 && better([lone, empty], best)) best = [lone, empty];
        return;
      }
      for (let take = Math.min(caps[i], left); take >= 0; take -= 1) {
        walk(i + 1, left - take, lone + (take === 1 ? 1 : 0), empty + (take === 0 ? 1 : 0));
      }
    };
    walk(0, n, 0, 0);
    return best;
  };

  it('strands as few pupils as the room allows, and then fills as many tables', () => {
    for (const caps of [[3, 3, 3], [3, 3, 3, 3], [4, 4, 4], [2, 2, 2, 2], [6, 6], [1, 3, 3], [2, 3, 4]]) {
      const total = caps.reduce((a, b) => a + b, 0);
      for (let n = 1; n <= total; n += 1) {
        const { seats, standing } = finals(caps, caps.map(() => 0), n);
        equal(standing, 0, `${n} of ${total} should all be seated`);
        equal(seats.reduce((a, b) => a + b, 0), n, `${n} of ${total} adds up`);
        assert(seats.every((s, i) => s <= caps[i]), `${n} of ${total} overfilled a desk`);
        equal([alone(seats), empties(seats)], bestPair(caps, n),
          `${n} across ${caps.join('+')} gave ${seats.join(',')} — better was possible`);
      }
    }
  });

  it('spreads the class over the tables rather than packing the first ones', () => {
    // Six across three threes: nobody is alone either way, but 3,3,0 leaves a
    // table standing empty while the class sits shoulder to shoulder.
    const { seats } = finals([3, 3, 3], [0, 0, 0], 6);
    equal(alone(seats), 0, 'still nobody on their own');
    equal(empties(seats), 0, 'and no table left out');
  });

  it('still takes an empty table over a child sitting alone', () => {
    // Four across three threes. Using every table means 2,1,1 — two children
    // on their own — so one table has to go unused.
    const { seats } = finals([3, 3, 3], [0, 0, 0], 4);
    equal(alone(seats), 0, 'nobody is stranded to fill a table');
    equal(empties(seats), 1, 'which costs one empty table, and should');
  });

  it('never seats more pupils than there are chairs', () => {
    const { seats, standing } = finals([3, 3], [0, 0], 10);
    equal(seats, [3, 3]);
    equal(standing, 4, 'the extras are reported rather than lost');
  });

  it('rescues somebody already sitting on their own', () => {
    const { seats } = finals([3, 3], [1, 0], 3);
    equal(alone(seats), 0, 'the lone pupil gets company first');
  });

  it('accepts the unavoidable rather than refusing to seat anyone', () => {
    // One pupil, or three across three twos — there is no arrangement
    // without somebody on their own, and a seat beats no seat.
    equal(finals([3, 3, 3], [0, 0, 0], 1).seats.reduce((a, b) => a + b, 0), 1);
    const five = finals([2, 2, 2], [0, 0, 0], 5);
    equal(five.standing, 0, 'all five sit down');
    equal(five.seats.reduce((a, b) => a + b, 0), 5);
    equal(alone(five.seats), 1, 'five into twos leaves exactly one on their own, and cannot do better');
  });

  it('uses single desks last, since they can only ever seat one alone', () => {
    const { seats } = finals([1, 3, 3], [0, 0, 0], 4);
    equal(seats[0], 0, 'the single desk stays empty while a table can take them');
    equal(alone(seats.filter((n) => n > 0)), 0);
  });

  // ---- not beside last time's neighbour ----

  const { _seatNeighbours: seatNeighbours, _neighbourPairs: neighbourPairs,
    _lastArrangement: lastArrangement, _seatAvoiding: seatAvoiding } = seatingDef;
  const pairs = (p) => [...neighbourPairs(p)].sort();

  it('counts deskmates and desks pushed together as neighbours, not the row in front', () => {
    const desks = [
      { id: 'a', shape: 'row', seats: 1, facing: 'up', x: 0, y: 0 },
      { id: 'b', shape: 'row', seats: 1, facing: 'up', x: 4, y: 0 },   // touching a, side by side
      { id: 'c', shape: 'row', seats: 1, facing: 'up', x: 0, y: 5 },   // directly behind a
      { id: 'd', shape: 'row', seats: 2, facing: 'up', x: 20, y: 0 },
    ];
    const edges = seatNeighbours(desks).map((e) => e.join(' ')).sort();
    equal(edges, ['a#0 b#0', 'd#0 d#1']);
  });

  it('remembers last time as the newest arrangement with most of the class in it', () => {
    const list = [
      { plan: { desks: [], seats: {} } },                       // just emptied
      { plan: { desks: [], seats: { x: 'ava', y: 'leo' } } },   // two placed by hand
      { plan: fullPlan() },
    ];
    equal(lastArrangement(list, 6).plan.seats['d1#0'], 'ava', 'two of six is not last time');
    equal(lastArrangement([], 4), null);
  });

  /** n two-seat desks in a line, far enough apart that only deskmates count. */
  const pairsRoom = (n) => ({
    desks: Array.from({ length: n }, (_, i) => ({ id: `d${i}`, shape: 'row', seats: 2, facing: 'up', x: i * 10, y: 0 })),
    seats: {}, objects: [], front: 'top',
  });
  const kids = (n) => Array.from({ length: n }, (_, i) => `k${i}`);

  it('never puts last time’s deskmates back together when the room allows it', () => {
    for (let round = 0; round < 50; round += 1) {
      const room = pairsRoom(12);
      const before = seatAvoiding(room, kids(24), new Set());
      const avoid = neighbourPairs({ ...room, seats: before.seats });
      equal(avoid.size, 12);
      const after = seatAvoiding(room, kids(24), avoid);
      equal(after.repeats, 0);
      equal(Object.keys(after.seats).length, 24, 'everybody still seated');
      assert(pairs({ ...room, seats: after.seats }).every((k) => !avoid.has(k)), 'no old pair together');
    }
  });

  it('splits tables of four too, where blind shuffling rarely manages it', () => {
    const room = {
      desks: Array.from({ length: 7 }, (_, i) => ({ id: `t${i}`, shape: 'table', seats: 4, facing: 'up', x: i * 12, y: 0 })),
      seats: {}, objects: [], front: 'top',
    };
    for (let round = 0; round < 20; round += 1) {
      const before = seatAvoiding(room, kids(28), new Set());
      const avoid = neighbourPairs({ ...room, seats: before.seats });
      equal(avoid.size, 42, 'six pairs at each of seven tables');
      equal(seatAvoiding(room, kids(28), avoid).repeats, 0);
    }
  });

  it('leaves pupils already seated where they are', () => {
    const room = pairsRoom(3);
    room.seats = { 'd0#0': 'k0' };
    const out = seatAvoiding(room, ['k1', 'k2', 'k3', 'k4', 'k5'], new Set(['k0|k1']));
    equal(out.seats['d0#0'], 'k0');
    assert(out.seats['d0#1'] !== 'k1', 'k1 does not sit back beside k0');
    equal(out.placed.length, 5);
  });

  it('owns up when the room cannot avoid a repeat', () => {
    // One desk of two, the same two children: they can only sit together.
    const room = pairsRoom(1);
    equal(seatAvoiding(room, ['k0', 'k1'], new Set(['k0|k1'])).repeats, 1);
  });
});

// ===================================================================
describe('room templates', () => {
  let saved;

  const room = {
    name: '  Room 12  ',
    front: 'left',
    desks: [
      { id: 'd1', shape: 'row', seats: 2, facing: 'left', x: 3, y: 4 },
      { id: 'd2', shape: 'round', seats: 6, facing: 'up', x: 20, y: 10 },
    ],
    objects: [{ id: 'o1', shape: 'strip', label: '  Door  ', x: 0, y: 0, w: 2, h: 12 }],
  };

  it('saves the furniture', () => {
    saved = templates.create(alice, room);
    equal(saved.name, 'Room 12', 'the name is tidied');
    equal(saved.front, 'left', 'which wall the board is on comes too');
    equal(saved.desks.length, 2);
    equal(saved.objects[0].label, 'Door');
  });

  it('never carries a pupil', () => {
    // The separation is the point: a template is reusable across classes
    // *because* nobody is in it, and it can be kept indefinitely for the
    // same reason.
    assert(!('seats' in saved), 'no seating map on the template itself');
    // A desk's own `seats` is a COUNT of chairs, which is furniture. What
    // must never appear is anybody sitting in one.
    assert(saved.desks.every((d) => typeof d.seats === 'number'), 'a desk’s seats is a number of chairs');
    const asText = JSON.stringify(saved);
    assert(!/studentKey|studentName|"students"/.test(asText), 'nothing pupil-shaped anywhere in it');
  });

  it('refuses an empty room', () => {
    throws(() => templates.create(alice, { name: 'Nothing', desks: [], objects: [] }));
  });

  it('drops furniture it does not know how to draw', () => {
    const odd = templates.create(alice, {
      name: 'Odd',
      desks: [{ shape: 'trapezoid', seats: 4 }, { shape: 'row', seats: 3, facing: 'up', x: 1, y: 1 }],
      objects: [{ shape: 'hexagon', label: 'nope' }, { shape: 'circle', x: 2, y: 2, w: 5, h: 5 }],
    });
    equal(odd.desks.length, 1, 'only the desk shape the client can draw');
    equal(odd.objects.length, 1, 'and only the object shape it can draw');
    templates.remove(alice, odd.id);
  });

  it('pulls impossible geometry back into range', () => {
    const wild = templates.create(alice, {
      name: 'Wild',
      desks: [{ shape: 'row', seats: 99, facing: 'sideways', x: -40, y: 9999 }],
      objects: [],
    });
    const d = wild.desks[0];
    assert(d.seats <= 12 && d.seats >= 1, 'seats are capped');
    equal(d.facing, 'up', 'an unknown facing falls back');
    assert(d.x >= 0 && d.y >= 0, 'no negative corners');
    templates.remove(alice, wild.id);
  });

  it('is private to the teacher who saved it', () => {
    equal(templates.get(bruno, saved.id), null, 'not Bruno’s to read');
    equal(templates.rename(bruno, saved.id, 'Mine'), null, 'nor to rename');
    equal(templates.remove(bruno, saved.id), false, 'nor to delete');
    equal(templates.listFor(bruno).length, 0);
    equal(templates.listFor(alice).length, 1);
  });

  it('renames, and deletes on the owner’s say-so', () => {
    equal(templates.rename(alice, saved.id, 'Room 12 — exams').name, 'Room 12 — exams');
    equal(templates.remove(alice, saved.id), true);
    equal(templates.listFor(alice).length, 0);
  });
});

// ===================================================================
// The packing rules, loaded into a stub of just enough browser.
describe('the grid', () => {
  const geom = loadGeometry();
  const box = (x, y, w, h, id) => ({ id: id || `${x},${y}`, x, y, w, h });

  it('knows when two cards overlap', () => {
    assert(geom.hits(box(0, 0, 4, 4), box(2, 2, 4, 4)), 'these overlap');
    assert(!geom.hits(box(0, 0, 4, 4), box(4, 0, 4, 4)), 'side by side do not');
    assert(!geom.hits(box(0, 0, 4, 4), box(0, 4, 4, 4)), 'nor stacked');
  });

  it('pushes whatever is in the way downwards', () => {
    const dragged = box(0, 0, 4, 4, 'dragged');
    const other = box(0, 0, 4, 4, 'other');
    const items = [dragged, other];
    geom.resolve(items, dragged);
    equal(dragged.y, 0, 'the card under the cursor never moves');
    assert(other.y >= 4, 'the other one gets out of the way');
    assert(!geom.hits(dragged, other), 'and nothing overlaps afterwards');
  });

  it('settles rather than shuffling for ever', () => {
    const items = Array.from({ length: 12 }, (_, i) => box(0, 0, 4, 4, `i${i}`));
    geom.resolve(items, items[0]);
    for (let a = 0; a < items.length; a += 1) {
      for (let b = a + 1; b < items.length; b += 1) {
        assert(!geom.hits(items[a], items[b]), `${items[a].id} and ${items[b].id} still overlap`);
      }
    }
  });

  it('closes the gap when a card is taken away', () => {
    const items = [box(0, 0, 4, 4, 'top'), box(0, 9, 4, 4, 'bottom')];
    geom.compact(items);
    equal(items[1].y, 4, 'the lower card rises to meet the one above');
  });

  it('does not pull a card up through another one', () => {
    const items = [box(0, 0, 6, 4, 'wide'), box(2, 8, 4, 4, 'below')];
    geom.compact(items);
    equal(items[1].y, 4, 'it stops under the wide one, not beside it');
  });

  it('finds the first free place for a new card', () => {
    const items = [box(0, 0, 8, 4)];
    equal(geom.findSpot(items, 4, 4), { x: 8, y: 0 }, 'beside it, on the same row');
    equal(geom.findSpot(items, 6, 4), { x: 0, y: 4 }, 'or underneath when it will not fit');
  });

  it('never places a new card off the right-hand edge', () => {
    const items = [box(0, 0, 12, 4)];
    const spot = geom.findSpot(items, 5, 3);
    assert(spot.x + 5 <= 12, 'inside the grid');
  });
});

// ===================================================================
describe('what a video is called', () => {
  const video = require('../server/video');
  const realFetch = global.fetch;

  const okReply = (body) => ({ ok: true, status: 200, json: async () => body });

  it('reads the title and the channel', async () => {
    let asked = null;
    global.fetch = async (url) => { asked = String(url); return okReply({ title: '  How volcanoes  form ', author_name: 'Geology Class' }); };
    try {
      const found = await video.titleFor('dQw4w9WgXcQ');
      equal(found.title, 'How volcanoes form', 'tidied on the way through');
      equal(found.channel, 'Geology Class');
      assert(asked.startsWith('https://www.youtube.com/oembed?'), 'asked oEmbed, not the Data API');
      assert(asked.includes('dQw4w9WgXcQ'), 'for that video');
    } finally { global.fetch = realFetch; }
  });

  it('never puts anything but an id in the outgoing URL', async () => {
    let asked = false;
    global.fetch = async () => { asked = true; return okReply({ title: 'nope' }); };
    try {
      for (const bad of ['', 'short', '../../etc/passwd', 'dQw4w9WgXcQ&x=1', null]) {
        equal(await video.titleFor(bad), null, `${bad} should not be looked up`);
      }
      equal(asked, false, 'and none of them reached the network');
    } finally { global.fetch = realFetch; }
  });

  it('says nothing rather than failing when YouTube will not answer', async () => {
    global.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
    try { equal(await video.titleFor('aaaaaaaaaaa'), null, 'a private video has no title here'); }
    finally { global.fetch = realFetch; }

    global.fetch = async () => { throw new Error('network is down'); };
    try { equal(await video.titleFor('bbbbbbbbbbb'), null, 'and neither does an unreachable one'); }
    finally { global.fetch = realFetch; }
  });

  it('asks once and remembers, because a title does not change', async () => {
    let asked = 0;
    global.fetch = async () => { asked += 1; return okReply({ title: 'Tides', author_name: 'Sea' }); };
    try {
      await video.titleFor('ccccccccccc');
      await video.titleFor('ccccccccccc');
      equal(asked, 1, 'the second one came from the cache');
    } finally { global.fetch = realFetch; }
  });
});

// ===================================================================
describe('a YouTube link', () => {
  const video = loadWidget('video');
  const id = video._videoId;
  const at = video._startAt;

  it('finds the video in whatever was pasted', () => {
    const want = 'dQw4w9WgXcQ';
    for (const link of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&index=2',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ?t=90',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      'youtube.com/watch?v=dQw4w9WgXcQ',
      '  dQw4w9WgXcQ  ',
    ]) equal(id(link), want, `did not read ${link}`);
  });

  it('refuses anything that is not a YouTube video', () => {
    // The point of parsing to an ID rather than passing a URL through: only
    // eleven characters of YouTube's own alphabet ever reach the iframe, so
    // there is no pasted string that becomes a frame of somewhere else.
    for (const bad of [
      '', '   ', 'not a link',
      'https://example.com/watch?v=dQw4w9WgXcQ',
      'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ',
      'javascript:alert(1)',
      'https://www.youtube.com/watch?v=../../etc/passwd',
      'https://www.youtube.com/channel/UCabcdefghijk',
      'https://youtu.be/short',
    ]) equal(id(bad), '', `${bad} should not have been accepted`);
  });

  it('picks up where the teacher meant it to start', () => {
    equal(at('https://youtu.be/dQw4w9WgXcQ?t=90'), 90);
    equal(at('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1h2m3s'), 3723);
    equal(at('https://www.youtube.com/watch?v=dQw4w9WgXcQ&start=45'), 45);
    equal(at('https://youtu.be/dQw4w9WgXcQ'), 0, 'no marker means the beginning');
    equal(at('nonsense'), 0);
  });
});

// ===================================================================
describe('what a signed-out visitor may ask of the server', () => {
  const req = (xff, remote = '10.0.0.1') => ({ headers: xff ? { 'x-forwarded-for': xff } : {}, socket: { remoteAddress: remote } });
  const res = () => { const r = { code: 200 }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };

  it('gives a visitor enough for a lesson, then stops', () => {
    visitors._reset();
    const t = 1_000_000;
    for (let i = 0; i < visitors.LIMIT; i += 1) equal(visitors.allow(req('1.2.3.4'), res(), 'weather', t), true);
    const r = res();
    equal(visitors.allow(req('1.2.3.4'), r, 'weather', t), false, 'one more is refused');
    equal(r.code, 429);
  });

  it('starts again once the window has passed', () => {
    visitors._reset();
    const t = 2_000_000;
    for (let i = 0; i <= visitors.LIMIT; i += 1) visitors.allow(req('5.6.7.8'), res(), 'video', t);
    equal(visitors.allow(req('5.6.7.8'), res(), 'video', t + visitors.WINDOW_MS + 1), true);
  });

  it('keeps each lookup and each address on its own allowance', () => {
    visitors._reset();
    const t = 3_000_000;
    for (let i = 0; i <= visitors.LIMIT; i += 1) visitors.allow(req('9.9.9.9'), res(), 'weather', t);
    equal(visitors.allow(req('9.9.9.9'), res(), 'video', t), true, 'weather used up does not use up video');
    equal(visitors.allow(req('8.8.8.8'), res(), 'weather', t), true, 'nor anybody else');
  });

  it('believes the address the proxy saw, not one the caller wrote', () => {
    // A client can put anything at the front of X-Forwarded-For. The edge
    // appends what it actually saw, so the last entry is the one to trust —
    // otherwise a scraper gets a fresh allowance by inventing an address.
    equal(visitors.addressOf(req('6.6.6.6, 203.0.113.9')), '203.0.113.9');
    equal(visitors.addressOf(req('')), '10.0.0.1', 'and falls back to the socket');
  });
});

// ===================================================================
describe("a visitor's class lists, kept in the browser", () => {
  const local = loadLocalApi();

  it('answers in the same shapes as the server', async () => {
    const store = local.make(memoryStorage());
    const list = await store.api.createList('  4B   Maths ', ['Ava B.', { name: 'Leo F.' }, '', '  ']);
    equal(list.name, '4B Maths');
    equal(list.students.length, 2, 'blank names are dropped');
    const { classes, signifyOk } = await store.api.classes();
    equal(signifyOk, true);
    equal(classes[0].key, `list:${list.id}`, 'keyed as list:<id>, like the server');
    equal(classes[0].size, 2);
    const members = await store.api.members(classes[0].key);
    equal(members.students.map((x) => x.name).join(','), 'Ava B.,Leo F.');
  });

  it('keeps a pupil the same pupil when a name is corrected', async () => {
    // Seats and groups are attached to the pupil's id, so fixing a spelling
    // must not quietly unseat them.
    const store = local.make(memoryStorage());
    const list = await store.api.createList('7C', ['Jon S.']);
    const id = list.students[0].id;
    const after = await store.api.updateList(list.id, { students: [{ id, name: 'John S.' }] });
    equal(after.students[0].id, id);
    equal(after.students[0].name, 'John S.');
  });

  it('refuses a list that is not there, the way the server does', async () => {
    const store = local.make(memoryStorage());
    let status = 0;
    try { await store.api.members('list:nope'); } catch (e) { status = e.status; }
    equal(status, 404);
  });

  it('clears everything a visitor kept after thirty days unopened', async () => {
    // On a shared classroom computer, a list of children's names should not
    // outlive the teacher who typed it.
    let now = 1_000_000_000;
    const storage = memoryStorage();
    const store = local.make(storage, () => now);
    await store.api.createList('Year 3', ['Mia D.']);
    storage.setItem('desk:guest-board:v4', '{}');
    storage.setItem('desk:something-else', 'kept');

    now += 29 * 24 * 3600 * 1000;
    equal(store.expireIfStale(), false, 'twenty-nine days is fine');
    now += 31 * 24 * 3600 * 1000;
    equal(store.expireIfStale(), true, 'thirty-one days since last opened is not');
    equal((await store.api.classes()).classes.length, 0, 'the lists are gone');
    equal(storage.getItem('desk:guest-board:v4'), null, 'and so is the board');
    equal(storage.getItem('desk:something-else'), 'kept', "but nothing that is not the visitor's");
  });

  it('counts opening the desk as using it', () => {
    let now = 2_000_000_000;
    const storage = memoryStorage();
    const store = local.make(storage, () => now);
    store.expireIfStale();                        // first visit, timers only
    now += 20 * 24 * 3600 * 1000; store.expireIfStale();
    now += 20 * 24 * 3600 * 1000;
    equal(store.expireIfStale(), false, 'forty days old, but opened twenty days ago');
  });

  it('makes an example class of twenty different made-up children', () => {
    const names = local.exampleNames(20);
    equal(names.length, 20);
    equal(new Set(names.map((n) => n.split(' ')[0])).size, 20, 'no first name twice');
    // First name and an initial — the form the class-list editor suggests,
    // so the example teaches the habit instead of contradicting it.
    equal(names.every((n) => /^[A-Z][a-z]+ [A-Z]\.$/.test(n)), true, names.join(', '));
  });

  it('gives a visitor the example once, and never offers it for their account', async () => {
    const storage = memoryStorage();
    const store = local.make(storage);
    const first = store.seedExample(local.exampleNames(20));
    equal(first.students.length, 20);
    equal(store.seedExample(local.exampleNames(20)), null, 'not twice');

    // Made-up names must not be offered for moving into a real account.
    equal(store.lists().length, 0);
    equal(store.hasLists(), false);

    // Deleted, it stays deleted — the visitor decided they did not want it.
    await store.api.deleteList(first.id);
    equal(store.seedExample(local.exampleNames(20)), null);
    equal((await store.api.classes()).classes.length, 0);
  });

  it('treats an example the visitor has made their own as theirs', async () => {
    const store = local.make(memoryStorage());
    const ex = store.seedExample(local.exampleNames(20));
    await store.api.updateList(ex.id, { name: 'My 3B' });
    equal(store.lists().length, 1, 'renamed, it is offered for keeping');
  });

  it('does not add an example to a desk that already has lists', async () => {
    const store = local.make(memoryStorage());
    await store.api.createList('Real class', ['Ada L.']);
    equal(store.seedExample(local.exampleNames(20)), null);
  });

  it('saves groups and rooms with the same limits as an account', async () => {
    const store = local.make(memoryStorage());
    let refusedEmpty = false;
    try { await store.api.saveGrouping({ groups: [] }); } catch { refusedEmpty = true; }
    equal(refusedEmpty, true);
    const g = await store.api.saveGrouping({ classKey: 'list:x', groups: [{ label: 'A', members: [{ key: 's1', name: 'Ava' }] }] });
    equal((await store.api.groupings('list:x')).groupings[0].id, g.id);
    const room = await store.api.saveTemplate({ name: 'Room 12', desks: [{ shape: 'table', seats: 4, x: 3, y: 2 }, { shape: 'sofa' }] });
    equal(room.desks.length, 1, 'an unknown desk shape is dropped');
  });
});

// ===================================================================
describe("bringing a visitor's desk into an account", () => {
  const { carryOver } = loadLocalApi();
  const { below, MAX_ITEMS } = loadGeometry();
  const defs = { notes: { size: { w: 4, h: 4 }, min: { w: 2, h: 3 } }, seating: { size: { w: 6, h: 6 }, min: { w: 4, h: 5 } }, timer: { size: { w: 3, h: 4 }, min: { w: 2, h: 3 } } };
  const defOf = (t) => defs[t] || null;
  const moved = new Map([['list_real', { id: 'list_NEW', students: new Map([['s_ada', 's_ADA'], ['s_ben', 's_BEN']]) }]]);

  it('rewrites a seating plan to the new list and the same children', () => {
    const [seat] = carryOver([{ id: 'g_seating', type: 'seating', x: 0, y: 0, w: 6, h: 6, state: {
      classKey: 'list:list_real',
      plans: { 'list:list_real': { seats: { d1a: 's_ada', d1b: 's_ben' } }, 'list:list_example': { seats: { d1a: 's_zed' } } },
    } }], { moved });
    equal(seat.state.classKey, 'list:list_NEW');
    equal(JSON.stringify(Object.keys(seat.state.plans)), '["list:list_NEW"]', "the example class's plan stays behind");
    equal(seat.state.plans['list:list_NEW'].seats.d1b, 's_BEN', 'the same child in the same seat');
  });

  it('never brings the example class’s pupils into an account', () => {
    const out = carryOver([
      { id: 'g_groups', type: 'groups', state: { classKey: 'list:list_example', groups: [{ members: [{ key: 's_zed', name: 'Zed Q.' }] }] } },
      { id: 'w_mine', type: 'groups', state: { classKey: 'list:list_example', groups: [{ members: [{ key: 's_zed', name: 'Zed Q.' }] }] } },
    ], { moved, worth: () => true });
    equal(out.length, 1, 'the starter copy stays behind; the one they added comes');
    equal(JSON.stringify(out[0].state), '{}', 'and it comes fresh, without the strangers in it');
  });

  it('leaves the untouched starter tools behind and brings what holds something', () => {
    const out = carryOver([
      { id: 'g_timer', type: 'timer', state: {} },
      { id: 'g_notes', type: 'notes', state: { text: 'Bring PE kit' } },
      { id: 'w_x1', type: 'timer', state: {} },
    ], { moved, worth: (i) => !!(i.state.text) });
    equal(out.map((i) => `${i.type}:${i.state.text || ''}`).join(','), 'notes:Bring PE kit,timer:');
  });

  it('adds tools under the desk without moving anything already on it', () => {
    const existing = [{ id: 'a', type: 'notes', x: 0, y: 0, w: 4, h: 4 }, { id: 'b', type: 'timer', x: 4, y: 2, w: 3, h: 6 }];
    const before = JSON.stringify(existing);
    const placed = below(existing, [
      { type: 'notes', x: 0, y: 9, w: 4, h: 4 }, { type: 'timer', x: 8, y: 20, w: 3, h: 4 }, { type: 'mystery', x: 0, y: 0, w: 2, h: 2 },
    ], defOf);
    equal(JSON.stringify(existing), before, 'the teacher’s own cards are untouched');
    equal(placed.length, 2, 'a tool this version does not know is left out');
    equal(Math.min(...placed.map((p) => p.y)), 8, 'starting where the desk ends');
    equal(placed[1].y, 8, 'and closed up among themselves');
    equal(new Set(placed.map((p) => p.id)).size, 2, 'with fresh ids of their own');
  });

  it('takes no more than the desk has room for', () => {
    const full = Array.from({ length: MAX_ITEMS - 1 }, (_, i) => ({ id: `x${i}`, type: 'timer', x: 0, y: i * 4, w: 3, h: 4 }));
    equal(below(full, [{ type: 'timer' }, { type: 'notes' }], defOf).length, 1);
  });
});

// ===================================================================
describe('the clock', () => {
  const clock = loadWidget('clock');
  it('starts digital, and moves an older clock with hands to digital once', () => {
    const fresh = {}; clock.init(fresh);
    equal(fresh.face, 'digital');
    const older = { face: 'analogue' }; clock.init(older);
    equal(older.face, 'digital', 'hands only because that used to be the default');
  });
  it('keeps hands that somebody chose', () => {
    const chosen = { face: 'analogue', facePicked: true }; clock.init(chosen);
    equal(chosen.face, 'analogue');
  });
});

// ===================================================================
describe('copying the groups', () => {
  const w = loadWidget('groups');
  const gs = [
    { label: 'Group A', members: [{ name: 'Ada' }, { name: 'Ben' }] },
    { label: 'Group B', members: [{ name: 'Cy <3' }] },
  ];
  it('pastes as headings and names in plain text', () => {
    equal(w._asText(gs, 'Science'), 'Science\n\nGroup A\n- Ada\n- Ben\n\nGroup B\n- Cy <3');
    equal(w._asText(gs, ''), 'Group A\n- Ada\n- Ben\n\nGroup B\n- Cy <3');
  });
  it('pastes as a table with a column per group, names escaped', () => {
    const h = w._asHtml(gs, 'Science');
    equal((h.match(/<tr>/g) || []).length, 3, 'a head row and two name rows');
    equal(h.includes('Cy &lt;3') && !h.includes('Cy <3'), true, 'escaped');
    equal(h.includes('<b>Science</b>'), true);
  });
});

// ===================================================================
describe('the word count', () => {
  const count = loadWidget('wordcount')._count;
  it('counts words, sentences and paragraphs', () => {
    const c = count('One two three. Four five!\n\nSix');
    equal(c.words, 6);
    equal(c.sentences, 3);
    equal(c.paragraphs, 2);
  });
  it('counts characters with and without spaces', () => {
    const c = count('a b\nc');
    equal(c.chars, 5);
    equal(c.charsNoSpaces, 3);
  });
  it('survives empty and whitespace-only text', () => {
    const c = count('  \n ');
    equal(c.words, 0);
    equal(c.sentences, 0);
    equal(c.paragraphs, 0);
    equal(count(null).words, 0);
  });
  it('reads 238 words in a minute', () => {
    equal(count(Array(238).fill('w').join(' ')).seconds, 60);
  });
});

describe('the passage grader', () => {
  const w = loadWidget('passage');
  const grade = w._grade;
  const R = (o = {}) => ({ punctuation: 'ignore', capitals: 'ignore', spelling: 'exact', ...o });
  const PSALM = 'The Lord is my shepherd; I shall not want.';

  it('counts a scripture reference as three points: book, chapter, verses', () => {
    const verse = 'Trust in the Lord. Proverbs 3: 7, 8';
    const r = grade(verse, 'trust in the lord proverbs 3:7,8', R());
    equal(r.total, 7, 'four words and the reference as three');
    equal(r.score, 7);
    equal(grade('Love one another. 1 John 3:11', 'love one another 1 john 3:11', R()).total, 6, 'a numbered book is one point');
    equal(grade('Song of Solomon 2:4', 'song of solomon 2:4', R()).total, 3, 'a book of several words is one point');
    equal(grade('Be kind. Eph 4:32', 'Be kind. Eph 4', R()).score, 4, 'missing verse costs one point');
  });

  it('sees through hidden characters when marking, and reports them', () => {
    const lord = 'The L\u043Erd is my sh\u200Bepherd, I shall not want.';
    const r = grade(PSALM, lord, R());
    equal(r.score, 9, 'a pasted word is still the right word');
    const seen = w._inspect(lord, r);
    equal(seen.hidden, 2, 'one letter from another alphabet, one invisible character');
    equal(w._inspect('The Lord is my shepherd I shall not want', grade(PSALM, 'The Lord is my shepherd I shall not want', R())).hidden, 0, 'typed text is clean');
    const swapped = grade(PSALM, 'The Lord is my shepherd, l shall not want.', R());
    equal(swapped.score, 9, 'an l for the I is the right word');
    equal(swapped.tally.lookalike, 1, 'and is reported');
    equal(w._inspect('x', swapped).looks, 1);
    const told = w._hiddenList(lord, r);
    equal(told.length, 2, 'each hidden character is listed');
    equal(`${told[0].before}[${told[0].ch}]${told[0].after}`, 'L[\u043E]rd', 'with the word it sits in');
    assert(/Cyrillic/.test(told[0].say) && /U\+043E/.test(told[0].say), 'and what it is');
    assert(told[1].invisible && told[1].before === 'sh' && /zero-width space/.test(told[1].say), 'an invisible one says where it is');
    const swap = w._hiddenList('x', swapped);
    assert(swap.length === 1 && /small l where the passage has a capital I/.test(swap[0].say), 'a swapped letter is named');
  });

  it('makes versions that read the same, differ in characters, and trace back', () => {
    const text = 'Trust in the Lord with all your heart and lean not on your own understanding. Proverbs 3:5';
    const a = w._makeCopy(text, 11, 'medium');
    const b = w._makeCopy(text, 11, 'medium');
    const c = w._makeCopy(text, 12, 'medium');
    assert(a.text !== text && a.count >= 3, 'something was planted');
    equal(a.text, b.text, 'the same seed makes the same version');
    assert(c.text !== a.text, 'another seed makes another');
    equal(grade(text, a.text, R()).percent, 100, 'every version marks as the full passage');
    equal(grade(a.text, text, R()).percent, 100, 'and a version can itself be set as the passage');
    const seen = w._inspect(a.text, grade(text, a.text, R()));
    assert(seen.hidden + seen.looks >= 1, 'it is noticed when pasted');
    const traced = w._tracedTo(seen.ids, [c, a]);
    equal(traced.length === 1 && traced[0].index, 1, 'and traced to the copy it came from');
  });

  it('gives full marks for the passage word for word', () => {
    const r = grade(PSALM, 'the lord is my shepherd i shall not want', R());
    equal(`${r.score}/${r.total}`, '9/9', 'punctuation and capitals ignored');
    equal(r.percent, 100);
  });

  it('counts a skipped word once, without knocking the rest out of line', () => {
    const r = grade(PSALM, 'The Lord is shepherd I shall not want', R());
    equal(`${r.score}/${r.total}`, '8/9');
    equal(r.tally.missing, 1);
  });

  it('shows added words but does not take marks for them', () => {
    const r = grade(PSALM, 'The Lord is my good shepherd I shall not want want', R());
    equal(r.score, 9);
    equal(r.tally.extra, 2);
  });

  it('marks words out of order as the ones that are out of place', () => {
    const r = grade('one two three four five', 'one two four three five', R());
    equal(r.score, 4, 'one of the swapped pair cannot line up');
  });

  it('marks a near miss by the spelling rule', () => {
    const typed = 'The Lord is my shepard I shall not want';
    equal(grade(PSALM, typed, R({ spelling: 'exact' })).score, 8, 'exact: nothing for it');
    equal(grade(PSALM, typed, R({ spelling: 'half' })).score, 8.5, 'half credit');
    equal(grade(PSALM, typed, R({ spelling: 'forgive' })).score, 9, 'forgiven');
    equal(grade(PSALM, typed, R()).tally.spelling, 1, 'and it is called a spelling slip, not a missing word');
  });

  it('never calls a different short word a misspelling', () => {
    equal(w._kinship('is', 'it'), null);
    equal(w._kinship('the', 'teh'), 'spelling', 'but two letters swapped is a typo');
    equal(w._kinship('shepherd', 'shepperd'), 'spelling');
    equal(w._kinship('shepherd', 'sheep'), null);
  });

  it('marks capitals only when asked, and does not forgive them as typos', () => {
    const typed = 'the lord is my shepherd I shall not want';
    equal(grade(PSALM, typed, R()).score, 9, 'ignored');
    equal(grade(PSALM, typed, R({ capitals: 'count' })).score, 7, 'the and lord lose their marks');
    equal(grade(PSALM, typed, R({ capitals: 'count', spelling: 'forgive' })).score, 7, 'forgiving typos is not forgiving capitals');
    equal(grade(PSALM, typed, R({ capitals: 'count', spelling: 'half' })).score, 8, 'half credit for each');
  });

  it('makes each punctuation mark a point when punctuation is marked', () => {
    const r = grade(PSALM, 'The Lord is my shepherd, I shall not want.', R({ punctuation: 'count' }));
    equal(r.total, 11, 'nine words, a semicolon and a full stop');
    equal(r.score, 10, 'a comma is not a semicolon');
    equal(`${r.marks.got}/${r.marks.total}`, '1/2');
  });

  it('reads curly quotes, long dashes and apostrophes the way pupils type them', () => {
    const passage = '“Surely goodness—and mercy,” the Lord’s word said…';
    equal(grade(passage, '"Surely goodness - and mercy," the Lord\'s word said...', R({ punctuation: 'count' })).percent, 100);
    equal(grade(passage, 'Surely goodness and mercy the Lords word said', R()).percent, 100, 'ignoring punctuation ignores the apostrophe too');
  });

  it('counts words the same way on both sides, punctuation never included', () => {
    equal(w._wordCount(PSALM), 9);
    equal(w._wordCount('The Lord’s — my shepherd... well-being!'), 5, 'a dash is not a word; an apostrophe or hyphen does not split one');
    equal(w._wordCount('   '), 0);
  });

  it('lets the teacher count a marked-down word right, or a forgiven one wrong', () => {
    const typed = 'The Lord is my shepard I shall not';          // shepherd near, want missing
    const base = grade(PSALM, typed, R({ spelling: 'half' }));
    equal(base.score, 7.5);
    const near = base.steps.find((x) => x.is === 'spelling').pos;
    const gone = base.steps.find((x) => x.is === 'missing').pos;
    equal(`${near},${gone}`, 'w4,w8', 'positions are the words’ places in the passage');
    const fixed = grade(PSALM, typed, R({ spelling: 'half' }), { [near]: 1, [gone]: 1 });
    equal(fixed.score, 9);
    equal(fixed.tally.changed, 2);
    equal(grade(PSALM, typed, R({ spelling: 'forgive' }), { [near]: 0 }).score, 7, 'a forgiven word counted wrong');
  });

  it('keeps a decision on the same word when punctuation starts to count', () => {
    // "want" comes after the semicolon, so counting the semicolon as a step
    // must not move which word "w8" means.
    const typed = 'The Lord is my shepherd; I shall not wnat.';
    const r = grade(PSALM, typed, R({ punctuation: 'count' }), { w8: 1 });
    equal(r.steps.find((x) => x.want && x.want.text === 'want').credit, 1);
    equal(r.score, r.total);
  });

  it('never lets an override touch a word the pupil got right', () => {
    equal(grade(PSALM, 'The Lord is my shepherd I shall not want', R(), { w0: 0 }).score, 9);
  });

  it('counts an added word against the pupil only when the teacher says so', () => {
    const typed = 'The Lord is my good shepherd I shall not want';   // "good" is the answer's 5th word
    const r = grade(PSALM, typed, R());
    const added = r.steps.find((x) => x.is === 'extra');
    equal(`${added.got.text}:${added.pos}`, 'good:x4', 'placed by where it sits in the answer');
    equal(r.score, 9, 'free to begin with');
    const counted = grade(PSALM, typed, R(), { x4: 1 });
    equal(counted.score, 8, 'minus one');
    equal(counted.cost, 1);
    equal(counted.tally.changed, 1);
    // A comma earlier in the answer must not move which word "x4" means.
    const withMarks = grade(PSALM, 'The Lord, is my good shepherd; I shall not want.', R({ punctuation: 'count' }), { x4: 1 });
    equal(`${withMarks.score}/${withMarks.total}`, '10/11', 'still "good" when punctuation counts');
  });

  it('never takes a score below nothing', () => {
    equal(grade('one', 'two three', R(), { x0: 1, x1: 1 }).score, 0);
  });

  it('keeps only well-formed decisions', () => {
    equal(JSON.stringify(w._cleanOverrides({ w3: 1, m2: 0, x1: 1, z1: 1, w4: 'yes', w5: 0.5, __proto__: { w9: 1 } })), '{"w3":1,"m2":0,"x1":1}');
    equal(JSON.stringify(w._cleanOverrides(null)), '{}');
  });

  it('gives nothing for an empty answer, and survives an empty passage', () => {
    equal(grade(PSALM, '', R()).score, 0);
    equal(grade('', 'anything', R()).total, 0);
    equal(grade('', 'anything', R()).percent, 0);
  });

  it('keeps saved answers tidy and within bounds', () => {
    const s = { results: [{ id: 'a', name: 'Ava', answer: 'x'.repeat(9000) }, { name: 'no id', answer: 'y' }, null] };
    w.init(s);
    equal(s.results.length, 1);
    equal(s.results[0].answer.length, 3000);
    equal(s.spelling, 'half', 'half credit to start');
  });
});

// ===================================================================
describe('the noise meter', () => {
  const colour = loadWidget('noise')._noiseColour;

  it('is green when the room is quiet, red once it is past the line', () => {
    equal(colour(0, 55).background, '#1b7f4b');
    equal(colour(15, 55).background, '#1b7f4b', 'still green a quarter of the way up');
    equal(colour(55, 55).background, '#ec3013', 'red at the line');
    equal(colour(90, 55).background, '#ec3013', 'and past it');
  });

  it('is yellow three-quarters of the way to the line', () => {
    equal(colour(55 * 0.75, 55).background, '#f5c400');
  });

  it('follows the line the teacher set, not a fixed loudness', () => {
    // The same level is calm in a room whose line is high and loud in one
    // whose line is low.
    equal(colour(40, 90).background, colour(20, 45).background);
  });

  it('puts dark ink on the yellow and white on the green and red', () => {
    equal(colour(0, 55).ink, '#ffffff');
    equal(colour(55 * 0.75, 55).ink, '#201e1d');
    equal(colour(60, 55).ink, '#ffffff');
  });
});

// ===================================================================
describe('the scoreboard', () => {
  const board = loadWidget('scoreboard');

  it('starts with each team the colour it is named after', () => {
    const s = {};
    board.init(s);
    const byName = Object.fromEntries(s.teams.map((t) => [t.name, t.colour]));
    equal(byName.Red, 'red');
    equal(byName.Blue, 'accent', 'blue is the accent — the class colour');
    equal(byName.Green, 'green');
    equal(byName.Yellow, 'yellow');
  });

  it('puts right a board saved when the names and colours disagreed', () => {
    // Every board made before this fix had Red in blue and Blue in green.
    const s = { teams: [
      { id: 'a', name: 'Red', score: 3, colour: 'accent' },
      { id: 'b', name: 'Blue', score: 1, colour: 'green' },
      { id: 'c', name: 'The Owls', score: 2, colour: 'purple' },
    ] };
    board.init(s);
    equal(s.teams[0].colour, 'red');
    equal(s.teams[1].colour, 'accent');
    equal(s.teams[2].colour, 'purple', 'a team with its own name keeps its own colour');
    equal(s.teams[0].score, 3, 'and nobody loses a point');
  });
});

// ===================================================================
describe('saved links', () => {
  const links = loadWidget('links');
  const clean = links._cleanUrl;

  it('keeps an ordinary web address, and gives a bare one https', () => {
    equal(clean('https://www.bbc.co.uk/bitesize'), 'https://www.bbc.co.uk/bitesize');
    equal(clean('  bbc.co.uk/bitesize  '), 'https://bbc.co.uk/bitesize');
    equal(clean('http://example.com'), 'http://example.com/');
  });

  it('refuses anything that is not a web page', () => {
    // A link on the board is tapped in front of a class. It must only ever go
    // to a web page — never run script, never open a file or a data blob.
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>x</script>',
      'file:///etc/passwd', 'vbscript:msgbox', 'ftp://example.com', 'mailto:a@b.co']) {
      equal(clean(bad), null, bad);
    }
  });

  it('refuses things that are not addresses at all', () => {
    for (const bad of ['', '   ', null, undefined, 'hello', 'not a url', 'https://', 'x'.repeat(2100)]) {
      equal(clean(bad), null, String(bad).slice(0, 20));
    }
  });

  it('will not save a password that was pasted in with the address', () => {
    // It would sit in the board's saved state and be shown on the projector.
    equal(clean('https://teacher:hunter2@example.com/'), null);
  });

  it('drops a saved link that no longer passes, rather than drawing it', () => {
    const s = { links: [
      { id: 'a', url: 'https://example.com/', title: 'Fine' },
      { id: 'b', url: 'javascript:alert(1)', title: 'Tampered' },
      { id: '', url: 'https://example.org/', title: 'No id' },
    ] };
    links.init(s);
    equal(s.links.length, 1);
    equal(s.links[0].title, 'Fine');
  });

  it('names an unnamed link after its site', () => {
    equal(links._nameFor('https://www.bbc.co.uk/'), 'bbc.co.uk');
    equal(links._nameFor('https://quizlet.com/join/'), 'quizlet.com/join');
  });
});

// ===================================================================
describe('the calculator', () => {
  const calc = loadWidget('calculator');
  const ev = calc._evaluate;
  const show = calc._show;
  const M = '\u00d7'; const D = '\u00f7'; const S = '\u2212';

  it('adds up', () => {
    equal(ev('2+3'), 5);
    equal(ev(`9${S}4`), 5);
    equal(ev(`6${M}7`), 42);
    equal(ev(`8${D}2`), 4);
  });

  it('does times and divide before plus and minus', () => {
    // Not a preference. In a maths lesson this is the thing being taught, and
    // a calculator that answers 20 to this one is teaching the wrong thing.
    equal(ev(`2+3${M}4`), 14);
    equal(ev(`2${M}3+4`), 10);
    equal(ev(`10${S}6${D}2`), 7);
    equal(ev(`1+2${M}3+4`), 11);
  });

  it('handles decimals, percentages and negatives', () => {
    equal(ev('0.1+0.2'), 0.30000000000000004, 'raw arithmetic is what it is');
    equal(show(ev('0.1+0.2')), '0.3', 'and the display tidies it');
    equal(ev('50%'), 0.5);
    equal(ev(`200${M}10%`), 20);
    equal(ev(`${S}5+8`), 3);
  });

  it('refuses a sum that is not finished, rather than guessing', () => {
    for (const bad of ['', '  ', '2+', `${M}5`, '2++3', '2 3', 'abc', '2+&', '.', `2${M}${D}3`]) {
      equal(ev(bad), null, `"${bad}" should not evaluate`);
    }
  });

  it('will not divide by zero', () => {
    equal(ev(`5${D}0`), null, 'no Infinity on the board');
    equal(ev(`5${D}0+1`), null);
  });

  it('never runs what it is given', () => {
    // The tokeniser is the only route from characters to a number, so a string
    // that is not arithmetic has nowhere to go.
    for (const nasty of ['alert(1)', '1;alert(1)', 'process.exit()', '__proto__', '1e400']) {
      const got = ev(nasty);
      assert(got === null || Number.isFinite(got), `${nasty} → ${got}`);
    }
  });

  it('shows an answer the way a person would write it', () => {
    equal(show(5), '5');
    equal(show(1 / 3), '0.333333333333');
    equal(show(-0), '0');
    assert(show(1e15).includes('10^'), 'very large numbers go to powers of ten');
  });

  it('does the scientific things', () => {
    equal(ev('2^3'), 8);
    equal(ev('-2^2'), -4, 'a minus in front is applied after the power, as written');
    equal(ev('2^-2'), 0.25);
    equal(ev('2^3^2'), 512, 'powers stack from the right');
    equal(ev('(1+2)(3+4)'), 21, 'brackets side by side multiply');
    equal(ev('2\u03c0'), 2 * Math.PI);
    equal(ev('\u221a(16)'), 4);
    equal(ev('5!'), 120);
    equal(ev('nCr(5,2)'), 10);
    equal(ev('nPr(5,2)'), 20);
    equal(ev('log(1000)'), 3);
    equal(ev('ln(e)'), 1);
    equal(ev('max(1,7,3)'), 7);
    equal(ev('(1+2'), 3, 'an open bracket closes itself, as on a TI');
    equal(ev('ans+1', { ans: 4 }), 5);
    equal(ev('x^2', { x: 3 }), 9);
    equal(ev('x^2'), null, 'x means nothing without a value');
  });

  it('is exact in degrees at the angles a class checks first', () => {
    equal(ev('sin(30)') && show(ev('sin(30)')), '0.5');
    equal(ev('sin(180)'), 0, 'not 1.2e-16');
    equal(ev('cos(90)'), 0);
    equal(ev('cos(180)'), -1);
    equal(ev('tan(45)') && show(ev('tan(45)')), '1');
    equal(ev('tan(90)'), null, 'no answer, rather than a huge one');
    equal(ev('asin(1)'), 90);
    equal(show(ev('sin(\u03c0/6)', { angle: 'rad' })), '0.5');
    equal(ev('sin(\u03c0)', { angle: 'rad' }), 0);
  });

  it('refuses what is not maths, however it got there', () => {
    for (const bad of ['sin(', '5!!!!x', '2+*3', 'sqrt(-1)', 'ln(0)', 'log(5,1)', '3(', ')', 'pi pi pi pi(', 'fact(3)', 'sin(1,2)', 'constructor', 'toString()', 'x'.repeat(500)]) {
      const got = ev(bad);
      assert(got === null || Number.isFinite(got), `"${bad.slice(0, 20)}" gave ${got}`);
    }
    equal(ev('sqrt(-1)'), null);
    equal(ev('ln(0)'), null);
    equal(ev('(' .repeat(300) + '1' + ')'.repeat(300)), null, 'absurd nesting is refused, not a stack overflow');
  });

  it('cleans what is typed or pasted down to maths', () => {
    equal(calc._clean('2*3/4-1'), '2\u00d73\u00f74\u22121', 'keys are drawn as the keypad draws them');
    equal(calc._clean('2*3/4-1', false, true), '2*3/4-1', 'but a function box is left as typed');
    equal(calc._clean('\u00a31,234 <b>x</b>\n+ 2').includes('<'), false);
    equal(calc._cleanPaste('1,234,567'), '1234567', 'a spreadsheet number loses its separators');
    equal(calc._cleanPaste(' 1,234.50 '), '1234.50');
    equal(calc._cleanPaste('max(1,2)'), 'max(1,2)', 'but an argument comma stays');
    equal(calc._cleanPaste('4 \u00d7 5\n'), '4 \u00d7 5');
    equal(ev(calc._cleanPaste('$12.50 * 3')), 37.5);
  });

  it('draws a function with gaps where there is no number', () => {
    const y = calc._compileY('1/x', 'rad');
    assert(!Number.isFinite(y.f(0)), 'a gap at zero');
    equal(y.f(4), 0.25);
    equal(calc._compileY('  ', 'rad'), null, 'an empty line is not an error');
    assert(calc._compileY('2 +', 'rad').bad, 'a half-typed one is');
    equal(calc._compileY('y1=x+1', 'rad').f(2), 3, 'a leading "y=" is fine');
  });

  it('finds zeros, highs and lows, slope and area', () => {
    const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= (tol || 1e-6), `${msg || ''} ${a} vs ${b}`);
    const zs = calc._roots((x) => x * x - 4, -10, 10);
    equal(zs.length, 2); near(zs[0], -2); near(zs[1], 2);
    const touch = calc._roots((x) => x * x, -10, 10);
    equal(touch.length, 1, 'a zero that only touches the axis is still a zero'); near(touch[0], 0);
    equal(calc._roots((x) => 1 / x, -10, 10).length, 0, 'a jump through zero is not a zero');
    equal(calc._roots((x) => Math.tan(x), -1, 1).length, 1);
    const lo = calc._extrema((x) => x * x - 3, -10, 10, 'min');
    equal(lo.length, 1); near(lo[0], 0, 1e-9);
    const hi = calc._extrema(Math.sin, -7, 7, 'max');
    equal(hi.length, 2); near(hi[1], Math.PI / 2, 1e-7);
    equal(calc._extrema((x) => x, -5, 5, 'max').length, 0, 'a straight line has no peak');
    near(calc._derivative((x) => x * x * x, 2), 12, 1e-6);
    near(calc._integrate(Math.sin, 0, Math.PI), 2, 1e-6);
    equal(calc._integrate((x) => 1 / x, -1, 1), null, 'no area across a gap');
    equal(calc._niceStep(3.3), 2); equal(calc._niceStep(80), 100);
  });

  it('draws parametric and polar curves', () => {
    const near = (a, b, tol) => assert(Math.abs(a - b) <= (tol || 1e-9), `${a} vs ${b}`);
    const circle = calc._compileCurve('param', { x: 'cos(t)', y: 'sin(t)' }, 'rad');
    const q = circle.f(Math.PI / 2);
    near(q.x, 0); near(q.y, 1);
    equal(calc._compileCurve('param', { x: '', y: '' }, 'rad'), null, 'an empty pair is not an error');
    assert(calc._compileCurve('param', { x: 'cos(t)', y: '' }, 'rad').bad, 'half a pair is');
    assert(calc._compileCurve('polar', { expr: '2 +' }, 'rad').bad);

    // r = 2 is a circle of radius 2, and the θ symbol works as well as "theta".
    const ring = calc._compileCurve('polar', { expr: '2' }, 'rad');
    near(ring.f(1).r, 2); near(Math.hypot(ring.f(1).x, ring.f(1).y), 2);
    const heart = calc._compileCurve('polar', { expr: '1+cos(\u03b8)' }, 'rad');
    near(heart.f(0).x, 2); near(heart.f(Math.PI).r, 0);

    // In degrees θ = 90 is straight up, exactly — not 6e-17 off.
    const deg = calc._compileCurve('polar', { expr: '3' }, 'deg');
    equal(deg.f(90).x, 0); equal(deg.f(90).y, 3);

    const pts = calc._sampleCurve(circle.f, { min: 0, max: 2 * Math.PI, step: 0.05 });
    near(pts[pts.length - 1][0], 2 * Math.PI, 1e-12);
    assert(calc._sampleCurve(circle.f, { min: 0, max: 1, step: 0 }).length === 0, 'a zero step draws nothing rather than hanging');
    assert(calc._sampleCurve(circle.f, { min: 0, max: 1e9, step: 1e-9 }).length <= 20001, 'and a huge range is capped');

    // Length and swept area of a unit circle, from the samples alone.
    const fine = calc._sampleCurve(circle.f, { min: 0, max: 2 * Math.PI, step: 0.001 });
    const tot = calc._curveTotals(fine, 0, 2 * Math.PI + 1);
    near(tot.length, 2 * Math.PI, 1e-4);
    near(tot.area, Math.PI, 1e-4);
    const cardioid = calc._sampleCurve(heart.f, { min: 0, max: 2 * Math.PI, step: 0.001 });
    near(calc._curveTotals(cardioid, 0, 7).area, 1.5 * Math.PI, 1e-3);

    equal(ev('t^2'), null, 't means nothing on the calculator itself');
    equal(ev('2\u03b8'), null);
  });
});

// ===================================================================
describe('a music link', () => {
  const music = loadWidget('music');
  const parse = music._parse;
  const embed = music._embedUrl;
  const urlFor = (link) => embed(parse(link));

  it('reads a Spotify link, however it was copied', () => {
    const id = '37i9dQZF1DXcBWIGoYBM5M';
    for (const link of [
      `https://open.spotify.com/playlist/${id}`,
      `https://open.spotify.com/playlist/${id}?si=abc123`,
      `https://open.spotify.com/intl-de/playlist/${id}`,
      `spotify:playlist:${id}`,
    ]) {
      const got = parse(link);
      equal(got && got.service, 'spotify', link);
      equal(got.kind, 'playlist');
      equal(got.id, id);
    }
    equal(urlFor(`https://open.spotify.com/track/${id}`), `https://open.spotify.com/embed/track/${id}`);
  });

  it('reads Apple Music, keeping the country it was shared from', () => {
    const got = parse('https://music.apple.com/gb/playlist/chill-mix/pl.u-abc123');
    equal(got.service, 'apple');
    equal(got.kind, 'playlist');
    equal(got.extra.country, 'gb');
    equal(embed(got), 'https://embed.music.apple.com/gb/playlist/chill-mix/pl.u-abc123');
  });

  it('reads SoundCloud, and builds the player URL from the parts', () => {
    const got = parse('https://soundcloud.com/artist/a-track');
    equal(got.service, 'soundcloud');
    equal(got.id, 'artist/a-track');
    assert(embed(got).startsWith('https://w.soundcloud.com/player/?'), 'the official player');
    assert(embed(got).includes(encodeURIComponent('https://soundcloud.com/artist/a-track')), 'with the permalink encoded');
    assert(embed(got).includes('auto_play=false'), 'and never autoplaying');
  });

  it('reads YouTube Music, songs and playlists alike', () => {
    equal(parse('https://music.youtube.com/watch?v=dQw4w9WgXcQ').kind, 'video');
    const list = parse('https://music.youtube.com/playlist?list=PLabcdefghijklmnop');
    equal(list.kind, 'playlist');
    assert(embed(list).startsWith('https://www.youtube-nocookie.com/embed/videoseries?'), 'through the no-cookie host');
  });

  it('refuses anything that is not one of the four', () => {
    // Only a known host and a validated id ever reach an iframe on this
    // origin, so no pasted string can become a frame of somewhere else.
    for (const bad of [
      '', '   ', 'not a link',
      'https://evil.test/playlist/37i9dQZF1DXcBWIGoYBM5M',
      'https://open.spotify.com.evil.test/playlist/abc',
      'https://open.spotify.com/wat/abc',
      'https://music.apple.com/us/playlist/slug',
      'javascript:alert(1)',
      'https://soundcloud.com/a/b/c/d/e',
    ]) equal(parse(bad), null, `${bad} should not have been accepted`);
  });

  it('never lets a query string ride along into the embed', () => {
    const got = parse('https://soundcloud.com/artist/track?secret=1&x=2');
    equal(got.id, 'artist/track', 'the query is dropped, not carried');
  });
});

// ===================================================================
describe('a Google Slides link', () => {
  const deck = loadWidget('slides')._deckFrom;

  it('reads the deck out of an ordinary share link', () => {
    const id = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
    for (const link of [
      `https://docs.google.com/presentation/d/${id}/edit#slide=id.p`,
      `https://docs.google.com/presentation/d/${id}/edit?usp=sharing`,
      `https://docs.google.com/presentation/d/${id}/view`,
      `https://docs.google.com/presentation/d/${id}/`,
      `docs.google.com/presentation/d/${id}/edit`,
    ]) {
      const got = deck(link);
      equal(got && got.id, id, `did not read ${link}`);
      equal(got.published, false, 'an ordinary deck, not a published one');
    }
  });

  it('knows a published-to-the-web deck from a normal one', () => {
    // They embed at different paths, so which it is has to survive the parse.
    const pub = '2PACX-1vQfakeidfakeidfakeidfakeidfakeidfakeid';
    const got = deck(`https://docs.google.com/presentation/d/e/${pub}/pub?start=false`);
    equal(got.id, pub);
    equal(got.published, true);
  });

  it('says what a Doc or a Form actually is, rather than failing blankly', () => {
    equal(deck('https://docs.google.com/document/d/abcdefghijklmno/edit').wrongKind, 'document');
    equal(deck('https://docs.google.com/spreadsheets/d/abcdefghijklmno/edit').wrongKind, 'spreadsheets');
    equal(deck('https://docs.google.com/forms/d/abcdefghijklmno/viewform').wrongKind, 'forms');
  });

  it('refuses anything that is not a Google deck', () => {
    // Only an id ever reaches the iframe, so no pasted string can frame
    // somewhere else on this origin.
    for (const bad of [
      '', '   ', 'not a link',
      'https://evil.test/presentation/d/abcdefghijklmno/edit',
      'https://docs.google.com.evil.test/presentation/d/abcdefghijklmno/edit',
      'javascript:alert(1)',
      'https://docs.google.com/presentation/d/short/edit',
    ]) {
      const got = deck(bad);
      assert(!got || !got.id, `${bad} should not have been accepted`);
    }
  });
});

// ===================================================================
describe('the catalogue', () => {
  const Desk = loadRegistry();
  const me = { can: { behaviour: true } };

  it('puts every widget in a drawer that exists', () => {
    const drawers = Desk.widgets.byCategory(me);
    const filed = drawers.reduce((n, d) => n + d.widgets.length, 0);
    equal(filed, Desk.widgets.available(me).length, 'nothing fell out of the catalogue');
    assert(drawers.length >= 4, 'more than one drawer');
    assert(drawers.every((d) => d.name && d.widgets.length), 'no empty drawers are shown');
  });

  it('files a widget with a nonsense category rather than losing it', () => {
    // The failure that matters: a typo in one widget silently removing it
    // from the only place anybody can add it from.
    Desk.widget({ type: 'test-oddity', name: 'Oddity', category: 'nowhere', blurb: 'x' });
    const drawers = Desk.widgets.byCategory(me);
    const found = drawers.flatMap((d) => d.widgets).find((w) => w.type === 'test-oddity');
    assert(!!found, 'it is still in the catalogue');
    equal(drawers[drawers.length - 1].widgets.some((w) => w.type === 'test-oddity'), true, 'in the last drawer');
  });

  it('searches names and blurbs, and drops drawers that empty out', () => {
    const hits = Desk.widgets.byCategory(me, 'timer');
    const names = hits.flatMap((d) => d.widgets).map((w) => w.type);
    assert(names.includes('timer'), 'the timer is found by its name');
    assert(hits.every((d) => d.widgets.length), 'no drawer comes back empty');

    const byBlurb = Desk.widgets.byCategory(me, 'sleeps').flatMap((d) => d.widgets).map((w) => w.type);
    equal(byBlurb, ['countdown'], 'a word from the blurb finds it too');

    equal(Desk.widgets.byCategory(me, 'zzzznotathing').length, 0, 'and nonsense finds nothing');
  });

  it('never offers a tool this teacher may not have', () => {
    const without = Desk.widgets.byCategory({ can: {} }).flatMap((d) => d.widgets).map((w) => w.type);
    assert(!without.includes('behaviour'), 'the behaviour tracker needs its permission');
  });

  it('can leave out the tools already on the desk', () => {
    const skip = new Set(['timer', 'clock']);
    const types = Desk.widgets.byCategory(me, '', { skip }).flatMap((d) => d.widgets).map((w) => w.type);
    assert(!types.includes('timer') && !types.includes('clock'), 'the ones on the desk are gone');
    assert(types.includes('stopwatch'), 'the rest are still there');
    equal(Desk.widgets.byCategory(me, 'timer', { skip }).flatMap((d) => d.widgets).some((w) => w.type === 'timer'), false,
      'and searching does not bring them back');
  });

  it('announces a new tool once, newest first, and stops after a while', () => {
    Desk.widget({ type: 'test-new-a', name: 'A', blurb: 'x', added: '2026-10-01', news: 'A is here.' });
    Desk.widget({ type: 'test-new-b', name: 'B', blurb: 'x', added: '2026-10-05', news: 'B is here.' });
    Desk.widget({ type: 'test-new-quiet', name: 'Q', blurb: 'x', added: '2026-10-05' });   // no line to say
    const now = Date.parse('2026-10-07T12:00:00');
    const ours = (list) => list.map((d) => d.type).filter((t) => t.startsWith('test-new'));

    equal(ours(Desk.widgets.announce(me, { now })), ['test-new-b', 'test-new-a'], 'newest first, and only with a line');
    equal(ours(Desk.widgets.announce(me, { now, seen: new Set(['test-new-b']) })), ['test-new-a'], 'not twice');
    equal(ours(Desk.widgets.announce(me, { now, onDesk: new Set(['test-new-a']) })), ['test-new-b'], 'not if already added');
    equal(ours(Desk.widgets.announce(me, { now: Date.parse('2026-12-31T12:00:00') })), [], 'not new for ever');
    equal(ours(Desk.widgets.announce(me, { now: Date.parse('2026-09-01T12:00:00') })), [], 'not before it went live');
    equal(Desk.widgets.isNew(Desk.widgets.get('timer'), now), false, 'a tool with no date is never new');
  });

  it('gives every announced tool a picture', () => {
    for (const d of Desk.widgets.all().filter((w) => w.news && !w.type.startsWith('test-'))) {
      assert(fs.existsSync(path.join(__dirname, '..', 'public', 'img', 'new', `${d.type}.png`)), `public/img/new/${d.type}.png`);
    }
  });
});

// ===================================================================
describe('countdowns to several days', () => {
  const countdown = loadWidget('countdown');

  it('carries an old single-day card over', () => {
    const s = { label: 'Trip', date: '2026-12-01', emoji: '🚌' };
    countdown.init(s);
    equal(s.events.length, 1, 'the day it was counting down to is kept');
    equal(s.events[0].date, '2026-12-01');
    equal(s.events[0].label, 'Trip');
    equal(s.date, undefined, 'and the old shape is gone');
  });

  it('starts empty, and gives every day an id to delete it by', () => {
    const s = {};
    countdown.init(s);
    equal(s.events, []);
    const withOne = { events: [{ label: 'Sports day', date: '2026-06-01' }] };
    countdown.init(withOne);
    assert(!!withOne.events[0].id, 'a day with no id gets one');
  });
});

// ===================================================================
describe('the converter', () => {
  const cv = loadWidget('convert');
  const { execFileSync } = require('child_process');
  const hasUnzip = (() => { try { execFileSync('unzip', ['-v'], { stdio: 'ignore' }); return true; } catch (_) { return false; } })();
  const enc = (t) => new TextEncoder().encode(t);

  it('computes the standard CRC-32', () => {
    equal(cv._crc32(enc('123456789')), 0xCBF43926, 'the check value every CRC-32 must give');
    equal(cv._crc32(new Uint8Array(0)), 0, 'nothing in, zero out');
  });

  it('writes a zip that unzip accepts, names and bytes intact', () => {
    const data = cv._zip([
      { name: 'a.txt', data: enc('hello') },
      { name: 'Café notes/ünï.txt', data: enc('second file') },
      { name: 'empty.bin', data: new Uint8Array(0) },
    ]);
    equal(data[0], 0x50, 'starts with the local header magic');
    if (!hasUnzip) return;
    const f = path.join(TMP, 't.zip');
    fs.writeFileSync(f, Buffer.from(data));
    execFileSync('unzip', ['-tq', f]);
    equal(execFileSync('unzip', ['-p', f, 'a.txt']).toString(), 'hello', 'the first file comes back');
    const raw = fs.readFileSync(f);
    assert(raw.includes(Buffer.from('Café notes/ünï.txt', 'utf8')), 'a UTF-8 name is stored as UTF-8');
    equal(raw.readUInt16LE(6) & 0x0800, 0x0800, 'and flagged as UTF-8 so unzippers read it so');
  });

  it('makes a .docx whose parts are well-formed and say what was given', () => {
    const files = cv._docxFiles([
      { text: 'Chapter <1> & "more"', heading: 1 },
      { text: 'Body text', heading: 0 },
      { pageBreak: true },
      { text: 'bad \u0001 control \uD800 char', heading: 0 },
    ], 'My file');
    equal(files[0].name, '[Content_Types].xml', 'content types must come first');
    const doc = new TextDecoder().decode(files.find((x) => x.name === 'word/document.xml').data);
    assert(doc.includes('Chapter &lt;1&gt; &amp; &quot;more&quot;'), 'text is escaped');
    assert(doc.includes('<w:pStyle w:val="Heading1"/>'), 'a heading gets the heading style');
    assert(doc.includes('<w:br w:type="page"/>'), 'page breaks are kept');
    assert(!/[\u0001\uD800]/.test(doc), 'characters Word refuses are removed');
    for (const x of files) {
      const xml = new TextDecoder().decode(x.data);
      assert(xml.startsWith('<?xml'), `${x.name} is XML`);
    }
    if (!hasUnzip) return;
    const f = path.join(TMP, 't.docx');
    fs.writeFileSync(f, Buffer.from(cv._zip(files)));
    execFileSync('unzip', ['-tq', f]);
  });

  // pdf.js items: [a, b, c, d, x, y]; y runs up the page.
  const item = (str, x, y, size = 10, extra = {}) => ({ str, transform: [size, 0, 0, size, x, y], width: str.length * size * 0.5, height: size, hasEOL: false, ...extra });

  it('joins wrapped lines into paragraphs and splits at a blank line', () => {
    const ps = cv._paragraphs([
      item('The quick brown fox jumps over the lazy dog and keeps', 72, 700),
      item('running into the next line.', 72, 688),
      item('A second paragraph starts after a gap.', 72, 660),
    ]);
    equal(ps.length, 2, 'two paragraphs');
    equal(ps[0].text, 'The quick brown fox jumps over the lazy dog and keeps running into the next line.', 'lines joined with a space');
    equal(ps[1].heading, 0, 'body text is not a heading');
  });

  it('spots headings by size', () => {
    const ps = cv._paragraphs([
      item('Unit 3: Supply', 72, 740, 20),
      item('Body text that is long enough to count as the body of the page.', 72, 712),
      item('More body text, also long enough to set the body size here.', 72, 700),
      item('Key terms', 72, 676, 13),
      item('Demand is what buyers want at each price, all else equal.', 72, 660),
    ]);
    equal(ps[0].heading, 1, 'much larger text is a main heading');
    equal(ps[1].heading, 0, 'body is body');
    equal(ps[2].text, 'Key terms', 'the smaller heading stands alone');
    equal(ps[2].heading, 2, 'and is a subheading');
  });

  it('mends a word hyphenated across lines, puts items on one line together, and keeps list items apart', () => {
    const ps = cv._paragraphs([
      item('An extra', 72, 700), item('ordinary', 116, 700),
      item('photo-', 160, 700),
      item('synthesis happens in leaves.', 72, 688),
      item('1. First answer', 72, 676),
      item('2. Second answer', 72, 664),
    ]);
    equal(ps[0].text, 'An extra ordinary photosynthesis happens in leaves.', 'same-line pieces joined; hyphen mended');
    equal(ps.length, 3, 'each numbered item is its own paragraph');
  });

  it('honours pdf.js end-of-line markers and ignores empty pages', () => {
    const ps = cv._paragraphs([
      item('Name:', 72, 700, 10, { hasEOL: true }),
      item('Date:', 72, 700.2),
    ]);
    equal(ps.length, 2, 'the marker ends the line even at the same height');
    equal(ps[0].text, 'Name:', 'a short label line stays on its own, as on a worksheet');
    equal(cv._paragraphs([]).length, 0, 'no items, no paragraphs');
    equal(cv._paragraphs([{ str: '   ', transform: [10, 0, 0, 10, 0, 0] }, { type: 'beginMarkedContent' }]).length, 0, 'whitespace and markers are nothing');
  });

  it('reads page ranges the way people write them', () => {
    const r = (t, n = 10) => cv._ranges(t, n);
    equal(r('').pages.length, 10, 'blank is every page');
    equal(r('all').pages.join(), '0,1,2,3,4,5,6,7,8,9', '"all" too');
    equal(r('1-3, 5, 8-').pages.join(), '0,1,2,4,7,8,9', 'mixed ranges, open end');
    equal(r('-2').pages.join(), '0,1', 'open start');
    equal(r('3–1').pages.join(), '2,1,0', 'an en dash, and a backwards range runs backwards');
    equal(r('2 2').pages.join(), '1,1', 'repeats are allowed');
    assert(/no page 11/.test(r('11').error), 'past the end says so');
    assert(/start at 1/.test(r('0').error), 'zero is refused');
    assert(r('one').error, 'words are refused');
    assert(r('-').error, 'a lone dash is refused');
    assert(r('1', 0).error, 'no pages at all is an error, not a crash');
  });

  it('finds which PDF a combined page number belongs to', () => {
    const at = (i) => cv._locate([3, 2, 4], i);
    equal(JSON.stringify(at(0)), '{"file":0,"page":0}', 'first page');
    equal(JSON.stringify(at(3)), '{"file":1,"page":0}', 'first page of the second file');
    equal(JSON.stringify(at(8)), '{"file":2,"page":3}', 'last page');
    equal(at(9), null, 'past the end');
  });

  it('shrinks to a longest side but never enlarges', () => {
    equal(JSON.stringify(cv._fit(4000, 3000, 1600)), '{"w":1600,"h":1200}', 'landscape');
    equal(JSON.stringify(cv._fit(3000, 4000, 1600)), '{"w":1200,"h":1600}', 'portrait');
    equal(JSON.stringify(cv._fit(800, 600, 1600)), '{"w":800,"h":600}', 'small stays small');
    equal(JSON.stringify(cv._fit(800, 600, 0)), '{"w":800,"h":600}', '0 means as it is');
  });

  it('names output files sensibly, and never twice the same in a zip', () => {
    equal(cv._outName('IMG_0042.HEIC', 'jpg'), 'IMG_0042.jpg', 'extension swapped');
    equal(cv._outName('worksheet.v2.pdf', 'docx'), 'worksheet.v2.docx', 'only the last extension');
    equal(cv._outName('', 'png'), 'file.png', 'a nameless file still gets a name');
    equal(cv._uniqueNames(['a.jpg', 'A.jpg', 'b.png', 'a.jpg']).join('|'), 'a.jpg|A (2).jpg|b.png|a (3).jpg', 'repeats numbered');
  });

  it('recognises iPhone photos by name, type or contents', () => {
    equal(cv._isHeic({ name: 'IMG_1.HEIC', type: '' }), true, 'by name');
    equal(cv._isHeic({ name: 'x', type: 'image/heif' }), true, 'by type');
    const head = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
    equal(cv._isHeic({ name: 'photo', type: '' }, head), true, 'by the ftyp brand');
    equal(cv._isHeic({ name: 'photo.jpg', type: 'image/jpeg' }, new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0])), false, 'a JPEG is not');
  });

  it('turns pdf.js image data into RGBA', () => {
    equal(Array.from(cv._toRGBA(2, new Uint8Array([1, 2, 3, 4, 5, 6]), 2, 1)).join(), '1,2,3,255,4,5,6,255', 'RGB gains opaque alpha');
    equal(Array.from(cv._toRGBA(1, new Uint8Array([0b10000000]), 2, 1)).join(), '255,255,255,255,0,0,0,255', '1-bit, high bit first');
    equal(Array.from(cv._toRGBA(3, new Uint8Array([9, 8, 7, 6]), 1, 1)).join(), '9,8,7,6', 'RGBA passes through');
    equal(cv._toRGBA(9, new Uint8Array(4), 1, 1), null, 'an unknown kind is refused, not guessed');
  });

  it('works for visitors, and keeps no files in its state', () => {
    equal(cv.guest, true, 'open to visitors');
    const s = {};
    cv.init(s);
    const kept = JSON.stringify(s);
    assert(kept.length < 200 && !/file|blob|data/i.test(Object.keys(s).join()), 'only settings are state');
    equal(s.tab, 'pics', 'starts on pictures');
  });
});

/** Runs a widget file with a stub browser and hands back its definition. */
function loadWidget(name) {
  const noop = () => {};
  const sandbox = { console, setTimeout, clearTimeout, URL, URLSearchParams, TextEncoder };
  sandbox.window = sandbox;
  sandbox.document = fakeDom();
  let captured = null;
  sandbox.Desk = Object.assign(loadUtil(), {
    widget: (def) => { captured = def; },
    icon: () => '',
    iconEl: () => ({}),
    roster: { picker: () => ({}), members: async () => [], onChange: () => noop },
    api: {},
    sound: { play: noop },
    widgets: { get: () => null },
  });
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'widgets', `${name}.js`), 'utf8'), sandbox, { filename: `${name}.js` });
  return captured;
}

/**
 * Just enough DOM to hold children and text.
 *
 * Only what the helpers under test actually touch — but children and
 * textContent are real, because the bug this exists to catch was the DOM
 * turning a null child into the word "null".
 */
function fakeDom() {
  const noop = () => {};
  const text = (data) => ({ nodeType: 3, data, get textContent() { return this.data; } });

  const element = (tag) => ({
    tagName: tag, nodeType: 1,
    style: { setProperty: noop }, dataset: {}, attributes: {}, childNodes: [],
    className: '', innerHTML: '', value: '',
    // Every real input has these; the stub needs them or keepFocus has
    // nothing to restore and the test proves less than it looks like it does.
    selectionStart: 0, selectionEnd: 0,
    setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; },
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    setAttribute(k, v) { this.attributes[k] = v; },
    addEventListener: noop,
    append(...kids) { for (const k of kids) this.childNodes.push(k); },
    get firstChild() { return this.childNodes[0] || null; },
    removeChild(k) { this.childNodes = this.childNodes.filter((c) => c !== k); },
    get textContent() { return this.childNodes.map((c) => c.textContent).join(''); },
    set textContent(v) { this.childNodes = v === '' ? [] : [text(String(v))]; },
  });

  const doc = {
    createElement: element,
    createTextNode: text,
    body: element('body'),
    addEventListener: noop,
    activeElement: null,
  };
  // Focus, just enough of it: keepFocus reads activeElement, calls focus(),
  // and asks whether a node is inside a root.
  const withFocus = (node) => {
    node.focus = () => { doc.activeElement = node; };
    node.contains = function contains(other) {
      if (this === other) return true;
      return this.childNodes.some((c) => c.nodeType === 1 && contains.call(c, other));
    };
    node.querySelectorAll = function all(sel) {
      const want = String(sel).split(',').map((s) => s.trim().toUpperCase());
      const out = [];
      const walk = (n) => {
        for (const c of n.childNodes) {
          if (c.nodeType !== 1) continue;
          if (want.includes(c.tagName.toUpperCase())) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    };
    return node;
  };
  const plain = doc.createElement;
  doc.createElement = (tag) => withFocus(plain(tag));
  withFocus(doc.body);
  return doc;
}

/** Runs public/js/util.js with a stub browser, and hands back its helpers. */
/** local-api.js loaded on its own, with an in-memory stand-in for localStorage. */
function loadLocalApi() {
  const sandbox = { console, Date, Math, JSON, Promise };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'local-api.js'), 'utf8'), sandbox, { filename: 'local-api.js' });
  return sandbox.Desk.localApi;
}

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    key: (i) => [...m.keys()][i] || null,
    get length() { return m.size; },
    _map: m,
  };
}

function loadUtil() {
  const sandbox = { console, setTimeout, clearTimeout, document: fakeDom() };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'util.js'), 'utf8'), sandbox, { filename: 'util.js' });
  // The helpers build nodes in the sandbox's DOM, so tests need that one
  // rather than anything in Node's own scope.
  sandbox.Desk._doc = sandbox.document;
  return sandbox.Desk;
}

/**
 * The real registry with every widget file loaded into it.
 *
 * The catalogue is the only way anybody adds a tool, so "is every widget
 * actually in it" is worth asserting against the real list rather than a
 * hand-written one that would drift the first time somebody adds a file.
 */
function loadRegistry() {
  // Memoised on the function itself: `describe` blocks run before a `let` at
  // the bottom of this file has been initialised, and a top-level cache
  // variable would be in its temporal dead zone when they call this.
  if (loadRegistry.cache) return loadRegistry.cache;
  const noop = () => {};
  const sandbox = { console, setTimeout, clearTimeout, URL, URLSearchParams };
  sandbox.window = sandbox;
  sandbox.document = fakeDom();
  vm.createContext(sandbox);

  const run = (rel) => vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'public', 'js', rel), 'utf8'), sandbox, { filename: rel });

  run('util.js');
  run('registry.js');
  Object.assign(sandbox.Desk, {
    icon: () => '', iconEl: () => ({}),
    roster: { picker: () => ({}), members: async () => [], onChange: () => noop },
    api: {}, sound: { play: noop },
  });

  const dir = path.join(__dirname, '..', 'public', 'js', 'widgets');
  for (const f of fs.readdirSync(dir).sort()) run(path.join('widgets', f));

  loadRegistry.cache = sandbox.Desk;
  return loadRegistry.cache;
}

/** Runs public/js/board.js with a stub browser, and hands back its geometry. */
function loadGeometry() {
  const noop = () => {};
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => ({ unref: noop }),
    requestAnimationFrame: noop,
    CSS: { escape: (s) => s },
    navigator: {},
    document: { body: { classList: { toggle: noop, add: noop, remove: noop } }, addEventListener: noop, removeEventListener: noop, createElement: () => ({ style: {}, classList: { toggle: noop, add: noop, remove: noop }, append: noop, setAttribute: noop, addEventListener: noop }) },
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = noop;
  sandbox.Desk = {
    debounce: (fn) => Object.assign(() => {}, { flush: noop, cancel: noop }),
    el: () => ({ style: {}, classList: { toggle: noop }, append: noop, querySelector: () => null }),
    icon: () => '',
    clamp: (n, lo, hi) => Math.min(hi, Math.max(lo, n)),
    toast: noop,
    clear: (n) => n,
    ask: async () => false,
    widgets: { get: () => null },
    api: {},
  };

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'board.js'), 'utf8'), sandbox, { filename: 'board.js' });
  return sandbox.Desk.board._geom;
}

// ===================================================================
describe('the economics graphs', () => {
  const econ = loadWidget('econgraphs');
  const M = econ._math;
  const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg || 'expected'} ${a} to be within ${tol} of ${b}`);
  const model = (k) => econ._models.find((m) => m.key === k);

  it('covers every graph the CED appendix lists', () => {
    const keys = econ._models.map((m) => m.key);
    for (const k of ['ppc', 'utility', 'sd', 'trade', 'production', 'costs', 'lrcosts', 'perfcomp', 'monopoly', 'natural', 'game', 'labor', 'firmfactor', 'monopsony', 'externality', 'lorenz']) {
      assert(keys.includes(k), `missing the ${k} graph`);
    }
    equal(new Set(keys).size, keys.length, 'every graph has its own key');
  });

  describe('supply and demand', () => {
    const mk = (o) => M.marketCalc(Object.assign({ d: 0, s: 0, mode: 'free', lvl: 3, amt: 2 }, o));
    it('starts at P = 5, Q = 50', () => { const m = mk({}); equal(m.Pe, 5); equal(m.Qe, 50); });
    it('an increase in demand raises both price and quantity', () => {
      const m = mk({ d: 20 }); equal(m.Qe, 60); equal(m.Pe, 6);
    });
    it('equal increases in both leave the price alone', () => { equal(mk({ d: 20, s: 20 }).Pe, 5); });
    it('a ceiling below equilibrium makes a shortage', () => {
      const m = mk({ mode: 'ceil', lvl: 3 });
      equal(m.qsAt(3), 30); equal(m.qdAt(3), 70); equal(m.shortage, 40); equal(m.Q, 30);
    });
    it('a ceiling above equilibrium does nothing', () => { assert(!mk({ mode: 'ceil', lvl: 7 }).binding); });
    it('a floor above equilibrium makes a surplus', () => {
      const m = mk({ mode: 'floor', lvl: 7 }); equal(m.surplus, 40); equal(m.Q, 30);
    });
    it('a tax opens a wedge and loses deadweight', () => {
      const m = mk({ mode: 'tax', amt: 2 });
      near(m.Q, 40, 1e-9); near(m.Pb - m.Ps, 2, 1e-9); near(m.gov, 80, 1e-6); near(m.DWL, 10, 0.01);
    });
    it('surplus, revenue and deadweight loss add back up to the free-market total', () => {
      const free = mk({}); const t = mk({ mode: 'tax', amt: 3 });
      near(t.CS + t.PS + t.gov + t.DWL, free.CS + free.PS, 0.05);
    });
    it('a subsidy raises quantity and costs the government', () => {
      const m = mk({ mode: 'sub', amt: 2 }); near(m.Q, 60, 1e-9); assert(m.gov < 0, 'the government pays');
    });
  });

  describe('costs', () => {
    const C = M.costFns(30, 1);
    it('MC meets AVC at its minimum', () => { near(C.MC(7.5), C.AVC(7.5), 1e-9); near(C.AVC(7.5), C.minAVC, 1e-9); });
    it('MC meets ATC at its minimum', () => { near(C.MC(C.qMinATC), C.ATC(C.qMinATC), 0.01); });
    it('ATC = AVC + AFC and TC = TFC + TVC', () => { near(C.ATC(6), C.AVC(6) + C.AFC(6), 1e-9); near(C.TC(6), 30 + C.TVC(6), 1e-9); });
    it('a firm supplies along MC above the shutdown point only', () => {
      equal(C.supplyQ(C.minAVC - 0.1), 0);
      near(C.supplyQ(C.minAVC), 7.5, 1e-6);
      near(C.MC(C.supplyQ(9)), 9, 1e-6);
    });
  });

  describe('perfect competition', () => {
    const base = { shift: 0, n: 20, fc: 30 };
    it('starts in long-run equilibrium with zero profit', () => {
      const e = M.pcEq(base); near(e.profit, 0, 0.05); near(e.P, e.C.minATC, 0.01);
    });
    it('more demand brings profit, and entry takes it away again', () => {
      const p = Object.assign({}, base, { shift: 30 });
      assert(M.pcEq(p).profit > 0, 'profit after demand rises');
      const n = M.pcLongRunN(p);
      assert(n > 20, 'firms enter');
      near(M.pcEq(p, n).profit, 0, 0.05);
      near(M.pcEq(p, n).P, M.pcEq(p, n).C.minATC, 0.02);
    });
    it('less demand brings losses, and exit takes them away', () => {
      const p = Object.assign({}, base, { shift: -25 });
      assert(M.pcEq(p).profit < 0, 'loss after demand falls');
      assert(M.pcLongRunN(p) < 20, 'firms leave');
    });
  });

  describe('monopoly', () => {
    const p = { kind: 'mono', pd: 'none', mc0: 2, fc: 20, s: 0 };
    it('produces where MR = MC and prices off the demand curve', () => {
      const m = M.monoCalc(p); near(m.qm, 14.4, 1e-9); near(m.pm, 12.8, 1e-9); near(m.MR(m.qm), m.MC(m.qm), 1e-9);
    });
    it('restricts output below the competitive level, with deadweight loss', () => {
      const m = M.monoCalc(p); assert(m.qm < m.qc, 'less than competition'); assert(m.dwl > 0, 'deadweight loss');
    });
    it('perfect price discrimination removes the deadweight loss', () => {
      const m = M.monoCalc(Object.assign({}, p, { pd: 'perfect' })); equal(m.dwl, 0); near(m.q, m.qc, 1e-9);
    });
    it('long-run entry leaves a monopolistic competitor with zero profit', () => {
      const q = Object.assign({}, p, { kind: 'mc' }); q.s = M.monoZeroProfitShift(q);
      near(M.monoCalc(q).profit, 0, 0.01);
      assert(M.monoCalc(q).qm < M.monoCalc(q).qMinATC, 'excess capacity');
    });
  });

  describe('natural monopoly', () => {
    const p = { c: 3, F: 60 };
    it('has three outputs in the right order', () => {
      const m = M.naturalCalc(Object.assign({ reg: 'none' }, p)); assert(m.qU < m.qF && m.qF < m.qS, `${m.qU} ${m.qF} ${m.qS}`);
    });
    it('fair-return pricing breaks even; marginal-cost pricing loses the fixed cost', () => {
      near(M.naturalCalc(Object.assign({ reg: 'fair' }, p)).profit, 0, 1e-6);
      near(M.naturalCalc(Object.assign({ reg: 'optimal' }, p)).profit, -60, 1e-6);
    });
  });

  describe('game theory', () => {
    it('finds the dominant strategies and the dilemma', () => {
      const g = M.analyseGame([5, 5, 15, 2, 2, 15, 10, 10]);
      equal(g.domRow, 0); equal(g.domCol, 0); equal(g.nash.length, 1); equal(g.nash[0].join(), '0,0'); assert(g.dilemma, 'prisoner’s dilemma');
    });
    it('finds two equilibria in a coordination game', () => {
      equal(M.analyseGame([5, 5, 0, 0, 0, 0, 3, 3]).nash.length, 2);
    });
    it('finds no pure equilibrium in matching pennies', () => {
      equal(M.analyseGame([1, -1, -1, 1, -1, 1, 1, -1]).nash.length, 0);
    });
  });

  describe('the MU-per-dollar rule', () => {
    it('spends all the income and equalizes MU/P', () => {
      const g = M.greedyBuy(24, 2, 4, [20, 16, 12, 8, 5, 3, 1], [36, 28, 20, 16, 8, 4, 2]);
      equal(g.nx, 4); equal(g.ny, 4); near(g.left, 0, 1e-9);
    });
    it('buys less X when X gets dearer', () => {
      const g = M.greedyBuy(24, 4, 4, [20, 16, 12, 8, 5, 3, 1], [36, 28, 20, 16, 8, 4, 2]);
      assert(g.nx < 4, 'fewer X');
    });
  });

  describe('trade and comparative advantage', () => {
    it('imports when the world price is below the domestic price', () => {
      const t = M.tradeCalc({ pw: 3, tariff: 0 }); equal(t.trade, 40); assert(t.cs > t.cs0 && t.ps < t.ps0, 'consumers gain, producers lose');
    });
    it('a tariff earns revenue and loses deadweight', () => {
      const t = M.tradeCalc({ pw: 3, tariff: 1 }); equal(t.pt, 4); near(t.rev, 20, 1e-9); near(t.dwl, 10, 1e-9);
    });
    it('the country with the lower opportunity cost has the comparative advantage', () => {
      const m = M.compCalc({ ax: 40, ay: 40, bx: 10, by: 20, tot: 1.5, q: 4 });
      equal(m.exporter, 'A'); assert(m.inRange, 'terms of trade in range'); equal(m.A.x + m.B.x, 40);
    });
  });

  describe('factor markets and externalities', () => {
    it('a monopsony hires fewer workers at a lower wage than a competitive market', () => {
      const m = M.monopsonyCalc({ wmin: 0 }); assert(m.Lm < m.Lc && m.Wm < m.Wc, 'fewer and lower');
    });
    it('a minimum wage between the two can raise employment, a high one cuts it', () => {
      const lo = M.monopsonyCalc({ wmin: 9 }); assert(lo.L > lo.Lm, 'employment rises');
      const hi = M.monopsonyCalc({ wmin: 13 }); assert(hi.L < hi.Lm, 'employment falls'); assert(hi.unemployed > 0, 'unemployment');
    });
    it('a firm in a competitive factor market hires where MRP = W', () => {
      const m = M.factorCalc({ pi: 1.2, s: 0 }); near(m.MRP(m.lf), m.We, 1e-9);
    });
    it('externalities: negative ones overproduce, positive ones underproduce', () => {
      const f = (kind, e) => M.extCalc({ kind, e: e == null ? 2 : e, policy: false });
      assert(f('negprod').Qm > f('negprod').Qs, 'negative production');
      assert(f('negcons').Qm > f('negcons').Qs, 'negative consumption');
      assert(f('posprod').Qm < f('posprod').Qs, 'positive production');
      assert(f('poscons').Qm < f('poscons').Qs, 'positive consumption');
    });
    it('a tax equal to the externality removes the deadweight loss', () => {
      const m = M.extCalc({ kind: 'negprod', e: 2, policy: true }); near(m.dwl, 0, 1e-6);
    });
    it('a monopolist with an external cost can still produce too little', () => {
      const m = M.extCalc({ kind: 'mono', e: 2, policy: false }); assert(m.Qm < m.Qs, 'below the social optimum');
    });
  });

  describe('drawing', () => {
    const K = { chart: (o) => M.makeChart(Object.assign({ labels: true, numbers: false }, o)) };
    const bad = /NaN|undefined|Infinity|null/;
    const check = (m, p, what) => {
      M.sanitize(m, p);
      const out = m.draw(p, K);
      assert(out.charts.length >= 1, `${m.key} (${what}) drew nothing`);
      for (const c of out.charts) assert(!bad.test(c.svg('x')), `${m.key} (${what}) put NaN or undefined in the picture`);
      for (const f of out.facts) assert(!bad.test(`${f.k} ${f.v}`), `${m.key} (${what}) has a bad fact: ${f.k} = ${f.v}`);
      assert(!bad.test(out.say || ''), `${m.key} (${what}) has bad text`);
    };
    for (const m of econ._models.filter((x) => x.draw)) {
      it(`${m.name}: default, every class question, and both extremes of every slider`, () => {
        check(m, M.fresh(m.defaults), 'default');
        for (const numbers of [false, true]) {
          K.chart = (o) => M.makeChart(Object.assign({ labels: !numbers, numbers }, o));
          check(m, M.fresh(m.defaults), `numbers=${numbers}`);
        }
        for (const sc of m.scenarios) {
          const p = Object.assign(M.fresh(m.defaults), M.fresh(sc.setup || {}));
          Object.assign(p, M.fresh(typeof sc.set === 'function' ? sc.set(p) : sc.set));
          check(m, p, `scenario "${sc.name}"`);
        }
        for (const spec of m.controls.filter((c) => !c.type && !c.head)) {
          for (const v of [spec.min, spec.max]) {
            const p = M.fresh(m.defaults); p[spec.k] = v;
            check(m, p, `${spec.k} = ${v}`);
          }
        }
        for (const spec of m.controls.filter((c) => c.type === 'seg')) {
          for (const [v] of spec.opts) { const p = M.fresh(m.defaults); p[spec.k] = v; check(m, p, `${spec.k} = ${v}`); }
        }
      });
    }
  });
});

// ===================================================================
store.flushSync();
fs.rmSync(TMP, { recursive: true, force: true });
report();
