import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireMe, readMe } from "@/lib/auth";
import { lang, standardsViewer } from "@/lib/access";
import {
  addItemsToCourse, canEdit, copyFramework, createFramework, ensureLibrary, getFramework, listFrameworks, mayCreate, searchItems, subjectsOf,
  type Framework,
} from "@/lib/standards-library";
import { GRADE_LEVELS, gradeSpan } from "@/lib/standards-csv";
import { getDb } from "@/lib/db";
import { dict } from "@/lib/i18n";
import { TopBar } from "@/components/TopBar";
import { FrameworkInfo, Notices } from "@/components/FrameworkInfo";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f-]{36}$/i;

async function act(formData: FormData) {
  "use server";
  const me = await readMe();
  const v = me && await standardsViewer(me);
  if (!v) return;
  const op = String(formData.get("op") || "");
  const back = String(formData.get("back") || "/standards");
  if (op === "add") {
    const courseId = String(formData.get("courseId") || "");
    if (!v.teaches.includes(courseId)) return;
    const r = await addItemsToCourse(v, courseId, formData.getAll("item").map(String));
    redirect(`${back.startsWith("/standards") ? back : "/standards"}&added=${r.added}`);
  }
  if (op === "new") {
    const f = await createFramework(v, "teacher", { title: formData.get("title"), subject: formData.get("subject") });
    if (f) redirect(`/standards/${f.id}`);
  }
  if (op === "copy") {
    const kind = formData.get("kind") === "school" ? "school" : "teacher";
    const f = await copyFramework(v, String(formData.get("frameworkId") || ""), kind);
    if (f) redirect(`/standards/${f.id}`);
  }
  redirect(back);
}

type Search = { f?: string; subject?: string; grade?: string; q?: string; course?: string; added?: string };

/**
 * The standards library: published sets, the school's own and the
 * teacher's own. Browse a framework as a tree, or search by words, code,
 * subject and grade. With ?course=, standards are ticked and added to that
 * course.
 */
export default async function StandardsLibrary({ searchParams }: { searchParams: Promise<Search> }) {
  const me = await requireMe();
  const v = await standardsViewer(me);
  if (!v) notFound();
  const d = dict(await lang());
  await ensureLibrary();
  const sp = await searchParams;
  const courseId = sp.course && v.teaches.includes(sp.course) ? sp.course : null;
  const course = courseId ? (await (await getDb()).query<{ name: string }>("SELECT name FROM courses WHERE tenant_id = $1 AND id = $2", [v.tenantId, courseId]))[0] : null;
  const frameworks = await listFrameworks(v);
  const fw = sp.f && UUID.test(sp.f) ? await getFramework(v, sp.f) : null;
  const q = (sp.q ?? "").slice(0, 200);
  const grade = GRADE_LEVELS.includes(sp.grade as never) ? sp.grade! : "";
  const subject = (sp.subject ?? "").slice(0, 60);
  const searching = !!(fw || q || grade || subject);
  const { hits, more } = searching ? await searchItems(v, { frameworkId: fw?.id, q, grade, subject, limit: 400 }) : { hits: [], more: false };
  const canNew = await mayCreate(v, "teacher");

  const qs = (extra: Record<string, string>) => {
    const p = new URLSearchParams();
    for (const [k, val] of Object.entries({ f: fw?.id ?? "", subject, grade, q, course: courseId ?? "", ...extra })) if (val) p.set(k, val);
    return `/standards?${p}`;
  };
  const gradeWord = (g: string) => (g === "PK" ? d.gradePK : g === "KG" ? d.gradeK : String(Number(g)));
  const groups: [string, Framework[]][] = [
    [d.stdPublished, frameworks.filter((f) => f.ownerKind === "library")],
    [d.stdSchoolSets, frameworks.filter((f) => f.ownerKind === "school")],
    [d.stdYourSets, frameworks.filter((f) => f.ownerKind === "teacher")],
  ];

  return (
    <>
      <TopBar crumbs={<><Link href="/">{d.myCourses}</Link> · {courseId ? <Link href={`/courses/${courseId}/settings`}>{course?.name}</Link> : me.tenantName}</>} />
      <main className="page stack" style={{ maxWidth: 1000 }}>
        <div className="row">
          <h1 style={{ fontSize: 34 }} className="grow">{d.standardsLibrary}</h1>
          {v.admin && <Link className="btn" href="/school/standards">{d.schoolStandards}</Link>}
        </div>
        <p className="muted" style={{ margin: 0 }}>{d.standardsLibraryHint}</p>
        {courseId && (
          <p className="notice" role="status">
            {d.addingTo.replace("{course}", course?.name ?? "")} <Link href={`/courses/${courseId}/settings`}>{d.backToSettings}</Link>
            {sp.added !== undefined && <><br /><b>{d.addedCount.replace("{n}", String(Number(sp.added) || 0))}</b></>}
          </p>
        )}

        <form method="get" action="/standards" className="card row std-filters" role="search" aria-label={d.searchStandards}>
          {courseId && <input type="hidden" name="course" value={courseId} />}
          <div className="fieldset" style={{ flex: "2 1 260px" }}>
            <label htmlFor="sf">{d.stdFramework}</label>
            <select id="sf" name="f" className="field" defaultValue={fw?.id ?? ""}>
              <option value="">{d.stdAllFrameworks}</option>
              {groups.filter(([, l]) => l.length).map(([label, l]) => (
                <optgroup key={label} label={label}>
                  {l.map((f) => <option key={f.id} value={f.id}>{f.title}{f.version ? ` (${f.version})` : ""}</option>)}
                </optgroup>
              ))}
            </select>
          </div>
          <div className="fieldset" style={{ flex: "1 1 150px" }}>
            <label htmlFor="ss">{d.stdSubject}</label>
            <select id="ss" name="subject" className="field" defaultValue={subject}>
              <option value="">{d.stdAnySubject}</option>
              {subjectsOf(frameworks).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="fieldset" style={{ flex: "1 1 110px" }}>
            <label htmlFor="sg">{d.stdGrade}</label>
            <select id="sg" name="grade" className="field" defaultValue={grade}>
              <option value="">{d.stdAnyGrade}</option>
              {GRADE_LEVELS.map((g) => <option key={g} value={g}>{gradeWord(g)}</option>)}
            </select>
          </div>
          <div className="fieldset" style={{ flex: "2 1 220px" }}>
            <label htmlFor="sq">{d.stdWordsOrCode}</label>
            <input id="sq" name="q" type="search" className="field" defaultValue={q} placeholder="3.OA.A.1, fractions…" />
          </div>
          <button className="btn btn-primary" style={{ alignSelf: "flex-end" }}>{d.search}</button>
          {searching && <Link className="btn" style={{ alignSelf: "flex-end" }} href={qs({ f: "", subject: "", grade: "", q: "" })}>{d.stdClear}</Link>}
        </form>

        {!searching && groups.map(([label, list]) => (
          <section key={label} aria-label={label}>
            <h2 className="label">{label}</h2>
            {list.length === 0 && <p className="empty">{label === d.stdYourSets ? d.stdNoneYours : d.stdNoneSchool}</p>}
            <div className="grid-cards">
              {list.map((f) => (
                <Link key={f.id} href={qs({ f: f.id })} className="card course-card">
                  <span className="muted" style={{ fontSize: 13 }}>{[f.subjects.join(", "), f.version, `${f.itemCount} ${d.stdItemsWord}`].filter(Boolean).join(" · ")}</span>
                  <h3 lang={f.language}>{f.title}</h3>
                  {f.licenseTitle && <span className="muted" style={{ fontSize: 12 }} lang="en">{f.licenseTitle}</span>}
                  {f.superseded && <span className="chip">{d.stdSuperseded}</span>}
                </Link>
              ))}
            </div>
          </section>
        ))}
        {!searching && canNew && (
          <form action={act} className="card row" style={{ alignItems: "flex-end" }}>
            <input type="hidden" name="op" value="new" />
            <div className="fieldset" style={{ flex: "2 1 240px" }}>
              <label htmlFor="nt">{d.stdNewTitle}</label>
              <input id="nt" name="title" className="field" maxLength={200} required />
            </div>
            <div className="fieldset" style={{ flex: "1 1 160px" }}>
              <label htmlFor="ns">{d.stdSubject}</label>
              <input id="ns" name="subject" className="field" maxLength={60} />
            </div>
            <button className="btn btn-primary">{d.stdNewSet}</button>
          </form>
        )}

        {fw && (
          <section className="card stack" aria-labelledby="fw-title" style={{ gap: 8 }}>
            <h2 id="fw-title" lang={fw.language} style={{ fontSize: 22 }}>{fw.title}</h2>
            <FrameworkInfo f={fw} d={d} />
            <div className="row">
              {canEdit(v, fw) && <Link className="btn" href={`/standards/${fw.id}`}>{d.edit}</Link>}
              {v.admin && (
                <form action={act}><input type="hidden" name="op" value="copy" /><input type="hidden" name="kind" value="school" /><input type="hidden" name="frameworkId" value={fw.id} /><input type="hidden" name="back" value={qs({})} />
                  <button className="btn">{d.stdCopyToSchool}</button></form>
              )}
              {canNew && (
                <form action={act}><input type="hidden" name="op" value="copy" /><input type="hidden" name="kind" value="teacher" /><input type="hidden" name="frameworkId" value={fw.id} /><input type="hidden" name="back" value={qs({})} />
                  <button className="btn">{d.stdCopyToMine}</button></form>
              )}
            </div>
          </section>
        )}

        {searching && (
          <form action={act} className="stack" style={{ gap: 8 }}>
            <input type="hidden" name="op" value="add" />
            <input type="hidden" name="back" value={qs({})} />
            {courseId && <input type="hidden" name="courseId" value={courseId} />}
            <p className="muted" role="status" style={{ margin: 0 }}>
              {hits.length === 0 ? d.stdNoMatches : more ? d.stdFirstN.replace("{n}", String(hits.length)) : d.stdNMatches.replace("{n}", String(hits.length))}
            </p>
            {courseId && hits.some((h) => h.code) && <button className="btn btn-primary" style={{ alignSelf: "flex-start" }}>{d.stdAddChosen}</button>}
            <ul className="list std-tree">
              {hits.map((h, k) => {
                const showFw = !fw && (k === 0 || hits[k - 1].frameworkId !== h.frameworkId);
                const indent = fw && !q ? Math.min(h.depth, 6) : 0;
                const body = (
                  <span style={{ display: "block" }}>
                    {h.code && <b>{h.code} </b>}
                    <span>{h.statement}</span>
                    {h.grades.length > 0 && <span className="muted" style={{ fontSize: 12 }}> · {d.stdGradesShort} {gradeSpan(h.grades, d.gradeK, d.gradePK)}</span>}
                  </span>
                );
                return (
                  <li key={h.id} style={{ paddingLeft: indent * 18, display: "block" }} className={h.code ? "" : "std-heading"}>
                    {showFw && <p className="label" style={{ margin: "10px 0 4px" }}>{h.framework.title}{h.framework.version ? ` (${h.framework.version})` : ""}</p>}
                    {courseId ? (
                      <label className="check" style={{ whiteSpace: "normal", alignItems: "flex-start" }}>
                        <input type="checkbox" name="item" value={h.id} /> {body}
                      </label>
                    ) : body}
                  </li>
                );
              })}
            </ul>
            {courseId && hits.some((h) => h.code) && <button className="btn btn-primary" style={{ alignSelf: "flex-start" }}>{d.stdAddChosen}</button>}
            <Notices notices={hits.map((h) => h.framework.notice)} d={d} />
          </form>
        )}
        {!searching && <Notices notices={frameworks.map((f) => f.ownerKind === "library" ? f.notice : null)} d={d} />}
      </main>
    </>
  );
}
