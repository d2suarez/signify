import Link from "next/link";
import type { Dict } from "@/lib/i18n";

/** The teacher's tabs for one course. */
export function CourseNav({ courseId, current, d }: { courseId: string; current: "plan" | "gradebook" | "settings"; d: Pick<Dict, "plan" | "gradebook" | "settings"> }) {
  const tabs = [
    { key: "plan", href: `/courses/${courseId}`, label: d.plan },
    { key: "gradebook", href: `/courses/${courseId}/gradebook`, label: d.gradebook },
    { key: "settings", href: `/courses/${courseId}/settings`, label: d.settings },
  ] as const;
  return (
    <nav className="tabs" aria-label="Course">
      {tabs.map((t) => (
        <Link key={t.key} href={t.href} aria-current={current === t.key ? "page" : undefined}>{t.label}</Link>
      ))}
    </nav>
  );
}
