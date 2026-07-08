/* global fabric */
'use strict';

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

const SHAPE_TOOLS = ['line', 'arrow', 'rect', 'ellipse', 'triangle'];

// Custom/state props that must survive serialization (document pages are locked images)
const PERSIST_PROPS = ['selectable', 'evented', 'docPage', 'hoverCursor', 'isCurve', 'cropX', 'cropY'];

class Whiteboard {
  constructor(canvasId, container, { onChange, onViewChange, onSelection, onModeChange } = {}) {
    this.container = container;
    this.canvas = new fabric.Canvas(canvasId, {
      backgroundColor: '#ffffff',
      preserveObjectStacking: true,
      stopContextMenu: true,
    });
    this.onChange = onChange || (() => {});
    this.onViewChange = onViewChange || (() => {});
    this.onSelection = onSelection || (() => {});
    this.onModeChange = onModeChange || (() => {});

    this.tool = 'select';
    this.handMode = 'board'; // 'board' pans, 'objects' manipulates
    this.color = '#1e293b';
    this.strokeWidth = 4;
    this.fillShapes = false;
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
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this._snapshot();
  }

  resize() {
    this.canvas.setDimensions({
      width: this.container.clientWidth,
      height: this.container.clientHeight,
    });
    this.canvas.requestRenderAll();
  }

  // ---------- change tracking / undo ----------

  commit() {
    if (this._internal) return;
    this._snapshot();
    this._emitChange();
  }

  _snapshot() {
    const json = JSON.stringify(this.canvas.toJSON(PERSIST_PROPS));
    if (this._undo[this._undo.length - 1] === json) return;
    this._undo.push(json);
    if (this._undo.length > 60) this._undo.shift();
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
  }

  redo() {
    if (!this._redo.length) return;
    const s = this._redo.pop();
    this._undo.push(s);
    this._loadString(s);
  }

  _loadString(s) {
    this._internal = true;
    this.canvas.loadFromJSON(s, () => {
      this.canvas.backgroundColor = '#ffffff';
      this.canvas.renderAll();
      this._internal = false;
      this._emitChange();
    });
  }

  getJSON() {
    return this.canvas.toJSON(PERSIST_PROPS);
  }

  loadJSON(json, cb) {
    this._internal = true;
    this.canvas.loadFromJSON(json, () => {
      this.canvas.backgroundColor = '#ffffff';
      this.canvas.renderAll();
      this._internal = false;
      this._snapshot();
      if (cb) cb();
    });
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
    c.isDrawingMode = t === 'pen' || t === 'highlighter';
    if (c.isDrawingMode) {
      const brush = new fabric.PencilBrush(c);
      if (t === 'highlighter') {
        brush.color = hexToRgba(this.color, 0.35);
        brush.width = Math.max(this.strokeWidth * 5, 18);
      } else {
        brush.color = this.color;
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

  deleteSelection() {
    if (this._crop || this._curveEdit) return;
    const c = this.canvas;
    const objs = c.getActiveObjects();
    if (!objs.length) return;
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

  addDocumentPages(dataUrls, done) {
    const c = this.canvas;
    const existing = this.getDocPages();
    let startPage = existing.length;
    // stack new pages below everything already on the board
    let y = 0;
    c.getObjects().forEach((o) => {
      const r = o.getBoundingRect(true, true);
      y = Math.max(y, r.top + r.height + 40);
    });
    this._internal = true;
    const addOne = (i) => {
      if (i >= dataUrls.length) {
        this._internal = false;
        this.commit();
        this.gotoDocPage(startPage + 1);
        if (done) done(dataUrls.length);
        return;
      }
      fabric.Image.fromURL(dataUrls[i], (img) => {
        img.set({
          left: 0, top: y,
          selectable: false, evented: false,
          hoverCursor: 'default',
          docPage: startPage + i + 1,
        });
        y += img.height + 24;
        c.add(img);
        img.moveTo(i); // keep pages underneath drawings
        addOne(i + 1);
      });
    };
    addOne(0);
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
    o.dirty = true;
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

    c.on('object:added', () => this.commit());
    c.on('object:modified', () => this.commit());
    c.on('object:removed', () => this.commit());
    c.on('text:changed', () => this._emitChange());

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
      this._panning = true;
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
      c.relativePan(new fabric.Point(e.movementX, e.movementY));
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
    const common = {
      stroke: this.color,
      strokeWidth: this.strokeWidth,
      fill: this.fillShapes ? hexToRgba(this.color, 0.25) : 'transparent',
      selectable: false,
      evented: false,
      strokeUniform: true,
    };
    let obj;
    if (tool === 'line' || tool === 'arrow') {
      obj = new fabric.Line([p.x, p.y, p.x, p.y], {
        stroke: this.color, strokeWidth: this.strokeWidth, selectable: false, evented: false,
      });
    } else if (tool === 'rect') {
      obj = new fabric.Rect({ ...common, left: p.x, top: p.y, width: 1, height: 1 });
    } else if (tool === 'ellipse') {
      obj = new fabric.Ellipse({ ...common, left: p.x, top: p.y, rx: 1, ry: 1 });
    } else {
      obj = new fabric.Triangle({ ...common, left: p.x, top: p.y, width: 1, height: 1 });
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
      tooSmall = (obj.width || obj.rx * 2 || 0) < 4 && (obj.height || obj.ry * 2 || 0) < 4;
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
    this.commit();
    void origin;
  }

  _makeArrow(line) {
    const { x1, y1, x2, y2 } = line;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const headLen = Math.max(14, line.strokeWidth * 4);
    const body = new fabric.Line([x1, y1, x2, y2], { stroke: line.stroke, strokeWidth: line.strokeWidth });
    const head = new fabric.Triangle({
      left: x2, top: y2, originX: 'center', originY: 'center',
      width: headLen, height: headLen,
      angle: (angle * 180) / Math.PI + 90,
      fill: line.stroke,
    });
    return new fabric.Group([body, head]);
  }

  // ----- curve tool: drag to set the line, move to bend, click to place -----

  _curveDown(p) {
    if (this._curve && this._curve.phase === 'bend') {
      const obj = this._curve.obj;
      obj.set({ selectable: true, evented: true, isCurve: true });
      obj.setCoords();
      this._curve = null;
      this._internal = false;
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
      style: { stroke: obj.stroke, strokeWidth: obj.strokeWidth, opacity: obj.opacity },
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
      c.add(new fabric.Path(`M ${s.x} ${s.y} Q ${q.x} ${q.y} ${e.x} ${e.y}`, { ...ce.style, fill: '', isCurve: true }));
    } else {
      c.add(ce.original);
    }
    c.requestRenderAll();
    this._internal = false;
    if (apply) this.commit();
    this._applyToolConfig();
    this.onModeChange();
  }

  // What kind of thing is selected (drives contextual actions)
  getActiveKind() {
    const o = this.canvas.getActiveObject();
    if (!o || (this._crop && o === this._crop.rect) || o.isEditHandle) return null;
    if (o.type === 'image' && !o.docPage) return 'image';
    if (this._isEditableCurve(o)) return 'curve';
    return 'object';
  }

  // ----- text -----

  _handleText(opt, p) {
    const c = this.canvas;
    if (opt.target && opt.target.isType('i-text')) {
      c.setActiveObject(opt.target);
      opt.target.enterEditing();
      return;
    }
    const it = new fabric.IText('', {
      left: p.x,
      top: p.y,
      fontFamily: 'Arial',
      fontSize: 28,
      fill: this.color,
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
}
