import Link from "next/link";
import { redirect } from "next/navigation";
import { requireMe, readMe, myClasses } from "@/lib/auth";
import { lang } from "@/lib/access";
import { linkLaunch, resolveLaunch } from "@/lib/lti";
import { pickables, placeItems } from "@/lib/lti-dl";
import { ourOrigin } from "@/lib/lti-http";
import { headers } from "next/headers";
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
  const w = formData.get("w") ? "w=1&" : "";
  // A deep-linking launch comes back here to pick; any other opens the course.
  if (r.ok && !formData.get("deepLink")) redirect(`/courses/${r.courseId}`);
  redirect(`/launch/${encodeURIComponent(id)}?${w}${r.ok ? "" : `e=${r.error}`}`);
}

async function place(formData: FormData) {
  "use server";
  const me = await readMe();
  if (!me) return;
  const id = String(formData.get("launchId") || "");
  const { ok, classes } = await myClasses();
  if (!ok) return;
  const refs = formData.get("cancel") ? [] : formData.getAll("item").map(String);
  const r = await placeItems(id, me, classes, String(formData.get("courseId") || ""), refs, ourOrigin(await headers()));
  const lid = encodeURIComponent(id);
  if (!r.ok) redirect(`/launch/${lid}?e=${r.error}`);
  // Opened in a window (no frame waiting): this tab posts the answer itself.
  if (formData.get("w")) redirect(`/lti/deep/${lid}/post`);
  redirect(`/launch/${lid}?placed=${r.count}`);
}

/**
 * An LTI launch from Schoology, opened with the person's own Signify sign-in.
 * It opens only for the same email at the same school, and the course only if
 * Signify ID says they're in that class.
 */
export default async function LaunchPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ e?: string; w?: string; placed?: string }>;
}) {
  const { id } = await params;
  const { e, w, placed } = await searchParams;
  const me = await requireMe();
  const d = dict(await lang());
  if (placed !== undefined) {
    return (
      <>
        <TopBar crumbs={<Link href="/">{d.myCourses}</Link>} />
        <main className="page stack" style={{ maxWidth: 640 }}>
          <h1 style={{ fontSize: 30 }}>{d.ltiDlTitle}</h1>
          <p className="notice" role="status">{Number(placed) > 0 ? d.ltiDlDone : d.ltiDlDoneNone}</p>
          <p><Link href="/">{d.myCourses}</Link></p>
        </main>
      </>
    );
  }
  const { ok, classes } = await myClasses();
  const r = ok ? await resolveLaunch(id, me, classes) : { kind: "error" as const, error: "classesFailed" };
  if (r.kind === "course") redirect(`/courses/${r.courseId}`);
  if (r.kind === "open") redirect(r.href);
  const items = r.kind === "deepLink" ? await pickables(me.tenantId, r.courseId) : [];
  const multiple = r.kind === "deepLink" ? r.launch.deepLink?.acceptMultiple !== false : true;
  const pick = (kind: "assignment" | "lesson") => items.filter((p) => p.kind === kind);

  return (
    <>
      <TopBar crumbs={<Link href="/">{d.myCourses}</Link>} />
      <main className="page stack" style={{ maxWidth: 640 }}>
        <h1 style={{ fontSize: 30 }}>{r.kind === "error" ? d.ltiRefusedTitle : r.kind === "deepLink" ? d.ltiDlTitle : r.launch.contextTitle || d.ltiFromSchoology}</h1>
        {e && <p className="notice" role="alert">{d[e as Key] ?? d.ltiBadToken}</p>}
        {r.kind === "error" && <p>{d[r.error as Key] ?? d.ltiBadToken}</p>}
        {r.kind === "notLinked" && <p>{d.ltiNotLinked}</p>}
        {r.kind === "pick" && (
          <section className="card stack">
            <p style={{ margin: 0 }}>{d.ltiPickHint}</p>
            <form action={link} className="stack">
              <input type="hidden" name="launchId" value={r.launch.id} />
              {r.launch.deepLink && <input type="hidden" name="deepLink" value="1" />}
              {w && <input type="hidden" name="w" value="1" />}
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
        {r.kind === "deepLink" && (
          <form action={place} className="card stack">
            <input type="hidden" name="launchId" value={r.launch.id} />
            <input type="hidden" name="courseId" value={r.courseId} />
            {w && <input type="hidden" name="w" value="1" />}
            <p style={{ margin: 0 }}>{d.ltiDlHint}{multiple ? "" : ` ${d.ltiDlOne}`}</p>
            {items.length === 0 && <p className="empty">{d.ltiDlNone}</p>}
            {(["assignment", "lesson"] as const).map((kind) => pick(kind).length > 0 && (
              <fieldset key={kind} className="fieldset stack" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend style={{ fontWeight: 600, marginBottom: 8 }}>{kind === "assignment" ? d.ltiDlAssignments : d.ltiDlLessons}</legend>
                {pick(kind).map((p) => (
                  <label key={p.ref} className="row" style={{ minHeight: 44, gap: 12, alignItems: "center" }}>
                    <input type={multiple ? "checkbox" : "radio"} name="item" value={p.ref} style={{ width: 22, height: 22 }} />
                    <span className="grow">{p.title}</span>
                    {p.kind === "assignment" && <span className="muted">{p.points} {d.pts}{p.published ? "" : ` · ${d.ltiDlDraft}`}</span>}
                  </label>
                ))}
              </fieldset>
            ))}
            <div className="row" style={{ gap: 12 }}>
              {items.length > 0 && <button className="btn btn-primary">{d.ltiDlPlace}</button>}
              <button className="btn" name="cancel" value="1">{d.ltiDlCancel}</button>
            </div>
          </form>
        )}
        <p><Link href="/">{d.myCourses}</Link></p>
      </main>
    </>
  );
}
