import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireMe } from "@/lib/auth";
import { academicAccess as courseAccess, ctx, lang } from "@/lib/access";
import { addCategory, deleteCategory, isWeighted, listCategories, setWeighted, updateCategory, MAX_DROP } from "@/lib/grades";
import { courseGrading, saveStandardsSettings, setGradingMode } from "@/lib/standards";
import { levelLabel, levelWords } from "@/lib/standards-math";
import { letterFor } from "@/lib/grade-math";
import { dict } from "@/lib/i18n";
import StandardsSettingsForm from "@/components/StandardsSettingsForm";
import { courseSetup, setCoursePolicy } from "@/lib/school-grading";
import { gpaText } from "@/lib/grade-scale";
import { LATE_KINDS, ruleText, type LateKind } from "@/lib/late-policy";
import { TopBar } from "@/components/TopBar";
import { ClassHeader } from "@/components/ClassHeader";
import ClassPicture from "@/components/ClassPicture";

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
  if (op === "sbg-settings") {
    let raw: unknown = null;
    try { raw = JSON.parse(String(formData.get("settings") || "null")); } catch { /* cleaned to the defaults */ }
    await saveStandardsSettings(c, courseId, raw ?? {});
  }
  if (op === "sbg-follow-school") await saveStandardsSettings(c, courseId, null);
  if (op === "add") await addCategory(c, courseId, formData.get("name"), formData.get("weight"), formData.get("drop"));
  if (op === "update") await updateCategory(c, courseId, String(formData.get("categoryId")), formData.get("name"), formData.get("weight"), formData.get("drop"));
  if (op === "delete") await deleteCategory(c, courseId, String(formData.get("categoryId")));
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
  const [weighted, categories, grading, setup] = await Promise.all([
    isWeighted(ctx(me), course.id), listCategories(ctx(me), course.id), courseGrading(ctx(me), course.id), courseSetup(ctx(me), course.id),
  ]);
  const own = setup.coursePolicy;
  const limits = setup.late.limits;
  // The school's policies that can apply in this band, in words.
  const schoolRules = setup.late.rules.filter((r) => !r.bands.length || r.bands.includes(setup.band.id));
  const sbg = grading.mode === "standards";
  const total = categories.reduce((n, c) => n + c.weight, 0);

  return (
    <>
      <TopBar crumbs={<Link href="/">{d.myCourses}</Link>} below={<ClassHeader course={course} d={d} tab="settings" heading />} />
      <main className="page stack" style={{ maxWidth: 860 }}>
        <section className="card stack" aria-labelledby="cp-title" style={{ gap: 10 }} id="picture">
          <h2 id="cp-title" className="label">{d.cpTitle}</h2>
          <div className="row" style={{ gap: 14, alignItems: "center", flexWrap: "wrap" }}>
            <div className="class-pic" style={{ width: 72, height: 72 }}>
              {course.pictureFileId
                // eslint-disable-next-line @next/next/no-img-element -- our own checked file
                ? <img src={`/files/${course.pictureFileId}`} alt={d.cpTitle} />
                : <span className="class-pic-none" aria-hidden="true">{(course.name.trim()[0] || "?").toUpperCase()}</span>}
            </div>
            <ClassPicture courseId={course.id} has={!!course.pictureFileId}
              w={{ cpChange: d.cpChange, cpAdd: d.cpAdd, cpRemove: d.cpRemove, cpBusy: d.cpBusy, cpFailed: d.cpFailed, cpRefused: d.cpRefused, cpOff: d.cpOff, cpHint: d.cpHint }} />
          </div>
        </section>

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

        <section className="card" aria-labelledby="stds">
          <div className="row">
            <h2 className="label grow" id="stds">{d.standards}</h2>
            <Link className="btn btn-sm" href={`/courses/${course.id}/standards`}>{d.csOpenTab}</Link>
          </div>
          <p className="muted" style={{ fontSize: 13, margin: "6px 0 0" }}>{sbg ? d.standardsHint : d.standardsHintPoints} {d.csMovedHint}</p>
        </section>
        {sbg && (
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>
            {grading.source === "course" ? d.stdSourceCourse : grading.source === "school" ? d.stdSourceSchool : d.stdSourceDefault}
            {grading.source === "course" && (
              <form action={act} style={{ display: "inline", marginLeft: 8 }}>
                <input type="hidden" name="courseId" value={course.id} />
                <button className="btn btn-sm" name="op" value="sbg-follow-school">{d.stdFollowSchool}</button>
              </form>
            )}
          </p>
        )}
        {sbg && grading.courseSettingsAllowed && <StandardsSettingsForm courseId={course.id} initial={grading.settings} scale={setup.band.rows} action={act} d={d} />}
        {sbg && !grading.courseSettingsAllowed && (
          <section className="card stack" style={{ gap: 6 }} aria-labelledby="school-scale">
            <h2 id="school-scale" className="label">{d.proficiencyScale}</h2>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.stdSchoolSetsScale}</p>
            <ul className="list">
              {grading.settings.labels.map((_, k) => {
                const level = grading.settings.labels.length - k;
                return <li key={level}>{level} · {levelLabel(grading.settings, level, levelWords(d))}</li>;
              })}
            </ul>
            <table className="conv-table">
              <thead><tr><th scope="col">{d.averageAtLeast}</th><th scope="col">{d.percentWord}</th><th scope="col">{d.grade}</th></tr></thead>
              <tbody>{grading.settings.conversion.map((r) => <tr key={r.min}><td>{r.min}</td><td>{r.percent}</td><td>{letterFor(r.percent, setup.band.rows)}</td></tr>)}</tbody>
            </table>
          </section>
        )}

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
          {/* The school's scale for this class, read-only: only school admins change scales (/school/grading). */}
          <p style={{ margin: 0, fontSize: 14 }}>{d.usingScale}: <b>{setup.band.name}</b></p>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {setup.bandFrom === "grades" ? <>{d.idGradeLevels} {setup.gradeLevels.join(", ")}. {d.scaleFromGrades}</> : d.noIdGradeLevels}
          </p>
          <div className="gb-scroll" style={{ position: "relative" }}>
            <table className="gb-table scale-table" style={{ width: "auto" }}>
              <caption className="sr-only">{d.scaleTableCaption.replace("{band}", setup.band.name)}</caption>
              <thead><tr><th scope="col" style={{ textAlign: "left" }}>{d.scaleLetter}</th><th scope="col">{d.scaleFrom}</th><th scope="col">{d.scaleGpa}</th></tr></thead>
              <tbody>
                {setup.band.rows.map((r, i) => (
                  <tr key={r.letter}>
                    <th scope="row" style={{ textAlign: "left", color: "var(--ink)", fontSize: 15 }}>{r.letter}</th>
                    <td style={{ textAlign: "right" }}>{i === setup.band.rows.length - 1 ? `${r.min}%` : `${r.min}% +`}</td>
                    <td style={{ textAlign: "right" }}>{r.gpa === null ? "—" : gpaText(r.gpa)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {d.scaleSchoolSets} <Link href="/school/grading">{d.gradingSetupLink}</Link> · <Link href="/school/periods">{d.periods}</Link>
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
