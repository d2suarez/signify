import Link from "next/link";
import type { ReactNode } from "react";
import { myClasses, requireMe } from "@/lib/auth";
import { roleInClass } from "@/lib/courses";
import { isSchoolAdmin, lang } from "@/lib/access";
import { dict, type Dict, type Lang } from "@/lib/i18n";
import { addDays, addSchoolDays, isSchoolDay, parseDay, todayIn } from "@/lib/planner";
import { SCHOOL_TZ } from "@/lib/school-grading";
import { schoolClasses, schoolDay, statusWord } from "@/lib/attendance";
import { listPeriods } from "@/lib/grades";
import {
  anchorDay, asView, classRows, monthRange, periodRange, pickPeriod, rangeRecords, recentWeeksRange,
  slippingFirst, summarize, weekRange, weeklyRates, pct, type Range, type View,
} from "@/lib/attendance-views";
import { ClassGrid, ClassTable, RangeNav, Slipping, TermPicker, ViewNav, WeekBars, dayWords } from "@/components/AttendanceViews";
import { TopBar } from "@/components/TopBar";
import { When } from "@/components/When";

export const dynamic = "force-dynamic";

/**
 * The school's attendance (story 01, D6): every class's record for one day
 * (taken or not, counts, who wasn't present), and a CSV export of a date
 * range for the school's SIS. School admins only.
 */
export default async function SchoolAttendancePage({ searchParams }: { searchParams: Promise<{ day?: string; view?: string; term?: string }> }) {
  const me = await requireMe();
  const L = await lang();
  const d = dict(L);
  const crumbs = <><Link href="/">{d.myCourses}</Link> · {me.tenantName}</>;
  if (!isSchoolAdmin(me)) {
    return (
      <>
        <TopBar crumbs={crumbs} />
        <main className="page stack" style={{ maxWidth: 900 }}>
          <h1 style={{ fontSize: 34 }}>{d.attSchoolTitle}</h1>
          <p className="notice">{d.spOnlyAdmins}</p>
        </main>
      </>
    );
  }
  const today = todayIn(SCHOOL_TZ);
  const sp = await searchParams;
  const view = asView(sp.view);
  // An admin who also teaches gets a way to their own classes' attendance.
  const teaches = (await myClasses()).classes.some((c) => roleInClass(c) === "teacher");
  const mine = teaches ? <Link href="/attendance" className="btn btn-sm">{d.attAllMine}</Link> : null;
  if (view !== "day") {
    return (
      <>
        <TopBar crumbs={crumbs} />
        <main className="page stack" style={{ maxWidth: 1100 }}>
          <SchoolRange tenantId={me.tenantId} view={view} asked={sp.day} term={sp.term} today={today} mine={mine} L={L} d={d} />
        </main>
      </>
    );
  }
  let day = parseDay(sp.day) ?? today;
  if (day > today) day = today;
  while (!isSchoolDay(day)) day = addDays(day, -1);
  const classes = await schoolDay(me.tenantId, day);
  const notTaken = classes.filter((c) => !c.taken).length;

  return (
    <>
      <TopBar crumbs={crumbs} />
      <main className="page stack" style={{ maxWidth: 1000 }}>
        <div className="row" style={{ flexWrap: "wrap", gap: 8, justifyContent: "space-between" }}>
          <ViewNav base="/school/attendance" view="day" d={d} />
          {mine}
        </div>
        <div className="row" style={{ flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
          <h1 style={{ fontSize: 34, flex: "1 1 12em", minWidth: 0 }}>
            {d.attSchoolTitle} · <When iso={`${day}T12:00:00Z`} withTime={false} lang={L} />
          </h1>
          <Link className="btn btn-sm" href={`/school/attendance?day=${addSchoolDays(day, -1)}`}>← {d.attPrevDay}</Link>
          {day < today && <Link className="btn btn-sm" href={`/school/attendance?day=${addSchoolDays(day, 1)}`}>{d.attNextDay} →</Link>}
          {day !== today && <Link className="btn btn-sm" href="/school/attendance">{d.attToday}</Link>}
        </div>
        <p className="muted" style={{ margin: 0 }} role="status">
          {classes.length === 0 ? d.attSchoolNoClasses : d.attSchoolSummary.replace("{n}", String(classes.length)).replace("{m}", String(notTaken))}
        </p>

        {classes.length > 0 && (
          <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0, gap: 8 }}>
            {classes.map((c) => (
              <li key={c.courseId} className="card stack" style={{ gap: 6 }}>
                <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
                  <b style={{ flex: "1 1 12em", minWidth: 0 }}>{c.name}</b>
                  <span className="muted" style={{ fontSize: 14 }}>{c.teacher || d.secAsker}</span>
                  <span className={`chip${c.taken ? "" : " chip-late"}`}>{c.taken ? d.attTakenShort : d.attNotTakenShort}</span>
                </div>
                {c.taken && (
                  <p className="muted" style={{ margin: 0, fontSize: 14 }}>
                    {(["present", "absent", "tardy", "excused"] as const).map((s) => `${statusWord(s, d)} ${c.counts[s]}`).join(" · ")}
                  </p>
                )}
                {c.notPresent.length > 0 && (
                  <ul style={{ margin: 0, paddingLeft: 20 }}>
                    {c.notPresent.map((p, i) => <li key={i}>{p.name || d.attUnnamed} · {statusWord(p.status, d)}{p.note ? ` · ${p.note}` : ""}</li>)}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}

        <ExportForm from={day} to={day} today={today} d={d} />
      </main>
    </>
  );
}

/** The SIS export, set to the range being looked at (any range of up to a year can be typed). */
function ExportForm({ from, to, today, d }: { from: string; to: string; today: string; d: Dict }) {
  return (
    <section className="card stack" aria-labelledby="att-export" style={{ gap: 10 }}>
      <h2 id="att-export" style={{ fontSize: 20 }}>{d.attExportTitle}</h2>
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>{d.attExportHint}</p>
      <form action="/school/attendance/export" method="get" className="row" style={{ flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
        <div className="fieldset" style={{ margin: 0 }}>
          <label htmlFor="att-from">{d.attFrom}</label>
          <input id="att-from" name="from" type="date" className="field" defaultValue={from} max={today} required />
        </div>
        <div className="fieldset" style={{ margin: 0 }}>
          <label htmlFor="att-to">{d.attTo}</label>
          <input id="att-to" name="to" type="date" className="field" defaultValue={to < today ? to : today} max={today} required />
        </div>
        <button type="submit" className="btn btn-primary">{d.attExport}</button>
      </form>
    </section>
  );
}

/** Every class over a week, month or term, or the school's trends. School admins only (the caller checked). */
async function SchoolRange({ tenantId, view, asked, term, today, mine, L, d }: {
  tenantId: string; view: Exclude<View, "day">; asked?: string; term?: string; today: string; mine: ReactNode; L: Lang; d: Dict;
}) {
  const base = "/school/attendance";
  const day = anchorDay(asked, today);
  const periods = view === "term" || view === "trends" ? await listPeriods(tenantId) : [];
  const period = pickPeriod(periods, today, term);
  const range: Range = view === "week" ? weekRange(day, today)
    : view === "month" ? monthRange(day, today)
    : period ? periodRange(period, today) : recentWeeksRange(today);
  const classes = await schoolClasses(tenantId);
  const recs = await rangeRecords(tenantId, [...classes.keys()], range.from, range.to);
  const list = [...classes.entries()].map(([courseId, c]) => ({ courseId, ...c }));
  const rows = classRows(list, recs, range.days).sort((a, b) => a.name.localeCompare(b.name));
  const title = view === "week" ? d.attWeekOf.replace("{day}", dayWords(range.from, L, { month: "long", day: "numeric" }))
    : view === "month" ? dayWords(range.from, L, { month: "long", year: "numeric" })
    : period ? period.name : d.attLast8Weeks;
  const isNow = view === "week" ? range.from <= today && today <= range.to : view === "month" ? today.startsWith(range.from.slice(0, 7)) : true;
  const students = view === "trends" ? summarize(recs, today) : [];
  const weeks = view === "trends" ? weeklyRates(recs, range) : [];
  const meetings = rows.reduce((n, r) => n + r.cells.length, 0);
  const taken = rows.reduce((n, r) => n + r.daysTaken, 0);
  return (
    <>
      <div className="row" style={{ flexWrap: "wrap", gap: 8, justifyContent: "space-between" }}>
        <ViewNav base={base} view={view} extra={term && (view === "term" || view === "trends") ? `term=${encodeURIComponent(term)}` : ""} d={d} />
        {mine}
      </div>
      <div className="row" style={{ flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
        <h1 style={{ fontSize: 34, flex: "1 1 12em", minWidth: 0 }}>{d.attSchoolTitle} · {title}</h1>
        {(view === "week" || view === "month") && (
          <RangeNav base={base} view={view} prev={range.prev} next={range.next} now={view === "week" ? d.attThisWeek : d.attThisMonth} isNow={isNow} d={d} />
        )}
      </div>
      {(view === "term" || view === "trends") && <TermPicker action={base} view={view} periods={periods} current={period} L={L} d={d} />}
      <p className="muted" style={{ margin: 0 }} role="status">
        {dayWords(range.from, L)} – {dayWords(range.to, L)} · {d.attRangeDays.replace("{n}", String(range.days.length))}
        {rows.length > 0 && <> · {d.attSchoolTakenOf.replace("{n}", String(taken)).replace("{m}", String(meetings))}</>}
      </p>
      {rows.length === 0 ? <p className="empty">{d.attSchoolNoClasses}</p> : (
        <section className="card stack" style={{ gap: 12 }} aria-label={title}>
          {view === "week" || view === "month" ? (
            <>
              <ClassGrid rows={rows} days={range.days} L={L} d={d} />
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.attSchoolLegend}</p>
            </>
          ) : view === "term" ? (
            <ClassTable rows={rows} schoolDays={range.days.length} d={d} />
          ) : (
            <>
              <WeekBars weeks={weeks} title={d.attSchoolByWeek} L={L} d={d} />
              <Slipping list={slippingFirst(students)} d={d} />
              <h3 style={{ fontSize: 18 }}>{d.attLowestClasses}</h3>
              <ol style={{ margin: 0, paddingLeft: 22 }}>
                {[...rows].filter((r) => r.rate != null).sort((a, b) => (a.rate ?? 1) - (b.rate ?? 1)).slice(0, 5).map((r) => (
                  <li key={r.courseId}>{r.name}{r.teacher ? ` (${r.teacher})` : ""}: {pct(r.rate)} · {d.attDaysTaken} {r.daysTaken} / {range.days.length}</li>
                ))}
              </ol>
              {rows.some((r) => r.daysTaken < range.days.length) && (
                <>
                  <h3 style={{ fontSize: 18 }}>{d.attMostMissed}</h3>
                  <ol style={{ margin: 0, paddingLeft: 22 }}>
                    {[...rows].filter((r) => r.daysTaken < range.days.length).sort((a, b) => a.daysTaken - b.daysTaken || a.name.localeCompare(b.name)).slice(0, 5).map((r) => (
                      <li key={r.courseId}>{r.name}{r.teacher ? ` (${r.teacher})` : ""}: {d.attNotTakenDays.replace("{n}", String(range.days.length - r.daysTaken))}</li>
                    ))}
                  </ol>
                </>
              )}
            </>
          )}
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.attRateHint}</p>
        </section>
      )}
      <ExportForm from={range.from} to={range.to} today={today} d={d} />
    </>
  );
}
