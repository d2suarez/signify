"use client";

import { useEffect } from "react";

/**
 * Makes the class header small once the page is scrolled (it stays at the
 * top, in the top bar). Two thresholds so a page that only just scrolls
 * doesn't flicker between the sizes as the header's own height changes.
 */
export default function ClassHeadShrink() {
  useEffect(() => {
    const root = document.documentElement;
    let raf = 0;
    const look = () => {
      raf = 0;
      const y = window.scrollY;
      if (y > 64 && root.dataset.classSmall !== "1") root.dataset.classSmall = "1";
      else if (y < 8 && root.dataset.classSmall === "1") delete root.dataset.classSmall;
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(look); };
    look();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => { window.removeEventListener("scroll", onScroll); if (raf) cancelAnimationFrame(raf); delete root.dataset.classSmall; };
  }, []);
  return null;
}
