import Link from "next/link";
import { noteTeacherName } from "@/lib/school-plans";
import { requireMe, myClasses, myChildren } from "@/lib/auth";
import { myCourses } from "@/lib/courses";
import { lang, isSchoolAdmin, ctx, updatesViewer } from "@/lib/access";
import { feed } from "@/lib/updates";
import { Feed } from "@/components/Updates";
import PostComposer from "@/components/PostComposer";
import { composerSetup } from "@/lib/composer";
import { myPreviewPeople } from "@/lib/preview";
import { liveLessonId } from "@/lib/live-ticket";
import { TopBar } from "@/components/TopBar";
import { ShareRequests } from "@/components/ShareRequests";
import { requestsToAnswer } from "@/lib/sections";
import { dict } from "@/lib/i18n";
import { teacherTasks, studentTasks, type StudentTask } from "@/lib/tasks";
import { studentWork } from "@/lib/family";
import { todayIn } from "@/lib/planner";
import { SCHOOL_TZ } from "@/lib/school-grading";
import { TodoPanel } from "@/components/Todo";

export const dynamic = "force-dynamic";

/**
 * Home: updates down the middle (write one at the top), what needs doing on
 * the left (in the left rail with the person's tools on wide screens),
 * classes and clubs on the right. On a narrow screen: to do, updates, then
 * classes (the rail with the tools comes after).
 */
export default async function Home() {
  const me = await requireMe();
  const L = await lang();
  const d = dict(L);
  const [{ ok, classes }, family] = await Promise.all([myClasses(), myChildren()]);
  const children = family.children;
  const isParent = me.role === "guardian" || children.length > 0;
  const courses = await myCourses(me.tenantId, classes, me.id);
  // The principal's weekly plans name teachers by their own display name (story 01, B4).
  if (courses.some((c) => c.role === "teacher")) await noteTeacherName(me.tenantId, me.id, me.name).catch(() => {});
  const onlyParent = isParent && courses.length === 0;
  const clubs = courses.filter((c) => c.kind === "club");
  const teaching = courses.filter((c) => c.role === "teacher" && c.kind !== "club");
  const learning = courses.filter((c) => c.role === "student" && c.kind !== "club");
  // Whom this teacher or admin may preview (Signify ID decides). Only the
  // practice people get a button here; real students are on /preview, where
  // there may be a whole school of them.
  const previews = teaching.length > 0 || isSchoolAdmin(me) ? (await myPreviewPeople()).people : [];
  const practice = previews.filter((p) => p.mock);
  const viewer = await updatesViewer();
  const now = new Date();
  const ownClasses = classes.filter((k) => k.role === "student");
  const [updates, setup, toAnswer, tTasks, sTasks] = await Promise.all([
    viewer ? feed(viewer, {}, 20) : Promise.resolve([]),
    viewer ? composerSetup(viewer, courses, d.updWholeSchool) : Promise.resolve(null),
    teaching.length > 0 || isSchoolAdmin(me) ? requestsToAnswer({ ...ctx(me), admin: isSchoolAdmin(me) }) : Promise.resolve([]),
    teaching.length > 0 ? teacherTasks(me, teaching.map((c) => c.id), todayIn(SCHOOL_TZ), now) : Promise.resolve(null),
    // A student's own work, and each child's for a parent: overdue and due soon.
    (async () => {
      const people = [
        ...(ownClasses.length ? [{ id: me.id, name: "", classes: ownClasses }] : []),
        ...children.map((k) => ({ id: k.id, name: k.display_name, classes: k.classes })),
      ];
      const each = await Promise.all(people.map(async (p) =>
        studentTasks(await studentWork(ctx(me), p.classes, p.id, now), now, 14, p.name ? { id: p.id, name: p.name } : undefined)));
      return { overdue: each.flatMap((t) => t.overdue) as StudentTask[], upcoming: each.flatMap((t) => t.upcoming) as StudentTask[] };
    })(),
  ]);

  const buttons = [
    (learning.length > 0 || isParent) && <Link key="w" className="btn btn-sm" href="/week">{d.thisWeek}</Link>,
    teaching.length > 0 && <Link key="p" className="btn btn-sm" href="/planner">{d.planner}</Link>,
    (teaching.length > 0 || isSchoolAdmin(me)) && <Link key="c" className="btn btn-sm" href="/catalog">{d.secCatalogTitle}</Link>,
    (teaching.length > 0 || isSchoolAdmin(me)) && <Link key="s" className="btn btn-sm" href="/standards">{d.standardsLibrary}</Link>,
    isSchoolAdmin(me) && <Link key="sp" className="btn btn-sm" href="/school/plans">{d.spTitle}</Link>,
    isSchoolAdmin(me) && <Link key="att" className="btn btn-sm" href="/school/attendance">{d.attSchoolTitle}</Link>,
    isSchoolAdmin(me) && <a key="pe" className="btn btn-sm" href="/school/periods">{d.periods}</a>,
    isSchoolAdmin(me) && <a key="g" className="btn btn-sm" href="/school/grading">{d.gradingSetupLink}</a>,
    isSchoolAdmin(me) && <a key="l" className="btn btn-sm" href="/school/lti">{d.ltiTitle}</a>,
    isSchoolAdmin(me) && <a key="wg" className="btn btn-sm" href="/school/widgets">{d.wgSchoolLink}</a>,
  ].filter(Boolean);

  const ClassLink = ({ c, sub }: { c: (typeof courses)[number]; sub?: string }) => {
    const live = !!liveLessonId(c.id);
    return (
      <li>
        <Link href={live && c.role === "student" ? `/courses/${c.id}/live` : `/courses/${c.id}`} className="class-link">
          <span className={`shape ${c.kind === "club" ? "s-arch" : c.role === "teacher" ? "s-square" : "s-arch"}`} aria-hidden="true" />
          <span className="grow" style={{ minWidth: 0 }}>
            <span className="class-name">{c.name}</span>
            {(sub || c.subject || c.schoolYear) && <span className="muted class-sub">{sub || [c.subject, c.schoolYear].filter(Boolean).join(" · ")}</span>}
          </span>
          {c.covering && <span className="pill">{d.covering}</span>}
          {live && <span className="pill"><span className="live-dot" />{c.role === "student" ? d.joinLive : d.liveNow}</span>}
        </Link>
      </li>
    );
  };

  return (
    <>
      <TopBar crumbs={<span>{me.tenantName || me.name}</span>} right={<span className="muted" style={{ fontSize: 14 }}>{me.name}</span>} />
      <main className="page page-wide home">
        <div className="row home-top">
          <h1 className="grow">{onlyParent ? d.yourChildren : d.homeTitle}</h1>
          {buttons.length > 0 && <nav className="row" aria-label={d.homeTools} style={{ gap: 6 }}>{buttons}</nav>}
        </div>
        {!ok && (
          <div className="notice notice-bad" role="alert">
            {d.classesFailed} <a href="/">{d.tryAgain}</a>
          </div>
        )}

        <div className="home-grid">
          {/* On wide screens To do is in the left rail (with the person's tools); here only on narrow ones. */}
          <aside className="home-todo stack" aria-label={d.todoTitle}>
            <TodoPanel teacher={tTasks} student={sTasks} d={d} L={L} />
          </aside>

          <section className="home-feed stack" aria-labelledby="home-updates" style={{ gap: 14 }}>
            <div className="row">
              <h2 id="home-updates" className="label grow">{d.updTitle}</h2>
              <Link className="btn btn-sm" href="/updates">{d.updAll}</Link>
            </div>
            {setup && setup.places.length > 0 && (
              <div className="card composer-card">
                <PostComposer places={setup.places} materials={setup.materials} canUpload={setup.canUpload} uploadFallback={setup.uploadFallback}
                  d={d} placeholder={teaching.length ? d.pcPlaceholderTeacher : d.pcPlaceholder} back="/" />
              </div>
            )}
            <Feed posts={updates} back="/" L={L} d={d} cards />
          </section>

          <aside className="home-classes stack" aria-label={d.homeClasses}>
            {toAnswer.length > 0 && (
              <section className="card stack" aria-labelledby="share-title" style={{ gap: 8 }}>
                <h2 id="share-title" className="label">{d.secToAnswerHome}</h2>
                <ShareRequests list={toAnswer} back="/" d={d} />
              </section>
            )}
            {teaching.length > 0 && (
              <section className="card side-card" aria-labelledby="h-teaching">
                <h2 id="h-teaching" className="label">{d.teaching}</h2>
                <ul className="class-list">{teaching.map((c) => <ClassLink key={c.id} c={c} />)}</ul>
              </section>
            )}
            {learning.length > 0 && (
              <section className="card side-card" aria-labelledby="h-learning">
                <h2 id="h-learning" className="label">{d.learning}</h2>
                <ul className="class-list">{learning.map((c) => <ClassLink key={c.id} c={c} />)}</ul>
              </section>
            )}
            {clubs.length > 0 && (
              <section className="card side-card" aria-labelledby="h-clubs">
                <h2 id="h-clubs" className="label">{d.clubsTitle}</h2>
                <ul className="class-list">{clubs.map((c) => <ClassLink key={c.id} c={c} sub={c.role === "teacher" ? d.clubSponsors : d.clubLabel} />)}</ul>
              </section>
            )}
            {isParent && (
              <section className="card side-card" aria-labelledby="h-children">
                <h2 id="h-children" className="label">{d.yourChildren}</h2>
                {!family.ok && <div className="notice notice-bad" role="alert">{d.childrenFailed} <a href="/">{d.tryAgain}</a></div>}
                {family.ok && children.length === 0 && <p className="empty" style={{ margin: 0 }}>{d.noChildren}</p>}
                <ul className="class-list">
                  {children.map((c) => (
                    <li key={c.id}>
                      <Link href={`/family/${c.id}`} className="class-link">
                        <span className="shape s-circle" aria-hidden="true" />
                        <span className="grow"><span className="class-name">{c.display_name}</span><span className="muted class-sub">{d.seeAllWork}</span></span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {ok && courses.length === 0 && !isParent && <p className="card empty" style={{ margin: 0 }}>{d.noCourses}</p>}
            {previews.length > 0 && (
              <section className="card side-card stack" aria-labelledby="preview-title" style={{ gap: 8 }}>
                <h2 id="preview-title" className="label">{d.previewTitle}</h2>
                <div className="row" style={{ gap: 6 }}>
                  {practice.map((p) => (
                    <Link key={p.id} className="btn btn-sm" href={`/preview/${p.id}`}>
                      {p.display_name} <span className="muted">· {p.kind === "parent" ? d.previewPracticeParent : d.previewPracticeStudent}</span>
                    </Link>
                  ))}
                  {previews.length > practice.length && <Link className="btn btn-sm" href="/preview">{d.previewEveryone} ({previews.length}) →</Link>}
                </div>
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.previewHint}</p>
              </section>
            )}
          </aside>
        </div>
      </main>
    </>
  );
}
