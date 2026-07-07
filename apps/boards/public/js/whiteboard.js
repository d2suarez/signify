/* global fabric */
'use strict';

function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
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

class Whiteboard {
  constructor(canvasId, container, { onChange, onViewChange } = {}) {
    this.container = container;
    this.canvas = new fabric.Canvas(canvasId, {
      backgroundColor: '#ffffff',
      preserveObjectStacking: true,
      stopContextMenu: true,
    });
    this.onChange = onChange || (() => {});
    this.onViewChange = onViewChange || (() => {});

    this.tool = 'select';
    this.color = '#1e293b';
    this.strokeWidth = 4;
    this.fillShapes = false;

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
    const json = JSON.stringify(this.canvas.toJSON());
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
    return this.canvas.toJSON();
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
    this._cancelCurve();
    this.tool = t;
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
    c.selection = t === 'select';
    c.skipTargetFind = !(t === 'select' || t === 'eraser' || t === 'text');
    c.defaultCursor = t === 'pan' ? 'grab' : t === 'select' ? 'default' : 'crosshair';
    if (t !== 'select') {
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
        fill: 'rgba(253, 246, 227, 0.95)', stroke: '#c8b273', strokeWidth: 1.5, rx: 6, ry: 6,
      }),
    ];
    for (let i = 0; i <= units; i++) {
      const x = pad + i * unit;
      parts.push(new fabric.Line([x, 0, x, 16], { stroke: '#7a6a3a', strokeWidth: 1.4 }));
      parts.push(new fabric.Text(String(i), {
        left: x, top: 20, fontSize: 12, fill: '#7a6a3a', originX: 'center', fontFamily: 'Arial',
      }));
      if (i < units) {
        parts.push(new fabric.Line([x + unit / 2, 0, x + unit / 2, 10], { stroke: '#7a6a3a', strokeWidth: 1 }));
      }
    }
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
      let zoom = c.getZoom() * Math.pow(0.999, e.deltaY);
      zoom = Math.min(8, Math.max(0.1, zoom));
      c.zoomToPoint(new fabric.Point(e.offsetX, e.offsetY), zoom);
      this.onViewChange();
    });

    c.on('mouse:down', (opt) => this._onDown(opt));
    c.on('mouse:move', (opt) => this._onMove(opt));
    c.on('mouse:up', (opt) => this._onUp(opt));

    c.on('object:added', () => this.commit());
    c.on('object:modified', () => this.commit());
    c.on('object:removed', () => this.commit());
    c.on('text:changed', () => this._emitChange());
  }

  _onDown(opt) {
    const c = this.canvas;
    const t = this.tool;
    if (c.isDrawingMode) return;
    const p = c.getPointer(opt.e);

    if (t === 'pan') {
      this._panning = true;
      c.defaultCursor = 'grabbing';
      return;
    }
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
      obj.set({ selectable: true, evented: true });
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
    this.canvas.discardActiveObject();
    this.canvas.requestRenderAll();
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
