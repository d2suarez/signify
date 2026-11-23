import Link from "next/link";
import type { Dict } from "@/lib/i18n";
import type { Day } from "@/lib/calendar";
import { STATUSES, statusWord, type Status } from "@/lib/attendance";
import { VIEWS, pct, type ClassRangeRow, type Counts, type Period, type StudentSummary, type View, type WeekRate } from "@/lib/attendance-views";

/**
 * The pieces of the attendance week / month / term / trends views (class
 * tab and the school's page). Server components, no JavaScript: links and
 * tables. Status is always a letter plus the word for screen readers, and
 * colour is only a second cue.
 */

/** A plain day ("2026-11-23") in words, in the page's language. */
export function dayWords(day: Day, L: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" }): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(L === "es" ? "es" : "en-US", { ...opts, timeZone: "UTC" });
}

export function ViewNav({ base, view, extra = "", d }: { base: string; view: View; extra?: string; d: Dict }) {
  const label: Record<View, string> = { day: d.attViewDay, week: d.attViewWeek, month: d.attViewMonth, term: d.attViewTerm, trends: d.attViewTrends };
  return (
    <nav className="seg seg-wrap att-views" aria-label={d.attViews}>
      {VIEWS.map((v) => (
        <Link key={v} className="seg-link" href={`${base}${v === "day" ? "" : `?view=${v}`}${extra && v !== "day" ? `&${extra}` : ""}`} aria-current={v === view ? "page" : undefined}>
          {label[v]}
        </Link>
      ))}
    </nav>
  );
}

const SHORT: Record<Status, keyof Dict> = { present: "attShortP", absent: "attShortA", tardy: "attShortT", excused: "attShortE" };

function Mark({ s, d }: { s: Status | null; d: Dict }) {
  if (!s) return <><span aria-hidden="true">–</span><span className="sr-only">{d.attNotMarked}</span></>;
  return <><span aria-hidden="true">{d[SHORT[s]]}</span><span className="sr-only">{statusWord(s, d)}</span></>;
}

export function countsLine(c: Counts, d: Dict): string {
  return STATUSES.map((s) => `${statusWord(s, d)} ${c[s]}`).join(" · ");
}

/** Students down, school days across (week and month). */
export function StudentGrid({ rows, days, grid, L, d }: {
  rows: StudentSummary[]; days: Day[]; grid: Map<string, (Status | null)[]>; L: string; d: Dict;
}) {
  return (
    <div className="att-scroll">
      <table className="att-table">
        <caption className="sr-only">{d.attGridCaption}</caption>
        <thead>
          <tr>
            <th scope="col" className="att-name">{d.attStudent}</th>
            {days.map((day) => (
              <th scope="col" key={day} className="att-day"><span aria-hidden="true">{dayWords(day, L, { weekday: "narrow" })}<br /></span>{dayWords(day, L, { day: "numeric" })}<span className="sr-only"> {dayWords(day, L, { month: "long", weekday: "long" })}</span></th>
            ))}
            <th scope="col">{d.attRate}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const cells = grid.get(s.studentId) ?? days.map(() => null);
            return (
              <tr key={s.studentId}>
                <th scope="row" className="att-name">{s.name || d.attUnnamed}</th>
                {cells.map((c, i) => <td key={days[i]} className={`att-cell${c ? ` att-${c}` : ""}`}><Mark s={c} d={d} /></td>)}
                <td className="att-num">{pct(s.rate)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Counts and rate per student (term and trends). */
export function StudentTable({ rows, trends, d }: { rows: StudentSummary[]; trends?: boolean; d: Dict }) {
  return (
    <div className="att-scroll">
      <table className="att-table att-sum">
        <caption className="sr-only">{d.attEveryStudent}</caption>
        <thead>
          <tr>
            <th scope="col" className="att-name">{d.attStudent}</th>
            {STATUSES.map((s) => <th scope="col" key={s}>{statusWord(s, d)}</th>)}
            <th scope="col">{d.attRate}</th>
            {trends && <th scope="col">{d.attLast2Weeks}</th>}
            {trends && <th scope="col">{d.attEarlier}</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.studentId}>
              <th scope="row" className="att-name">
                {s.name || d.attUnnamed}
                {s.slipping && <> <span className="chip chip-late">{d.attSlippingChip}</span></>}
              </th>
              {STATUSES.map((st) => <td key={st} className="att-num">{s.counts[st]}</td>)}
              <td className="att-num"><b>{pct(s.rate)}</b></td>
              {trends && <td className="att-num">{pct(s.recentRate)}</td>}
              {trends && <td className="att-num">{pct(s.earlierRate)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The rate by week, as bars with the number written beside each. */
export function WeekBars({ weeks, title, L, d }: { weeks: WeekRate[]; title: string; L: string; d: Dict }) {
  const id = `wb-${title.length}`;
  return (
    <section className="stack" aria-labelledby={id} style={{ gap: 8 }}>
      <h3 id={id} style={{ fontSize: 18 }}>{title}</h3>
      {weeks.length === 0 ? <p className="empty" style={{ margin: 0 }}>{d.attNoRecords}</p> : (
        <ul className="att-bars">
          {weeks.map((w) => (
            <li key={w.monday}>
              <span className="att-bar-label">{dayWords(w.monday, L, { month: "short", day: "numeric" })}</span>
              <span className="att-bar" aria-hidden="true"><i style={{ width: `${Math.round((w.rate ?? 0) * 100)}%` }} /></span>
              <span className="att-num att-bar-num">
                {w.rate == null ? d.attNotTakenShort : pct(w.rate)}
                <span className="sr-only"> · {d.attWeekOf.replace("{day}", dayWords(w.monday, L, { month: "long", day: "numeric" }))}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Who is slipping, worst first. */
export function Slipping({ list, d }: { list: StudentSummary[]; d: Dict }) {
  return (
    <section className="stack" aria-labelledby="att-slip" style={{ gap: 6 }}>
      <h3 id="att-slip" style={{ fontSize: 18 }}>{d.attSlipping}</h3>
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>{d.attSlippingHint}</p>
      {list.length === 0 ? <p className="empty" style={{ margin: 0 }}>{d.attSlippingNone}</p> : (
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {list.map((s) => (
            <li key={s.studentId}>
              <b>{s.name || d.attUnnamed}</b>: {d.attSlippingRow
                .replace("{recent}", pct(s.recentRate)).replace("{earlier}", pct(s.earlierRate))
                .replace("{a}", String(s.recent.absent)).replace("{t}", String(s.recent.tardy))}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The school's classes down, days across: taken or not, and how many were absent. */
export function ClassGrid({ rows, days, L, d }: { rows: ClassRangeRow[]; days: Day[]; L: string; d: Dict }) {
  return (
    <div className="att-scroll">
      <table className="att-table">
        <caption className="sr-only">{d.attClassGridCaption}</caption>
        <thead>
          <tr>
            <th scope="col" className="att-name">{d.attClass}</th>
            {days.map((day) => (
              <th scope="col" key={day} className="att-day"><span aria-hidden="true">{dayWords(day, L, { weekday: "narrow" })}<br /></span>{dayWords(day, L, { day: "numeric" })}<span className="sr-only"> {dayWords(day, L, { month: "long", weekday: "long" })}</span></th>
            ))}
            <th scope="col">{d.attRate}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.courseId}>
              <th scope="row" className="att-name">{r.name}<span className="muted att-teacher">{r.teacher}</span></th>
              {r.cells.map((c, i) => (
                <td key={days[i]} className={`att-cell${c ? "" : " att-none"}`}>
                  {c ? <><span aria-hidden="true">✓{c.absent ? ` ${c.absent}` : ""}</span><span className="sr-only">{d.attTakenShort} · {d.attCellAbsent.replace("{n}", String(c.absent))}</span></>
                    : <><span aria-hidden="true">–</span><span className="sr-only">{d.attNotTakenShort}</span></>}
                </td>
              ))}
              <td className="att-num">{pct(r.rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Each class over a term: days taken out of the school days, counts and rate. */
export function ClassTable({ rows, schoolDays, d }: { rows: ClassRangeRow[]; schoolDays: number; d: Dict }) {
  return (
    <div className="att-scroll">
      <table className="att-table att-sum">
        <caption className="sr-only">{d.attClassesTable}</caption>
        <thead>
          <tr>
            <th scope="col" className="att-name">{d.attClass}</th>
            <th scope="col">{d.attDaysTaken}</th>
            {STATUSES.map((s) => <th scope="col" key={s}>{statusWord(s, d)}</th>)}
            <th scope="col">{d.attRate}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.courseId}>
              <th scope="row" className="att-name">{r.name}<span className="muted att-teacher">{r.teacher}</span></th>
              <td className="att-num">{r.daysTaken} / {schoolDays}</td>
              {STATUSES.map((st) => <td key={st} className="att-num">{r.counts[st]}</td>)}
              <td className="att-num"><b>{pct(r.rate)}</b></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Pick a grading period (a plain GET form, so it works without JavaScript). */
export function TermPicker({ action, view, periods, current, L, d }: {
  action: string; view: View; periods: Period[]; current: Period | null; L: string; d: Dict;
}) {
  if (!periods.length) return <p className="notice" style={{ margin: 0 }}>{d.attNoPeriods}</p>;
  return (
    <form action={action} method="get" className="row" style={{ flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
      <input type="hidden" name="view" value={view} />
      <div className="fieldset" style={{ margin: 0 }}>
        <label htmlFor="att-term">{d.attTerm}</label>
        <select id="att-term" name="term" className="field" defaultValue={current?.id}>
          {periods.map((p) => (
            <option key={p.id} value={p.id}>{p.name} ({dayWords(p.startsOn, L, { month: "short", day: "numeric" })} – {dayWords(p.endsOn, L, { month: "short", day: "numeric" })})</option>
          ))}
        </select>
      </div>
      <button type="submit" className="btn">{d.attShowTerm}</button>
    </form>
  );
}

/** ← / → / back to now, for the week and month views. */
export function RangeNav({ base, view, prev, next, now, isNow, d }: {
  base: string; view: "week" | "month"; prev: Day | null; next: Day | null; now: string; isNow: boolean; d: Dict;
}) {
  const href = (day: Day) => `${base}?view=${view}&day=${day}`;
  return (
    <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
      {prev && <Link className="btn btn-sm" href={href(prev)}>← {view === "week" ? d.attPrevWeek : d.attPrevMonth}</Link>}
      {next && <Link className="btn btn-sm" href={href(next)}>{view === "week" ? d.attNextWeek : d.attNextMonth} →</Link>}
      {!isNow && <Link className="btn btn-sm" href={`${base}?view=${view}`}>{now}</Link>}
    </div>
  );
}
