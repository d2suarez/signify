"use client";

import { useEffect, useRef, useState } from "react";

export type LightboxLabels = { title: string; close: string; prev: string; next: string; count: string; original: string };

type Pic = { href: string; src: string; alt: string };

/**
 * Wraps one post's body. Its pictures are plain links to `/files/<id>` (they
 * still open the picture without JavaScript); with JavaScript a click opens
 * them here instead, in a native <dialog>, paging through only this post's
 * pictures with buttons, arrow keys or a swipe. Focus goes to the close
 * button and back to the picture that opened it; Esc and the backdrop close.
 */
export function Lightbox({ labels, children }: { labels: LightboxLabels; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const touchX = useRef<number | null>(null);
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
    setPics(all.map((l) => {
      const img = l.querySelector("img");
      return { href: l.href, src: img?.currentSrc || img?.src || l.href, alt: img?.alt ?? "" };
    }));
    setAt(i);
    dialog.current?.showModal();
    closeBtn.current?.focus();
  }

  function go(step: number) {
    if (pics.length < 2) return;
    setAt((n) => (n + step + pics.length) % pics.length);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
  }

  const pic = pics[at];
  const many = pics.length > 1;
  const count = labels.count.replace("{n}", String(at + 1)).replace("{total}", String(pics.length));

  return (
    <div ref={box} onClick={onClick}>
      {children}
      <dialog ref={dialog} className="dialog lightbox" aria-label={labels.title}
        onKeyDown={onKey}
        onClick={(e) => { e.stopPropagation(); if (e.target === dialog.current) dialog.current?.close(); }}
        onClose={() => { const o = opener.current; opener.current = null; o?.focus(); }}>
        <div className="lightbox-in">
          <div className="lightbox-bar">
            <span className="lightbox-count" aria-live="polite" aria-atomic="true">{many ? count : ""}</span>
            {pic && <a className="btn btn-sm" href={pic.href} target="_blank" rel="noopener">{labels.original}</a>}
            <button ref={closeBtn} type="button" className="btn btn-sm" onClick={() => dialog.current?.close()}>{labels.close}</button>
          </div>
          <figure className="lightbox-fig"
            onTouchStart={(e) => { touchX.current = e.touches.length === 1 ? e.touches[0].clientX : null; }}
            onTouchEnd={(e) => {
              const x0 = touchX.current; touchX.current = null;
              if (x0 == null) return;
              const dx = e.changedTouches[0].clientX - x0;
              if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
            }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {pic && <img key={pic.src} src={pic.src} alt={pic.alt} />}
            {pic?.alt && <figcaption>{pic.alt}</figcaption>}
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
