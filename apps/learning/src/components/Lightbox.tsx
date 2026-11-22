"use client";

import { useEffect, useRef, useState } from "react";

export type LightboxLabels = { title: string; close: string; prev: string; next: string; count: string; original: string; zoomIn: string; zoomOut: string };

type Pic = { href: string; src: string; alt: string };

const MAX_ZOOM = 4;
const STEPS = [1, 1.5, 2, 3, 4];

/**
 * Wraps one post's body. Its pictures are plain links to `/files/<id>` (they
 * still open the picture without JavaScript); with JavaScript a click opens
 * them here instead, in a native <dialog>, paging through only this post's
 * pictures with buttons, arrow keys or a sideways swipe. Focus goes to the
 * close button and back to the picture that opened it; Esc, the backdrop and
 * a swipe down (the picture follows the finger) close.
 *
 * Zoom: pinch, double-tap/double-click, the + and − buttons or the + − 0
 * keys. Zoomed, the picture sits in a scroll box of the size it had, so a
 * finger, the mouse wheel, scroll bars or the arrow keys move around it, and
 * swipes no longer page or close. Paging or closing goes back to the whole picture.
 */
export function Lightbox({ labels, children }: { labels: LightboxLabels; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const touch = useRef<{ x: number; y: number; atTop: boolean } | null>(null);
  const fig = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  // Zoom lives in refs while fingers move (no re-render per frame); `zoomed` is for the buttons.
  const zoom = useRef(1);
  const base = useRef<{ w: number; h: number } | null>(null);
  const [zoomed, setZoomed] = useState(1);
  const [pics, setPics] = useState<Pic[]>([]);
  const [at, setAt] = useState(0);

  const links = () => Array.from(box.current?.querySelectorAll<HTMLAnchorElement>("a.post-figure-link") ?? []);

  // Only once JavaScript runs does a picture open a dialog, so say so then.
  useEffect(() => { for (const a of links()) a.setAttribute("aria-haspopup", "dialog"); }, []);

  function onClick(e: React.MouseEvent) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // let "open in new tab" work
    const a = (e.target as Element).closest?.("a.post-figure-link");
    if (!a || !box.current?.contains(a)) return;
    const all = links();
    const i = all.indexOf(a as HTMLAnchorElement);
    if (i < 0) return;
    e.preventDefault();
    opener.current = a as HTMLElement;
    resetZoom();
    setPics(all.map((l) => {
      const im = l.querySelector("img");
      return { href: l.href, src: im?.currentSrc || im?.src || l.href, alt: im?.alt ?? "" };
    }));
    setAt(i);
    dialog.current?.showModal();
    closeBtn.current?.focus();
  }

  // Close and give focus back to the picture that opened it. Our own closes
  // do it at once; Esc closes natively and comes through onClose.
  function backToOpener() { resetZoom(); const o = opener.current; opener.current = null; o?.focus(); }
  function shut() { dialog.current?.close(); backToOpener(); }

  function go(step: number) {
    if (pics.length < 2) return;
    resetZoom();
    setAt((n) => (n + step + pics.length) % pics.length);
  }

  /* ---------- zoom ---------- */

  function resetZoom() {
    zoom.current = 1;
    base.current = null;
    const st = stage.current, im = img.current;
    if (st) { st.classList.remove("is-zoomed"); st.style.width = st.style.height = ""; }
    if (im) im.style.width = im.style.height = "";
    setZoomed(1);
  }

  /**
   * Zoom to `z`, keeping the point of the picture under (cx, cy) (screen
   * coordinates) where it is. The first zoom freezes the stage at the size the
   * picture had, so the page around it doesn't move.
   */
  function zoomTo(z: number, cx?: number, cy?: number) {
    const st = stage.current, im = img.current;
    if (!st || !im || !im.naturalWidth) return;
    z = Math.min(MAX_ZOOM, Math.max(1, z));
    if (z <= 1.01) { resetZoom(); return; }
    if (!base.current) {
      // The picture's own box (object-fit may leave bands): what it shows is
      // the largest box of its shape that fits.
      const bw = im.offsetWidth, bh = im.offsetHeight, ar = im.naturalWidth / im.naturalHeight;
      const w = Math.min(bw, bh * ar);
      base.current = { w, h: w / ar };
      st.style.width = `${bw}px`;
      st.style.height = `${bh}px`;
      st.classList.add("is-zoomed");
      im.style.width = `${w}px`;
      im.style.height = `${w / ar}px`;
    }
    const r = st.getBoundingClientRect();
    const k = r.width / st.offsetWidth || 1; // Larger text zooms main: screen px per CSS px
    const lx = ((cx ?? r.left + r.width / 2) - r.left) / k, ly = ((cy ?? r.top + r.height / 2) - r.top) / k;
    const fx = (st.scrollLeft + lx - im.offsetLeft) / im.offsetWidth;
    const fy = (st.scrollTop + ly - im.offsetTop) / im.offsetHeight;
    zoom.current = z;
    im.style.width = `${base.current.w * z}px`;
    im.style.height = `${base.current.h * z}px`;
    st.scrollLeft = im.offsetLeft + fx * im.offsetWidth - lx;
    st.scrollTop = im.offsetTop + fy * im.offsetHeight - ly;
  }

  function step(dir: 1 | -1) {
    const z = zoom.current;
    const next = dir > 0 ? STEPS.find((s) => s > z + 0.01) ?? MAX_ZOOM : [...STEPS].reverse().find((s) => s < z - 0.01) ?? 1;
    zoomTo(next);
    setZoomed(zoom.current);
  }

  // Pinch needs listeners that may cancel the browser's own page zoom, which
  // React's (passive) touch handlers can't do.
  useEffect(() => {
    const el = fig.current;
    if (!el) return;
    let pinch: { d0: number; z0: number } | null = null;
    let pan: { x: number; y: number } | null = null;
    let tap: { t: number; x: number; y: number; moved: boolean } | null = null;
    let lastTap: { t: number; x: number; y: number } | null = null;
    const k = () => { const st = stage.current; return st && st.offsetWidth ? st.getBoundingClientRect().width / st.offsetWidth : 1; };
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const mid = (t: TouchList) => [(t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2] as const;
    const onPicture = (e: TouchEvent) => !!img.current && img.current.contains(e.target as Node);
    const start = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        pinch = { d0: dist(e.touches) || 1, z0: zoom.current };
        pan = tap = null;
      } else if (e.touches.length === 1) {
        const t = e.touches[0];
        tap = onPicture(e) ? { t: Date.now(), x: t.clientX, y: t.clientY, moved: false } : null;
        // Zoomed, one finger moves around the picture (the stage takes no native touch scrolling).
        pan = zoom.current > 1 && stage.current?.contains(e.target as Node) ? { x: t.clientX, y: t.clientY } : null;
      }
    };
    const move = (e: TouchEvent) => {
      if (pinch && e.touches.length === 2) {
        e.preventDefault();
        const [x, y] = mid(e.touches);
        zoomTo(pinch.z0 * dist(e.touches) / pinch.d0, x, y);
        return;
      }
      const t = e.touches[0];
      if (tap && Math.hypot(t.clientX - tap.x, t.clientY - tap.y) > 10) tap.moved = true;
      if (pan && e.touches.length === 1 && stage.current) {
        e.preventDefault();
        const f = k();
        stage.current.scrollLeft -= (t.clientX - pan.x) / f;
        stage.current.scrollTop -= (t.clientY - pan.y) / f;
        pan = { x: t.clientX, y: t.clientY };
      }
    };
    const end = (e: TouchEvent) => {
      if (pinch && e.touches.length < 2) {
        pinch = null;
        if (zoom.current < 1.05) resetZoom(); else setZoomed(zoom.current);
        lastTap = null;
        return;
      }
      if (e.touches.length) return;
      pan = null;
      // Double-tap: zoom in where tapped, or back to the whole picture.
      if (tap && !tap.moved && Date.now() - tap.t < 300) {
        const now = Date.now();
        if (lastTap && now - lastTap.t < 350 && Math.hypot(tap.x - lastTap.x, tap.y - lastTap.y) < 30) {
          e.preventDefault();
          lastTouchToggle.current = Date.now();
          toggleAt(tap.x, tap.y);
          lastTap = null;
        } else lastTap = { t: now, x: tap.x, y: tap.y };
      }
      tap = null;
    };
    const noGesture = (e: Event) => e.preventDefault(); // Safari's own pinch events
    el.addEventListener("touchstart", start, { passive: false });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end, { passive: false });
    el.addEventListener("touchcancel", end);
    el.addEventListener("gesturestart", noGesture);
    el.addEventListener("gesturechange", noGesture);
    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
      el.removeEventListener("gesturestart", noGesture);
      el.removeEventListener("gesturechange", noGesture);
    };
  }, []);

  const lastTouchToggle = useRef(0);
  function toggleAt(x: number, y: number) {
    if (zoom.current > 1) resetZoom();
    else { zoomTo(2.5, x, y); setZoomed(zoom.current); }
  }
  function onDoubleClick(e: React.MouseEvent) {
    if (Date.now() - lastTouchToggle.current < 600) return; // a double-tap already did it
    toggleAt(e.clientX, e.clientY);
  }

  // Zoomed, the mouse can drag the picture around too (the wheel and scroll bars also work).
  const mouse = useRef<{ x: number; y: number } | null>(null);
  function onPointerDown(e: React.PointerEvent) {
    if (e.pointerType !== "mouse" || e.button !== 0 || zoom.current <= 1) return;
    e.preventDefault();
    mouse.current = { x: e.clientX, y: e.clientY };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    const m = mouse.current, st = stage.current;
    if (!m || !st) return;
    const f = st.getBoundingClientRect().width / st.offsetWidth || 1;
    st.scrollLeft -= (e.clientX - m.x) / f;
    st.scrollTop -= (e.clientY - m.y) / f;
    mouse.current = { x: e.clientX, y: e.clientY };
  }

  /* ---------- keys and swipes ---------- */

  function onKey(e: React.KeyboardEvent) {
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (e.key === "+" || e.key === "=") { e.preventDefault(); step(1); }
    else if (e.key === "-" || e.key === "_") { e.preventDefault(); step(-1); }
    else if (e.key === "0") { e.preventDefault(); resetZoom(); }
    else if (zoom.current > 1 && arrows[e.key]) {
      // Zoomed, the arrows move around the picture.
      e.preventDefault();
      const [dx, dy] = arrows[e.key];
      stage.current?.scrollBy({ left: dx * 80, top: dy * 80 });
    }
    else if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
  }

  // Swipes on the picture area: sideways pages, down closes. Down only counts
  // when the area isn't scrolled into a long caption, so scrolling back up
  // never closes it by surprise. Zoomed, a finger moves the picture instead.
  function drag(dy: number) {
    const el = img.current;
    if (!el) return;
    el.style.transform = dy > 0 ? `translateY(${dy}px)` : "";
    el.style.opacity = dy > 0 ? String(Math.max(0.4, 1 - dy / 400)) : "";
  }
  function onTouchStart(e: React.TouchEvent<HTMLElement>) {
    const t = e.touches[0];
    touch.current = e.touches.length === 1 && zoom.current <= 1 ? { x: t.clientX, y: t.clientY, atTop: e.currentTarget.scrollTop <= 0 } : null;
  }
  function onTouchMove(e: React.TouchEvent<HTMLElement>) {
    const s = touch.current;
    if (!s) return;
    if (e.touches.length !== 1) { touch.current = null; drag(0); return; }
    if (!s.atTop) return;
    const dx = e.touches[0].clientX - s.x, dy = e.touches[0].clientY - s.y;
    drag(dy > Math.abs(dx) ? dy : 0);
  }
  function onTouchEnd(e: React.TouchEvent<HTMLElement>) {
    const s = touch.current;
    touch.current = null;
    drag(0);
    if (!s || e.touches.length) return;
    const dx = e.changedTouches[0].clientX - s.x, dy = e.changedTouches[0].clientY - s.y;
    if (s.atTop && dy > 80 && dy > Math.abs(dx) * 1.5) shut();
    else if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
  }

  const pic = pics[at];
  const many = pics.length > 1;
  const count = labels.count.replace("{n}", String(at + 1)).replace("{total}", String(pics.length));
  const canIn = zoomed < MAX_ZOOM - 0.01, canOut = zoomed > 1;

  return (
    <div ref={box} onClick={onClick}>
      {children}
      <dialog ref={dialog} className="dialog lightbox" aria-label={labels.title}
        onKeyDown={onKey}
        onClick={(e) => { e.stopPropagation(); if (e.target === dialog.current) shut(); }}
        onClose={() => { if (!dialog.current?.open) backToOpener(); }}>
        <div className="lightbox-in">
          <div className="lightbox-bar">
            <span className="lightbox-count" aria-live="polite" aria-atomic="true">{many ? count : ""}</span>
            {/* aria-disabled, not disabled: the button keeps focus at the end of the range. */}
            <button type="button" className="btn btn-sm lightbox-zoom" title={labels.zoomIn} aria-disabled={!canIn} onClick={() => canIn && step(1)}>
              <span aria-hidden="true">+</span><span className="sr-only">{labels.zoomIn}</span>
            </button>
            <button type="button" className="btn btn-sm lightbox-zoom" title={labels.zoomOut} aria-disabled={!canOut} onClick={() => canOut && step(-1)}>
              <span aria-hidden="true">−</span><span className="sr-only">{labels.zoomOut}</span>
            </button>
            <button ref={closeBtn} type="button" className="btn btn-sm" onClick={shut}>{labels.close}</button>
          </div>
          <figure ref={fig} className="lightbox-fig"
            onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
            onTouchCancel={() => { touch.current = null; drag(0); }}>
            <div ref={stage} className="lightbox-stage"
              onPointerDown={onPointerDown} onPointerMove={onPointerMove}
              onPointerUp={() => { mouse.current = null; }} onPointerCancel={() => { mouse.current = null; }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {pic && <img ref={img} key={pic.src} src={pic.src} alt={pic.alt} onDoubleClick={onDoubleClick} draggable={false} />}
            </div>
            {pic?.alt && <figcaption>{pic.alt}</figcaption>}
            {pic && <a className="lightbox-orig" href={pic.href} target="_blank" rel="noopener">{labels.original}</a>}
          </figure>
          {many && (
            <div className="lightbox-nav">
              <button type="button" className="btn" onClick={() => go(-1)}><span aria-hidden="true">←</span> {labels.prev}</button>
              <button type="button" className="btn" onClick={() => go(1)}>{labels.next} <span aria-hidden="true">→</span></button>
            </div>
          )}
        </div>
      </dialog>
    </div>
  );
}
