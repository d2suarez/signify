// ===================================================================
// Teacher's Desk — a visitor's class lists, kept in this browser
//
// Signed in, class lists, saved groups and saved rooms live on the server
// under the teacher's account. A visitor has no account, so for them the same
// calls are answered here instead, from this browser's own storage. The
// widgets and the class-list dialog cannot tell the difference: they ask
// Desk.api, and for a visitor Desk.api has been pointed here.
//
// It is temporary, and says so. Everything a visitor keeps is dated, and a
// desk nobody has opened for EXPIRY_DAYS is cleared the next time the page
// loads — on a shared classroom computer, a list of children's names should
// not outlive the teacher who typed it in. The answers mirror the server's
// own shapes and limits, so moving a visitor's lists into an account later is
// a matter of sending them, not converting them.
// ===================================================================

(function (Desk) {
  'use strict';

  const PREFIX = 'desk:guest';
  const KEYS = {
    lists: `${PREFIX}:lists`,
    groupings: `${PREFIX}:groupings`,
    templates: `${PREFIX}:templates`,
    touched: `${PREFIX}:touched`,
    seeded: `${PREFIX}:example-seeded`,
  };
  const EXPIRY_DAYS = 30;
  const DAY = 24 * 60 * 60 * 1000;

  const MAX_LISTS = 40;
  const MAX_STUDENTS = 200;
  const MAX_GROUPINGS = 60;
  const MAX_TEMPLATES = 40;

  const DESK_SHAPES = ['row', 'table', 'round'];
  const OBJECT_SHAPES = ['rect', 'circle', 'strip'];
  const FACINGS = ['up', 'right', 'down', 'left'];
  const FRONTS = ['top', 'right', 'bottom', 'left'];

  const clean = (v, max = 80) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
  const num = (v, lo, hi, fallback) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };
  /*
   * First names for the example class, drawn from the range of names in a
   * real classroom. Each is given a random initial, the same "first name and
   * initial" form the class-list editor suggests, so the example teaches the
   * habit rather than contradicting it.
   */
  const EXAMPLE_FIRST = [
    'Aaliyah', 'Aarav', 'Amara', 'Ava', 'Ben', 'Carlos', 'Chloe', 'Dev', 'Elif', 'Ella',
    'Eva', 'Finn', 'Freya', 'Grace', 'Hana', 'Hugo', 'Ibrahim', 'Isla', 'Jack', 'Jonah',
    'Kai', 'Keira', 'Leo', 'Lena', 'Luca', 'Maya', 'Mateo', 'Mia', 'Nia', 'Noah',
    'Olu', 'Oscar', 'Priya', 'Rafi', 'Rosa', 'Ruby', 'Sam', 'Sofia', 'Tariq', 'Theo',
    'Tom', 'Wei', 'Yara', 'Yusuf', 'Zara', 'Zoe',
  ];
  const INITIALS = 'ABCDEFGHJKLMNOPRSTVWY';   // the letters surnames actually start with

  /** `count` different made-up names, shuffled; `random` is swappable for tests. */
  function exampleNames(count = 20, random = Math.random) {
    const pool = EXAMPLE_FIRST.slice();
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, Math.min(count, pool.length))
      .map((first) => `${first} ${INITIALS[Math.floor(random() * INITIALS.length)]}.`);
  }

  const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  /** An error that looks like the server's, so callers handle both the same. */
  function refused(status, message) {
    const e = new Error(message);
    e.status = status;
    return e;
  }

  /**
   * The store itself. `storage` is window.localStorage in the browser and a
   * stand-in in the tests; anything with getItem/setItem/removeItem/key/length.
   */
  function make(storage, clock = () => Date.now()) {
    const read = (key) => {
      try { const v = JSON.parse(storage.getItem(key) || 'null'); return Array.isArray(v) ? v : []; }
      catch { return []; }
    };
    const write = (key, rows) => {
      storage.setItem(key, JSON.stringify(rows));
      storage.setItem(KEYS.touched, String(clock()));
    };

    /**
     * Clears everything a visitor kept if nobody has opened this desk for
     * EXPIRY_DAYS. Returns true if it did.
     */
    function expireIfStale() {
      const last = Number(storage.getItem(KEYS.touched)) || 0;
      const stale = last > 0 && clock() - last > EXPIRY_DAYS * DAY;
      if (stale) clearAll();
      // Opening the desk is what counts as using it, so the clock restarts
      // here — including for somebody who only ever used the timer.
      storage.setItem(KEYS.touched, String(clock()));
      return stale;
    }

    /** Everything this browser holds for a visitor, gone. */
    function clearAll() {
      const doomed = [];
      for (let i = 0; i < storage.length; i += 1) {
        const k = storage.key(i);
        if (k && k.startsWith(PREFIX)) doomed.push(k);
      }
      for (const k of doomed) storage.removeItem(k);
    }

    function normaliseStudents(input, previous = []) {
      const known = new Set(previous.map((s) => s.id));
      const out = [];
      const seen = new Set();
      for (const raw of Array.isArray(input) ? input : []) {
        const name = clean(typeof raw === 'string' ? raw : raw && raw.name);
        if (!name) continue;
        // A pupil keeps their id across an edit, so a seat or a group stays
        // attached to the same child when a spelling is corrected.
        const id = raw && raw.id && known.has(raw.id) ? raw.id : newId('s');
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ id, name });
        if (out.length >= MAX_STUDENTS) break;
      }
      return out;
    }

    const listView = (l) => ({
      key: `list:${l.id}`, name: l.name, subject: '', source: 'list', editable: true, size: l.students.length,
    });

    const api = {
      // ---------- class lists ----------
      async classes() {
        const out = read(KEYS.lists).map(listView).sort((a, b) => a.name.localeCompare(b.name));
        return { classes: out, signifyOk: true };
      },
      async members(key) {
        const id = String(key || '').startsWith('list:') ? String(key).slice(5) : '';
        const list = read(KEYS.lists).find((l) => l.id === id);
        if (!list) throw refused(404, 'That class list is not available.');
        return { name: list.name, source: 'list', editable: true, students: list.students.map((s) => ({ ...s })) };
      },
      async createList(name, students) {
        const lists = read(KEYS.lists);
        if (lists.length >= MAX_LISTS) throw refused(400, 'That is as many lists as one desk can hold.');
        const now = clock();
        const list = { id: newId('list'), name: clean(name, 60) || 'Untitled list', students: normaliseStudents(students), createdAt: now, updatedAt: now };
        lists.push(list);
        write(KEYS.lists, lists);
        return list;
      },
      async updateList(id, patch = {}) {
        const lists = read(KEYS.lists);
        const list = lists.find((l) => l.id === id);
        if (!list) throw refused(404, 'That list is not here.');
        if (patch.name != null) list.name = clean(patch.name, 60) || list.name;
        if (patch.students != null) list.students = normaliseStudents(patch.students, list.students);
        // An example the visitor has made their own — renamed, or filled with
        // their real class — is theirs now, and is offered for keeping.
        delete list.example;
        list.updatedAt = clock();
        write(KEYS.lists, lists);
        return list;
      },
      async deleteList(id) {
        const lists = read(KEYS.lists);
        const left = lists.filter((l) => l.id !== id);
        if (left.length === lists.length) throw refused(404, 'That list is not here.');
        write(KEYS.lists, left);
        return { deleted: true };
      },

      // ---------- saved groups ----------
      async groupings(classKey) {
        const rows = read(KEYS.groupings)
          .filter((g) => !classKey || g.classKey === classKey)
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, 100);
        return { groupings: rows };
      },
      async saveGrouping(input = {}) {
        const groups = [];
        for (const raw of Array.isArray(input.groups) ? input.groups : []) {
          const members = [];
          for (const m of Array.isArray(raw && raw.members) ? raw.members : []) {
            const key = clean(m && m.key, 80);
            if (!key) continue;
            members.push({ key, name: clean(m.name, 80) });
            if (members.length >= MAX_STUDENTS) break;
          }
          groups.push({ label: clean(raw && raw.label, 40) || `Group ${groups.length + 1}`, members });
          if (groups.length >= 40) break;
        }
        if (!groups.length) throw refused(400, 'There are no groups to save.');
        let rows = read(KEYS.groupings);
        if (rows.length >= MAX_GROUPINGS) rows = rows.sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_GROUPINGS - 1);
        const row = {
          id: newId('g'),
          classKey: clean(input.classKey, 80),
          className: clean(input.className, 60),
          name: clean(input.name, 60) || new Date(clock()).toLocaleDateString(),
          groups,
          createdAt: clock(),
        };
        rows.push(row);
        write(KEYS.groupings, rows);
        return row;
      },
      async deleteGrouping(id) {
        const rows = read(KEYS.groupings);
        const left = rows.filter((g) => g.id !== id);
        if (left.length === rows.length) throw refused(404, 'That grouping is not here.');
        write(KEYS.groupings, left);
        return { deleted: true };
      },

      // ---------- saved rooms ----------
      async templates() {
        return { templates: read(KEYS.templates).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100) };
      },
      async saveTemplate(input = {}) {
        const desks = [];
        for (const d of Array.isArray(input.desks) ? input.desks : []) {
          if (!DESK_SHAPES.includes(d && d.shape)) continue;
          desks.push({
            id: clean(d.id, 40) || newId('d'), shape: d.shape, seats: num(d.seats, 1, 12, 2),
            facing: FACINGS.includes(d.facing) ? d.facing : 'up', x: num(d.x, 0, 200, 0), y: num(d.y, 0, 200, 0),
          });
          if (desks.length >= 60) break;
        }
        const objects = [];
        for (const o of Array.isArray(input.objects) ? input.objects : []) {
          if (!OBJECT_SHAPES.includes(o && o.shape)) continue;
          objects.push({
            id: clean(o.id, 40) || newId('o'), shape: o.shape, label: clean(o.label, 30),
            x: num(o.x, 0, 200, 0), y: num(o.y, 0, 200, 0), w: num(o.w, 1, 200, 6), h: num(o.h, 1, 200, 4),
          });
          if (objects.length >= 40) break;
        }
        if (!desks.length && !objects.length) throw refused(400, 'There is nothing in this room to save.');
        let rows = read(KEYS.templates);
        if (rows.length >= MAX_TEMPLATES) rows = rows.sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_TEMPLATES - 1);
        const row = {
          id: newId('t'), name: clean(input.name, 60) || 'Untitled room',
          front: FRONTS.includes(input.front) ? input.front : 'top', desks, objects, createdAt: clock(),
        };
        rows.push(row);
        write(KEYS.templates, rows);
        return row;
      },
      async renameTemplate(id, name) {
        const rows = read(KEYS.templates);
        const row = rows.find((t) => t.id === id);
        if (!row) throw refused(404, 'That room is not here.');
        row.name = clean(name, 60) || row.name;
        write(KEYS.templates, rows);
        return row;
      },
      async deleteTemplate(id) {
        const rows = read(KEYS.templates);
        const left = rows.filter((t) => t.id !== id);
        if (left.length === rows.length) throw refused(404, 'That room is not here.');
        write(KEYS.templates, left);
        return { deleted: true };
      },
    };

    /**
     * The example class a visitor finds on their first visit, so the tools
     * that work from a class list work the moment the page opens. Made once
     * per desk: a visitor who deletes it has decided they do not want it, and
     * it does not come back until the desk itself is cleared. Marked as an
     * example so it is never offered for moving into an account.
     */
    function seedExample(names) {
      if (storage.getItem(KEYS.seeded)) return null;
      storage.setItem(KEYS.seeded, String(clock()));
      if (read(KEYS.lists).length) return null;
      const now = clock();
      const list = {
        id: newId('list'), name: 'Example class', example: true,
        students: normaliseStudents(names), createdAt: now, updatedAt: now,
      };
      write(KEYS.lists, [list]);
      return list;
    }

    return {
      api,
      seedExample,
      expireIfStale,
      clearAll,
      /** The class lists a visitor made, for moving into an account. */
      lists: () => read(KEYS.lists).filter((l) => !l.example),
      /** Every list here, the example class included. */
      everyList: () => read(KEYS.lists),
      forgetLists: () => { storage.removeItem(KEYS.lists); },
      hasLists: () => read(KEYS.lists).some((l) => !l.example && l.students.length),
    };
  }

  /**
   * A visitor's tools, made ready to join a teacher's own desk.
   *
   * The tools point at class lists and pupils by id, and those ids were made
   * in this browser. Moving a list into an account gives it — and every pupil
   * on it — a new id, so each tool is rewritten to the new ones: a seating
   * plan comes across with the same children in the same seats.
   *
   * `moved` maps each list that made it into the account to its new id and
   * its pupils' new ids. Anything tied to a list that did NOT come — the
   * example class, or a list that failed to send — cannot be brought across
   * honestly: a plan keyed by that list is dropped, a choice of that list is
   * cleared, and a tool still carrying its pupils (groups dealt from the
   * example class, say) arrives fresh instead of full of strangers.
   *
   * What comes: a tool the visitor added themselves, a tool linked to a list
   * that came, and a starter tool that `worth` says holds something. The
   * rest of the starter board — the tools laid out for every visitor and
   * never touched — stays behind; the teacher's own desk does not need a
   * second, empty copy of them.
   *
   * Pure: no storage, no DOM, so the rules can be tested on their own.
   */
  function carryOver(items, { moved = new Map(), worth = () => false } = {}) {
    const pupils = new Map();
    for (const m of moved.values()) for (const [was, now] of m.students) pupils.set(was, now);
    // Every pupil id this browser ever made has the same look; one that is
    // not being carried across belongs to a list that stayed behind.
    const localPupil = (v) => typeof v === 'string' && /^s_[a-z0-9]+$/.test(v);
    const out = [];

    for (const item of Array.isArray(items) ? items : []) {
      if (!item || typeof item.type !== 'string') continue;
      let linked = false;
      let strays = false;

      const swap = (v) => {
        if (typeof v !== 'string') return v;
        if (v.startsWith('list:')) {
          const m = moved.get(v.slice(5));
          if (m) { linked = true; return `list:${m.id}`; }
          return null;                     // a list that is not coming
        }
        if (pupils.has(v)) return pupils.get(v);
        if (localPupil(v)) strays = true;
        return v;
      };
      const walk = (v) => {
        if (Array.isArray(v)) return v.map((x) => { const y = walk(x); return y === null ? '' : y; });
        if (v && typeof v === 'object') {
          const o = {};
          for (const [k, x] of Object.entries(v)) {
            const key = swap(k);
            if (key === null) continue;    // e.g. the example class's seating plan
            const y = walk(x);
            o[key] = y === null ? '' : y;
          }
          return o;
        }
        return swap(v);
      };

      let state = walk(item.state && typeof item.state === 'object' ? item.state : {});
      if (strays) { state = {}; linked = false; }
      const own = !String(item.id || '').startsWith('g_');
      const candidate = { type: item.type, state, x: item.x, y: item.y, w: item.w, h: item.h };
      if (own || linked || (!strays && worth(candidate))) out.push(candidate);
    }
    return out;
  }

  Desk.localApi = { make, exampleNames, carryOver, EXPIRY_DAYS, PREFIX };
}(window.Desk = window.Desk || {}));
