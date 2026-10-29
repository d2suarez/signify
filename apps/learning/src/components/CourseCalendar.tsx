"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { addMonths, monthGrid, onSabbath, type Day } from "@/lib/calendar";
import type { Dict, Lang } from "@/lib/i18n";

export type CalendarItem = {
  kind: "lesson" | "assignment";
  id: string;
  title: string;
  day: Day;
  /** The exact moment an assignment is due (shown in this browser's time). */
  dueAt?: string | null;
  href: string;
  draft?: boolean;
};

export function localTime(iso: string | null | undefined): string {
  if (!iso) return "23:59";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * A month of a course: planned lessons (teachers only) and due dates. Due
 * dates on the Sabbath (Friday from 6 pm, Saturday) carry a warning for the
 * teacher. The month grid is mirrored by a plain list underneath, which is
 * also what a phone or a screen reader reads most easily.
 */
export default function CourseCalendar({ items, teacher, L, d }: { items: CalendarItem[]; teacher: boolean; L: Lang; d: Dict }) {
  // The month is the browser's, so it's chosen after the first paint.
  const [ym, setYm] = useState<{ year: number; month0: number } | null>(null);
  const [today, setToday] = useState("");
  useEffect(() => {
    const now = new Date();
    setYm({ year: now.getFullYear(), month0: now.getMonth() });
    setToday(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`);
  }, []);
  if (!ym) return <p className="muted">{d.loading}</p>;

  const locale = L === "es" ? "es" : "en-US";
  const monthName = new Date(Date.UTC(ym.year, ym.month0, 15)).toLocaleDateString(locale, { month: "long", year: "numeric", timeZone: "UTC" });
  const weekdays = Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(2026, 10, 1 + i)).toLocaleDateString(locale, { weekday: "short", timeZone: "UTC" }));
  const prefix = `${ym.year}-${String(ym.month0 + 1).padStart(2, "0")}`;
  const inMonth = items.filter((i) => i.day.startsWith(prefix)).sort((a, b) => a.day.localeCompare(b.day) || a.kind.localeCompare(b.kind));
  const byDay = new Map<Day, CalendarItem[]>();
  for (const i of inMonth) byDay.set(i.day, [...(byDay.get(i.day) || []), i]);
  const sabbath = (i: CalendarItem) => teacher && i.kind === "assignment" && onSabbath(i.day, localTime(i.dueAt));
  const sabbathCount = inMonth.filter(sabbath).length;
  const go = (by: number) => setYm(addMonths(ym.year, ym.month0, by));
  const dayLabel = (day: Day) => new Date(`${day}T12:00:00Z`).toLocaleDateString(locale, { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });

  const Entry = ({ i }: { i: CalendarItem }) => (
    <Link href={i.href} className={`cal-item cal-${i.kind}`}>
      <span className={`shape ${i.kind === "lesson" ? "s-arch" : "s-tri"}`} aria-hidden="true" />
      <span className="cal-title">
        <span className="sr-only">{i.kind === "lesson" ? d.lesson : d.assignment}: </span>
        {i.title}
        {i.kind === "assignment" && i.dueAt ? <span className="cal-time"> · {new Date(i.dueAt).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })}</span> : null}
      </span>
      {i.draft && <span className="pill pill-draft">{d.draft}</span>}
      {sabbath(i) && <span className="chip chip-late">⚠ {d.sabbath}</span>}
    </Link>
  );

  return (
    <div className="stack">
      <div className="row">
        <h2 className="grow" style={{ fontSize: 24 }} aria-live="polite">{monthName}</h2>
        <button type="button" className="btn btn-sm" onClick={() => go(-1)}>← {d.previousMonth}</button>
        <button type="button" className="btn btn-sm" onClick={() => setYm(addMonths(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, 0))}>{d.today}</button>
        <button type="button" className="btn btn-sm" onClick={() => go(1)}>{d.nextMonth} →</button>
      </div>
      {sabbathCount > 0 && <p className="notice" role="status" style={{ margin: 0 }}>{sabbathCount} {d.sabbathCount}</p>}

      <div className="card cal-wrap">
        <table className="cal">
          <caption className="sr-only">{monthName}</caption>
          <thead><tr>{weekdays.map((w) => <th key={w} scope="col">{w}</th>)}</tr></thead>
          <tbody>
            {monthGrid(ym.year, ym.month0).map((week, wi) => (
              <tr key={wi}>
                {week.map((day, di) => (
                  <td key={di} className={`${day ? "" : "cal-out"}${day === today ? " cal-today" : ""}${di === 6 ? " cal-sat" : ""}`}
                    aria-current={day === today ? "date" : undefined}>
                    {day && <>
                      <span className="cal-num">{Number(day.slice(8))}</span>
                      {(byDay.get(day) || []).map((i) => <Entry key={i.kind + i.id} i={i} />)}
                    </>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="card" aria-labelledby="cal-list">
        <p className="label" id="cal-list">{d.thisMonth}</p>
        {inMonth.length === 0 ? <p className="empty">{teacher ? d.calendarEmptyTeacher : d.calendarEmpty}</p> : (
          <ul className="list">
            {[...byDay.entries()].map(([day, list]) => (
              <li key={day} style={{ alignItems: "flex-start" }}>
                <b style={{ flex: "0 0 180px" }}>{dayLabel(day)}</b>
                <div className="grow stack" style={{ gap: 6 }}>{list.map((i) => <Entry key={i.kind + i.id} i={i} />)}</div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
