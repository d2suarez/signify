import Link from "next/link";
import type { Dict } from "@/lib/i18n";
import TabsKeep from "./TabsKeep";

export type CourseTab = "plan" | "planner" | "calendar" | "standards" | "attendance" | "gradebook" | "settings";

/**
 * The teacher's tabs for one class, in the class header (ClassHeader.tsx).
 * Always the same tabs in the same order and size on every page inside the
 * class (Desmond, 2026-11-23: "the tabs move and resize. They need to be
 * fixed"): one row that never wraps; on a narrow screen it scrolls sideways
 * and keeps where it was scrolled from page to page.
 */
export function CourseNav({ courseId, current, d, club }: {
  courseId: string; current: CourseTab | null;
  d: Pick<Dict, "plan" | "planner" | "calendar" | "standards" | "attTitle" | "gradebook" | "settings" | "courseSections" | "clubHome">;
  /** A club has no gradebook, grading settings or standards. */
  club?: boolean;
}) {
  const all = [
    { key: "plan", href: `/courses/${courseId}`, label: club ? d.clubHome : d.plan },
    // The Planner for this class alone (Desmond, 2026-11-23); /planner has every class taught.
    { key: "planner", href: `/courses/${courseId}/planner`, label: d.planner },
    { key: "calendar", href: `/courses/${courseId}/calendar`, label: d.calendar },
    { key: "standards", href: `/courses/${courseId}/standards`, label: d.standards },
    { key: "attendance", href: `/courses/${courseId}/attendance`, label: d.attTitle },
    { key: "gradebook", href: `/courses/${courseId}/gradebook`, label: d.gradebook },
    { key: "settings", href: `/courses/${courseId}/settings`, label: d.settings },
  ] as const;
  const tabs = club ? all.filter((t) => t.key !== "gradebook" && t.key !== "settings" && t.key !== "standards") : all;
  return (
    <nav className="tabs class-tabs" aria-label={d.courseSections} id="class-tabs">
      {tabs.map((t) => (
        <Link key={t.key} href={t.href} aria-current={current === t.key ? "page" : undefined}>{t.label}</Link>
      ))}
      <TabsKeep id="class-tabs" />
    </nav>
  );
}
