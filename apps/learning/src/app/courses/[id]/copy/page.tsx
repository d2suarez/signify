import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMe } from "@/lib/auth";
import { courseAccess, ctx, lang } from "@/lib/access";
import { dict } from "@/lib/i18n";
import { copySources, sourceContents, askableSections, myRequests, noteTeacher } from "@/lib/sections";
import { TopBar } from "@/components/TopBar";
import { ClassHeader } from "@/components/ClassHeader";
import { CopyForm } from "@/components/CopyForm";
import { copyInto, askToShare, answerRequest } from "../section-actions";

export const dynamic = "force-dynamic";

const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? "");

/** Copy units, lessons and assignments into this class from another one; ask other teachers to share. */
export default async function CopyPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ from?: string; asked?: string }>;
}) {
  await requireMe();
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const L = await lang();
  const access = await courseAccess(id);
  if (!access || access.course.role !== "teacher") notFound();
  const { me, course } = access;
  const d = dict(L);
  const c = ctx(me);
  await noteTeacher(c, course.id);
  const [sources, askable, requests] = await Promise.all([copySources(c, course.id), askableSections(c), myRequests(c)]);
  const from = sources.find((s) => s.id === sp.from);
  const contents = from ? await sourceContents(c, from.id) : null;
  const year = (y: string) => y || d.secNoYear;
  const mine = sources.filter((s) => !s.shared), shared = sources.filter((s) => s.shared);
  const list = (items: typeof sources) => (
    <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0, gap: 6 }}>
      {items.map((s) => (
        <li key={s.id}>
          <Link className="btn" aria-current={s.id === from?.id ? "true" : undefined} href={`/courses/${course.id}/copy?from=${s.id}`}
            style={s.id === from?.id ? { borderColor: "var(--ink)" } : undefined}>
            {s.name} <span className="muted">· {year(s.schoolYear)}{s.courseName !== s.name ? ` · ${s.courseName}` : ""}</span>
          </Link>
        </li>
      ))}
    </ul>
  );

  return (
    <>
      <TopBar crumbs={<Link href="/">{d.myCourses}</Link>} below={<ClassHeader course={course} d={d} />} />
      <main className="page stack">
        <h1 style={{ fontSize: 30 }}>{fill(d.secCopyTitle, { name: course.name })}</h1>
        <p className="muted" style={{ margin: 0 }}>{d.secCopyHint}</p>

        <section className="card stack" aria-labelledby="from-title" style={{ gap: 10 }}>
          <h2 id="from-title" className="label">{d.secFrom}</h2>
          {sources.length === 0 && <p className="empty" style={{ margin: 0 }}>{d.secNoSources}</p>}
          {mine.length > 0 && <><h3 style={{ fontSize: 16, margin: 0 }}>{d.secYours}</h3>{list(mine)}</>}
          {shared.length > 0 && <><h3 style={{ fontSize: 16, margin: 0 }}>{d.secShared}</h3>{list(shared)}</>}
        </section>

        {from && contents && (
          <section className="stack" aria-labelledby="pick-title" style={{ gap: 10 }}>
            <h2 id="pick-title" style={{ fontSize: 22 }}>{d.secPick}: {from.name} <span className="muted">· {year(from.schoolYear)}</span></h2>
            {contents.units.length + contents.lessons.length + contents.assignments.length + contents.resources.length === 0
              ? <p className="empty">{d.secEmptySource}</p>
              : <CopyForm courseId={course.id} from={from.id} contents={contents} action={copyInto} d={d} />}
          </section>
        )}

        <section className="card stack" aria-labelledby="ask-title" style={{ gap: 10 }}>
          <h2 id="ask-title" className="label">{d.secAsk}</h2>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>{d.secAskHint}</p>
          {sp.asked && <div className="notice" role="status">{d.secAskSent}</div>}
          {askable.filter((s) => !s.asked).length === 0 ? <p className="empty" style={{ margin: 0 }}>{d.secNoAskable}</p> : (
            <form action={askToShare} className="stack" style={{ gap: 8 }}>
              <input type="hidden" name="courseId" value={course.id} />
              <label className="label" htmlFor="ask-source">{d.secAskWhich}</label>
              <select id="ask-source" name="source" className="field" required>
                {askable.filter((s) => !s.asked).map((s) => (
                  <option key={s.id} value={s.id}>{s.name} · {year(s.schoolYear)}{s.courseName !== s.name ? ` · ${s.courseName}` : ""}</option>
                ))}
              </select>
              <label className="label" htmlFor="ask-message">{d.secAskMessage}</label>
              <textarea id="ask-message" name="message" className="field" rows={2} maxLength={1000} />
              <button className="btn btn-primary" type="submit" style={{ alignSelf: "flex-start" }}>{d.secAskSend}</button>
            </form>
          )}
          {requests.length > 0 && (
            <>
              <h3 style={{ fontSize: 16, margin: 0 }}>{d.secMyRequests}</h3>
              <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0, gap: 6 }}>
                {requests.map((r) => (
                  <li key={r.id} className="row" style={{ gap: 8 }}>
                    <span className="grow">{r.sourceName} <span className="muted">· {year(r.sourceYear)}</span></span>
                    <span className="pill">{d[`secStatus_${r.status}` as const]}</span>
                    {r.status === "pending" && (
                      <form action={answerRequest}>
                        <input type="hidden" name="requestId" value={r.id} />
                        <input type="hidden" name="back" value={`/courses/${course.id}/copy`} />
                        <button className="btn btn-sm" name="op" value="withdraw">{d.secWithdraw}</button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </main>
    </>
  );
}
