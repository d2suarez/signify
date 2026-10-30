import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireMe } from "@/lib/auth";
import { courseAccess, ctx, lang } from "@/lib/access";
import { addCategory, deleteCategory, isWeighted, listCategories, setWeighted, updateCategory, MAX_DROP } from "@/lib/grades";
import {
  addStandard, archiveStandard, courseGrading, listStandards, moveStandard, saveStandardsSettings, setGradingMode, updateStandard, STANDARD_LIMITS,
} from "@/lib/standards";
import { dict } from "@/lib/i18n";
import StandardsSettingsForm from "@/components/StandardsSettingsForm";
import { courseSetup, setCourseBand, setCoursePolicy } from "@/lib/school-grading";
import { gpaText } from "@/lib/grade-scale";
import { LATE_KINDS, ruleText, type LateKind } from "@/lib/late-policy";
import { TopBar } from "@/components/TopBar";
import { CourseNav } from "@/components/CourseNav";

export const dynamic = "force-dynamic";

async function act(formData: FormData) {
  "use server";
  const access = await courseAccess(String(formData.get("courseId") || ""));
  if (!access || access.course.role !== "teacher") return;
  const c = ctx(access.me), courseId = access.course.id;
  const op = String(formData.get("op") || "");
  if (op === "method") {
    const m = formData.get("method");
    // Standards keep the points method's own setting, so switching back restores it.
    await setGradingMode(c, courseId, m === "standards" ? "standards" : "points");
    if (m !== "standards") await setWeighted(c, courseId, m === "weighted");
  }
  const sid = String(formData.get("standardId") || "");
  if (op === "std-add") await addStandard(c, courseId, formData.get("code"), formData.get("description"), formData.get("externalId"));
  if (op === "std-update") await updateStandard(c, courseId, sid, formData.get("code"), formData.get("description"), formData.get("externalId"));
  if (op === "std-archive") await archiveStandard(c, courseId, sid, true);
  if (op === "std-restore") await archiveStandard(c, courseId, sid, false);
  if (op === "std-up" || op === "std-down") await moveStandard(c, courseId, sid, op === "std-up" ? -1 : 1);
  if (op === "sbg-settings") {
    let raw: unknown = null;
    try { raw = JSON.parse(String(formData.get("settings") || "null")); } catch { /* cleaned to the defaults */ }
    await saveStandardsSettings(c, courseId, raw);
  }
  if (op === "add") await addCategory(c, courseId, formData.get("name"), formData.get("weight"), formData.get("drop"));
  if (op === "update") await updateCategory(c, courseId, String(formData.get("categoryId")), formData.get("name"), formData.get("weight"), formData.get("drop"));
  if (op === "delete") await deleteCategory(c, courseId, String(formData.get("categoryId")));
  if (op === "band") await setCourseBand(c, courseId, String(formData.get("band") || "") || null);
  if (op === "late") {
    const own = formData.get("lateMode") === "own";
    const r = await setCoursePolicy(c, courseId, own
      ? { kind: formData.get("kind"), percent: formData.get("percent"), max: formData.get("max") }
      : null);
    if (!r.ok) redirect(`/courses/${courseId}/settings?late=${r.reason}#late`);
  }
  revalidatePath(`/courses/${courseId}/settings`);
}

export default async function SettingsPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ late?: string }>;
}) {
  await requireMe();
  const { id } = await params;
  const { late: lateError } = await searchParams;
  const d = dict(await lang());
  const access = await courseAccess(id);
  if (!access || access.course.role !== "teacher") notFound();
  const { me, course } = access;
  const [weighted, categories, grading, standards, setup] = await Promise.all([
    isWeighted(ctx(me), course.id), listCategories(ctx(me), course.id), courseGrading(ctx(me), course.id),
    listStandards(ctx(me), course.id, { withArchived: true }), courseSetup(ctx(me), course.id),
  ]);
  const own = setup.coursePolicy;
  const limits = setup.late.limits;
  // The school's policies that can apply in this band, in words.
  const schoolRules = setup.late.rules.filter((r) => !r.bands.length || r.bands.includes(setup.band.id));
  const sbg = grading.mode === "standards";
  const live = standards.filter((s) => !s.archived), archived = standards.filter((s) => s.archived);
  const total = categories.reduce((n, c) => n + c.weight, 0);

  return (
    <>
      <TopBar crumbs={<><Link href="/">{d.myCourses}</Link> · <Link href={`/courses/${course.id}`}>{course.name}</Link></>} />
      <main className="page stack" style={{ maxWidth: 860 }}>
        <h1 style={{ fontSize: 34 }}>{course.name}</h1>
        <CourseNav courseId={course.id} current="settings" d={d} />

        <form action={act} className="card stack" style={{ gap: 10 }}>
          <input type="hidden" name="courseId" value={course.id} />
          <input type="hidden" name="op" value="method" />
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="label" style={{ marginBottom: 10 }}>{d.gradingMethod}</legend>
            <label className="check" style={{ fontSize: 15 }}><input type="radio" name="method" value="points" defaultChecked={!sbg && !weighted} /> {d.byPoints}</label>
            <br />
            <label className="check" style={{ fontSize: 15, marginTop: 6 }}><input type="radio" name="method" value="weighted" defaultChecked={!sbg && weighted} /> {d.byWeight}</label>
            <br />
            <label className="check" style={{ fontSize: 15, marginTop: 6 }}><input type="radio" name="method" value="standards" defaultChecked={sbg} aria-describedby="sbg-hint" /> {d.byStandards}</label>
            <p id="sbg-hint" className="muted" style={{ fontSize: 13, margin: "6px 0 0" }}>{d.byStandardsHint}</p>
          </fieldset>
          <button className="btn btn-primary" style={{ alignSelf: "flex-start" }}>{d.save}</button>
        </form>

        {sbg && (
          <section className="card" aria-labelledby="stds">
            <h2 className="label" id="stds">{d.standards}</h2>
            <p className="muted" style={{ fontSize: 13, margin: "6px 0 0" }}>{d.standardsHint}</p>
            <ul className="list" style={{ marginTop: 8 }}>
              {live.map((s, i) => (
                <li key={s.id}>
                  <form action={act} className="row grow">
                    <input type="hidden" name="courseId" value={course.id} />
                    <input type="hidden" name="standardId" value={s.id} />
                    <input name="code" className="field" style={{ width: 120 }} defaultValue={s.code} maxLength={STANDARD_LIMITS.code} aria-label={d.standardCode} required />
                    <input name="description" className="field" style={{ flex: "1 1 240px", width: "auto" }} defaultValue={s.description} maxLength={STANDARD_LIMITS.description} aria-label={d.standardDescription} />
                    <input name="externalId" className="field" style={{ width: 150 }} defaultValue={s.externalId ?? ""} maxLength={STANDARD_LIMITS.externalId} aria-label={d.caseId} placeholder={d.caseId} />
                    <button className="btn btn-sm" name="op" value="std-update">{d.save}</button>
                    <button className="btn btn-sm" name="op" value="std-up" disabled={i === 0} aria-label={`${d.moveUp}: ${s.code}`}>↑</button>
                    <button className="btn btn-sm" name="op" value="std-down" disabled={i === live.length - 1} aria-label={`${d.moveDown}: ${s.code}`}>↓</button>
                    <button className="btn btn-sm" name="op" value="std-archive">{d.archive}</button>
                  </form>
                </li>
              ))}
              <li>
                <form action={act} className="row grow">
                  <input type="hidden" name="courseId" value={course.id} />
                  <input name="code" className="field" style={{ width: 120 }} placeholder={d.standardCode} maxLength={STANDARD_LIMITS.code} aria-label={d.standardCode} required />
                  <input name="description" className="field" style={{ flex: "1 1 240px", width: "auto" }} placeholder={d.standardDescription} maxLength={STANDARD_LIMITS.description} aria-label={d.standardDescription} />
                  <input name="externalId" className="field" style={{ width: 150 }} placeholder={d.caseId} maxLength={STANDARD_LIMITS.externalId} aria-label={d.caseId} />
                  <button className="btn btn-primary btn-sm" name="op" value="std-add">{d.addStandard}</button>
                </form>
              </li>
            </ul>
            {archived.length > 0 && (
              <details style={{ marginTop: 10 }}>
                <summary>{d.archivedStandards} ({archived.length})</summary>
                <ul className="list">
                  {archived.map((s) => (
                    <li key={s.id}>
                      <form action={act} className="row grow">
                        <input type="hidden" name="courseId" value={course.id} />
                        <input type="hidden" name="standardId" value={s.id} />
                        <span className="grow"><b>{s.code}</b> {s.description}</span>
                        <button className="btn btn-sm" name="op" value="std-restore">{d.restore}</button>
                      </form>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        )}
        {sbg && <StandardsSettingsForm courseId={course.id} initial={grading.settings} scale={setup.band.rows} action={act} d={d} />}

        {!sbg && <section className="card" aria-labelledby="cats">
          <p className="label" id="cats">{d.categories}</p>
          <ul className="list" style={{ marginTop: 8 }}>
            {categories.map((c) => (
              <li key={c.id}>
                <form action={act} className="row grow">
                  <input type="hidden" name="courseId" value={course.id} />
                  <input type="hidden" name="categoryId" value={c.id} />
                  <input name="name" className="field" style={{ flex: "1 1 200px", width: "auto" }} defaultValue={c.name} maxLength={60} aria-label={d.name} required />
                  <input name="weight" type="number" min={0} max={1000} step="any" className="field" style={{ width: 110 }} defaultValue={c.weight} aria-label={d.weight} />
                  <label className="row" style={{ gap: 6, fontSize: 14 }}>{d.dropLowest}
                    <input name="drop" type="number" min={0} max={MAX_DROP} step={1} className="field" style={{ width: 76 }} defaultValue={c.dropLowest} />
                  </label>
                  <button className="btn btn-sm" name="op" value="update">{d.save}</button>
                  <button className="btn btn-sm" name="op" value="delete">{d.delete}</button>
                </form>
              </li>
            ))}
            <li>
              <form action={act} className="row grow">
                <input type="hidden" name="courseId" value={course.id} />
                <input name="name" className="field" style={{ flex: "1 1 200px", width: "auto" }} placeholder={d.name} maxLength={60} aria-label={d.name} required />
                <input name="weight" type="number" min={0} max={1000} step="any" className="field" style={{ width: 110 }} placeholder={d.weight} aria-label={d.weight} />
                <label className="row" style={{ gap: 6, fontSize: 14 }}>{d.dropLowest}
                  <input name="drop" type="number" min={0} max={MAX_DROP} step={1} className="field" style={{ width: 76 }} defaultValue={0} />
                </label>
                <button className="btn btn-primary btn-sm" name="op" value="add">{d.addCategory}</button>
              </form>
            </li>
          </ul>
          {weighted && categories.length > 0 && (
            <p className="muted" style={{ fontSize: 13 }}>{d.weightsTotal} {total}%. {total !== 100 ? d.weightsScaled : ""}</p>
          )}
          <p className="muted" style={{ fontSize: 13 }}>{d.dropLowestHint}</p>
        </section>}

        <section className="card stack" style={{ gap: 8 }} aria-labelledby="scale-title">
          <h2 className="label" id="scale-title">{d.gradeScaleTitle}</h2>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>
            {setup.gradeLevels.length ? <>{d.idGradeLevels} {setup.gradeLevels.join(", ")}</> : d.noIdGradeLevels}
          </p>
          <form action={act} className="row" style={{ alignItems: "flex-end" }}>
            <input type="hidden" name="courseId" value={course.id} />
            <div className="fieldset" style={{ margin: 0 }}>
              <label htmlFor="band">{d.gradeScaleTitle}</label>
              <select id="band" name="band" className="field" defaultValue={setup.pickedBand ?? ""}>
                <option value="">{d.bandAuto}</option>
                {setup.scales.bands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
            <button className="btn" name="op" value="band">{d.save}</button>
          </form>
          <p style={{ margin: 0, fontSize: 14 }}>{d.usingScale}: <b>{setup.band.name}</b></p>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {setup.band.rows.map((r, i) => (
              <span key={r.letter}>{i ? " · " : ""}<span style={{ whiteSpace: "nowrap" }}>{r.letter} {r.min}{r.gpa === null ? "" : ` (${gpaText(r.gpa)})`}</span></span>
            ))}
          </p>
        </section>

        {!sbg && <section className="card stack" style={{ gap: 8 }} aria-labelledby="late-title" id="late">
          <h2 className="label" id="late-title">{d.lateCourseTitle}</h2>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>{d.schoolLateHere}:</p>
          {schoolRules.length === 0 ? <p style={{ margin: 0, fontSize: 14 }}>{d.noLateRules}</p> : (
            <ul style={{ margin: 0, paddingLeft: 20, fontSize: 14 }}>
              {schoolRules.map((r) => (
                <li key={r.id}>
                  {r.name ? <b>{r.name}: </b> : null}{ruleText(r, d)}
                  {(r.categories.length > 0 || r.kinds.length > 0) && (
                    <span className="muted"> · {[...r.categories, ...r.kinds.map((k) => d[`workKind_${k}`])].join(", ")}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {setup.late.teachers === "no" ? <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.lateNotAllowed}</p> : (
            <form action={act} className="stack" style={{ gap: 8 }}>
              <input type="hidden" name="courseId" value={course.id} />
              {lateError && <p className="notice notice-bad" role="alert" style={{ margin: 0 }}>{lateError === "notAllowed" ? d.lateNotAllowed : d.lateOutsideLimits}</p>}
              {setup.late.teachers === "within" && (
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                  {d.lateLimitsAre.replace("{min}", String(limits.minPercent)).replace("{max}", String(limits.maxPercent)).replace("{cap}", String(limits.maxCap))}
                </p>
              )}
              <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="sr-only">{d.lateCourseTitle}</legend>
                <label className="row" style={{ gap: 8, minHeight: 44 }}><input type="radio" name="lateMode" value="school" defaultChecked={!own} /> {d.useSchoolLate}</label>
                <label className="row" style={{ gap: 8, minHeight: 44 }}><input type="radio" name="lateMode" value="own" defaultChecked={!!own} /> {d.ownLate}</label>
              </fieldset>
              <div className="row" style={{ alignItems: "flex-end" }}>
                <div className="fieldset" style={{ margin: 0 }}>
                  <label htmlFor="late-kind">{d.latePenalty}</label>
                  <select id="late-kind" name="kind" className="field" defaultValue={own?.kind ?? "perDay"}>
                    {LATE_KINDS.map((k: LateKind) => <option key={k} value={k}>{d[`lateKind_${k}`]}</option>)}
                  </select>
                </div>
                <div className="fieldset" style={{ margin: 0 }}>
                  <label htmlFor="late-pct">{d.percentOff}</label>
                  <input id="late-pct" name="percent" type="number" min={0} max={100} step="any" className="field" style={{ width: 110 }} defaultValue={own?.percent ?? 10} />
                </div>
                <div className="fieldset" style={{ margin: 0 }}>
                  <label htmlFor="late-max">{d.atMostPercent}</label>
                  <input id="late-max" name="max" type="number" min={0} max={100} step="any" className="field" style={{ width: 110 }} defaultValue={own?.max || 50} />
                </div>
                <button className="btn" name="op" value="late">{d.save}</button>
              </div>
              {own && <p style={{ margin: 0, fontSize: 14 }}>{d.usingScale}: <b>{ruleText(own, d)}</b></p>}
            </form>
          )}
        </section>}

        <section className="card stack" style={{ gap: 6 }} aria-labelledby="import-title">
          <h2 className="label" id="import-title">{d.importCourse}</h2>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>{d.importCourseHint}</p>
          <Link className="btn" style={{ alignSelf: "flex-start" }} href={`/courses/${course.id}/import`}>{d.importChoose}</Link>
        </section>
      </main>
    </>
  );
}
