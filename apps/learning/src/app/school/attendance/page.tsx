import Link from "next/link";
import { requireMe } from "@/lib/auth";
import { isSchoolAdmin, lang } from "@/lib/access";
import { dict } from "@/lib/i18n";
import { addDays, addSchoolDays, isSchoolDay, parseDay, todayIn } from "@/lib/planner";
import { SCHOOL_TZ } from "@/lib/school-grading";
import { schoolDay, statusWord } from "@/lib/attendance";
import { TopBar } from "@/components/TopBar";
import { When } from "@/components/When";

export const dynamic = "force-dynamic";

/**
 * The school's attendance (story 01, D6): every class's record for one day
 * (taken or not, counts, who wasn't present), and a CSV export of a date
 * range for the school's SIS. School admins only.
 */
export default async function SchoolAttendancePage({ searchParams }: { searchParams: Promise<{ day?: string }> }) {
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
  let day = parseDay((await searchParams).day) ?? today;
  if (day > today) day = today;
  while (!isSchoolDay(day)) day = addDays(day, -1);
  const classes = await schoolDay(me.tenantId, day);
  const notTaken = classes.filter((c) => !c.taken).length;
  const monthAgo = addDays(today, -30);

  return (
    <>
      <TopBar crumbs={crumbs} />
      <main className="page stack" style={{ maxWidth: 1000 }}>
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

        <section className="card stack" aria-labelledby="att-export" style={{ gap: 10 }}>
          <h2 id="att-export" style={{ fontSize: 20 }}>{d.attExportTitle}</h2>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>{d.attExportHint}</p>
          <form action="/school/attendance/export" method="get" className="row" style={{ flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
            <div className="fieldset" style={{ margin: 0 }}>
              <label htmlFor="att-from">{d.attFrom}</label>
              <input id="att-from" name="from" type="date" className="field" defaultValue={monthAgo} max={today} required />
            </div>
            <div className="fieldset" style={{ margin: 0 }}>
              <label htmlFor="att-to">{d.attTo}</label>
              <input id="att-to" name="to" type="date" className="field" defaultValue={today} max={today} required />
            </div>
            <button type="submit" className="btn btn-primary">{d.attExport}</button>
          </form>
        </section>
      </main>
    </>
  );
}
