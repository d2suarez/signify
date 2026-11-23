import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { courseAccess, ctx, lang, studentsOf } from "@/lib/access";
import { requireMe } from "@/lib/auth";
import { AttendanceError, STATUSES, asStatus, classDay, statusWord, takeAttendance, type Status } from "@/lib/attendance";
import { addDays, addSchoolDays, isSchoolDay, parseDay, todayIn } from "@/lib/planner";
import { SCHOOL_TZ } from "@/lib/school-grading";
import { dict, type Dict, type Lang } from "@/lib/i18n";
import { TopBar } from "@/components/TopBar";
import { ClassHeader } from "@/components/ClassHeader";
import { When } from "@/components/When";
import { listPeriods } from "@/lib/grades";
import {
  anchorDay, asView, exportHref, gridOf, monthRange, periodRange, pickPeriod, rangeRecords, recentWeeksRange,
  slippingFirst, summarize, weekRange, weeklyRates, type View,
} from "@/lib/attendance-views";
import { RangeNav, Slipping, StudentGrid, StudentTable, TermPicker, ViewNav, WeekBars, countsLine, dayWords } from "@/components/AttendanceViews";

export const dynamic = "force-dynamic";

/**
 * Attendance for one class meeting (story 01, D6): the class from Signify
 * ID, each student Present / Absent / Tardy / Excused with a note, saved as
 * the school's record. Works without JavaScript (one form).
 */

async function save(formData: FormData) {
  "use server";
  const access = await courseAccess(String(formData.get("courseId") || ""));
  if (!access || access.course.role !== "teacher") return;
  const day = String(formData.get("day") || "");
  const base = `/courses/${access.course.id}/attendance?day=${encodeURIComponent(day)}`;
  const { ok, students } = await studentsOf(access);
  if (!ok) redirect(`${base}&m=roster`);
  const marks = students.map((s) => ({ studentId: s.id, status: asStatus(formData.get(`s:${s.id}`)), note: formData.get(`n:${s.id}`) }));
  try {
    await takeAttendance(ctx(access.me), access.course.id, day, todayIn(SCHOOL_TZ), marks, new Map(students.map((s) => [s.id, s.name])));
  } catch (e) {
    if (e instanceof AttendanceError) redirect(`${base}&m=${e.code}`);
    throw e;
  }
  redirect(`${base}&m=saved`);
}

export default async function AttendancePage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ day?: string; m?: string; view?: string; term?: string }>;
}) {
  await requireMe();
  const { id } = await params;
  const { day: asked, m, view: askedView, term } = await searchParams;
  const L = await lang();
  const d = dict(L);
  const access = await courseAccess(id);
  if (!access || access.course.role !== "teacher") notFound();
  const { me, course } = access;
  const today = todayIn(SCHOOL_TZ);
  const view = asView(askedView);
  const head = (
    <>
      <TopBar crumbs={<Link href="/">{d.myCourses}</Link>} below={<ClassHeader course={course} d={d} tab="attendance" heading />} />
    </>
  );
  if (view !== "day") {
    return (
      <>
        {head}
        <main className="page stack">
          <ClassRange access={access} view={view} asked={asked} term={term} today={today} L={L} d={d} />
        </main>
      </>
    );
  }
  // Today, or the last school day before it at a weekend; never a day to come.
  let day = parseDay(asked) ?? today;
  if (day > today) day = today;
  while (!isSchoolDay(day)) day = addDays(day, -1);
  const prev = addSchoolDays(day, -1);
  const next = addSchoolDays(day, 1);

  const [{ ok, students }, marks] = await Promise.all([studentsOf(access), classDay(ctx(me), course.id, day)]);
  const taken = marks.size > 0;
  const last = [...marks.values()].reduce<string | null>((a, x) => (!a || x.markedAt > a ? x.markedAt : a), null);
  const counts = Object.fromEntries(STATUSES.map((s) => [s, [...marks.values()].filter((x) => x.status === s).length])) as Record<Status, number>;

  return (
    <>
      {head}
      <main className="page stack">
        <section className="card stack" aria-labelledby="att-title" style={{ gap: 12 }}>
          <div className="row" style={{ flexWrap: "wrap", gap: 8, justifyContent: "space-between" }}>
            <ViewNav base={`/courses/${course.id}/attendance`} view="day" d={d} />
            <Link href="/attendance" className="btn btn-sm">{d.attAllMine}</Link>
          </div>
          <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
            <h2 id="att-title" style={{ fontSize: 24, flex: "1 1 12em", minWidth: 0 }}>
              {d.attTitle} · <When iso={`${day}T12:00:00Z`} withTime={false} lang={L} />
            </h2>
            <Link className="btn btn-sm" href={`/courses/${course.id}/attendance?day=${prev}`}>← {d.attPrevDay}</Link>
            {day < today && <Link className="btn btn-sm" href={`/courses/${course.id}/attendance?day=${next}`}>{d.attNextDay} →</Link>}
            {day !== today && <Link className="btn btn-sm" href={`/courses/${course.id}/attendance`}>{d.attToday}</Link>}
          </div>
          <p className="muted" style={{ margin: 0 }} role="status">
            {taken
              ? <>{d.attTaken} <When iso={last} lang={L} /> · {STATUSES.map((s) => `${statusWord(s, d)} ${counts[s]}`).join(" · ")}</>
              : d.attNotTaken}
          </p>
          {m === "saved" && <p className="notice" role="status" style={{ margin: 0 }}>{d.attSaved}</p>}
          {m === "roster" && <p className="notice" role="alert" style={{ margin: 0 }}>{d.attRosterFailed}</p>}
          {(m === "day" || m === "future") && <p className="notice" role="alert" style={{ margin: 0 }}>{d.attBadDay}</p>}

          {!ok ? <p className="notice" role="alert" style={{ margin: 0 }}>{d.attRosterFailed}</p>
            : students.length === 0 ? <p className="empty">{d.attNoStudents}</p> : (
            <form action={save} className="stack" style={{ gap: 10 }}>
              <input type="hidden" name="courseId" value={course.id} />
              <input type="hidden" name="day" value={day} />
              <ul className="att-list">
                {students.map((s) => {
                  const had = marks.get(s.id);
                  const now = had?.status ?? "present";
                  return (
                    <li key={s.id} className="att-row">
                      <fieldset className="choice">
                        <legend>{s.name}{!had && taken && <span className="muted" style={{ fontWeight: 400 }}> · {d.attNotMarked}</span>}</legend>
                        <div className="choice-opts">
                          {STATUSES.map((st) => (
                            <label key={st}>
                              <input type="radio" name={`s:${s.id}`} value={st} defaultChecked={now === st} />
                              <span>{statusWord(st, d)}</span>
                            </label>
                          ))}
                        </div>
                      </fieldset>
                      <div className="fieldset" style={{ margin: 0 }}>
                        <label htmlFor={`n-${s.id}`} className="sr-only">{d.attNoteFor.replace("{name}", s.name)}</label>
                        <input id={`n-${s.id}`} name={`n:${s.id}`} className="field" maxLength={300} defaultValue={had?.note ?? ""} placeholder={d.attNote} />
                      </div>
                    </li>
                  );
                })}
              </ul>
              {!taken && <p className="muted" style={{ margin: 0, fontSize: 14 }}>{d.attDefaultHint}</p>}
              <div><button type="submit" className="btn btn-primary">{taken ? d.attUpdate : d.attSave}</button></div>
            </form>
          )}
          {taken && <div><a className="btn btn-sm" href={`/courses/${course.id}/attendance/export?from=${day}&to=${day}`} download>{d.attDownloadDay}</a></div>}
        </section>
      </main>
    </>
  );
}

/** Week, month, term or trends for one class (its teachers only; the caller checked). */
async function ClassRange({ access, view, asked, term, today, L, d }: {
  access: NonNullable<Awaited<ReturnType<typeof courseAccess>>>; view: Exclude<View, "day">; asked?: string; term?: string;
  today: string; L: Lang; d: Dict;
}) {
  const { me, course } = access;
  const base = `/courses/${course.id}/attendance`;
  const day = anchorDay(asked, today);
  const periods = view === "term" || view === "trends" ? await listPeriods(me.tenantId) : [];
  const period = pickPeriod(periods, today, term);
  const range = view === "week" ? weekRange(day, today)
    : view === "month" ? monthRange(day, today)
    : period ? periodRange(period, today) : recentWeeksRange(today);
  const [{ ok, students }, recs] = await Promise.all([
    studentsOf(access),
    rangeRecords(me.tenantId, [course.id], range.from, range.to),
  ]);
  // Everyone ID lists now, and anyone marked in the range who has since left.
  const rows = summarize(recs, today, new Map(students.map((s) => [s.id, s.name])));
  const total = rows.reduce((c, s) => { for (const k of STATUSES) c[k] += s.counts[k]; return c; }, { present: 0, absent: 0, tardy: 0, excused: 0 } as Record<Status, number>);
  const title = view === "week" ? d.attWeekOf.replace("{day}", dayWords(range.from, L, { month: "long", day: "numeric" }))
    : view === "month" ? dayWords(range.from, L, { month: "long", year: "numeric" })
    : period ? period.name : d.attLast8Weeks;
  const isNow = view === "week" ? range.from <= today && today <= range.to : view === "month" ? today.startsWith(range.from.slice(0, 7)) : true;
  return (
    <section className="card stack" aria-labelledby="att-title" style={{ gap: 12 }}>
      <div className="row" style={{ flexWrap: "wrap", gap: 8, justifyContent: "space-between" }}>
        <ViewNav base={base} view={view} extra={term && (view === "term" || view === "trends") ? `term=${encodeURIComponent(term)}` : ""} d={d} />
        <Link href="/attendance" className="btn btn-sm">{d.attAllMine}</Link>
      </div>
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        <h2 id="att-title" style={{ fontSize: 24, flex: "1 1 12em", minWidth: 0 }}>{d.attTitle} · {title}</h2>
        {(view === "week" || view === "month") && (
          <RangeNav base={base} view={view} prev={range.prev} next={range.next} now={view === "week" ? d.attThisWeek : d.attThisMonth} isNow={isNow} d={d} />
        )}
      </div>
      {(view === "term" || view === "trends") && <TermPicker action={base} view={view} periods={periods} current={period} L={L} d={d} />}
      <p className="muted" style={{ margin: 0 }} role="status">
        {dayWords(range.from, L)} – {dayWords(range.to, L)} · {d.attRangeDays.replace("{n}", String(range.days.length))}
        {recs.length > 0 && <> · {countsLine(total, d)}</>}
      </p>
      {!ok && <p className="notice" role="alert" style={{ margin: 0 }}>{d.attRosterFailedView}</p>}
      {rows.length === 0 ? <p className="empty">{d.attNoStudents}</p>
        : view === "week" || view === "month" ? (
          <>
            {recs.length === 0 && <p className="empty" style={{ margin: 0 }}>{d.attNoRecords}</p>}
            <StudentGrid rows={rows} days={range.days} grid={gridOf(recs, range.days)} L={L} d={d} />
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.attLegend}</p>
          </>
        ) : view === "term" ? (
          <>
            {recs.length === 0 && <p className="empty" style={{ margin: 0 }}>{d.attNoRecords}</p>}
            <StudentTable rows={rows} d={d} />
          </>
        ) : (
          <>
            <Slipping list={slippingFirst(rows)} d={d} />
            <WeekBars weeks={weeklyRates(recs, range)} title={d.attTrendsByWeek} L={L} d={d} />
            <h3 style={{ fontSize: 18 }}>{d.attEveryStudent}</h3>
            <StudentTable rows={rows} trends d={d} />
          </>
        )}
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.attRateHint}</p>
      <div><a className="btn btn-sm" href={exportHref(`${base}/export`, range, today)} download>{d.attDownloadRange}</a></div>
    </section>
  );
}
