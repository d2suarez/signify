import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireMe, readMe } from "@/lib/auth";
import { ctx, lang, isSchoolAdmin, standardsViewer } from "@/lib/access";
import { getCatalog } from "@/lib/sections";
import { ensureLibrary, listFrameworks, type Viewer } from "@/lib/standards-library";
import { addCourseSet, listCourseSets, mayChooseCourseSets, removeCourseSet, setParts, COURSE_SET_LIMITS } from "@/lib/course-standards";
import { dict } from "@/lib/i18n";
import { TopBar } from "@/components/TopBar";
import { Notices } from "@/components/FrameworkInfo";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f-]{36}$/i;

async function viewerOf(): Promise<Viewer | null> {
  const me = await readMe();
  return me ? standardsViewer(me) : null;
}

async function act(formData: FormData) {
  "use server";
  const v = await viewerOf();
  const catalogId = String(formData.get("catalogId") || "");
  if (!v || !UUID.test(catalogId)) return;
  const op = String(formData.get("op") || "");
  if (op === "add") {
    const r = await addCourseSet(v, catalogId, { frameworkId: formData.get("frameworkId"), partId: formData.get("partId"), grades: formData.getAll("grade").map(String) });
    redirect(`/catalog/${catalogId}/standards?r=${r}`);
  }
  if (op === "remove") await removeCourseSet(v, catalogId, String(formData.get("setId") || ""));
  redirect(`/catalog/${catalogId}/standards`);
}

/**
 * A course's standards (Desmond, 2026-11-23): the sets every class of the
 * course gets. A school admin, or a teacher of the course when the school
 * allows. Step 1 picks a set; step 2 (?set=) narrows it to a part and/or
 * grades. Anyone who teaches or taught a section may look.
 */
export default async function CourseStandardSets({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ set?: string; r?: string; back?: string }> }) {
  const me = await requireMe();
  const { id } = await params;
  const sp = await searchParams;
  const d = dict(await lang());
  const course = await getCatalog(ctx(me), id);
  const admin = isSchoolAdmin(me);
  if (!course || (!admin && !course.sections.some((s) => s.mine))) notFound();
  const v = await viewerOf();
  await ensureLibrary();
  const may = !!v && await mayChooseCourseSets(v, course.id);
  const sets = await listCourseSets(ctx(me), course.id);
  const frameworks = may && v ? (await listFrameworks(v)).filter((f) => !f.courseId && !f.superseded) : [];
  const chosen = sp.set && UUID.test(sp.set) ? frameworks.find((f) => f.id === sp.set) ?? null : null;
  const parts = chosen && v ? await setParts(v, chosen.id) : null;
  const total = sets.reduce((n, s) => n + s.count, 0);
  const gradeWord = (g: string) => (g === "PK" ? d.gradePK : g === "KG" ? d.gradeK : /^\d+$/.test(g) ? String(Number(g)) : g);
  const message: Record<string, string> = {
    ok: d.csSetAdded, exists: d.csSetExists, empty: d.csSetEmpty, unknown: d.csSetUnknown, forbidden: d.csSetForbidden,
    "too-many": d.csSetTooMany.replace("{n}", String(COURSE_SET_LIMITS.standards)),
  };
  const groups = [
    [d.stdFollowed, frameworks.filter((f) => f.followed)],
    [d.stdSchoolSets, frameworks.filter((f) => f.ownerKind === "school")],
    [d.stdYourSets, frameworks.filter((f) => f.ownerKind === "teacher")],
    [d.stdOtherPublished, frameworks.filter((f) => f.ownerKind === "library" && !f.followed)],
  ] as const;

  return (
    <>
      <TopBar crumbs={<><Link href="/">{d.myCourses}</Link> · <Link href={`/catalog/${course.id}`}>{course.name}</Link></>} />
      <main className="page stack" style={{ maxWidth: 860 }}>
        <div>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>{d.csCourseWord}</p>
          <h1 style={{ fontSize: 34 }}>{course.name} · {d.standards}</h1>
        </div>
        <p className="muted" style={{ margin: 0 }}>{d.csCourseHint.replace("{n}", String(course.sections.length))}</p>
        {sp.r && message[sp.r] && <p className={`notice${sp.r === "ok" ? "" : " notice-bad"}`} role="status">{message[sp.r]}</p>}

        <section className="card stack" aria-labelledby="sets-now" style={{ gap: 8 }}>
          <h2 id="sets-now" className="label">{d.csCourseSets} ({total})</h2>
          {sets.length === 0 ? <p className="empty" style={{ margin: 0 }}>{d.csNoCourseSets}</p> : (
            <ul className="list">
              {sets.map((s) => (
                <li key={s.id}>
                  <span className="grow">
                    <b>{s.title}</b>{s.version ? ` (${s.version})` : ""}
                    <span className="muted" style={{ display: "block", fontSize: 13 }}>
                      {[s.part ? s.part.title : d.csWholeSet, s.grades.length ? `${d.csGrades} ${s.grades.map(gradeWord).join(", ")}` : d.csEveryGrade, `${s.count} ${d.stdItemsWord}`].join(" · ")}
                    </span>
                  </span>
                  {may && (
                    <form action={act}>
                      <input type="hidden" name="catalogId" value={course.id} />
                      <input type="hidden" name="setId" value={s.id} />
                      <button className="btn btn-sm" name="op" value="remove" aria-label={`${d.remove}: ${s.title}`}>{d.remove}</button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
          {may && sets.length > 0 && <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.csRemoveHint}</p>}
          <Notices notices={sets.map((s) => s.notice)} d={d} />
        </section>

        {!may && <p className="muted">{d.csSchoolChooses}</p>}

        {may && (
          <section className="card stack" aria-labelledby="sets-add" style={{ gap: 10 }}>
            <h2 id="sets-add" className="label">{d.csAddSet}</h2>
            <form method="get" className="row" style={{ alignItems: "flex-end" }}>
              <label className="fieldset grow">
                <span className="label">{d.csStep1}</span>
                <select name="set" className="field" defaultValue={chosen?.id ?? ""} required>
                  <option value="" disabled>{d.csPickSet}…</option>
                  {groups.filter(([, list]) => list.length).map(([label, list]) => (
                    <optgroup key={label} label={label}>
                      {list.map((f) => <option key={f.id} value={f.id}>{f.title}{f.version ? ` (${f.version})` : ""} · {f.itemCount}</option>)}
                    </optgroup>
                  ))}
                </select>
              </label>
              <button className="btn">{d.csNextStep}</button>
            </form>
            {frameworks.length === 0 && <p className="muted" style={{ margin: 0 }}>{d.csNoSetsToPick} <Link href="/standards">{d.standardsLibrary}</Link></p>}

            {chosen && parts && (
              <form action={act} className="stack" style={{ gap: 10, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
                <input type="hidden" name="catalogId" value={course.id} />
                <input type="hidden" name="frameworkId" value={chosen.id} />
                <p style={{ margin: 0 }}><b>{chosen.title}</b>{chosen.version ? ` (${chosen.version})` : ""}</p>
                {parts.parts.length > 0 && (
                  <label className="fieldset">
                    <span className="label">{d.csStep2Part}</span>
                    <select name="partId" className="field" defaultValue="">
                      <option value="">{d.csWholeSet}</option>
                      {parts.parts.map((p) => <option key={p.id} value={p.id}>{"  ".repeat(p.depth)}{p.title}</option>)}
                    </select>
                  </label>
                )}
                {parts.grades.length > 1 && (
                  <fieldset className="fieldset" style={{ border: 0, padding: 0, margin: 0 }}>
                    <legend className="label">{d.csStep2Grades}</legend>
                    <div className="row" style={{ gap: 4 }}>
                      {parts.grades.map((g) => (
                        <label key={g} className="check" style={{ minWidth: 52 }}><input type="checkbox" name="grade" value={g} /> {gradeWord(g)}</label>
                      ))}
                    </div>
                  </fieldset>
                )}
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.csAddHint}</p>
                <button className="btn btn-primary" name="op" value="add" style={{ alignSelf: "flex-start" }}>{d.csGiveCourse}</button>
                <Notices notices={[chosen.notice]} d={d} />
              </form>
            )}
          </section>
        )}

        <section className="card" aria-labelledby="sets-classes">
          <h2 id="sets-classes" className="label">{d.secSections}</h2>
          <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
            {course.sections.map((s) => (
              <li key={s.id}>{s.schoolYear || d.secNoYear} · {v?.teaches.includes(s.id) ? <Link href={`/courses/${s.id}/standards`}>{s.name}</Link> : s.name}</li>
            ))}
          </ul>
        </section>
      </main>
    </>
  );
}
