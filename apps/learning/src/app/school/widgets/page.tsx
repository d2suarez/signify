import Link from "next/link";
import { requireMe } from "@/lib/auth";
import { isSchoolAdmin, lang } from "@/lib/access";
import { dict } from "@/lib/i18n";
import { schoolWidgets, settingHistory } from "@/lib/school-grading";
import { TopBar } from "@/components/TopBar";
import { When } from "@/components/When";
import { RestoreWidgets, SchoolWidgetsEditor } from "@/components/SchoolWidgets";

export const dynamic = "force-dynamic";

/** The school's Desk tools in the left rail: defaults and what students may have. Everyone can see it; admins change it. */
export default async function SchoolWidgetsPage() {
  const me = await requireMe();
  const L = await lang();
  const d = dict(L);
  const admin = isSchoolAdmin(me);
  const [setting, history] = await Promise.all([schoolWidgets(me.tenantId), settingHistory(me.tenantId, "widgets")]);
  const names = (k: string[]) => (k.length ? k.map((x) => (d as Record<string, string>)[`wg_${x}`] ?? x).join(", ") : d.wgEmptyList);
  return (
    <>
      <TopBar crumbs={<><Link href="/">{d.myCourses}</Link> · {me.tenantName}</>} />
      <main className="page stack" style={{ maxWidth: 900 }}>
        <h1 style={{ fontSize: 34 }}>{d.wgSchoolTitle}</h1>
        <p className="muted" style={{ margin: 0 }}>{d.wgSchoolHint}</p>
        {!admin && <p className="notice">{d.onlyAdminsGrading}</p>}
        <SchoolWidgetsEditor initial={setting.value} version={setting.version} canEdit={admin} d={d} />
        <section className="card stack" aria-labelledby="wg-history">
          <h2 className="label" id="wg-history">{d.earlierVersions}</h2>
          {history.length === 0 ? <p className="empty" style={{ margin: 0 }}>{d.noEarlierVersions}</p> : (
            <ul className="list">
              {history.map((h) => (
                <li key={h.id}>
                  <span className="grow">
                    {d.versionWord} {h.version} · <When iso={h.changedAt} lang={L} />
                    <span className="muted" style={{ display: "block", fontSize: 13 }}>
                      {d.wgSchoolStaffHome}: {names(h.value.staffHome)} · {d.wgSchoolStaffClass}: {names(h.value.staffClass)} · {d.wgSchoolStudentHome}: {names(h.value.studentHome)} · {d.wgSchoolStudentClass}: {names(h.value.studentClass)} · {d.wgSchoolAllowed}: {names(h.value.studentAllowed)}
                    </span>
                  </span>
                  {admin && <RestoreWidgets versionId={h.id} baseVersion={setting.version} d={d} />}
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}
