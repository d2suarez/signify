import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMe } from "@/lib/auth";
import { ctx, lang, isSchoolAdmin, standardsViewer } from "@/lib/access";
import { dict } from "@/lib/i18n";
import { myCatalog, requestsToAnswer, grantedShares } from "@/lib/sections";
import { TopBar } from "@/components/TopBar";
import { ShareRequests } from "@/components/ShareRequests";

export const dynamic = "force-dynamic";

/** The courses this teacher has taught, each with its sections by year, and sharing requests. */
export default async function CatalogPage() {
  const me = await requireMe();
  const L = await lang();
  // Teachers (from live Signify ID classes) and school admins only.
  if (!(await standardsViewer(me))) notFound();
  const d = dict(L);
  const c = { ...ctx(me), admin: isSchoolAdmin(me) };
  const [courses, toAnswer, granted] = await Promise.all([myCatalog(c), requestsToAnswer(c), grantedShares(c)]);
  return (
    <>
      <TopBar crumbs={<Link href="/">{d.myCourses}</Link>} />
      <main className="page stack">
        <h1 style={{ fontSize: 34 }}>{d.secCatalogTitle}</h1>
        <p className="muted" style={{ margin: 0 }}>{d.secCatalogHint}</p>
        {toAnswer.length > 0 && (
          <section className="card stack" aria-labelledby="answer-title" style={{ gap: 10 }}>
            <h2 id="answer-title" className="label">{d.secToAnswer}</h2>
            <ShareRequests list={toAnswer} back="/catalog" d={d} />
          </section>
        )}
        {courses.length === 0 && <p className="empty">{d.secNoCatalog}</p>}
        <div className="grid-cards">
          {courses.map((k) => (
            <Link key={k.id} href={`/catalog/${k.id}`} className="card course-card">
              <span className="muted" style={{ fontSize: 13 }}>{k.subject || " "}</span>
              <h3>{k.name}</h3>
              <span className="muted" style={{ fontSize: 14 }}>{k.sections.map((s) => s.schoolYear || d.secNoYear).join(" · ")}</span>
            </Link>
          ))}
        </div>
        {granted.length > 0 && (
          <section className="card stack" aria-labelledby="granted-title" style={{ gap: 10 }}>
            <h2 id="granted-title" className="label">{d.secGranted}</h2>
            <ShareRequests list={granted} granted back="/catalog" d={d} />
          </section>
        )}
      </main>
    </>
  );
}
