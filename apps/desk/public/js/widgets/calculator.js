// ===================================================================
// Widget — Calculator
//
// A calculator for the front of the room: big enough to read from the back,
// and it shows the SUM as well as the answer. That second part is the whole
// reason this is not just a phone calculator — a class watching a teacher
// work something out needs to see what was typed, not only what came out.
//
// It does times and divide before plus and minus, which a phone calculator
// usually does not. In a maths lesson that is not a preference, it is the
// thing being taught.
//
// On the card it is a plain four-function calculator you can type or paste
// into. Opened full-screen it becomes a scientific calculator, and a graphing
// one in the manner of a TI-84: up to six functions, a window, zoom, trace,
// a table, and zeros / extrema / intersections / slope / area.
//
// No eval, ever. The text is lexed and parsed here into a small tree, and the
// only thing that can come out of a string of characters is a number. A name
// that is not on the list below is a refusal, not a lookup.
// ===================================================================

(function (Desk) {
  'use strict';

  const { el, toast } = Desk;

  // ---------------------------------------------------------------
  // The maths engine. Pure — nothing in here touches the page.
  // ---------------------------------------------------------------

  const MAX_LENGTH = 400;
  const MAX_DEPTH = 80;

  const snap = (v) => (Math.abs(v) < 1e-15 ? 0 : v);
  const toRad = (a, env) => (env.angle === 'rad' ? a : (a * Math.PI) / 180);
  const fromRad = (r, env) => (env.angle === 'rad' ? r : (r * 180) / Math.PI);

  function factorial(n) {
    if (!Number.isInteger(n) || n < 0 || n > 170) return NaN;
    let out = 1;
    for (let i = 2; i <= n; i += 1) out *= i;
    return out;
  }

  function choose(n, r, ordered) {
    if (![n, r].every(Number.isInteger) || r < 0 || n < r) return NaN;
    let out = 1;
    for (let i = 0; i < r; i += 1) out *= (n - i) / (ordered ? 1 : i + 1);
    return Math.round(out);
  }

  const gcd = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) { [a, b] = [b, a % b]; } return a; };

  /**
   * Trig in degrees has to be EXACT at the angles people check first. Doing it
   * through radians gives sin(180) = 1.22e-16, and a class shown that learns
   * the calculator is broken. Multiples of 90 are answered directly.
   */
  function sinOf(a, env) {
    if (env.angle !== 'rad') {
      if (a % 180 === 0) return 0;
      if ((a - 90) % 360 === 0) return 1;
      if ((a + 90) % 360 === 0) return -1;
    }
    return snap(Math.sin(toRad(a, env)));
  }
  function cosOf(a, env) {
    if (env.angle !== 'rad') {
      if ((a - 90) % 180 === 0) return 0;
      if (a % 360 === 0) return 1;
      if ((a - 180) % 360 === 0) return -1;
    }
    return snap(Math.cos(toRad(a, env)));
  }
  function tanOf(a, env) {
    if (env.angle !== 'rad') {
      if (a % 180 === 0) return 0;
      if ((a - 90) % 180 === 0) return NaN;
    }
    const t = Math.tan(toRad(a, env));
    return Math.abs(t) > 1e15 ? NaN : snap(t);
  }

  const inRange = (a) => Math.abs(a) <= 1;

  /** name → { n: [min, max] arguments, f(args, env) }. The whole vocabulary. */
  const FUNCS = {
    sin: { n: [1, 1], f: (a, env) => sinOf(a[0], env) },
    cos: { n: [1, 1], f: (a, env) => cosOf(a[0], env) },
    tan: { n: [1, 1], f: (a, env) => tanOf(a[0], env) },
    asin: { n: [1, 1], f: (a, env) => (inRange(a[0]) ? fromRad(Math.asin(a[0]), env) : NaN) },
    acos: { n: [1, 1], f: (a, env) => (inRange(a[0]) ? fromRad(Math.acos(a[0]), env) : NaN) },
    atan: { n: [1, 1], f: (a, env) => fromRad(Math.atan(a[0]), env) },
    sinh: { n: [1, 1], f: (a) => Math.sinh(a[0]) },
    cosh: { n: [1, 1], f: (a) => Math.cosh(a[0]) },
    tanh: { n: [1, 1], f: (a) => Math.tanh(a[0]) },
    ln: { n: [1, 1], f: (a) => (a[0] > 0 ? Math.log(a[0]) : NaN) },
    log: {
      n: [1, 2],
      f: (a) => {
        if (a.length === 1) return a[0] > 0 ? Math.log10(a[0]) : NaN;
        return a[0] > 0 && a[1] > 0 && a[1] !== 1 ? Math.log(a[0]) / Math.log(a[1]) : NaN;
      },
    },
    exp: { n: [1, 1], f: (a) => Math.exp(a[0]) },
    sqrt: { n: [1, 1], f: (a) => (a[0] >= 0 ? Math.sqrt(a[0]) : NaN) },
    cbrt: { n: [1, 1], f: (a) => Math.cbrt(a[0]) },
    abs: { n: [1, 1], f: (a) => Math.abs(a[0]) },
    floor: { n: [1, 1], f: (a) => Math.floor(a[0]) },
    ceil: { n: [1, 1], f: (a) => Math.ceil(a[0]) },
    sign: { n: [1, 1], f: (a) => Math.sign(a[0]) },
    round: {
      n: [1, 2],
      f: (a) => {
        const d = a.length === 2 ? a[1] : 0;
        if (!Number.isInteger(d) || d < 0 || d > 12) return NaN;
        const k = 10 ** d;
        return Math.round(a[0] * k) / k;
      },
    },
    ncr: { n: [2, 2], f: (a) => choose(a[0], a[1], false) },
    npr: { n: [2, 2], f: (a) => choose(a[0], a[1], true) },
    min: { n: [1, 20], f: (a) => Math.min(...a) },
    max: { n: [1, 20], f: (a) => Math.max(...a) },
    mod: { n: [2, 2], f: (a) => (a[1] === 0 ? NaN : ((a[0] % a[1]) + a[1]) % a[1]) },
    gcd: { n: [2, 2], f: (a) => (a.every(Number.isInteger) ? gcd(a[0], a[1]) : NaN) },
    lcm: { n: [2, 2], f: (a) => (a.every(Number.isInteger) && a[0] && a[1] ? Math.abs(a[0] * a[1]) / gcd(a[0], a[1]) : NaN) },
  };

  const CONSTS = ['pi', 'e', 'x', 't', 'theta', 'ans'];

  // Longest first, so "asin" is never read as "a" + "sin" and "sinh" is never
  // read as "sin" + "h".
  const NAMES = Object.keys(FUNCS).concat(CONSTS).sort((a, b) => b.length - a.length);

  /** Turns what is on the screen into a flat list of tokens. Null if it cannot. */
  function lex(text) {
    const raw = String(text)
      .replace(/[×·⋅]/g, '*').replace(/÷/g, '/').replace(/[−–—]/g, '-')
      .replace(/π/g, 'pi').replace(/θ/g, 'theta').replace(/√/g, 'sqrt')
      .replace(/²/g, '^2').replace(/³/g, '^3')
      .toLowerCase();
    const out = [];
    let i = 0;
    while (i < raw.length) {
      const c = raw[i];
      if (/\s/.test(c)) { i += 1; continue; }

      const num = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/.exec(raw.slice(i));
      if (num) { out.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue; }

      if ('+-*/^(),!%'.includes(c)) { out.push({ t: 'op', v: c }); i += 1; continue; }

      const word = /^[a-z]+/.exec(raw.slice(i));
      if (!word) return null;
      let run = word[0];
      while (run) {
        const name = NAMES.find((n) => run.startsWith(n));
        if (!name) return null;
        out.push({ t: 'id', v: name });
        run = run.slice(name.length);
      }
      i += word[0].length;
    }
    return out;
  }

  /** Text → tree, or null if it is not a finished, well-formed expression. */
  function parse(text) {
    const src = String(text == null ? '' : text);
    if (src.length > MAX_LENGTH) return null;
    const tk = lex(src);
    if (!tk || !tk.length) return null;

    let i = 0;
    let depth = 0;
    const fail = () => { throw new Error('parse'); };
    const isOp = (v) => i < tk.length && tk[i].t === 'op' && tk[i].v === v;

    function expr() {
      let left = term();
      while (isOp('+') || isOp('-')) {
        const op = tk[i].v; i += 1;
        left = { t: 'bin', op, l: left, r: term() };
      }
      return left;
    }

    function startsOperand() {
      const k = tk[i];
      return !!k && (k.t === 'num' || k.t === 'id' || (k.t === 'op' && k.v === '('));
    }

    function term() {
      let left = unary();
      for (;;) {
        if (isOp('*') || isOp('/')) {
          const op = tk[i].v; i += 1;
          left = { t: 'bin', op, l: left, r: unary() };
        } else if (startsOperand()) {
          // Implicit multiplication: 2x, 3(4+1), (a)(b), 2pi. Two bare numbers
          // side by side is not one — "2 3" is a typing slip, not 6.
          if (tk[i - 1].t === 'num' && tk[i].t === 'num') fail();
          left = { t: 'bin', op: '*', l: left, r: power() };
        } else return left;
      }
    }

    // A minus is a sign only in front of an operand; a plus never is, so
    // "2++3" stays a mistake rather than quietly meaning 5. Minus binds looser
    // than ^, so -2^2 is -4, as it is written.
    function unary() {
      if (isOp('-')) { i += 1; return { t: 'neg', a: unary() }; }
      return power();
    }

    function power() {
      const base = postfix();
      if (isOp('^')) { i += 1; return { t: 'bin', op: '^', l: base, r: unary() }; }
      return base;
    }

    function postfix() {
      let node = primary();
      for (;;) {
        if (isOp('!')) { i += 1; node = { t: 'fact', a: node }; }
        else if (isOp('%')) { i += 1; node = { t: 'pct', a: node }; }
        else return node;
      }
    }

    function primary() {
      const k = tk[i];
      if (!k) fail();
      if (k.t === 'num') { i += 1; return { t: 'num', v: k.v }; }

      if (k.t === 'op' && k.v === '(') {
        i += 1;
        depth += 1;
        if (depth > MAX_DEPTH) fail();
        const inner = expr();
        // A bracket left open at the end closes itself, as on a TI.
        if (isOp(')')) i += 1; else if (i < tk.length) fail();
        depth -= 1;
        return inner;
      }

      if (k.t === 'id') {
        i += 1;
        if (k.v === 'pi') return { t: 'num', v: Math.PI };
        if (k.v === 'e') return { t: 'num', v: Math.E };
        if (k.v === 'x') return { t: 'x' };
        // t (parametric) and θ (polar) are the same variable to the evaluator.
        if (k.v === 't' || k.v === 'theta') return { t: 'p' };
        if (k.v === 'ans') return { t: 'ans' };

        const def = FUNCS[k.v];
        let args;
        if (isOp('(')) {
          i += 1;
          depth += 1;
          if (depth > MAX_DEPTH) fail();
          args = [expr()];
          while (isOp(',')) { i += 1; args.push(expr()); }
          if (isOp(')')) i += 1; else if (i < tk.length) fail();
          depth -= 1;
        } else {
          // "sin30", "sqrt 9": the argument is the next operand.
          args = [unary()];
        }
        if (args.length < def.n[0] || args.length > def.n[1]) fail();
        return { t: 'call', name: k.v, args };
      }
      return fail();
    }

    try {
      const tree = expr();
      return i === tk.length ? tree : null;
    } catch (e) {
      return null;
    }
  }

  /** Works a tree out. NaN stands for "no such number" (÷0, √−1, …). */
  function run(n, env) {
    switch (n.t) {
      case 'num': return n.v;
      case 'x': return env.x === undefined ? NaN : env.x;
      case 'p': return env.t === undefined ? NaN : env.t;
      case 'ans': return env.ans || 0;
      case 'neg': return -run(n.a, env);
      case 'pct': return run(n.a, env) / 100;
      case 'fact': return factorial(run(n.a, env));
      case 'call': return FUNCS[n.name].f(n.args.map((a) => run(a, env)), env);
      case 'bin': {
        const a = run(n.l, env);
        const b = run(n.r, env);
        if (n.op === '+') return a + b;
        if (n.op === '-') return a - b;
        if (n.op === '*') return a * b;
        if (n.op === '/') return b === 0 ? NaN : a / b;
        return Math.pow(a, b);
      }
      default: return NaN;
    }
  }

  /** Text → a finite number, or null. `opts`: { angle: 'deg'|'rad', ans, x }. */
  function evaluate(text, opts) {
    const tree = parse(text);
    if (!tree) return null;
    const o = opts || {};
    const v = run(tree, { angle: o.angle || 'deg', ans: o.ans, x: o.x });
    return Number.isFinite(v) ? v : null;
  }

  /**
   * One graphed line: { f(x) } to call, { bad: true } when the text will not
   * parse, null when the line is empty. `f` may return NaN or ±Infinity —
   * those are gaps, and the caller draws them as gaps.
   */
  function compileY(text, angle) {
    const t = String(text || '').replace(/^\s*y\d*\s*=/i, '');
    if (!t.trim()) return null;
    const tree = parse(t);
    if (!tree) return { bad: true };
    const env = { angle: angle || 'deg', x: 0, ans: 0 };
    return { f: (x) => { env.x = x; return run(tree, env); } };
  }

  /**
   * A parametric or polar curve: { f(p) → { x, y, r } }, { bad: true }, or
   * null when the line is empty. For parametric, `src` is { x, y } and p is t.
   * For polar, `src` is { expr } and p is θ in the current angle unit — the
   * point is placed with the same exact-at-90° trig the calculator uses.
   */
  function compileCurve(kind, src, angle) {
    const strip = (t) => String(t || '').replace(/^\s*[a-z]\d*\s*(?:\([^)]*\))?\s*=/i, '');
    const env = { angle: angle || 'rad', t: 0, x: undefined, ans: 0 };
    if (kind === 'param') {
      const tx = strip(src.x); const ty = strip(src.y);
      if (!tx.trim() && !ty.trim()) return null;
      const ax = tx.trim() ? parse(tx) : null; const ay = ty.trim() ? parse(ty) : null;
      if (!ax || !ay) return { bad: true };
      return { f: (t) => { env.t = t; const x = run(ax, env); const y = run(ay, env); return { x, y, r: Math.hypot(x, y) }; } };
    }
    const tr = strip(src.expr);
    if (!tr.trim()) return null;
    const ar = parse(tr);
    if (!ar) return { bad: true };
    return {
      f: (th) => {
        env.t = th;
        const r = run(ar, env);
        return { x: r * cosOf(th, env), y: r * sinOf(th, env), r };
      },
    };
  }

  /** Points [p, x, y] along a curve from min to max, always including max. */
  function sampleCurve(f, rng) {
    const { min, max, step } = rng;
    if (!(step > 0) || !(max > min)) return [];
    const n = Math.min(20000, Math.floor((max - min) / step + 1e-9) + 1);
    const out = [];
    for (let i = 0; i < n; i += 1) { const p = min + i * step; const q = f(p); out.push([p, q.x, q.y]); }
    const last = min + (n - 1) * step;
    if (last < max - 1e-12 * Math.max(1, Math.abs(max))) { const q = f(max); out.push([max, q.x, q.y]); }
    return out;
  }

  /** Length and swept area (½∮x dy − y dx) of sampled points between a and b. */
  function curveTotals(pts, a, b) {
    let length = 0; let area = 0;
    for (let i = 1; i < pts.length; i += 1) {
      const p = pts[i - 1]; const q = pts[i];
      if (p[0] < a || q[0] > b || ![p[1], p[2], q[1], q[2]].every(Number.isFinite)) continue;
      length += Math.hypot(q[1] - p[1], q[2] - p[2]);
      area += 0.5 * (p[1] * q[2] - q[1] * p[2]);
    }
    return { length, area };
  }

  /** Enough digits to be exact, without 0.30000000000000004 on the board. */
  function show(n) {
    if (n == null) return '';
    const rounded = Number(n.toPrecision(12));
    if (Math.abs(rounded) >= 1e12 || (rounded !== 0 && Math.abs(rounded) < 1e-9)) {
      return rounded.toExponential(6).replace('e', ' × 10^');
    }
    return String(rounded);
  }

  /** Shorter, for graph readouts. */
  function fmt(n) {
    if (n == null || !Number.isFinite(n)) return '—';
    if (Math.abs(n) < 1e-10) return '0';
    const r = Number(n.toPrecision(6));
    return Math.abs(r) >= 1e9 || Math.abs(r) < 1e-4 ? r.toExponential(3) : String(r);
  }

  /**
   * What a keyboard, a paste or a keypad is allowed to put on the screen.
   * Everything the parser reads, nothing else — so a pasted web page, a price
   * with a £ in it or a stray newline simply loses the parts that are not
   * maths. `*` `/` `-` are shown the way the keypad draws them.
   */
  function clean(raw, keepEquals, ascii) {
    const text = String(raw == null ? '' : raw).replace(/\s+/g, ' ');
    // In a function box the keys are left as typed (* / -); on the calculator
    // screen they are drawn the way the keypad draws them (× ÷ −).
    return (ascii ? text.replace(/[×·⋅]/g, '*').replace(/÷/g, '/').replace(/[−–—]/g, '-') : text
      .replace(/\*/g, '×').replace(/\//g, '÷').replace(/[-–—]/g, '−').replace(/[·⋅]/g, '×'))
      .replace(/²/g, '^2').replace(/³/g, '^3')
      .replace(new RegExp(`[^0-9A-Za-z+−×÷*/^().,!%πθ√ \\-${keepEquals ? '=' : ''}]`, 'g'), '');
  }

  /**
   * Pasted text. A lone number written with thousands separators — "1,234,567"
   * from a spreadsheet or a web page — loses them; anywhere else a comma is an
   * argument separator and stays.
   */
  function cleanPaste(raw, keepEquals, ascii) {
    let text = String(raw == null ? '' : raw).trim();
    if (/^[-−+]?\s*\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) text = text.replace(/,/g, '');
    return clean(text, keepEquals, ascii);
  }

  // ----- the numerical tools the grapher uses -----

  const finite = Number.isFinite;

  function bisect(f, a, b) {
    let fa = f(a);
    for (let k = 0; k < 70; k += 1) {
      const m = (a + b) / 2;
      const fm = f(m);
      if (fm === 0) return m;
      if (Math.sign(fm) === Math.sign(fa)) { a = m; fa = fm; } else b = m;
    }
    return (a + b) / 2;
  }

  function golden(f, a, b, sign) {
    const g = (Math.sqrt(5) - 1) / 2;
    let c = b - g * (b - a);
    let d = a + g * (b - a);
    for (let k = 0; k < 80; k += 1) {
      if (sign * f(c) < sign * f(d)) { b = d; } else { a = c; }
      c = b - g * (b - a);
      d = a + g * (b - a);
    }
    return (a + b) / 2;
  }

  function dedupe(xs, tol) {
    const out = [];
    for (const x of xs.sort((a, b) => a - b)) if (!out.length || Math.abs(x - out[out.length - 1]) > tol) out.push(x);
    return out;
  }

  /** x where f crosses (or just touches) zero on [lo, hi]. */
  function roots(f, lo, hi, n) {
    const N = n || 1200;
    const step = (hi - lo) / N;
    const xs = [];
    const ys = [];
    for (let i = 0; i <= N; i += 1) { xs.push(lo + i * step); ys.push(f(xs[i])); }
    const found = [];
    for (let i = 0; i < N; i += 1) {
      const a = ys[i];
      const b = ys[i + 1];
      if (!finite(a) || !finite(b)) continue;
      if (a === 0) { found.push(xs[i]); continue; }
      if (a * b < 0) {
        const r = bisect(f, xs[i], xs[i + 1]);
        // A sign change is also what a jump or a pole looks like (1/x). A real
        // root leaves the function near zero; a jump leaves it huge.
        if (Math.abs(f(r)) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b))) found.push(r);
      }
    }
    if (finite(ys[N]) && ys[N] === 0) found.push(xs[N]);
    // A touch without a crossing (x², (x−1)²) never changes sign.
    for (const x of extrema((t) => Math.abs(f(t)), lo, hi, 'min', N)) {
      if (Math.abs(f(x)) < 1e-9 && !found.some((r) => Math.abs(r - x) < 1e-6 * Math.max(1, Math.abs(hi - lo)))) found.push(x);
    }
    return dedupe(found, 1e-9 * Math.max(1, Math.abs(hi - lo)));
  }

  /** x of the local minima or maxima of f on [lo, hi]. */
  function extrema(f, lo, hi, kind, n) {
    const N = n || 1200;
    const sign = kind === 'max' ? -1 : 1;
    const step = (hi - lo) / N;
    const xs = [];
    const ys = [];
    for (let i = 0; i <= N; i += 1) { xs.push(lo + i * step); ys.push(sign * f(xs[i])); }
    const found = [];
    for (let i = 1; i < N; i += 1) {
      if (![ys[i - 1], ys[i], ys[i + 1]].every(finite)) continue;
      if (ys[i] < ys[i - 1] && ys[i] <= ys[i + 1]) {
        let x = golden(f, xs[i - 1], xs[i + 1], sign);
        // Golden-section is only good to about 1e-8 (the curve is flat at the
        // bottom), which shows as x = 1.49e-8 where a class expects 0. The
        // slope changes sign cleanly, so finish by bisecting on that.
        const d = (t) => derivative(f, t);
        const reach = 1e-4 * Math.max(1, Math.abs(x));
        const lo = Math.max(xs[i - 1], x - reach);
        const hi = Math.min(xs[i + 1], x + reach);
        const dl = d(lo); const dh = d(hi);
        if (dl != null && dh != null && dl * dh < 0) x = bisect((t) => d(t), lo, hi);
        found.push(x);
      }
    }
    return dedupe(found, 1e-9 * Math.max(1, Math.abs(hi - lo)));
  }

  /** The slope of f at x — a five-point stencil, good to about 1e-10. */
  function derivative(f, x) {
    const h = 1e-3 * Math.max(1, Math.abs(x));
    const d = (-f(x + 2 * h) + 8 * f(x + h) - 8 * f(x - h) + f(x - 2 * h)) / (12 * h);
    return finite(d) ? d : null;
  }

  /** The area under f from a to b (Simpson's rule); null if it hits a gap. */
  function integrate(f, a, b) {
    const n = 2000;
    const h = (b - a) / n;
    let sum = f(a) + f(b);
    for (let i = 1; i < n; i += 1) sum += f(a + i * h) * (i % 2 ? 4 : 2);
    const out = (sum * h) / 3;
    return finite(out) ? out : null;
  }

  /** A gridline spacing of 1, 2 or 5 × a power of ten, near `target`. */
  function niceStep(target) {
    const p = 10 ** Math.floor(Math.log10(target));
    const m = target / p;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  }

  // ---------------------------------------------------------------
  // The widget.
  // ---------------------------------------------------------------

  // Card keypad: label, kind.
  const KEYS = [
    ['AC', 'clear'], ['⌫', 'back'], ['%', 'post'], ['÷', 'op'],
    ['7', 'num'], ['8', 'num'], ['9', 'num'], ['×', 'op'],
    ['4', 'num'], ['5', 'num'], ['6', 'num'], ['−', 'op'],
    ['1', 'num'], ['2', 'num'], ['3', 'num'], ['+', 'op'],
    ['0', 'num'], ['.', 'num'], ['±', 'sign'], ['=', 'equals'],
  ];

  // Scientific keypad: label, text to insert, kind. 'fn' starts something new
  // after an answer; 'post' carries the answer on.
  const SCI_KEYS = [
    ['sin', 'sin(', 'fn'], ['cos', 'cos(', 'fn'], ['tan', 'tan(', 'fn'], ['DEG', '', 'angle'],
    ['sin⁻¹', 'asin(', 'fn'], ['cos⁻¹', 'acos(', 'fn'], ['tan⁻¹', 'atan(', 'fn'], ['Ans', 'Ans', 'fn'],
    ['ln', 'ln(', 'fn'], ['log', 'log(', 'fn'], ['eˣ', 'e^(', 'fn'], ['10ˣ', '10^(', 'fn'],
    ['x²', '^2', 'post'], ['xʸ', '^', 'post'], ['√', '√(', 'fn'], ['x⁻¹', '^(−1)', 'post'],
    ['(', '(', 'fn'], [')', ')', 'post'], ['π', 'π', 'fn'], ['e', 'e', 'fn'],
    ['n!', '!', 'post'], ['nCr', 'nCr(', 'fn'], ['nPr', 'nPr(', 'fn'], ['|x|', 'abs(', 'fn']
  ];

  const CURVES = ['#d1495b', '#2a6fdb', '#2e9e5b', '#e08a00', '#8a4fd1', '#0b9aa6'];
  const SUB = ['₁', '₂', '₃', '₄', '₅', '₆'];
  const FN_TAIL = new RegExp(`(?:${Object.keys(FUNCS).sort((a, b) => b.length - a.length).concat(['Ans', 'sqrt']).join('|')})\\(?$`, 'i');

  function defaultGraph() {
    return {
      fns: [
        { expr: 'x^2', on: true }, { expr: '', on: true }, { expr: '', on: true },
        { expr: '', on: true }, { expr: '', on: true }, { expr: '', on: true },
      ],
      win: { xmin: -10, xmax: 10, ymin: -10, ymax: 10 },
      auto: true,
      view: 'graph',
      tbl: { start: -5, step: 1 },
      kind: 'func',
      param: [0, 1, 2].map(() => ({ x: '', y: '', on: true })),
      polar: [0, 1, 2].map(() => ({ expr: '', on: true })),
      t: { min: 0, max: 2 * Math.PI, step: 0.02 },
      th: { min: 0, max: 2 * Math.PI, step: Math.PI / 90 },
      tblc: { start: 0, step: 0.5 },
    };
  }

  Desk.widget({
    type: 'calculator',
    name: 'Calculator',
    blurb: 'Type, paste or press. Open it full-screen for a scientific and graphing calculator.',
    icon: 'calculator',
    category: 'other',
    students: true,
    role: 'p1',
    tone: 'card',
    guest: true,
    size: { w: 3, h: 6 },
    min: { w: 2, h: 5 },

    init(s) {
      if (typeof s.expr !== 'string') s.expr = '';
      if (typeof s.answer !== 'string') s.answer = '';
      if (!Array.isArray(s.tape)) s.tape = [];
      if (s.angle !== 'rad') s.angle = 'deg';
      if (typeof s.ans !== 'number' || !finite(s.ans)) s.ans = 0;
      if (s.mode !== 'graph') s.mode = 'sci';
      if (!s.graph || typeof s.graph !== 'object') s.graph = defaultGraph();
      const g = s.graph;
      const d = defaultGraph();
      if (!Array.isArray(g.fns)) g.fns = d.fns;
      while (g.fns.length < 6) g.fns.push({ expr: '', on: true });
      g.fns = g.fns.slice(0, 6).map((f) => ({ expr: String((f && f.expr) || '').slice(0, 200), on: !f || f.on !== false }));
      const w = g.win || {};
      if (!['xmin', 'xmax', 'ymin', 'ymax'].every((k) => finite(w[k])) || w.xmin >= w.xmax || w.ymin >= w.ymax) g.win = d.win;
      if (typeof g.auto !== 'boolean') g.auto = true;
      if (g.view !== 'table') g.view = 'graph';
      // The grapher has its own angle unit, and starts in radians: y = sin(x)
      // drawn in degrees is a nearly flat line, which is the first thing a
      // class would try.
      if (g.angle !== 'deg') g.angle = 'rad';
      if (!['func', 'param', 'polar'].includes(g.kind)) g.kind = 'func';
      const keep = (arr, n, blank) => {
        const a = Array.isArray(arr) ? arr.slice(0, n) : [];
        while (a.length < n) a.push(blank());
        return a;
      };
      const txt = (v) => String(v || '').slice(0, 200);
      g.param = keep(g.param, 3, () => ({})).map((c) => ({ x: txt(c && c.x), y: txt(c && c.y), on: !c || c.on !== false }));
      g.polar = keep(g.polar, 3, () => ({})).map((c) => ({ expr: txt(c && c.expr), on: !c || c.on !== false }));
      const range = (r, dflt) => (r && finite(r.min) && finite(r.max) && finite(r.step) && r.min < r.max && r.step > 0 ? { min: r.min, max: r.max, step: r.step } : { ...dflt });
      g.t = range(g.t, d.t);
      g.th = range(g.th, d.th);
      if (!g.tblc || !finite(g.tblc.start) || !finite(g.tblc.step) || g.tblc.step === 0) g.tblc = { ...d.tblc };
      if (!g.tbl || !finite(g.tbl.start) || !finite(g.tbl.step) || g.tbl.step === 0) g.tbl = d.tbl;
    },

    holdsContent: (s) => (s.tape.length ? `${s.tape.length} worked out.` : ''),

    mount(ctx) {
      const s = ctx.state;
      const big = !!ctx.expanded;
      const cleanups = [];

      const body = el('div.calc-body');
      ctx.root.append(el('div.calculator' + (big ? '.is-big' : ''), {}, [body]));

      let paintMain = () => {};
      let drawTape = () => {};
      let buildGraph = null;

      // ================= the calculator itself =================

      function buildCalc(host) {
        const sum = el('input.calc-sum', {
          type: 'text', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off',
          placeholder: '0', 'aria-label': 'Type or paste a sum', enterkeyhint: 'done',
        });
        const out = el('div.calc-answer');
        const mode = el('span.calc-mode');
        const pad = el('div.calc-pad');
        const tape = el('div.calc-tape');

        sum.value = s.expr;
        const caretToEnd = () => { try { sum.setSelectionRange(sum.value.length, sum.value.length); } catch (e) { /* not a text field right now */ } };
        caretToEnd();

        const screen = el('div.calc-screen', {
          onclick: (e) => { if (e.target !== sum) { sum.focus(); caretToEnd(); } },
        }, [mode, sum, out]);

        const main = el('div.calc-main', {}, [screen]);
        if (big) {
          const sci = el('div.calc-sci');
          for (const [label, text, kind] of SCI_KEYS) {
            const k = el('button.calc-key.calc-key--sci', {
              text: label, 'data-kind': kind, 'aria-label': label,
              onclick: () => press(label, kind, text),
            });
            if (kind === 'angle') k.dataset.angle = '1';
            sci.append(k);
          }
          main.append(el('div.calc-keys', {}, [sci, pad]));
        } else {
          main.append(pad);
        }

        const wrap = el('div.calc-wrap', {}, [main, big ? tape : null]);
        host.append(wrap);

        paintMain = () => {
          out.textContent = s.answer;
          out.classList.toggle('is-shown', !!s.answer);
          mode.textContent = big ? (s.angle === 'rad' ? 'RAD' : 'DEG') : '';
          for (const k of host.querySelectorAll('[data-angle]')) k.textContent = s.angle === 'rad' ? 'RAD' : 'DEG';
          drawTape();
        };

        /** The text changed: keep it, and drop an answer that no longer matches. */
        function commit() {
          s.expr = sum.value;
          s.answer = '';
          ctx.save();
          paintMain();
        }

        /** Put `text` where the caret is — replacing the selection, if there is one. */
        function insert(text, fresh) {
          if (s.answer && fresh) { sum.value = ''; }
          const a = sum.selectionStart == null ? sum.value.length : sum.selectionStart;
          const b = sum.selectionEnd == null ? a : sum.selectionEnd;
          sum.setRangeText(text, s.answer && fresh ? 0 : a, s.answer && fresh ? 0 : b, 'end');
          commit();
        }

        /** Backspace that takes "sin(" or "Ans" as one thing, not four. */
        function backspace() {
          const a = sum.selectionStart == null ? sum.value.length : sum.selectionStart;
          const b = sum.selectionEnd == null ? a : sum.selectionEnd;
          if (a !== b) { sum.setRangeText('', a, b, 'end'); }
          else if (a > 0) {
            const m = FN_TAIL.exec(sum.value.slice(0, a));
            const from = m ? a - m[0].length : a - 1;
            sum.setRangeText('', from, a, 'end');
          }
          commit();
        }

        function equals() {
          const value = evaluate(s.expr, { angle: s.angle, ans: s.ans });
          if (value == null) { toast('That sum is not finished.', 'warn'); return; }
          s.answer = show(value);
          s.ans = value;
          s.tape.unshift({ expr: s.expr, answer: s.answer });
          s.tape.length = Math.min(s.tape.length, 30);
          // Carrying the answer forward is how somebody actually uses one of
          // these: work out a total, then keep going with it.
          s.expr = s.answer;
          sum.value = s.expr;
          caretToEnd();
          ctx.save();
          paintMain();
        }

        function press(label, kind, text) {
          if (kind === 'clear') { sum.value = ''; s.expr = ''; s.answer = ''; ctx.save(); paintMain(); }
          else if (kind === 'back') backspace();
          else if (kind === 'equals') equals();
          else if (kind === 'angle') { s.angle = s.angle === 'rad' ? 'deg' : 'rad'; ctx.save(); paintMain(); if (buildGraph) buildGraph.angleChanged(); }
          else if (kind === 'sign') {
            // Flips the sign of the number being typed, not of the whole sum.
            const m = /(−?)(\d*\.?\d+)$/.exec(sum.value);
            if (m) {
              sum.value = sum.value.slice(0, m.index) + (m[1] ? '' : '−') + m[2];
              caretToEnd();
              commit();
            }
          }
          // Starting a new sum after an answer replaces it; an operator, or
          // something that goes after a number, carries the answer on.
          else if (kind === 'num' || kind === 'fn') insert(text || label, true);
          else insert(text || label, false);
        }

        for (const [label, kind] of KEYS) {
          pad.append(el('button.calc-key', {
            text: label,
            'data-kind': kind === 'post' ? 'op' : kind,
            'aria-label': label === 'AC' ? 'Clear' : label === '⌫' ? 'Backspace' : label,
            onclick: () => press(label, kind),
          }));
        }

        // ----- the keyboard: type, paste, Enter -----

        function tidy() {
          const at = sum.selectionStart == null ? sum.value.length : sum.selectionStart;
          const cleaned = clean(sum.value);
          if (cleaned !== sum.value) {
            const caret = clean(sum.value.slice(0, at)).length;
            sum.value = cleaned;
            try { sum.setSelectionRange(caret, caret); } catch (e) { /* ignore */ }
          }
          commit();
        }
        sum.addEventListener('input', tidy);

        sum.addEventListener('keydown', (e) => {
          if (e.metaKey || e.ctrlKey || e.altKey) return;
          if (e.key === 'Enter' || e.key === '=') { e.preventDefault(); equals(); return; }
          if (e.key === 'Escape') {
            if (sum.value) { e.preventDefault(); e.stopPropagation(); press('AC', 'clear'); }
            return;
          }
          // Typing a number or a name straight after an answer starts a new
          // sum; an operator carries on, same as the keypad.
          if (s.answer && /^[0-9.a-zA-Zπ(√]$/.test(e.key)) { sum.value = ''; s.expr = ''; s.answer = ''; paintMain(); }
        });

        sum.addEventListener('paste', (e) => {
          const data = e.clipboardData && e.clipboardData.getData('text');
          if (data == null) return;
          e.preventDefault();
          const text = cleanPaste(data);
          if (!text) { toast('There was no maths in what you pasted.', 'warn'); return; }
          insert(text, true);
        });

        // Anywhere on the open calculator, typing goes to the sum: nobody
        // standing at a board has clicked into a field first.
        if (big) {
          const onKey = (e) => {
            if (s.mode !== 'sci') return;
            if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return;
            const tag = (document.activeElement || {}).tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            sum.focus();
            if (document.activeElement === sum && sum.selectionStart === 0 && sum.value && !s.answer) caretToEnd();
          };
          window.addEventListener('keydown', onKey);
          cleanups.push(() => window.removeEventListener('keydown', onKey));
          if (!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches)) sum.focus();
        }

        drawTape = () => {
          Desk.clear(tape);
          if (!big || !s.tape.length) return;
          tape.append(el('div.calc-tape-head', {}, [
            el('span.hint', { text: 'Worked out' }),
            el('button.btn.btn--small', {
              onclick: () => { s.tape = []; ctx.save(); paintMain(); },
            }, 'Clear'),
          ]));
          for (const row of s.tape) {
            tape.append(el('button.calc-tape-row', {
              title: 'Use this sum again',
              onclick: () => { sum.value = row.expr; s.expr = row.expr; s.answer = ''; caretToEnd(); ctx.save(); paintMain(); },
            }, [
              el('span.calc-tape-sum', { text: row.expr }),
              el('span.calc-tape-eq', { text: `= ${row.answer}` }),
            ]));
          }
        };

        paintMain();
      }

      // ================= the graphing calculator =================

      function buildGraphing(host) {
        const g = s.graph;
        const kind = g.kind;                        // 'func' | 'param' | 'polar'
        const curved = kind !== 'func';
        const slots = kind === 'func' ? g.fns : kind === 'param' ? g.param : g.polar;
        const rng = kind === 'param' ? g.t : g.th;
        const pName = kind === 'param' ? 't' : 'θ';
        const nameOf = (i) => (kind === 'func' ? `Y${SUB[i]}` : kind === 'param' ? `P${SUB[i]}` : `r${SUB[i]}`);

        let compiled = [];
        let samples = [];      // curved kinds: [p, x, y] points per slot
        let marks = [];
        let results = [];
        let pinned = null;     // func: { x, k }   curved: { k, i }
        let hover = null;
        let activeInput = null;

        const cv = el('canvas.gr-canvas', { tabindex: '0', 'aria-label': 'Graph' });
        const read = el('div.gr-read');
        const stageEl = el('div.gr-stage', {}, [cv, read]);
        const tableEl = el('div.gr-table');
        const view = el('div.gr-view', {}, []);

        function recompile() {
          compiled = slots.map((f) => (f.on ? (curved ? compileCurve(kind, f, g.angle) : compileY(f.expr, g.angle)) : null));
          resample();
        }
        function resample() {
          samples = curved ? compiled.map((c) => (c && c.f ? sampleCurve(c.f, rng) : null)) : [];
        }

        // ---- the kind of graph ----
        const kindSeg = el('div.seg.gr-kind', {}, [['func', 'y = f(x)'], ['param', 'Parametric'], ['polar', 'Polar']].map(([k, label]) =>
          el('button.seg-btn' + (kind === k ? '.is-on' : ''), {
            text: label,
            onclick: () => { if (g.kind === k) return; g.kind = k; ctx.save(); build(); },
          })));

        // ---- the lines ----
        const strip = (t) => String(t || '').replace(/^\s*[a-z]\d*\s*(?:\([^)]*\))?\s*=/i, '');
        const textBad = (t) => !!strip(t).trim() && !parse(strip(t));

        function field(f, key, aria, placeholder) {
          const inp = el('input.input.gr-fn', {
            type: 'text', value: f[key], placeholder: placeholder || '',
            autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', 'aria-label': aria,
          });
          const edit = () => {
            const at = inp.selectionStart == null ? inp.value.length : inp.selectionStart;
            const cleaned = clean(inp.value, true, true);
            if (cleaned !== inp.value) {
              const caret = clean(inp.value.slice(0, at), true, true).length;
              inp.value = cleaned;
              try { inp.setSelectionRange(caret, caret); } catch (e) { /* ignore */ }
            }
            f[key] = inp.value;
            marks = []; results = []; pinned = null; hover = null;
            changed();
          };
          inp.addEventListener('input', edit);
          inp.addEventListener('focus', () => { activeInput = inp; });
          inp.addEventListener('paste', (e) => {
            const data = e.clipboardData && e.clipboardData.getData('text');
            if (data == null) return;
            e.preventDefault();
            inp.setRangeText(cleanPaste(data, true, true), inp.selectionStart, inp.selectionEnd, 'end');
            edit();
          });
          return inp;
        }

        const rows = slots.map((f, i) => {
          const dot = el('button.gr-dot', {
            'aria-label': `Show or hide ${nameOf(i)}`, 'aria-pressed': String(f.on),
            style: { '--c': CURVES[i] },
            onclick: () => { f.on = !f.on; dot.setAttribute('aria-pressed', String(f.on)); pinned = null; changed(); },
          });
          const line = (label, inp) => el('div.gr-line', {}, [el('span.gr-label', { text: label }), inp]);
          let inps; let content;
          if (kind === 'param') {
            const ix = field(f, 'x', `X${i + 1} of t`, i === 0 ? 'e.g. 3cos(t)' : '');
            const iy = field(f, 'y', `Y${i + 1} of t`, i === 0 ? 'e.g. 2sin(t)' : '');
            inps = [ix, iy];
            content = el('div.gr-pair', {}, [line(`X${SUB[i]}(t) =`, ix), line(`Y${SUB[i]}(t) =`, iy)]);
          } else {
            const inp = field(f, kind === 'func' ? 'expr' : 'expr', `${nameOf(i)} equals`, i === 0 ? (kind === 'func' ? 'e.g. x^2 − 4' : 'e.g. 1 + cos(θ)') : '');
            inps = [inp];
            content = line(`${nameOf(i)}${kind === 'polar' ? '(θ)' : ''} =`, inp);
          }
          const check = () => {
            if (kind === 'param') {
              const xb = textBad(f.x) || (!strip(f.x).trim() && !!strip(f.y).trim());
              const yb = textBad(f.y) || (!strip(f.y).trim() && !!strip(f.x).trim());
              inps[0].classList.toggle('is-bad', xb); inps[1].classList.toggle('is-bad', yb);
            } else inps[0].classList.toggle('is-bad', textBad(f.expr));
          };
          return { f, inps, check, row: el('div.gr-row', {}, [dot, content]) };
        });

        const chipSet = kind === 'func' ? ['x', '^', '(', ')', 'π', 'sin', 'cos', 'tan', 'ln', 'log', '√', 'abs']
          : [pName, '^', '(', ')', 'π', 'sin', 'cos', 'tan', 'ln', 'log', '√', 'abs'];
        const insertChips = el('div.gr-chips', {}, chipSet.map((t) =>
          el('button.chip', {
            text: t, 'aria-label': `Insert ${t}`,
            onmousedown: (e) => e.preventDefault(),
            onclick: () => {
              const first = rows.find((r) => r.inps.some((i) => !i.value));
              const inp = activeInput || (first ? first.inps.find((i) => !i.value) : rows[0].inps[0]);
              const text = ['sin', 'cos', 'tan', 'ln', 'log', 'abs'].includes(t) ? `${t}(` : t === '√' ? '√(' : t;
              inp.focus();
              inp.setRangeText(text, inp.selectionStart, inp.selectionEnd, 'end');
              inp.dispatchEvent(new Event('input'));
            },
          })));

        // ---- the parameter range (curved kinds) ----
        const rangeInputs = {};
        const rangeGrid = curved ? el('div.gr-win.gr-range', {}, ['min', 'max', 'step'].map((k) => {
          const inp = el('input.input', {
            type: 'text', inputmode: 'decimal', 'aria-label': `${pName} ${k}`, autocomplete: 'off', spellcheck: 'false',
            onchange: () => {
              const v = evaluate(clean(inp.value), { angle: g.angle });
              const next = { ...rng, [k]: v };
              if (v == null || !(next.min < next.max) || !(next.step > 0)) { paintRange(); toast('Needs a number, min below max, and a step above 0.', 'warn'); return; }
              Object.assign(rng, next);
              pinned = null; hover = null; resample(); ctx.save(); draw();
            },
          });
          rangeInputs[k] = inp;
          return el('label.gr-win-item', {}, [el('span', { text: `${pName} ${k}`.toUpperCase() }), inp]);
        })) : null;
        function paintRange() { for (const k of Object.keys(rangeInputs)) rangeInputs[k].value = fmt(rng[k]).replace('—', ''); }

        // ---- the window ----
        const winInputs = {};
        const winGrid = el('div.gr-win', {}, ['xmin', 'xmax', 'ymin', 'ymax'].map((k) => {
          const inp = el('input.input', {
            type: 'text', inputmode: 'decimal', 'aria-label': k, autocomplete: 'off', spellcheck: 'false',
            onchange: () => {
              const v = evaluate(clean(inp.value), { angle: g.angle });
              if (v == null) { paintWin(); toast('That is not a number.', 'warn'); return; }
              const next = { ...g.win, [k]: v };
              if (next.xmin >= next.xmax || next.ymin >= next.ymax) { paintWin(); toast('The window needs min below max.', 'warn'); return; }
              g.win = next; g.auto = false; windowMoved();
            },
          });
          winInputs[k] = inp;
          return el('label.gr-win-item', {}, [el('span', { text: k.replace('min', ' min').replace('max', ' max').toUpperCase() }), inp]);
        }));
        function paintWin() { for (const k of Object.keys(winInputs)) winInputs[k].value = fmt(g.win[k]).replace('—', ''); }

        function setWindow(win, keepAuto) {
          g.win = win;
          if (!keepAuto) g.auto = false;
          windowMoved();
        }
        function zoom(factor, cx, cy) {
          const w = g.win;
          const px = cx == null ? (w.xmin + w.xmax) / 2 : cx;
          const py = cy == null ? (w.ymin + w.ymax) / 2 : cy;
          setWindow({
            xmin: px - (px - w.xmin) * factor, xmax: px + (w.xmax - px) * factor,
            ymin: py - (py - w.ymin) * factor, ymax: py + (w.ymax - py) * factor,
          });
        }
        function squareUp() {
          const { w, h } = size();
          if (!w || !h) return;
          const xr = g.win.xmax - g.win.xmin;
          const yc = (g.win.ymin + g.win.ymax) / 2;
          const yr = (xr * h) / w;
          g.win = { ...g.win, ymin: yc - yr / 2, ymax: yc + yr / 2 };
        }
        function fit() {
          if (curved) {
            let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity;
            for (const pts of samples) {
              for (const [, x, y] of pts || []) {
                if (!finite(x) || !finite(y)) continue;
                x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
              }
            }
            if (!finite(x0)) { toast('Nothing to fit yet — type a curve first.', 'warn'); return; }
            const { w, h } = size();
            // Keep the picture true: a circle must stay a circle.
            let hx = Math.max((x1 - x0) / 2, 1e-9) * 1.15; let hy = Math.max((y1 - y0) / 2, 1e-9) * 1.15;
            if (w && h) { hx = Math.max(hx, (hy * w) / h); hy = (hx * h) / w; }
            const cx = (x0 + x1) / 2; const cy = (y0 + y1) / 2;
            setWindow({ xmin: cx - hx, xmax: cx + hx, ymin: cy - hy, ymax: cy + hy });
            return;
          }
          const ys = [];
          const N = 400;
          for (let i = 0; i <= N; i += 1) {
            const x = g.win.xmin + ((g.win.xmax - g.win.xmin) * i) / N;
            for (const c of compiled) { if (c && c.f) { const y = c.f(x); if (finite(y)) ys.push(y); } }
          }
          if (!ys.length) { toast('Nothing to fit yet — type a function first.', 'warn'); return; }
          ys.sort((a, b) => a - b);
          // The middle 90%, so one asymptote does not flatten everything else.
          let lo = ys[Math.floor(ys.length * 0.05)];
          let hi = ys[Math.ceil(ys.length * 0.95) - 1];
          if (lo === hi) { lo -= 1; hi += 1; }
          const pad = (hi - lo) * 0.15;
          setWindow({ ...g.win, ymin: lo - pad, ymax: hi + pad });
        }

        const zoomBar = el('div.gr-zoom', {}, [
          el('button.btn.btn--small', { text: 'Zoom in', onclick: () => zoom(0.5) }),
          el('button.btn.btn--small', { text: 'Zoom out', onclick: () => zoom(2) }),
          el('button.btn.btn--small', { text: 'Standard', onclick: () => { g.win = { xmin: -10, xmax: 10, ymin: -10, ymax: 10 }; g.auto = true; marks = []; windowMoved(); } }),
          el('button.btn.btn--small', { text: 'Square', onclick: () => { squareUp(); g.auto = false; windowMoved(); } }),
          curved ? null : el('button.btn.btn--small', { text: 'Trig', onclick: () => setWindow({ xmin: -2 * Math.PI, xmax: 2 * Math.PI, ymin: -4, ymax: 4 }) }),
          el('button.btn.btn--small', { text: 'Fit', onclick: fit }),
        ]);

        // ---- analyse ----
        const which = el('select.select', { 'aria-label': 'Which line' }, slots.map((_, i) => el('option', { value: String(i), text: nameOf(i) })));
        const lowerIn = el('input.input', { type: 'text', inputmode: 'decimal', value: curved ? '' : '0', placeholder: curved ? 'start' : '', 'aria-label': 'From', autocomplete: 'off' });
        const upperIn = el('input.input', { type: 'text', inputmode: 'decimal', value: curved ? '' : '1', placeholder: curved ? 'end' : '', 'aria-label': 'To', autocomplete: 'off' });
        const list = el('div.gr-results');

        const fnOf = (i) => (compiled[i] && compiled[i].f ? compiled[i].f : null);
        const num = (inp) => evaluate(clean(inp.value), { angle: g.angle });

        function say(text) { results.unshift(text); results.length = Math.min(results.length, 24); paintResults(); }
        function paintResults() {
          Desk.clear(list);
          if (!results.length) {
            list.append(el('p.hint', { text: curved ? 'Slope, length and area appear here.' : 'Zeros, highs and lows, crossings, slope and area appear here.' }));
            return;
          }
          for (const r of results) list.append(el('div.gr-result', { text: r }));
        }

        function analyse(what) {
          const i = Number(which.value);
          const f = fnOf(i);
          const name = nameOf(i);
          const { xmin, xmax } = g.win;
          if (what !== 'cross' && !f) { toast(`${name} has nothing to analyse.`, 'warn'); return; }
          marks = marks.filter((m) => m.kind !== what || m.k !== i);
          let added = 0;
          const add = (x, y, label) => { marks.push({ x, y, k: i, kind: what, label }); say(`${label}: x = ${fmt(x)}, y = ${fmt(y)}`); added += 1; };

          if (what === 'zero') roots(f, xmin, xmax).forEach((x) => add(x, 0, `${name} zero`));
          else if (what === 'min') extrema(f, xmin, xmax, 'min').forEach((x) => add(x, f(x), `${name} minimum`));
          else if (what === 'max') extrema(f, xmin, xmax, 'max').forEach((x) => add(x, f(x), `${name} maximum`));
          else if (what === 'yint') {
            const y = f(0);
            if (finite(y)) add(0, y, `${name} y-intercept`);
          } else if (what === 'cross') {
            const on = slots.map((_, k) => k).filter((k) => fnOf(k));
            for (let a = 0; a < on.length; a += 1) {
              for (let b = a + 1; b < on.length; b += 1) {
                const fa = fnOf(on[a]); const fb = fnOf(on[b]);
                roots((x) => fa(x) - fb(x), xmin, xmax).forEach((x) => {
                  marks.push({ x, y: fa(x), k: on[a], kind: what, label: 'cross' });
                  say(`Y${SUB[on[a]]} meets Y${SUB[on[b]]}: x = ${fmt(x)}, y = ${fmt(fa(x))}`);
                  added += 1;
                });
              }
            }
          }
          if (!added) say(`${what === 'cross' ? 'No crossings' : `No ${({ zero: 'zeros', min: 'minimum', max: 'maximum', yint: 'y-intercept' })[what]}`} in this window.`);
          draw();
        }

        /** dy/dx at parameter p of a curved line, from the curve itself. */
        function curveSlope(f, p) {
          const dx = derivative((q) => f(q).x, p);
          const dy = derivative((q) => f(q).y, p);
          if (dx == null || dy == null) return null;
          return Math.abs(dx) < 1e-9 ? Infinity : dy / dx;
        }
        const slopeText = (d) => (d == null ? '—' : d === Infinity ? 'vertical' : fmt(d));

        function slopeHere() {
          const t = pinned || hover;
          if (!t) { toast('Click the graph to pin a point first.', 'warn'); return; }
          if (curved) {
            const f = fnOf(t.k);
            const p = samples[t.k] && samples[t.k][t.i] && samples[t.k][t.i][0];
            if (!f || p == null) return;
            say(`${nameOf(t.k)} slope at ${pName} = ${fmt(p)}: dy/dx = ${slopeText(curveSlope(f, p))}`);
            return;
          }
          const f = fnOf(t.k);
          if (!f) return;
          const d = derivative(f, t.x);
          say(`Y${SUB[t.k]} slope at x = ${fmt(t.x)}: dy/dx = ${d == null ? '—' : fmt(d)}`);
        }
        function areaBetween() {
          const i = Number(which.value);
          const f = fnOf(i);
          const a = num(lowerIn); const b = num(upperIn);
          if (!f) { toast(`${nameOf(i)} has nothing to add up.`, 'warn'); return; }
          if (a == null || b == null) { toast('Give two numbers for from and to.', 'warn'); return; }
          const v = integrate(f, a, b);
          say(`∫ Y${SUB[i]} from ${fmt(a)} to ${fmt(b)} = ${v == null ? 'not defined here' : fmt(v)}`);
        }
        function totals(what) {
          const i = Number(which.value);
          const pts = samples[i];
          if (!pts || !pts.length) { toast(`${nameOf(i)} has nothing to measure.`, 'warn'); return; }
          const a = lowerIn.value.trim() ? num(lowerIn) : rng.min;
          const b = upperIn.value.trim() ? num(upperIn) : rng.max;
          if (a == null || b == null || a >= b) { toast(`Give ${pName} start below ${pName} end, or leave both empty.`, 'warn'); return; }
          const t = curveTotals(pts, a - 1e-12, b + 1e-12);
          const span = `${pName} from ${fmt(a)} to ${fmt(b)}`;
          say(what === 'length' ? `${nameOf(i)} length, ${span} = ${fmt(t.length)}` : `${nameOf(i)} area swept, ${span} = ${fmt(Math.abs(t.area))}`);
        }

        const btn = (text, fn) => el('button.btn.btn--small', { text, onclick: fn });
        const analyseBox = el('div.gr-analyse', {}, curved ? [
          el('div.gr-analyse-row', {}, [which, btn('Slope at pinned point', slopeHere)]),
          el('div.gr-analyse-row', {}, [el('span.hint', { text: `${pName} from` }), lowerIn, el('span.hint', { text: 'to' }), upperIn]),
          el('div.gr-analyse-row', {}, [btn('Length', () => totals('length')), btn('Area swept', () => totals('area')), btn('Clear', () => { results = []; paintResults(); })]),
          list,
        ] : [
          el('div.gr-analyse-row', {}, [which, btn('Zeros', () => analyse('zero')), btn('Minimum', () => analyse('min')), btn('Maximum', () => analyse('max')), btn('Y-intercept', () => analyse('yint'))]),
          el('div.gr-analyse-row', {}, [btn('Where lines meet', () => analyse('cross')), btn('Slope at pinned point', slopeHere)]),
          el('div.gr-analyse-row', {}, [el('span.hint', { text: '∫ from' }), lowerIn, el('span.hint', { text: 'to' }), upperIn, btn('Area', areaBetween)]),
          el('div.gr-analyse-row', {}, [btn('Clear marks', () => { marks = []; results = []; paintResults(); draw(); })]),
          list,
        ]);

        // ---- the table ----
        const tbl = curved ? g.tblc : g.tbl;
        const tStart = el('input.input', { type: 'text', inputmode: 'decimal', value: String(tbl.start), 'aria-label': 'Table starts at', autocomplete: 'off', onchange: () => { const v = num(tStart); if (v != null) { tbl.start = v; ctx.save(); drawTable(); } else tStart.value = String(tbl.start); } });
        const tStep = el('input.input', { type: 'text', inputmode: 'decimal', value: String(tbl.step), 'aria-label': 'Table step', autocomplete: 'off', onchange: () => { const v = num(tStep); if (v != null && v !== 0) { tbl.step = v; ctx.save(); drawTable(); } else tStep.value = String(tbl.step); } });
        const tHead = el('div.gr-table-head', {}, [el('span.hint', { text: `Start ${curved ? pName : 'x'}` }), tStart, el('span.hint', { text: 'Step' }), tStep]);

        function drawTable() {
          Desk.clear(tableEl);
          const cols = slots.map((_, i) => i).filter((i) => fnOf(i));
          const heads = [el('th', { text: curved ? pName : 'x' })];
          for (const i of cols) {
            if (kind === 'func') heads.push(el('th', { text: `Y${SUB[i]}`, style: { color: CURVES[i] } }));
            else if (kind === 'param') heads.push(el('th', { text: `X${SUB[i]}`, style: { color: CURVES[i] } }), el('th', { text: `Y${SUB[i]}`, style: { color: CURVES[i] } }));
            else heads.push(el('th', { text: nameOf(i), style: { color: CURVES[i] } }));
          }
          const t = el('table.gr-tbl', {}, [el('thead', {}, [el('tr', {}, heads)])]);
          const bodyEl = el('tbody');
          for (let r = 0; r < 60; r += 1) {
            const p = tbl.start + r * tbl.step;
            const cells = [el('td', { text: fmt(Number(p.toPrecision(12))) })];
            for (const i of cols) {
              if (kind === 'func') cells.push(el('td', { text: fmt(fnOf(i)(p)) }));
              else {
                const q = fnOf(i)(p);
                if (kind === 'param') cells.push(el('td', { text: fmt(q.x) }), el('td', { text: fmt(q.y) }));
                else cells.push(el('td', { text: fmt(q.r) }));
              }
            }
            bodyEl.append(el('tr', {}, cells));
          }
          t.append(bodyEl);
          tableEl.append(cols.length ? t : el('p.hint', { text: 'Type something on the left to fill the table.' }));
        }

        const viewSeg = el('div.seg', {}, [
          el('button.seg-btn', { text: 'Graph', onclick: () => setView('graph') }),
          el('button.seg-btn', { text: 'Table', onclick: () => setView('table') }),
        ]);
        function setView(v) {
          g.view = v; ctx.save(); paintView();
        }
        function paintView() {
          viewSeg.children[0].classList.toggle('is-on', g.view === 'graph');
          viewSeg.children[1].classList.toggle('is-on', g.view === 'table');
          Desk.clear(view);
          if (g.view === 'graph') { view.append(stageEl); view.append(el('p.hint.gr-tip', { text: 'Drag to move, scroll to zoom, click to pin a point, then ← → to walk along the line.' })); draw(); }
          else { view.append(tHead, tableEl); drawTable(); }
        }

        // ---- the canvas ----
        function size() { return { w: cv.clientWidth, h: cv.clientHeight }; }

        function pointOn(px) {
          const { w } = size();
          return g.win.xmin + (px / w) * (g.win.xmax - g.win.xmin);
        }
        const toScreenX = (x) => ((x - g.win.xmin) / (g.win.xmax - g.win.xmin)) * size().w;
        const toScreenY = (y) => ((g.win.ymax - y) / (g.win.ymax - g.win.ymin)) * size().h;

        /** func: the line nearest (x, py). curved: the sampled point nearest the pointer. */
        function nearest(px, py) {
          if (curved) {
            let best = null;
            samples.forEach((pts, k) => {
              if (!pts) return;
              for (let i = 0; i < pts.length; i += 1) {
                const q = pts[i];
                if (!finite(q[1]) || !finite(q[2])) continue;
                const d = Math.hypot(toScreenX(q[1]) - px, toScreenY(q[2]) - py);
                if (!best || d < best.d) best = { k, i, d };
              }
            });
            return best && best.d < 40 ? best : null;
          }
          const { h } = size();
          const x = pointOn(px);
          const yr = g.win.ymax - g.win.ymin;
          let best = null;
          compiled.forEach((c, k) => {
            if (!c || !c.f) return;
            const y = c.f(x);
            if (!finite(y)) return;
            const d = Math.abs(((g.win.ymax - y) / yr) * h - py);
            if (!best || d < best.d) best = { k, d, x };
          });
          return best;
        }
        const traceOf = (near) => (curved ? { k: near.k, i: near.i } : { x: near.x, k: near.k });

        function draw() {
          if (g.view !== 'graph') return;
          const { w, h } = size();
          if (!w || !h) return;
          if (g.auto) squareUp();
          paintWin();
          if (curved) paintRange();
          const dpr = window.devicePixelRatio || 1;
          if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
          const c = cv.getContext('2d');
          c.setTransform(dpr, 0, 0, dpr, 0, 0);
          c.clearRect(0, 0, w, h);
          const cs = getComputedStyle(cv);
          const ink = cs.getPropertyValue('--ink').trim() || '#222';
          const muted = cs.getPropertyValue('--muted').trim() || '#666';
          const line = cs.getPropertyValue('--line').trim() || '#ccc';
          const surface = cs.getPropertyValue('--surface').trim() || '#fff';
          c.fillStyle = surface; c.fillRect(0, 0, w, h);

          const { xmin, xmax, ymin, ymax } = g.win;
          const xr = xmax - xmin; const yr = ymax - ymin;
          const X = (x) => ((x - xmin) / xr) * w;
          const Y = (y) => ((ymax - y) / yr) * h;

          // grid and axes
          const sx = niceStep((xr / w) * 90);
          const sy = niceStep((yr / h) * 70);
          c.lineWidth = 1; c.font = '11px "IBM Plex Mono", monospace'; c.fillStyle = muted;
          c.strokeStyle = line;
          c.beginPath();
          for (let x = Math.ceil(xmin / sx) * sx; x <= xmax; x += sx) { const px = Math.round(X(x)) + 0.5; c.moveTo(px, 0); c.lineTo(px, h); }
          for (let y = Math.ceil(ymin / sy) * sy; y <= ymax; y += sy) { const py = Math.round(Y(y)) + 0.5; c.moveTo(0, py); c.lineTo(w, py); }
          c.stroke();
          const ax = Math.min(Math.max(X(0), 0), w);
          const ay = Math.min(Math.max(Y(0), 0), h);
          c.strokeStyle = ink; c.lineWidth = 1.5;
          c.beginPath(); c.moveTo(0, ay); c.lineTo(w, ay); c.moveTo(ax, 0); c.lineTo(ax, h); c.stroke();
          c.fillStyle = muted;
          c.textAlign = 'center'; c.textBaseline = 'top';
          for (let x = Math.ceil(xmin / sx) * sx; x <= xmax; x += sx) {
            if (Math.abs(x) < sx / 2) continue;
            c.fillText(fmt(Number(x.toPrecision(10))), X(x), Math.min(ay + 4, h - 14));
          }
          c.textAlign = 'right'; c.textBaseline = 'middle';
          for (let y = Math.ceil(ymin / sy) * sy; y <= ymax; y += sy) {
            if (Math.abs(y) < sy / 2) continue;
            c.fillText(fmt(Number(y.toPrecision(10))), Math.max(ax - 5, 30), Y(y));
          }

          c.lineWidth = 2.25; c.lineJoin = 'round';
          if (curved) {
            // A curve is a polyline through its samples, broken wherever a
            // sample has no number (a negative square root, say).
            samples.forEach((pts, k) => {
              if (!pts) return;
              c.strokeStyle = CURVES[k];
              c.beginPath();
              let pen = false;
              for (const [, x, y] of pts) {
                if (!finite(x) || !finite(y)) { pen = false; continue; }
                const px = Math.max(-1e6, Math.min(1e6, X(x))); const py = Math.max(-1e6, Math.min(1e6, Y(y)));
                if (!pen) { c.moveTo(px, py); pen = true; } else c.lineTo(px, py);
              }
              c.stroke();
            });
          } else {
            // a gap wherever there is no number, and wherever a line would
            // have to leap from off the top of the screen to off the bottom.
            const off = (py) => (py < 0 ? -1 : py > h ? 1 : 0);
            compiled.forEach((comp, k) => {
              if (!comp || !comp.f) return;
              c.strokeStyle = CURVES[k];
              c.beginPath();
              let pen = false; let prev = null;
              for (let px = 0; px <= w; px += 1) {
                const y = comp.f(xmin + (px / w) * xr);
                if (!finite(y)) { pen = false; prev = null; continue; }
                const py = Math.max(-1e6, Math.min(1e6, Y(y)));
                if (pen && prev !== null && off(py) * off(prev) === -1) pen = false;
                if (!pen) { c.moveTo(px, py); pen = true; } else c.lineTo(px, py);
                prev = py;
              }
              c.stroke();
            });
          }

          // marks from Analyse
          for (const m of marks) {
            if (m.x < xmin || m.x > xmax) continue;
            c.strokeStyle = ink; c.fillStyle = surface; c.lineWidth = 2;
            c.beginPath(); c.arc(X(m.x), Y(m.y), 5, 0, Math.PI * 2); c.fill(); c.stroke();
          }

          // the traced point
          const t = pinned || hover;
          const readRows = [];
          if (t && curved) {
            const f = fnOf(t.k);
            const q = samples[t.k] && samples[t.k][t.i];
            if (f && q && finite(q[1]) && finite(q[2])) {
              c.fillStyle = CURVES[t.k]; c.strokeStyle = surface; c.lineWidth = 2;
              c.beginPath(); c.arc(X(q[1]), Y(q[2]), 6, 0, Math.PI * 2); c.fill(); c.stroke();
              const parts = [`${pName} = ${fmt(q[0])}`];
              if (kind === 'polar') parts.push(`r = ${fmt(f(q[0]).r)}`);
              parts.push(`x = ${fmt(q[1])}`, `y = ${fmt(q[2])}`, `dy/dx = ${slopeText(curveSlope(f, q[0]))}`);
              readRows.push([nameOf(t.k), parts, CURVES[t.k]]);
            }
          } else if (t) {
            const f = fnOf(t.k);
            const y = f ? f(t.x) : NaN;
            if (f && finite(y)) {
              c.fillStyle = CURVES[t.k]; c.strokeStyle = surface; c.lineWidth = 2;
              c.beginPath(); c.arc(X(t.x), Y(y), 6, 0, Math.PI * 2); c.fill(); c.stroke();
              const d = derivative(f, t.x);
              readRows.push([`Y${SUB[t.k]}`, [`x = ${fmt(t.x)}`, `y = ${fmt(y)}`, d == null ? '' : `dy/dx = ${fmt(d)}`], CURVES[t.k]]);
            }
          }
          Desk.clear(read);
          read.classList.toggle('is-shown', readRows.length > 0);
          for (const [name, parts, colour] of readRows) {
            read.append(el('span.gr-read-name', { text: name, style: { color: colour } }), ...parts.map((p) => el('span', { text: p })));
            if (pinned) read.append(el('span.gr-read-pin', { text: 'pinned' }));
          }
        }

        function windowMoved() { ctx.save(); draw(); }
        function changed() {
          recompile();
          rows.forEach((r) => r.check());
          ctx.save();
          if (g.view === 'graph') draw(); else drawTable();
        }

        let dragging = null;
        cv.addEventListener('pointerdown', (e) => {
          cv.setPointerCapture(e.pointerId);
          dragging = { x0: e.clientX, y0: e.clientY, win: { ...g.win }, moved: false };
        });
        cv.addEventListener('pointermove', (e) => {
          const r = cv.getBoundingClientRect();
          if (dragging) {
            const dx = e.clientX - dragging.x0; const dy = e.clientY - dragging.y0;
            if (!dragging.moved && Math.hypot(dx, dy) < 4) return;
            dragging.moved = true;
            const xr = dragging.win.xmax - dragging.win.xmin; const yr = dragging.win.ymax - dragging.win.ymin;
            g.win = {
              xmin: dragging.win.xmin - (dx / r.width) * xr, xmax: dragging.win.xmax - (dx / r.width) * xr,
              ymin: dragging.win.ymin + (dy / r.height) * yr, ymax: dragging.win.ymax + (dy / r.height) * yr,
            };
            g.auto = false;
            draw();
            return;
          }
          if (pinned) return;
          const near = nearest(e.clientX - r.left, e.clientY - r.top);
          hover = near ? traceOf(near) : null;
          draw();
        });
        cv.addEventListener('pointerleave', () => { if (!dragging && !pinned) { hover = null; draw(); } });
        cv.addEventListener('pointerup', (e) => {
          const was = dragging; dragging = null;
          if (!was) return;
          if (was.moved) { ctx.save(); return; }
          const r = cv.getBoundingClientRect();
          const px = e.clientX - r.left; const py = e.clientY - r.top;
          const near = nearest(px, py);
          let close = false;
          if (pinned) {
            if (curved) {
              const q = samples[pinned.k] && samples[pinned.k][pinned.i];
              close = !!q && Math.hypot(toScreenX(q[1]) - px, toScreenY(q[2]) - py) < 10;
            } else close = Math.abs(toScreenX(pinned.x) - px) < 8;
          }
          if (pinned && close) pinned = null;
          else if (near) { pinned = traceOf(near); hover = null; }
          draw();
        });
        cv.addEventListener('wheel', (e) => {
          e.preventDefault();
          const r = cv.getBoundingClientRect();
          const cx = pointOn(e.clientX - r.left);
          const cy = g.win.ymax - ((e.clientY - r.top) / r.height) * (g.win.ymax - g.win.ymin);
          zoom(e.deltaY > 0 ? 1.18 : 1 / 1.18, cx, cy);
        }, { passive: false });
        cv.addEventListener('keydown', (e) => {
          if (!pinned && !hover) return;
          const t = pinned || hover;
          const on = slots.map((_, k) => k).filter((k) => fnOf(k));
          const switchLine = () => {
            const at = on.indexOf(t.k);
            t.k = on[(at + (e.key === 'ArrowUp' ? 1 : on.length - 1) + (at < 0 ? 1 : 0)) % on.length];
          };
          if (curved) {
            const pts = samples[t.k] || [];
            const stride = e.shiftKey ? 10 : 1;
            if (e.key === 'ArrowLeft') t.i = Math.max(0, t.i - stride);
            else if (e.key === 'ArrowRight') t.i = Math.min(pts.length - 1, t.i + stride);
            else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && on.length) { switchLine(); t.i = Math.min(t.i, (samples[t.k] || []).length - 1); }
            else if (e.key === 'Escape') { pinned = null; hover = null; } else return;
          } else {
            const { w } = size();
            const step = ((g.win.xmax - g.win.xmin) / w) * (e.shiftKey ? 10 : 1);
            if (e.key === 'ArrowLeft') t.x -= step;
            else if (e.key === 'ArrowRight') t.x += step;
            else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && on.length) switchLine();
            else if (e.key === 'Escape') { pinned = null; hover = null; } else return;
          }
          if (pinned !== null || (e.key !== 'Escape')) pinned = pinned || t;
          e.preventDefault();
          e.stopPropagation();
          draw();
        });

        const ro = new ResizeObserver(() => draw());
        ro.observe(cv);
        cleanups.push(() => ro.disconnect());

        recompile();

        host.append(el('div.gr', {}, [
          el('div.gr-side', {}, [
            kindSeg,
            el('div.section-title', { text: kind === 'func' ? 'Functions' : kind === 'param' ? 'Parametric curves' : 'Polar curves' }),
            ...rows.map((r) => r.row),
            insertChips,
            curved ? el('div.section-title', { text: `Range of ${pName}` }) : null,
            rangeGrid,
            el('div.section-title', { text: 'Window' }),
            winGrid,
            zoomBar,
            el('div.section-title', { text: 'Analyse' }),
            analyseBox,
          ]),
          el('div.gr-main', {}, [el('div.gr-bar', {}, [viewSeg]), view]),
        ]));

        paintResults();
        paintWin();
        if (curved) paintRange();
        paintView();
        rows.forEach((r) => r.check());
        if (!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches) && !slots.some((f) => (f.expr || f.x || f.y))) rows[0].inps[0].focus();

        buildGraph = {
          angleChanged() { recompile(); if (g.view === 'graph') draw(); else drawTable(); },
        };
      }

      // ================= the shell =================

      function build() {
        for (const fn of cleanups.splice(0)) fn();
        buildGraph = null;
        Desk.clear(body);
        if (!big) { buildCalc(body); return; }

        const unit = () => (s.mode === 'graph' ? s.graph.angle : s.angle);
        const label = () => (unit() === 'rad' ? 'Radians' : 'Degrees');
        const angle = el('button.btn.btn--small.calc-angle', {
          'aria-label': 'Switch between degrees and radians',
          onclick: () => {
            const next = unit() === 'rad' ? 'deg' : 'rad';
            if (s.mode === 'graph') {
              // θ is in the current unit, so its range has to travel with it
              // or a full turn would become 6.28 degrees.
              const k = next === 'deg' ? 180 / Math.PI : Math.PI / 180;
              const th = s.graph.th;
              for (const key of ['min', 'max', 'step']) th[key] = Number((th[key] * k).toPrecision(10));
              s.graph.angle = next;
            } else s.angle = next;
            angle.textContent = label();
            ctx.save();
            paintMain();
            if (buildGraph) buildGraph.angleChanged();
          },
        }, label());
        const pick = (mode) => () => { s.mode = mode; ctx.save(); build(); };
        const seg = el('div.seg', {}, [
          el('button.seg-btn' + (s.mode === 'sci' ? '.is-on' : ''), { text: 'Scientific', onclick: pick('sci') }),
          el('button.seg-btn' + (s.mode === 'graph' ? '.is-on' : ''), { text: 'Graphing', onclick: pick('graph') }),
        ]);
        const inner = el('div.calc-inner');
        body.append(el('div.calc-modebar', {}, [seg, angle]), inner);
        if (s.mode === 'graph') buildGraphing(inner); else buildCalc(inner);
      }

      build();

      return {
        destroy() { for (const fn of cleanups.splice(0)) fn(); },
        frame() {},
        tick() {},
      };
    },

    // Pure, and the only place a string of characters turns into a number —
    // so it is exported and tested directly rather than through the buttons.
    _evaluate: evaluate,
    _parse: parse,
    _compileY: compileY,
    _compileCurve: compileCurve,
    _sampleCurve: sampleCurve,
    _curveTotals: curveTotals,
    _show: show,
    _fmt: fmt,
    _clean: clean,
    _cleanPaste: cleanPaste,
    _roots: roots,
    _extrema: extrema,
    _derivative: derivative,
    _integrate: integrate,
    _niceStep: niceStep,
  });
}(window.Desk));
