"use client";

import { useEffect } from "react";

const KEY = "learning:class-tabs-x";

/**
 * Keeps a sideways-scrolling tab row where the teacher left it from one
 * page to the next (only matters where the row is wider than the screen),
 * and brings the current tab into view only if it would be hidden.
 */
export default function TabsKeep({ id }: { id: string }) {
  useEffect(() => {
    const nav = document.getElementById(id);
    if (!nav) return;
    try { nav.scrollLeft = Number(sessionStorage.getItem(KEY)) || 0; } catch { /* no storage */ }
    const cur = nav.querySelector<HTMLElement>('[aria-current="page"]');
    if (cur) {
      const l = cur.offsetLeft, r = l + cur.offsetWidth;
      if (l < nav.scrollLeft) nav.scrollLeft = l;
      else if (r > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = r - nav.clientWidth;
    }
    const save = () => { try { sessionStorage.setItem(KEY, String(nav.scrollLeft)); } catch { /* no storage */ } };
    nav.addEventListener("scroll", save, { passive: true });
    return () => nav.removeEventListener("scroll", save);
  }, [id]);
  return null;
}
