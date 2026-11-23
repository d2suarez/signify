import Link from "next/link";
import { myClasses, requireMe } from "@/lib/auth";
import { myCourses } from "@/lib/courses";
import { isSchoolAdmin, lang } from "@/lib/access";
import { dict } from "@/lib/i18n";
import { todayIn, isSchoolDay } from "@/lib/planner";
import { SCHOOL_TZ } from "@/lib/school-grading";
import { takenOn } from "@/lib/attendance-views";
import { countsLine } from "@/components/AttendanceViews";
import { TopBar } from "@/components/TopBar";

export const dynamic = "force-dynamic";

/**
 * Take attendance (Desmond 2026-11-23: "on the home page, when I click on
 * the attendance tab, I should be able to click on a class and start taking
 * attendance there"). The home page's Attendance button: every class and
 * club this person teaches, each one tap from today's attendance on its
 * Attendance tab (the same record as the seating chart slide), with
 * whether today's is taken. School admins also get the whole school's.
 */
export default async function TakeAttendancePage() {
  const me = await requireMe();
  const L = await lang();
  const d = dict(L);
  const { ok, classes } = await myClasses();
  const taught = (await myCourses(me.tenantId, classes, me.id)).filter((c) => c.role === "teacher")
    .sort((a, b) => Number(a.kind === "club") - Number(b.kind === "club") || a.name.localeCompare(b.name));
  const today = todayIn(SCHOOL_TZ);
  const schoolDay = isSchoolDay(today);
  const taken = schoolDay ? await takenOn(me.tenantId, taught.map((c) => c.id), today) : new Map();
  const admin = isSchoolAdmin(me);
  return (
    <>
      <TopBar crumbs={<><Link href="/">{d.myCourses}</Link> · {d.attTitle}</>} />
      <main className="page stack" style={{ maxWidth: 760 }}>
        <div className="row" style={{ flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
          <h1 style={{ fontSize: 34, flex: "1 1 12em", minWidth: 0 }}>{d.attHubTitle}</h1>
          {admin && <Link className="btn btn-sm" href="/school/attendance">{d.attHubSchool}</Link>}
        </div>
        {!ok && <div className="notice notice-bad" role="alert">{d.classesFailed} <a href="/attendance">{d.tryAgain}</a></div>}
        {!schoolDay && <p className="notice" style={{ margin: 0 }}>{d.attHubWeekend}</p>}
        {ok && taught.length === 0 ? <p className="card empty" style={{ margin: 0 }}>{d.attHubNone}</p> : taught.length > 0 && (
          <>
            {schoolDay && <p className="muted" style={{ margin: 0 }}>{d.attHubHint}</p>}
            <ul className="class-list card att-hub">
              {taught.map((c) => {
                const t = taken.get(c.id);
                return (
                  <li key={c.id}>
                    <Link href={`/courses/${c.id}/attendance`} className="class-link">
                      <span className={`shape ${c.kind === "club" ? "s-arch" : "s-square"}`} aria-hidden="true" />
                      <span className="grow" style={{ minWidth: 0 }}>
                        <span className="class-name">{c.name}</span>
                        <span className="muted class-sub">
                          {!schoolDay ? [c.subject, c.schoolYear].filter(Boolean).join(" · ") || d.attTitle
                            : t ? `${d.attHubTaken} · ${countsLine(t, d)}` : d.attHubNotTaken}
                        </span>
                      </span>
                      <span className={`chip${t ? " chip-done" : schoolDay ? " chip-late" : ""}`}>{t ? d.attTakenShort : schoolDay ? d.attNotTakenShort : d.attTitle}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </main>
    </>
  );
}
