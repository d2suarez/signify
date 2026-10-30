import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireMe, readMe } from "@/lib/auth";
import { isSchoolAdmin, lang, standardsViewer } from "@/lib/access";
import {
  createFramework, ensureLibrary, listFrameworks, saveSchoolStandards, schoolSets, schoolStandards, setSchoolSet,
} from "@/lib/standards-library";
import { defaultSettings } from "@/lib/standards-math";
import { schoolScales } from "@/lib/school-grading";
import { LEGACY_SCALE } from "@/lib/grade-scale";
import { dict } from "@/lib/i18n";
import { TopBar } from "@/components/TopBar";
import StandardsSettingsForm from "@/components/StandardsSettingsForm";
import { FrameworkInfo } from "@/components/FrameworkInfo";

export const dynamic = "force-dynamic";

async function act(formData: FormData) {
  "use server";
  const me = await readMe();
  if (!me || !isSchoolAdmin(me)) return;
  const v = await standardsViewer(me);
  if (!v) return;
  const op = String(formData.get("op") || "");
  if (op === "sbg-settings") {
    let raw: unknown = null;
    try { raw = JSON.parse(String(formData.get("settings") || "null")); } catch { /* cleaned to the defaults */ }
    await saveSchoolStandards(v, { settings: raw ?? defaultSettings() });
  }
  if (op === "sbg-reset") await saveSchoolStandards(v, { settings: null });
  if (op === "allow") {
    await saveSchoolStandards(v, { teacherFrameworks: formData.get("teacherFrameworks") === "on", courseSettings: formData.get("courseSettings") === "on" });
  }
  if (op === "set-on" && formData.get("accept") === "on") await setSchoolSet(v, String(formData.get("key") || ""), true);
  if (op === "set-off") await setSchoolSet(v, String(formData.get("key") || ""), false);
  if (op === "new") {
    const f = await createFramework(v, "school", { title: formData.get("title"), subject: formData.get("subject") });
    if (f) redirect(`/standards/${f.id}`);
  }
  revalidatePath("/school/standards");
}

/**
 * The school's standards: what teachers may do, the default proficiency
 * scale and conversion for standards-based courses, published sets that
 * need the school's agreement to their terms, and the school's own sets.
 */
export default async function SchoolStandardsPage() {
  const me = await requireMe();
  const d = dict(await lang());
  const admin = isSchoolAdmin(me);
  if (!admin) {
    return (
      <>
        <TopBar crumbs={<><Link href="/">{d.myCourses}</Link> · {me.tenantName}</>} />
        <main className="page stack" style={{ maxWidth: 760 }}><h1 style={{ fontSize: 34 }}>{d.schoolStandards}</h1><p className="notice">{d.onlyAdmins}</p></main>
      </>
    );
  }
  await ensureLibrary();
  const v = (await standardsViewer(me))!;
  const [school, sets, frameworks, scales] = await Promise.all([schoolStandards(me.tenantId), schoolSets(), listFrameworks(v), schoolScales(me.tenantId)]);
  // Letters in the conversion table follow the school's first grade band.
  const letters = scales.value.bands[0]?.rows ?? LEGACY_SCALE;
  const own = frameworks.filter((f) => f.ownerKind === "school");

  return (
    <>
      <TopBar crumbs={<><Link href="/">{d.myCourses}</Link> · {me.tenantName}</>} />
      <main className="page stack" style={{ maxWidth: 900 }}>
        <div className="row">
          <h1 style={{ fontSize: 34 }} className="grow">{d.schoolStandards}</h1>
          <Link className="btn" href="/standards">{d.standardsLibrary}</Link>
        </div>
        <p className="muted" style={{ margin: 0 }}>{d.schoolStandardsHint}</p>

        <form action={act} className="card stack" style={{ gap: 8 }}>
          <input type="hidden" name="op" value="allow" />
          <h2 className="label">{d.stdWhatTeachersMay}</h2>
          <label className="check" style={{ whiteSpace: "normal" }}><input type="checkbox" name="teacherFrameworks" defaultChecked={school.teacherFrameworks} /> {d.stdAllowTeacherSets}</label>
          <label className="check" style={{ whiteSpace: "normal" }}><input type="checkbox" name="courseSettings" defaultChecked={school.courseSettings} /> {d.stdAllowCourseSettings}</label>
          <button className="btn btn-primary" style={{ alignSelf: "flex-start" }}>{d.save}</button>
        </form>

        <section className="stack" style={{ gap: 8 }} aria-labelledby="sbg-default">
          <h2 id="sbg-default" className="label">{d.stdSchoolScale}</h2>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>{school.settings ? d.stdSchoolScaleOwn : d.stdSchoolScaleBuiltIn}</p>
          <StandardsSettingsForm courseId="" initial={school.settings ?? defaultSettings()} scale={letters} action={act} d={d} />
          {school.settings && (
            <form action={act}><input type="hidden" name="op" value="sbg-reset" /><button className="btn btn-sm">{d.stdBackToBuiltIn}</button></form>
          )}
        </section>

        <section className="stack" style={{ gap: 8 }} aria-labelledby="sets">
          <h2 id="sets" className="label">{d.stdSetsNeedingTerms}</h2>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.stdSetsNeedingTermsHint}</p>
          {sets.length === 0 && <p className="empty">{d.stdNoneSchool}</p>}
          {sets.map((f) => {
            const on = !!f.key && school.enabledSets.includes(f.key);
            return (
              <div key={f.id} className="card stack" style={{ gap: 6 }}>
                <h3 lang={f.language} style={{ margin: 0 }}>{f.title} {on && <span className="chip">{d.stdOn}</span>}</h3>
                <FrameworkInfo f={f} d={d} />
                <form action={act} className="stack" style={{ gap: 6 }}>
                  <input type="hidden" name="key" value={f.key ?? ""} />
                  {on ? (
                    <button className="btn btn-sm" name="op" value="set-off" style={{ alignSelf: "flex-start" }}>{d.stdTurnOff}</button>
                  ) : (
                    <>
                      <label className="check" style={{ whiteSpace: "normal" }}><input type="checkbox" name="accept" required /> {d.stdAcceptTerms}</label>
                      <button className="btn btn-primary btn-sm" name="op" value="set-on" style={{ alignSelf: "flex-start" }}>{d.stdTurnOn}</button>
                    </>
                  )}
                </form>
              </div>
            );
          })}
        </section>

        <section className="card stack" style={{ gap: 8 }} aria-labelledby="own">
          <h2 id="own" className="label">{d.stdSchoolSets}</h2>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.stdSchoolSetsHint}</p>
          {own.length === 0 && <p className="empty">{d.stdNoneSchool}</p>}
          <ul className="list">
            {own.map((f) => (
              <li key={f.id}><Link className="grow" href={`/standards/${f.id}`}>{f.title}</Link> <span className="muted">{f.itemCount} {d.stdItemsWord}</span></li>
            ))}
          </ul>
          <form action={act} className="row" style={{ alignItems: "flex-end" }}>
            <input type="hidden" name="op" value="new" />
            <div className="fieldset" style={{ flex: "2 1 240px" }}>
              <label htmlFor="nt">{d.stdNewTitle}</label>
              <input id="nt" name="title" className="field" maxLength={200} required />
            </div>
            <div className="fieldset" style={{ flex: "1 1 160px" }}>
              <label htmlFor="ns">{d.stdSubject}</label>
              <input id="ns" name="subject" className="field" maxLength={60} />
            </div>
            <button className="btn btn-primary">{d.stdNewSchoolSet}</button>
          </form>
        </section>
      </main>
    </>
  );
}
