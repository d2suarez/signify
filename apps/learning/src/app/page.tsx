import Link from "next/link";
import { requireMe, myClasses } from "@/lib/auth";
import { myCourses } from "@/lib/courses";
import { lang, isSchoolAdmin } from "@/lib/access";
import { t } from "@/lib/i18n";
import { liveLessonId } from "@/lib/live-ticket";
import { TopBar } from "@/components/TopBar";

export const dynamic = "force-dynamic";

export default async function Home() {
  const me = await requireMe();
  const L = await lang();
  const { ok, classes } = await myClasses();
  const courses = await myCourses(me.tenantId, classes);
  const teaching = courses.filter((c) => c.role === "teacher");
  const learning = courses.filter((c) => c.role === "student");

  return (
    <>
      <TopBar crumbs={<span>{me.tenantName || me.name}</span>} right={<span className="muted" style={{ fontSize: 14 }}>{me.name}</span>} />
      <main className="page stack">
        <div className="row">
          <h1 style={{ fontSize: 34 }} className="grow">{t("myCourses", L)}</h1>
          {teaching.length > 0 && <Link className="btn" href="/planner">{t("planner", L)}</Link>}
          {isSchoolAdmin(me) && <a className="btn" href="/school/periods">{t("periods", L)}</a>}
        </div>
        {!ok && (
          <div className="notice notice-bad" role="alert">
            {t("classesFailed", L)} <a href="/">{t("tryAgain", L)}</a>
          </div>
        )}

        {teaching.length > 0 && (
          <section>
            <div className="section-title"><span className="shape s-square" /><h2>{t("teaching", L)}</h2></div>
            <div className="grid-cards">
              {teaching.map((c) => (
                <Link key={c.id} href={`/courses/${c.id}`} className="card course-card">
                  <span className="muted" style={{ fontSize: 13 }}>{c.subject || " "}</span>
                  <h3>{c.name}</h3>
                  <span className="row" style={{ fontSize: 14 }}>
                    <span className="muted">{c.lessonCount} {c.lessonCount === 1 ? t("lesson", L) : t("lessons", L)}</span>
                    {c.covering && <span className="pill">{t("covering", L)}</span>}
                    {liveLessonId(c.id) && <span className="pill"><span className="live-dot" />{t("liveNow", L)}</span>}
                  </span>
                </Link>
              ))}
            </div>
          </section>
        )}

        {learning.length > 0 && (
          <section>
            <div className="section-title"><span className="shape s-arch" /><h2>{t("learning", L)}</h2></div>
            <div className="grid-cards">
              {learning.map((c) => {
                const live = !!liveLessonId(c.id);
                return (
                  <Link key={c.id} href={live ? `/courses/${c.id}/live` : `/courses/${c.id}`} className="card course-card">
                    <span className="muted" style={{ fontSize: 13 }}>{c.subject || " "}</span>
                    <h3>{c.name}</h3>
                    {live && <span className="pill" style={{ alignSelf: "flex-start" }}><span className="live-dot" />{t("joinLive", L)}</span>}
                  </Link>
                );
              })}
            </div>
          </section>
        )}

        {ok && courses.length === 0 && <p className="empty">{t("noCourses", L)}</p>}
      </main>
    </>
  );
}
