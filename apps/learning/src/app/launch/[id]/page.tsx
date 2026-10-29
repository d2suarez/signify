import Link from "next/link";
import { redirect } from "next/navigation";
import { requireMe, readMe, myClasses } from "@/lib/auth";
import { lang } from "@/lib/access";
import { linkLaunch, resolveLaunch } from "@/lib/lti";
import { dict, type Key } from "@/lib/i18n";
import { TopBar } from "@/components/TopBar";

export const dynamic = "force-dynamic";

async function link(formData: FormData) {
  "use server";
  const me = await readMe();
  if (!me) return;
  const id = String(formData.get("launchId") || "");
  const { ok, classes } = await myClasses();
  if (!ok) return;
  const r = await linkLaunch(id, me, classes, String(formData.get("courseId") || ""));
  if (r.ok) redirect(`/courses/${r.courseId}`);
  redirect(`/launch/${encodeURIComponent(id)}?e=${r.error}`);
}

/**
 * An LTI launch from Schoology, opened with the person's own Signify sign-in.
 * It opens only for the same email at the same school, and the course only if
 * Signify ID says they're in that class.
 */
export default async function LaunchPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ e?: string }>;
}) {
  const { id } = await params;
  const { e } = await searchParams;
  const me = await requireMe();
  const d = dict(await lang());
  const { ok, classes } = await myClasses();
  const r = ok ? await resolveLaunch(id, me, classes) : { kind: "error" as const, error: "classesFailed" };
  if (r.kind === "course") redirect(`/courses/${r.courseId}`);

  return (
    <>
      <TopBar crumbs={<Link href="/">{d.myCourses}</Link>} />
      <main className="page stack" style={{ maxWidth: 640 }}>
        <h1 style={{ fontSize: 30 }}>{r.kind === "error" ? d.ltiRefusedTitle : r.launch.contextTitle || d.ltiFromSchoology}</h1>
        {e && <p className="notice" role="alert">{d[e as Key] ?? d.ltiBadToken}</p>}
        {r.kind === "error" && <p>{d[r.error as Key] ?? d.ltiBadToken}</p>}
        {r.kind === "notLinked" && <p>{d.ltiNotLinked}</p>}
        {r.kind === "pick" && (
          <section className="card stack">
            <p style={{ margin: 0 }}>{d.ltiPickHint}</p>
            <form action={link} className="stack">
              <input type="hidden" name="launchId" value={r.launch.id} />
              <div className="fieldset">
                <label htmlFor="lti-course">{d.ltiPickCourse}</label>
                <select id="lti-course" name="courseId" className="field" required>
                  {r.courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div><button className="btn btn-primary">{d.ltiLink}</button></div>
            </form>
          </section>
        )}
        <p><Link href="/">{d.myCourses}</Link></p>
      </main>
    </>
  );
}
