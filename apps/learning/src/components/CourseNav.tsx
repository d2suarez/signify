import Link from "next/link";
import type { Dict } from "@/lib/i18n";

/** The teacher's tabs for one course. */
export function CourseNav({ courseId, current, d, club }: {
  courseId: string; current: "plan" | "planner" | "calendar" | "resources" | "groups" | "attendance" | "gradebook" | "settings";
  d: Pick<Dict, "plan" | "planner" | "calendar" | "resources" | "grpTitle" | "attTitle" | "gradebook" | "settings" | "courseSections" | "clubHome">;
  /** A club has no gradebook or grading settings. */
  club?: boolean;
}) {
  const all = [
    { key: "plan", href: `/courses/${courseId}`, label: d.plan },
    // The Planner for this class alone (Desmond, 2026-11-23); /planner has every class taught.
    { key: "planner", href: `/courses/${courseId}/planner`, label: d.planner },
    { key: "calendar", href: `/courses/${courseId}/calendar`, label: d.calendar },
    { key: "resources", href: `/courses/${courseId}/resources`, label: d.resources },
    { key: "groups", href: `/courses/${courseId}/groups`, label: d.grpTitle },
    { key: "attendance", href: `/courses/${courseId}/attendance`, label: d.attTitle },
    { key: "gradebook", href: `/courses/${courseId}/gradebook`, label: d.gradebook },
    { key: "settings", href: `/courses/${courseId}/settings`, label: d.settings },
  ] as const;
  const tabs = club
    ? all.filter((t) => t.key !== "gradebook" && t.key !== "settings").map((t) => (t.key === "plan" ? { ...t, label: d.clubHome } : t))
    : all;
  return (
    <nav className="tabs" aria-label={d.courseSections}>
      {tabs.map((t) => (
        <Link key={t.key} href={t.href} aria-current={current === t.key ? "page" : undefined}>{t.label}</Link>
      ))}
    </nav>
  );
}
