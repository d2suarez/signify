import type { Dict, Lang } from "@/lib/i18n";
import type { MyAttendance } from "@/lib/my-attendance";
import { statusWord } from "@/lib/attendance";

/**
 * One class's attendance for a student or their parent: counts in words,
 * then the days they weren't marked present. Read only; no teacher notes.
 */
export function AttendanceSummary({ a, d, L, heading }: { a: MyAttendance; d: Dict; L: Lang; heading?: string }) {
  const date = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString(L === "es" ? "es" : "en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  return (
    <div className="stack" style={{ gap: 8 }}>
      {heading && <p className="label">{heading}</p>}
      {a.days === 0 ? <p className="muted" style={{ margin: 0 }}>{d.attMineNone}</p> : (
        <>
          <p style={{ margin: 0 }}>
            {d.attMineDays.replace("{n}", String(a.days))}
            {" · "}{statusWord("present", d)} {a.counts.present}
            {" · "}{statusWord("absent", d)} {a.counts.absent}
            {" · "}{statusWord("tardy", d)} {a.counts.tardy}
            {" · "}{statusWord("excused", d)} {a.counts.excused}
          </p>
          {a.notPresent.length === 0
            ? <p className="muted" style={{ margin: 0 }}>{d.attMineAllPresent}</p>
            : (
              <ul className="list" style={{ fontSize: 14 }}>
                {a.notPresent.map((x) => (
                  <li key={x.day} style={{ padding: "6px 0" }}>
                    <span className="grow">{date(x.day)}</span>
                    <span className="chip">{statusWord(x.status, d)}</span>
                  </li>
                ))}
              </ul>
            )}
        </>
      )}
    </div>
  );
}
