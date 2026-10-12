/* global fabric */
'use strict';

// Use pointer events so we can tell fingers (pan/pinch) apart from pens and mice
if (window.fabric) fabric.enablePointerEvents = true;

// Font used for text the user types. It must NOT be Bricolage Grotesque: that
// variable display font is measured ~5% narrower per character by Fabric than
// the browser renders it, so the typing caret drifts left of the glyphs. Plain
// system fonts (Arial et al.) measure exactly as they render. Bricolage stays
// the UI/CSS font — this only governs on-canvas text objects.
const TEXT_FONT = 'Arial';

function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const CHART_COLORS = ['#0A7C6E', '#F59E0B', '#FF6B35', '#2563EB', '#7C3AED', '#DB2777', '#0891B2', '#65A30D'];
const FONT = 'Bricolage Grotesque, Arial, sans-serif';

// A "nice" axis step (1/2/5 × 10^k) giving ~8 divisions across the span
function niceStep(span) {
  const raw = span / 8;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return step * mag;
}

function txt(s, opts) {
  return new fabric.Text(String(s), Object.assign({ fontFamily: FONT, fill: '#1F2937' }, opts));
}

// Fit a canvas viewport so all objects are visible
function fitToContent(canvas, pad = 40) {
  const objs = canvas.getObjects();
  const w = canvas.getWidth();
  const h = canvas.getHeight();
  if (!objs.length) {
    canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
    canvas.requestRenderAll();
    return;
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  objs.forEach((o) => {
    const r = o.getBoundingRect(true, true);
    minX = Math.min(minX, r.left);
    minY = Math.min(minY, r.top);
    maxX = Math.max(maxX, r.left + r.width);
    maxY = Math.max(maxY, r.top + r.height);
  });
  const zoom = Math.min((w - pad * 2) / Math.max(maxX - minX, 1), (h - pad * 2) / Math.max(maxY - minY, 1), 3);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  canvas.setViewportTransform([zoom, 0, 0, zoom, w / 2 - cx * zoom, h / 2 - cy * zoom]);
  canvas.requestRenderAll();
}

function downloadDataURL(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const POLY_SHAPES = ['diamond', 'pentagon', 'hexagon', 'star'];
const SHAPE_TOOLS = ['line', 'arrow', 'rect', 'ellipse', 'triangle', ...POLY_SHAPES];

// Custom/state props that must survive serialization (document pages are locked
// images; oid anchors comments; erasable gates the partial eraser)
const PERSIST_PROPS = ['selectable', 'evented', 'docPage', 'docMargin', 'hoverCursor', 'isCurve', 'cropX', 'cropY', 'erasable', 'oid'];

// Unit-square outlines for the polygon shapes (scaled during drag)
function unitPoints(kind) {
  const ring = (n, rot = -Math.PI / 2) => Array.from({ length: n }, (_, i) => ({
    x: 0.5 + 0.5 * Math.cos(rot + (i * 2 * Math.PI) / n),
    y: 0.5 + 0.5 * Math.sin(rot + (i * 2 * Math.PI) / n),
  }));
  if (kind === 'diamond') return [{ x: 0.5, y: 0 }, { x: 1, y: 0.5 }, { x: 0.5, y: 1 }, { x: 0, y: 0.5 }];
  if (kind === 'pentagon') return ring(5);
  if (kind === 'hexagon') return ring(6, 0);
  if (kind === 'star') {
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? 0.5 : 0.21;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      pts.push({ x: 0.5 + r * Math.cos(a), y: 0.5 + r * Math.sin(a) });
    }
    return pts;
  }
  return [];
}

// ----- shape-beautify geometry helpers -----
function _distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
// Ramer–Douglas–Peucker: simplify a polyline, keeping corners above tolerance
function _rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  let maxD = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = _distToSeg(pts[i], pts[0], pts[pts.length - 1]);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > eps) {
    const left = _rdp(pts.slice(0, idx + 1), eps);
    const right = _rdp(pts.slice(idx), eps);
    return left.slice(0, -1).concat(right);
  }
  return [pts[0], pts[pts.length - 1]];
}
// Classify a freehand stroke's anchor points as 'line' | 'rect' | 'triangle' | 'ellipse' | null
function _classifyStroke(pts) {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
  const diag = Math.hypot(w, h);
  const first = pts[0], last = pts[pts.length - 1];
  const gap = Math.hypot(last.x - first.x, last.y - first.y);
  const closed = gap < 0.25 * diag;
  if (!closed) {
    let maxd = 0;
    for (const p of pts) maxd = Math.max(maxd, _distToSeg(p, first, last));
    const span = Math.hypot(last.x - first.x, last.y - first.y);
    if (span > 0 && maxd < 0.12 * span) return { kind: 'line', a: first, b: last };
    return null; // an open, non-straight scribble — leave it alone
  }
  const simp = _rdp(pts, 0.05 * diag);
  let corners = simp.length - 1; // closed loop repeats the start point
  if (corners <= 2) corners = 3;
  if (corners === 3) return { kind: 'triangle' };
  if (corners === 4) return { kind: 'rect' };
  return { kind: 'ellipse' };
}

class Whiteboard {
  constructor(canvasId, container, { onChange, onViewChange, onSelection, onModeChange } = {}) {
    this.container = container;
    this.canvas = new fabric.Canvas(canvasId, {
      backgroundColor: '#ffffff',
      preserveObjectStacking: true,
      stopContextMenu: true,
    });
    this.onChange = onChange || (() => {});
    // Wrap the view-change callback so that, in document mode, every pan/zoom
    // is fenced to the document bounds before the app reacts — this is what
    // keeps a PDF from feeling like an infinite, chaotic canvas.
    const viewCb = onViewChange || (() => {});
    this.onViewChange = () => { if (this._docMode) this._constrainView(); viewCb(); };
    this._docMode = false; // true once the board holds a confined document
    this.onSelection = onSelection || (() => {});
    this.onModeChange = onModeChange || (() => {});
    this.onOps = null; // set via enableOps(cb): per-object sync instead of whole-board
    this._ops = [];
    this._opsTimer = null;
    this._needFullSync = false;
    this._lastThumbTs = 0;

    this.tool = 'select';
    this.handMode = 'board'; // 'board' pans, 'objects' manipulates
    this.eraserMode = 'object'; // 'object' removes whole things, 'partial' rubs out strokes
    this.color = '#1e293b';
    this.strokeWidth = 4;
    this.opacity = 1;
    this.lineStyle = 'solid'; // 'solid' | 'dashed' | 'dotted'
    this.fillShapes = false;
    this._clipboard = null;
    // On touch devices, fingers pan/pinch the board while pens and mice use the tools
    this.fingerPans = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    this._crop = null;      // active crop session { img, rect }
    this._curveEdit = null; // active curve-edit session

    this._undo = [];
    this._redo = [];
    this._internal = false;   // suppress commit during programmatic / in-progress edits
    this._changeTimer = null;
    this._drawing = null;     // in-progress shape
    this._curve = null;       // in-progress curve
    this._panning = false;
    this._erasing = false;
    this._erasedAny = false;

    this._bindEvents();
    this._bindTouchNav();
    this._bindButtonPan();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('scroll', () => this.canvas.calcOffset(), true);
    this._observeSize();
    this._snapshot();
  }

  // ---------- touch navigation: fingers pan, two fingers pinch-zoom ----------

  // Right-drag (or middle-drag) pans the board from ANY tool — the usual
  // convention in design apps. Handled in the capture phase so Fabric never
  // sees the press and no stray stroke or selection starts.
  _bindButtonPan() {
    const el = this.canvas.upperCanvasEl;
    let from = null;

    const down = (e) => {
      if (e.button !== 2 && e.button !== 1) return; // right or middle only
      if (this._crop || this._curveEdit) return;    // leave active edit sessions alone
      e.preventDefault();
      e.stopImmediatePropagation();
      from = { x: e.clientX, y: e.clientY };
      this._buttonPanning = true;
      el.style.cursor = 'grabbing';
      try { el.setPointerCapture(e.pointerId); } catch { /* not fatal */ }
    };

    const move = (e) => {
      if (!from) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.canvas.relativePan(new fabric.Point(e.clientX - from.x, e.clientY - from.y));
      from = { x: e.clientX, y: e.clientY };
      this.onViewChange();
    };

    const up = (e) => {
      if (!from) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      from = null;
      this._buttonPanning = false;
      el.style.cursor = '';
      try { el.releasePointerCapture(e.pointerId); } catch { /* not fatal */ }
    };

    el.addEventListener('pointerdown', down, true);
    el.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    // belt and braces: never show the browser menu on the drawing surface
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _bindTouchNav() {
    const el = this.canvas.upperCanvasEl;
    const active = new Map(); // pointerId -> {x, y}
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' || !this.fingerPans) return;
      e.preventDefault();
      e.stopImmediatePropagation(); // fabric never sees finger touches in this mode
      active.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }, { capture: true });

    const move = (e) => {
      if (!active.has(e.pointerId)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const c = this.canvas;
      const prev = active.get(e.pointerId);
      const cur = { x: e.clientX, y: e.clientY };
      if (active.size === 1) {
        c.relativePan(new fabric.Point(cur.x - prev.x, cur.y - prev.y));
      } else if (active.size === 2) {
        const [idA, idB] = [...active.keys()];
        const otherId = idA === e.pointerId ? idB : idA;
        const other = active.get(otherId);
        const d0 = Math.hypot(prev.x - other.x, prev.y - other.y) || 1;
        const d1 = Math.hypot(cur.x - other.x, cur.y - other.y) || 1;
        const rect = el.getBoundingClientRect();
        const mid = new fabric.Point((cur.x + other.x) / 2 - rect.left, (cur.y + other.y) / 2 - rect.top);
        const zoom = Math.min(8, Math.max(0.1, c.getZoom() * (d1 / d0)));
        c.zoomToPoint(mid, zoom);
        c.relativePan(new fabric.Point((cur.x - prev.x) / 2, (cur.y - prev.y) / 2));
      }
      active.set(e.pointerId, cur);
      c.requestRenderAll();
      this.onViewChange();
    };
    const up = (e) => { active.delete(e.pointerId); };
    window.addEventListener('pointermove', move, { capture: true, passive: false });
    window.addEventListener('pointerup', up, { capture: true });
    window.addEventListener('pointercancel', up, { capture: true });
  }

  setFingerPans(on) {
    this.fingerPans = !!on;
  }

  resize() {
    this.canvas.setDimensions({
      width: this.container.clientWidth,
      height: this.container.clientHeight,
    });
    // recalc the cached DOM offset Fabric uses to map pointer -> canvas coords,
    // otherwise clicks (and the text caret) land in the wrong place after the
    // toolbar wraps or the students panel expands without a window resize
    this.canvas.calcOffset();
    this.canvas.requestRenderAll();
  }

  // Any change to the canvas element's box (panel expand, top-bar wrap, etc.)
  // must refresh the pointer offset; a ResizeObserver catches them all.
  _observeSize() {
    if (typeof ResizeObserver === 'undefined') return;
    let raf = null;
    const ro = new ResizeObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = null; this.resize(); });
    });
    ro.observe(this.container);
  }

  // ---------- object-level sync ----------
  // Each local change becomes a tiny op {t:'add'|'mod'|'del'|'clear'|'full', ...}
  // instead of re-sending the entire board JSON on every stroke.

  enableOps(cb) {
    this.onOps = cb;
  }

  _ser(o) {
    return o.toObject(PERSIST_PROPS);
  }

  _queueOp(op) {
    if (!this.onOps || this._internal) return;
    this._ops.push(op);
    this._scheduleOpsFlush();
  }

  _markFullSync() {
    if (!this.onOps) return;
    this._needFullSync = true;
    this._scheduleOpsFlush();
  }

  _scheduleOpsFlush() {
    if (this._opsTimer) return;
    this._opsTimer = setTimeout(() => {
      this._opsTimer = null;
      this.flushOpsNow();
    }, 200);
  }

  flushOpsNow() {
    if (!this.onOps) return;
    clearTimeout(this._opsTimer);
    this._opsTimer = null;
    if (this.loading) {
      // mid-enliven the canvas is partial — a 'full' sync now would overwrite
      // the stored board with a half-loaded one; retry once loading settles
      this._scheduleOpsFlush();
      return;
    }
    let ops;
    if (this._needFullSync) {
      this._needFullSync = false;
      this._ops = [];
      ops = [{ t: 'full', json: this.getJSON() }];
    } else {
      if (!this._ops.length) return;
      // collapse repeated mods of the same object into the last one
      const seen = new Set();
      ops = [];
      for (let i = this._ops.length - 1; i >= 0; i--) {
        const op = this._ops[i];
        const key = op.t === 'mod' && op.o && op.o.oid ? 'mod:' + op.o.oid : 'i' + i;
        if (seen.has(key)) continue;
        seen.add(key);
        ops.unshift(op);
      }
      this._ops = [];
    }
    let thumb = null;
    if (Date.now() - this._lastThumbTs > 2500) {
      this._lastThumbTs = Date.now();
      thumb = this.getThumb();
    }
    this.onOps(ops, thumb);
  }

  // Apply remote ops to this canvas without echoing them back
  applyOps(ops, done) {
    const c = this.canvas;
    // Tag this apply with the current load generation. If the board is switched
    // (loadJSON bumps _loadSeq) while a slow enliven callback is in flight, we
    // bail instead of adding the old board's object onto the new canvas.
    let seq = (this._loadSeq = this._loadSeq || 0);
    const finish = () => {
      c.requestRenderAll();
      this._internal = false;
      this._snapshot();
      if (done) done();
    };
    this._internal = true;
    const step = (i) => {
      if (this._loadSeq !== seq) { this._internal = false; return; } // a board switch superseded us
      if (i >= ops.length) return finish();
      const op = ops[i];
      if (op.t === 'full') {
        // loadJSON bumps _loadSeq for its own load; adopt it so we stay current
        return this.loadJSON(op.json, () => { seq = this._loadSeq; this._internal = true; step(i + 1); });
      }
      if (op.t === 'clear') {
        c.getObjects().slice().forEach((o) => c.remove(o));
        return step(i + 1);
      }
      if (op.t === 'del') {
        const o = op.oid && this.findByOid(op.oid);
        if (o) c.remove(o);
        return step(i + 1);
      }
      if ((op.t === 'add' || op.t === 'mod') && op.o) {
        // don't stomp text the local user is typing in right now
        const activeText = this.getActiveText && this.getActiveText();
        if (activeText && activeText.isEditing && activeText.oid === op.o.oid) return step(i + 1);
        return fabric.util.enlivenObjects([op.o], (objs) => {
          if (this._loadSeq !== seq) { this._internal = false; return; } // switched mid-enliven
          const nu = objs[0];
          if (nu) {
            const old = op.o.oid ? this.findByOid(op.o.oid) : null;
            if (old) {
              const idx = c.getObjects().indexOf(old);
              c.remove(old);
              c.insertAt(nu, Math.max(0, idx));
            } else {
              c.add(nu);
            }
            if (nu.type === 'i-text' || nu.type === 'text') {
              nu.setControlsVisibility({ ml: false, mr: false, mt: false, mb: false });
            }
          }
          step(i + 1);
        });
      }
      step(i + 1);
    };
    step(0);
  }

  // ---------- change tracking / undo ----------

  commit() {
    if (this._internal) return;
    this._snapshot();
    this._emitChange();
  }

  // Start a fresh undo history whose baseline is what's on the canvas now.
  // Called at every board boundary (opening, creating, reloading a board):
  // one shared stack across boards let Undo on a new/other board restore the
  // PREVIOUS board's content — and the full sync then saved it into that board,
  // even a student's board a teacher had opened.
  resetHistory() {
    this._undo = [JSON.stringify(this.canvas.toJSON(PERSIST_PROPS))];
    this._redo = [];
  }

  _snapshot() {
    const json = JSON.stringify(this.canvas.toJSON(PERSIST_PROPS));
    if (this._undo[this._undo.length - 1] === json) return;
    this._undo.push(json);
    // Bound the stack by BOTH depth and total bytes. On boards with imported
    // document pages each snapshot is many MB, so a 60-deep count cap alone let
    // the undo history grow into hundreds of MB and crash low-end tabs.
    let bytes = this._undo.reduce((n, s) => n + s.length, 0);
    while (this._undo.length > 1 && (this._undo.length > 60 || bytes > 24 * 1024 * 1024)) {
      bytes -= this._undo.shift().length;
    }
    this._redo.length = 0;
  }

  _emitChange() {
    clearTimeout(this._changeTimer);
    this._changeTimer = setTimeout(() => {
      this.onChange(this.getJSON(), this.getThumb());
    }, 400);
  }

  undo() {
    if (this._undo.length < 2) return;
    this._redo.push(this._undo.pop());
    this._loadString(this._undo[this._undo.length - 1]);
    this._markFullSync();
  }

  redo() {
    if (!this._redo.length) return;
    const s = this._redo.pop();
    this._undo.push(s);
    this._loadString(s);
    this._markFullSync();
  }

  _loadString(s) {
    this._internal = true;
    this.loading = true;
    this.canvas.loadFromJSON(s, () => {
      this.canvas.backgroundColor = '#ffffff';
      this.canvas.renderAll();
      this._internal = false;
      this.loading = false;
      this._emitChange();
    });
  }

  getJSON() {
    return this.canvas.toJSON(PERSIST_PROPS);
  }

  loadJSON(json, cb, onProgress) {
    this._internal = true;
    // While a board (possibly a huge one, e.g. 40 PDF page images) is
    // enlivening, the canvas is empty or partial. `loading` lets callers
    // refuse to treat that transient state as the board's real content.
    this.loading = true;
    // Every load gets a sequence number so a newer load supersedes a slower
    // older one instead of the two interleaving objects onto the canvas.
    const seq = (this._loadSeq = (this._loadSeq || 0) + 1);
    const objs = (json && json.objects) || [];

    // Small boards: fabric's native path, no ceremony.
    if (!onProgress || objs.length < 10) {
      this.canvas.loadFromJSON(json, () => {
        if (this._loadSeq !== seq) return;
        this.canvas.backgroundColor = '#ffffff';
        this.canvas.getObjects().forEach((o) => {
          if (o.type === 'i-text' || o.type === 'text') {
            o.setControlsVisibility({ ml: false, mr: false, mt: false, mb: false });
          }
        });
        this.canvas.renderAll();
        this._internal = false;
        this.loading = false;
        this.resetHistory(); // a loaded board starts its own undo history
        this._applyDocMode();
        if (cb) cb();
      });
      return;
    }

    // Big boards (imported documents etc.): enliven in small batches so the
    // page stays responsive, content paints progressively, and the caller can
    // show a real progress bar — vital feedback on slow classroom wifi.
    const c = this.canvas;
    c.getObjects().slice().forEach((o) => c.remove(o));
    c.backgroundColor = '#ffffff';
    const total = objs.length;
    const BATCH = 4;
    onProgress(0, total);
    const step = (i) => {
      if (this._loadSeq !== seq) return; // a newer load took over
      if (i >= total) {
        c.renderAll();
        this._internal = false;
        this.loading = false;
        this.resetHistory(); // a loaded board starts its own undo history
        this._applyDocMode();
        if (cb) cb();
        return;
      }
      fabric.util.enlivenObjects(objs.slice(i, i + BATCH), (enlivened) => {
        if (this._loadSeq !== seq) return;
        this._internal = true; // stay gated across async callbacks
        enlivened.forEach((o) => {
          if (!o) return;
          c.add(o);
          if (o.type === 'i-text' || o.type === 'text') {
            o.setControlsVisibility({ ml: false, mr: false, mt: false, mb: false });
          }
        });
        onProgress(Math.min(i + BATCH, total), total);
        c.requestRenderAll();
        setTimeout(() => step(i + BATCH), 0); // yield so the UI can breathe
      });
    };
    step(0);
  }

  getThumb() {
    const c = this.canvas;
    return c.toDataURL({ format: 'jpeg', quality: 0.6, multiplier: Math.min(1, 280 / c.getWidth()) });
  }

  // ---------- tools ----------

  setTool(t) {
    this.finishCurveEdit(true);
    this.applyCrop();
    this._cancelCurve();
    this.tool = t;
    this._applyToolConfig();
  }

  // The hand tool's two modes: 'board' pans the viewport, 'objects' selects/manipulates
  setHandMode(mode) {
    this.handMode = mode === 'objects' ? 'objects' : 'board';
    if (this.tool === 'pan') this._applyToolConfig();
  }

  _applyToolConfig() {
    const t = this.tool;
    const c = this.canvas;
    const partialErase = t === 'eraser' && this.eraserMode === 'partial' && fabric.EraserBrush;
    c.isDrawingMode = t === 'pen' || t === 'highlighter' || partialErase;
    if (partialErase) {
      const brush = new fabric.EraserBrush(c);
      brush.width = Math.max(this.strokeWidth * 6, 20);
      c.freeDrawingBrush = brush;
    } else if (c.isDrawingMode) {
      const brush = new fabric.PencilBrush(c);
      if (t === 'highlighter') {
        brush.color = hexToRgba(this.color, 0.35 * this.opacity);
        brush.width = Math.max(this.strokeWidth * 5, 18);
      } else {
        brush.color = this.opacity < 1 ? hexToRgba(this.color, this.opacity) : this.color;
        brush.width = this.strokeWidth;
      }
      c.freeDrawingBrush = brush;
    }
    const objectsMode = t === 'select' || (t === 'pan' && this.handMode === 'objects');
    c.selection = objectsMode;
    c.skipTargetFind = !(objectsMode || t === 'eraser' || t === 'text');
    c.defaultCursor = t === 'pan' && this.handMode === 'board' ? 'grab' : objectsMode ? 'default' : 'crosshair';
    if (!objectsMode) {
      c.discardActiveObject();
      c.requestRenderAll();
    }
  }

  setEraserMode(mode) {
    this.eraserMode = mode === 'partial' ? 'partial' : 'object';
    if (this.tool === 'eraser') this._applyToolConfig();
  }

  setOpacity(v) {
    this.opacity = Math.min(1, Math.max(0.05, v));
    this._applyToolConfig();
    const active = this.canvas.getActiveObjects();
    if (this.tool === 'select' && active.length) {
      active.forEach((o) => {
        o.set('opacity', this.opacity);
        if (o.oid) this._queueOp({ t: 'mod', o: this._ser(o) });
      });
      this.canvas.requestRenderAll();
      this.commit();
    }
  }

  setColor(color) {
    this.color = color;
    const c = this.canvas;
    if (c.isDrawingMode && c.freeDrawingBrush) {
      c.freeDrawingBrush.color = this.tool === 'highlighter' ? hexToRgba(color, 0.35) : color;
    }
    const active = c.getActiveObjects();
    if (this.tool === 'select' && active.length) {
      active.forEach((o) => {
        if (o.isType('i-text')) o.set('fill', color);
        else if (o.stroke) o.set('stroke', color);
        else o.set('fill', color);
        if (o.oid) this._queueOp({ t: 'mod', o: this._ser(o) });
      });
      c.requestRenderAll();
      this.commit();
    }
  }

  setStrokeWidth(w) {
    this.strokeWidth = w;
    const c = this.canvas;
    if (c.isDrawingMode && c.freeDrawingBrush) {
      c.freeDrawingBrush.width = this.tool === 'highlighter' ? Math.max(w * 5, 18) : w;
    }
  }

  setFillShapes(on) {
    this.fillShapes = on;
  }

  _dashFor(width) {
    if (this.lineStyle === 'dashed') return [Math.max(6, width * 3), Math.max(5, width * 2)];
    if (this.lineStyle === 'dotted') return [1, Math.max(4, width * 2)];
    return null;
  }

  setLineStyle(style) {
    this.lineStyle = ['dashed', 'dotted'].includes(style) ? style : 'solid';
    const active = this.canvas.getActiveObjects();
    if (this.tool === 'select' && active.length) {
      active.forEach((o) => {
        if (o.stroke || o.type === 'line' || o.type === 'path') {
          o.set({ strokeDashArray: this._dashFor(o.strokeWidth || this.strokeWidth), strokeLineCap: this.lineStyle === 'dotted' ? 'round' : 'butt' });
          if (o.oid) this._queueOp({ t: 'mod', o: this._ser(o) });
        }
      });
      this.canvas.requestRenderAll();
      this.commit();
    }
  }

  // ---------- copy / paste ----------

  copySelection() {
    const objs = this.canvas.getActiveObjects();
    if (!objs.length) return false;
    this._clipboard = objs.filter((o) => !o.docPage).map((o) => this._ser(o));
    return this._clipboard.length > 0;
  }

  hasClipboard() {
    return !!(this._clipboard && this._clipboard.length);
  }

  paste() {
    if (!this.hasClipboard()) return;
    const c = this.canvas;
    const defs = this._clipboard.map((o) => {
      const n = { ...o };
      delete n.oid; // fresh id assigned on add
      n.left = (n.left || 0) + 24;
      n.top = (n.top || 0) + 24;
      return n;
    });
    fabric.util.enlivenObjects(defs, (objs) => {
      c.discardActiveObject();
      objs.forEach((o) => c.add(o));
      if (objs.length === 1) c.setActiveObject(objs[0]);
      else if (objs.length > 1) c.setActiveObject(new fabric.ActiveSelection(objs, { canvas: c }));
      c.requestRenderAll();
      // shift the clipboard so a repeated paste cascades
      this._clipboard = objs.map((o) => this._ser(o));
    });
  }

  duplicateSelection() {
    if (this.copySelection()) this.paste();
  }

  deleteSelection() {
    if (this._crop || this._curveEdit) return;
    const c = this.canvas;
    const objs = c.getActiveObjects();
    if (!objs.length) return;
    objs.forEach((o) => { if (o.oid) this._queueOp({ t: 'del', oid: o.oid }); });
    this._internal = true;
    objs.forEach((o) => c.remove(o));
    c.discardActiveObject();
    c.requestRenderAll();
    this._internal = false;
    this.commit();
  }

  clear() {
    this.cancelCrop();
    this.finishCurveEdit(false);
    // Supersede any in-flight loadJSON. A big board (e.g. a multi-page PDF)
    // enlivens in async batches; without bumping the load sequence here, a
    // slow older load keeps painting its objects onto the canvas we just
    // cleared — which is how clicking "new board" mid-load used to drop the
    // previous board's content onto the fresh blank one.
    this._loadSeq = (this._loadSeq || 0) + 1;
    this.loading = false;
    this._docMode = false; // a cleared board holds no document pages
    this._queueOp({ t: 'clear' });
    this._internal = true;
    this.canvas.clear();
    this.canvas.backgroundColor = '#ffffff';
    this.canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
    this.canvas.renderAll();
    this._internal = false;
    this.commit();
    this.onViewChange();
  }

  // ---------- zoom / pan ----------

  getZoom() {
    return this.canvas.getZoom();
  }

  zoomBy(factor) {
    const c = this.canvas;
    const zoom = Math.min(8, Math.max(0.1, c.getZoom() * factor));
    c.zoomToPoint(new fabric.Point(c.getWidth() / 2, c.getHeight() / 2), zoom);
    this.onViewChange();
  }

  resetZoom() {
    const c = this.canvas;
    c.zoomToPoint(new fabric.Point(c.getWidth() / 2, c.getHeight() / 2), 1);
    this.onViewChange();
  }

  fitContent() {
    fitToContent(this.canvas);
    this.onViewChange();
  }

  // ---------- inserts ----------

  addImageFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      fabric.Image.fromURL(reader.result, (img) => {
        const max = 480;
        const s = Math.min(1, max / img.width, max / img.height);
        img.scale(s);
        const c = this.canvas.getVpCenter();
        img.set({ left: c.x - img.getScaledWidth() / 2, top: c.y - img.getScaledHeight() / 2 });
        this.canvas.add(img);
        this.canvas.setActiveObject(img);
        this.canvas.requestRenderAll();
      });
    };
    reader.readAsDataURL(file);
  }

  addRuler() {
    const unit = 40, units = 15, pad = 20, h = 70;
    const w = pad * 2 + unit * units;
    const parts = [
      new fabric.Rect({
        left: 0, top: 0, width: w, height: h,
        fill: 'rgba(255, 255, 255, 0.96)', stroke: '#0A7C6E', strokeWidth: 1.5, rx: 3, ry: 3,
      }),
    ];
    for (let i = 0; i <= units; i++) {
      const x = pad + i * unit;
      parts.push(new fabric.Line([x, 0, x, 16], { stroke: '#1F2937', strokeWidth: 1.4 }));
      parts.push(new fabric.Text(String(i), {
        left: x, top: 20, fontSize: 12, fill: '#1F2937', originX: 'center', fontFamily: 'Bricolage Grotesque, Arial',
      }));
      if (i < units) {
        parts.push(new fabric.Line([x + unit / 2, 0, x + unit / 2, 10], { stroke: '#6F7680', strokeWidth: 1 }));
      }
    }
    const c = this.canvas.getVpCenter();
    const g = new fabric.Group(parts, { left: c.x - w / 2, top: c.y - h / 2 });
    this.canvas.add(g);
    this.canvas.setActiveObject(g);
    this.canvas.requestRenderAll();
  }

  // ---------- documents (locked page images you draw on top of) ----------

  // Document mode: pages are locked, stacked in a column, and the board is
  // fenced to them (see _constrainView). Blank pages and a margin gutter can be
  // added around them.
  addDocumentPages(dataUrls, done) {
    const c = this.canvas;
    const existing = this.getDocPages();
    let startPage = existing.length;
    // stack new pages below everything already on the board, centered on x=0
    let y = 0;
    c.getObjects().forEach((o) => {
      const r = o.getBoundingRect(true, true);
      y = Math.max(y, r.top + r.height + 40);
    });
    this._internal = true;
    const addOne = (i) => {
      if (i >= dataUrls.length) {
        this._internal = false;
        this._docMode = true;
        this._applyDocMode();
        this._markFullSync(); // pages were added internally — sync the whole board once
        this.commit();
        this.gotoDocPage(startPage + 1);
        if (done) done(dataUrls.length);
        return;
      }
      fabric.Image.fromURL(dataUrls[i], (img) => {
        img.set({
          left: -img.width / 2, top: y, // centered column
          selectable: false, evented: false, erasable: false,
          hoverCursor: 'default',
          docPage: startPage + i + 1,
          docMargin: startPage === 0 && i === 0 ? 90 : undefined, // default gutter, stored on page 1
        });
        y += img.height + 24;
        c.add(img);
        img.moveTo(i); // keep pages underneath drawings
        addOne(i + 1);
      });
    };
    addOne(0);
  }

  // The other option: drop the pages onto the board as ordinary movable,
  // resizable image objects (no fence, no page model) — good for referencing.
  addDocumentObjects(dataUrls, done) {
    const c = this.canvas;
    const center = c.getVpCenter();
    const addOne = (i) => {
      if (i >= dataUrls.length) { if (done) done(dataUrls.length); return; }
      fabric.Image.fromURL(dataUrls[i], (img) => {
        const max = 700;
        const s = Math.min(1, max / img.width, max / img.height);
        img.scale(s);
        img.set({
          left: center.x - img.getScaledWidth() / 2 + i * 28,
          top: center.y - img.getScaledHeight() / 2 + i * 28,
        });
        c.add(img); // added outside _internal → object:added queues an add op + oid
        c.setActiveObject(img);
        c.requestRenderAll();
        addOne(i + 1);
      });
    };
    addOne(0);
  }

  // Whether the board is currently a confined document
  isDocMode() { return !!this._docMode; }

  _applyDocMode() {
    this._docMode = this.getDocPages().length > 0;
    // A light gutter behind the white pages sells the "document" feel and makes
    // the fenced area obvious.
    this.canvas.backgroundColor = this._docMode ? '#e9eaee' : '#ffffff';
    if (this._docMode) this._constrainView();
    this.canvas.requestRenderAll();
  }

  // The scrollable region in document mode: everything on the board, plus a
  // margin gutter. Because it tracks all objects, annotations in the gutter are
  // always reachable and you can never scroll off into empty space.
  _docFenceBounds() {
    if (this._fenceCache) return this._fenceCache;
    const objs = this.canvas.getObjects();
    if (!objs.length) return null;
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const o of objs) {
      const br = o.getBoundingRect(true, true);
      l = Math.min(l, br.left); t = Math.min(t, br.top);
      r = Math.max(r, br.left + br.width); b = Math.max(b, br.top + br.height);
    }
    const m = this.getDocMargin();
    this._fenceCache = { left: l - m, top: t - m, right: r + m, bottom: b + m };
    return this._fenceCache;
  }

  _constrainView() {
    const c = this.canvas;
    const cur = c.viewportTransform;
    const z = cur[0];
    const bounds = this._docFenceBounds();
    if (!bounds) return;
    const W = c.getWidth(), H = c.getHeight();
    const contentW = (bounds.right - bounds.left) * z;
    const contentH = (bounds.bottom - bounds.top) * z;
    let x = cur[4], y = cur[5];
    if (contentW <= W) x = (W - contentW) / 2 - bounds.left * z;   // smaller than view → center
    else x = Math.min(-bounds.left * z, Math.max(W - bounds.right * z, x)); // else clamp edges
    if (contentH <= H) y = (H - contentH) / 2 - bounds.top * z;
    else y = Math.min(-bounds.top * z, Math.max(H - bounds.bottom * z, y));
    if (x !== cur[4] || y !== cur[5]) {
      c.setViewportTransform([z, 0, 0, z, x, y]);
      c.requestRenderAll();
    }
  }

  getDocMargin() {
    const p = this.getDocPages().find((o) => typeof o.docMargin === 'number');
    return p ? p.docMargin : 90;
  }

  setDocMargin(v) {
    const pages = this.getDocPages();
    if (!pages.length) return;
    const val = Math.max(0, Math.min(600, Math.round(v)));
    // clear any stray margins, keep it authoritative on page 1
    pages.forEach((p) => { if (p.docMargin !== undefined) { p.set('docMargin', undefined); } });
    pages[0].set('docMargin', val);
    if (pages[0].oid) this._queueOp({ t: 'mod', o: this._ser(pages[0]) });
    this._fenceCache = null; // margin changed → fence changed
    this._constrainView();
    this.canvas.requestRenderAll();
    this.onViewChange();
  }

  // Append a blank page the same size as the last one, to keep writing.
  addBlankPage() {
    const pages = this.getDocPages();
    if (!pages.length) return null;
    const last = pages[pages.length - 1];
    const w = last.getScaledWidth();
    const h = last.getScaledHeight();
    const rect = new fabric.Rect({
      left: last.left, top: last.top + h + 24, width: w, height: h,
      fill: '#ffffff', stroke: '#d8dbe0', strokeWidth: 1,
      selectable: false, evented: false, erasable: false, hoverCursor: 'default',
      docPage: (last.docPage || pages.length) + 1,
    });
    this.canvas.add(rect); // outside _internal → object:added queues the add op + oid
    rect.moveTo(pages.length); // under the drawings
    this.canvas.requestRenderAll();
    this.gotoDocPage(rect.docPage);
    return rect.docPage;
  }

  getDocPages() {
    return this.canvas.getObjects()
      .filter((o) => o.docPage)
      .sort((a, b) => a.docPage - b.docPage);
  }

  gotoDocPage(n) {
    const page = this.getDocPages().find((o) => o.docPage === n);
    if (!page) return;
    const c = this.canvas;
    const w = page.getScaledWidth();
    const zoom = Math.min((c.getWidth() - 60) / w, 2);
    c.setViewportTransform([zoom, 0, 0, zoom, (c.getWidth() - w * zoom) / 2 - page.left * zoom, 24 - page.top * zoom]);
    c.requestRenderAll();
    this.onViewChange();
  }

  // The page whose top edge is nearest the top of the current view
  getCurrentDocPage() {
    const pages = this.getDocPages();
    if (!pages.length) return 0;
    const vpt = this.canvas.viewportTransform;
    const viewTop = -vpt[5] / vpt[3];
    let best = pages[0].docPage;
    let bestDist = Infinity;
    for (const p of pages) {
      const d = Math.abs(p.top - viewTop);
      if (d < bestDist) { bestDist = d; best = p.docPage; }
    }
    return best;
  }

  // ---------- rich text ----------

  getActiveText() {
    const o = this.canvas.getActiveObject();
    return o && o.type === 'i-text' ? o : null;
  }

  // Read a style property from the current text selection (or the whole object)
  getTextStyleValue(prop) {
    const o = this.getActiveText();
    if (!o) return undefined;
    if (o.isEditing && o.selectionStart !== o.selectionEnd) {
      const styles = o.getSelectionStyles(o.selectionStart, o.selectionEnd);
      if (styles.length && styles.every((s) => s[prop] !== undefined)) {
        const first = styles[0][prop];
        return styles.every((s) => s[prop] === first) ? first : undefined;
      }
    }
    return o[prop];
  }

  // Apply style to the selected range if editing, otherwise the whole text object
  applyTextStyle(style) {
    const o = this.getActiveText();
    if (!o) return;
    if (o.isEditing && o.selectionStart !== o.selectionEnd) {
      o.setSelectionStyles(style, o.selectionStart, o.selectionEnd);
    } else {
      Object.keys(style).forEach((k) => { if (o.removeStyle) o.removeStyle(k); });
      o.set(style);
    }
    // Re-measure now, not on the next paint: otherwise the text's size and its
    // selection box stay one change behind, and anything placed relative to it
    // (the text toolbar) lands in the wrong spot.
    if (o.initDimensions) o.initDimensions();
    o.setCoords();
    o.dirty = true;
    if (o.oid) this._queueOp({ t: 'mod', o: this._ser(o) });
    this.canvas.requestRenderAll();
    this.commit();
  }

  toggleTextStyle(prop, onVal, offVal) {
    const cur = this.getTextStyleValue(prop);
    this.applyTextStyle({ [prop]: cur === onVal ? offVal : onVal });
  }

  changeTextSize(delta) {
    const o = this.getActiveText();
    if (!o) return;
    const cur = this.getTextStyleValue('fontSize') || o.fontSize;
    this.applyTextStyle({ fontSize: Math.max(8, Math.min(200, cur + delta)) });
  }

  // ---------- coordinate graph ----------

  addGraph({ xMin = -10, xMax = 10, yMin = -10, yMax = 10, xLabel = 'x', yLabel = 'y', title = '' } = {}) {
    const size = 440, pad = 40;
    const span = size - pad * 2;
    if (xMax <= xMin) xMax = xMin + 1;
    if (yMax <= yMin) yMax = yMin + 1;
    const X = (x) => pad + ((x - xMin) / (xMax - xMin)) * span;
    const Y = (y) => size - pad - ((y - yMin) / (yMax - yMin)) * span;
    const stepX = niceStep(xMax - xMin);
    const stepY = niceStep(yMax - yMin);
    const parts = [new fabric.Rect({ left: 0, top: 0, width: size, height: size, fill: '#FFFFFF', stroke: '#E4E2DD', strokeWidth: 1, rx: 3, ry: 3 })];

    for (let x = Math.ceil(xMin / stepX) * stepX; x <= xMax + 1e-9; x += stepX) {
      parts.push(new fabric.Line([X(x), pad, X(x), size - pad], { stroke: '#EDEBE6', strokeWidth: 1 }));
    }
    for (let y = Math.ceil(yMin / stepY) * stepY; y <= yMax + 1e-9; y += stepY) {
      parts.push(new fabric.Line([pad, Y(y), size - pad, Y(y)], { stroke: '#EDEBE6', strokeWidth: 1 }));
    }

    const axX = (0 >= yMin && 0 <= yMax) ? Y(0) : size - pad; // x-axis screen-y
    const axY = (0 >= xMin && 0 <= xMax) ? X(0) : pad;        // y-axis screen-x
    parts.push(new fabric.Line([pad, axX, size - pad, axX], { stroke: '#1F2937', strokeWidth: 2 }));
    parts.push(new fabric.Line([axY, pad, axY, size - pad], { stroke: '#1F2937', strokeWidth: 2 }));
    parts.push(new fabric.Triangle({ left: size - pad, top: axX, width: 10, height: 10, angle: 90, fill: '#1F2937', originX: 'center', originY: 'center' }));
    parts.push(new fabric.Triangle({ left: axY, top: pad, width: 10, height: 10, fill: '#1F2937', originX: 'center', originY: 'center' }));

    for (let x = Math.ceil(xMin / stepX) * stepX; x <= xMax + 1e-9; x += stepX) {
      if (Math.abs(x) < 1e-9) continue;
      parts.push(txt(+x.toFixed(4), { left: X(x), top: axX + 5, fontSize: 11, fill: '#6F7680', originX: 'center' }));
    }
    for (let y = Math.ceil(yMin / stepY) * stepY; y <= yMax + 1e-9; y += stepY) {
      if (Math.abs(y) < 1e-9) continue;
      parts.push(txt(+y.toFixed(4), { left: axY - 6, top: Y(y), fontSize: 11, fill: '#6F7680', originX: 'right', originY: 'center' }));
    }
    parts.push(txt(xLabel, { left: size - pad + 2, top: axX + 8, fontSize: 13, fontStyle: 'italic', fill: '#0A7C6E' }));
    parts.push(txt(yLabel, { left: axY + 6, top: pad - 4, fontSize: 13, fontStyle: 'italic', fill: '#0A7C6E' }));
    if (title) parts.push(txt(title, { left: size / 2, top: 8, fontSize: 15, fontWeight: '700', originX: 'center' }));

    this._placeGroup(parts, size, size);
  }

  // ---------- data charts (from CSV) ----------

  addChart(spec) {
    const type = spec.type;
    const W = 460, H = 340, pad = 46, top = spec.title ? 40 : 20, legendH = 26;
    const plotW = W - pad * 2;
    const plotH = H - top - pad - legendH;
    const parts = [new fabric.Rect({ left: 0, top: 0, width: W, height: H, fill: '#FFFFFF', stroke: '#E4E2DD', strokeWidth: 1, rx: 4, ry: 4 })];
    if (spec.title) parts.push(txt(spec.title, { left: W / 2, top: 12, fontSize: 16, fontWeight: '700', originX: 'center' }));

    if (type === 'pie') this._buildPie(parts, spec, W, H, top);
    else this._buildAxisChart(parts, spec, { W, H, pad, top, plotW, plotH });

    this._placeGroup(parts, W, H);
  }

  _buildAxisChart(parts, spec, geo) {
    const { pad, top, plotW, plotH } = geo;
    const type = spec.type;
    const x0 = pad, y0 = top + plotH;
    let max = 0, min = 0;
    spec.series.forEach((s) => s.forEach((v) => { if (v > max) max = v; if (v < min) min = v; }));
    if (max === min) max = min + 1;
    const Y = (v) => y0 - ((v - min) / (max - min)) * plotH;

    // y grid + labels
    const stepY = niceStep(max - min);
    for (let v = Math.ceil(min / stepY) * stepY; v <= max + 1e-9; v += stepY) {
      parts.push(new fabric.Line([x0, Y(v), x0 + plotW, Y(v)], { stroke: '#EDEBE6', strokeWidth: 1 }));
      parts.push(txt(+v.toFixed(2), { left: x0 - 6, top: Y(v), fontSize: 10, fill: '#6F7680', originX: 'right', originY: 'center' }));
    }
    parts.push(new fabric.Line([x0, top, x0, y0], { stroke: '#1F2937', strokeWidth: 1.5 }));
    parts.push(new fabric.Line([x0, y0, x0 + plotW, y0], { stroke: '#1F2937', strokeWidth: 1.5 }));

    const n = spec.labels.length;
    const slot = plotW / Math.max(n, 1);
    spec.labels.forEach((lab, i) => {
      parts.push(txt(lab, { left: x0 + slot * (i + 0.5), top: y0 + 6, fontSize: 10, fill: '#6F7680', originX: 'center' }));
    });

    if (type === 'bar') {
      const groups = spec.series.length;
      const bw = (slot * 0.7) / groups;
      spec.series.forEach((s, si) => {
        s.forEach((v, i) => {
          const bx = x0 + slot * i + slot * 0.15 + si * bw;
          parts.push(new fabric.Rect({ left: bx, top: Math.min(Y(v), Y(0)), width: bw * 0.9, height: Math.abs(Y(v) - Y(0)), fill: CHART_COLORS[si % CHART_COLORS.length] }));
        });
      });
    } else { // line
      spec.series.forEach((s, si) => {
        const col = CHART_COLORS[si % CHART_COLORS.length];
        const pts = s.map((v, i) => ({ x: x0 + slot * (i + 0.5), y: Y(v) }));
        for (let i = 1; i < pts.length; i++) {
          parts.push(new fabric.Line([pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y], { stroke: col, strokeWidth: 2.5 }));
        }
        pts.forEach((p) => parts.push(new fabric.Circle({ left: p.x, top: p.y, radius: 3, fill: col, originX: 'center', originY: 'center' })));
      });
    }
    this._legend(parts, spec.seriesNames, geo.W, geo.H);
  }

  _buildPie(parts, spec, W, H, top) {
    const cx = W / 2 - 40, cy = top + (H - top) / 2 - 10, r = Math.min(W, H) / 3.2;
    const data = spec.series[0] || [];
    const total = data.reduce((a, b) => a + Math.max(0, b), 0) || 1;
    let ang = -Math.PI / 2;
    data.forEach((v, i) => {
      const frac = Math.max(0, v) / total;
      const end = ang + frac * Math.PI * 2;
      const x1 = cx + r * Math.cos(ang), y1 = cy + r * Math.sin(ang);
      const x2 = cx + r * Math.cos(end), y2 = cy + r * Math.sin(end);
      const large = frac > 0.5 ? 1 : 0;
      parts.push(new fabric.Path(`M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`,
        { fill: CHART_COLORS[i % CHART_COLORS.length], stroke: '#FFFFFF', strokeWidth: 2 }));
      if (frac > 0.04) {
        const mid = (ang + end) / 2;
        parts.push(txt(Math.round(frac * 100) + '%', { left: cx + r * 0.6 * Math.cos(mid), top: cy + r * 0.6 * Math.sin(mid), fontSize: 11, fill: '#FFFFFF', fontWeight: '700', originX: 'center', originY: 'center' }));
      }
      ang = end;
    });
    // legend down the right side
    spec.labels.forEach((lab, i) => {
      const ly = top + 20 + i * 20;
      parts.push(new fabric.Rect({ left: W - 120, top: ly, width: 12, height: 12, fill: CHART_COLORS[i % CHART_COLORS.length], rx: 2 }));
      parts.push(txt(lab, { left: W - 104, top: ly - 1, fontSize: 11, fill: '#1F2937' }));
    });
  }

  _legend(parts, names, W, H) {
    if (!names || names.length < 2) return;
    let x = 40;
    const y = H - 20;
    names.forEach((nm, i) => {
      parts.push(new fabric.Rect({ left: x, top: y, width: 12, height: 12, fill: CHART_COLORS[i % CHART_COLORS.length], rx: 2 }));
      const t = txt(nm, { left: x + 16, top: y - 1, fontSize: 11, fill: '#1F2937' });
      parts.push(t);
      x += 28 + String(nm).length * 6.5;
    });
  }

  // A masonry wall of response cards (used for text-poll answers)
  addTextWall({ title = '', responses = [] } = {}) {
    const cardW = 210, gap = 14;
    const cols = Math.min(3, Math.max(1, Math.round(Math.sqrt(Math.max(responses.length, 1)))));
    const tints = ['#E3F1EF', '#FDF1DC', '#FFE9E0', '#EAF1FD', '#F3ECFB'];
    const titleH = title ? 34 : 8;
    const colH = new Array(cols).fill(titleH);
    const cards = [];
    responses.forEach((r, i) => {
      const body = new fabric.Textbox(String(r.value || ''), { width: cardW - 24, fontSize: 14, fontFamily: FONT, fill: '#1F2937' });
      const name = txt(r.name || 'Anonymous', { fontSize: 11, fill: '#6F7680', fontWeight: '700' });
      const cardH = 14 + body.height + 8 + 14 + 8;
      const col = colH.indexOf(Math.min(...colH));
      const x = gap + col * (cardW + gap);
      const y = colH[col];
      cards.push(new fabric.Rect({ left: x, top: y, width: cardW, height: cardH, rx: 6, ry: 6, fill: tints[i % tints.length], stroke: '#E4E2DD', strokeWidth: 1 }));
      body.set({ left: x + 12, top: y + 12 });
      name.set({ left: x + 12, top: y + cardH - 22 });
      cards.push(body, name);
      colH[col] = y + cardH + gap;
    });
    const totalW = gap + cols * (cardW + gap);
    const totalH = Math.max(...colH, titleH) + 4;
    const parts = [new fabric.Rect({ left: 0, top: 0, width: totalW, height: totalH, fill: '#FFFFFF', stroke: '#E4E2DD', strokeWidth: 1, rx: 6, ry: 6 })];
    if (title) parts.push(txt(title, { left: gap, top: 8, fontSize: 17, fontWeight: '700' }));
    parts.push(...cards);
    this._placeGroup(parts, totalW, totalH);
  }

  _placeGroup(parts, w, h) {
    const c = this.canvas.getVpCenter();
    const g = new fabric.Group(parts, { left: c.x - w / 2, top: c.y - h / 2 });
    this.canvas.add(g);
    this.canvas.setActiveObject(g);
    this.canvas.requestRenderAll();
  }

  // Add a rendered math equation (a self-contained MathJax SVG string) as a movable vector group.
  addEquation(svg, color = '#1f2937', targetH = 68) {
    return new Promise((resolve, reject) => {
      fabric.loadSVGFromString(svg, (objects, options) => {
        if (!objects || !objects.length) return reject(new Error('Could not render that equation.'));
        const grp = fabric.util.groupSVGElements(objects, options);
        // MathJax glyphs use currentColor — paint them the chosen ink color
        const paint = (o) => {
          if (o._objects) o._objects.forEach(paint);
          else if (o.fill !== null && o.fill !== 'none') o.set('fill', color);
        };
        paint(grp);
        const h = grp.height || 1;
        const s = Math.max(0.05, targetH / h);
        grp.scale(s);
        const c = this.canvas.getVpCenter();
        grp.set({ left: c.x - (grp.width * s) / 2, top: c.y - (grp.height * s) / 2 });
        this.canvas.add(grp);
        this.canvas.setActiveObject(grp);
        this.canvas.requestRenderAll();
        resolve(grp);
      });
    });
  }

  // ---------- export ----------

  downloadView(filename) {
    const c = this.canvas;
    downloadDataURL(c.toDataURL({ format: 'png', multiplier: 2 }), filename);
  }

  downloadFull(filename) {
    const c = this.canvas;
    const objs = c.getObjects();
    if (!objs.length) return this.downloadView(filename);
    const vpt = c.viewportTransform.slice();
    c.setViewportTransform([1, 0, 0, 1, 0, 0]);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    objs.forEach((o) => {
      const r = o.getBoundingRect(true, true);
      minX = Math.min(minX, r.left);
      minY = Math.min(minY, r.top);
      maxX = Math.max(maxX, r.left + r.width);
      maxY = Math.max(maxY, r.top + r.height);
    });
    const pad = 40;
    const w = maxX - minX + pad * 2;
    const h = maxY - minY + pad * 2;
    const multiplier = Math.min(2, 4096 / Math.max(w, h));
    const url = c.toDataURL({
      format: 'png', left: minX - pad, top: minY - pad, width: w, height: h, multiplier,
    });
    c.setViewportTransform(vpt);
    c.requestRenderAll();
    downloadDataURL(url, filename);
  }

  // ---------- events ----------

  _bindEvents() {
    const c = this.canvas;

    c.on('mouse:wheel', (opt) => {
      const e = opt.e;
      e.preventDefault();
      e.stopPropagation();
      if (e.ctrlKey || e.metaKey) {
        // pinch or ctrl/cmd+scroll zooms
        let zoom = c.getZoom() * Math.pow(0.995, e.deltaY);
        zoom = Math.min(8, Math.max(0.1, zoom));
        c.zoomToPoint(new fabric.Point(e.offsetX, e.offsetY), zoom);
      } else {
        // plain scroll pans — natural for scrolling through documents
        c.relativePan(new fabric.Point(-e.deltaX, -e.deltaY));
      }
      this.onViewChange();
    });

    c.on('mouse:down', (opt) => this._onDown(opt));
    c.on('mouse:move', (opt) => this._onMove(opt));
    c.on('mouse:up', (opt) => this._onUp(opt));

    c.on('object:added', (e) => {
      this._fenceCache = null; // content changed → recompute the document fence
      // every object gets a stable id so comments can anchor to it
      if (e.target && !e.target.oid && !e.target.isEditHandle) {
        e.target.oid = 'o' + Math.random().toString(36).slice(2, 11);
      }
      // text scales uniformly only — no squishing from the side handles
      if (e.target && (e.target.type === 'i-text' || e.target.type === 'text')) {
        e.target.setControlsVisibility({ ml: false, mr: false, mt: false, mb: false });
      }
      if (!this._internal && e.target && !e.target.isEditHandle) {
        this._queueOp({ t: 'add', o: this._ser(e.target) });
      }
      this.commit();
    });
    c.on('object:modified', (e) => {
      this._fenceCache = null;
      if (!this._internal && e.target) {
        if (e.target.type === 'activeSelection') {
          // group transforms store child coords relative to the selection — full sync is simplest
          this._markFullSync();
        } else if (!e.target.isEditHandle) {
          this._queueOp({ t: 'mod', o: this._ser(e.target) });
        }
      }
      this.commit();
    });
    c.on('object:removed', (e) => {
      this._fenceCache = null;
      if (!this._internal && e.target && e.target.oid && !e.target.isEditHandle) {
        this._queueOp({ t: 'del', oid: e.target.oid });
      }
      this.commit();
    });
    c.on('text:changed', (e) => {
      if (e.target && e.target.oid) this._queueOp({ t: 'mod', o: this._ser(e.target) });
      this._emitChange();
    });
    c.on('erasing:end', (e) => { // partial-eraser stroke finished
      const targets = e && e.targets && e.targets.length ? e.targets : null;
      if (targets) targets.forEach((o) => { if (o.oid) this._queueOp({ t: 'mod', o: this._ser(o) }); });
      else this._markFullSync();
      this.commit();
    });

    c.on('object:moving', (e) => {
      if (this._curveEdit && e.target && e.target.isEditHandle) this._updateCurveEditPreview();
    });

    c.on('mouse:dblclick', (opt) => {
      const target = opt.target;
      if (!target || this._crop || this._curveEdit) return;
      if (target.type === 'image' && !target.docPage) this.startCrop(target);
      else if (this._isEditableCurve(target)) this.startCurveEdit(target);
    });

    const sel = () => this.onSelection(this.getActiveKind());
    c.on('selection:created', sel);
    c.on('selection:updated', sel);
    c.on('selection:cleared', sel);
  }

  _onDown(opt) {
    const c = this.canvas;
    const t = this.tool;

    // Clicking away from an active crop/curve session applies it
    if (this._crop) {
      if (opt.target !== this._crop.rect) this.applyCrop();
      return;
    }
    if (this._curveEdit) {
      if (!(opt.target && opt.target.isEditHandle)) this.finishCurveEdit(true);
      return;
    }

    if (c.isDrawingMode) return;
    const p = c.getPointer(opt.e);

    if (t === 'pan' && this.handMode === 'board') {
      // track our own deltas — touch/pen events have no movementX/movementY
      this._panning = { x: opt.e.clientX || 0, y: opt.e.clientY || 0 };
      c.defaultCursor = 'grabbing';
      return;
    }
    if (t === 'pan') return; // objects mode: fabric's own select/drag takes over
    if (t === 'eraser') {
      this._erasing = true;
      this._erasedAny = false;
      if (opt.target) {
        this._internal = true;
        c.remove(opt.target);
        this._internal = false;
        this._erasedAny = true;
      }
      return;
    }
    if (t === 'text') {
      this._handleText(opt, p);
      return;
    }
    if (t === 'curve') {
      this._curveDown(p);
      return;
    }
    if (SHAPE_TOOLS.includes(t)) {
      this._startShape(t, p);
    }
  }

  _onMove(opt) {
    const c = this.canvas;
    const e = opt.e;

    if (this._panning) {
      const nx = e.clientX || 0;
      const ny = e.clientY || 0;
      c.relativePan(new fabric.Point(nx - this._panning.x, ny - this._panning.y));
      this._panning = { x: nx, y: ny };
      this.onViewChange();
      return;
    }
    if (this._erasing) {
      const target = c.findTarget(e);
      if (target) {
        this._internal = true;
        c.remove(target);
        this._internal = false;
        this._erasedAny = true;
        c.requestRenderAll();
      }
      return;
    }
    const p = c.getPointer(e);
    if (this._curve) {
      this._curveMove(p);
      return;
    }
    if (this._drawing) {
      this._updateShape(p);
    }
  }

  _onUp() {
    const c = this.canvas;
    if (this._panning) {
      this._panning = false;
      c.defaultCursor = 'grab';
      return;
    }
    if (this._erasing) {
      this._erasing = false;
      if (this._erasedAny) this.commit();
      return;
    }
    if (this._curve) {
      this._curveUp();
      return;
    }
    if (this._drawing) {
      this._finishShape();
    }
  }

  // ----- shapes (drag to size) -----

  _startShape(tool, p) {
    const c = this.canvas;
    this._internal = true;
    const dash = this._dashFor(this.strokeWidth);
    const cap = this.lineStyle === 'dotted' ? 'round' : 'butt';
    const common = {
      stroke: this.color,
      strokeWidth: this.strokeWidth,
      opacity: this.opacity,
      strokeDashArray: dash,
      strokeLineCap: cap,
      fill: this.fillShapes ? hexToRgba(this.color, 0.25) : 'transparent',
      selectable: false,
      evented: false,
      strokeUniform: true,
    };
    let obj;
    if (tool === 'line' || tool === 'arrow') {
      obj = new fabric.Line([p.x, p.y, p.x, p.y], {
        stroke: this.color, strokeWidth: this.strokeWidth, opacity: this.opacity,
        strokeDashArray: tool === 'arrow' ? null : dash, strokeLineCap: cap,
        selectable: false, evented: false,
      });
    } else if (tool === 'rect') {
      obj = new fabric.Rect({ ...common, left: p.x, top: p.y, width: 1, height: 1 });
    } else if (tool === 'ellipse') {
      obj = new fabric.Ellipse({ ...common, left: p.x, top: p.y, rx: 1, ry: 1 });
    } else if (tool === 'triangle') {
      obj = new fabric.Triangle({ ...common, left: p.x, top: p.y, width: 1, height: 1 });
    } else {
      // polygon shapes: unit outline scaled while dragging
      obj = new fabric.Polygon(unitPoints(tool), { ...common, left: p.x, top: p.y, scaleX: 1, scaleY: 1 });
    }
    c.add(obj);
    this._drawing = { tool, origin: p, obj };
  }

  _updateShape(p) {
    const { tool, origin, obj } = this._drawing;
    if (tool === 'line' || tool === 'arrow') {
      obj.set({ x2: p.x, y2: p.y });
    } else {
      const w = Math.abs(p.x - origin.x);
      const h = Math.abs(p.y - origin.y);
      obj.set({ left: Math.min(p.x, origin.x), top: Math.min(p.y, origin.y) });
      if (tool === 'ellipse') obj.set({ rx: w / 2, ry: h / 2 });
      else if (POLY_SHAPES.includes(tool)) obj.set({ scaleX: Math.max(w, 1), scaleY: Math.max(h, 1) });
      else obj.set({ width: w, height: h });
    }
    obj.setCoords();
    this.canvas.requestRenderAll();
  }

  _finishShape() {
    const c = this.canvas;
    const { tool, origin, obj } = this._drawing;
    this._drawing = null;

    let tooSmall;
    if (tool === 'line' || tool === 'arrow') {
      tooSmall = Math.hypot(obj.x2 - obj.x1, obj.y2 - obj.y1) < 4;
    } else {
      tooSmall = obj.getScaledWidth() < 4 && obj.getScaledHeight() < 4;
    }
    if (tooSmall) {
      c.remove(obj);
      this._internal = false;
      return;
    }

    let finalObj = obj;
    if (tool === 'arrow') {
      c.remove(obj);
      finalObj = this._makeArrow(obj);
      c.add(finalObj);
    }
    finalObj.set({ selectable: true, evented: true });
    finalObj.setCoords();
    c.requestRenderAll();
    this._internal = false;
    // The shape was added while _internal was true (to suppress per-frame ops
    // during the drag), so object:added never queued an 'add'. Emit it now, or
    // in a live class the shape never syncs to peers and never persists.
    if (finalObj.oid) this._queueOp({ t: 'add', o: this._ser(finalObj) });
    this.commit();
    void origin;
  }

  _makeArrow(line) {
    // One path (shaft + filled head) — grouped line+triangle drifted apart on large arrows
    const { x1, y1, x2, y2 } = line;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const headLen = Math.max(14, line.strokeWidth * 4);
    const hx1 = x2 - headLen * Math.cos(angle - Math.PI / 7);
    const hy1 = y2 - headLen * Math.sin(angle - Math.PI / 7);
    const hx2 = x2 - headLen * Math.cos(angle + Math.PI / 7);
    const hy2 = y2 - headLen * Math.sin(angle + Math.PI / 7);
    const bx = x2 - headLen * 0.6 * Math.cos(angle);
    const by = y2 - headLen * 0.6 * Math.sin(angle);
    const d = `M ${x1} ${y1} L ${bx} ${by} M ${hx1} ${hy1} L ${x2} ${y2} L ${hx2} ${hy2} L ${hx1} ${hy1} Z`;
    return new fabric.Path(d, {
      stroke: line.stroke, strokeWidth: line.strokeWidth, fill: line.stroke,
      opacity: line.opacity, strokeLineJoin: 'round',
    });
  }

  // ----- curve tool: drag to set the line, move to bend, click to place -----

  _curveDown(p) {
    if (this._curve && this._curve.phase === 'bend') {
      const obj = this._curve.obj;
      obj.set({ selectable: true, evented: true, isCurve: true });
      obj.setCoords();
      this._curve = null;
      this._internal = false;
      // Same as shapes: the curve was built under _internal, so emit its add
      // op now or it won't sync/persist in a room.
      if (obj.oid) this._queueOp({ t: 'add', o: this._ser(obj) });
      this.commit();
      return;
    }
    this._internal = true;
    this._curve = { phase: 'drag', start: p, end: p, obj: null };
    this._replaceCurve(`M ${p.x} ${p.y} L ${p.x} ${p.y}`);
  }

  _curveMove(p) {
    const cv = this._curve;
    if (cv.phase === 'drag') {
      cv.end = p;
      this._replaceCurve(`M ${cv.start.x} ${cv.start.y} L ${p.x} ${p.y}`);
    } else {
      this._replaceCurve(`M ${cv.start.x} ${cv.start.y} Q ${p.x} ${p.y} ${cv.end.x} ${cv.end.y}`);
    }
  }

  _curveUp() {
    const cv = this._curve;
    if (cv.phase === 'drag') {
      if (Math.hypot(cv.end.x - cv.start.x, cv.end.y - cv.start.y) < 4) {
        this._cancelCurve();
      } else {
        cv.phase = 'bend';
      }
    }
  }

  _replaceCurve(pathStr) {
    const c = this.canvas;
    if (this._curve.obj) c.remove(this._curve.obj);
    const path = new fabric.Path(pathStr, {
      stroke: this.color,
      strokeWidth: this.strokeWidth,
      strokeDashArray: this._dashFor(this.strokeWidth),
      strokeLineCap: this.lineStyle === 'dotted' ? 'round' : 'butt',
      fill: '',
      selectable: false,
      evented: false,
    });
    this._curve.obj = path;
    c.add(path);
    c.requestRenderAll();
  }

  _cancelCurve() {
    if (!this._curve) return;
    if (this._curve.obj) this.canvas.remove(this._curve.obj);
    this._curve = null;
    this._internal = false;
    this.canvas.requestRenderAll();
  }

  cancelPending() {
    this._cancelCurve();
    this.cancelCrop();
    this.finishCurveEdit(false);
    this.canvas.discardActiveObject();
    this.canvas.requestRenderAll();
  }

  _flushChange() {
    if (this._changeTimer) {
      clearTimeout(this._changeTimer);
      this._changeTimer = null;
      this.onChange(this.getJSON(), this.getThumb());
    }
  }

  // ---------- crop (images) ----------

  isCropping() {
    return !!this._crop;
  }

  startCropOnActive() {
    const o = this.canvas.getActiveObject();
    if (o && o.type === 'image' && !o.docPage) this.startCrop(o);
  }

  startCrop(img) {
    if (this._crop || this._curveEdit || img.type !== 'image' || img.docPage) return;
    this._flushChange();
    const c = this.canvas;
    this._internal = true;
    c.isDrawingMode = false;
    c.discardActiveObject();
    img.set({ evented: false, selectable: false }); // only the crop frame is interactive
    const center = img.getCenterPoint();
    const rect = new fabric.Rect({
      left: center.x, top: center.y, originX: 'center', originY: 'center',
      width: img.getScaledWidth(), height: img.getScaledHeight(), angle: img.angle,
      fill: 'rgba(10, 124, 110, 0.15)', stroke: '#0A7C6E', strokeWidth: 1.5,
      strokeDashArray: [6, 4], strokeUniform: true,
      lockRotation: true, transparentCorners: false, cornerColor: '#0A7C6E', cornerSize: 9,
    });
    rect.setControlsVisibility({ mtr: false });
    c.add(rect);
    c.setActiveObject(rect);
    c.requestRenderAll();
    this._crop = { img, rect };
    this.onModeChange();
  }

  applyCrop() {
    if (!this._crop) return;
    const c = this.canvas;
    const { img, rect } = this._crop;
    this._crop = null;

    const inv = fabric.util.invertTransform(img.calcTransformMatrix());
    const local = rect.getCoords(true, true).map((pt) => fabric.util.transformPoint(pt, inv));
    c.remove(rect);
    img.set({ evented: true, selectable: true });

    let minX = Math.max(Math.min(...local.map((p) => p.x)), -img.width / 2);
    let maxX = Math.min(Math.max(...local.map((p) => p.x)), img.width / 2);
    let minY = Math.max(Math.min(...local.map((p) => p.y)), -img.height / 2);
    let maxY = Math.min(Math.max(...local.map((p) => p.y)), img.height / 2);

    if (maxX - minX >= 4 && maxY - minY >= 4) {
      const absCenter = fabric.util.transformPoint(
        new fabric.Point((minX + maxX) / 2, (minY + maxY) / 2), img.calcTransformMatrix());
      img.set({
        cropX: (img.cropX || 0) + img.width / 2 + minX,
        cropY: (img.cropY || 0) + img.height / 2 + minY,
        width: maxX - minX,
        height: maxY - minY,
      });
      img.setPositionByOrigin(absCenter, 'center', 'center');
      img.setCoords();
    }
    c.discardActiveObject();
    c.requestRenderAll();
    this._internal = false;
    if (img.oid) this._queueOp({ t: 'mod', o: this._ser(img) });
    this.commit();
    this._applyToolConfig();
    this.onModeChange();
  }

  cancelCrop() {
    if (!this._crop) return;
    const c = this.canvas;
    const { img, rect } = this._crop;
    this._crop = null;
    c.remove(rect);
    img.set({ evented: true, selectable: true });
    c.discardActiveObject();
    c.requestRenderAll();
    this._internal = false;
    this._applyToolConfig();
    this.onModeChange();
  }

  // ---------- curve editing (drag the endpoints and control point) ----------

  isCurveEditing() {
    return !!this._curveEdit;
  }

  _isEditableCurve(obj) {
    if (!obj || obj.type !== 'path' || !obj.path || obj.path.length !== 2) return false;
    if (obj.isCurve) return true;
    return obj.path[0][0] === 'M' && (obj.path[1][0] === 'Q' || obj.path[1][0] === 'L');
  }

  startCurveEditOnActive() {
    const o = this.canvas.getActiveObject();
    if (this._isEditableCurve(o)) this.startCurveEdit(o);
  }

  startCurveEdit(obj) {
    if (this._curveEdit || this._crop || !this._isEditableCurve(obj)) return;
    this._flushChange();
    const c = this.canvas;
    const m = obj.calcTransformMatrix();
    const po = obj.pathOffset;
    const abs = (x, y) => fabric.util.transformPoint(new fabric.Point(x - po.x, y - po.y), m);
    const cmds = obj.path;
    const s = abs(cmds[0][1], cmds[0][2]);
    let q, e;
    if (cmds[1][0] === 'Q') {
      q = abs(cmds[1][1], cmds[1][2]);
      e = abs(cmds[1][3], cmds[1][4]);
    } else {
      e = abs(cmds[1][1], cmds[1][2]);
      q = new fabric.Point((s.x + e.x) / 2, (s.y + e.y) / 2);
    }

    this._internal = true;
    c.isDrawingMode = false;
    c.selection = false;
    c.skipTargetFind = false;
    c.discardActiveObject();
    c.remove(obj);

    const r = Math.min(20, Math.max(4, 8 / c.getZoom()));
    const mkHandle = (pt, fill) => {
      const h = new fabric.Circle({
        left: pt.x, top: pt.y, radius: r, fill, stroke: '#0A7C6E', strokeWidth: 1.5,
        originX: 'center', originY: 'center', hasControls: false, hasBorders: false, hoverCursor: 'move',
      });
      h.isEditHandle = true;
      return h;
    };
    this._curveEdit = {
      original: obj,
      style: { stroke: obj.stroke, strokeWidth: obj.strokeWidth, opacity: obj.opacity, strokeDashArray: obj.strokeDashArray, strokeLineCap: obj.strokeLineCap },
      hStart: mkHandle(s, '#FFFFFF'),
      hCtrl: mkHandle(q, '#F59E0B'),
      hEnd: mkHandle(e, '#FFFFFF'),
      preview: null, arm1: null, arm2: null,
    };
    c.add(this._curveEdit.hStart, this._curveEdit.hCtrl, this._curveEdit.hEnd);
    this._updateCurveEditPreview();
    this.onModeChange();
  }

  _updateCurveEditPreview() {
    const ce = this._curveEdit;
    if (!ce) return;
    const c = this.canvas;
    [ce.preview, ce.arm1, ce.arm2].forEach((o) => o && c.remove(o));
    const s = ce.hStart.getCenterPoint();
    const q = ce.hCtrl.getCenterPoint();
    const e = ce.hEnd.getCenterPoint();
    ce.preview = new fabric.Path(`M ${s.x} ${s.y} Q ${q.x} ${q.y} ${e.x} ${e.y}`, {
      ...ce.style, fill: '', selectable: false, evented: false,
    });
    const armStyle = { stroke: '#F59E0B', strokeWidth: 1, strokeDashArray: [4, 4], selectable: false, evented: false };
    ce.arm1 = new fabric.Line([s.x, s.y, q.x, q.y], armStyle);
    ce.arm2 = new fabric.Line([e.x, e.y, q.x, q.y], armStyle);
    c.add(ce.preview, ce.arm1, ce.arm2);
    [ce.hStart, ce.hCtrl, ce.hEnd].forEach((h) => h.bringToFront());
    c.requestRenderAll();
  }

  finishCurveEdit(apply) {
    if (!this._curveEdit) return;
    const ce = this._curveEdit;
    this._curveEdit = null;
    const c = this.canvas;
    [ce.preview, ce.arm1, ce.arm2, ce.hStart, ce.hCtrl, ce.hEnd].forEach((o) => o && c.remove(o));
    if (apply) {
      const s = ce.hStart.getCenterPoint();
      const q = ce.hCtrl.getCenterPoint();
      const e = ce.hEnd.getCenterPoint();
      const nu = new fabric.Path(`M ${s.x} ${s.y} Q ${q.x} ${q.y} ${e.x} ${e.y}`, { ...ce.style, fill: '', isCurve: true });
      c.add(nu);
      this._internal = false;
      if (ce.original.oid) this._queueOp({ t: 'del', oid: ce.original.oid });
      if (!nu.oid) nu.oid = 'o' + Math.random().toString(36).slice(2, 11);
      this._queueOp({ t: 'add', o: this._ser(nu) });
    } else {
      c.add(ce.original);
      this._internal = false;
    }
    c.requestRenderAll();
    if (apply) this.commit();
    this._applyToolConfig();
    this.onModeChange();
  }

  // ---------- comment anchors ----------

  findByOid(oid) {
    return this.canvas.getObjects().find((o) => o.oid === oid) || null;
  }

  // Screen position (within the canvas element) of an object's top-right corner
  anchorPos(obj) {
    const r = obj.getBoundingRect(); // viewport coordinates
    return { x: r.left + r.width, y: r.top };
  }

  // What kind of thing is selected (drives contextual actions)
  getActiveKind() {
    const o = this.canvas.getActiveObject();
    if (!o || (this._crop && o === this._crop.rect) || o.isEditHandle) return null;
    if (o.type === 'image' && !o.docPage) return 'image';
    if (this._isEditableCurve(o)) return 'curve';
    if (this.isFreehandPath(o)) return 'stroke';
    return 'object';
  }

  // A single hand-drawn pen stroke (fabric path with several segments)
  isFreehandPath(obj) {
    const o = obj || this.canvas.getActiveObject();
    return !!(o && o.type === 'path' && Array.isArray(o.path) && o.path.length > 4 && !o.docPage);
  }

  // Recognize the selected freehand stroke and replace it with a clean shape.
  // Returns the recognized kind, or null if it couldn't be tidied.
  beautifyActive() {
    const c = this.canvas;
    const o = c.getActiveObject();
    if (!this.isFreehandPath(o)) return null;
    const pts = [];
    for (const seg of o.path) {
      const n = seg.length;
      if (n >= 3) pts.push({ x: seg[n - 2], y: seg[n - 1] });
    }
    if (pts.length < 3) return null;
    const res = _classifyStroke(pts);
    if (!res) return null;

    o.setCoords();
    const ac = o.aCoords; // scene-space corners
    const xs = [ac.tl.x, ac.tr.x, ac.br.x, ac.bl.x];
    const ys = [ac.tl.y, ac.tr.y, ac.br.y, ac.bl.y];
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const w = maxX - minX, h = maxY - minY;
    const stroke = o.stroke || this.color;
    const sw = Math.max(1, (o.strokeWidth || 2) * (((o.scaleX || 1) + (o.scaleY || 1)) / 2));
    const base = {
      left: minX, top: minY, stroke, strokeWidth: sw,
      fill: o.fill && o.fill !== 'transparent' ? o.fill : 'transparent',
      strokeLineJoin: 'round', strokeLineCap: 'round', originX: 'left', originY: 'top',
    };

    let shape;
    if (res.kind === 'line') {
      // decide the diagonal direction from the raw endpoints
      const dx = res.b.x - res.a.x, dy = res.b.y - res.a.y;
      let x1, y1, x2, y2;
      if (h < 0.18 * w) { y1 = y2 = (minY + maxY) / 2; x1 = minX; x2 = maxX; }
      else if (w < 0.18 * h) { x1 = x2 = (minX + maxX) / 2; y1 = minY; y2 = maxY; }
      else if ((dx >= 0) === (dy >= 0)) { x1 = minX; y1 = minY; x2 = maxX; y2 = maxY; }
      else { x1 = minX; y1 = maxY; x2 = maxX; y2 = minY; }
      shape = new fabric.Line([x1, y1, x2, y2], { stroke, strokeWidth: sw, strokeLineCap: 'round' });
    } else if (res.kind === 'rect') {
      shape = new fabric.Rect({ ...base, width: w, height: h, rx: 0, ry: 0 });
    } else if (res.kind === 'triangle') {
      shape = new fabric.Triangle({ ...base, width: w, height: h });
    } else if (res.kind === 'ellipse') {
      shape = new fabric.Ellipse({ ...base, rx: w / 2, ry: h / 2 });
    } else {
      return null;
    }

    c.remove(o);
    c.add(shape);
    c.setActiveObject(shape);
    c.requestRenderAll();
    if (this.onSelection) this.onSelection(this.getActiveKind());
    return res.kind;
  }

  // ----- text -----

  _handleText(opt, p) {
    const c = this.canvas;
    if (opt.target && opt.target.isType('i-text')) {
      // Legacy text typed in the drifting display font: move it to the safe
      // font so its caret lines up now that it's being edited again.
      if (/bricolage/i.test(opt.target.fontFamily || '')) {
        opt.target.set('fontFamily', TEXT_FONT);
        if (typeof opt.target.initDimensions === 'function') opt.target.initDimensions();
      }
      c.setActiveObject(opt.target);
      opt.target.enterEditing();
      return;
    }
    const it = new fabric.IText('', {
      left: p.x,
      top: p.y,
      fontFamily: TEXT_FONT,
      fontSize: 28,
      fill: this.color,
      opacity: this.opacity,
    });
    this._internal = true;
    c.add(it);
    this._internal = false;
    c.setActiveObject(it);
    it.enterEditing();
    it.on('editing:exited', () => {
      if (!it.text.trim()) {
        this._internal = true;
        c.remove(it);
        this._internal = false;
      } else {
        this.commit();
      }
    });
  }

  isEditingText() {
    const o = this.canvas.getActiveObject();
    return !!(o && o.isEditing);
  }
}

// Read-only viewer used for "teacher is sharing" and the teacher's student close-up
class BoardViewer {
  constructor(canvasEl) {
    this.canvas = new fabric.StaticCanvas(canvasEl, { backgroundColor: '#ffffff' });
  }
  setSize(w, h) {
    this.canvas.setDimensions({ width: w, height: h });
  }
  refit() {
    fitToContent(this.canvas, 24);
  }
  // ---- document pages (imported PDF/doc pages carry a docPage number) ----
  getDocPages() {
    return this.canvas.getObjects()
      .filter((o) => o.docPage)
      .sort((a, b) => a.docPage - b.docPage);
  }
  // Fit a single page and center it in the viewport
  gotoDocPage(n) {
    const page = this.getDocPages().find((o) => o.docPage === n);
    if (!page) return;
    const c = this.canvas;
    const w = page.getScaledWidth();
    const h = page.getScaledHeight();
    const zoom = Math.min((c.getWidth() - 40) / w, (c.getHeight() - 40) / h, 2);
    const left = (c.getWidth() - w * zoom) / 2 - page.left * zoom;
    const top = (c.getHeight() - h * zoom) / 2 - page.top * zoom;
    c.setViewportTransform([zoom, 0, 0, zoom, left, top]);
    c.requestRenderAll();
  }
  // The page whose center is nearest the center of the current view (pages are shown centered)
  getCurrentDocPage() {
    const pages = this.getDocPages();
    if (!pages.length) return 0;
    const c = this.canvas;
    const vpt = c.viewportTransform;
    const viewMidScene = (c.getHeight() / 2 - vpt[5]) / vpt[3];
    let best = pages[0].docPage;
    let bestDist = Infinity;
    for (const p of pages) {
      const mid = p.top + p.getScaledHeight() / 2;
      const d = Math.abs(mid - viewMidScene);
      if (d < bestDist) { bestDist = d; best = p.docPage; }
    }
    return best;
  }
  // Let the viewer scroll-pan, ctrl/pinch-zoom, and drag-pan like the main board
  enableNav() {
    if (this._nav) return;
    this._nav = true;
    const el = this.canvas.lowerCanvasEl;
    el.style.touchAction = 'none';
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const c = this.canvas;
      if (e.ctrlKey || e.metaKey) {
        let z = Math.min(8, Math.max(0.1, c.getZoom() * Math.pow(0.995, e.deltaY)));
        const r = el.getBoundingClientRect();
        c.zoomToPoint(new fabric.Point(e.clientX - r.left, e.clientY - r.top), z);
      } else {
        c.relativePan(new fabric.Point(-e.deltaX, -e.deltaY));
      }
      c.requestRenderAll();
    }, { passive: false });
    let drag = null;
    el.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY };
      try { el.setPointerCapture(e.pointerId); } catch { /* ok */ }
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.canvas.relativePan(new fabric.Point(e.clientX - drag.x, e.clientY - drag.y));
      drag = { x: e.clientX, y: e.clientY };
      this.canvas.requestRenderAll();
    });
    el.addEventListener('pointerup', () => { drag = null; });
    el.addEventListener('pointercancel', () => { drag = null; });
  }
  load(json) {
    if (!json) {
      this.canvas.clear();
      this.canvas.backgroundColor = '#ffffff';
      this.canvas.renderAll();
      return;
    }
    this.canvas.loadFromJSON(json, () => {
      this.canvas.backgroundColor = '#ffffff';
      fitToContent(this.canvas, 24);
    });
  }
  // Like load(), but resolves once the board is fully rendered (images enlivened),
  // so callers can snapshot it with toDataURL — used by the "export all boards" PDF.
  loadAsync(json) {
    return new Promise((resolve) => {
      if (!json) { this.load(null); return resolve(); }
      this.canvas.loadFromJSON(json, () => {
        this.canvas.backgroundColor = '#ffffff';
        fitToContent(this.canvas, 24);
        this.canvas.renderAll();
        resolve();
      });
    });
  }
  // Apply incremental ops to the read-only view
  applyOps(ops) {
    const c = this.canvas;
    const step = (i) => {
      if (i >= ops.length) return c.requestRenderAll();
      const op = ops[i];
      if (op.t === 'full') return this.load(op.json);
      if (op.t === 'clear') {
        c.getObjects().slice().forEach((o) => c.remove(o));
        return step(i + 1);
      }
      if (op.t === 'del') {
        const o = c.getObjects().find((x) => x.oid === op.oid);
        if (o) c.remove(o);
        return step(i + 1);
      }
      if ((op.t === 'add' || op.t === 'mod') && op.o) {
        return fabric.util.enlivenObjects([op.o], (objs) => {
          const nu = objs[0];
          if (nu) {
            const old = op.o.oid ? c.getObjects().find((x) => x.oid === op.o.oid) : null;
            if (old) {
              const idx = c.getObjects().indexOf(old);
              c.remove(old);
              c.insertAt(nu, Math.max(0, idx));
            } else {
              c.add(nu);
            }
          }
          step(i + 1);
        });
      }
      step(i + 1);
    };
    step(0);
  }
}
