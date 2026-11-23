import Link from "next/link";
import { requireMe } from "@/lib/auth";
import { isSchoolAdmin, lang } from "@/lib/access";
import { dict } from "@/lib/i18n";
import { addDays, parseDay, schoolWeek, todayIn } from "@/lib/planner";
import { schoolTeachers, schoolWeekPlans } from "@/lib/school-plans";
import type { PlanDay } from "@/lib/week-plan";
import { TopBar } from "@/components/TopBar";
import { When } from "@/components/When";
import PrintButton from "@/components/PrintButton";

export const dynamic = "force-dynamic";

const SCHOOL_TZ = "America/New_York";

/**
 * The principal's weekly plans (teacher story 01, B4): every teacher's week
 * as planned in Learning, per class and day, with the materials (linked to
 * a read-only view) and the standards they measure. "Print / Save as PDF"
 * prints it, one teacher to a page. School admins only.
 */
export default async function SchoolPlansPage({ searchParams }: { searchParams: Promise<{ week?: string; teacher?: string }> }) {
  const me = await requireMe();
  const L = await lang();
  const d = dict(L);
  const { week, teacher } = await searchParams;
  const crumbs = <><Link href="/">{d.myCourses}</Link> · {me.tenantName}</>;
  if (!isSchoolAdmin(me)) {
    return (
      <>
        <TopBar crumbs={crumbs} />
        <main className="page stack" style={{ maxWidth: 900 }}>
          <h1 style={{ fontSize: 34 }}>{d.spTitle}</h1>
          <p className="notice">{d.spOnlyAdmins}</p>
        </main>
      </>
    );
  }
  const today = todayIn(SCHOOL_TZ);
  const days = schoolWeek(parseDay(week) ?? today);
  const [everyone, plans] = await Promise.all([schoolTeachers(me.tenantId), schoolWeekPlans(me.tenantId, days, { teacher: teacher || undefined })]);
  const locale = L === "es" ? "es" : "en-US";
  const dayName = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString(locale, { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
  const range = `${new Date(`${days[0]}T12:00:00Z`).toLocaleDateString(locale, { month: "long", day: "numeric", timeZone: "UTC" })} – ${new Date(`${days[4]}T12:00:00Z`).toLocaleDateString(locale, { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
  const q = (w: string) => `/school/plans?week=${w}${teacher ? `&teacher=${encodeURIComponent(teacher)}` : ""}`;
  const view = (kind: string, id: string) => `/school/plans/${kind}/${id}`;
  const kindWord = (sub: string) => (sub === "quiz" ? d.kindQuiz : sub === "online" || sub === "offline" ? d.pcKindAssignment : sub === "lesson" ? d.lesson : d.matMaterial);

  const Day = ({ p }: { p: PlanDay }) => {
    const nothing = !p.lessons.length && !p.materials.length && !p.due.length && !p.presentation;
    return (
      <tr>
        <th scope="row">{dayName(p.day)}</th>
        <td>
          {nothing ? <span className="muted">—</span> : (
            <ul className="plans-items">
              {p.presentation && <li><span aria-hidden="true">▶ </span><Link href={view("lesson", p.presentation.id)}>{p.presentation.title}</Link> <span className="muted">· {d.spSlides}</span></li>}
              {p.lessons.map((l) => <li key={l.id}><span className="shape s-arch" aria-hidden="true" /> <Link href={view("lesson", l.id)}>{l.title}</Link> <span className="muted">· {d.lesson}</span></li>)}
              {p.materials.map((m) => (
                <li key={m.itemId}>
                  <span className={`shape ${m.kind === "assignment" ? "s-tri" : "s-square"}`} aria-hidden="true" /> <Link href={view(m.kind, m.id)}>{m.title || d.untitled}</Link>
                  <span className="muted"> · {kindWord(m.sub)}{m.hidden ? ` · ${m.kind === "assignment" ? d.draft : d.pcHiddenFromStudents}` : ""}</span>
                </li>
              ))}
              {p.due.map((a) => <li key={`due-${a.id}`} className="muted">{d.due}: <Link href={view("assignment", a.id)}>{a.title}</Link>{a.dueAt && <> · <When iso={a.dueAt} lang={L} /></>}</li>)}
            </ul>
          )}
        </td>
        <td>
          {p.standards.length === 0 ? <span className="muted">—</span> : (
            <ul className="plans-items">
              {p.standards.map((s) => <li key={s.id}><b>{s.code}</b> {s.description}</li>)}
            </ul>
          )}
        </td>
      </tr>
    );
  };

  return (
    <>
      <TopBar crumbs={crumbs} />
      <main className="page page-wide stack plans-page">
        <div className="row">
          <div className="grow">
            <h1 style={{ fontSize: 34 }}>{d.spTitle}</h1>
            <p className="muted" style={{ margin: 0 }}>{me.tenantName} · {range}</p>
          </div>
          <nav className="row no-print" aria-label={d.spTitle}>
            <Link className="btn btn-sm" href={q(addDays(days[0], -7))}>← {d.previousWeek}</Link>
            <Link className="btn btn-sm" href={teacher ? `/school/plans?teacher=${encodeURIComponent(teacher)}` : "/school/plans"}>{d.thisWeek}</Link>
            <Link className="btn btn-sm" href={q(addDays(days[0], 7))}>{d.nextWeek} →</Link>
            <PrintButton label={d.spPrint} />
          </nav>
        </div>
        <p className="muted no-print" style={{ margin: 0 }}>{d.spHint}</p>
        <form method="get" className="row no-print" style={{ gap: 8 }}>
          <input type="hidden" name="week" value={days[0]} />
          <label htmlFor="sp-teacher" className="label" style={{ margin: 0 }}>{d.spTeacher}</label>
          <select id="sp-teacher" name="teacher" className="field" defaultValue={teacher ?? ""} style={{ maxWidth: 320 }}>
            <option value="">{d.spEveryone}</option>
            {everyone.map((t) => <option key={t.userId} value={t.userId}>{t.name || d.spUnnamed}</option>)}
          </select>
          <button className="btn btn-sm">{d.spShow}</button>
        </form>

        {plans.length === 0 && <p className="empty">{d.spNoTeachers}</p>}
        {plans.map((t) => (
          <section key={t.userId} className="card stack plans-teacher" aria-labelledby={`sp-${t.userId}`}>
            <h2 id={`sp-${t.userId}`} style={{ fontSize: 24 }}>{t.name || d.spUnnamed}</h2>
            <p className="muted print-only" style={{ margin: 0 }}>{me.tenantName} · {range}</p>
            {t.empty && <p className="muted" style={{ margin: 0 }}>{d.spNothingPlanned}</p>}
            {t.classes.filter((c) => !c.empty).map((c) => (
              <div key={c.courseId} className="stack" style={{ gap: 6 }}>
                <h3 style={{ fontSize: 18, margin: 0 }}>{c.name}{c.schoolYear ? <span className="muted" style={{ fontWeight: 400 }}> · {c.schoolYear}</span> : null}</h3>
                <div className="table-scroll">
                  <table className="plain-table plans-table">
                    <thead><tr><th scope="col">{d.spDay}</th><th scope="col">{d.spPlan}</th><th scope="col">{d.planStandards}</th></tr></thead>
                    <tbody>{c.days.map((p) => <Day key={p.day} p={p} />)}</tbody>
                  </table>
                </div>
              </div>
            ))}
            {!t.empty && t.classes.some((c) => c.empty) && (
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.spEmptyClasses}: {t.classes.filter((c) => c.empty).map((c) => c.name).join(", ")}</p>
            )}
          </section>
        ))}
      </main>
    </>
  );
}
