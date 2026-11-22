"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * The course page's "More" menu for rarely used teacher actions. A plain <details>, so it
 * opens and closes by keyboard without script; this adds Esc (focus back on the button)
 * and closing when you click or tab outside it.
 */
export function CourseMenu({ label, title, children }: { label: string; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const close = (focus: boolean) => {
      if (!el.open) return;
      el.open = false;
      if (focus) el.querySelector("summary")?.focus();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && el.open) { e.preventDefault(); close(true); } };
    const onOutside = (e: Event) => { if (!el.contains(e.target as Node)) close(false); };
    el.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onOutside);
    document.addEventListener("focusin", onOutside);
    return () => {
      el.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onOutside);
      document.removeEventListener("focusin", onOutside);
    };
  }, []);
  return (
    <details ref={ref} className="menu course-menu">
      <summary className="btn" title={title}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
        <span>{label}</span>
      </summary>
      <div className="menu-pop card stack" style={{ gap: 12 }}>{children}</div>
    </details>
  );
}
