import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireMe, readMe } from "@/lib/auth";
import { isSchoolAdmin, lang } from "@/lib/access";
import { listTools, platformInfo, registerTool, removeTool, setToolPrivacy, type DataShare } from "@/lib/lti-platform";
import { ourOrigin } from "@/lib/lti-http";
import { dict, type Dict, type Key } from "@/lib/i18n";
import { TopBar } from "@/components/TopBar";

export const dynamic = "force-dynamic";

async function act(formData: FormData) {
  "use server";
  const me = await readMe();
  if (!me || !isSchoolAdmin(me)) return;
  const op = String(formData.get("op") || "");
  if (op === "add") {
    const r = await registerTool(me.tenantId, me.id, Object.fromEntries(formData));
    if (!r.ok) redirect(`/school/tools?e=${r.error}`);
  }
  if (op === "privacy") await setToolPrivacy(me.tenantId, String(formData.get("toolId")), formData.get("teacherData"), formData.get("studentData"));
  if (op === "remove") await removeTool(me.tenantId, String(formData.get("toolId")));
  revalidatePath("/school/tools");
  redirect("/school/tools");
}

function Copy({ label, value }: { label: string; value: string }) {
  return (
    <div className="fieldset">
      <label>{label}</label>
      <input className="field" readOnly value={value} aria-label={label} style={{ fontFamily: "var(--mono, monospace)" }} />
    </div>
  );
}

function ShareSelect({ name, value, d, id }: { name: string; value: DataShare; d: Dict; id: string }) {
  return (
    <select id={id} name={name} className="field" defaultValue={value}>
      <option value="none">{d.toolShareNone}</option>
      <option value="name">{d.toolShareName}</option>
      <option value="name_email">{d.toolShareNameEmail}</option>
    </select>
  );
}

/** School admins register outside tools (LTI 1.3) that teachers may put in lessons and assignments. */
export default async function ToolsPage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  const me = await requireMe();
  const d = dict(await lang());
  const { e } = await searchParams;
  const admin = isSchoolAdmin(me);
  const p = platformInfo(ourOrigin(await headers()));
  const tools = admin ? await listTools(me.tenantId) : [];

  return (
    <>
      <TopBar crumbs={<><Link href="/">{d.myCourses}</Link> · {me.tenantName} · <Link href="/school/lti">{d.ltiTitle}</Link></>} />
      <main className="page stack" style={{ maxWidth: 820 }}>
        <h1 style={{ fontSize: 34 }}>{d.toolsTitle}</h1>
        <p className="muted" style={{ margin: 0 }}>{d.toolsHint}</p>
        {!admin && <p className="notice">{d.ltiOnlyAdmins}</p>}
        {admin && (
          <>
            <section className="card stack">
              <h2 style={{ margin: 0, fontSize: 22 }}>{d.toolsOurs}</h2>
              <p className="muted" style={{ margin: 0 }}>{d.toolsOursHint}</p>
              <Copy label={d.ltiIssuer} value={p.issuer} />
              <Copy label={d.ltiAuthUrl} value={p.authUrl} />
              <Copy label={d.ltiTokenUrl} value={p.tokenUrl} />
              <Copy label={d.ltiJwksUrl} value={p.jwksUrl} />
              <p className="muted" style={{ margin: 0 }}>{d.toolsServicesHint}</p>
            </section>

            <section className="card stack">
              <h2 style={{ margin: 0, fontSize: 22 }}>{d.toolsRegistered}</h2>
              {tools.length === 0 && <p className="empty">{d.toolsNone}</p>}
              {tools.map((t) => (
                <div key={t.id} className="card stack" style={{ gap: 8 }}>
                  <b>{t.name}</b>
                  <Copy label={d.ltiClientId} value={t.clientId} />
                  <Copy label={d.toolDeploymentId} value={t.id} />
                  <p className="muted" style={{ margin: 0, fontSize: 14, overflowWrap: "anywhere" }}>
                    {d.toolLoginUrl}: {t.loginUrl} · {d.toolLaunchUrl}: {t.launchUrl}{t.deepLinkUrl ? ` · ${d.toolDeepLinkUrl}: ${t.deepLinkUrl}` : ""}
                  </p>
                  <form action={act} className="row" style={{ alignItems: "flex-end" }}>
                    <input type="hidden" name="toolId" value={t.id} />
                    <div className="fieldset" style={{ flex: "1 1 200px" }}>
                      <label htmlFor={`td-${t.id}`}>{d.toolTeacherData}</label>
                      <ShareSelect id={`td-${t.id}`} name="teacherData" value={t.teacherData} d={d} />
                    </div>
                    <div className="fieldset" style={{ flex: "1 1 200px" }}>
                      <label htmlFor={`sd-${t.id}`}>{d.toolStudentData}</label>
                      <ShareSelect id={`sd-${t.id}`} name="studentData" value={t.studentData} d={d} />
                    </div>
                    <button className="btn" name="op" value="privacy">{d.save}</button>
                    <button className="btn btn-sm" name="op" value="remove">{d.ltiRemove}</button>
                  </form>
                </div>
              ))}
              {e && <p className="notice" role="alert">{d[e as Key] ?? e}</p>}
              <form action={act} className="stack">
                <h3 style={{ margin: 0, fontSize: 18 }}>{d.toolsAdd}</h3>
                {([
                  ["name", d.name, true],
                  ["clientId", d.toolClientIdField, false],
                  ["loginUrl", d.toolLoginUrl, true],
                  ["launchUrl", d.toolLaunchUrl, true],
                  ["deepLinkUrl", d.toolDeepLinkUrl, false],
                  ["jwksUrl", d.toolJwksUrl, true],
                  ["redirectUris", d.toolRedirects, false],
                ] as const).map(([name, label, required]) => (
                  <div className="fieldset" key={name}>
                    <label htmlFor={`tool-${name}`}>{label}</label>
                    <input id={`tool-${name}`} name={name} className="field" required={required} maxLength={name === "redirectUris" ? 2000 : 500} />
                  </div>
                ))}
                <div className="row">
                  <div className="fieldset" style={{ flex: "1 1 200px" }}>
                    <label htmlFor="new-td">{d.toolTeacherData}</label>
                    <ShareSelect id="new-td" name="teacherData" value="name_email" d={d} />
                  </div>
                  <div className="fieldset" style={{ flex: "1 1 200px" }}>
                    <label htmlFor="new-sd">{d.toolStudentData}</label>
                    <ShareSelect id="new-sd" name="studentData" value="none" d={d} />
                  </div>
                </div>
                <p className="muted" style={{ margin: 0 }}>{d.toolPrivacyHint}</p>
                <div><button className="btn btn-primary" name="op" value="add">{d.toolsRegister}</button></div>
              </form>
            </section>
          </>
        )}
      </main>
    </>
  );
}
