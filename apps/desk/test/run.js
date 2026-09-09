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
    equal(b.prefs.accent, 'blue');
  });

  it('keeps only colours it actually has', () => {
    const p = board.cleanPrefs({ theme: 'midnight', accent: 'chartreuse', backgroundDim: 500 });
    equal(p.theme, 'auto', 'an unknown mode falls back');
    equal(p.accent, 'blue', 'so does an unknown accent');
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
    board.saveBoard(bruno, { rev, items: [], prefs: { theme: 'dark', accent: 'teal' } });
    equal(board.boardFor(bruno).prefs.accent, 'teal');
    board.resetBoard(bruno);
    equal(board.boardFor(bruno).prefs.accent, 'teal', 'resetting the tools does not repaint the room');
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

/** Runs a widget file with a stub browser and hands back its definition. */
function loadWidget(name) {
  const noop = () => {};
  const sandbox = { console, setTimeout, clearTimeout, URL, URLSearchParams };
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
store.flushSync();
fs.rmSync(TMP, { recursive: true, force: true });
report();
