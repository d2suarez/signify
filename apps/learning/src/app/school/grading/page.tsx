import Link from "next/link";
import { requireMe } from "@/lib/auth";
import { isSchoolAdmin, lang } from "@/lib/access";
import { dict } from "@/lib/i18n";
import { schoolLate, schoolScales, settingHistory } from "@/lib/school-grading";
import { ruleText } from "@/lib/late-policy";
import { TopBar } from "@/components/TopBar";
import { When } from "@/components/When";
import { LateEditor, RestoreButton, ScalesEditor } from "@/components/SchoolGrading";

export const dynamic = "force-dynamic";

/** The school's grade scales and late policies. Everyone can see them; admins change them. */
export default async function SchoolGradingPage() {
  const me = await requireMe();
  const L = await lang();
  const d = dict(L);
  const admin = isSchoolAdmin(me);
  const [scales, late, scaleHistory, lateHistory] = await Promise.all([
    schoolScales(me.tenantId), schoolLate(me.tenantId), settingHistory(me.tenantId, "scales"), settingHistory(me.tenantId, "late"),
  ]);

  return (
    <>
      <TopBar crumbs={<><Link href="/">{d.myCourses}</Link> · {me.tenantName} · <Link href="/school/periods">{d.periods}</Link></>} />
      <main className="page stack" style={{ maxWidth: 900 }}>
        <h1 style={{ fontSize: 34 }}>{d.gradingSetup}</h1>
        <p className="muted" style={{ margin: 0 }}>{d.gradingSetupHint}</p>
        {!admin && <p className="notice">{d.onlyAdminsGrading}</p>}

        <section className="card stack" aria-labelledby="scales-title">
          <h2 className="label" id="scales-title">{d.scalesTitle}</h2>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>{d.scalesHint}</p>
          <ScalesEditor initial={scales.value} version={scales.version} canEdit={admin} d={d} />
          <details>
            <summary>{d.earlierVersions}</summary>
            {scaleHistory.length === 0 ? <p className="empty">{d.noEarlierVersions}</p> : (
              <ul className="list">
                {scaleHistory.map((h) => (
                  <li key={h.id}>
                    <span className="grow">
                      {d.versionWord} {h.version} · <When iso={h.changedAt} lang={L} />
                      <span className="muted" style={{ display: "block", fontSize: 13 }}>
                        {h.value.bands.map((b) => `${b.name}: ${b.rows.map((r) => `${r.letter} ${r.min}`).join(", ")}`).join(" · ")}
                      </span>
                    </span>
                    {admin && <RestoreButton settingKey="scales" versionId={h.id} baseVersion={scales.version} d={d} />}
                  </li>
                ))}
              </ul>
            )}
          </details>
        </section>

        <section className="card stack" aria-labelledby="late-title">
          <h2 className="label" id="late-title">{d.lateTitle}</h2>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>{d.lateHint}</p>
          <LateEditor initial={late.value} version={late.version} bands={scales.value.bands.map((b) => ({ id: b.id, name: b.name }))} canEdit={admin} d={d} />
          <details>
            <summary>{d.earlierVersions}</summary>
            {lateHistory.length === 0 ? <p className="empty">{d.noEarlierVersions}</p> : (
              <ul className="list">
                {lateHistory.map((h) => (
                  <li key={h.id}>
                    <span className="grow">
                      {d.versionWord} {h.version} · <When iso={h.changedAt} lang={L} />
                      <span className="muted" style={{ display: "block", fontSize: 13 }}>
                        {h.value.rules.length ? h.value.rules.map((r) => `${r.name ? `${r.name}: ` : ""}${ruleText(r, d)}`).join(" · ") : d.noLateRules}
                        {" · "}{d[`teachersLate_${h.value.teachers}`]}
                      </span>
                    </span>
                    {admin && <RestoreButton settingKey="late" versionId={h.id} baseVersion={late.version} d={d} />}
                  </li>
                ))}
              </ul>
            )}
          </details>
        </section>
      </main>
    </>
  );
}
