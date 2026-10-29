import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireMe, readMe } from "@/lib/auth";
import { isSchoolAdmin, lang } from "@/lib/access";
import { SCHOOLOGY, listLinks, listPlatforms, registerPlatform, removePlatform, unlinkContext } from "@/lib/lti";
import { ourOrigin } from "@/lib/lti-http";
import { dict, type Key } from "@/lib/i18n";
import { TopBar } from "@/components/TopBar";

export const dynamic = "force-dynamic";

async function act(formData: FormData) {
  "use server";
  const me = await readMe();
  if (!me || !isSchoolAdmin(me)) return;
  const op = String(formData.get("op") || "");
  if (op === "add") {
    const r = await registerPlatform(me.tenantId, me.id, Object.fromEntries(formData));
    if (!r.ok) redirect(`/school/lti?e=${r.error}`);
  }
  if (op === "remove") await removePlatform(me.tenantId, String(formData.get("platformId")));
  if (op === "unlink") await unlinkContext(me.tenantId, String(formData.get("platformId")), String(formData.get("contextId")));
  revalidatePath("/school/lti");
  redirect("/school/lti");
}

function Copy({ label, value }: { label: string; value: string }) {
  return (
    <div className="fieldset">
      <label>{label}</label>
      <input className="field" readOnly value={value} aria-label={label} style={{ fontFamily: "var(--mono, monospace)" }} />
    </div>
  );
}

/** School admins register Schoology (or another LMS) as an LTI 1.3 platform. */
export default async function LtiPage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  const me = await requireMe();
  const d = dict(await lang());
  const { e } = await searchParams;
  const admin = isSchoolAdmin(me);
  const origin = ourOrigin(await headers());
  const [platforms, links] = admin ? await Promise.all([listPlatforms(me.tenantId), listLinks(me.tenantId)]) : [[], []];

  return (
    <>
      <TopBar crumbs={<><Link href="/">{d.myCourses}</Link> · {me.tenantName}</>} />
      <main className="page stack" style={{ maxWidth: 820 }}>
        <h1 style={{ fontSize: 34 }}>{d.ltiTitle}</h1>
        <p className="muted" style={{ margin: 0 }}>{d.ltiHint}</p>
        {!admin && <p className="notice">{d.ltiOnlyAdmins}</p>}
        {admin && (
          <>
            <section className="card stack">
              <h2 style={{ margin: 0, fontSize: 22 }}>{d.ltiStep1}</h2>
              <p className="muted" style={{ margin: 0 }}>{d.ltiStep1Hint}</p>
              <Copy label={d.ltiToolName} value="Signify Learning" />
              <Copy label={d.ltiLoginUrl} value={`${origin}/lti/login`} />
              <Copy label={d.ltiRedirectUrl} value={`${origin}/lti/launch`} />
              <Copy label={d.ltiTargetUrl} value={`${origin}/lti/launch`} />
              <Copy label={d.ltiJwksUrl} value={`${origin}/.well-known/jwks.json`} />
              <Copy label={d.ltiDeepLinkUrl} value={`${origin}/lti/launch`} />
              <p className="muted" style={{ margin: 0 }}>{d.ltiPrivacyHint}</p>
              <p className="muted" style={{ margin: 0 }}>{d.ltiServicesHint}</p>
            </section>

            <section className="card stack">
              <h2 style={{ margin: 0, fontSize: 22 }}>{d.ltiStep2}</h2>
              {platforms.length === 0 && <p className="empty">{d.ltiNone}</p>}
              <ul className="list">
                {platforms.map((p) => (
                  <li key={p.id}>
                    <span className="grow">
                      <b>{p.name}</b> <span className="muted">{p.issuer} · {d.ltiClientId}: {p.clientId} · {d.ltiDeployments}: {p.deploymentIds.join(", ") || d.ltiAnyDeployment} · {d.ltiFrameOrigins}: {p.frameOrigins.join(" ") || "—"}</span>
                    </span>
                    <form action={act}>
                      <input type="hidden" name="platformId" value={p.id} />
                      <button className="btn btn-sm" name="op" value="remove">{d.ltiRemove}</button>
                    </form>
                  </li>
                ))}
              </ul>
              {e && <p className="notice" role="alert">{d[e as Key] ?? e}</p>}
              <form action={act} className="stack">
                <p className="muted" style={{ margin: 0 }}>{d.ltiStep2Hint}</p>
                {([
                  ["name", d.name, SCHOOLOGY.name, true],
                  ["clientId", d.ltiClientId, "", true],
                  ["deploymentIds", d.ltiDeployments, "", false],
                  ["issuer", d.ltiIssuer, SCHOOLOGY.issuer, true],
                  ["authUrl", d.ltiAuthUrl, SCHOOLOGY.authUrl, true],
                  ["tokenUrl", d.ltiTokenUrl, SCHOOLOGY.tokenUrl, false],
                  ["jwksUrl", d.ltiPlatformJwks, SCHOOLOGY.jwksUrl, true],
                  ["frameOrigins", d.ltiFrameOrigins, "https://*.schoology.com", false],
                ] as const).map(([name, label, value, required]) => (
                  <div className="fieldset" key={name}>
                    <label htmlFor={`lti-${name}`}>{label}</label>
                    <input id={`lti-${name}`} name={name} className="field" defaultValue={value} required={required} maxLength={500} />
                  </div>
                ))}
                <p className="muted" style={{ margin: 0 }}>{d.ltiFrameHint}</p>
                <div><button className="btn btn-primary" name="op" value="add">{d.ltiRegister}</button></div>
              </form>
            </section>

            <section className="card stack">
              <h2 style={{ margin: 0, fontSize: 22 }}>{d.ltiLinked}</h2>
              <p className="muted" style={{ margin: 0 }}>{d.ltiLinkedHint}</p>
              {links.length === 0 && <p className="empty">{d.ltiNoLinks}</p>}
              <ul className="list">
                {links.map((l) => (
                  <li key={l.platformId + l.contextId}>
                    <span className="grow"><b>{l.title || l.contextId}</b> → {l.courseName}</span>
                    <form action={act}>
                      <input type="hidden" name="platformId" value={l.platformId} />
                      <input type="hidden" name="contextId" value={l.contextId} />
                      <button className="btn btn-sm" name="op" value="unlink">{d.ltiUnlink}</button>
                    </form>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </main>
    </>
  );
}
