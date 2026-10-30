import Link from "next/link";
import type { Dict } from "@/lib/i18n";

/** The teacher's tabs for one course. */
export function CourseNav({ courseId, current, d }: { courseId: string; current: "plan" | "calendar" | "gradebook" | "settings"; d: Pick<Dict, "plan" | "calendar" | "gradebook" | "settings" | "courseSections"> }) {
  const tabs = [
    { key: "plan", href: `/courses/${courseId}`, label: d.plan },
    { key: "calendar", href: `/courses/${courseId}/calendar`, label: d.calendar },
    { key: "gradebook", href: `/courses/${courseId}/gradebook`, label: d.gradebook },
    { key: "settings", href: `/courses/${courseId}/settings`, label: d.settings },
  ] as const;
  return (
    <nav className="tabs" aria-label={d.courseSections}>
      {tabs.map((t) => (
        <Link key={t.key} href={t.href} aria-current={current === t.key ? "page" : undefined}>{t.label}</Link>
      ))}
    </nav>
  );
}
