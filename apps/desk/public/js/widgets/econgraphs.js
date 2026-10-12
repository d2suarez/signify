// ===================================================================
// Widget — Economics graphs
//
// Live, adjustable versions of the graphs and visuals the AP Microeconomics
// Course and Exam Description (CED, Appendix: "Graphs and Visuals") says a
// student must be able to draw or analyse: the PPC, utility, supply and
// demand (with controls, taxes and trade), the production function and the
// cost curves, perfect competition, monopoly and monopolistic competition,
// the game-theory matrix, factor markets and monopsony, externalities, and
// the Lorenz curve. Comparative advantage, elasticity and the MU-per-dollar
// rule are here too, because Units 1 and 2 test them with numbers.
//
// A teacher moves a slider (or drags a curve) and the class watches the
// curve shift, the new equilibrium appear and the surplus areas change. The
// old curve stays on the screen as a dashed ghost, the way the exam asks for
// D1 and D2. "Class questions" hold the answer back until the teacher says
// so, so the room has to predict first. Labels can be hidden so the class
// has to name the curves and points themselves.
//
// How it is organised:
//   - an engine at the top: number helpers, a small SVG chart builder, the
//     controls, and the widget itself;
//   - then one MODELS entry per graph. A model is { key, unit, name,
//     defaults, controls, scenarios, draw(p, K) }. draw() is pure: it takes
//     the parameters and returns charts and facts. Nothing in a model touches
//     the page, which is what lets the tests check the economics.
//   - three models build their own tables rather than a chart (the game
//     matrix, MU per dollar, and the other elasticities): they supply
//     build(host, p, api) instead.
//
// Nothing here holds anything about pupils and nothing calls the server, so
// the widget is open to guests. State is a handful of numbers per graph.
//
// The curves are stylised on purpose (straight lines, round numbers), exactly
// as the CED's own examples are: the point is the relationships, not data.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el } = Desk;

  const UNITS = {
    1: 'Basic Economic Concepts',
    2: 'Supply and Demand',
    3: 'Production, Cost, and Perfect Competition',
    4: 'Imperfect Competition',
    5: 'Factor Markets',
    6: 'Market Failure and the Role of Government',
  };

  // ---------------------------------------------------------------
  // Number helpers
  // ---------------------------------------------------------------

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const fin = (v) => typeof v === 'number' && Number.isFinite(v);

  /** A number as people write it: no trailing zeros, a real minus sign. */
  const trim = (v, d = 2) => {
    if (!fin(v)) return '–';
    const r = Math.round(v * 10 ** d) / 10 ** d;
    return String(Object.is(r, -0) ? 0 : r).replace('-', '−');
  };
  const money = (v, d = 2) => (v < -1e-9 ? '−$' : '$') + trim(Math.abs(v), d);
  const pct = (v, d = 0) => `${trim(v * 100, d)}%`;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** Simpson's rule. Plenty for the smooth, low-order curves in this file. */
  function integ(f, a, b, n = 160) {
    if (!(b > a)) return 0;
    const h = (b - a) / n;
    let sum = f(a) + f(b);
    for (let i = 1; i < n; i += 1) sum += f(a + i * h) * (i % 2 ? 4 : 2);
    return (sum * h) / 3;
  }

  /** A root of f between lo and hi by bisection; the nearer end if there is none. */
  function solve(f, lo, hi) {
    let flo = f(lo);
    const fhi = f(hi);
    if (!fin(flo) || !fin(fhi)) return NaN;
    if (flo === 0) return lo;
    if (fhi === 0) return hi;
    if (flo * fhi > 0) return Math.abs(flo) < Math.abs(fhi) ? lo : hi;
    for (let i = 0; i < 70; i += 1) {
      const mid = (lo + hi) / 2;
      const fm = f(mid);
      if ((fm < 0) === (flo < 0)) { lo = mid; flo = fm; } else hi = mid;
    }
    return (lo + hi) / 2;
  }

  /** The x that minimises a one-dip function on [lo, hi]. */
  function argmin(f, lo, hi) {
    for (let i = 0; i < 80; i += 1) {
      const a = lo + (hi - lo) / 3;
      const b = hi - (hi - lo) / 3;
      if (f(a) < f(b)) hi = b; else lo = a;
    }
    return (lo + hi) / 2;
  }

  const sign = (v, eps = 1e-9) => (v > eps ? 1 : v < -eps ? -1 : 0);

  /** "rises", "falls" or "is unchanged" for before -> after. */
  function moves(before, after, eps = 1e-6) {
    const s = sign(after - before, eps);
    return s > 0 ? 'rises' : s < 0 ? 'falls' : 'is unchanged';
  }

  // ---------------------------------------------------------------
  // The chart builder. Builds an SVG string in DATA coordinates: a model says
  // where a curve or a point is in the units of its own axes and never thinks
  // about pixels.
  // ---------------------------------------------------------------

  let chartSeq = 0;

  /** Round tick values for an axis. */
  function ticks(lo, hi, want = 6) {
    const raw = (hi - lo) / want;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((t) => t >= raw) || mag * 10;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
    return out;
  }

  /** 'P_M' -> P with a small M beside it. Only ever applied to our own strings. */
  function lab(s) {
    const m = /^(.*?)_(\S+)(.*)$/.exec(String(s));
    if (!m) return esc(s);
    return `${esc(m[1])}<tspan class="ec-sub" dy="4">${esc(m[2])}</tspan>${m[3] ? `<tspan dy="-4">${esc(m[3])}</tspan>` : ''}`;
  }

  function makeChart(o) {
    const id = `ecc${(chartSeq += 1)}`;
    const numbers = !!o.numbers;
    const labels = o.labels !== false;
    const W = o.w || 520;
    const H = o.h || 420;
    const ml = (o.ml || 52) + (numbers ? 24 : 0);
    const mr = o.mr || 34;
    const mt = o.mt || 28;
    const mb = (o.mb || 48) + (numbers ? 16 : 0);
    const x0 = o.xmin || 0;
    const x1 = o.xmax;
    const y0 = o.ymin || 0;
    const y1 = o.ymax;
    const PW = W - ml - mr;
    const PH = H - mt - mb;
    const X = (v) => ml + ((v - x0) / (x1 - x0)) * PW;
    const Y = (v) => H - mb - ((v - y0) / (y1 - y0)) * PH;
    const axisY = o.zeroAxis ? Y(0) : H - mb;
    const areas = [];
    const lines = [];
    const marks = [];
    const f = (n) => +n.toFixed(1);

    const c = {
      title: o.title || '',
      X, Y,
      /** pixel (in svg user units) back to data */
      fromPx: (px, py) => ({ x: x0 + ((px - ml) / PW) * (x1 - x0), y: y0 + ((H - mb - py) / PH) * (y1 - y0) }),
      W, H,
    };

    c.area = (pts, cls, k = {}) => {
      areas.push(`<polygon class="ec-area ec-${cls}" points="${pts.map(([x, y]) => `${f(X(x))},${f(Y(y))}`).join(' ')}"/>`);
      if (k.label && labels) {
        const xs = pts.map((q) => X(q[0]));
        const ys = pts.map((q) => Y(q[1]));
        const w = Math.max(...xs) - Math.min(...xs);
        const h = Math.max(...ys) - Math.min(...ys);
        if (w > 26 && h > 15) {
          const cx = xs.reduce((a, b) => a + b, 0) / xs.length;
          const cy = ys.reduce((a, b) => a + b, 0) / ys.length;
          marks.push(`<text class="ec-t ec-arealab" x="${f(cx)}" y="${f(cy + 5)}" text-anchor="middle">${lab(k.label)}</text>`);
        }
      }
    };

    const stroke = (cls, k) => `ec-ln ec-${cls}${k.ghost ? ' is-ghost' : ''}${k.dash ? ' is-dash' : ''}`;
    const width = (k) => (k.w ? ` style="stroke-width:${k.w}px"` : '');

    c.curve = (fn, a, b, cls, k = {}) => {
      const n = k.n || 80;
      const lim = (y1 - y0) * 3;
      let d = '';
      let pen = false;
      for (let i = 0; i <= n; i += 1) {
        const x = a + ((b - a) * i) / n;
        let y = fn(x);
        if (!fin(y)) { pen = false; continue; }
        y = clamp(y, y0 - lim, y1 + lim);
        d += `${pen ? 'L' : 'M'}${f(X(x))},${f(Y(y))}`;
        pen = true;
      }
      if (!d) return;
      lines.push(`<path class="${stroke(cls, k)}" d="${d}"${width(k)}/>`);
      if (k.label) {
        const at = k.at == null ? b : k.at;
        c.text(at, fn(at), k.label, { cls, dx: k.dx == null ? 8 : k.dx, dy: k.dy == null ? -8 : k.dy, anchor: k.anchor });
      }
    };

    /** A straight segment (clipped to the plot like a curve). */
    c.seg = (xa, ya, xb, yb, cls, k = {}) => {
      lines.push(`<path class="${stroke(cls, k)}" d="M${f(X(xa))},${f(Y(ya))}L${f(X(xb))},${f(Y(yb))}"${width(k)}/>`);
      if (k.label) c.text(xb, yb, k.label, { cls, dx: k.dx == null ? 8 : k.dx, dy: k.dy == null ? -8 : k.dy, anchor: k.anchor });
    };

    /** Text at a data position. Hidden when the teacher turns labels off,
     *  unless it is marked fixed (it is part of the picture, not an answer). */
    c.text = (x, y, s, k = {}) => {
      if (!labels && !k.fixed) return;
      let px = X(x) + (k.dx || 0);
      const py = clamp(Y(y) + (k.dy || 0), mt + 8, H - 6);
      let anchor = k.anchor || 'start';
      if (anchor === 'start' && px + String(s).length * 9 > W - 4) { anchor = 'end'; px -= 2 * (k.dx || 0); }
      px = clamp(px, 6, W - 6);
      marks.push(`<text class="ec-t${k.cls ? ` ec-${k.cls}` : ''}${k.bold ? ' is-bold' : ''}" x="${f(px)}" y="${f(py)}" text-anchor="${anchor}">${lab(s)}</text>`);
    };

    c.dot = (x, y, cls = 'k', k = {}) => {
      marks.push(`<circle class="ec-dot ec-${cls}" cx="${f(X(x))}" cy="${f(Y(y))}" r="${k.r || 6}"/>`);
      if (k.label) c.text(x, y, k.label, { cls: k.tcls || cls, dx: k.dx == null ? 9 : k.dx, dy: k.dy == null ? -9 : k.dy, anchor: k.anchor, bold: true });
    };

    /** Dashed guides from a point to the axes, with the names of what they hit. */
    c.drop = (x, y, xl, yl, k = {}) => {
      const cls = k.cls || 'k';
      let d = '';
      if (k.only !== 'y') d += `M${f(X(x))},${f(Y(y))}V${f(axisY)}`;
      if (k.only !== 'x') d += `M${f(X(x))},${f(Y(y))}H${f(X(x0))}`;
      marks.push(`<path class="ec-drop ec-${cls}" d="${d}"/>`);
      if (xl && k.only !== 'y') c.text(x, y0, xl, { cls, dy: numbers ? 36 : 21, dx: k.xdx || 0, anchor: k.xanchor || 'middle', bold: true });
      if (yl && k.only !== 'x') c.text(x0, y, yl, { cls, dx: numbers ? -32 : -9, dy: 5, anchor: 'end', bold: true });
    };

    c.handle = (x, y, hid, cls = 'k') => {
      marks.push(`<g class="ec-handle ec-${cls}" data-h="${esc(hid)}"><circle class="ec-hit" cx="${f(X(x))}" cy="${f(Y(y))}" r="17"/><circle class="ec-grip" cx="${f(X(x))}" cy="${f(Y(y))}" r="7.5"/></g>`);
    };

    c.svg = (aria) => {
      const grid = [];
      if (numbers) {
        const tk = (lo, hi, step) => (step ? Array.from({ length: Math.floor((hi - lo) / step + 1e-9) + 1 }, (_, i) => +(lo + i * step).toFixed(6)) : ticks(lo, hi));
        for (const v of tk(x0, x1, o.xstep)) {
          grid.push(`<path class="ec-grid" d="M${f(X(v))},${mt}V${f(H - mb)}"/>`);
          grid.push(`<text class="ec-tick" x="${f(X(v))}" y="${f(H - mb + 17)}" text-anchor="middle">${trim(v, 1)}</text>`);
        }
        for (const v of tk(y0, y1, o.ystep)) {
          grid.push(`<path class="ec-grid" d="M${ml},${f(Y(v))}H${W - mr}"/>`);
          grid.push(`<text class="ec-tick" x="${ml - 7}" y="${f(Y(v) + 4)}" text-anchor="end">${trim(v, 1)}</text>`);
        }
      }
      const axes = `<path class="ec-axis" d="M${ml},${mt - 6}V${f(H - mb)}M${ml},${f(axisY)}H${W - mr + 8}"/>`
        + `<path class="ec-arrow" d="M${ml - 4},${mt - 2}L${ml},${mt - 10}L${ml + 4},${mt - 2}ZM${W - mr + 5},${f(axisY - 4)}L${W - mr + 13},${f(axisY)}L${W - mr + 5},${f(axisY + 4)}Z"/>`;
      const titles = `<text class="ec-axt" x="${f(ml + PW / 2)}" y="${H - 6}" text-anchor="middle">${esc(o.xlabel || 'Quantity')}</text>`
        + `<text class="ec-axt" transform="translate(15 ${f(mt + PH / 2)}) rotate(-90)" text-anchor="middle">${esc(o.ylabel || 'Price')}</text>`;
      return `<svg class="ec-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(aria || c.title || 'Graph')}">`
        + `<defs><clipPath id="${id}"><rect x="${ml}" y="${mt - 4}" width="${PW + 2}" height="${PH + 6}"/></clipPath>`
        + '<pattern id="ec-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" class="ec-hatch-bg"/><path d="M0 0V7" class="ec-hatch-ln"/></pattern></defs>'
        + `${grid.join('')}<g clip-path="url(#${id})">${areas.join('')}${lines.join('')}</g>${axes}${marks.join('')}${titles}</svg>`;
    };

    return c;
  }

  // ---------------------------------------------------------------
  // The models. Each pushes itself onto this list; the widget below reads it.
  // ---------------------------------------------------------------

  const MODELS = [];
  const byKey = (k) => MODELS.find((m) => m.key === k) || null;
  /** A model's defaults as fresh data, so editing a saved game never edits the defaults. */
  const fresh = (o) => JSON.parse(JSON.stringify(o));
  const define = (m) => { MODELS.push(Object.assign({ controls: [], scenarios: [], exam: [], defaults: {} }, m)); };

  // =================================================================
  // UNIT 1 — Basic Economic Concepts
  // =================================================================

  /** The PPC. Bowed out (increasing opportunity cost) or a straight line (constant). */
  const ppcY = (shape, x, X, Y) => {
    if (x > X + 1e-9 || x < 0) return NaN;
    return shape === 'line' ? Y * (1 - x / X) : Y * Math.sqrt(Math.max(0, 1 - (x / X) ** 2));
  };

  define({
    key: 'ppc',
    unit: 1,
    name: 'Production possibilities curve',
    ced: 'CED Topic 1.3 · MKT-1.C, MKT-2.A, MKT-2.B',
    blurb: 'Every point on the curve uses all resources efficiently. Points inside waste resources; points outside cannot be reached yet.',
    exam: [
      'Draw and label a PPC and show points that are efficient, inefficient and unattainable.',
      'Show economic growth or a loss of capacity as the whole curve (or one end of it) moving.',
      'Calculate the opportunity cost of moving between two points.',
      'Bowed out means increasing opportunity cost; a straight line means constant opportunity cost.',
    ],
    defaults: { shape: 'bowed', gx: 0, gy: 0, a: 40, b: 80, showB: false, inside: false, outside: false },
    controls: [
      { type: 'seg', k: 'shape', label: 'Opportunity cost', opts: [['bowed', 'Increasing'], ['line', 'Constant']] },
      { head: 'Capacity' },
      { k: 'gx', label: 'Capacity to make Good X', min: -40, max: 40, step: 5, fmt: (v) => `${v > 0 ? '+' : ''}${v}%` },
      { k: 'gy', label: 'Capacity to make Good Y', min: -40, max: 40, step: 5, fmt: (v) => `${v > 0 ? '+' : ''}${v}%` },
      { head: 'Points' },
      { k: 'a', label: 'Point A: units of X', min: 0, max: 140, step: 5 },
      { type: 'toggle', k: 'showB', label: 'Compare with a second point, B' },
      { k: 'b', label: 'Point B: units of X', min: 0, max: 140, step: 5, show: (p) => p.showB },
      { type: 'toggle', k: 'inside', label: 'Show a point inside the curve' },
      { type: 'toggle', k: 'outside', label: 'Show a point outside the curve' },
    ],
    scenarios: [
      { name: 'Better technology for Good X only', ask: 'Technology improves only in the production of Good X. What happens to the PPC?', set: { gx: 30 } },
      { name: 'The labor force grows', ask: 'The labor force grows and every resource is used as before. What happens to the PPC, and what happens to the opportunity cost of Good X?', set: { gx: 30, gy: 30 } },
      { name: 'A recession leaves workers idle', ask: 'Many workers lose their jobs. Where is the economy now, relative to the PPC?', set: { inside: true } },
      { name: 'A hurricane destroys capital', ask: 'A hurricane destroys factories and farms. What happens to the PPC?', set: { gx: -25, gy: -25 } },
      { name: 'Constant opportunity cost', ask: 'Suppose resources are equally good at making both goods. What does the PPC look like, and what is the opportunity cost of each unit of X?', set: { shape: 'line', showB: true } },
    ],
    drag: (id, x, y, p) => { if (id === 'A') p.a = Math.round(x / 5) * 5; if (id === 'B') p.b = Math.round(x / 5) * 5; },
    draw(p, K) {
      const X0 = 100;
      const Y0 = 60;
      const X = X0 * (1 + p.gx / 100);
      const Y = Y0 * (1 + p.gy / 100);
      const f = (x) => ppcY(p.shape, x, X, Y);
      const c = K.chart({ xmax: 150, ymax: 100, xlabel: 'Units of Good X', ylabel: 'Units of Good Y' });
      const moved = p.gx !== 0 || p.gy !== 0;
      if (moved) c.curve((x) => ppcY(p.shape, x, X0, Y0), 0, X0, 'k', { ghost: true, label: 'PPC_1', at: X0, dx: 8, dy: -10 });
      c.curve(f, 0, X, 'd', { w: 3.5, n: 120, label: moved ? 'PPC_2' : 'PPC', at: X, dx: 8, dy: -10 });

      const a = Math.min(p.a, X);
      const b = Math.min(p.b, X);
      const ya = f(a);
      const yb = f(b);
      const facts = [];
      const say = [];

      c.drop(a, ya, 'X_A', 'Y_A', { cls: 'k' });
      c.dot(a, ya, 'd', { label: 'A', r: 7 });
      c.handle(a, ya, 'A', 'd');
      facts.push({ sw: 'd', k: 'Point A', v: `${trim(a, 1)} X and ${trim(ya, 1)} Y` });

      if (p.showB) {
        c.drop(b, yb, 'X_B', 'Y_B', { cls: 'g' });
        c.dot(b, yb, 's', { label: 'B', r: 7 });
        c.handle(b, yb, 'B', 's');
        facts.push({ sw: 's', k: 'Point B', v: `${trim(b, 1)} X and ${trim(yb, 1)} Y` });
        const dx = b - a;
        const dy = ya - yb;
        if (Math.abs(dx) > 0.5) {
          if (dx > 0) {
            facts.push({ k: 'Moving A to B', v: `+${trim(dx, 1)} X, −${trim(dy, 1)} Y` });
            facts.push({ k: 'Opportunity cost of 1 X', v: `${trim(dy / dx, 2)} Y` });
            say.push(`Moving from A to B gains ${trim(dx, 1)} X and costs ${trim(dy, 1)} Y, so each extra X costs ${trim(dy / dx, 2)} Y.`);
          } else {
            facts.push({ k: 'Moving A to B', v: `−${trim(-dx, 1)} X, +${trim(-dy, 1)} Y` });
            facts.push({ k: 'Opportunity cost of 1 Y', v: `${trim(-dx / -dy, 2)} X` });
            say.push(`Moving from A to B gains ${trim(-dy, 1)} Y and costs ${trim(-dx, 1)} X, so each extra Y costs ${trim(dx / dy, 2)} X.`);
          }
        }
      } else {
        const h = 1;
        const slope = (f(Math.max(0, a - h)) - f(Math.min(X, a + h))) / (Math.min(X, a + h) - Math.max(0, a - h));
        if (fin(slope)) facts.push({ k: 'Opportunity cost of 1 X at A', v: `${trim(slope, 2)} Y` });
      }

      if (p.inside) {
        const cx = 0.5 * X;
        const cy = 0.55 * f(cx);
        c.dot(cx, cy, 'a', { label: 'C', r: 7 });
        facts.push({ sw: 'a', k: 'Point C', v: 'inside: resources unused or misused' });
      }
      if (p.outside) {
        const dxp = 0.68 * X;
        const dyp = Math.min(95, 1.22 * f(dxp));
        c.dot(dxp, dyp, 'f', { label: 'D', r: 7 });
        facts.push({ sw: 'f', k: 'Point D', v: 'outside: cannot be produced now' });
      }

      if (p.shape === 'bowed') say.push('The curve bows out because resources are not equally good at making both goods: the more X is made, the more Y is given up for each extra unit.');
      else say.push('A straight line means constant opportunity cost: resources are equally good at both goods.');
      if (moved) {
        const parts = [];
        if (p.gx) parts.push(`capacity for X ${p.gx > 0 ? 'grows' : 'shrinks'}`);
        if (p.gy) parts.push(`capacity for Y ${p.gy > 0 ? 'grows' : 'shrinks'}`);
        say.push(`The curve moves because ${parts.join(' and ')}.`);
      }
      return { charts: [c], facts, say: say.join(' ') };
    },
  });

  // ---- comparative advantage -----------------------------------------

  /** Opportunity costs, advantages and the gains from trade for two countries. */
  function compCalc(p) {
    const ocA = p.ay / p.ax;                 // Y given up per X
    const ocB = p.by / p.bx;
    const eq = Math.abs(ocA - ocB) < 1e-9;
    const exporter = eq ? null : (ocA < ocB ? 'A' : 'B');   // makes X
    const lo = Math.min(ocA, ocB);
    const hi = Math.max(ocA, ocB);
    const inRange = !eq && p.tot > lo + 1e-9 && p.tot < hi - 1e-9;
    const out = { ocA, ocB, eq, exporter, lo, hi, inRange, q: 0, A: null, B: null };
    if (!exporter) return out;
    const E = exporter === 'A' ? { x: p.ax, y: p.ay } : { x: p.bx, y: p.by };
    const I = exporter === 'A' ? { x: p.bx, y: p.by } : { x: p.ax, y: p.ay };
    out.q = clamp(p.q, 0, Math.min(E.x, I.y / p.tot));
    const e = { x: E.x - out.q, y: out.q * p.tot };
    const i = { x: out.q, y: I.y - out.q * p.tot };
    out.A = exporter === 'A' ? e : i;
    out.B = exporter === 'A' ? i : e;
    return out;
  }

  define({
    key: 'compadv',
    unit: 1,
    name: 'Comparative advantage and trade',
    ced: 'CED Topic 1.4 · MKT-1.C, MKT-2.A (two PPCs)',
    blurb: 'Compare opportunity costs. The country that gives up less to make a good has the comparative advantage, and both gain by specializing and trading at a price between the two opportunity costs.',
    exam: [
      'Calculate opportunity costs from production numbers and identify the comparative advantage.',
      'Tell absolute advantage (can make more) from comparative advantage (gives up less).',
      'Show that trade lets each country consume beyond its own PPC.',
    ],
    noNumbers: false,
    defaults: { ax: 40, ay: 40, bx: 10, by: 20, tot: 1.5, q: 4, trade: false, _n: true },
    controls: [
      { head: 'Country A can make up to' },
      { k: 'ax', label: 'Good X', min: 5, max: 60, step: 5 },
      { k: 'ay', label: 'Good Y', min: 5, max: 60, step: 5 },
      { head: 'Country B can make up to' },
      { k: 'bx', label: 'Good X', min: 5, max: 60, step: 5 },
      { k: 'by', label: 'Good Y', min: 5, max: 60, step: 5 },
      { type: 'toggle', k: 'trade', label: 'Specialize and trade' },
      { k: 'tot', label: 'Terms of trade (Y per 1 X)', min: 0.25, max: 4, step: 0.05, show: (p) => p.trade, fmt: (v) => trim(v, 2) },
      { k: 'q', label: 'Units of X traded', min: 0, max: 40, step: 1, show: (p) => p.trade },
    ],
    scenarios: [
      { name: 'A is better at everything', ask: 'Country A can make more of both goods than Country B. Does trade still help both? Who should make what?', set: { trade: true } },
      { name: 'Same opportunity costs', ask: 'Both countries give up the same amount of Y for each X. Is there any gain from trade?', set: { ax: 20, ay: 20, bx: 10, by: 10, trade: true } },
      { name: 'Absolute vs comparative', ask: 'Country A is better at X, Country B is better at Y in absolute terms. Whose comparative advantage is what?', set: { ax: 30, ay: 10, bx: 20, by: 20, tot: 0.7, q: 10, trade: true } },
    ],
    draw(p, K) {
      const m = compCalc(p);
      const T = p.tot;
      const maxX = Math.max(p.ax, p.bx);
      const E = m.exporter === 'A' ? p.ax : p.bx;
      const maxY = Math.max(p.ay, p.by, p.trade && m.exporter ? T * E : 0);
      const xmax = Math.ceil((maxX * 1.15) / 5) * 5;
      const ymax = Math.ceil((maxY * 1.15) / 5) * 5;
      const mk = (name, mx, my, isExp, cons) => {
        const c = K.chart({ title: name, xmax, ymax, xlabel: 'Good X', ylabel: 'Good Y' });
        c.seg(0, my, mx, 0, 'd', { w: 3.5 });
        c.text(mx * 0.55, my * 0.5, 'PPC', { cls: 'd', dx: 10, dy: -8, bold: true });
        c.dot(0, my, 'k', { r: 4 });
        c.dot(mx, 0, 'k', { r: 4 });
        if (p.trade && m.exporter && m.inRange) {
          if (isExp) { c.seg(mx, 0, 0, T * mx, 's', { dash: true }); c.dot(mx, 0, 'v', { label: 'P', r: 7, dy: -11, dx: 4 }); }
          else { c.seg(0, my, my / T, 0, 's', { dash: true }); c.dot(0, my, 'v', { label: 'P', r: 7, dy: -11, dx: 12 }); }
          c.dot(cons.x, cons.y, 'f', { label: 'C', r: 7, dx: 10, dy: -10 });
        }
        return c;
      };
      const charts = [
        mk('Country A', p.ax, p.ay, m.exporter === 'A', m.A),
        mk('Country B', p.bx, p.by, m.exporter === 'B', m.B),
      ];
      const facts = [
        { k: 'A: cost of 1 X', v: `${trim(m.ocA, 2)} Y` },
        { k: 'A: cost of 1 Y', v: `${trim(1 / m.ocA, 2)} X` },
        { k: 'B: cost of 1 X', v: `${trim(m.ocB, 2)} Y` },
        { k: 'B: cost of 1 Y', v: `${trim(1 / m.ocB, 2)} X` },
      ];
      const say = [];
      if (m.eq) {
        facts.push({ k: 'Comparative advantage', v: 'none: same opportunity costs' });
        say.push('The opportunity costs are identical, so neither country has a comparative advantage and there are no gains from trade.');
      } else {
        const exp = m.exporter;
        const imp = exp === 'A' ? 'B' : 'A';
        facts.push({ k: 'Comparative advantage in X', v: `Country ${exp}` });
        facts.push({ k: 'Comparative advantage in Y', v: `Country ${imp}` });
        const absX = p.ax === p.bx ? 'neither' : (p.ax > p.bx ? 'A' : 'B');
        const absY = p.ay === p.by ? 'neither' : (p.ay > p.by ? 'A' : 'B');
        facts.push({ k: 'Absolute advantage', v: `X: ${absX === 'neither' ? 'neither' : `Country ${absX}`}, Y: ${absY === 'neither' ? 'neither' : `Country ${absY}`}` });
        facts.push({ k: 'Terms of trade must be between', v: `${trim(m.lo, 2)} and ${trim(m.hi, 2)} Y per X` });
        say.push(`Country ${exp} gives up less Y for each X, so it should make X; Country ${imp} should make Y.`);
        if (p.trade) {
          if (!m.inRange) say.push('This price is not between the two opportunity costs, so at least one country would refuse to trade. Move the terms of trade into the range.');
          else {
            const gain = (c, mx, my) => my * (1 - c.x / mx);
            facts.push({ sw: 'v', k: 'P: after specializing, it makes', v: 'only its comparative-advantage good' });
            facts.push({ sw: 'f', k: 'C: after trading, it consumes', v: 'outside its own PPC' });
            facts.push({ k: 'Country A consumes', v: `${trim(m.A.x, 1)} X and ${trim(m.A.y, 1)} Y (own PPC allows ${trim(gain(m.A, p.ax, p.ay), 1)} Y)` });
            facts.push({ k: 'Country B consumes', v: `${trim(m.B.x, 1)} X and ${trim(m.B.y, 1)} Y (own PPC allows ${trim(gain(m.B, p.bx, p.by), 1)} Y)` });
            say.push('After trading, each country consumes a point outside its own PPC, which it could not reach alone.');
          }
        }
      }
      return { charts, facts, say: say.join(' ') };
    },
  });

  // ---- total and marginal utility ------------------------------------

  const muAt = (p, i) => p.m1 - p.dec * (i - 1);
  const tuAt = (p, n) => { let t = 0; for (let i = 1; i <= n; i += 1) t += muAt(p, i); return t; };
  /** Buy while the next unit is worth at least what it costs (and adds something). */
  function bestUnits(p) {
    let n = 0;
    while (n < 12 && muAt(p, n + 1) >= p.price && muAt(p, n + 1) > 0) n += 1;
    return n;
  }

  define({
    key: 'utility',
    unit: 1,
    name: 'Total and marginal utility',
    ced: 'CED Topics 1.5–1.6 · CBA-1.B, CBA-2.A, CBA-2.B',
    blurb: 'Marginal utility (MU) is the extra satisfaction from one more unit; total utility (TU) is the running total. Rational choice is made on the margin: keep going while MU is at least the price.',
    exam: [
      'Draw and interpret TU and MU, with MU on the same quantity axis as TU.',
      'Explain diminishing marginal utility: MU falls as consumption rises.',
      'TU is at its maximum when MU = 0; TU rises while MU is positive.',
      'Compare marginal benefit with marginal cost to find the best quantity.',
    ],
    defaults: { m1: 20, dec: 2, n: 5, price: 8, line: true, _n: true },
    controls: [
      { k: 'm1', label: 'Utility from the 1st unit', min: 10, max: 30, step: 1 },
      { k: 'dec', label: 'MU lost with each extra unit', min: 1, max: 4, step: 0.5 },
      { k: 'n', label: 'Units consumed', min: 0, max: 12, step: 1 },
      { type: 'toggle', k: 'line', label: 'Compare with a price' },
      { k: 'price', label: 'Price of each unit', min: 0, max: 24, step: 1, show: (p) => p.line, fmt: (v) => money(v, 0) },
    ],
    scenarios: [
      { name: 'Why does TU stop rising?', ask: 'Keep consuming more of a good. What happens to marginal utility, and what happens to total utility when marginal utility reaches zero?', set: { n: 11, line: false } },
      { name: 'The price falls', ask: 'The price of the good falls to $2. How many units should a rational consumer buy now?', set: { price: 2, line: true } },
      { name: 'A free good', ask: 'The good is free. How much will a consumer take, and is TU at its maximum there?', set: { price: 0, line: true, n: 10 } },
    ],
    draw(p, K) {
      const N = 12;
      const nOpt = bestUnits(p);
      const tuMax = tuAt(p, N + 1) > 0 ? Math.max(...Array.from({ length: N + 1 }, (_, i) => tuAt(p, i))) : 10;
      const ymaxT = Math.ceil((tuMax * 1.15) / 10) * 10;
      const tu = (x) => {
        const i = Math.min(N - 1, Math.max(0, Math.floor(x)));
        return tuAt(p, i) + (x - i) * (tuAt(p, i + 1) - tuAt(p, i));
      };
      const c1 = K.chart({ title: 'Total utility', xmax: 13, ymax: ymaxT, xlabel: 'Units consumed', ylabel: 'Total utility', xmin: 0, xstep: 2 });
      c1.curve(tu, 0, N, 'd', { w: 3.5, n: 120 });
      for (let i = 1; i <= N; i += 1) c1.dot(i, tuAt(p, i), 'd', { r: 3.5 });
      c1.text(N, tu(N), 'TU', { cls: 'd', dx: 6, dy: -8, bold: true });
      if (p.n > 0) { c1.drop(p.n, tuAt(p, p.n), 'n', 'TU', { cls: 'k' }); c1.dot(p.n, tuAt(p, p.n), 'a', { r: 7 }); }

      const lowest = Math.min(muAt(p, N), 0);
      const c2 = K.chart({ title: 'Marginal utility', xmax: 13, ymax: p.m1 + 3, ymin: Math.floor(lowest - 2), zeroAxis: true, xlabel: 'Units consumed', ylabel: 'Marginal utility', xstep: 2 });
      for (let i = 1; i <= N; i += 1) {
        const v = muAt(p, i);
        c2.area([[i - 0.38, 0], [i + 0.38, 0], [i + 0.38, v], [i - 0.38, v]], v < 0 ? 'loss' : (i <= p.n ? 'cs' : 'off'));
      }
      c2.curve((x) => p.m1 - p.dec * (x - 1), 1, N, 'd', { w: 3, label: 'MU', at: N, dy: -10 });
      if (p.line) {
        c2.seg(0, p.price, 13, p.price, 's', { dash: true, w: 2.5 });
        c2.text(0.2, p.price, 'Price = MC', { cls: 's', dx: 6, dy: -7, bold: true });
        if (nOpt > 0) { c2.drop(nOpt, muAt(p, nOpt), 'n*', null, { cls: 's', only: 'x' }); c2.dot(nOpt, muAt(p, nOpt), 's', { r: 6 }); }
      }

      const facts = [];
      if (p.n > 0) {
        facts.push({ sw: 'cs', k: `MU of unit ${p.n}`, v: String(trim(muAt(p, p.n), 1)) });
        facts.push({ sw: 'd', k: `TU after ${p.n} units`, v: String(trim(tuAt(p, p.n), 1)) });
      }
      facts.push({ k: 'MU reaches zero at unit', v: String(trim(1 + p.m1 / p.dec, 1)) });
      if (p.line) facts.push({ sw: 's', k: 'Best quantity (MU ≥ price)', v: `${nOpt} unit${nOpt === 1 ? '' : 's'}` });
      const say = ['Each extra unit adds less utility than the one before (diminishing marginal utility). Total utility keeps rising while MU is positive and is at its peak when MU = 0.'];
      if (p.line) say.push(`A rational consumer buys while marginal benefit is at least marginal cost: here that is ${nOpt} unit${nOpt === 1 ? '' : 's'}.`);
      return { charts: [c1, c2], facts, say: say.join(' ') };
    },
  });

  // ---- the utility-maximizing rule (MU per dollar) -------------------

  /**
   * Buy, one unit at a time, whichever next unit gives the most MU per dollar
   * that the money left can still pay for. Returns the purchases in order.
   */
  function greedyBuy(income, px, py, mux, muy) {
    const buys = [];
    let nx = 0;
    let ny = 0;
    let left = income;
    for (let guard = 0; guard < 40; guard += 1) {
      const rx = nx < mux.length && px > 0 && px <= left + 1e-9 ? mux[nx] / px : -Infinity;
      const ry = ny < muy.length && py > 0 && py <= left + 1e-9 ? muy[ny] / py : -Infinity;
      if (Math.max(rx, ry) <= 0) break;
      if (rx >= ry) { buys.push({ good: 'X', unit: nx + 1, ratio: rx, cost: px }); left -= px; nx += 1; }
      else { buys.push({ good: 'Y', unit: ny + 1, ratio: ry, cost: py }); left -= py; ny += 1; }
    }
    return { buys, nx, ny, left };
  }

  define({
    key: 'optimize',
    unit: 1,
    name: 'Utility-maximizing rule (MU per $)',
    ced: 'CED Topic 1.6 · CBA-2.A, CBA-2.B',
    blurb: 'Spend each dollar where it buys the most extra utility. The best bundle is where MU of X over its price equals MU of Y over its price (MUₓ/Pₓ = MUᵧ/Pᵧ), using all the income. You can type your own MU numbers into the table. Indifference curves are not on the exam.',
    exam: [
      'Use a table of marginal utilities and prices to find the best bundle.',
      'Explain why the consumer equates MU/P across goods when income is spent.',
      'Show what happens to the best bundle when a price or income changes.',
    ],
    noNumbers: true,
    defaults: { income: 24, px: 2, py: 4, mux: [20, 16, 12, 8, 5, 3, 1], muy: [36, 28, 20, 16, 8, 4, 2] },
    controls: [
      { k: 'income', label: 'Income', min: 4, max: 60, step: 2, fmt: (v) => money(v, 0) },
      { k: 'px', label: 'Price of X', min: 1, max: 8, step: 1, fmt: (v) => money(v, 0) },
      { k: 'py', label: 'Price of Y', min: 1, max: 10, step: 1, fmt: (v) => money(v, 0) },
      { type: 'button', label: 'Reset the MU table', run: (p) => { p.mux = [20, 16, 12, 8, 5, 3, 1]; p.muy = [36, 28, 20, 16, 8, 4, 2]; } },
    ],
    scenarios: [
      { name: 'The price of X doubles', ask: 'The price of X rises from $2 to $4. Will the consumer buy more or less X, and how does the MU/P rule explain it?', set: { px: 4 } },
      { name: 'Income rises', ask: 'Income rises from $24 to $36. What happens to the best bundle?', set: { income: 36 } },
    ],
    build(host, p, api) {
      const mkIn = (arr, i) => el('input.input.ec-cell', {
        type: 'number', min: 0, step: 1, 'aria-label': `${arr === 'mux' ? 'MU of X' : 'MU of Y'}, unit ${i + 1}`,
        oninput: (e) => { const v = parseFloat(e.target.value); p[arr][i] = fin(v) ? Math.max(0, v) : 0; api.refresh(); api.save(); },
      });
      const rows = [];
      const body = el('tbody');
      for (let i = 0; i < 7; i += 1) {
        const r = { ix: mkIn('mux', i), iy: mkIn('muy', i), rx: el('td.ec-ratio'), ry: el('td.ec-ratio') };
        rows.push(r);
        body.append(el('tr', {}, [el('th', { text: String(i + 1), scope: 'row' }), el('td', {}, r.ix), r.rx, el('td', {}, r.iy), r.ry]));
      }
      const head = el('tr', {}, [el('th', { text: 'Unit' }), el('th', { text: 'MU of X' }), el('th', { text: 'MUₓ ÷ Pₓ' }), el('th', { text: 'MU of Y' }), el('th', { text: 'MUᵧ ÷ Pᵧ' })]);
      host.append(el('div.ec-tablewrap', {}, [el('table.ec-table', {}, [el('thead', {}, head), body])]));

      return {
        update(q) {
          const g = greedyBuy(q.income, q.px, q.py, q.mux, q.muy);
          const order = new Map(g.buys.map((b, k) => [`${b.good}${b.unit}`, k + 1]));
          rows.forEach((r, i) => {
            if (document.activeElement !== r.ix) r.ix.value = q.mux[i];
            if (document.activeElement !== r.iy) r.iy.value = q.muy[i];
            const cell = (td, good, mu, price) => {
              const k = order.get(`${good}${i + 1}`);
              td.textContent = `${trim(mu / price, 2)}${k ? `  · #${k}` : ''}`;
              td.classList.toggle('is-bought', !!k);
            };
            cell(r.rx, 'X', q.mux[i], q.px);
            cell(r.ry, 'Y', q.muy[i], q.py);
          });
          const spent = q.income - g.left;
          const lastX = g.nx ? q.mux[g.nx - 1] / q.px : null;
          const lastY = g.ny ? q.muy[g.ny - 1] / q.py : null;
          const equal = lastX != null && lastY != null && Math.abs(lastX - lastY) < 1e-9;
          const facts = [
            { sw: 'cs', k: 'Best bundle', v: `${g.nx} of X and ${g.ny} of Y` },
            { k: 'Spent', v: `${money(spent, 0)} of ${money(q.income, 0)}` },
            { k: 'Total utility', v: String(trim(q.mux.slice(0, g.nx).reduce((a, b) => a + b, 0) + q.muy.slice(0, g.ny).reduce((a, b) => a + b, 0), 1)) },
          ];
          if (lastX != null) facts.push({ k: 'MUₓ/Pₓ at the last unit', v: trim(lastX, 2) });
          if (lastY != null) facts.push({ k: 'MUᵧ/Pᵧ at the last unit', v: trim(lastY, 2) });
          api.facts(facts);
          api.say(`Buy whichever next unit gives the most MU per dollar, until the money is gone (#1 is bought first). ${equal ? 'At the best bundle MUₓ/Pₓ = MUᵧ/Pᵧ, so no dollar could be spent better.' : 'The two ratios are as close as whole units allow.'}`);
        },
      };
    },
  });

  // =================================================================
  // UNIT 2 — Supply and Demand
  // =================================================================

  /**
   * One linear market: D is P = 10 - 0.1(Q - d), S is P = 0.1(Q - s), where d
   * and s slide each curve right (positive) or left. Equilibrium starts at
   * P = 5, Q = 50. A government wedge (tax or subsidy) or a price control can
   * be laid over it. Used by the product market and the labor market.
   */
  function marketCalc(p) {
    const D = (q) => 10 - 0.1 * (q - p.d);
    const S = (q) => Math.max(0, 0.1 * (q - p.s));
    const Qe = 50 + (p.d + p.s) / 2;
    const Pe = 5 + (p.d - p.s) / 20;
    const qsAt = (pr) => Math.max(0, p.s + 10 * pr);
    const qdAt = (pr) => Math.max(0, 100 + p.d - 10 * pr);
    const r = { D, S, Qe, Pe, Q: Qe, Pb: Pe, Ps: Pe, w: 0, mode: 'free', shortage: 0, surplus: 0, binding: false, qsAt, qdAt };
    if (p.mode === 'ceil' && p.lvl < Pe - 1e-9) {
      r.mode = 'ceil'; r.binding = true; r.Q = qsAt(p.lvl); r.Pb = r.Ps = p.lvl; r.shortage = qdAt(p.lvl) - qsAt(p.lvl);
    } else if (p.mode === 'floor' && p.lvl > Pe + 1e-9) {
      r.mode = 'floor'; r.binding = true; r.Q = qdAt(p.lvl); r.Pb = r.Ps = p.lvl; r.surplus = qsAt(p.lvl) - qdAt(p.lvl);
    } else if (p.mode === 'tax' || p.mode === 'sub') {
      r.mode = p.mode;
      r.w = p.mode === 'tax' ? p.amt : -p.amt;
      r.Q = Math.max(0, Qe - 5 * r.w);
      r.Pb = D(r.Q);
      r.Ps = r.Pb - r.w;
      r.binding = p.amt > 0;
    }
    r.CS = Math.max(0, integ(D, 0, r.Q) - r.Pb * r.Q);
    r.PS = Math.max(0, r.Ps * r.Q - integ(S, 0, r.Q));
    r.gov = r.w * r.Q;
    r.DWL = Math.abs(integ((q) => D(q) - S(q), Math.min(r.Q, Qe), Math.max(r.Q, Qe)));
    return r;
  }

  const MARKET_WORDS = {
    product: {
      x: 'Quantity', y: 'Price', pw: 'price', qw: 'quantity', dn: 'Demand', sn: 'Supply',
      cs: 'Consumer surplus', ps: 'Producer surplus', pe: 'P_e', qe: 'Q_e',
    },
    labor: {
      x: 'Quantity of Labor', y: 'Wage', pw: 'wage', qw: 'employment', dn: 'Labor demand', sn: 'Labor supply',
      cs: 'Surplus to employers', ps: 'Surplus to workers', pe: 'W_e', qe: 'L_e',
    },
  };

  function drawMarket(p, K, kind) {
    const V = MARKET_WORDS[kind];
    const labor = kind === 'labor';
    const m = marketCalc(p);
    const c = K.chart({ xmax: 120, ymax: 13.5, xlabel: V.x, ylabel: V.y });
    const D0 = (q) => 10 - 0.1 * q;
    const S0 = (q) => 0.1 * q;
    const dMoved = p.d !== 0;
    const sMoved = p.s !== 0;
    const Dat = clamp(85 + p.d, 8, 108);
    const Sat = Math.min(105 + p.s, 112);

    // shaded areas first, so the curves sit on top
    if (p.cs && m.Q > 0) c.area([[0, m.D(0)], [m.Q, m.D(m.Q)], [m.Q, m.Pb], [0, m.Pb]], 'cs', { label: labor ? 'Employers' : 'CS' });
    if (p.ps && m.Q > 0) {
      const q0 = Math.max(0, p.s);
      c.area([[q0, m.Ps], [m.Q, m.Ps], [m.Q, m.S(m.Q)], [q0, m.S(q0)]], 'ps', { label: labor ? 'Workers' : 'PS' });
    }
    if (m.binding && (m.mode === 'tax' || m.mode === 'sub') && m.Q > 0) {
      const lo = Math.min(m.Pb, m.Ps);
      const hi = Math.max(m.Pb, m.Ps);
      c.area([[0, lo], [m.Q, lo], [m.Q, hi], [0, hi]], 'rev', { label: m.mode === 'tax' ? 'Tax revenue' : 'Cost to government' });
    }
    if (p.dwl && m.binding && m.DWL > 0.01) {
      const qq = m.Q;
      c.area([[qq, m.D(qq)], [qq, m.S(qq)], [m.Qe, m.Pe]], 'dwl', { label: 'DWL' });
    }

    if (dMoved) c.curve(D0, 0, 100, 'd', { ghost: true, label: 'D_1', at: 85, dy: -9 });
    if (sMoved) c.curve(S0, 0, 120, 's', { ghost: true, label: 'S_1', at: Math.min(105, 120), dy: -9 });
    c.curve(m.D, 0, 130, 'd', { w: 3.5, label: dMoved ? 'D_2' : 'D', at: Dat, dy: -9 });
    c.curve((q) => 0.1 * (q - p.s), 0, 130, 's', { w: 3.5, label: sMoved ? 'S_2' : 'S', at: Sat, dy: -9 });
    if (m.mode === 'tax' || m.mode === 'sub') {
      c.curve((q) => 0.1 * (q - p.s) + m.w, 0, 130, 's', { dash: true, w: 3, label: m.mode === 'tax' ? 'S + tax' : 'S + subsidy', at: Math.min(100 + p.s, 105), dy: m.w > 0 ? -12 : 18 });
    }

    const shifted = dMoved || sMoved;
    if (shifted && m.mode === 'free') {
      c.drop(50, 5, 'Q_1', 'P_1', { cls: 'g' });
      c.dot(50, 5, 'g', { r: 4.5 });
    }
    if (m.mode === 'free' || !m.binding) {
      c.drop(m.Qe, m.Pe, shifted ? 'Q_2' : V.qe, shifted ? 'P_2' : V.pe, { cls: 'k' });
      c.dot(m.Qe, m.Pe, 'a', { r: 7 });
    } else if (m.mode === 'tax' || m.mode === 'sub') {
      c.dot(m.Qe, m.Pe, 'g', { r: 4.5 });
      c.drop(m.Q, m.Pb, 'Q_t', 'P_b', { cls: 'k' });
      c.drop(m.Q, m.Ps, null, 'P_s', { cls: 'k', only: 'y' });
      c.dot(m.Q, m.Pb, 'a', { r: 6 });
      c.dot(m.Q, m.Ps, 'a', { r: 6 });
    } else {
      const lvlName = m.mode === 'ceil' ? (labor ? 'Wage ceiling' : 'Price ceiling') : (labor ? 'Minimum wage' : 'Price floor');
      c.seg(0, p.lvl, 120, p.lvl, 'k', { dash: true, w: 2.5 });
      c.text(120, p.lvl, lvlName, { cls: 'k', dx: -6, dy: m.mode === 'ceil' ? 17 : -8, anchor: 'end', bold: true });
      const qs = m.qsAt(p.lvl);
      const qd = m.qdAt(p.lvl);
      c.drop(qs, p.lvl, 'Q_S', null, { cls: 'g', only: 'x' });
      c.drop(qd, p.lvl, 'Q_D', null, { cls: 'g', only: 'x' });
      c.dot(qs, p.lvl, 's', { r: 5 });
      c.dot(qd, p.lvl, 'd', { r: 5 });
      c.drop(m.Q, p.lvl, null, labor ? 'W_c' : 'P_c', { cls: 'k', only: 'y' });
      const lo = Math.min(qs, qd);
      const hi = Math.max(qs, qd);
      c.seg(lo, p.lvl, hi, p.lvl, m.mode === 'ceil' ? 'f' : 'a', { w: 6 });
      c.text((lo + hi) / 2, p.lvl, m.mode === 'ceil' ? 'Shortage' : (labor ? 'Unemployment' : 'Surplus'), { cls: m.mode === 'ceil' ? 'f' : 'a', dy: m.mode === 'ceil' ? -12 : 20, anchor: 'middle', bold: true });
    }
    c.handle(15 + p.d, m.D(15 + p.d), 'D', 'd');
    c.handle(85 + p.s, 0.1 * 85, 'S', 's');

    // facts
    const facts = [];
    if (m.mode === 'free' || !m.binding) {
      facts.push({ k: `Equilibrium ${V.pw}`, v: money(m.Pe) });
      facts.push({ k: `Equilibrium ${V.qw}`, v: trim(m.Qe, 1) });
    } else if (m.mode === 'tax' || m.mode === 'sub') {
      facts.push({ k: `${V.pw[0].toUpperCase()}${V.pw.slice(1)} buyers pay`, v: money(m.Pb) });
      facts.push({ k: `${V.pw[0].toUpperCase()}${V.pw.slice(1)} sellers keep`, v: money(m.Ps) });
      facts.push({ k: `${V.qw[0].toUpperCase()}${V.qw.slice(1)} traded`, v: trim(m.Q, 1) });
    } else {
      facts.push({ k: `${m.mode === 'ceil' ? 'Ceiling' : 'Floor'} price`, v: money(p.lvl) });
      facts.push({ k: `${V.qw[0].toUpperCase()}${V.qw.slice(1)} traded`, v: trim(m.Q, 1) });
      facts.push({ k: m.mode === 'ceil' ? 'Shortage' : (labor ? 'Unemployment' : 'Surplus'), v: trim(m.mode === 'ceil' ? m.shortage : m.surplus, 1) });
    }
    facts.push({ sw: 'cs', k: V.cs, v: trim(m.CS, 1) });
    facts.push({ sw: 'ps', k: V.ps, v: trim(m.PS, 1) });
    if (m.binding && (m.mode === 'tax' || m.mode === 'sub')) facts.push({ sw: 'rev', k: m.mode === 'tax' ? 'Tax revenue' : 'Cost to government', v: trim(Math.abs(m.gov), 1) });
    if (m.binding) facts.push({ sw: 'dwl', k: 'Deadweight loss', v: trim(m.DWL, 1) });

    // what to say
    const say = [];
    if (shifted) {
      const bits = [];
      if (dMoved) bits.push(`${V.dn.toLowerCase()} ${p.d > 0 ? 'increases' : 'decreases'}`);
      if (sMoved) bits.push(`${V.sn.toLowerCase()} ${p.s > 0 ? 'increases' : 'decreases'}`);
      const cap = bits.join(' and ');
      say.push(`${cap[0].toUpperCase()}${cap.slice(1)}: the equilibrium ${V.pw} ${moves(5, m.Pe)} and the ${V.qw} ${moves(50, m.Qe)}.`);
      if (dMoved && sMoved && p.d === p.s) say.push('The shifts are the same size, so the price does not change; with different sizes the price change would depend on which shift is bigger.');
    } else if (m.mode === 'free') say.push(`At equilibrium the ${V.qw} demanded equals the ${V.qw} supplied. Drag a curve, or use a slider, to shift it.`);
    if (m.mode === 'ceil') say.push(m.binding ? `The ceiling is below equilibrium, so it binds: buyers want ${trim(m.qdAt(p.lvl), 0)} but sellers offer ${trim(m.qsAt(p.lvl), 0)}, a shortage of ${trim(m.shortage, 0)}.` : 'This ceiling is above the equilibrium price, so it does nothing.');
    if (m.mode === 'floor') say.push(m.binding ? `The ${labor ? 'minimum wage' : 'floor'} is above equilibrium, so it binds: ${trim(m.qsAt(p.lvl), 0)} are offered but only ${trim(m.qdAt(p.lvl), 0)} wanted, leaving ${trim(m.surplus, 0)} ${labor ? 'unemployed' : 'unsold'}.` : 'This floor is below the equilibrium price, so it does nothing.');
    if (m.mode === 'tax' && p.amt > 0) say.push(`The tax puts a wedge of ${money(p.amt)} between what buyers pay and what sellers keep, so the ${V.qw} falls and the burden is shared between them.`);
    if (m.mode === 'sub' && p.amt > 0) say.push(`The subsidy puts a ${money(p.amt)} wedge the other way, so the ${V.qw} rises past equilibrium and the government pays for the extra.`);
    return { charts: [c], facts, say: say.join(' ') };
  }

  const marketDrag = (id, x, y, p) => {
    if (id === 'D') p.d = clamp(Math.round((x - 15) / 5) * 5, -30, 30);
    if (id === 'S') p.s = clamp(Math.round((x - 85) / 5) * 5, -30, 30);
  };

  define({
    key: 'sd',
    unit: 2,
    name: 'Supply and demand',
    ced: 'CED Topics 2.1–2.2, 2.6–2.8 · MKT-3.A–E, MKT-4.A–B, POL-1.A–B',
    blurb: 'Drag the D or S handle (or use the sliders) to shift a curve. Demand is marginal benefit (MB) and supply is marginal cost (MC), so the shaded areas show who gains.',
    exam: [
      'Draw demand and supply, label equilibrium price and quantity, and show shifts as D₁ to D₂.',
      'Show consumer surplus, producer surplus and total surplus.',
      'Show the effect of price ceilings, price floors, per-unit taxes and subsidies, and the deadweight loss.',
      'A shift of a curve is a change in demand or supply; a movement along it is a change in quantity demanded or supplied.',
    ],
    defaults: { d: 0, s: 0, mode: 'free', lvl: 3, amt: 2, cs: false, ps: false, dwl: true },
    controls: [
      { head: 'Shift the curves' },
      { k: 'd', label: 'Demand', min: -30, max: 30, step: 5, fmt: (v) => (v === 0 ? 'no change' : v > 0 ? `increase ${v}` : `decrease ${-v}`) },
      { k: 's', label: 'Supply', min: -30, max: 30, step: 5, fmt: (v) => (v === 0 ? 'no change' : v > 0 ? `increase ${v}` : `decrease ${-v}`) },
      { head: 'Government' },
      {
        type: 'seg', k: 'mode', label: 'Policy', opts: [['free', 'None'], ['ceil', 'Ceiling'], ['floor', 'Floor'], ['tax', 'Tax'], ['sub', 'Subsidy']],
        on: (p, v) => { if (v === 'ceil') p.lvl = 3; if (v === 'floor') p.lvl = 7; },
      },
      { k: 'lvl', label: 'Controlled price', min: 1, max: 10, step: 0.5, show: (p) => p.mode === 'ceil' || p.mode === 'floor', fmt: (v) => money(v) },
      { k: 'amt', label: 'Per-unit amount', min: 0, max: 4, step: 0.5, show: (p) => p.mode === 'tax' || p.mode === 'sub', fmt: (v) => money(v) },
      { head: 'Show' },
      { type: 'toggle', k: 'cs', label: 'Consumer surplus' },
      { type: 'toggle', k: 'ps', label: 'Producer surplus' },
      { type: 'toggle', k: 'dwl', label: 'Deadweight loss' },
    ],
    scenarios: [
      { name: 'Incomes rise (normal good)', ask: 'Consumers’ incomes rise and the good is normal. Which curve shifts, which way, and what happens to equilibrium price and quantity?', set: { d: 20 } },
      { name: 'Price of a substitute falls', ask: 'The price of a substitute falls. What happens to demand for this good, and to its price and quantity?', set: { d: -20 } },
      { name: 'Technology cuts costs', ask: 'A new technology lowers the cost of production. What happens to supply, price and quantity?', set: { s: 20 } },
      { name: 'Input prices rise', ask: 'The price of an input rises. What happens to supply, price and quantity?', set: { s: -20 } },
      { name: 'Demand and supply both increase', ask: 'Demand and supply both increase. What can you say for sure about price and quantity, and what depends on the size of the shifts?', set: { d: 20, s: 20 } },
      { name: 'Price ceiling below equilibrium', ask: 'The government sets a price ceiling below the equilibrium price. What happens in the market?', set: { mode: 'ceil', lvl: 3, dwl: true } },
      { name: 'Price floor above equilibrium', ask: 'The government sets a price floor above the equilibrium price. What happens in the market?', set: { mode: 'floor', lvl: 7, dwl: true } },
      { name: 'A per-unit tax on sellers', ask: 'A $2 per-unit tax is placed on sellers. Show the tax wedge, the revenue and the deadweight loss.', set: { mode: 'tax', amt: 2, dwl: true } },
      { name: 'A per-unit subsidy', ask: 'The government pays a $2 subsidy per unit. What happens to quantity, and who benefits?', set: { mode: 'sub', amt: 2, dwl: true } },
    ],
    drag: marketDrag,
    draw: (p, K) => drawMarket(p, K, 'product'),
  });

  // ---- elasticity -----------------------------------------------------

  const midPct = (a, b) => (b - a) / ((a + b) / 2);

  define({
    key: 'elasticity',
    unit: 2,
    name: 'Price elasticity of demand',
    ced: 'CED Topic 2.3 · MKT-3.E',
    blurb: 'On a straight-line demand curve, demand is elastic where the price is high, unit elastic at the midpoint and inelastic where the price is low. Total revenue peaks at the midpoint.',
    exam: [
      'Calculate price elasticity of demand with the midpoint method.',
      'Use the total revenue test: if price and total revenue move in opposite directions, demand is elastic.',
      'Know that elasticity changes along a straight-line demand curve even though its slope does not.',
    ],
    defaults: { b: 0.4, p1: 14, p2: 8, _n: true },
    controls: [
      { k: 'b', label: 'Slope of demand', min: 0.2, max: 1, step: 0.05, fmt: (v) => trim(v, 2) },
      { k: 'p1', label: 'Starting price', min: 1, max: 19, step: 0.5, fmt: (v) => money(v) },
      { k: 'p2', label: 'New price', min: 1, max: 19, step: 0.5, fmt: (v) => money(v) },
    ],
    scenarios: [
      { name: 'Cut the price from the top', ask: 'Demand is elastic when the price is high. If the price falls from $14 to $8, what happens to total revenue?', set: { p1: 14, p2: 8 } },
      { name: 'Cut the price from the bottom', ask: 'Now the price falls from $6 to $2. What happens to total revenue, and what does that tell you about elasticity here?', set: { p1: 6, p2: 2 } },
      { name: 'Raise the price in the inelastic range', ask: 'A firm raises its price from $4 to $8. What happens to quantity demanded and to total revenue?', set: { p1: 4, p2: 8 } },
    ],
    draw(p, K) {
      const a = 20;
      const D = (q) => a - p.b * q;
      const qAt = (pr) => (a - pr) / p.b;
      const mid = a / 2;
      const q1 = qAt(p.p1);
      const q2 = qAt(p.p2);
      const pctQ = midPct(q1, q2);
      const pctP = midPct(p.p1, p.p2);
      const E = pctP === 0 ? NaN : Math.abs(pctQ / pctP);
      const tr1 = p.p1 * q1;
      const tr2 = p.p2 * q2;
      const kind = !fin(E) ? '' : Math.abs(E - 1) < 0.005 ? 'unit elastic' : E > 1 ? 'elastic' : 'inelastic';

      const c1 = K.chart({ title: 'Demand', xmax: 100, ymax: 22, xlabel: 'Quantity', ylabel: 'Price' });
      const qm = qAt(mid);
      c1.seg(0, a, qm, mid, 'd', { w: 3.5 });
      c1.seg(qm, mid, qAt(0), 0, 'a', { w: 3.5 });
      c1.text(qm * 0.35, a - p.b * qm * 0.35, 'Elastic', { cls: 'd', dx: 14, dy: -6, bold: true });
      c1.text(qm + (qAt(0) - qm) * 0.55, D(qm + (qAt(0) - qm) * 0.55), 'Inelastic', { cls: 'a', dx: 12, dy: -8, bold: true });
      c1.dot(qm, mid, 'k', { r: 5, label: 'Unit elastic', dx: 10, dy: -10 });
      c1.drop(q1, p.p1, 'Q_1', 'P_1', { cls: 'g' });
      c1.drop(q2, p.p2, 'Q_2', 'P_2', { cls: 'g' });
      c1.dot(q1, p.p1, 'f', { r: 6.5 });
      c1.dot(q2, p.p2, 's', { r: 6.5 });

      const TR = (q) => q * D(q);
      const trMax = (a * a) / (4 * p.b);
      const c2 = K.chart({ title: 'Total revenue', xmax: 100, ymax: Math.ceil((trMax * 1.18) / 10) * 10, xlabel: 'Quantity', ylabel: 'Total revenue ($)' });
      c2.curve(TR, 0, qAt(0), 'v', { w: 3.5, label: 'TR', at: qAt(0) * 0.9, dy: -10 });
      c2.dot(qm, TR(qm), 'k', { r: 5, label: 'TR is highest', dx: 8, dy: -10 });
      c2.drop(q1, tr1, 'Q_1', null, { cls: 'g', only: 'x' });
      c2.drop(q2, tr2, 'Q_2', null, { cls: 'g', only: 'x' });
      c2.dot(q1, tr1, 'f', { r: 6.5 });
      c2.dot(q2, tr2, 's', { r: 6.5 });

      const facts = [
        { sw: 'f', k: 'Start: price, quantity', v: `${money(p.p1)}, ${trim(q1, 1)}` },
        { sw: 's', k: 'New: price, quantity', v: `${money(p.p2)}, ${trim(q2, 1)}` },
        { k: '% change in quantity', v: pct(pctQ, 1) },
        { k: '% change in price', v: pct(pctP, 1) },
        { k: 'Elasticity (midpoint)', v: fin(E) ? `${trim(E, 2)} → ${kind}` : '–' },
        { sw: 'v', k: 'Total revenue', v: `${trim(tr1, 1)} → ${trim(tr2, 1)}` },
      ];
      const say = [];
      if (fin(E)) {
        const trMove = moves(tr1, tr2, 0.005);
        say.push(`Price ${moves(p.p1, p.p2)} and total revenue ${trMove}: ${kind === 'unit elastic' ? 'demand is unit elastic here (revenue does not change).' : `prices and revenue move ${(sign(p.p2 - p.p1) === sign(tr2 - tr1)) ? 'in the same direction, so demand is inelastic' : 'in opposite directions, so demand is elastic'} over this range.`}`);
        say.push(`The midpoint method gives |E| = ${trim(E, 2)}.`);
      } else say.push('Choose two different prices to find the elasticity between them.');
      return { charts: [c1, c2], facts, say: say.join(' ') };
    },
  });

  // ---- other elasticities (calculators) -------------------------------

  const ELAST_CALCS = [
    {
      key: 'ped', title: 'Price elasticity of demand', fields: ['Price: before', 'Price: after', 'Quantity demanded: before', 'Quantity demanded: after'],
      run: (v) => {
        const e = midPct(v[2], v[3]) / midPct(v[0], v[1]);
        const a = Math.abs(e);
        return { val: a, text: `|E| = ${trim(a, 2)}: ${Math.abs(a - 1) < 0.005 ? 'unit elastic' : a > 1 ? 'elastic' : 'inelastic'}` };
      },
    },
    {
      key: 'xed', title: 'Cross-price elasticity', fields: ['Price of Good B: before', 'Price of Good B: after', 'Quantity of Good A: before', 'Quantity of Good A: after'],
      run: (v) => {
        const e = midPct(v[2], v[3]) / midPct(v[0], v[1]);
        return { val: e, text: `E = ${trim(e, 2)}: ${Math.abs(e) < 0.005 ? 'unrelated goods' : e > 0 ? 'substitutes (positive)' : 'complements (negative)'}` };
      },
    },
    {
      key: 'yed', title: 'Income elasticity of demand', fields: ['Income: before', 'Income: after', 'Quantity demanded: before', 'Quantity demanded: after'],
      run: (v) => {
        const e = midPct(v[2], v[3]) / midPct(v[0], v[1]);
        return { val: e, text: `E = ${trim(e, 2)}: ${e < 0 ? 'inferior good (negative)' : e > 1 ? 'normal good, a luxury (above 1)' : 'normal good, a necessity (0 to 1)'}` };
      },
    },
    {
      key: 'pes', title: 'Price elasticity of supply', fields: ['Price: before', 'Price: after', 'Quantity supplied: before', 'Quantity supplied: after'],
      run: (v) => {
        const e = midPct(v[2], v[3]) / midPct(v[0], v[1]);
        return { val: e, text: `E = ${trim(e, 2)}: ${Math.abs(e - 1) < 0.005 ? 'unit elastic' : e > 1 ? 'elastic' : 'inelastic'}` };
      },
    },
  ];

  define({
    key: 'otherelast',
    unit: 2,
    name: 'Elasticity calculators',
    ced: 'CED Topics 2.3–2.5 · MKT-3.E (price, cross-price, income, supply)',
    blurb: 'Type the before and after numbers. The calculators use the midpoint method (the change divided by the average) and say what the answer means.',
    exam: [
      'Midpoint method: % change = change ÷ average of the two values.',
      'Cross-price elasticity: positive for substitutes, negative for complements.',
      'Income elasticity: negative for inferior goods, above 1 for luxuries, 0 to 1 for necessities.',
    ],
    noNumbers: true,
    defaults: {
      ped: [10, 8, 100, 130], xed: [4, 5, 60, 70], yed: [30000, 36000, 20, 26], pes: [5, 6, 40, 46],
    },
    scenarios: [
      { name: 'Substitutes or complements?', ask: 'The price of Good B rises 25% and the quantity of Good A bought rises. Are A and B substitutes or complements?', set: {} },
    ],
    build(host, p, api) {
      const outs = {};
      const grid = el('div.ec-calcs');
      for (const calc of ELAST_CALCS) {
        const out = el('p.ec-calc-out');
        outs[calc.key] = out;
        const inputs = calc.fields.map((label, i) => el('label.ec-calc-field', {}, [
          el('span', { text: label }),
          el('input.input.ec-cell', {
            type: 'number', step: 'any', 'data-calc': calc.key, 'data-i': i,
            oninput: (e) => { const x = parseFloat(e.target.value); p[calc.key][i] = fin(x) ? x : 0; api.refresh(); api.save(); },
          }),
        ]));
        grid.append(el('div.ec-calc', {}, [el('h4', { text: calc.title }), ...inputs, out]));
      }
      host.append(grid);
      return {
        update(q) {
          for (const calc of ELAST_CALCS) {
            for (const inp of grid.querySelectorAll(`[data-calc="${calc.key}"]`)) {
              if (document.activeElement !== inp) inp.value = q[calc.key][+inp.dataset.i];
            }
            const v = q[calc.key];
            const ok = v[0] + v[1] > 0 && v[2] + v[3] > 0 && v[0] !== v[1];
            outs[calc.key].textContent = ok ? calc.run(v).text : 'Enter two different values for the first pair.';
          }
          api.facts([]);
          api.say('Elasticity is the percentage change in quantity divided by the percentage change in the other variable.');
        },
      };
    },
  });

  // ---- international trade -------------------------------------------

  function tradeCalc(p) {
    const D = (q) => 10 - 0.1 * q;
    const S = (q) => 0.1 * q;
    const qd = (pr) => Math.max(0, 100 - 10 * pr);
    const qs = (pr) => Math.max(0, 10 * pr);
    const importing = p.pw < 5 - 1e-9;
    const exporting = p.pw > 5 + 1e-9;
    const t = importing ? p.tariff : 0;
    const pt = importing ? Math.min(p.pw + t, 5) : p.pw;
    const blocked = importing && p.pw + t >= 5 - 1e-9 && t > 0;
    const cs = (pr) => integ((q) => D(q) - pr, 0, qd(pr));
    const ps = (pr) => integ((q) => pr - S(q), 0, qs(pr));
    const r = {
      D, S, qd, qs, importing, exporting, t, pt, blocked,
      cs0: cs(5), ps0: ps(5), cs: cs(pt), ps: ps(pt),
      trade: importing ? qd(pt) - qs(pt) : exporting ? qs(pt) - qd(pt) : 0,
      rev: 0, dwl: 0,
    };
    if (importing && t > 0 && !blocked) {
      r.rev = t * (qd(pt) - qs(pt));
      r.dwl = 0.5 * t * (qs(pt) - qs(p.pw)) + 0.5 * t * (qd(p.pw) - qd(pt));
    }
    return r;
  }

  define({
    key: 'trade',
    unit: 2,
    name: 'Domestic market and world price',
    ced: 'CED Topic 2.9 · POL-1.B',
    blurb: 'With trade the domestic price becomes the world price. If it is lower, the country imports; if higher, it exports. A tariff raises the domestic price above the world price. (Graphing quotas is outside the AP course.)',
    exam: [
      'Draw the domestic market with a world price line and show quantities produced, consumed and imported or exported.',
      'Show who gains and loses from free trade, and the effect of a tariff: revenue and deadweight loss.',
      'Understand that a quota reduces imports and raises the price, like a tariff but without the revenue.',
    ],
    defaults: { pw: 3, tariff: 0, cs: true, ps: true },
    controls: [
      { k: 'pw', label: 'World price', min: 1, max: 9, step: 0.5, fmt: (v) => money(v) },
      { k: 'tariff', label: 'Tariff per unit', min: 0, max: 4, step: 0.5, show: (p) => p.pw < 5, fmt: (v) => money(v) },
      { type: 'toggle', k: 'cs', label: 'Consumer surplus' },
      { type: 'toggle', k: 'ps', label: 'Producer surplus' },
    ],
    scenarios: [
      { name: 'World price below domestic price', ask: 'The world price is $3 and the domestic no-trade price is $5. Does the country import or export? Who gains and who loses?', set: { pw: 3 } },
      { name: 'A tariff on imports', ask: 'The government puts a $1 tariff on the imported good. Show the new domestic price, the tariff revenue and the deadweight loss.', set: { pw: 3, tariff: 1 } },
      { name: 'World price above domestic price', ask: 'The world price is $7. Does the country import or export, and who gains and who loses?', set: { pw: 7 } },
    ],
    draw(p, K) {
      const m = tradeCalc(p);
      const c = K.chart({ xmax: 110, ymax: 11, xlabel: 'Quantity', ylabel: 'Price' });
      const P = m.pt;
      if (p.cs) c.area([[0, 10], [m.qd(P), P], [0, P]], 'cs', { label: 'CS' });
      if (p.ps) c.area([[0, 0], [0, P], [m.qs(P), P]], 'ps', { label: 'PS' });
      if (m.rev > 0) c.area([[m.qs(P), p.pw], [m.qd(P), p.pw], [m.qd(P), P], [m.qs(P), P]], 'rev', { label: 'Tariff revenue' });
      if (m.dwl > 0) {
        c.area([[m.qs(p.pw), p.pw], [m.qs(P), p.pw], [m.qs(P), P]], 'dwl');
        c.area([[m.qd(P), p.pw], [m.qd(p.pw), p.pw], [m.qd(P), P]], 'dwl');
      }
      c.curve(m.D, 0, 100, 'd', { w: 3.5, label: 'Domestic D', at: 6, dy: -9, dx: 10 });
      c.curve(m.S, 0, 110, 's', { w: 3.5, label: 'Domestic S', at: 100, dy: -9, anchor: 'end', dx: -6 });
      c.dot(50, 5, 'g', { r: 4.5 });
      c.text(0, 5, 'P_1 (no trade)', { cls: 'g', dx: 8, dy: -6 });
      c.seg(0, 5, 50, 5, 'g', { dash: true });
      c.seg(0, p.pw, 110, p.pw, 'k', { dash: true, w: 2.5 });
      c.text(110, p.pw, 'World price', { cls: 'k', dx: -4, dy: p.pw < 5 ? 17 : -8, anchor: 'end', bold: true });
      if (m.importing && m.t > 0) {
        c.seg(0, P, 110, P, 'f', { dash: true, w: 2.5 });
        c.text(110, P, 'World price + tariff', { cls: 'f', dx: -4, dy: -8, anchor: 'end', bold: true });
      }
      c.drop(m.qs(P), P, 'Q_S', null, { cls: 'k', only: 'x' });
      c.drop(m.qd(P), P, 'Q_D', null, { cls: 'k', only: 'x' });
      c.dot(m.qs(P), P, 's', { r: 5.5 });
      c.dot(m.qd(P), P, 'd', { r: 5.5 });
      c.drop(0, P, null, m.importing && m.t > 0 ? 'P_w+t' : 'P_w', { cls: 'k', only: 'y' });

      const facts = [];
      if (m.importing) {
        facts.push({ k: 'Imports', v: trim(m.trade, 1) });
        facts.push({ k: 'Domestic price', v: money(P) });
      } else if (m.exporting) facts.push({ k: 'Exports', v: trim(m.trade, 1) });
      else facts.push({ k: 'Trade', v: 'none: world price = domestic price' });
      facts.push({ sw: 'cs', k: 'Consumer surplus', v: `${trim(m.cs0, 1)} → ${trim(m.cs, 1)}` });
      facts.push({ sw: 'ps', k: 'Producer surplus', v: `${trim(m.ps0, 1)} → ${trim(m.ps, 1)}` });
      if (m.rev > 0) facts.push({ sw: 'rev', k: 'Tariff revenue', v: trim(m.rev, 1) });
      if (m.dwl > 0) facts.push({ sw: 'dwl', k: 'Deadweight loss', v: trim(m.dwl, 1) });
      const say = [];
      if (m.importing) say.push(`The world price is below the domestic price, so the country imports ${trim(m.trade, 0)} units. Consumers gain more than domestic producers lose.`);
      else if (m.exporting) say.push(`The world price is above the domestic price, so the country exports ${trim(m.trade, 0)} units. Producers gain more than consumers lose.`);
      else say.push('With the world price equal to the domestic price, there is no trade.');
      if (m.blocked) say.push('This tariff is high enough to block all imports.');
      else if (m.rev > 0) say.push(`The tariff raises the domestic price to ${money(P)}, shrinks imports, earns the government revenue, and creates deadweight loss.`);
      return { charts: [c], facts, say: say.join(' ') };
    },
  });

  // =================================================================
  // UNIT 3 — Production, Cost, and the Perfect Competition Model
  // =================================================================

  // ---- the production function ----------------------------------------

  // TP(L) = t(1.5L^2 - 0.06L^3). Marginal product peaks at L = 8.33,
  // average product peaks where it meets MP at L = 12.5, and MP is zero (and
  // TP highest) at L = 16.67.
  const tpOf = (L, t) => t * (1.5 * L * L - 0.06 * L * L * L);
  const mpOf = (L, t) => t * (3 * L - 0.18 * L * L);
  const apOf = (L, t) => (L > 0 ? t * (1.5 * L - 0.06 * L * L) : NaN);
  const L_MPMAX = 25 / 3;
  const L_TPMAX = 50 / 3;

  define({
    key: 'production',
    unit: 3,
    name: 'The production function',
    ced: 'CED Topic 3.1 · PRD-1.A',
    blurb: 'Adding workers to a fixed amount of capital: output first rises faster, then more slowly (diminishing marginal returns), and eventually falls.',
    exam: [
      'Draw and read total product (TP), marginal product (MP) and average product (AP) against the quantity of the variable input.',
      'Name the three regions: increasing, diminishing and negative marginal returns.',
      'MP crosses AP at AP’s maximum; TP is highest where MP = 0.',
    ],
    defaults: { L: 6, t: 1, zones: true },
    controls: [
      { k: 'L', label: 'Workers hired', min: 0, max: 20, step: 0.5 },
      { k: 't', label: 'Technology', min: 0.6, max: 1.6, step: 0.1, fmt: (v) => `×${trim(v, 1)}` },
      { type: 'toggle', k: 'zones', label: 'Show the three regions' },
    ],
    scenarios: [
      { name: 'Where do returns start to diminish?', ask: 'As more workers are added to the same factory, where does marginal product begin to fall, and where does total product stop growing?', set: { L: 12, zones: true } },
      { name: 'Technology improves', ask: 'A better machine makes each worker more productive. What happens to TP, MP and AP?', set: { t: 1.4 } },
    ],
    draw(p, K) {
      const t = p.t;
      const tpMax = tpOf(L_TPMAX, t);
      const c1 = K.chart({ title: 'Total product', xmax: 20, ymax: Math.ceil((Math.max(tpMax, tpOf(L_TPMAX, 1)) * 1.12) / 10) * 10, xlabel: 'Quantity of variable input (workers)', ylabel: 'Quantity of output' });
      const ymaxT = Math.ceil((Math.max(tpMax, tpOf(L_TPMAX, 1)) * 1.12) / 10) * 10;
      const bands = [
        [0, L_MPMAX, 'cs', 'Increasing'],
        [L_MPMAX, L_TPMAX, 'profit', 'Diminishing'],
        [L_TPMAX, 20, 'loss', 'Negative'],
      ];
      if (p.zones) for (const [a, b, cls] of bands) c1.area([[a, 0], [b, 0], [b, ymaxT], [a, ymaxT]], cls);
      if (t !== 1) c1.curve((L) => tpOf(L, 1), 0, 20, 'k', { ghost: true, n: 100 });
      c1.curve((L) => tpOf(L, t), 0, 20, 'd', { w: 3.5, n: 100, label: 'TP', at: 19, dy: -10 });
      c1.drop(p.L, tpOf(p.L, t), 'L', 'TP', { cls: 'k' });
      c1.dot(p.L, tpOf(p.L, t), 'a', { r: 7 });

      const ymaxM = Math.ceil(14 * Math.max(t, 1));
      const c2 = K.chart({ title: 'Marginal and average product', xmax: 20, ymax: ymaxM, ymin: -Math.ceil(4 * Math.max(t, 1)), zeroAxis: true, xlabel: 'Quantity of variable input (workers)', ylabel: 'Output per worker' });
      if (p.zones) for (const [a, b, cls, name] of bands) { c2.area([[a, -100], [b, -100], [b, 100], [a, 100]], cls); c2.text((a + b) / 2, ymaxM, name, { cls: 'k', anchor: 'middle', dy: 14, fixed: true, bold: true }); }
      if (t !== 1) { c2.curve((L) => mpOf(L, 1), 0, 20, 'k', { ghost: true }); c2.curve((L) => apOf(L, 1), 0.2, 20, 'k', { ghost: true }); }
      c2.curve((L) => mpOf(L, t), 0, 20, 's', { w: 3.5, label: 'MP', at: 14.6, dy: 4, dx: 10 });
      c2.curve((L) => apOf(L, t), 0.2, 20, 'v', { w: 3.5, label: 'AP', at: 19, dy: -10 });
      const mp = mpOf(p.L, t);
      c2.drop(p.L, Math.max(mp, 0), 'L', null, { cls: 'k', only: 'x' });
      c2.dot(p.L, mp, 's', { r: 6.5 });
      if (p.L > 0.2) c2.dot(p.L, apOf(p.L, t), 'v', { r: 6.5 });

      const region = p.L < L_MPMAX ? 'increasing marginal returns' : p.L <= L_TPMAX ? 'diminishing marginal returns' : 'negative marginal returns';
      const facts = [
        { sw: 'd', k: 'Total product', v: trim(tpOf(p.L, t), 1) },
        { sw: 's', k: 'Marginal product', v: trim(mp, 2) },
        { sw: 'v', k: 'Average product', v: p.L > 0 ? trim(apOf(p.L, t), 2) : '–' },
        { k: 'Region', v: region },
      ];
      if (p.zones) {
        facts.push({ sw: 'cs', k: 'Shading: increasing', v: 'marginal returns' });
        facts.push({ sw: 'profit', k: 'Shading: diminishing', v: 'marginal returns' });
        facts.push({ sw: 'loss', k: 'Shading: negative', v: 'marginal returns' });
      }
      const say = [`At ${trim(p.L, 1)} workers the firm is in the region of ${region}.`];
      if (p.L > 0.2) say.push(mp > apOf(p.L, t) ? 'MP is above AP, so AP is rising.' : 'MP is below AP, so AP is falling.');
      if (mp < 0) say.push('MP is negative, so total product is falling: another worker makes things worse.');
      return { charts: [c1, c2], facts, say: say.join(' ') };
    },
  });

  // ---- short-run costs -------------------------------------------------

  /**
   * One firm's short-run costs. Variable cost is v * (10q - 1.5q^2 + 0.1q^3),
   * so MC = v(10 - 3q + 0.3q^2) falls, bottoms out at q = 5 and then rises
   * (diminishing returns); AVC bottoms out at q = 7.5 where MC meets it.
   */
  function costFns(fc, v) {
    const MC = (q) => v * (10 - 3 * q + 0.3 * q * q);
    const TVC = (q) => v * (10 * q - 1.5 * q * q + 0.1 * q * q * q);
    const AVC = (q) => (q > 0 ? TVC(q) / q : v * 10);
    const ATC = (q) => AVC(q) + fc / q;
    const AFC = (q) => fc / q;
    const qMinATC = argmin(ATC, 1, 16);
    const minAVC = v * 4.375;
    const supplyQ = (pr) => {
      if (pr < minAVC - 1e-9) return 0;
      return (3 + Math.sqrt(Math.max(0, 9 - 1.2 * (10 - pr / v)))) / 0.6;
    };
    return { MC, TVC, AVC, ATC, AFC, TFC: () => fc, TC: (q) => TVC(q) + fc, qMinATC, minATC: ATC(qMinATC), qMinAVC: 7.5, minAVC, supplyQ };
  }

  define({
    key: 'costs',
    unit: 3,
    name: 'Short-run costs',
    ced: 'CED Topic 3.2 · PRD-1.A, PRD-2.A',
    blurb: 'Per-unit costs (AFC, AVC, ATC, MC) and total costs (TFC, TVC, TC) all come from the same firm. Fixed costs are spread over more units; MC rises because of diminishing returns.',
    exam: [
      'Draw MC, ATC, AVC and AFC with the right shapes, and MC crossing ATC and AVC at their minimums.',
      'Total cost graphs (TFC, TVC, TC) are given to you to analyze; you will not have to draw them.',
      'ATC = AVC + AFC, and TC = TFC + TVC.',
      'If MC is below ATC then ATC is falling; if MC is above ATC then ATC is rising.',
    ],
    defaults: { view: 'unit', fc: 30, v: 1, q: 8, marks: true },
    controls: [
      { type: 'seg', k: 'view', label: 'Show', opts: [['unit', 'Per-unit costs'], ['total', 'Total costs']] },
      { k: 'q', label: 'Output', min: 1, max: 16, step: 0.5 },
      { k: 'fc', label: 'Fixed cost', min: 10, max: 80, step: 5, fmt: (v) => money(v, 0) },
      { k: 'v', label: 'Price of variable inputs', min: 0.6, max: 1.6, step: 0.1, fmt: (v) => `×${trim(v, 1)}` },
      { type: 'toggle', k: 'marks', label: 'Mark the minimum points', show: (p) => p.view === 'unit' },
    ],
    scenarios: [
      { name: 'Fixed cost rises', ask: 'The firm’s rent (a fixed cost) goes up. Which curves move, and which do not?', set: { fc: 60 } },
      { name: 'Wages (a variable cost) rise', ask: 'The wage rate rises. Which cost curves shift, and which do not?', set: { v: 1.4 } },
      { name: 'Is average cost rising or falling?', ask: 'At output 12, is ATC rising or falling? How can you tell from MC?', set: { q: 12, view: 'unit' } },
    ],
    draw(p, K) {
      const C = costFns(p.fc, p.v);
      const q = p.q;
      const facts = [];
      const say = [];
      const charts = [];
      if (p.view === 'unit') {
        const ymax = Math.ceil(18 * Math.max(p.v, 1));
        const c = K.chart({ xmax: 16, ymax, xlabel: 'Quantity', ylabel: 'Cost ($ per unit)' });
        const mcTop = solve((x) => C.MC(x) - ymax * 0.92, 7.5, 16);
        c.curve(C.AFC, 0.6, 16, 'f', { w: 3, label: 'AFC', at: Math.max(1.4, p.fc / (ymax * 0.55)), dx: 8, dy: -6 });
        c.curve(C.ATC, 0.6, 16, 'a', { w: 3.5, label: 'ATC', at: 15.6, dy: -10 });
        c.curve(C.AVC, 0.2, 16, 'v', { w: 3.5, label: 'AVC', at: 15.6, dy: 20 });
        c.curve(C.MC, 0, 16, 's', { w: 3.5, label: 'MC', at: Math.min(mcTop, 15.5), dy: -8, dx: 8 });
        if (p.marks) {
          c.dot(C.qMinATC, C.minATC, 'a', { r: 6 });
          c.drop(C.qMinATC, C.minATC, 'min ATC', null, { cls: 'a', only: 'x', xanchor: 'start', xdx: -2 });
          c.dot(C.qMinAVC, C.minAVC, 'v', { r: 6 });
          c.drop(C.qMinAVC, C.minAVC, 'min AVC', null, { cls: 'v', only: 'x', xanchor: 'end', xdx: 2 });
        }
        c.seg(q, 0, q, ymax, 'k', { dash: true, w: 1.8 });
        c.dot(q, Math.min(C.MC(q), ymax), 's', { r: 5.5 });
        c.dot(q, C.ATC(q), 'a', { r: 5.5 });
        c.dot(q, C.AVC(q), 'v', { r: 5.5 });
        c.dot(q, Math.min(C.AFC(q), ymax), 'f', { r: 5.5 });
        charts.push(c);
        facts.push({ sw: 's', k: 'Marginal cost (MC)', v: money(C.MC(q)) });
        facts.push({ sw: 'a', k: 'Average total cost (ATC)', v: money(C.ATC(q)) });
        facts.push({ sw: 'v', k: 'Average variable cost (AVC)', v: money(C.AVC(q)) });
        facts.push({ sw: 'f', k: 'Average fixed cost (AFC)', v: money(C.AFC(q)) });
        facts.push({ k: 'ATC is lowest at output', v: trim(C.qMinATC, 1) });
        say.push(`At output ${trim(q, 1)}, MC is ${C.MC(q) < C.ATC(q) ? 'below' : 'above'} ATC, so ATC is ${C.MC(q) < C.ATC(q) ? 'falling' : 'rising'}. MC crosses AVC and ATC at their lowest points. ATC = AFC + AVC.`);
      } else {
        const ymax = Math.ceil(C.TC(16) / 50) * 50;
        const c = K.chart({ xmax: 16, ymax, xlabel: 'Output', ylabel: 'Total cost ($)' });
        c.curve(C.TFC, 0, 16, 'f', { w: 3.5, label: 'TFC', at: 15, dy: -9 });
        c.curve(C.TVC, 0, 16, 'v', { w: 3.5, label: 'TVC', at: 15.2, dy: 20 });
        c.curve(C.TC, 0, 16, 'a', { w: 3.5, label: 'TC', at: 15, dy: -10 });
        c.seg(q, 0, q, ymax, 'k', { dash: true, w: 1.8 });
        c.dot(q, C.TFC(q), 'f', { r: 5.5 });
        c.dot(q, C.TVC(q), 'v', { r: 5.5 });
        c.dot(q, C.TC(q), 'a', { r: 5.5 });
        charts.push(c);
        facts.push({ sw: 'f', k: 'Total fixed cost (TFC)', v: money(C.TFC(q)) });
        facts.push({ sw: 'v', k: 'Total variable cost (TVC)', v: money(C.TVC(q)) });
        facts.push({ sw: 'a', k: 'Total cost (TC)', v: money(C.TC(q)) });
        say.push('TFC is a flat line because it does not change with output. TVC starts at the origin and TC = TFC + TVC, so TC is always the same distance above TVC.');
      }
      return { charts, facts, say: say.join(' ') };
    },
  });

  // ---- long-run costs --------------------------------------------------

  const LR_Q0 = 10;
  const lrCost = (q, w) => 6 + 0.06 * Math.max(0, Math.abs(q - LR_Q0) - w) ** 2;
  const lrSlope = (q, w) => {
    const d = Math.abs(q - LR_Q0) - w;
    return d > 0 ? 0.12 * d * Math.sign(q - LR_Q0) : 0;
  };
  const plantQ = (i, n) => (n === 1 ? LR_Q0 : 2 + (16 * i) / (n - 1));

  define({
    key: 'lrcosts',
    unit: 3,
    name: 'Long-run average total cost',
    ced: 'CED Topic 3.3 · PRD-1.A, PRD-2.A',
    blurb: 'In the long run a firm can choose any plant size. Each short-run curve (SRATC) belongs to one plant; the long-run curve (LRATC) touches the lowest part of every one.',
    exam: [
      'Draw LRATC as a U-shaped curve with the short-run ATC curves tangent to it.',
      'Economies of scale: LRATC falls. Constant returns: flat. Diseconomies of scale: LRATC rises.',
      'Minimum efficient scale is the smallest output at which LRATC is as low as it gets.',
    ],
    defaults: { n: 5, sel: 2, flat: 1.5, zones: true },
    controls: [
      { k: 'n', label: 'Plant sizes drawn', min: 1, max: 7, step: 1 },
      { k: 'sel', label: 'Highlight plant size', min: 0, max: 6, step: 1, fmt: (v, p) => `${Math.min(v, p.n - 1) + 1} of ${p.n}` },
      { k: 'flat', label: 'Width of the flat part', min: 0, max: 4, step: 0.5, fmt: (v) => (v === 0 ? 'none' : trim(v, 1)) },
      { type: 'toggle', k: 'zones', label: 'Show the three regions' },
    ],
    scenarios: [
      { name: 'Name the three regions', ask: 'Where does this firm have economies of scale, constant returns to scale and diseconomies of scale?', set: { zones: true, n: 5 } },
      { name: 'Many small plants', ask: 'If the firm could build any size of plant, what would its LRATC look like?', set: { n: 7 } },
    ],
    draw(p, K) {
      const w = p.flat;
      const sel = Math.min(p.sel, p.n - 1);
      const c = K.chart({ xmax: 20, ymax: 14, xlabel: 'Quantity', ylabel: 'Cost ($ per unit)' });
      const a = LR_Q0 - w;
      const b = LR_Q0 + w;
      if (p.zones) {
        c.area([[0, 0], [a, 0], [a, 14], [0, 14]], 'cs');
        if (w > 0) c.area([[a, 0], [b, 0], [b, 14], [a, 14]], 'profit');
        c.area([[b, 0], [20, 0], [20, 14], [b, 14]], 'loss');
        c.text(a / 2, 14, 'Economies of scale', { cls: 'k', anchor: 'middle', dy: 14, fixed: true, bold: true });
        if (w >= 1) c.text(LR_Q0, 14, 'Constant', { cls: 'k', anchor: 'middle', dy: 14, fixed: true, bold: true });
        c.text((b + 20) / 2, 14, 'Diseconomies of scale', { cls: 'k', anchor: 'middle', dy: 14, fixed: true, bold: true });
      }
      for (let i = 0; i < p.n; i += 1) {
        const qk = plantQ(i, p.n);
        const base = lrCost(qk, w);
        const m = lrSlope(qk, w);
        const sr = (q) => base + m * (q - qk) + 0.2 * (q - qk) ** 2;
        const lo = Math.max(0, qk - 6);
        const hi = Math.min(20, qk + 6);
        c.curve(sr, lo, hi, i === sel ? 'v' : 'g', { w: i === sel ? 3.5 : 2, n: 60, ghost: i !== sel, label: i === sel ? `SRATC_${i + 1}` : null, at: Math.min(hi, qk + 4), dy: -8 });
      }
      c.curve((q) => lrCost(q, w), 0, 20, 'a', { w: 4.5, n: 100, label: 'LRATC', at: 19.2, dy: -12 });
      c.dot(a, 6, 'k', { r: 5 });
      c.drop(a, 6, 'MES', null, { cls: 'k', only: 'x' });
      const qk = plantQ(sel, p.n);
      c.dot(qk, lrCost(qk, w), 'v', { r: 6.5 });
      const region = qk < a - 1e-9 ? 'economies of scale' : qk > b + 1e-9 ? 'diseconomies of scale' : 'constant returns to scale';
      const facts = [
        { sw: 'a', k: 'Lowest possible cost', v: money(6) },
        { k: 'Minimum efficient scale', v: `output ${trim(a, 1)}` },
        { sw: 'v', k: `Plant ${sel + 1} is best at output`, v: `${trim(qk, 1)} (${money(lrCost(qk, w))})` },
        { k: 'That plant is in the region of', v: region },
      ];
      const say = ['Each SRATC curve is tangent to LRATC at the output where that plant size is the cheapest way to produce. LRATC is the lower edge of all the short-run curves.'];
      return { charts: [c], facts, say: say.join(' ') };
    },
  });

  // ---- perfect competition: market and firm -----------------------------

  // The market starts in long-run equilibrium: 20 identical firms, price
  // equal to the lowest ATC. Demand is P = 20 - slope * Q.
  const PC = (() => {
    const c = costFns(30, 1);
    const N0 = 20;
    const Q0 = N0 * c.qMinATC;
    return { N0, P0: c.minATC, Q0, slope: (20 - c.minATC) / Q0 };
  })();

  /** The short-run equilibrium for n identical firms. */
  function pcEq(p, nOverride) {
    const n = nOverride == null ? p.n : nOverride;
    const C = costFns(p.fc, 1);
    const k = 1 + p.shift / 100;
    const demandQ = (pr) => k * Math.max(0, (20 - pr) / PC.slope);
    const supplyQ = (pr) => n * C.supplyQ(pr);
    const lo = C.minAVC;
    const g = (pr) => demandQ(pr) - supplyQ(pr);
    let P;
    let partial = false;
    if (g(lo) < 0) { P = lo; partial = true; } else P = solve(g, lo, 20);
    const q = C.supplyQ(P);
    const Q = partial ? demandQ(P) : n * q;
    const atc = C.ATC(q);
    const profit = (P - atc) * q;
    return { C, P, q, Q, atc, profit, partial, demandQ, n };
  }

  /** The number of firms at which economic profit is zero. */
  function pcLongRunN(p) {
    return solve((n) => pcEq(p, n).profit, 2, 120);
  }

  define({
    key: 'perfcomp',
    unit: 3,
    name: 'Perfect competition: market and firm',
    ced: 'CED Topics 3.4–3.7 · CBA-2.D, PRD-2.A, PRD-3.A, POL-2.A',
    blurb: 'The market sets the price; each firm is a price taker and produces where P = MC. Profit draws new firms in and losses push firms out until economic profit is zero.',
    exam: [
      'Draw the side-by-side market and firm graphs, with the firm’s D = MR = P.',
      'Find the profit-maximizing quantity (MR = MC) and shade economic profit or loss.',
      'Shut down in the short run if P < AVC; exit in the long run if P < ATC.',
      'Long-run equilibrium: P = MC = minimum ATC, which is both allocatively and productively efficient.',
    ],
    defaults: { shift: 0, n: 20, fc: 30, marks: false, profitOn: true },
    controls: [
      { k: 'shift', label: 'Change in market demand', min: -30, max: 50, step: 5, fmt: (v) => `${v > 0 ? '+' : ''}${v}%` },
      { k: 'n', label: 'Number of firms', min: 4, max: 60, step: 1, fmt: (v) => trim(v, 1) },
      {
        type: 'button', label: 'Let firms enter or exit (long run)',
        run: (p, api) => {
          const target = clamp(pcLongRunN(p), 4, 60);
          api.animate((q) => {
            const d = target - q.n;
            if (Math.abs(d) < 0.06) { q.n = target; return false; }
            q.n += clamp(d, -0.8, 0.8);
            return true;
          });
        },
      },
      { k: 'fc', label: 'Firm’s fixed cost', min: 10, max: 60, step: 5, fmt: (v) => money(v, 0) },
      { type: 'toggle', k: 'profitOn', label: 'Shade profit or loss' },
      { type: 'toggle', k: 'marks', label: 'Mark break-even and shutdown points' },
    ],
    scenarios: [
      { name: 'Demand increases', ask: 'Demand for the product increases. What happens to the price, to one firm’s profit, and then to the number of firms in the long run?', set: { shift: 30 } },
      { name: 'Demand decreases', ask: 'Demand falls. Show the typical firm’s loss. Will it shut down now, and what happens in the long run?', set: { shift: -25 } },
      { name: 'Price below AVC', ask: 'The price falls below the firm’s minimum AVC. What should the firm do?', set: { shift: -30, n: 30 } },
    ],
    draw(p, K) {
      const e = pcEq(p);
      const C = e.C;
      const shifted = p.shift !== 0;
      const m = K.chart({ title: 'Market', xmax: 500, ymax: 20, xlabel: 'Quantity', ylabel: 'Price' });
      const dFn = (Q) => 20 - (PC.slope * Q) / (1 + p.shift / 100);
      if (shifted) m.curve((Q) => 20 - PC.slope * Q, 0, 400, 'd', { ghost: true, label: 'D_1', at: (20 - 3) / PC.slope, dy: -9 });
      m.curve(dFn, 0, 500, 'd', { w: 3.5, label: shifted ? 'D_2' : 'D', at: Math.min(480, ((20 - 4.5) * (1 + p.shift / 100)) / PC.slope), dy: -9 });
      const sFn = (Q) => C.MC(Q / p.n);
      m.curve(sFn, p.n * 7.5, p.n * 16, 's', { w: 3.5, label: 'S', at: Math.min(p.n * 15.2, 490), dy: -9, n: 60 });
      m.drop(e.Q, e.P, 'Q', 'P', { cls: 'k' });
      m.dot(e.Q, e.P, 'a', { r: 7 });

      const f = K.chart({ title: 'A typical firm', xmax: 16, ymax: 18, xlabel: 'Quantity', ylabel: 'Price, cost' });
      if (p.profitOn && e.q > 0) {
        const lo = Math.min(e.P, e.atc);
        const hi = Math.max(e.P, e.atc);
        f.area([[0, lo], [e.q, lo], [e.q, hi], [0, hi]], e.profit >= 0 ? 'profit' : 'loss', { label: e.profit >= 0 ? 'Profit' : 'Loss' });
      }
      f.curve(C.MC, 0, 16, 's', { w: 3.5, label: 'MC', at: Math.min(solve((x) => C.MC(x) - 16.5, 7.5, 16), 15.4), dy: -8 });
      f.curve(C.ATC, 1.5, 16, 'a', { w: 3.5, label: 'ATC', at: 15.6, dy: -10 });
      f.curve(C.AVC, 0.2, 16, 'v', { w: 3.5, label: 'AVC', at: 15.6, dy: 20 });
      f.seg(0, e.P, 16, e.P, 'd', { w: 3 });
      f.text(0.2, e.P, 'D = MR = P', { cls: 'd', dx: 4, dy: -9, bold: true });
      if (p.marks) {
        f.dot(C.qMinATC, C.minATC, 'a', { r: 6, label: 'Break-even', dx: -8, dy: -12, anchor: 'end' });
        f.dot(7.5, C.minAVC, 'v', { r: 6, label: 'Shutdown', dx: -8, dy: 22, anchor: 'end' });
      }
      f.drop(e.q, e.P, 'q*', 'P', { cls: 'k' });
      f.dot(e.q, e.P, 'a', { r: 7 });

      const profitWord = Math.abs(e.profit) < 0.05 ? 'zero' : e.profit > 0 ? 'positive' : 'negative';
      let status;
      if (profitWord === 'zero') status = 'Economic profit is zero, so firms have no reason to enter or leave: this is long-run equilibrium (P = MC = minimum ATC).';
      else if (e.profit > 0) status = 'The typical firm earns an economic profit, so new firms will enter.';
      else if (e.P >= C.minAVC - 1e-9) status = 'The typical firm has an economic loss, but P covers AVC, so it keeps producing for now and firms will exit in the long run.';
      else status = 'P is below AVC, so the firm shuts down.';
      const facts = [
        { sw: 'a', k: 'Market price', v: money(e.P) },
        { k: 'Market quantity', v: trim(e.Q, 0) },
        { k: 'Firms in the market', v: trim(p.n, 1) },
        { k: 'One firm produces', v: trim(e.q, 2) },
        { k: 'Its ATC at that output', v: money(e.atc) },
        { sw: e.profit >= 0 ? 'profit' : 'loss', k: 'Economic profit per firm', v: money(e.profit) },
      ];
      const say = [status];
      if (e.partial) say.push('Demand is so weak that price falls to the shutdown point and some firms leave at once.');
      if (shifted && Math.abs(e.profit) >= 0.05) say.push('Press the long-run button to watch firms enter or exit until economic profit returns to zero.');
      return { charts: [m, f], facts, say: say.join(' ') };
    },
  });

  // =================================================================
  // UNIT 4 — Imperfect Competition
  // =================================================================

  // Linear demand P = a - 0.5Q (a = 20 for a monopoly), MR = a - Q, rising
  // marginal cost MC = mc0 + 0.25Q, and fixed cost, so ATC = fc/Q + mc0 +
  // 0.125Q is U-shaped.
  function monoCalc(p) {
    const a = p.kind === 'mc' ? 20 - 0.5 * p.s : 20;
    const D = (q) => a - 0.5 * q;
    const MR = (q) => a - q;
    const MC = (q) => p.mc0 + 0.25 * q;
    const ATC = (q) => p.fc / q + p.mc0 + 0.125 * q;
    const qm = Math.max(0, (a - p.mc0) / 1.25);
    const qc = Math.max(0, (a - p.mc0) / 0.75);
    const perfect = p.kind === 'mono' && p.pd === 'perfect';
    const q = perfect ? qc : qm;
    const pm = D(qm);
    const atc = q > 0 ? ATC(q) : NaN;
    const profit = perfect ? integ((x) => D(x) - MC(x), 0, qc) - p.fc : (pm - ATC(qm)) * qm;
    return {
      a, D, MR, MC, ATC, qm, qc, q, pm, atc, profit, perfect,
      cs: perfect ? 0 : 0.5 * (a - pm) * qm,
      dwl: perfect ? 0 : 0.5 * (qc - qm) * (pm - MC(qm)),
      qMinATC: Math.sqrt(p.fc / 0.125),
    };
  }
  /** The demand shift at which a monopolistic competitor just breaks even. */
  const monoZeroProfitShift = (p) => 2 * (20 - (p.mc0 + Math.sqrt(p.fc / 0.4)));

  define({
    key: 'monopoly',
    unit: 4,
    name: 'Monopoly and monopolistic competition',
    ced: 'CED Topics 4.2–4.4 · PRD-3.B, POL-2.B, POL-2.C',
    blurb: 'A firm with market power faces a downward-sloping demand curve, so MR is below demand. It produces where MR = MC and charges the price on the demand curve above that quantity.',
    exam: [
      'Draw D, MR, MC and ATC; find Q where MR = MC and P on the demand curve; shade profit or loss.',
      'Show the deadweight loss and compare with the perfectly competitive outcome (P = MC).',
      'Perfect price discrimination: the firm captures all consumer surplus and there is no deadweight loss.',
      'Monopolistic competition: in the long run entry shifts demand left until P = ATC, with zero economic profit, P > MC and excess capacity.',
    ],
    defaults: { kind: 'mono', pd: 'none', mc0: 2, fc: 20, s: 0, profitOn: true, cs: false, dwl: true, pc: false },
    controls: [
      { type: 'seg', k: 'kind', label: 'Market structure', opts: [['mono', 'Monopoly'], ['mc', 'Monopolistic competition']] },
      { type: 'seg', k: 'pd', label: 'Pricing', opts: [['none', 'One price'], ['perfect', 'Perfect price discrimination']], show: (p) => p.kind === 'mono' },
      { k: 'mc0', label: 'Marginal cost level', min: 0, max: 8, step: 0.5, fmt: (v) => money(v) },
      { k: 'fc', label: 'Fixed cost', min: 0, max: 60, step: 5, fmt: (v) => money(v, 0) },
      { k: 's', label: 'Entry shifts demand left by', min: -10, max: 30, step: 0.5, show: (p) => p.kind === 'mc', fmt: (v) => trim(v, 1) },
      {
        type: 'button', label: 'Let firms enter or exit (long run)', show: (p) => p.kind === 'mc',
        run: (p, api) => {
          const target = clamp(monoZeroProfitShift(p), -10, 30);
          api.animate((q) => {
            const d = target - q.s;
            if (Math.abs(d) < 0.15) { q.s = target; return false; }
            q.s += clamp(d, -1.2, 1.2);
            return true;
          });
        },
      },
      { type: 'toggle', k: 'profitOn', label: 'Shade profit or loss' },
      { type: 'toggle', k: 'cs', label: 'Shade consumer surplus', show: (p) => !(p.kind === 'mono' && p.pd === 'perfect') },
      { type: 'toggle', k: 'dwl', label: 'Shade deadweight loss', show: (p) => !(p.kind === 'mono' && p.pd === 'perfect') },
      { type: 'toggle', k: 'pc', label: 'Show the competitive output (P = MC)' },
    ],
    scenarios: [
      { name: 'Monopoly vs competition', ask: 'Compare the monopolist’s price and quantity with what a perfectly competitive industry would produce. Where is the deadweight loss?', set: { pc: true, dwl: true } },
      { name: 'Perfect price discrimination', ask: 'The monopolist can charge each buyer their maximum willingness to pay. What happens to output, consumer surplus and deadweight loss?', set: { pd: 'perfect' } },
      { name: 'Profit attracts entry', ask: 'A monopolistically competitive firm is earning economic profit. What happens in the long run to its demand curve, its profit, and its output?', set: (p) => ({ kind: 'mc', s: clamp(monoZeroProfitShift(p), -10, 30) }) },
    ],
    draw(p, K) {
      const m = monoCalc(p);
      const c = K.chart({ xmax: 45, ymax: 22, xlabel: 'Quantity', ylabel: 'Price, cost' });
      const mc = p.kind === 'mc';

      if (m.perfect) {
        c.area([[0, m.a], [m.qc, m.D(m.qc)], [m.qc, m.MC(m.qc)], [0, m.MC(0)]], 'profit', { label: 'Producer surplus' });
      } else {
        if (p.dwl && m.dwl > 0.01) c.area([[m.qm, m.pm], [m.qm, m.MC(m.qm)], [m.qc, m.MC(m.qc)]], 'dwl', { label: 'DWL' });
        if (p.cs && m.qm > 0) c.area([[0, m.a], [m.qm, m.pm], [0, m.pm]], 'cs', { label: 'CS' });
        if (p.profitOn && m.qm > 0) {
          const lo = Math.min(m.pm, m.atc);
          const hi = Math.max(m.pm, m.atc);
          c.area([[0, lo], [m.qm, lo], [m.qm, hi], [0, hi]], m.profit >= 0 ? 'profit' : 'loss', { label: m.profit >= 0 ? 'Profit' : 'Loss' });
        }
      }

      if (mc && p.s !== 0) c.curve((q) => 20 - 0.5 * q, 0, 40, 'd', { ghost: true, label: 'D_1', at: 32, dy: -9 });
      c.curve(m.D, 0, 45, 'd', { w: 3.5, label: mc && p.s !== 0 ? 'D_2' : 'D', at: Math.max(4, Math.min(2 * (m.a - 3), 40)), dy: -9, dx: 6 });
      if (!m.perfect) c.curve(m.MR, 0, 45, 'm', { w: 3.5, label: 'MR', at: Math.max(3, Math.min(m.a - 2, 42)), dy: 18, dx: 6 });
      c.curve(m.MC, 0, 45, 's', { w: 3.5, label: 'MC', at: 40, dy: -9 });
      c.curve(m.ATC, 1, 45, 'a', { w: 3.5, label: 'ATC', at: 40, dy: 20, n: 100 });

      if (p.pc && m.qc > 0) {
        c.dot(m.qc, m.MC(m.qc), 'g', { r: 5.5 });
        c.drop(m.qc, m.MC(m.qc), 'Q_C', null, { cls: 'g', only: 'x' });
        c.text(0, m.MC(m.qc), 'P_C', { cls: 'g', dx: -9, dy: 5, anchor: 'end', bold: true });
        c.seg(0, m.MC(m.qc), m.qc, m.MC(m.qc), 'g', { dash: true });
      }
      if (m.perfect) {
        c.dot(m.qc, m.D(m.qc), 'a', { r: 7 });
        c.drop(m.qc, m.D(m.qc), 'Q', 'P', { cls: 'k' });
      } else if (m.qm > 0) {
        c.dot(m.qm, m.MC(m.qm), 'm', { r: 5.5 });
        c.dot(m.qm, m.pm, 'a', { r: 7 });
        c.drop(m.qm, m.pm, 'Q_M', 'P_M', { cls: 'k' });
        c.dot(m.qm, m.atc, 'a', { r: 4.5 });
      }
      if (mc && m.qMinATC > m.qm) {
        c.drop(m.qMinATC, m.ATC(m.qMinATC), 'min ATC', null, { cls: 'g', only: 'x' });
        c.seg(m.qm, 0.9, m.qMinATC, 0.9, 'f', { w: 6 });
        c.text((m.qm + m.qMinATC) / 2, 0.9, 'Excess capacity', { cls: 'f', anchor: 'middle', dy: -10, bold: true, fixed: true });
      }

      const facts = [];
      if (m.perfect) {
        facts.push({ k: 'Output (D = MC)', v: trim(m.qc, 1) });
        facts.push({ sw: 'profit', k: 'Producer surplus', v: trim(integ((x) => m.D(x) - m.MC(x), 0, m.qc), 1) });
        facts.push({ sw: m.profit >= 0 ? 'profit' : 'loss', k: 'Profit (after fixed cost)', v: money(m.profit, 1) });
        facts.push({ sw: 'dwl', k: 'Deadweight loss', v: '0' });
      } else {
        facts.push({ k: 'Output (MR = MC)', v: trim(m.qm, 2) });
        facts.push({ sw: 'a', k: 'Price', v: money(m.pm) });
        facts.push({ k: 'ATC at that output', v: money(m.atc) });
        facts.push({ sw: m.profit >= 0 ? 'profit' : 'loss', k: 'Economic profit', v: money(m.profit, 1) });
        facts.push({ sw: 'cs', k: 'Consumer surplus', v: trim(m.cs, 1) });
        facts.push({ sw: 'dwl', k: 'Deadweight loss', v: trim(m.dwl, 1) });
        if (p.pc) facts.push({ k: 'Competitive output', v: trim(m.qc, 1) });
      }
      const say = [];
      if (m.perfect) say.push('With perfect price discrimination the firm sells every unit where demand is at least MC, so it produces the competitive output, takes all the surplus, and there is no deadweight loss.');
      else {
        say.push(`The firm produces where MR = MC (${trim(m.qm, 1)} units) and charges ${money(m.pm)} from the demand curve. Because P is above MR = MC, it produces less than the competitive output (${trim(m.qc, 1)}), which is the deadweight loss.`);
        if (mc) {
          if (Math.abs(m.profit) < 0.1) say.push('Demand is tangent to ATC: P = ATC, zero economic profit, so there is no more entry. P is above MC, and output is below the point of minimum ATC, which is excess capacity.');
          else if (m.profit > 0) say.push('Economic profit attracts new firms. Their products take sales away, so each firm’s demand shifts left until profit is zero.');
          else say.push('Losses push firms out, which shifts the remaining firms’ demand right until profit is zero.');
        }
      }
      return { charts: [c], facts, say: say.join(' ') };
    },
  });

  // ---- natural monopoly --------------------------------------------------

  function naturalCalc(p) {
    const a = 20;
    const D = (q) => a - 0.5 * q;
    const MR = (q) => a - q;
    const ATC = (q) => p.c + p.F / q;
    const qU = Math.max(0, a - p.c);
    const disc = (a - p.c) ** 2 - 2 * p.F;
    const qF = disc >= 0 ? (a - p.c) + Math.sqrt(disc) : NaN;
    const qS = 2 * (a - p.c);
    const q = p.reg === 'fair' ? qF : p.reg === 'optimal' ? qS : qU;
    const price = fin(q) ? D(q) : NaN;
    const profit = fin(q) ? (price - ATC(q)) * q : NaN;
    const dwl = fin(q) ? 0.5 * (qS - q) * (price - p.c) : NaN;
    return { a, D, MR, ATC, qU, qF, qS, q, price, profit, dwl };
  }

  define({
    key: 'natural',
    unit: 4,
    name: 'Natural monopoly and regulation',
    ced: 'CED Topic 4.2 · PRD-3.B, POL-2.B, POL-2.C',
    blurb: 'When fixed costs are huge, ATC keeps falling over the whole market, so one firm is the cheapest way to serve it. Regulators can pick a price, but each choice has a cost.',
    exam: [
      'Draw a natural monopoly: ATC still falling where it meets demand, with MC below ATC.',
      'Unregulated, the firm sets MR = MC and earns a profit. Under a fair-return price (P = ATC) profit is zero but some deadweight loss remains.',
      'The socially optimal price (P = MC) removes the deadweight loss but the firm loses money, so it needs a subsidy.',
    ],
    defaults: { c: 3, F: 60, reg: 'none', profitOn: true, dwlOn: true },
    controls: [
      { type: 'seg', k: 'reg', label: 'Regulation', opts: [['none', 'Unregulated'], ['fair', 'Fair return (P = ATC)'], ['optimal', 'Socially optimal (P = MC)']] },
      { k: 'c', label: 'Marginal cost', min: 1, max: 8, step: 0.5, fmt: (v) => money(v) },
      { k: 'F', label: 'Fixed cost', min: 20, max: 120, step: 10, fmt: (v) => money(v, 0) },
      { type: 'toggle', k: 'profitOn', label: 'Shade profit or loss' },
      { type: 'toggle', k: 'dwlOn', label: 'Shade deadweight loss' },
    ],
    scenarios: [
      { name: 'Unregulated natural monopoly', ask: 'Where does an unregulated natural monopoly produce, what price does it charge, and is there a deadweight loss?', set: { reg: 'none' } },
      { name: 'Regulate to P = ATC', ask: 'Regulators force the price down to average total cost. What happens to profit, output and deadweight loss?', set: { reg: 'fair' } },
      { name: 'Regulate to P = MC', ask: 'Regulators set the price equal to marginal cost. Why might the firm leave the market?', set: { reg: 'optimal' } },
    ],
    draw(p, K) {
      const m = naturalCalc(p);
      const c = K.chart({ xmax: 45, ymax: 22, xlabel: 'Quantity', ylabel: 'Price, cost' });
      if (fin(m.q) && m.q > 0) {
        if (p.dwlOn && m.dwl > 0.01) c.area([[m.q, m.price], [m.q, p.c], [m.qS, p.c]], 'dwl', { label: 'DWL' });
        if (p.profitOn) {
          const atc = m.ATC(m.q);
          const lo = Math.min(m.price, atc);
          const hi = Math.max(m.price, atc);
          if (hi - lo > 0.01) c.area([[0, lo], [m.q, lo], [m.q, hi], [0, hi]], m.profit >= 0 ? 'profit' : 'loss', { label: m.profit >= 0 ? 'Profit' : 'Loss' });
        }
      }
      c.curve(m.D, 0, 45, 'd', { w: 3.5, label: 'D', at: 33, dy: -9 });
      c.curve(m.MR, 0, 45, 'm', { w: 3.5, label: 'MR', at: 17, dy: 18, dx: 6 });
      c.seg(0, p.c, 45, p.c, 's', { w: 3.5, label: 'MC', dx: -6, dy: -9, anchor: 'end' });
      c.curve(m.ATC, 1.5, 45, 'a', { w: 3.5, label: 'ATC', at: 40, dy: -10, n: 100 });
      if (fin(m.q) && m.q > 0) {
        c.dot(m.q, m.price, 'a', { r: 7 });
        c.drop(m.q, m.price, 'Q', 'P', { cls: 'k' });
        if (p.reg === 'none') c.dot(m.q, p.c, 'm', { r: 5.5 });
      }
      const facts = [];
      const say = [];
      if (!fin(m.q)) {
        facts.push({ k: 'P = ATC', v: 'no output covers cost' });
        say.push('With this much fixed cost, demand never reaches ATC, so no price covers the firm’s costs: it would not serve the market unless it were subsidized.');
      } else {
        facts.push({ k: 'Output', v: trim(m.q, 1) });
        facts.push({ sw: 'a', k: 'Price', v: money(m.price) });
        facts.push({ sw: m.profit >= 0 ? 'profit' : 'loss', k: 'Economic profit', v: money(m.profit, 1) });
        facts.push({ sw: 'dwl', k: 'Deadweight loss', v: trim(m.dwl, 1) });
        say.push(p.reg === 'none' ? 'Unregulated, the firm sets MR = MC, charges the price on the demand curve above that, and earns a profit; output is below the efficient level.'
          : p.reg === 'fair' ? 'At P = ATC the firm breaks even (zero economic profit). Output rises but is still below the efficient level, so some deadweight loss remains.'
            : 'At P = MC the market is efficient, with no deadweight loss. But price is below ATC, so the firm loses its fixed cost and needs a subsidy to stay open.');
      }
      return { charts: [c], facts, say: say.join(' ') };
    },
  });

  // ---- game theory --------------------------------------------------------

  /**
   * Analyse a 2x2 normal-form game. pay is [r00, c00, r01, c01, r10, c10,
   * r11, c11]: for the cell in row i and column j the first number is the row
   * player's payoff and the second the column player's.
   */
  function analyseGame(pay) {
    const R = (i, j) => pay[(i * 2 + j) * 2];
    const Cc = (i, j) => pay[(i * 2 + j) * 2 + 1];
    const brRow = [0, 1].map((j) => { const a = R(0, j); const b = R(1, j); return a > b ? [0] : b > a ? [1] : [0, 1]; });
    const brCol = [0, 1].map((i) => { const a = Cc(i, 0); const b = Cc(i, 1); return a > b ? [0] : b > a ? [1] : [0, 1]; });
    const nash = [];
    for (let i = 0; i < 2; i += 1) for (let j = 0; j < 2; j += 1) if (brRow[j].includes(i) && brCol[i].includes(j)) nash.push([i, j]);
    const domRow = [0, 1].find((i) => R(i, 0) > R(1 - i, 0) && R(i, 1) > R(1 - i, 1));
    const domCol = [0, 1].find((j) => Cc(0, j) > Cc(0, 1 - j) && Cc(1, j) > Cc(1, 1 - j));
    let dilemma = false;
    if (nash.length === 1) {
      const [ni, nj] = nash[0];
      for (let i = 0; i < 2; i += 1) for (let j = 0; j < 2; j += 1) if (R(i, j) > R(ni, nj) && Cc(i, j) > Cc(ni, nj)) dilemma = true;
    }
    return { R, C: Cc, brRow, brCol, nash, domRow, domCol, dilemma };
  }

  define({
    key: 'game',
    unit: 4,
    name: 'Game theory matrix',
    ced: 'CED Topic 4.5 · PRD-3.C',
    blurb: 'Each cell shows (row player’s payoff, column player’s payoff). A dominant strategy is best whatever the other player does; a Nash equilibrium is a cell where neither player can do better by switching alone. Everything is editable.',
    exam: [
      'Read a two-player, two-strategy payoff matrix.',
      'Find a dominant strategy for each player, if there is one.',
      'Find the Nash equilibrium: each player’s strategy is the best response to the other’s.',
      'Larger games and mixed strategies are outside the course.',
    ],
    noNumbers: true,
    defaults: {
      rn: 'Firm A', cn: 'Firm B', r1: 'Low price', r2: 'High price', c1: 'Low price', c2: 'High price',
      pay: [5, 5, 15, 2, 2, 15, 10, 10], br: false, ne: false,
    },
    controls: [
      { type: 'toggle', k: 'br', label: 'Mark each player’s best responses' },
      { type: 'toggle', k: 'ne', label: 'Mark the Nash equilibrium' },
    ],
    scenarios: [
      {
        name: 'Both firms: lower the price?',
        ask: 'Each firm can charge a low or a high price. Does either have a dominant strategy? What is the Nash equilibrium, and would both be better off somewhere else?',
        setup: { br: false, ne: false },
        set: { br: true, ne: true },
      },
      {
        name: 'Pricing and advertising',
        ask: 'Company B chooses whether to advertise; Company A chooses whether to raise its price. Payoffs are (B, A). Find any dominant strategies and the Nash equilibria.',
        setup: {
          rn: 'Company B', cn: 'Company A', r1: 'Advertise', r2: 'Not advertise', c1: 'Keep price the same', c2: 'Raise price',
          pay: [50, -2, 175, 0, 150, 15, 100, 0], br: false, ne: false,
        },
        set: { br: true, ne: true },
      },
      {
        name: 'Only one dominant strategy',
        ask: 'Does either player have a dominant strategy? How does the other player respond to it?',
        setup: {
          rn: 'Row', cn: 'Column', r1: 'Up', r2: 'Down', c1: 'Left', c2: 'Right',
          pay: [3, 1, 4, 0, 1, 0, 2, 3], br: false, ne: false,
        },
        set: { br: true, ne: true },
      },
      {
        name: 'Coordination game',
        ask: 'Two firms choose between two standards. Is there a dominant strategy? How many Nash equilibria are there?',
        setup: {
          rn: 'Firm A', cn: 'Firm B', r1: 'Standard 1', r2: 'Standard 2', c1: 'Standard 1', c2: 'Standard 2',
          pay: [5, 5, 0, 0, 0, 0, 3, 3], br: false, ne: false,
        },
        set: { br: true, ne: true },
      },
      {
        name: 'No equilibrium in pure strategies',
        ask: 'One player wants to match, the other wants to mismatch. Is there a cell where neither wants to switch?',
        setup: {
          rn: 'Matcher', cn: 'Mismatcher', r1: 'Heads', r2: 'Tails', c1: 'Heads', c2: 'Tails',
          pay: [1, -1, -1, 1, -1, 1, 1, -1], br: false, ne: false,
        },
        set: { br: true, ne: true },
      },
    ],
    build(host, p, api) {
      const text = (key, cls) => el('input.input.ec-gname' + (cls ? `.${cls}` : ''), {
        type: 'text', maxlength: 28, 'aria-label': key,
        oninput: (e) => { p[key] = e.target.value.slice(0, 28); api.refresh(); api.save(); },
      });
      const num = (i, cls) => el('input.input.ec-pay.' + cls, {
        type: 'number', step: 1, 'aria-label': `Payoff ${i}`,
        oninput: (e) => { const v = parseFloat(e.target.value); p.pay[i] = fin(v) ? v : 0; api.refresh(); api.save(); },
      });
      const nameIn = { rn: text('rn', 'is-row'), cn: text('cn', 'is-col'), r1: text('r1'), r2: text('r2'), c1: text('c1'), c2: text('c2') };
      const pays = [];
      const cells = [];
      const body = el('tbody');
      for (let i = 0; i < 2; i += 1) {
        const tr = el('tr');
        tr.append(el('th.ec-gside', {}, nameIn[i ? 'r2' : 'r1']));
        for (let j = 0; j < 2; j += 1) {
          const rI = num((i * 2 + j) * 2, 'is-row');
          const cI = num((i * 2 + j) * 2 + 1, 'is-col');
          pays[(i * 2 + j) * 2] = rI;
          pays[(i * 2 + j) * 2 + 1] = cI;
          const td = el('td.ec-gcell', {}, [el('span.ec-paren', { text: '(' }), rI, el('span.ec-paren', { text: ',' }), cI, el('span.ec-paren', { text: ')' })]);
          cells.push(td);
          tr.append(td);
        }
        body.append(tr);
      }
      const table = el('table.ec-matrix', {}, [
        el('thead', {}, [
          el('tr', {}, [el('th'), el('th.ec-gtop', { colspan: 2 }, [el('span.ec-gwho', { text: 'Column player: ' }), nameIn.cn])]),
          el('tr', {}, [el('th', {}, [el('span.ec-gwho', { text: 'Row player' }), nameIn.rn]), el('th.ec-gcol', {}, nameIn.c1), el('th.ec-gcol', {}, nameIn.c2)]),
        ]),
        body,
      ]);
      host.append(el('div.ec-tablewrap', {}, [table, el('p.hint.ec-gnote', { text: 'Each cell is (row player’s payoff, column player’s payoff).' })]));

      return {
        update(q) {
          for (const k of Object.keys(nameIn)) if (document.activeElement !== nameIn[k]) nameIn[k].value = q[k];
          pays.forEach((inp, i) => { if (document.activeElement !== inp) inp.value = q.pay[i]; });
          const g = analyseGame(q.pay);
          const rowName = (i) => q[i ? 'r2' : 'r1'] || `Row ${i + 1}`;
          const colName = (j) => q[j ? 'c2' : 'c1'] || `Column ${j + 1}`;
          cells.forEach((td, k) => {
            const i = k >> 1;
            const j = k & 1;
            td.classList.toggle('is-nash', !!q.ne && g.nash.some(([a, b]) => a === i && b === j));
            pays[k * 2].classList.toggle('is-br', !!q.br && g.brRow[j].includes(i));
            pays[k * 2 + 1].classList.toggle('is-br', !!q.br && g.brCol[i].includes(j));
          });
          const facts = [];
          if (q.br) {
            facts.push({ sw: 'd', k: `${q.rn || 'Row'}: dominant strategy`, v: g.domRow == null ? 'none' : rowName(g.domRow) });
            facts.push({ sw: 's', k: `${q.cn || 'Column'}: dominant strategy`, v: g.domCol == null ? 'none' : colName(g.domCol) });
          }
          if (q.ne) {
            if (g.nash.length) for (const [i, j] of g.nash) facts.push({ sw: 'a', k: 'Nash equilibrium', v: `${rowName(i)} / ${colName(j)}` });
            else facts.push({ k: 'Nash equilibrium', v: 'none in pure strategies' });
          }
          let say = 'Edit any payoff or name. Underlined payoffs are best responses; a cell where both are underlined is a Nash equilibrium.';
          if (q.ne) {
            if (!g.nash.length) say = 'There is no cell where both players are best-responding, so there is no Nash equilibrium in pure strategies (mixed strategies are outside the course).';
            else if (g.nash.length > 1) say = 'There is more than one Nash equilibrium, so the outcome depends on what the players expect of each other.';
            else if (g.dilemma) say = 'There is one Nash equilibrium, but another cell would give both players more: each has an incentive to deviate from it, so they end up worse off (a prisoner’s dilemma).';
            else say = 'There is one Nash equilibrium: neither player can do better by changing strategy alone.';
          }
          api.facts(facts);
          api.say(say);
        },
      };
    },
  });

  // =================================================================
  // UNIT 5 — Factor Markets
  // =================================================================

  define({
    key: 'labor',
    unit: 5,
    name: 'Labor market',
    ced: 'CED Topics 5.1–5.2 · PRD-4.A, PRD-4.B, PRD-4.C, POL-4.A',
    blurb: 'Firms demand labor and workers supply it, so the wage and employment are set where the two meet. Demand for labor is derived from demand for the product.',
    exam: [
      'Draw the labor market with the wage on the vertical axis and the quantity of labor on the horizontal axis.',
      'Shift labor demand (product price, productivity, prices of other inputs) and labor supply (population, alternative wages, preferences) and show the new wage and employment.',
      'Show a minimum wage above equilibrium as a price floor: more people want to work than firms will hire.',
    ],
    defaults: { d: 0, s: 0, mode: 'free', lvl: 7, cs: false, ps: false, dwl: true },
    controls: [
      { head: 'Shift the curves' },
      { k: 'd', label: 'Labor demand', min: -30, max: 30, step: 5, fmt: (v) => (v === 0 ? 'no change' : v > 0 ? `increase ${v}` : `decrease ${-v}`) },
      { k: 's', label: 'Labor supply', min: -30, max: 30, step: 5, fmt: (v) => (v === 0 ? 'no change' : v > 0 ? `increase ${v}` : `decrease ${-v}`) },
      { head: 'Government' },
      { type: 'seg', k: 'mode', label: 'Policy', opts: [['free', 'None'], ['floor', 'Minimum wage']], on: (p, v) => { if (v === 'floor') p.lvl = 7; } },
      { k: 'lvl', label: 'Minimum wage', min: 1, max: 10, step: 0.5, show: (p) => p.mode === 'floor', fmt: (v) => money(v) },
      { head: 'Show' },
      { type: 'toggle', k: 'cs', label: 'Surplus to employers' },
      { type: 'toggle', k: 'ps', label: 'Surplus to workers' },
      { type: 'toggle', k: 'dwl', label: 'Deadweight loss' },
    ],
    scenarios: [
      { name: 'Demand for the product rises', ask: 'Demand for the firms’ product rises. What happens to the demand for labor, the wage and employment?', set: { d: 20 } },
      { name: 'Workers become more productive', ask: 'Training makes each worker more productive. What happens to labor demand, the wage and employment?', set: { d: 20 } },
      { name: 'More people enter the labor force', ask: 'Immigration increases the number of people looking for work. What happens to the wage and employment?', set: { s: 20 } },
      { name: 'Other jobs start paying more', ask: 'Workers can now earn more in other industries. What happens in this labor market?', set: { s: -20 } },
      { name: 'A minimum wage above equilibrium', ask: 'The government sets a minimum wage above the equilibrium wage in a competitive labor market. What happens to employment?', set: { mode: 'floor', lvl: 7, dwl: true } },
    ],
    drag: marketDrag,
    draw: (p, K) => drawMarket(p, K, 'labor'),
  });

  // ---- a firm in a perfectly competitive factor market ----------------

  const FIRMS = 10;
  function factorCalc(p) {
    const pi = p.pi;
    const D = (L) => pi * (18 - 0.02 * L);
    const S = (L) => 2 + 0.02 * (L - p.s);
    const Le = (18 * pi - 2 + 0.02 * p.s) / (0.02 * (1 + pi));
    const We = D(Le);
    const MRP = (l) => pi * (18 - 0.2 * l);
    return { D, S, Le, We, MRP, lf: Math.max(0, 5 * (18 - We / pi)) };
  }

  define({
    key: 'firmfactor',
    unit: 5,
    name: 'Firm in a competitive labor market',
    ced: 'CED Topic 5.3 · CBA-2.D, PRD-4.A–C, POL-2.A',
    blurb: 'The market sets the wage; the firm takes it as given. It hires workers up to the point where the extra revenue from the last worker (MRP) equals the wage (MFC).',
    exam: [
      'Draw the market and the firm side by side, with the firm’s MFC = W as a horizontal line.',
      'Hire where MRP = MFC (the profit-maximizing level of employment).',
      'MRP = MP × MR (or price): a change in productivity or in the output price shifts MRP, which is the firm’s labor demand curve.',
    ],
    defaults: { pi: 1, s: 0, areas: false },
    controls: [
      { k: 'pi', label: 'Output price or productivity', min: 0.7, max: 1.3, step: 0.05, fmt: (v) => (v === 1 ? 'unchanged' : `${v > 1 ? '+' : '−'}${trim(Math.abs(v - 1) * 100, 0)}%`) },
      { k: 's', label: 'Labor supply (market)', min: -200, max: 200, step: 50, fmt: (v) => (v === 0 ? 'no change' : v > 0 ? `increase ${v}` : `decrease ${-v}`) },
      { type: 'toggle', k: 'areas', label: 'Shade the wage bill and the gain' },
    ],
    scenarios: [
      { name: 'The price of the product rises', ask: 'The price of what the firm sells rises. What happens to MRP, the market wage and the number of workers this firm hires?', set: { pi: 1.2 } },
      { name: 'The price of the product falls', ask: 'The price of what the firm sells falls. What happens to MRP, the wage and employment?', set: { pi: 0.8 } },
      { name: 'More workers in the market', ask: 'Labor supply increases. What happens to the wage, and to how many workers each firm hires?', set: { s: 200 } },
    ],
    draw(p, K) {
      const m = factorCalc(p);
      const base = factorCalc({ pi: 1, s: 0 });
      const moved = p.pi !== 1;
      const sMoved = p.s !== 0;
      const mk = K.chart({ title: 'Labor market', xmax: 800, ymax: 24, xlabel: 'Quantity of labor', ylabel: 'Wage' });
      if (moved) mk.curve(base.D, 0, 800, 'd', { ghost: true, label: 'D_1', at: 640, dy: -9 });
      if (sMoved) mk.curve(base.S, 0, 800, 's', { ghost: true, label: 'S_1', at: 700, dy: -9 });
      mk.curve(m.D, 0, 900, 'd', { w: 3.5, label: moved ? 'D_2' : 'D', at: Math.min(780, 20 / 0.02 * 0.82), dy: -9 });
      mk.curve(m.S, 0, 900, 's', { w: 3.5, label: sMoved ? 'S_2' : 'S', at: 760, dy: -9 });
      if (moved || sMoved) { mk.drop(base.Le, base.We, 'L_1', 'W_1', { cls: 'g' }); mk.dot(base.Le, base.We, 'g', { r: 4.5 }); }
      mk.drop(m.Le, m.We, moved || sMoved ? 'L_2' : 'L_M', moved || sMoved ? 'W_2' : 'W_M', { cls: 'k' });
      mk.dot(m.Le, m.We, 'a', { r: 7 });

      const fm = K.chart({ title: 'A typical firm', xmax: 100, ymax: 24, xlabel: 'Quantity of labor', ylabel: 'Wage' });
      if (p.areas) {
        fm.area([[0, 0], [m.lf, 0], [m.lf, m.We], [0, m.We]], 'rev', { label: 'Wage bill' });
        fm.area([[0, m.MRP(0)], [m.lf, m.We], [0, m.We]], 'profit', { label: 'Gain' });
      }
      if (moved) fm.curve((l) => base.MRP(l), 0, 100, 'd', { ghost: true, label: 'MRP_1', at: 70, dy: -9 });
      fm.curve(m.MRP, 0, 100, 'd', { w: 3.5, label: moved ? 'MRP_2' : 'MRP_L', at: Math.min(88, 5 * (18 * p.pi - 1.2) * 0.85), dy: -9 });
      if (m.We !== base.We) fm.seg(0, base.We, 100, base.We, 'g', { ghost: true });
      fm.seg(0, m.We, 100, m.We, 's', { w: 3.5, label: 'MFC = W', dx: -4, dy: -9, anchor: 'end' });
      fm.drop(m.lf, m.We, 'L_F', 'W_F', { cls: 'k' });
      fm.dot(m.lf, m.We, 'a', { r: 7 });

      const facts = [
        { sw: 'a', k: 'Market wage', v: money(m.We) },
        { k: 'Market employment', v: trim(m.Le, 0) },
        { k: `This firm hires (1 of ${FIRMS})`, v: trim(m.lf, 1) },
        { sw: 'rev', k: 'Firm’s wage bill', v: money(m.lf * m.We, 0) },
        { k: 'MRP of the last worker', v: money(m.MRP(m.lf)) },
      ];
      const say = ['The firm hires until MRP = MFC = W: a worker is worth hiring while the extra revenue they bring in is at least the wage.'];
      if (moved) say.push(`The output price or productivity ${p.pi > 1 ? 'rises' : 'falls'}, so MRP shifts ${p.pi > 1 ? 'right' : 'left'} in both graphs; the wage ${moves(base.We, m.We)} and employment ${moves(base.Le, m.Le)}.`);
      if (sMoved) say.push(`Labor supply ${p.s > 0 ? 'increases' : 'decreases'}, so the wage ${moves(base.We, m.We)}; each firm moves along its own MRP curve and hires ${moves(base.lf, m.lf) === 'is unchanged' ? 'the same number' : `${moves(base.lf, m.lf) === 'rises' ? 'more' : 'fewer'} workers`}.`);
      return { charts: [mk, fm], facts, say: say.join(' ') };
    },
  });

  // ---- monopsony ---------------------------------------------------------

  function monopsonyCalc(p) {
    const S = (l) => 2 + 0.02 * l;
    const MFC = (l) => 2 + 0.04 * l;
    const MRP = (l) => 18 - 0.02 * l;
    const Lm = 16 / 0.06;
    const Wm = S(Lm);
    const Lc = 400;
    const Wc = 10;
    const r = { S, MFC, MRP, Lm, Wm, Lc, Wc, L: Lm, W: Wm, binding: false, unemployed: 0, Ls: 0, Ld: 0 };
    if (p.wmin > Wm + 1e-9) {
      r.binding = true;
      r.Ls = (p.wmin - 2) / 0.02;
      r.Ld = (18 - p.wmin) / 0.02;
      r.L = Math.max(0, Math.min(r.Ls, r.Ld));
      r.W = p.wmin;
      r.unemployed = Math.max(0, r.Ls - r.Ld);
    }
    r.dwl = r.L < Lc ? integ((l) => MRP(l) - S(l), r.L, Lc) : 0;
    return r;
  }

  define({
    key: 'monopsony',
    unit: 5,
    name: 'Monopsony',
    ced: 'CED Topic 5.4 · PRD-4.D, POL-2.B, POL-2.C',
    blurb: 'A single large employer faces the whole labor supply curve. To hire one more worker it must raise the wage for everyone, so MFC is above supply. It hires where MRP = MFC, and pays the wage on the supply curve at that quantity.',
    exam: [
      'Draw S, MFC (above S) and MRP; hire where MRP = MFC; read the wage from the supply curve.',
      'Compared with a competitive labor market, a monopsony hires fewer workers and pays a lower wage.',
      'A minimum wage between the monopsony wage and the competitive wage can raise both wages and employment.',
    ],
    defaults: { wmin: 0, comp: true, dwl: true },
    controls: [
      { k: 'wmin', label: 'Minimum wage', min: 0, max: 14, step: 0.5, fmt: (v) => (v === 0 ? 'none' : money(v)) },
      { type: 'toggle', k: 'comp', label: 'Show the competitive outcome' },
      { type: 'toggle', k: 'dwl', label: 'Shade the deadweight loss' },
    ],
    scenarios: [
      { name: 'Monopsony vs competition', ask: 'Compare the number of workers hired and the wage paid by a monopsony with a competitive labor market.', set: { comp: true } },
      { name: 'A modest minimum wage', ask: 'The government sets a minimum wage of $9, between the monopsony wage and the competitive wage. What happens to employment?', set: { wmin: 9 } },
      { name: 'A high minimum wage', ask: 'Now the minimum wage is raised to $13. What happens to employment, and why is this different?', set: { wmin: 13 } },
    ],
    draw(p, K) {
      const m = monopsonyCalc(p);
      const c = K.chart({ xmax: 800, ymax: 20, xlabel: 'Quantity of labor', ylabel: 'Wage' });
      if (p.dwl && m.dwl > 0.5) c.area([[m.L, m.MRP(m.L)], [m.L, m.S(m.L)], [m.Lc, m.Wc]], 'dwl', { label: 'DWL' });
      c.curve(m.MRP, 0, 800, 'd', { w: 3.5, label: 'MRP_L = D', at: 700, dy: -9, anchor: 'end' });
      c.curve(m.S, 0, 800, 's', { w: 3.5, label: 'S', at: 760, dy: 20 });
      c.curve(m.MFC, 0, 400, 'v', { w: 3.5, label: 'MFC', at: 385, dy: -10, dx: 6 });
      if (m.binding) {
        c.seg(0, p.wmin, m.Ls, p.wmin, 'f', { w: 4.5 });
        c.seg(m.Ls, p.wmin, m.Ls, m.MFC(m.Ls), 'f', { dash: true, w: 2.5 });
        c.text(m.Ls * 0.5, p.wmin, 'Minimum wage', { cls: 'f', anchor: 'middle', dy: -9, bold: true });
      }
      if (p.comp) { c.dot(m.Lc, m.Wc, 'g', { r: 5 }); c.drop(m.Lc, m.Wc, 'L_C', 'W_C', { cls: 'g' }); }
      if (m.binding) {
        c.dot(m.L, m.W, 'a', { r: 7 });
        c.drop(m.L, m.W, 'L', 'W', { cls: 'k' });
      } else {
        c.dot(m.Lm, m.MFC(m.Lm), 'v', { r: 5.5 });
        c.dot(m.Lm, m.Wm, 'a', { r: 7 });
        c.drop(m.Lm, m.Wm, 'L_M', 'W_M', { cls: 'k' });
      }
      const facts = [];
      if (m.binding) {
        facts.push({ sw: 'a', k: 'Wage with minimum wage', v: money(m.W) });
        facts.push({ k: 'Workers hired', v: trim(m.L, 0) });
        if (m.unemployed > 1) facts.push({ k: 'Unemployed', v: trim(m.unemployed, 0) });
      } else {
        facts.push({ sw: 'a', k: 'Monopsony wage', v: money(m.Wm) });
        facts.push({ k: 'Workers hired', v: trim(m.Lm, 0) });
        facts.push({ k: 'MRP of the last worker', v: money(m.MRP(m.Lm)) });
      }
      if (p.comp) {
        facts.push({ sw: 'g', k: 'Competitive wage', v: money(m.Wc) });
        facts.push({ k: 'Competitive employment', v: trim(m.Lc, 0) });
      }
      if (m.dwl > 0.5) facts.push({ sw: 'dwl', k: 'Deadweight loss', v: trim(m.dwl, 0) });
      const say = [];
      if (!m.binding) say.push(`The monopsonist hires where MRP = MFC (${trim(m.Lm, 0)} workers), then pays only the wage the supply curve requires for that many workers (${money(m.Wm)}), which is less than the worker’s MRP (${money(m.MRP(m.Lm))}).`);
      else if (p.wmin <= m.Wc + 1e-9) say.push('The minimum wage makes MFC flat at the minimum wage up to the quantity workers will supply at that wage. The monopsonist now hires more workers at a higher wage: this wage floor raises employment.');
      else say.push('The minimum wage is now above the competitive wage, so the quantity of labor firms want falls below the quantity workers supply: employment falls and there is unemployment.');
      return { charts: [c], facts, say: say.join(' ') };
    },
  });

  // =================================================================
  // UNIT 6 — Market Failure and the Role of Government
  // =================================================================

  /**
   * The five externality pictures from the CED. Each returns the private and
   * social benefit and cost curves, plus the market and socially optimal
   * outcomes. In the competitive pictures D = P = 10 - 0.1Q and S = 0.1Q.
   */
  function extCalc(p) {
    const e = p.e;
    const kind = p.kind;
    let MPB = (q) => 10 - 0.1 * q;
    let MSB = MPB;
    let MPC = (q) => 0.1 * q;
    let MSC = MPC;
    let MR = null;
    let xmax = 110;
    let ymax = 12;
    if (kind === 'negprod') MSC = (q) => 0.1 * q + e;
    else if (kind === 'posprod') MSC = (q) => 0.1 * q - e;
    else if (kind === 'negcons') MSB = (q) => 10 - 0.1 * q - e;
    else if (kind === 'poscons') MSB = (q) => 10 - 0.1 * q + e;
    else {
      MPB = (q) => 20 - 0.5 * q;
      MSB = MPB;
      MR = (q) => 20 - q;
      MPC = (q) => 2 + 0.25 * q;
      MSC = (q) => 2 + 0.25 * q + e;
      xmax = 45;
      ymax = 22;
    }
    const mono = kind === 'mono';
    // market outcome: where the PRIVATE curves meet (MR = MPC for a monopoly)
    const privateCost = p.policy ? MSC : MPC;
    const privateBenefit = p.policy ? MSB : MPB;
    const hi = xmax * 1.5;
    const Qm = solve((q) => (mono ? MR(q) : privateBenefit(q)) - privateCost(q), 0, hi);
    const Qs = solve((q) => MSB(q) - MSC(q), 0, hi);
    const Pm = mono ? MPB(Qm) : privateBenefit(Qm);
    const consumerSide = kind === 'negcons' || kind === 'poscons';
    const Ps = consumerSide ? MSC(Qs) : MSB(Qs);
    const dwl = Math.abs(integ((q) => MSB(q) - MSC(q), Math.min(Qm, Qs), Math.max(Qm, Qs)));
    return { MPB, MSB, MPC, MSC, MR, xmax, ymax, Qm, Qs, Pm, Ps, dwl, mono, consumerSide };
  }

  const EXT_KINDS = {
    negprod: { name: 'Negative production externality', cost: 'external cost', fix: 'a per-unit tax on producers', who: 'producers' },
    posprod: { name: 'Positive production externality', cost: 'external benefit', fix: 'a per-unit subsidy to producers', who: 'producers' },
    negcons: { name: 'Negative consumption externality', cost: 'external cost', fix: 'a per-unit tax on consumers', who: 'consumers' },
    poscons: { name: 'Positive consumption externality', cost: 'external benefit', fix: 'a per-unit subsidy to consumers', who: 'consumers' },
    mono: { name: 'Monopoly with a negative externality', cost: 'external cost', fix: 'a per-unit tax on the producer', who: 'the producer' },
  };

  define({
    key: 'externality',
    unit: 6,
    name: 'Externalities',
    ced: 'CED Topics 6.1–6.2, 6.4 · POL-2.A–C, POL-3.A–B',
    blurb: 'An externality is a cost or benefit that falls on people outside the transaction. The market follows the private curves, so it produces too much when there is an external cost and too little when there is an external benefit.',
    exam: [
      'Draw all four externality graphs in a competitive market, with MPB, MSB, MPC and MSC labeled.',
      'Identify the market quantity and the socially optimal quantity, and the deadweight loss between them.',
      'Show how a tax or subsidy equal to the externality moves the market to the socially optimal quantity.',
      'In an imperfectly competitive market the monopolist uses MR = MPC, so the market quantity can be above or below Q_S.',
    ],
    defaults: { kind: 'negprod', e: 2, policy: false, dwlOn: true },
    controls: [
      {
        type: 'seg', k: 'kind', label: 'Type of externality',
        opts: [['negprod', 'Negative production'], ['posprod', 'Positive production'], ['negcons', 'Negative consumption'], ['poscons', 'Positive consumption'], ['mono', 'Monopoly + negative']],
      },
      { k: 'e', label: 'Size of the externality per unit', min: 0, max: 8, step: 0.5, fmt: (v) => money(v) },
      { type: 'toggle', k: 'policy', label: 'Apply the tax or subsidy that fixes it' },
      { type: 'toggle', k: 'dwlOn', label: 'Shade the deadweight loss' },
    ],
    scenarios: [
      { name: 'A factory pollutes a river', ask: 'A factory’s production pollutes the river. Is the market quantity too high or too low? Show the deadweight loss.', set: { kind: 'negprod', e: 2 } },
      { name: 'Smoking', ask: 'Smoking imposes costs on bystanders. Which curve is shifted, and is the market quantity too high or too low?', set: { kind: 'negcons', e: 2 } },
      { name: 'Vaccinations', ask: 'Each vaccination protects other people too. Draw the externality and say whether the market quantity is too high or too low.', set: { kind: 'poscons', e: 2 } },
      { name: 'A firm’s research spills over', ask: 'Other firms learn from a company’s research without paying for it. Show the effect on output and say what policy could help.', set: { kind: 'posprod', e: 2 } },
      { name: 'A polluting monopolist', ask: 'A monopolist pollutes. Is its output above or below the socially optimal quantity?', set: { kind: 'mono', e: 2 } },
      { name: 'Fix it with a tax or subsidy', ask: 'What per-unit tax or subsidy would make the market produce the socially optimal quantity?', set: { policy: true } },
    ],
    draw(p, K) {
      const m = extCalc(p);
      const k = EXT_KINDS[p.kind];
      const c = K.chart({ xmax: m.xmax, ymax: m.ymax, xlabel: 'Quantity', ylabel: 'Price, cost, benefit' });
      const mono = m.mono;
      const span = m.xmax;
      const sameB = p.kind === 'negprod' || p.kind === 'posprod' || mono;
      const sameC = p.kind === 'negcons' || p.kind === 'poscons';

      if (p.dwlOn && m.dwl > 0.01) {
        const sbQm = m.MSB(m.Qm);
        const scQm = m.MSC(m.Qm);
        c.area([[m.Qs, m.consumerSide ? m.Ps : m.Ps], [m.Qm, sbQm], [m.Qm, scQm]], 'dwl', { label: 'DWL' });
      }
      c.curve(m.MPB, 0, span * 1.4, 'd', { w: 3.5, label: sameB ? (mono ? 'D = MPB = MSB' : 'MPB = MSB') : 'MPB', at: span * (mono ? 0.78 : 0.8), dy: -9 });
      if (!sameB) c.curve(m.MSB, 0, span * 1.4, 'v', { w: 3.5, label: 'MSB', at: span * (p.kind === 'poscons' ? 0.72 : 0.62), dy: p.kind === 'poscons' ? -12 : 22 });
      if (mono) c.curve(m.MR, 0, span * 1.4, 'm', { w: 3.5, label: 'MR', at: 17, dy: 18, dx: 6 });
      if (sameC) c.curve(m.MPC, 0, span * 1.4, 's', { w: 3.5, label: 'MPC = MSC', at: span * 0.86, dy: -9 });
      else {
        c.curve(m.MPC, 0, span * 1.4, 's', { w: 3.5, label: 'MPC', at: span * (mono ? 0.86 : 0.88), dy: p.kind === 'negprod' || mono ? 20 : -10, dx: 6 });
        c.curve(m.MSC, 0, span * 1.4, 'v', { w: 3.5, label: 'MSC', at: span * (p.kind === 'posprod' ? 0.9 : 0.8), dy: p.kind === 'posprod' ? 22 : -10, dx: 6 });
      }
      const gap = Math.abs(m.Qm - m.Qs) < 0.05;
      c.dot(m.Qm, m.Pm, 'a', { r: 7 });
      c.drop(m.Qm, m.Pm, 'Q_M', 'P_M', { cls: 'k' });
      if (!gap) {
        c.dot(m.Qs, m.Ps, 'v', { r: 7 });
        c.drop(m.Qs, m.Ps, 'Q_S', 'P_S', { cls: 'v' });
      }

      const over = m.Qm - m.Qs;
      const facts = [
        { sw: 'a', k: 'Market quantity', v: trim(m.Qm, 1) },
        { sw: 'v', k: 'Socially optimal quantity', v: trim(m.Qs, 1) },
        { k: gap ? 'Market is efficient' : over > 0 ? 'Overproduced by' : 'Underproduced by', v: gap ? 'yes' : trim(Math.abs(over), 1) },
        { sw: 'dwl', k: 'Deadweight loss', v: trim(m.dwl, 1) },
      ];
      const say = [];
      if (p.e === 0) say.push('With no externality the private and social curves are the same, so the market quantity is the socially optimal quantity.');
      else if (p.policy && !mono) say.push(`With ${k.fix} equal to ${money(p.e)}, the private curve moves onto the social curve and the market produces the socially optimal quantity.`);
      else {
        say.push(`${k.name}: there is an ${k.cost} of ${money(p.e)} per unit that ${k.who} ignore.`);
        if (mono) say.push(over < 0 ? 'The monopolist restricts output so much (MR = MPC) that it still produces less than the socially optimal quantity, even though it ignores an external cost.' : 'The monopolist produces more than the socially optimal quantity because the external cost is large.');
        else say.push(over > 0 ? 'The market overproduces: at the market quantity the marginal social cost is above the marginal social benefit.' : 'The market underproduces: at the market quantity the marginal social benefit is above the marginal social cost.');
        if (!p.policy && !mono) say.push(`${k.fix[0].toUpperCase()}${k.fix.slice(1)} equal to the externality would fix it.`);
        else if (mono) say.push('The tax moves the monopolist’s MC up to MSC, but it still sets MR = MC, so output is closer to, but not exactly at, the social optimum.');
      }
      return { charts: [c], facts, say: say.join(' ') };
    },
  });

  // ---- the Lorenz curve ------------------------------------------------------

  const lorenz = (g, x) => 100 * (x / 100) ** g;

  define({
    key: 'lorenz',
    unit: 6,
    name: 'Lorenz curve and inequality',
    ced: 'CED Topic 6.5 · POL-5.A',
    blurb: 'A Lorenz curve plots the cumulative share of income against the cumulative share of households, from poorest to richest. The further it sags from the straight line of perfect equality, the more unequal the country.',
    exam: [
      'Interpret a Lorenz curve that is given to you, and compare two countries.',
      'Read shares off the graph, such as the income of the poorest 20 or 40 percent of households.',
      'Drawing a Lorenz curve and calculating a Gini coefficient are outside the course and the exam.',
    ],
    noNumbers: false,
    defaults: { gx: 2.2, gz: 1.4, z: true, shade: false, _n: true },
    controls: [
      { k: 'gx', label: 'Country X: inequality', min: 1, max: 4, step: 0.1, fmt: (v) => (v === 1 ? 'perfect equality' : trim(v, 1)) },
      { type: 'toggle', k: 'z', label: 'Compare with Country Z' },
      { k: 'gz', label: 'Country Z: inequality', min: 1, max: 4, step: 0.1, show: (p) => p.z, fmt: (v) => (v === 1 ? 'perfect equality' : trim(v, 1)) },
      { type: 'toggle', k: 'shade', label: 'Shade the gap in Country X' },
    ],
    scenarios: [
      { name: 'Which country is more unequal?', ask: 'Looking at the two curves, which country has the more unequal distribution of income, and how can you tell?', set: { z: true } },
      { name: 'The poorest 40 percent', ask: 'What share of the total income goes to the poorest 40 percent of households in each country?', set: { z: true } },
    ],
    draw(p, K) {
      const c = K.chart({ xmax: 100, ymax: 100, xlabel: 'Percentage of households (poorest to richest)', ylabel: 'Percentage of income' });
      if (p.shade) {
        const pts = [[0, 0]];
        for (let x = 0; x <= 100; x += 2.5) pts.push([x, lorenz(p.gx, x)]);
        pts.push([100, 100]);
        c.area(pts, 'cs');
      }
      c.seg(0, 0, 100, 100, 'g', { dash: true, w: 2.5 });
      c.text(60, 60, 'Perfect equality', { cls: 'g', dx: -8, dy: -12, anchor: 'end', bold: true });
      c.curve((x) => lorenz(p.gx, x), 0, 100, 'd', { w: 3.5, n: 100, label: 'Country X', at: 82, dy: 20, dx: 6 });
      if (p.z) c.curve((x) => lorenz(p.gz, x), 0, 100, 's', { w: 3.5, n: 100, label: 'Country Z', at: 62, dy: -14, dx: -6, anchor: 'end' });
      for (const at of [20, 40, 60, 80]) {
        c.dot(at, lorenz(p.gx, at), 'd', { r: 4 });
        if (p.z) c.dot(at, lorenz(p.gz, at), 's', { r: 4 });
      }
      const facts = [];
      for (const at of [20, 40, 80]) {
        facts.push({ sw: 'd', k: `X: poorest ${at}% receive`, v: `${trim(lorenz(p.gx, at), 1)}%` });
        if (p.z) facts.push({ sw: 's', k: `Z: poorest ${at}% receive`, v: `${trim(lorenz(p.gz, at), 1)}%` });
      }
      facts.push({ sw: 'd', k: 'X: richest 20% receive', v: `${trim(100 - lorenz(p.gx, 80), 1)}%` });
      if (p.z) facts.push({ sw: 's', k: 'Z: richest 20% receive', v: `${trim(100 - lorenz(p.gz, 80), 1)}%` });
      const say = [];
      if (p.gx === 1 && (!p.z || p.gz === 1)) say.push('A curve on the diagonal means every group receives its fair share: perfect equality.');
      else if (p.z && p.gx !== p.gz) say.push(`Country ${p.gx > p.gz ? 'X' : 'Z'} is more unequal: its Lorenz curve is farther from the line of perfect equality, so the poorest households receive a smaller share of income.`);
      else say.push('The bigger the gap between the curve and the line of perfect equality, the more unequal the income distribution.');
      return { charts: [c], facts, say: say.join(' ') };
    },
  });


  // ---------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------

  /**
   * Builds the control rows for one model. `p` is the live parameter object;
   * every change goes through changed(). A control with show(p) comes and
   * goes with the parameters (a tax-size slider only while taxes are on).
   */
  function buildControls(model, p, changed, api) {
    const node = el('div.ec-controls');
    const syncs = [];

    for (const spec of model.controls) {
      if (spec.head) {
        const h = el('div.ec-h', { text: spec.head });
        node.append(h);
        syncs.push(() => { h.hidden = spec.show ? !spec.show(p) : false; });
        continue;
      }

      let row;
      let sync = () => {};

      if (spec.type === 'seg') {
        const btns = spec.opts.map(([v, t]) => el('button.ec-segbtn', {
          type: 'button', text: t,
          onclick: () => { p[spec.k] = v; if (spec.on) spec.on(p, v); changed(); },
        }));
        row = el('div.ec-row.ec-row--seg', {}, [el('span.ec-lab', { text: spec.label }), el('div.ec-seg', { role: 'group', 'aria-label': spec.label }, btns)]);
        sync = () => spec.opts.forEach(([v], i) => btns[i].setAttribute('aria-pressed', String(p[spec.k] === v)));
      } else if (spec.type === 'toggle') {
        const box = el('input', { type: 'checkbox', onchange: () => { p[spec.k] = box.checked; changed(); } });
        row = el('label.ec-row.ec-row--toggle', {}, [box, el('span.ec-lab', { text: spec.label })]);
        sync = () => { box.checked = !!p[spec.k]; };
      } else if (spec.type === 'button') {
        const b = el('button.btn.btn--small', { type: 'button', text: spec.label, onclick: () => { spec.run(p, api); changed(); } });
        row = el('div.ec-row.ec-row--btn', {}, [b]);
        sync = () => { if (spec.text) b.textContent = spec.text(p); };
      } else {
        const out = el('output.ec-val');
        const inp = el('input.ec-range', {
          type: 'range', min: spec.min, max: spec.max, step: spec.step || 1, 'aria-label': spec.label,
          oninput: () => { p[spec.k] = +inp.value; if (spec.on) spec.on(p, p[spec.k]); changed(); },
        });
        row = el('label.ec-row', {}, [el('span.ec-lab', { text: spec.label }), out, inp]);
        sync = () => {
          if (+inp.value !== +p[spec.k]) inp.value = p[spec.k];
          out.textContent = spec.fmt ? spec.fmt(p[spec.k], p) : trim(p[spec.k]);
        };
      }

      node.append(row);
      syncs.push(() => {
        row.hidden = spec.show ? !spec.show(p) : false;
        sync();
      });
    }

    return { node, sync: () => syncs.forEach((s) => s()) };
  }

  /** Put every parameter back inside what its control allows. Saved state can be anything. */
  function sanitize(model, p) {
    const d = model.defaults;
    for (const k of Object.keys(d)) {
      if (typeof d[k] === 'number') {
        if (!fin(p[k])) p[k] = d[k];
      } else if (typeof d[k] === 'boolean') {
        p[k] = typeof p[k] === 'boolean' ? p[k] : d[k];
      } else if (typeof d[k] === 'string') {
        p[k] = typeof p[k] === 'string' ? p[k] : d[k];
      } else if (Array.isArray(d[k])) {
        if (!Array.isArray(p[k]) || p[k].length !== d[k].length) p[k] = d[k].slice();
        else p[k] = p[k].map((v, i) => (fin(v) ? v : d[k][i]));
      }
    }
    for (const spec of model.controls) {
      if (spec.type === 'seg' && !spec.opts.some(([v]) => v === p[spec.k])) p[spec.k] = d[spec.k];
      else if (!spec.type && !spec.head && spec.k) p[spec.k] = clamp(p[spec.k], spec.min, spec.max);
    }
  }

  // ---------------------------------------------------------------
  // The widget
  // ---------------------------------------------------------------

  Desk.widget({
    type: 'econgraphs',
    added: '2026-10-07',
    news: 'AP Micro graphs you can move in front of the class — shift a curve and watch surplus change.',
    name: 'Economics graphs',
    blurb: 'AP Microeconomics graphs you can move: shift curves, see surplus and profit change, and quiz the class.',
    icon: 'econ',
    category: 'board',
    guest: true,                  // holds nothing about pupils and calls no API
    fills: true,
    tone: 'card',
    size: { w: 7, h: 8 },
    min: { w: 4, h: 6 },

    init(s) {
      if (!byKey(s.model)) s.model = MODELS[0].key;
      if (!s.p || typeof s.p !== 'object') s.p = {};
      if (typeof s.labels !== 'boolean') s.labels = true;
    },

    readout(s) {
      const m = byKey(s.model);
      return m ? m.name : '';
    },

    mount(ctx) {
      const s = ctx.state;
      const big = !!ctx.expanded;
      const timers = new Set();

      let model = byKey(s.model) || MODELS[0];
      let p = {};
      let ctl = null;
      let custom = null;
      let lastCharts = [];
      let asking = null;

      // --- the frame ---------------------------------------------------
      const pick = el('select.select.ec-pick', { 'aria-label': 'Choose a graph', onchange: () => choose(pick.value) });
      for (const u of Object.keys(UNITS)) {
        const g = el('optgroup', { label: `Unit ${u} · ${UNITS[u]}` });
        for (const m of MODELS.filter((x) => String(x.unit) === u)) g.append(el('option', { value: m.key, text: m.name }));
        pick.append(g);
      }

      const step = (d) => {
        const i = MODELS.indexOf(model);
        choose(MODELS[(i + d + MODELS.length) % MODELS.length].key);
      };
      const prev = el('button.btn.btn--small.ec-nav', { type: 'button', text: '‹', 'aria-label': 'Previous graph', onclick: () => step(-1) });
      const next = el('button.btn.btn--small.ec-nav', { type: 'button', text: '›', 'aria-label': 'Next graph', onclick: () => step(1) });

      const tLabels = el('button.ec-tog', { type: 'button', text: 'Labels', title: 'Hide the labels so the class has to name the curves and points', onclick: () => { s.labels = !s.labels; ctx.save(); refresh(); } });
      const tNums = el('button.ec-tog', { type: 'button', text: 'Numbers', title: 'Show a numbered grid', onclick: () => { p._n = !p._n; ctx.save(); refresh(); } });

      const stage = el('div.ec-stage');
      const askText = el('p.ec-ask-text');
      const askGo = el('button.btn.btn--small.btn--primary', { type: 'button', text: 'Show the answer', onclick: () => reveal() });
      const askX = el('button.btn.btn--small.btn--ghost', { type: 'button', text: 'Close', onclick: () => { asking = null; refresh(); } });
      const ask = el('div.ec-ask', { hidden: true }, [askText, el('div.ec-ask-btns', {}, [askGo, askX])]);
      const say = el('p.ec-say', { 'aria-live': 'polite' });
      const factsEl = el('ul.ec-facts');
      const scnEl = el('div.ec-scn');
      const ctlHost = el('div.ec-ctl-host');
      const resetBtn = el('button.btn.btn--small.btn--ghost.ec-reset', {
        type: 'button', text: 'Reset this graph',
        onclick: () => { Object.assign(p, fresh(model.defaults), { _n: model.defaults._n }); asking = null; for (const t of timers) clearInterval(t); timers.clear(); ctx.save(); refresh(); },
      });
      const about = el('details.ec-about');

      const main = el('div.ec-main', {}, [ask, stage, say]);
      const side = el('div.ec-side', {}, [ctlHost, resetBtn, factsEl, scnEl, about]);
      const root = el('div.econ' + (big ? '.is-big' : ''), {}, [
        el('div.ec-top', {}, [prev, pick, next, el('div.ec-togs', {}, [tLabels, tNums])]),
        el('div.ec-body', {}, [main, side]),
      ]);
      ctx.root.append(root);

      // Charts are drawn to the shape of the room they have been given, so a
      // wide board gets a wide graph and a tall card a tall one.
      let layout = { cols: 1, aspect: 1.25, H: 420 };
      let lastN = 1;
      let lastTitled = false;
      const K = {
        chart: (o) => makeChart(Object.assign({
          labels: s.labels,
          numbers: !!p._n && !model.noNumbers,
          h: layout.H,
          w: Math.round(layout.H * layout.aspect),
        }, o)),
      };
      function measure(n, titled) {
        const w = stage.clientWidth;
        const h = stage.clientHeight;
        if (!w || !h) return layout;
        const cols = n === 2 && w >= 520 ? 2 : 1;
        const rows = Math.ceil(n / cols);
        const cellW = (w - (cols - 1) * 8) / cols;
        const cellH = (h - (rows - 1) * 8) / rows - (titled ? 22 : 0);
        // One drawing unit is about a pixel on a small card, so the type stays readable there.
        return { cols, aspect: clamp(cellW / Math.max(cellH, 60), 0.75, 2.4), H: Math.round(clamp(cellH * 1.15, 260, 440)) };
      }
      const roomChanged = () => {
        const want = measure(lastN, lastTitled);
        return want.cols !== layout.cols || Math.abs(want.aspect - layout.aspect) > 0.06 || Math.abs(want.H - layout.H) > 24;
      };
      const watcher = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (model.draw && roomChanged()) refresh(); }) : null;
      if (watcher) watcher.observe(stage);
      const api = {
        facts: (list) => paintFacts(list),
        say: (t) => { say.textContent = t || ''; },
        save: () => ctx.save(),
        refresh: () => refresh(),
        /** Run tick() every 90ms, redrawing each time, until it returns false. */
        animate: (tick) => {
          for (const t of timers) clearInterval(t);
          timers.clear();
          const t = setInterval(() => {
            const go = tick(p);
            ctl.sync();
            refresh();
            if (!go) { clearInterval(t); timers.delete(t); ctx.save(); }
          }, 90);
          timers.add(t);
        },
      };

      // --- choosing a graph --------------------------------------------
      function choose(key) {
        model = byKey(key) || MODELS[0];
        s.model = model.key;
        s.p[model.key] = Object.assign(fresh(model.defaults), s.p[model.key]);
        p = s.p[model.key];
        sanitize(model, p);
        for (const t of timers) clearInterval(t);
        timers.clear();
        asking = null;
        custom = null;
        pick.value = model.key;

        ctl = buildControls(model, p, () => { ctl.sync(); refresh(); ctx.save(); }, api);
        ctlHost.replaceChildren(ctl.node);

        scnEl.replaceChildren();
        if (model.scenarios.length) {
          scnEl.append(el('div.ec-h', { text: 'Class questions' }));
          for (const sc of model.scenarios) {
            scnEl.append(el('button.ec-scn-btn', { type: 'button', text: sc.name, onclick: () => start(sc) }));
          }
        }

        about.replaceChildren(el('summary', { text: 'About this graph' }), ...aboutNodes(model));
        stage.replaceChildren();
        delete stage.dataset.n;
        delete stage.dataset.cols;
        if (model.build) {
          custom = model.build(stage, p, api) || {};
        }
        ctx.save();
        refresh();
      }

      function start(sc) {
        Object.assign(p, fresh(model.defaults), { _n: p._n }, fresh(sc.setup || {}));
        asking = sc;
        ctl.sync();
        refresh();
      }

      function reveal() {
        if (!asking) return;
        Object.assign(p, fresh(typeof asking.set === 'function' ? asking.set(p) : asking.set));
        asking = Object.assign({}, asking, { shown: true });
        ctl.sync();
        ctx.save();
        refresh();
      }

      function paintFacts(list) {
        factsEl.replaceChildren(...(list || []).map((f) => el('li', {}, [
          f.sw ? el(`i.ec-sw.ec-${f.sw}`) : el('i.ec-sw.is-none'),
          el('span', { text: f.k }),
          el('b', { text: f.v }),
        ])));
      }

      function refresh() {
        tLabels.setAttribute('aria-pressed', String(s.labels));
        tNums.setAttribute('aria-pressed', String(!!p._n));
        tNums.hidden = !!model.noNumbers || !!model.build;
        tLabels.hidden = !!model.build;
        ctl.sync();

        if (asking) {
          ask.hidden = false;
          askText.textContent = asking.ask;
          askGo.hidden = !!asking.shown;
        } else ask.hidden = true;

        if (model.build) {
          if (custom && custom.update) custom.update(p);
          return;
        }

        let out = model.draw(p, K);
        lastN = out.charts.length;
        lastTitled = out.charts.some((c) => c.title);
        if (roomChanged()) { layout = measure(lastN, lastTitled); out = model.draw(p, K); }
        lastCharts = out.charts;
        stage.dataset.n = String(out.charts.length);
        stage.dataset.cols = String(layout.cols);
        stage.innerHTML = out.charts.map((c) => `<figure class="ec-fig">${c.title ? `<figcaption>${esc(c.title)}</figcaption>` : ''}${c.svg(model.name)}</figure>`).join('');
        paintFacts(out.facts);
        say.textContent = out.say || '';
      }

      // --- dragging a curve or a point ----------------------------------
      let drag = null;
      stage.addEventListener('pointerdown', (e) => {
        const h = e.target.closest && e.target.closest('[data-h]');
        if (!h || !model.drag) return;
        const svgs = [...stage.querySelectorAll('svg')];
        const idx = svgs.indexOf(h.closest('svg'));
        drag = { id: h.dataset.h, idx };
        try { stage.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events have no pointer to capture */ }
        e.preventDefault();
      });
      stage.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const svg = stage.querySelectorAll('svg')[drag.idx];
        const chart = lastCharts[drag.idx];
        if (!svg || !chart) return;
        const pt = svg.createSVGPoint();
        pt.x = e.clientX; pt.y = e.clientY;
        const m = svg.getScreenCTM();
        if (!m) return;
        const u = pt.matrixTransform(m.inverse());
        const d = chart.fromPx(u.x, u.y);
        model.drag(drag.id, d.x, d.y, p, drag.idx);
        sanitize(model, p);
        ctl.sync();
        refresh();
      });
      const endDrag = () => { if (drag) { drag = null; ctx.save(); } };
      stage.addEventListener('pointerup', endDrag);
      stage.addEventListener('pointercancel', endDrag);

      choose(model.key);

      return {
        destroy() {
          for (const t of timers) clearInterval(t);
          timers.clear();
          if (watcher) watcher.disconnect();
        },
      };
    },

    // Exposed for the tests.
    _models: MODELS,
    _math: {
      solve, integ, argmin, trim, ticks, makeChart, fresh, sanitize,
      marketCalc, tradeCalc, costFns, pcEq, pcLongRunN, monoCalc, monoZeroProfitShift, naturalCalc,
      analyseGame, greedyBuy, extCalc, monopsonyCalc, factorCalc, compCalc,
    },
  });

  /** The "About this graph" text: what the CED asks for, in plain words. */
  function aboutNodes(model) {
    const out = [];
    if (model.ced) out.push(el('p.ec-ced', { text: model.ced }));
    if (model.blurb) out.push(el('p', { text: model.blurb }));
    if (model.exam && model.exam.length) {
      out.push(el('div.ec-h', { text: 'On the AP exam' }));
      out.push(el('ul', {}, model.exam.map((t) => el('li', { text: t }))));
    }
    return out;
  }

}(window.Desk));
