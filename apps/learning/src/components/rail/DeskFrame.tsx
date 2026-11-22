"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Dict } from "@/lib/i18n";
import { DESK_ORIGIN, DESK_TYPE, deskEmbedUrl } from "@/lib/desk";
import type { WidgetKind } from "@/lib/widgets";

/** Teacher's Desk's mark: its three shapes (the desk's own app icon). */
export function DeskMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true" focusable="false">
      <circle cx="128" cy="128" r="128" fill="#ec3013" />
      <rect x="256" y="0" width="256" height="256" fill="#1f4fd1" />
      <path d="M256 256 512 512 0 512Z" fill="#f5c400" />
    </svg>
  );
}

/** A card's place, in the frame's own pixels (Desk sends it when a card opens larger). */
type Spot = { x: number; y: number; w: number; h: number };
const isSpot = (r: unknown): r is Spot => !!r && typeof r === "object"
  && (["x", "y", "w", "h"] as const).every((k) => Number.isFinite((r as Record<string, unknown>)[k])) && (r as Spot).w > 0 && (r as Spot).h > 0;

const EASE = "cubic-bezier(.2,.7,.2,1)";
const calm = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The transform that puts a full-window frame over `to` (viewport pixels). */
function over(to: Spot): Keyframe {
  return {
    transform: `translate(${to.x}px, ${to.y}px) scale(${to.w / window.innerWidth}, ${to.h / window.innerHeight})`,
    borderRadius: `${Math.round(14 * window.innerWidth / to.w)}px / ${Math.round(14 * window.innerHeight / to.h)}px`,
  };
}
const whole: Keyframe = { transform: "translate(0px, 0px) scale(1, 1)", borderRadius: "0px" };

/**
 * While a card is open larger, everything but the frame is set aside: inert
 * (out of reach of keys, clicks and screen readers) and, for what sits on
 * the page itself — the Signify app switcher in the top corner, whose button
 * landed on the big view's close button — hidden too. Undone exactly.
 */
function setAside(frame: HTMLElement): () => void {
  const done: { el: HTMLElement; inert: boolean; visibility: string }[] = [];
  for (let n: HTMLElement | null = frame; n && n.parentElement && n !== document.body; n = n.parentElement) {
    const parent: HTMLElement = n.parentElement;
    for (const sib of Array.from(parent.children) as Element[]) {
      if (sib === n || !(sib instanceof HTMLElement) || sib.tagName === "SCRIPT" || sib.tagName === "STYLE") continue;
      done.push({ el: sib, inert: sib.inert, visibility: sib.style.visibility });
      sib.inert = true;
      if (parent === document.body) sib.style.visibility = "hidden";
    }
  }
  return () => { for (const d of done) { d.el.inert = d.inert; d.el.style.visibility = d.visibility; } };
}

/**
 * The rail's tools are Teacher's Desk's own: one frame of desk.signify.one/embed
 * showing the person's real cards (the same timer, the same seating plans as
 * on their desk), drawn and saved by Desk with the person's own Desk sign-in.
 * One frame for all of them, so it is one desk tab, never several racing
 * each other's saves. Desk tells us (postMessage, checked against its
 * origin) how tall it is and when a card opens larger; then the frame fills
 * the window until Desk says it closed. Opening, the frame grows out of the
 * card's place in the rail; closing, Desk says "closing", the frame shrinks
 * back into that place, we say "closed", and Desk puts the card back.
 */
export function DeskFrame({ d, kinds, idClassId, hidden }: { d: Dict; kinds: WidgetKind[]; idClassId: string | null; hidden: boolean }) {
  const [height, setHeight] = useState(160);
  const [big, setBig] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  const bigNow = useRef(false);
  /** Where the card sits inside the frame, and where that was on screen when it opened. */
  const spot = useRef<{ inFrame: Spot; from: Spot } | null>(null);

  const types = kinds.map((k) => DESK_TYPE[k]);
  const key = `${types.join(",")}|${idClassId ?? ""}`;
  // Built in the browser: Desk only talks back to the origin it was told, and checks it.
  useEffect(() => { setSrc(deskEmbedUrl(types, idClassId, location.origin)); setLoaded(false); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const closed = () => {
      try { frame.current?.contentWindow?.postMessage({ desk: 1, closed: true }, DESK_ORIGIN); } catch { /* gone */ }
    };
    const shrink = () => {
      const f = frame.current;
      const s = spot.current;
      const box = slot.current?.getBoundingClientRect();
      if (!f || !s || !box || calm()) return closed();
      const to = { x: box.left + s.inFrame.x, y: box.top + s.inFrame.y, w: s.inFrame.w, h: s.inFrame.h };
      const run = f.animate([whole, over(to)], { duration: 300, easing: EASE, fill: "forwards" });
      let sent = false;
      const finish = () => {
        if (sent) return;
        sent = true;
        // Blank for the moment between Desk taking the big view away and the
        // frame going back into the rail, so the wide board behind it never shows.
        f.style.opacity = "0";
        closed();
      };
      run.finished.then(finish, finish);
      setTimeout(finish, 420); // a background tab pauses animations
    };
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== DESK_ORIGIN || e.source !== frame.current?.contentWindow) return;
      const m = e.data as { desk?: number; height?: number; stage?: boolean | "closing"; rect?: unknown };
      if (!m || m.desk !== 1) return;
      // While a card fills the window the board behind it is window-wide; its height means nothing to the rail.
      if (typeof m.height === "number" && m.height > 0 && !bigNow.current) setHeight(Math.min(4000, Math.round(m.height)));
      if (m.stage === true) {
        const at = frame.current?.getBoundingClientRect();
        spot.current = at && isSpot(m.rect)
          ? { inFrame: m.rect, from: { x: at.left + m.rect.x, y: at.top + m.rect.y, w: m.rect.w, h: m.rect.h } } : null;
        bigNow.current = true;
        setBig(true);
      } else if (m.stage === "closing") {
        shrink();
      } else if (m.stage === false) {
        bigNow.current = false;
        setBig(false);
        const f = frame.current;
        if (f) { f.getAnimations().forEach((a) => a.cancel()); f.style.opacity = ""; }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Opening: grow out of the card's place. Before paint, so the frame is never seen full-size first.
  useLayoutEffect(() => {
    const f = frame.current;
    if (!big || !f) return;
    const s = spot.current;
    if (s && !calm()) f.animate([over(s.from), whole], { duration: 340, easing: EASE });
    return setAside(f);
  }, [big]);

  if (!src) return null;
  return (
    <div ref={slot} className={`desk-frame ${big ? "is-big" : ""}`} hidden={hidden} style={big ? { minHeight: height } : undefined}>
      {!loaded && <p className="muted wg-small" style={{ margin: 0 }}>{d.wgLoading}</p>}
      <iframe
        ref={frame}
        src={src}
        title={d.wgDeskFrame}
        style={big ? undefined : { height }}
        allow={`microphone ${DESK_ORIGIN}; fullscreen ${DESK_ORIGIN}; clipboard-write ${DESK_ORIGIN}`}
        onLoad={() => setLoaded(true)}
      />
    </div>
  );
}
