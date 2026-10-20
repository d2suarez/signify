// ===================================================================
// Widget — Seating plan
//
// A room you arrange, and a class you sit in it.
//
// Three decisions shape the whole thing:
//
//   * The plan belongs to the CLASS, not to the widget. One seating widget
//     holds a plan per class and switching the picker switches the room, so a
//     teacher with five classes needs one card, not five.
//   * The card is read-only. A seating chart's job during a lesson is to be
//     looked at — dragging a child across the room by accident while taking
//     the register is not a feature. Editing happens in the big view.
//   * Every drag has a tap equivalent. Interactive whiteboards and tablets
//     make drag-and-drop miserable; tap a name, tap a seat does the same job.
//
// Geometry is in grid cells, not pixels, so the same plan draws at thumbnail
// size on the card and wall size on the projector.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, icon, clamp, shuffle, toast, initials } = Desk;

  // The room, in cells. 48x32 is about six pairs across and six rows deep —
  // a real classroom, with space left over to push the furniture around.
  const COLS = 48;
  const ROWS = 32;

  const SEAT_W = 4;   // a seat is always this way round, whichever way the
  const SEAT_H = 3;   // desk faces, so names never read sideways
  const DESK_D = 2;   // how deep the desk surface is

  const SHAPES = {
    row:   { label: 'Desks in a row', min: 1, max: 6, blurb: 'Seats along one side.' },
    table: { label: 'Table', min: 2, max: 10, blurb: 'Seats along both sides.' },
    round: { label: 'Round table', min: 3, max: 10, blurb: 'Seats all the way round.' },
  };

  const FACINGS = ['up', 'right', 'down', 'left'];
  const isVertical = (facing) => facing === 'left' || facing === 'right';

  // ---------------- which wall the front is ----------------
  //
  // Not every room faces the way the plan was drawn. A teacher whose board is
  // on the long wall needs the front on the long wall, or every desk they
  // place is turned the wrong way and the plan reads as somebody else's room.
  //
  // Everything below works in "along / away" terms — along the front wall,
  // and away from it — and converts to room coordinates at the last moment.

  const FRONTS = ['top', 'right', 'bottom', 'left'];
  const FRONT_LABEL = { top: 'Top', right: 'Right', bottom: 'Bottom', left: 'Left' };
  const frontIsSide = (front) => front === 'left' || front === 'right';

  // Which way a pupil looks to face the board.
  const FACE_FRONT = { top: 'up', bottom: 'down', left: 'left', right: 'right' };
  // ...and which way is "further along the front wall", for the side arms of a horseshoe.
  const ALONG_PLUS = { top: 'right', bottom: 'right', left: 'down', right: 'down' };
  const ALONG_MINUS = { top: 'left', bottom: 'left', left: 'up', right: 'up' };

  const alongMax = (front) => (frontIsSide(front) ? ROWS : COLS);
  const awayMax = (front) => (frontIsSide(front) ? COLS : ROWS);

  /** (along, away) plus a footprint, in room coordinates. */
  function toRoom(front, along, away, w, h) {
    if (front === 'top') return { x: along, y: away };
    if (front === 'bottom') return { x: along, y: ROWS - away - h };
    if (front === 'left') return { x: away, y: along };
    return { x: COLS - away - w, y: along };
  }

  // Objects are the furniture that is not a desk: the teacher's own desk, a
  // bookcase, the door, a rug. Deliberately three plain shapes the teacher
  // labels themselves rather than a catalogue of clip-art — every classroom
  // has something the catalogue would not have had.
  const OBJECTS = {
    rect:   { label: 'Box',   w: 8, h: 5, blurb: 'A desk, a bookcase, a cupboard.' },
    circle: { label: 'Round', w: 8, h: 8, blurb: 'A rug, a round table, a bin.' },
    strip:  { label: 'Strip', w: 12, h: 2, blurb: 'A door, a window, the board, a wall.' },
  };

  // ---------------- geometry ----------------

  /**
   * Where a desk's surface and seats sit, in cells, relative to its own
   * top-left corner. `facing` is the way the pupils look; the desk is always
   * on the side they are looking towards.
   */
  function layout(desk) {
    const n = clamp(desk.seats | 0, 1, 12);
    const seats = [];

    if (desk.shape === 'round') {
      // Enough radius that the seats go round without touching.
      const ring = Math.max(4.5, (n * SEAT_W) / (2 * Math.PI) + 1.8);
      const side = 2 * ring + Math.max(SEAT_W, SEAT_H);
      const c = side / 2;
      for (let i = 0; i < n; i += 1) {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
        seats.push({ x: c + ring * Math.cos(a) - SEAT_W / 2, y: c + ring * Math.sin(a) - SEAT_H / 2, w: SEAT_W, h: SEAT_H });
      }
      return { w: side, h: side, circle: { cx: c, cy: c, r: Math.max(3, ring - SEAT_H / 2 - 0.5) }, seats };
    }

    if (desk.shape === 'table') {
      const near = Math.ceil(n / 2);
      const far = n - near;
      const runs = Math.max(near, far, 1);
      if (isVertical(desk.facing)) {
        const w = SEAT_W + DESK_D + SEAT_W;
        const h = runs * SEAT_H;
        for (let i = 0; i < near; i += 1) seats.push({ x: 0, y: i * SEAT_H, w: SEAT_W, h: SEAT_H });
        for (let i = 0; i < far; i += 1) seats.push({ x: SEAT_W + DESK_D, y: i * SEAT_H, w: SEAT_W, h: SEAT_H });
        return { w, h, body: { x: SEAT_W, y: 0, w: DESK_D, h }, seats };
      }
      const w = runs * SEAT_W;
      const h = SEAT_H + DESK_D + SEAT_H;
      for (let i = 0; i < near; i += 1) seats.push({ x: i * SEAT_W, y: 0, w: SEAT_W, h: SEAT_H });
      for (let i = 0; i < far; i += 1) seats.push({ x: i * SEAT_W, y: SEAT_H + DESK_D, w: SEAT_W, h: SEAT_H });
      return { w, h, body: { x: 0, y: SEAT_H, w, h: DESK_D }, seats };
    }

    // row — one line of seats, desk on the side they face
    if (desk.facing === 'up' || desk.facing === 'down') {
      const w = n * SEAT_W;
      const h = DESK_D + SEAT_H;
      const deskFirst = desk.facing === 'up';
      for (let i = 0; i < n; i += 1) seats.push({ x: i * SEAT_W, y: deskFirst ? DESK_D : 0, w: SEAT_W, h: SEAT_H });
      return { w, h, body: { x: 0, y: deskFirst ? 0 : SEAT_H, w, h: DESK_D }, seats };
    }
    const w = DESK_D + SEAT_W;
    const h = n * SEAT_H;
    const deskFirst = desk.facing === 'left';
    for (let i = 0; i < n; i += 1) seats.push({ x: deskFirst ? DESK_D : 0, y: i * SEAT_H, w: SEAT_W, h: SEAT_H });
    return { w, h, body: { x: deskFirst ? 0 : SEAT_W, y: 0, w: DESK_D, h }, seats };
  }

  /**
   * The same desk seen from the other end of the room.
   *
   * Which axis to mirror follows the front wall: a class at the top of the
   * plan looks up, so their left and right are swapped horizontally — but a
   * class facing a side wall has theirs swapped vertically instead.
   */
  function mirror(l, axis) {
    const flip = axis === 'y'
      ? (r) => ({ ...r, y: l.h - r.y - r.h })
      : (r) => ({ ...r, x: l.w - r.x - r.w });
    return {
      w: l.w,
      h: l.h,
      body: l.body ? flip(l.body) : undefined,
      circle: l.circle
        ? (axis === 'y'
          ? { ...l.circle, cy: l.h - l.circle.cy }
          : { ...l.circle, cx: l.w - l.circle.cx })
        : undefined,
      seats: l.seats.map(flip),
    };
  }

  const overlaps = (a, b) => !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);

  /** Somewhere this desk fits without sitting on top of another. */
  function findSpace(desks, size, objects = []) {
    const taken = desks.map((d) => ({ x: d.x, y: d.y, ...pick(layout(d)) }))
      .concat(objects.map((o) => ({ x: o.x, y: o.y, w: o.w, h: o.h })));
    for (let y = 0; y + size.h <= ROWS; y += 1) {
      for (let x = 0; x + size.w <= COLS; x += 1) {
        // Two cells of air, so a new desk lands beside its neighbour rather
        // than welded to it.
        const probe = { x, y, w: size.w + 2, h: size.h + 2 };
        if (!taken.some((t) => overlaps(t, probe))) return { x, y };
      }
    }
    return { x: 0, y: 0 };
  }
  const pick = (l) => ({ w: l.w, h: l.h });

  const seatId = (deskId, i) => `${deskId}#${i}`;

  /**
   * Tidies a plan against the class list, in place.
   *
   * `rosterKnown` is the important argument and the reason this is its own
   * function. A desk that has shrunk must give up seats it no longer has —
   * that depends only on the furniture and is always safe. Dropping a PUPIL,
   * though, is only safe when we were actually told who is in the class: a
   * refused roster lookup returns nobody, and treating that as "everybody has
   * left" deletes the entire arrangement.
   *
   * That is not hypothetical. While the sign-in bug was answering 401 to every
   * roster request, this wiped a term's worth of seating plans — four classes
   * — and the teacher was left wondering what they had clicked. Silence is
   * not an empty class.
   */
  function prunePlan(p, studentIds, rosterKnown) {
    if (!p) return p;

    const live = new Set();
    for (const d of p.desks) for (let i = 0; i < d.seats; i += 1) live.add(seatId(d.id, i));
    for (const seat of Object.keys(p.seats)) if (!live.has(seat)) delete p.seats[seat];

    if (!rosterKnown) return p;
    const here = new Set(studentIds);
    for (const [seat, who] of Object.entries(p.seats)) if (!here.has(who)) delete p.seats[seat];
    return p;
  }
  const newId = () => `d${Math.random().toString(36).slice(2, 9)}`;

  /**
   * What to write in a seat.
   *
   * A chair is about forty pixels wide, and "Elliot Shaw" in forty pixels is
   * "Elliot S…" — which is worse than useless, because the bit that got cut
   * is the bit that tells two Elliots apart. So: first names, and a surname
   * initial only for the pupils who actually share one. That is how a class
   * list is read aloud anyway.
   */
  function shortNames(students) {
    const firsts = new Map();
    for (const st of students) {
      const first = String(st.name).trim().split(/\s+/)[0] || st.name;
      firsts.set(first, (firsts.get(first) || 0) + 1);
    }
    const out = new Map();
    for (const st of students) {
      const parts = String(st.name).trim().split(/\s+/);
      const first = parts[0] || st.name;
      const surname = parts.length > 1 ? parts[parts.length - 1] : '';
      out.set(st.id, firsts.get(first) > 1 && surname ? `${first} ${surname[0]}.` : first);
    }
    return out;
  }

  // ---------------- starting arrangements ----------------
  // An empty room is a wall to climb. These are the three ways a classroom is
  // actually laid out, sized to the class that is in it.

  /**
   * Lays desks out in rows parallel to the front wall, everybody facing it.
   * Works in along/away terms so the same code produces a sensible room
   * whichever wall the board is on.
   */
  function gridOf(front, specs) {
    if (!specs.length) return [];
    const facing = FACE_FRONT[front];
    const probe = layout({ ...specs[0], facing });
    const side = frontIsSide(front);
    const aSize = side ? probe.h : probe.w;      // extent along the front
    const dSize = side ? probe.w : probe.h;      // extent away from it

    const across = Math.max(1, Math.min(6, Math.floor((alongMax(front) - 2) / (aSize + 2))));
    const gapA = Math.max(1, Math.floor((alongMax(front) - across * aSize) / (across + 1)));

    const desks = [];
    specs.forEach((spec, i) => {
      const along = gapA + (i % across) * (aSize + gapA);
      const away = 4 + Math.floor(i / across) * (dSize + 3);
      if (away + dSize > awayMax(front)) return;
      const w = side ? dSize : aSize;
      const h = side ? aSize : dSize;
      desks.push({ id: newId(), shape: spec.shape, seats: spec.seats, facing, ...toRoom(front, along, away, w, h) });
    });
    return desks;
  }

  const repeat = (n, spec) => Array.from({ length: Math.max(1, n) }, () => spec);

  const rowsOfPairs = (count, front) => gridOf(front, repeat(Math.ceil(count / 2), { shape: 'row', seats: 2 }));
  const tablesOfFour = (count, front) => gridOf(front, repeat(Math.ceil(count / 4), { shape: 'table', seats: 4 }));

  /**
   * Three arms round an open front, everybody facing in. The arms are sized
   * from the class rather than fixed, so a class of 12 does not get a
   * horseshoe with eight empty seats down one side.
   */
  function horseshoe(count, front) {
    const desks = [];
    const side = frontIsSide(front);
    const perArm = Math.max(1, Math.round(count / 4));
    const backCount = Math.max(1, count - perArm * 2);

    // The two arms run away from the front, facing each other across the room.
    const armFacing = [ALONG_PLUS[front], ALONG_MINUS[front]];
    const arm = layout({ shape: 'row', seats: 1, facing: armFacing[0] });
    const armA = side ? arm.h : arm.w;
    const armD = side ? arm.w : arm.h;
    for (let i = 0; i < perArm; i += 1) {
      const away = 5 + i * armD;
      if (away + armD > awayMax(front) - 3) break;
      const w = side ? armD : armA;
      const h = side ? armA : armD;
      desks.push({ id: newId(), shape: 'row', seats: 1, facing: armFacing[0], ...toRoom(front, 1, away, w, h) });
      desks.push({ id: newId(), shape: 'row', seats: 1, facing: armFacing[1], ...toRoom(front, alongMax(front) - 1 - armA, away, w, h) });
    }

    // ...and a back row across the wall opposite the front, looking at it.
    const across = Math.min(5, Math.max(1, Math.ceil(backCount / 2)));
    const per = Math.max(1, Math.ceil(backCount / across));
    const back = layout({ shape: 'row', seats: per, facing: FACE_FRONT[front] });
    const backA = side ? back.h : back.w;
    const backD = side ? back.w : back.h;
    const usable = alongMax(front) - 2 * (armA + 2);
    const gap = Math.max(1, Math.floor((usable - across * backA) / (across + 1)));
    for (let i = 0; i < across; i += 1) {
      const along = armA + 2 + gap + i * (backA + gap);
      if (along + backA > alongMax(front)) break;
      const w = side ? backD : backA;
      const h = side ? backA : backD;
      desks.push({ id: newId(), shape: 'row', seats: per, facing: FACE_FRONT[front], ...toRoom(front, along, awayMax(front) - backD - 2, w, h) });
    }
    return desks;
  }

  /**
   * How many pupils to put at each desk.
   *
   * Two rules, in this order:
   *
   *   1. **Nobody sits on their own if the room allows it otherwise.** Dealing
   *      the class out desk by desk, or filling seats in order, both strand
   *      whoever falls on the boundary — seven pupils across three threes
   *      becomes 3, 3, 1, and that last child is sitting alone for the lesson.
   *      3, 2, 2 seats exactly the same class with nobody isolated.
   *   2. **Then use as many tables as possible.** Six pupils across three
   *      threes has no lone child either way, but 3, 3, 0 leaves a table
   *      standing empty while the rest of the class is packed shoulder to
   *      shoulder; 2, 2, 2 uses the room the teacher actually laid out.
   *
   * First beats second where they pull apart, and they do: four pupils across
   * three threes has to leave a table empty, because 2, 1, 1 buys that table
   * at the price of two children sitting alone. A child on their own is worse
   * than a spare table.
   *
   * `caps` and `already` are per desk and must be in the caller's shuffled
   * order, because the order decides which desks end up fuller.
   * Returns how many MORE go at each desk, and how many are left standing.
   */
  function shareOut(caps, already, total) {
    const k = caps.length;
    const room = caps.map((c, i) => Math.max(0, c - already[i]));
    const spare = room.reduce((a, b) => a + b, 0);
    const seating = Math.min(total, spare);

    // Solved exactly rather than greedily. Handing out pairs and hoping the
    // remainder lands somewhere sensible does not work: three pupils across
    // desks of 2, 3 and 4 becomes 2, 1, 0 that way, when 0, 3, 0 strands
    // nobody. The room is small enough — desks x pupils x seats — that
    // working out the genuine best costs nothing.
    //
    // Both rules are carried in one number: a lone pupil costs a whole desk's
    // worth, an empty desk costs one. Since no arrangement can leave more than
    // k desks empty, any saving in lone pupils outweighs every empty desk
    // there could ever be — which is the ordering, stated as arithmetic rather
    // than left to a tie-break that only happens to work.
    const LONE = k + 1;

    // cost[i][p] = the best that score can be if desks i..end seat p between
    // them, with take[i][p] the number that goes at desk i to achieve it.
    const INF = Infinity;
    const cost = Array.from({ length: k + 1 }, () => new Array(seating + 1).fill(INF));
    const take = Array.from({ length: k + 1 }, () => new Array(seating + 1).fill(0));
    cost[k][0] = 0;

    for (let i = k - 1; i >= 0; i -= 1) {
      for (let p = 0; p <= seating; p += 1) {
        let best = INF;
        let bestTake = 0;
        for (let t = 0; t <= Math.min(room[i], p); t += 1) {
          const rest = cost[i + 1][p - t];
          if (rest === INF) continue;
          const sitting = already[i] + t;
          const here = rest + (sitting === 1 ? LONE : 0) + (sitting === 0 ? 1 : 0);
          if (here < best) { best = here; bestTake = t; }
        }
        cost[i][p] = best;
        take[i][p] = bestTake;
      }
    }

    const add = new Array(k).fill(0);
    let left = seating;
    for (let i = 0; i < k; i += 1) {
      add[i] = take[i][left];
      left -= add[i];
    }

    return { add, standing: total - seating };
  }

  // ---------------- not beside last time's neighbour ----------------
  //
  // A fair shuffle is not quite what a teacher wants. With thirty children
  // there are hundreds of possible pairs, so SOME pair from last time lands
  // together again most weeks — and that is the pair the teacher notices.
  // So "Seat at random" now deals until nobody is next to anyone they sat
  // beside in the last arrangement, the same best-of-many approach the group
  // maker uses for keep-apart pairs.

  const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  /**
   * Which seats count as next to each other, as [seat, seat] pairs: two seats
   * at the same desk, or at two desks pushed together side by side. The desk
   * in front does not count — its surface is two cells deep, so the row ahead
   * is never within one cell.
   */
  function seatNeighbours(desks) {
    const seats = [];
    for (const d of desks) {
      layout(d).seats.forEach((r, i) => seats.push({
        id: seatId(d.id, i), desk: d.id, x: (d.x || 0) + r.x, y: (d.y || 0) + r.y, w: r.w, h: r.h,
      }));
    }
    const edges = [];
    for (let i = 0; i < seats.length; i += 1) {
      for (let j = i + 1; j < seats.length; j += 1) {
        const a = seats[i];
        const b = seats[j];
        if (a.desk === b.desk) { edges.push([a.id, b.id]); continue; }
        // Gap on each axis; negative means they overlap on that axis.
        const gx = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w));
        const gy = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h));
        if (Math.max(gx, gy) <= 1 && Math.min(gx, gy) < 0) edges.push([a.id, b.id]);
      }
    }
    return edges;
  }

  /** Every pair of pupils sitting next to each other in a plan. */
  function neighbourPairs(plan) {
    const out = new Set();
    if (!plan || !Array.isArray(plan.desks)) return out;
    const seats = plan.seats || {};
    for (const [a, b] of seatNeighbours(plan.desks)) {
      if (seats[a] && seats[b]) out.add(pairKey(seats[a], seats[b]));
    }
    return out;
  }

  const repeatCount = (edges, seats, avoid) => edges.reduce(
    (n, [a, b]) => n + (seats[a] && seats[b] && avoid.has(pairKey(seats[a], seats[b])) ? 1 : 0), 0);

  /**
   * "Last time" is the newest kept arrangement with at least half the class
   * in it — not merely the newest, which is often the room a moment after
   * "Empty the seats", or three pupils placed by hand.
   */
  function lastArrangement(list, classSize) {
    const enough = Math.max(2, Math.ceil(classSize / 2));
    return (list || []).find((snap) => Object.keys((snap.plan && snap.plan.seats) || {}).length >= enough) || null;
  }

  /**
   * One random dealing of `waiting` (pupil ids) into the plan's free seats.
   * Returns the whole seat map, the seats filled in the order they were
   * filled, and how many were left with nowhere to sit.
   */
  function dealSeats(p, waiting) {
    const pupils = shuffle(waiting);
    // Shuffling the DESKS is what moves the spare seats around the room.
    // Filling seats in order always left the same desks short — the empty
    // places piled up wherever the list happened to end.
    const desks = shuffle(p.desks.filter((d) => d.seats > 0));
    const caps = desks.map((d) => d.seats);
    const already = desks.map((d) => {
      let n = 0;
      for (let i = 0; i < d.seats; i += 1) if (p.seats[seatId(d.id, i)]) n += 1;
      return n;
    });

    const { add, standing } = shareOut(caps, already, pupils.length);

    const seats = { ...p.seats };
    const placed = [];
    desks.forEach((desk, di) => {
      if (!add[di]) return;
      // ...and shuffling within the desk decides WHICH chair is the empty
      // one, so it is not always the last seat that goes spare.
      const free = shuffle(
        Array.from({ length: desk.seats }, (_, i) => seatId(desk.id, i))
          .filter((id) => !p.seats[id]),
      );
      for (let k = 0; k < add[di]; k += 1) {
        seats[free[k]] = pupils[placed.length];
        placed.push(free[k]);
      }
    });
    return { seats, placed, standing };
  }

  /**
   * Deals the class, keeping nobody next to a pair in `avoid` if it can.
   *
   * Deals afresh until one has no repeats, so when a clean arrangement exists
   * the one chosen is still a fair pick among them. Tables of four or more
   * can make that rare by chance alone; then the best dealing is improved by
   * swapping pupils just seated, which only moves names between chairs and so
   * never undoes shareOut's choice of how many sit at each desk.
   */
  function seatAvoiding(p, waiting, avoid, tries = 300) {
    let best = dealSeats(p, waiting);
    if (!avoid || !avoid.size) return { ...best, repeats: 0 };
    const edges = seatNeighbours(p.desks);
    let score = repeatCount(edges, best.seats, avoid);
    for (let t = 1; t < tries && score; t += 1) {
      const next = dealSeats(p, waiting);
      const s = repeatCount(edges, next.seats, avoid);
      if (s < score) { best = next; score = s; }
    }

    const spots = best.placed;
    const seats = best.seats;
    let better = true;
    while (better && score) {
      better = false;
      for (let i = 0; i < spots.length && score; i += 1) {
        for (let j = i + 1; j < spots.length && score; j += 1) {
          const a = spots[i];
          const b = spots[j];
          [seats[a], seats[b]] = [seats[b], seats[a]];
          const s = repeatCount(edges, seats, avoid);
          if (s < score) { score = s; better = true; } else [seats[a], seats[b]] = [seats[b], seats[a]];
        }
      }
    }
    return { ...best, repeats: score };
  }

  // How many previous arrangements to keep per class. Enough to cover a
  // half-term of weekly changes, small enough that a board full of classes
  // stays a few tens of kilobytes.
  const KEEP_HISTORY = 12;

  const samePlan = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  /**
   * Puts a copy of a plan on the front of its class's history.
   *
   * Called before anything that destroys an arrangement, which is the only
   * moment it matters — a plan being built up seat by seat is not worth a
   * snapshot per click, and a plan that is about to be shuffled, emptied or
   * cleared is the one somebody will want back.
   *
   * A plan with no desks and nobody in it is not worth keeping, and neither
   * is one identical to the snapshot already at the front — restoring twice
   * in a row should not fill the list with copies of the same room.
   */
  function keepHistory(history, classKey, plan, why) {
    if (!plan || (!plan.desks.length && !Object.keys(plan.seats).length)) return history;
    const list = history[classKey] || (history[classKey] = []);
    const copy = JSON.parse(JSON.stringify(plan));
    if (list.length && samePlan(list[0].plan, copy)) return history;
    list.unshift({ at: Date.now(), why: why || '', plan: copy });
    list.length = Math.min(list.length, KEEP_HISTORY);
    return history;
  }

  const STARTERS = [
    { key: 'pairs', label: 'Rows of pairs', make: rowsOfPairs },
    { key: 'fours', label: 'Tables of four', make: tablesOfFour },
    { key: 'horseshoe', label: 'Horseshoe', make: horseshoe },
  ];

  // ===================================================================

  Desk.widget({
    type: 'seating',
    name: 'Seating plan',
    blurb: 'Arrange the room, then sit the class in it. One plan per class, switched from the same card.',
    icon: 'seating',
    category: 'class',
    tone: 'card',
    guest: true,
    fills: true,
    size: { w: 6, h: 7 },
    min: { w: 3, h: 5 },
    needsRoster: true,

    // Pure, and the one piece of this widget where getting it wrong seats a
    // child on their own — so it is exported and tested directly.
    _shareOut: shareOut,
    _seatNeighbours: seatNeighbours,
    _neighbourPairs: neighbourPairs,
    _lastArrangement: lastArrangement,
    _seatAvoiding: seatAvoiding,
    _prunePlan: prunePlan,
    _keepHistory: keepHistory,
    _KEEP_HISTORY: KEEP_HISTORY,

    init(s) {
      if (typeof s.classKey !== 'string') s.classKey = '';
      if (!s.plans || typeof s.plans !== 'object') s.plans = {};
      if (typeof s.flipped !== 'boolean') s.flipped = false;
      // Which of the three room sizes the walls are set to.
      if (!['small', 'medium', 'large'].includes(s.room)) s.room = 'medium';
      // classKey -> [{ at, why, plan }], newest first. See keep() below.
      if (!s.history || typeof s.history !== 'object') s.history = {};
    },

    holdsContent(s) {
      const plans = Object.values(s.plans || {}).filter((p) => p.desks && p.desks.length);
      return plans.length ? `${plans.length} seating plan${plans.length === 1 ? '' : 's'} go with it.` : '';
    },

    mount(ctx) {
      const s = ctx.state;
      const editable = !!ctx.expanded;

      let students = [];
      // Remembered when the class loads, because printing happens in one
      // gesture and cannot wait on a lookup.
      let className = '';
      let short = new Map();         // student id -> what fits in a chair
      let selectedStudent = null;    // tap-to-place
      let named = null;              // whose full name is showing, when not editing
      let arriving = null;           // pupil id -> order, for the one draw after seating at random
      let selected = null;           // { kind: 'desk' | 'object', id } — what the inspector is showing
      let dragging = null;
      let ghost = null;

      const room = el('div.room', { style: { '--cols': COLS, '--rows': ROWS } });

      /**
       * How big the room is.
       *
       * Not how big the desks are: the desks are a fixed size in cells, and
       * the room is the walls around them. A small room with six desks in it
       * draws those desks large, because they take more of it — which is the
       * same thing a real classroom does. The teacher picks the room; the
       * plan underneath never changes, so it reads the same to everyone.
       *
       * The room is never smaller than the furniture standing in it, or a
       * desk would be outside the wall.
       */
      const ROOMS = [
        { key: 'small', label: 'Small', cols: 24 },
        { key: 'medium', label: 'Medium', cols: 34 },
        { key: 'large', label: 'Large', cols: COLS },
      ];
      const ROOM_RATIO = ROWS / COLS;

      function viewOf(p) {
        const chosen = ROOMS.find((r) => r.key === s.room) || ROOMS[1];
        let cols = chosen.cols;
        let rows = Math.round(cols * ROOM_RATIO);
        for (const d of (p ? p.desks : [])) {
          const l = layout(d);
          cols = Math.max(cols, d.x + l.w);
          rows = Math.max(rows, d.y + l.h);
        }
        for (const o of (p ? p.objects : [])) {
          cols = Math.max(cols, o.x + o.w);
          rows = Math.max(rows, o.y + o.h);
        }
        return { cols: clamp(Math.ceil(cols), 12, COLS), rows: clamp(Math.ceil(rows), 8, ROWS), ox: 0, oy: 0 };
      }

      // The walls only move when the teacher moves them, or when a piece of
      // furniture would otherwise end up outside them.
      let view = { cols: COLS, rows: ROWS, ox: 0, oy: 0 };
      let viewKey = '';

      function refreshView(p) {
        if (dragging) return;
        const key = `${s.classKey}|${s.room}|${p ? p.desks.length : 0}|${p ? p.objects.length : 0}`;
        const outside = p && [
          ...p.desks.map((d) => { const l = layout(d); return { x: d.x, y: d.y, w: l.w, h: l.h }; }),
          ...p.objects,
        ].some((b) => b.x + b.w > view.cols || b.y + b.h > view.rows);
        if (key === viewKey && !outside) return;
        viewKey = key;
        view = viewOf(p);
      }

      const tray = el('div.plan-tray');
      const toolbar = el('div.plan-toolbar');
      const inspector = el('div.plan-inspector');

      const picker = Desk.roster.picker({
        value: s.classKey,
        onPick: (key) => {
          // The picker announces the current class on mount too; only a real
          // change should swap the room out from under the teacher.
          if (key !== s.classKey) { s.classKey = key; selected = null; selectedStudent = null; ctx.save(); }
          load();
        },
      });

      // The front bar is inside the room now rather than stacked above it,
      // because it has to be able to sit on any of the four walls.
      const frontBar = el('div.room-front', { text: 'Front of the room' });
      room.append(frontBar);
      const roomBox = el('div.room-box', {}, room);
      const roomWrap = el('div.room-wrap', {}, roomBox);
      // What goes on paper: the room and nothing else. A block wrapper rather
      // than the centring flex box, so the printed heading sits above the
      // plan instead of beside it.
      const printArea = el('div.plan-print', {}, roomWrap);

      ctx.root.append(el('div.seating', { class: editable ? 'is-editable' : '' }, [
        el('div.plan-head', {}, [picker, toolbar]),
        el('div.plan-stage', {}, [
          printArea,
          editable ? el('aside.plan-side', {}, [tray, inspector]) : null,
        ]),
      ]));

      // ---------------- the plan for the class in front of us ----------------

      function plan() {
        if (!s.classKey) return null;
        if (!s.plans[s.classKey]) s.plans[s.classKey] = { desks: [], seats: {}, objects: [], front: 'top' };
        const p = s.plans[s.classKey];
        if (!Array.isArray(p.desks)) p.desks = [];
        if (!Array.isArray(p.objects)) p.objects = [];              // added later than desks
        if (!p.seats || typeof p.seats !== 'object') p.seats = {};
        if (!FRONTS.includes(p.front)) p.front = 'top';
        return p;
      }

      const frontOf = () => (plan() ? plan().front : 'top');
      // Mirroring swaps left and right for a class facing up or down the
      // plan, and top and bottom for one facing a side wall.
      const mirrorAxis = () => (frontIsSide(frontOf()) ? 'y' : 'x');

      const isSelected = (kind, id) => !!selected && selected.kind === kind && selected.id === id;
      const selectedDeskObj = () => (selected && selected.kind === 'desk' ? plan().desks.find((d) => d.id === selected.id) : null);
      const selectedObject = () => (selected && selected.kind === 'object' ? plan().objects.find((o) => o.id === selected.id) : null);

      /**
       * Loads the class, then tidies the plan against it.
       *
       * Everything here is held in LOCALS until the awaits are done, and the
       * result is thrown away if another load has started meanwhile. Both of
       * those matter, and the reason is the bug that emptied a term of seating
       * plans:
       *
       * `students` used to be assigned straight into the closure variable, and
       * this function awaits twice — once for the roster, once for the class
       * name. Opening a card into the big view mounts a second copy of the
       * widget, which starts its own load; that second load reset the shared
       * `students` to [] while the first was still waiting on its second
       * await. The first then pruned the plan against an empty list it had no
       * business believing, with `rosterKnown` still true from its own
       * successful fetch — so every seat went, and the next save made it
       * permanent. It looked exactly like what the teacher reported: the plan
       * is there on the card, and gone the moment you expand it.
       */
      let loadSeq = 0;
      async function load() {
        const mine = ++loadSeq;
        let got = [];
        let name = '';
        // Whether we actually KNOW who is in this class, as opposed to having
        // failed to ask. The difference is the whole of prunePlan.
        let rosterKnown = false;

        if (s.classKey) {
          try {
            got = await Desk.roster.members(s.classKey);
            rosterKnown = true;
          } catch (e) { toast(e.message, 'warn'); }
          try {
            const found = (await Desk.roster.classes()).find((c) => c.key === s.classKey);
            name = (found && found.name) || '';
          } catch { /* the plan prints without a name in its heading */ }
        }

        // A newer load started while this one was waiting: it has asked the
        // same questions more recently, so the answers here are stale and must
        // not be allowed to touch the plan.
        if (mine !== loadSeq) return;

        students = got;
        className = name;
        short = shortNames(students);

        prunePlan(plan(), students.map((x) => x.id), rosterKnown);
        draw();
      }

      /** Snapshot this class's plan before something destroys it. */
      const keep = (why) => { if (s.classKey) keepHistory(s.history, s.classKey, plan(), why); };

      const seatedIds = () => new Set(Object.values(plan() ? plan().seats : {}));
      const unseated = () => { const taken = seatedIds(); return students.filter((x) => !taken.has(x.id)); };
      const studentById = (id) => students.find((x) => x.id === id) || null;

      function allSeats() {
        const p = plan();
        if (!p) return [];
        const out = [];
        for (const d of p.desks) for (let i = 0; i < d.seats; i += 1) out.push(seatId(d.id, i));
        return out;
      }

      // ---------------- drawing ----------------

      function draw() {
        /* The side panel is rebuilt from scratch on every change — that is
           what keeps it honest about the desk you have selected. But a rebuilt
           panel starts at the top, and a teacher who has scrolled down to the
           rotate button was being thrown back up the moment they used it. So
           the panel's own scroll position is kept across the rebuild: it is
           the teacher's place in the page, not the panel's. */
        const keep = holdScroll();
        drawToolbar();
        drawRoom();
        if (editable) { drawTray(); drawInspector(); }
        keep();
      }

      /**
       * Remembers where the panel is scrolled to, and puts it back.
       *
       * Which element actually scrolls depends on the width: the side panel
       * beside the room on a wide screen, the whole stage below about 1100px
       * where the panel sits under it. Both are asked, and only the one that
       * had been scrolled is restored.
       */
      function holdScroll() {
        const marks = ['.plan-side', '.plan-stage'].map((sel) => {
          const node = ctx.root.querySelector(sel);
          return { sel, top: node ? node.scrollTop : 0 };
        });
        return () => {
          for (const mark of marks) {
            if (!mark.top) continue;
            const node = ctx.root.querySelector(mark.sel);
            if (node) node.scrollTop = mark.top;
          }
        };
      }

      function drawToolbar() {
        Desk.clear(toolbar);
        const p = plan();

        toolbar.append(el('button.btn.btn--small', {
          svg: icon(s.flipped ? 'person' : 'present', 14),
          title: s.flipped
            ? 'Showing the room as the class sees it. Switch back to your own view.'
            : 'Showing the room as you see it from the front. Switch to the pupils’ view.',
          onclick: () => { s.flipped = !s.flipped; ctx.save(); draw(); },
        }, s.flipped ? ' Class’s view' : ' My view'));

        if (!editable) {
          toolbar.append(el('button.btn.btn--small.btn--primary', {
            svg: icon('expand', 14), onclick: () => ctx.expand && ctx.expand(),
          }, ' Open to edit'));
          return;
        }

        if (p && p.desks.length) {
          toolbar.append(
            el('button.btn.btn--small.btn--primary', { svg: icon('shuffle', 14), onclick: fillAtRandom }, ' Seat at random'),
            el('button.btn.btn--small', { svg: icon('print', 14), onclick: printPlan }, ' Print'),
            el('button.btn.btn--small', { onclick: clearSeats }, 'Empty the seats'),
            el('button.btn.btn--small', { svg: icon('trash', 14), onclick: clearRoom }, ' Clear the room'),
          );
        }
      }

      /**
       * The plan on paper — for the supply teacher, the wall, or a clipboard.
       *
       * The room is re-sized for the sheet first. It is drawn at whatever
       * pixel size its box happens to be, and on a card that is a thumbnail
       * showing initials; printing that would waste a page. 700px across is
       * about the printable width of A4 or Letter at portrait, which leaves
       * every seat wide enough for a real name.
       *
       * Which way round it prints follows what is on screen, and the heading
       * says which — a plan handed to somebody standing at the front and a
       * plan read from a pupil's desk are mirror images, and one of them is
       * useless if you cannot tell which you are holding.
       */
      function printPlan() {
        const p = plan();
        if (!p || !p.desks.length) { toast('There is no plan to print yet.', 'warn'); return; }

        const PRINT_W = 700;
        Desk.print(printArea, {
          title: className || 'Seating plan',
          subtitle: s.flipped ? 'As the class sees it' : 'As you see it from the front',
          prepare: () => { printing = true; sizeRoom(PRINT_W, PRINT_W); },
          restore: () => { printing = false; fit(); },
        });
      }

      function drawRoom() {
        Desk.clear(room);
        const p = plan();
        room.append(frontBar);

        if (!p) { room.dataset.front = 'top'; room.append(el('p.hint.room-note', { text: 'Choose a class list to begin.' })); return; }

        room.dataset.front = p.front;
        refreshView(p);
        room.style.setProperty('--cols', String(view.cols));
        room.style.setProperty('--rows', String(view.rows));
        fit();
        drawObjects(p);
        if (!p.desks.length && !p.objects.length) { drawStarters(); return; }

        const axis = mirrorAxis();
        for (const desk of p.desks) {
          // Flipping shows the room the way the class sees it. Mirror the
          // geometry rather than the elements, so names stay readable — and
          // mirror INSIDE each desk as well as across the room, because from
          // the back of the class the left-hand chair of a pair is the
          // right-hand one. Getting only the desks the right way round makes
          // every pair read backwards, which is worse than not flipping.
          const l = s.flipped ? mirror(layout(desk), axis) : layout(desk);
          const x = (s.flipped && axis === 'x' ? COLS - desk.x - l.w : desk.x) - view.ox;
          const y = (s.flipped && axis === 'y' ? ROWS - desk.y - l.h : desk.y) - view.oy;

          const node = el('div.desk', {
            'data-id': desk.id,
            class: isSelected('desk', desk.id) ? 'is-selected' : '',
            style: { '--x': x, '--y': y, '--w': l.w, '--h': l.h },
          });

          if (l.circle) {
            node.append(el('div.desk-surface.desk-surface--round', {
              style: { '--bx': l.circle.cx - l.circle.r, '--by': l.circle.cy - l.circle.r, '--bw': l.circle.r * 2, '--bh': l.circle.r * 2 },
            }));
          } else {
            node.append(el('div.desk-surface', { style: { '--bx': l.body.x, '--by': l.body.y, '--bw': l.body.w, '--bh': l.body.h } }));
          }

          l.seats.forEach((rect, i) => {
            const id = seatId(desk.id, i);
            const who = studentById(p.seats[id]);
            const seat = el('div.seat', {
              'data-seat': id,
              class: [who ? 'is-taken' : 'is-free', who && who.id === selectedStudent ? 'is-selected' : '',
                who && arriving && arriving.has(who.id) ? 'is-arriving' : ''].filter(Boolean).join(' '),
              style: { '--arrive': who && arriving && arriving.has(who.id) ? arriving.get(who.id) : 0, '--bx': rect.x, '--by': rect.y, '--bw': rect.w, '--bh': rect.h },
            }, [
              el('span.seat-name', { text: who ? (short.get(who.id) || who.name) : '', title: who ? who.name : '' }),
              el('span.seat-initials', { text: who ? initials(who.name) : '' }),
            ]);
            if (who) seat.dataset.who = who.id;
            if (editable) {
              seat.addEventListener('pointerdown', (e) => onSeatDown(e, id, who));
              seat.addEventListener('click', () => onSeatClick(id, who));
            } else if (who) {
              // Read-only, a tap has nothing to move — so it answers "who is
              // that?", which a chair-sized first name cannot when two pupils
              // share one.
              seat.addEventListener('click', () => { named = named === who.id ? null : who.id; showFullName(); });
            }
            node.append(seat);
          });

          if (editable) {
            node.querySelector('.desk-surface').addEventListener('pointerdown', (e) => onDeskDown(e, desk));
          }
          room.append(node);
        }
        showFullName();
      }

      /**
       * The full name of the pupil in hand (or tapped, when not editing),
       * floated over their chair. It hangs off the desk, not the seat, because
       * a seat clips its text — which is the whole problem — and it is placed
       * in the room's own grid units so it moves with the room when the room
       * resizes, rather than being measured once and left behind.
       */
      function showFullName() {
        for (const t of room.querySelectorAll('.seat-tag')) t.remove();
        for (const d of room.querySelectorAll('.desk.has-tag')) d.classList.remove('has-tag');
        const id = editable ? selectedStudent : named;
        const who = id && studentById(id);
        const seat = who && room.querySelector(`.seat[data-who="${CSS.escape(String(id))}"]`);
        if (!seat) return;
        const desk = seat.parentElement;
        const n = (el, k) => parseFloat(el.style.getPropertyValue(k)) || 0;
        const x = n(desk, '--x') + n(seat, '--bx') + n(seat, '--bw') / 2;   // room columns
        const y = n(desk, '--y') + n(seat, '--by');                          // room rows
        const tag = el('div.seat-tag', {
          text: who.name, role: 'status',
          class: [y < 3 ? 'is-below' : '', x < 6 ? 'is-left' : x > COLS - 6 ? 'is-right' : ''].filter(Boolean).join(' '),
          style: { '--bx': seat.style.getPropertyValue('--bx'), '--by': seat.style.getPropertyValue('--by'),
                   '--bw': seat.style.getPropertyValue('--bw'), '--bh': seat.style.getPropertyValue('--bh') },
        });
        desk.classList.add('has-tag');
        desk.append(tag);
      }

      /**
       * The furniture that is not a desk. Three plain shapes the teacher
       * labels themselves — every classroom has something a fixed catalogue
       * of clip-art would not have had.
       */
      function drawObjects(p) {
        const axis = mirrorAxis();
        for (const o of p.objects) {
          const x = (s.flipped && axis === 'x' ? COLS - o.x - o.w : o.x) - view.ox;
          const y = (s.flipped && axis === 'y' ? ROWS - o.y - o.h : o.y) - view.oy;
          const node = el(`div.room-object.room-object--${o.shape}`, {
            'data-id': o.id,
            class: isSelected('object', o.id) ? 'is-selected' : '',
            style: { '--x': x, '--y': y, '--w': o.w, '--h': o.h },
            title: o.label || OBJECTS[o.shape].label,
          }, el('span.room-object-label', { text: o.label || '' }));

          if (editable) {
            node.addEventListener('pointerdown', (e) => onObjectDown(e, o));
            node.append(el('span.object-resize', {
              title: 'Drag to resize',
              onpointerdown: (e) => { e.stopPropagation(); onObjectResize(e, o); },
            }));
          }
          room.append(node);
        }
      }

      function setRoom(key) {
        s.room = key;
        ctx.save();
        draw();
      }

      function addObject(shapeKey) {
        const p = plan();
        if (!p) { toast('Choose a class list first.', 'warn'); return; }
        if (p.objects.length >= 30) { toast('That is as much as one room can hold.', 'warn'); return; }
        const spec = OBJECTS[shapeKey];
        const draft = { id: newId(), shape: shapeKey, label: '', w: spec.w, h: spec.h };
        Object.assign(draft, findSpace(p.desks, { w: spec.w, h: spec.h }, p.objects));
        p.objects.push(draft);
        selected = { kind: 'object', id: draft.id };
        ctx.save(); draw();
      }

      function drawStarters() {
        const count = students.length || 30;
        room.append(el('div.starters', {}, [
          el('p.hint', { text: `Nothing in the room yet. Start from one of these — sized for ${students.length ? `the ${count} pupils on this list` : 'a class of 30'} — or add desks yourself.` }),
          el('div.starter-row', {}, STARTERS.map((st) => el('button.btn.btn--small', {
            text: st.label,
            onclick: () => {
              keep(`before ${st.label.toLowerCase()}`);
              plan().desks = st.make(count, plan().front);
              plan().seats = {};
              ctx.save(); draw();
            },
          }))),
        ]));
      }

      /**
       * Makes each titled section of a side panel fold away. The panel is long
       * once a desk is selected, and on a tablet the sections a teacher is not
       * using push the ones they are below the fold. Sections are found by
       * their heading, so the draw functions stay as they were; which are
       * folded is remembered with the widget.
       */
      function foldable(container, fixedKey) {
        const kids = [...container.childNodes];
        Desk.clear(container);
        if (!s.folded || typeof s.folded !== 'object') s.folded = {};
        let body = null;
        for (const node of kids) {
          if (node.matches && node.matches('h3.section-title')) {
            const key = fixedKey || node.textContent.replace(/\s*\(\d+\)\s*$/, '').trim();
            const section = el('div.fold', { class: s.folded[key] ? 'is-folded' : '' });
            const head = el('button.fold-head', {
              type: 'button',
              'aria-expanded': s.folded[key] ? 'false' : 'true',
              onclick: () => {
                s.folded[key] = !s.folded[key];
                section.classList.toggle('is-folded', !!s.folded[key]);
                head.setAttribute('aria-expanded', s.folded[key] ? 'false' : 'true');
                ctx.save();
              },
            }, [el('span', { svg: icon('chevron', 12) }), node.textContent]);
            body = el('div.fold-body');
            section.append(head, body);
            container.append(section);
          } else if (body) body.append(node);
          else container.append(node);
        }
      }

      function drawTray() {
        Desk.clear(tray);
        const waiting = unseated();
        tray.append(el('h3.section-title', { text: waiting.length ? `Not seated (${waiting.length})` : 'Everyone is seated' }));

        if (!students.length) { tray.append(el('p.hint', { text: 'No pupils on this list.' })); foldable(tray, 'tray'); return; }

        const list = el('div.tray-list');
        for (const st of waiting) {
          list.append(el('button.tray-chip', {
            text: st.name,
            class: selectedStudent === st.id ? 'is-selected' : '',
            onpointerdown: (e) => onChipDown(e, st.id),
            onclick: () => {
              selectedStudent = selectedStudent === st.id ? null : st.id;
              drawTray();
            },
          }));
        }
        tray.append(list);

        if (selectedStudent && seatedIds().has(selectedStudent)) {
          const who = studentById(selectedStudent);
          tray.append(el('button.btn.btn--small.btn--block', {
            onclick: () => { unseat(selectedStudent); selectedStudent = null; },
          }, `Take ${who ? who.name.split(' ')[0] : 'them'} out of their seat`));
        }
        tray.append(el('p.hint', {
          text: waiting.length
            ? 'Drag a name onto a seat, or tap the name and then the seat.'
            : 'Tap somebody in the room to move them.',
        }));
        foldable(tray, 'tray');
      }

      function drawInspector() {
        Desk.clear(inspector);
        const p = plan();
        if (!p) return;

        // Which wall the board is on. Everything else — which way a starter
        // faces, which way the class's view mirrors — follows from this.
        inspector.append(el('h3.section-title', { text: 'Front of the room' }));
        const fronts = el('div.seg.seg--tiny');
        for (const f of FRONTS) {
          fronts.append(el('button.seg-btn', {
            text: FRONT_LABEL[f],
            class: p.front === f ? 'is-on' : '',
            onclick: () => setFront(f),
          }));
        }
        inspector.append(fronts);

        // How big the room is. Fewer desks in a smaller room means bigger
        // desks — the same thing a real classroom does.
        inspector.append(el('h3.section-title', { text: 'Room size' }));
        const rooms = el('div.seg.seg--tiny');
        for (const r of ROOMS) {
          rooms.append(el('button.seg-btn', {
            text: r.label,
            class: s.room === r.key ? 'is-on' : '',
            onclick: () => setRoom(r.key),
          }));
        }
        inspector.append(rooms);

        inspector.append(el('h3.section-title', { text: 'Add a desk' }));
        const add = el('div.starter-row');
        for (const [key, shape] of Object.entries(SHAPES)) {
          add.append(el('button.btn.btn--small', { text: shape.label, title: shape.blurb, onclick: () => addDesk(key) }));
        }
        inspector.append(add);

        inspector.append(el('h3.section-title', { text: 'Add something else' }));
        const addObj = el('div.starter-row');
        for (const [key, spec] of Object.entries(OBJECTS)) {
          addObj.append(el('button.btn.btn--small', { text: spec.label, title: spec.blurb, onclick: () => addObject(key) }));
        }
        inspector.append(addObj);

        drawRooms();
        drawHistory();

        const desk = selectedDeskObj();
        const object = selectedObject();

        if (!desk && !object) {
          if (p.desks.length || p.objects.length) {
            inspector.append(el('p.hint', { text: 'Tap anything in the room to change it. Drag it to move it.' }));
          }
          foldable(inspector);
          return;
        }

        if (desk) drawDeskPanel(p, desk);
        if (object) drawObjectPanel(p, object);
        foldable(inspector);
      }

      function drawDeskPanel(p, desk) {
        const shape = SHAPES[desk.shape];
        inspector.append(
          el('h3.section-title', { text: shape.label }),
          el('div.plan-row', {}, [
            el('span.hint', { text: 'Seats' }),
            el('div.stepper', {}, [
              el('button.icon-btn', { svg: icon('minus', 15), 'aria-label': 'Fewer seats', onclick: () => resize(desk, -1) }),
              el('span.stepper-value', { text: String(desk.seats) }),
              el('button.icon-btn', { svg: icon('plus', 15), 'aria-label': 'More seats', onclick: () => resize(desk, 1) }),
            ]),
          ]),
        );

        if (desk.shape !== 'round') {
          inspector.append(el('div.plan-row', {}, [
            el('span.hint', { text: 'Facing' }),
            el('button.btn.btn--small', {
              svg: icon('reset', 14),
              onclick: () => {
                desk.facing = FACINGS[(FACINGS.indexOf(desk.facing) + 1) % 4];
                keepInRoom(desk);
                ctx.save(); draw();
              },
            }, ` Turn (${desk.facing})`),
          ]));
        }

        inspector.append(el('button.btn.btn--small.btn--danger', {
          svg: icon('trash', 14),
          onclick: () => {
            for (let i = 0; i < desk.seats; i += 1) delete p.seats[seatId(desk.id, i)];
            p.desks = p.desks.filter((d) => d !== desk);
            selected = null;
            ctx.save(); draw();
          },
        }, ' Remove this desk'));
      }

      function drawObjectPanel(p, o) {
        const labelInput = el('input.input', {
          type: 'text', maxlength: 30, value: o.label,
          placeholder: OBJECTS[o.shape].blurb.replace(/\.$/, '').replace(/^A /, 'e.g. '),
          oninput: (e) => {
            o.label = e.target.value;
            ctx.save();
            const node = room.querySelector(`.room-object[data-id="${CSS.escape(o.id)}"] .room-object-label`);
            if (node) node.textContent = o.label;
          },
        });

        inspector.append(
          el('h3.section-title', { text: OBJECTS[o.shape].label }),
          el('label.field', {}, [el('span.field-label', { text: 'Label' }), labelInput]),
        );

        if (o.shape !== 'circle') {
          inspector.append(el('div.plan-row', {}, [
            el('span.hint', { text: 'Turn' }),
            el('button.btn.btn--small', {
              svg: icon('reset', 14),
              // A rectangle turned a quarter is a rectangle the other way up,
              // which is all "rotate" can honestly mean for an axis-aligned
              // box — and it is what putting a door on a side wall needs.
              onclick: () => {
                const { w, h } = o;
                o.w = h; o.h = w;
                keepObjectInRoom(o);
                ctx.save(); draw();
              },
            }, ' Quarter turn'),
          ]));
        }

        inspector.append(
          el('p.hint', { text: 'Drag it to move it, or drag its bottom-right corner to resize it.' }),
          el('button.btn.btn--small.btn--danger', {
            svg: icon('trash', 14),
            onclick: () => {
              p.objects = p.objects.filter((x) => x !== o);
              selected = null;
              ctx.save(); draw();
            },
          }, ' Remove this'),
        );
      }

      /**
       * Saved rooms. A template is the furniture and nothing else — no pupil
       * is ever in one — which is what lets the same room be reused for every
       * class a teacher has, and kept indefinitely without holding anything
       * about a child.
       */
      async function drawRooms() {
        const host = el('div.saved');
        inspector.append(el('h3.section-title', { text: 'Saved rooms' }), host);

        const p = plan();
        if (p && (p.desks.length || p.objects.length)) {
          host.append(el('button.btn.btn--small.btn--block', { svg: icon('save', 14), onclick: saveRoom }, ' Save this room'));
        }

        let saved = [];
        try { saved = (await Desk.api.templates()).templates || []; }
        catch { host.append(el('p.hint', { text: 'Could not load your saved rooms.' })); return; }

        if (!saved.length) {
          host.append(el('p.hint', { text: 'Save a room here and you can set it up once and use it for every class.' }));
          return;
        }
        for (const room_ of saved) {
          host.append(el('div.saved-row', {}, [
            el('span.saved-name', { text: room_.name }),
            el('span.hint', { text: `${room_.desks.length} desks` }),
            el('button.btn.btn--small', { text: 'Use', onclick: () => useRoom(room_) }),
            el('button.icon-btn.icon-btn--danger', {
              svg: icon('trash', 14), 'aria-label': `Delete ${room_.name}`,
              onclick: async () => { await Desk.api.deleteTemplate(room_.id); drawInspector(); },
            }),
          ]));
        }
      }

      async function saveRoom() {
        const p = plan();
        const input = el('input.input', { type: 'text', maxlength: 60, placeholder: 'e.g. Room 12, exam layout' });
        if (!await Desk.ask({
          title: 'Save this room',
          body: el('div', {}, [
            input,
            el('p.dialog-note', { text: 'The furniture is saved — where the desks are, which way they face, and which wall the front is. Who sits where is not, so you can use it for any class.' }),
          ]),
          confirmLabel: 'Save',
        })) return;
        try {
          await Desk.api.saveTemplate({ name: input.value, front: p.front, desks: p.desks, objects: p.objects });
          toast('Saved. You can use it for any class.');
          drawInspector();
        } catch (e) { toast(e.message, 'warn'); }
      }

      /**
       * Previous arrangements for this class, newest first.
       *
       * Kept because a seating plan is a piece of work — twenty minutes of
       * knowing who cannot sit next to whom — and until now the only copy of
       * it was the live one. Anything that overwrites it now leaves a way
       * back, and restoring is itself undoable.
       */
      function drawHistory() {
        const list = (s.history && s.history[s.classKey]) || [];
        if (!list.length) return;

        inspector.append(el('h3.section-title', { text: 'Previous arrangements' }));
        const host = el('div.saved');

        list.forEach((snap, i) => {
          const seated = Object.keys(snap.plan.seats || {}).length;
          const desks = (snap.plan.desks || []).length;
          host.append(el('div.saved-row', {}, [
            el('div.saved-what', {}, [
              el('span.saved-name', { text: Desk.when(snap.at) }),
              el('span.hint', {
                text: `${seated} seated \u00b7 ${desks} desk${desks === 1 ? '' : 's'}${snap.why ? ` \u00b7 ${snap.why}` : ''}`,
              }),
            ]),
            el('button.btn.btn--small', { text: 'Put back', onclick: () => restore(i) }),
            el('button.icon-btn.icon-btn--danger', {
              svg: icon('trash', 14), 'aria-label': 'Forget this one',
              onclick: () => { list.splice(i, 1); ctx.save(); draw(); },
            }),
          ]));
        });
        inspector.append(host);
        inspector.append(el('p.hint', { text: `The last ${KEEP_HISTORY} are kept, and putting one back keeps the current one too.` }));
      }

      async function restore(i) {
        const list = (s.history && s.history[s.classKey]) || [];
        const snap = list[i];
        if (!snap) return;
        const seated = Object.keys(snap.plan.seats || {}).length;
        if (!await Desk.ask({
          title: `Put back the arrangement from ${Desk.when(snap.at)}?`,
          body: `${seated} pupil${seated === 1 ? '' : 's'} seated. What is in the room now is kept, so you can change your mind.`,
          confirmLabel: 'Put it back',
        })) return;

        keep('before putting an older one back');
        s.plans[s.classKey] = JSON.parse(JSON.stringify(snap.plan));
        selected = null;
        selectedStudent = null;
        ctx.save();
        // Pupils who have since left are dropped on the next load, which is
        // now safe to let happen — it only prunes against a roster it has.
        load();
        toast('Put back.');
      }

      async function useRoom(template) {
        const p = plan();
        const seated = Object.keys(p.seats).length;
        if ((p.desks.length || p.objects.length) && !await Desk.ask({
          title: `Use “${template.name}” for this class?`,
          body: seated
            ? `The furniture in this room is replaced, and the ${seated} pupil${seated === 1 ? '' : 's'} already seated go back to the list.`
            : 'The furniture in this room is replaced.',
          confirmLabel: 'Use it', danger: true,
        })) return;

        keep(`before using \u201c${template.name}\u201d`);

        // Fresh ids, so two classes using the same template do not end up
        // sharing seat ids — and seating is per class, never in a template.
        const remap = new Map();
        p.desks = template.desks.map((d) => {
          const id = newId();
          remap.set(d.id, id);
          return { ...d, id };
        });
        p.objects = template.objects.map((o) => ({ ...o, id: newId() }));
        p.front = template.front;
        p.seats = {};
        selected = null;
        ctx.save(); draw();
      }

      // ---------------- editing ----------------

      function addDesk(shapeKey) {
        const p = plan();
        if (!p) { toast('Choose a class list first.', 'warn'); return; }
        if (p.desks.length >= 40) { toast('That is as much furniture as one room can hold.', 'warn'); return; }
        const shape = SHAPES[shapeKey];
        const seats = shapeKey === 'round' ? 4 : shapeKey === 'table' ? 4 : 2;
        const draft = { id: newId(), shape: shapeKey, seats: clamp(seats, shape.min, shape.max), facing: 'up' };
        Object.assign(draft, findSpace(p.desks, layout(draft)));
        p.desks.push(draft);
        selected = { kind: 'desk', id: draft.id };
        ctx.save(); draw();
      }

      function resize(desk, by) {
        const shape = SHAPES[desk.shape];
        const next = clamp(desk.seats + by, shape.min, shape.max);
        if (next === desk.seats) return;
        // Losing a seat must free whoever was in it rather than stranding
        // them in a seat that is no longer drawn.
        if (next < desk.seats) {
          for (let i = next; i < desk.seats; i += 1) delete plan().seats[seatId(desk.id, i)];
        }
        desk.seats = next;
        keepInRoom(desk);
        ctx.save(); draw();
      }

      /**
       * Moves the board to another wall.
       *
       * The desks are deliberately left where they are: a teacher who has
       * arranged a room should not have it rearranged underneath them. But a
       * room whose front is on the left and whose class all face upwards is
       * plainly wrong, so the offer to turn them is made — and ignored by
       * doing nothing, which is the right default for a destructive tidy-up.
       */
      function setFront(front) {
        const p = plan();
        if (!p || p.front === front) return;
        p.front = front;
        ctx.save();
        draw();

        const facing = FACE_FRONT[front];
        const wrong = p.desks.filter((d) => d.shape !== 'round' && d.facing !== facing);
        if (!wrong.length) return;

        toast(`Front moved. ${wrong.length} desk${wrong.length === 1 ? ' is' : 's are'} still facing the old way.`, 'info', {
          actionLabel: 'Turn them',
          onAction: () => {
            for (const d of wrong) { d.facing = facing; keepInRoom(d); }
            ctx.save(); draw();
          },
        });
      }

      function keepObjectInRoom(o) {
        o.w = clamp(o.w, 1, COLS);
        o.h = clamp(o.h, 1, ROWS);
        o.x = clamp(o.x, 0, COLS - o.w);
        o.y = clamp(o.y, 0, ROWS - o.h);
      }

      function keepInRoom(desk) {
        const l = layout(desk);
        desk.x = clamp(desk.x, 0, COLS - l.w);
        desk.y = clamp(desk.y, 0, ROWS - l.h);
      }

      /**
       * Sits `studentId` in `seat`. If somebody is already there, the two
       * swap when the newcomer came from another seat, and the one displaced
       * goes back to the list when they did not.
       */
      function place(seat, studentId) {
        const p = plan();
        if (!studentId) { delete p.seats[seat]; ctx.save(); draw(); return; }

        const cameFrom = Object.keys(p.seats).find((k) => p.seats[k] === studentId) || null;
        if (cameFrom === seat) return;
        const displaced = p.seats[seat] || null;

        if (cameFrom) delete p.seats[cameFrom];
        p.seats[seat] = studentId;
        // Only a seat-to-seat move has anywhere to put the displaced pupil.
        // Otherwise they simply stop being seated, which puts them back on
        // the list where they can be seen and re-seated.
        if (displaced && cameFrom) p.seats[cameFrom] = displaced;

        ctx.save(); draw();
      }

      function unseat(studentId) {
        const p = plan();
        const seat = Object.keys(p.seats).find((k) => p.seats[k] === studentId);
        if (!seat) return;
        delete p.seats[seat];
        ctx.save(); draw();
      }

      /**
       * Tapping is the whiteboard-friendly half of every drag: tap a name to
       * pick it up, tap a seat to put it down.
       *
       * A tap on a seated pupil picks them UP rather than removing them — a
       * mis-tap during a lesson should not quietly empty a chair, and moving
       * somebody is far commoner than un-seating them.
       */
      function onSeatClick(id, who) {
        if (selectedStudent) {
          if (who && who.id === selectedStudent) { selectedStudent = null; draw(); return; }
          place(id, selectedStudent);
          selectedStudent = null;
          return;
        }
        if (who) { selectedStudent = who.id; draw(); return; }
        // An empty seat with nobody in hand selects the desk it belongs to.
        selected = { kind: 'desk', id: id.split('#')[0] };
        draw();
      }

      function fillAtRandom() {
        const p = plan();
        const waiting = unseated();
        if (!waiting.length) { toast('Everyone already has a seat.', 'warn'); return; }
        if (!allSeats().some((id) => !p.seats[id])) {
          toast('There are no empty seats. Add a desk first.', 'warn');
          return;
        }

        // Read last time BEFORE keep(), or the newest snapshot is this room.
        const last = lastArrangement(s.history[s.classKey], students.length);
        const avoid = neighbourPairs(last && last.plan);
        keep('before seating at random');

        const { seats, placed, standing, repeats } = seatAvoiding(p, waiting.map((x) => x.id), avoid);
        p.seats = seats;

        // The pupils just seated arrive one after another, in the order they
        // were dealt out, so a class watching sees names land rather than a
        // full room appear.
        arriving = new Map(placed.map((id, i) => [seats[id], i]));
        ctx.save(); draw();
        arriving = null;
        if (standing) {
          toast(`${standing} pupil${standing === 1 ? ' has' : 's have'} nowhere to sit.`, 'warn');
        } else if (repeats) {
          toast(`${repeats} pair${repeats === 1 ? ' is' : 's are'} together again from last time. There was no way to split them all.`, 'warn');
        } else if (avoid.size) {
          toast('Nobody is next to anyone they sat beside last time.');
        }
      }

      async function clearSeats() {
        if (!Object.keys(plan().seats).length) return;
        if (!await Desk.ask({
          title: 'Empty the seats?',
          body: 'The furniture stays where it is; everybody goes back to the list. This arrangement is kept, so you can put it back.',
          confirmLabel: 'Empty',
        })) return;
        keep('before emptying the seats');
        plan().seats = {};
        ctx.save(); draw();
      }

      async function clearRoom() {
        if (!await Desk.ask({
          title: 'Clear the room?',
          body: 'Every desk and where everyone sits goes, for this class only. Your other classes keep their plans, and this arrangement is kept so you can put it back.',
          confirmLabel: 'Clear', danger: true,
        })) return;
        keep('before clearing the room');
        plan().desks = [];
        plan().objects = [];
        plan().seats = {};
        selected = null;
        ctx.save(); draw();
      }

      // ---------------- dragging ----------------
      // Pointer events rather than HTML5 drag-and-drop, which does not work on
      // a touchscreen — and an interactive whiteboard is a touchscreen.

      function cellSize() {
        const r = room.getBoundingClientRect();
        return { cw: r.width / view.cols, ch: r.height / view.rows, rect: r };
      }

      function onChipDown(e, studentId) { startStudentDrag(e, studentId, null); }
      function onSeatDown(e, id, who) { if (who) startStudentDrag(e, who.id, id); }

      function startStudentDrag(e, studentId, fromSeat) {
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        const student = studentById(studentId);
        if (!student) return;

        dragging = { kind: 'student', studentId, fromSeat, moved: false, startX: e.clientX, startY: e.clientY };
        ghost = el('div.drag-ghost', { text: student.name });
        moveGhost(e.clientX, e.clientY);
        document.body.append(ghost);
        document.body.classList.add('is-seating-drag');
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp, { once: true });
        window.addEventListener('pointercancel', onUp, { once: true });
      }

      function onDeskDown(e, desk) { startPieceDrag(e, 'desk', desk); }
      function onObjectDown(e, o) { startPieceDrag(e, 'object', o); }

      /** Moving a desk or an object — the same gesture either way. */
      function startPieceDrag(e, kind, piece) {
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        e.preventDefault();
        selected = { kind, id: piece.id };
        drawInspector();
        for (const n of room.querySelectorAll('.desk, .room-object')) {
          n.classList.toggle('is-selected', n.dataset.id === piece.id);
        }

        const { cw, ch } = cellSize();
        dragging = { kind: 'piece', piece, cw, ch, startX: e.clientX, startY: e.clientY, ox: piece.x, oy: piece.y, moved: false };
        armDrag();
      }

      function onObjectResize(e, o) {
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        e.preventDefault();
        selected = { kind: 'object', id: o.id };
        const { cw, ch } = cellSize();
        dragging = { kind: 'resize', piece: o, cw, ch, startX: e.clientX, startY: e.clientY, ow: o.w, oh: o.h, moved: false };
        armDrag();
      }

      function armDrag() {
        document.body.classList.add('is-seating-drag');
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp, { once: true });
        window.addEventListener('pointercancel', onUp, { once: true });
      }

      /** Where a piece sits on screen, once the class's view has had its say. */
      function screenPos(piece, size) {
        const axis = mirrorAxis();
        return {
          x: s.flipped && axis === 'x' ? COLS - piece.x - size.w : piece.x,
          y: s.flipped && axis === 'y' ? ROWS - piece.y - size.h : piece.y,
        };
      }

      function nodeFor(piece) {
        return room.querySelector(`.desk[data-id="${CSS.escape(piece.id)}"], .room-object[data-id="${CSS.escape(piece.id)}"]`);
      }

      function moveGhost(x, y) {
        if (!ghost) return;
        ghost.style.left = `${x}px`;
        ghost.style.top = `${y}px`;
      }

      function onMove(e) {
        if (!dragging) return;
        const far = Math.abs(e.clientX - dragging.startX) + Math.abs(e.clientY - dragging.startY) > 4;
        if (far) dragging.moved = true;

        if (dragging.kind === 'student') {
          moveGhost(e.clientX, e.clientY);
          const over = document.elementFromPoint(e.clientX, e.clientY);
          const seat = over && over.closest('.seat');
          for (const n of room.querySelectorAll('.seat.is-drop')) n.classList.remove('is-drop');
          if (seat) seat.classList.add('is-drop');
          return;
        }

        const piece = dragging.piece;
        const size = piece.shape in OBJECTS ? { w: piece.w, h: piece.h } : pick(layout(piece));
        const dx = Math.round((e.clientX - dragging.startX) / dragging.cw);
        const dy = Math.round((e.clientY - dragging.startY) / dragging.ch);

        if (dragging.kind === 'resize') {
          // Resizing follows the hand on screen; in the mirrored view that is
          // the opposite side of the object, so the drag is simply inverted.
          const axis = mirrorAxis();
          piece.w = clamp(dragging.ow + (s.flipped && axis === 'x' ? -dx : dx), 1, COLS);
          piece.h = clamp(dragging.oh + (s.flipped && axis === 'y' ? -dy : dy), 1, ROWS);
          keepObjectInRoom(piece);
        } else {
          // In the pupils' view the room is mirrored, so dragging left must
          // still move the piece the way the teacher's hand went.
          const axis = mirrorAxis();
          piece.x = clamp(dragging.ox + (s.flipped && axis === 'x' ? -dx : dx), 0, COLS - size.w);
          piece.y = clamp(dragging.oy + (s.flipped && axis === 'y' ? -dy : dy), 0, ROWS - size.h);
        }

        const now = piece.shape in OBJECTS ? { w: piece.w, h: piece.h } : pick(layout(piece));
        const at = screenPos(piece, now);
        const node = nodeFor(piece);
        if (node) {
          node.style.setProperty('--x', at.x);
          node.style.setProperty('--y', at.y);
          node.style.setProperty('--w', now.w);
          node.style.setProperty('--h', now.h);
        }
      }

      function onUp(e) {
        window.removeEventListener('pointermove', onMove);
        document.body.classList.remove('is-seating-drag');
        const d = dragging;
        dragging = null;
        if (ghost) { ghost.remove(); ghost = null; }
        for (const n of room.querySelectorAll('.seat.is-drop')) n.classList.remove('is-drop');
        if (!d) return;

        if (d.kind === 'piece' || d.kind === 'resize') { if (d.moved) { ctx.save(); draw(); } return; }

        // A drag that never went anywhere is a tap, and the click handler
        // deals with those.
        if (!d.moved) return;

        const over = document.elementFromPoint(e.clientX, e.clientY);
        const seat = over && over.closest('.seat');
        if (seat) { place(seat.dataset.seat, d.studentId); return; }
        if (over && over.closest('.plan-side') && d.fromSeat) {
          delete plan().seats[d.fromSeat];
          ctx.save(); draw();
        }
      }

      // ---------------- fitting the room to its box ----------------

      /**
       * Sizes the room in pixels rather than leaving it to CSS.
       *
       * `aspect-ratio` loses to a flex parent that has already decided the
       * height, and a room whose cells are not square draws round tables as
       * ellipses and rectangles at the wrong proportions. One multiplication
       * here is worth more than any amount of arguing with the layout engine.
       *
       * It also decides what a seat can say: full names when there is room,
       * initials when there is not. The same plan is a thumbnail on the card
       * and wall-sized on the projector.
       */
      const sizeRoom = (width, height) => {
        if (width < 4 || height < 4) return;
        const cw = Math.max(1.5, Math.min(width / view.cols, height / view.rows));
        roomBox.style.width = `${cw * view.cols}px`;
        room.style.height = `${cw * view.rows}px`;
        room.style.setProperty('--cell', `${cw}px`);
        room.classList.toggle('is-tiny', cw * SEAT_W < 44);
      };

      // Sizing the room for paper changes the layout, which trips the observer
      // below, which re-fits the room to the screen — mid-print. That is how
      // the first version of this printed a page of initials at thumbnail
      // size. While a print is in flight the room's size is not up for
      // negotiation.
      let printing = false;

      const fit = () => {
        if (printing) return;
        // Layout size, not getBoundingClientRect: a card opening into the big
        // view is scaled by a transform while it animates, the rect reports
        // that scaled size, and the observer does not fire again when the
        // animation ends — so the room stayed at thumbnail scale until
        // something redrew it.
        // The front bar sits inside the room now — it can be on any wall —
        // so the whole box is the room and nothing has to be subtracted.
        sizeRoom(roomWrap.clientWidth, roomWrap.clientHeight);
      };
      const observer = new ResizeObserver(fit);
      observer.observe(roomWrap);

      const offRoster = Desk.roster.onChange(() => load());
      load();

      return {
        destroy() {
          observer.disconnect();
          offRoster();
          picker.destroy && picker.destroy();
          if (ghost) ghost.remove();
          window.removeEventListener('pointermove', onMove);
          document.body.classList.remove('is-seating-drag');
        },
      };
    },
  });
}(window.Desk));
