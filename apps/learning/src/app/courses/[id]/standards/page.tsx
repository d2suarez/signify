import Link from "next/link";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireMe } from "@/lib/auth";
import { academicAccess as courseAccess, ctx, lang, isSchoolAdmin } from "@/lib/access";
import { addStandard, archiveStandard, moveStandard, teachersMayAdd, updateStandard, STANDARD_LIMITS } from "@/lib/standards";
import { courseStandardSources } from "@/lib/standards-library";
import { classStandards, coverage, listCourseSets, mayChooseCourseSets, syncSection, type CoverageStatus } from "@/lib/course-standards";
import { getDb } from "@/lib/db";
import { todayIn } from "@/lib/planner";
import { dict } from "@/lib/i18n";
import { TopBar } from "@/components/TopBar";
import { ClassHeader } from "@/components/ClassHeader";
import { Notices } from "@/components/FrameworkInfo";
import PrintButton from "@/components/PrintButton";

export const dynamic = "force-dynamic";

const SCHOOL_TZ = "America/New_York";

/** A standard added to this class only: typed, edited, moved, archived. The course's own are changed on the course. */
async function act(formData: FormData) {
  "use server";
  const access = await courseAccess(String(formData.get("courseId") || ""));
  if (!access || access.course.role !== "teacher") return;
  const c = ctx(access.me), courseId = access.course.id;
  const op = String(formData.get("op") || "");
  const sid = String(formData.get("standardId") || "");
  if (op === "add") await addStandard(c, courseId, formData.get("code"), formData.get("description"));
  if (op === "update") await updateStandard(c, courseId, sid, formData.get("code"), formData.get("description"));
  if (op === "archive") await archiveStandard(c, courseId, sid, true);
  if (op === "restore") await archiveStandard(c, courseId, sid, false);
  if (op === "up" || op === "down") await moveStandard(c, courseId, sid, op === "up" ? -1 : 1);
  revalidatePath(`/courses/${courseId}/standards`);
}

type Search = { status?: string; set?: string; strand?: string; q?: string };

/**
 * A class's standards (Desmond, 2026-11-23): where they come from (the
 * course's sets, plus any added to this class only) and how each has been
 * covered: taught, assessed, when last, what's planned, what's still to
 * cover. Filters are plain GET parameters, so a filtered view can be
 * printed or bookmarked.
 */
export default async function ClassStandards({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const me = await requireMe();
  const { id } = await params;
  const sp = await searchParams;
  const L = await lang();
  const d = dict(L);
  const access = await courseAccess(id);
  if (!access || access.course.role !== "teacher" || access.course.kind === "club") notFound();
  const { course } = access;
  const c = ctx(me);
  const db = await getDb();
  // A new item in a school set, or a set changed on the course, reaches the class here too.
  await db.tx((t) => syncSection(t, me.tenantId, course.id));
  const [k] = await db.query("SELECT k.id, k.name FROM courses c JOIN catalog_courses k ON k.id = c.catalog_id WHERE c.tenant_id = $1 AND c.id = $2", [me.tenantId, course.id]);
  const catalogId = k ? String(k.id) : null;
  const today = todayIn(SCHOOL_TZ);
  const viewer = { ...c, admin: isSchoolAdmin(me), teaches: [course.id] };
  const [cov, sets, mayChoose, mayType, all, sources] = await Promise.all([
    coverage(c, course.id, today),
    catalogId ? listCourseSets(c, catalogId) : Promise.resolve([]),
    catalogId ? mayChooseCourseSets(viewer, catalogId) : Promise.resolve(false),
    teachersMayAdd(me.tenantId),
    classStandards(c, course.id, { withArchived: true }),
    courseStandardSources(me.tenantId, course.id),
  ]);

  const status = (["covered", "planned", "none"] as const).includes(sp.status as CoverageStatus) ? (sp.status as CoverageStatus) : "";
  const setNames = [...new Set(cov.rows.map((r) => r.set || ""))];
  const strands = [...new Set(cov.rows.map((r) => r.strand).filter(Boolean))];
  const words = (sp.q ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  const rows = cov.rows.filter((r) =>
    (!status || r.status === status)
    && (sp.set === undefined || sp.set === "*" || (sp.set === "" ? !r.set : r.set === sp.set))
    && (!sp.strand || r.strand === sp.strand)
    && words.every((w) => `${r.code} ${r.description}`.toLowerCase().includes(w)));
  const filtered = rows.length !== cov.rows.length;

  const locale = L === "es" ? "es" : "en-US";
  const date = (day: string | null) => day ? new Date(`${day}T12:00:00Z`).toLocaleDateString(locale, { month: "short", day: "numeric", timeZone: "UTC" }) : "—";
  const pct = (n: number) => (cov.counts.total ? Math.round((100 * n) / cov.counts.total) : 0);
  const statusWord: Record<CoverageStatus, string> = { covered: d.csCovered, planned: d.csPlanned, none: d.csNotYet };
  const own = all.filter((s) => !s.fromCourse);
  const ownLive = own.filter((s) => !s.archived), ownArchived = own.filter((s) => s.archived);
  const fromCourse = all.filter((s) => s.fromCourse && !s.archived).length;
  let lastStrand: string | null = null;

  return (
    <>
      <TopBar crumbs={<Link href="/">{d.myCourses}</Link>} below={<ClassHeader course={course} d={d} tab="standards" heading />} />
      <main className="page stack" style={{ maxWidth: 1000 }}>
        <div className="row">
          {/* The class header is the title on screen; printed, the top bar is left out, so the name prints here. */}
          <p style={{ fontSize: 34, margin: 0 }} className="grow print-only">{course.name}</p>
          <span className="spacer no-print" />
          <span className="no-print"><PrintButton label={d.csPrint} /></span>
        </div>
        <h2 className="print-only" style={{ fontSize: 22 }}>{d.csTitle} · {date(today)}</h2>

        <section className="card stack" aria-labelledby="cov-sum" style={{ gap: 10 }}>
          <h2 id="cov-sum" className="label">{d.csCoverage}</h2>
          {cov.counts.total === 0 ? <p className="empty" style={{ margin: 0 }}>{d.csNone}</p> : (
            <>
              <p style={{ margin: 0, fontSize: 18 }}>
                <b>{d.csCoveredOf.replace("{n}", String(cov.counts.covered)).replace("{total}", String(cov.counts.total))}</b>
                <span className="muted"> · {cov.counts.planned} {d.csPlanned.toLowerCase()} · {cov.counts.none} {d.csStillToCover}</span>
              </p>
              <div className="cov-bar" role="img" aria-label={`${d.csCovered} ${pct(cov.counts.covered)}%, ${d.csPlanned} ${pct(cov.counts.planned)}%, ${d.csNotYet} ${pct(cov.counts.none)}%`}>
                <span className="cov-bar-covered" style={{ width: `${pct(cov.counts.covered)}%` }} />
                <span className="cov-bar-planned" style={{ width: `${pct(cov.counts.planned)}%` }} />
              </div>
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.csHowCounted}</p>
            </>
          )}
        </section>

        <section className="card stack no-print" aria-labelledby="cov-from" style={{ gap: 8 }}>
          <h2 id="cov-from" className="label">{d.csWhereFrom}</h2>
          <div>
            <b>{d.csFromCourse.replace("{course}", k ? String(k.name) : course.name)}</b> <span className="muted">({fromCourse})</span>
            {sets.length === 0
              ? <p className="muted" style={{ margin: "4px 0 0", fontSize: 14 }}>{d.csNoCourseSets}</p>
              : (
                <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
                  {sets.map((s) => (
                    <li key={s.id}>{s.title}{s.version ? ` (${s.version})` : ""}{s.part ? ` · ${s.part.title}` : ""}{s.grades.length ? ` · ${d.csGrades} ${s.grades.map((g) => (g === "KG" ? "K" : g === "PK" ? "PK" : String(Number(g)) || g)).join(", ")}` : ""} <span className="muted">({s.count})</span></li>
                  ))}
                </ul>
              )}
            {catalogId && (mayChoose
              ? <p style={{ margin: "6px 0 0" }}><Link className="btn btn-sm" href={`/catalog/${catalogId}/standards`}>{d.csChooseCourseSets}</Link></p>
              : <p className="muted" style={{ margin: "6px 0 0", fontSize: 13 }}>{d.csSchoolChooses}</p>)}
          </div>
          <div>
            <b>{d.csThisClassOnly}</b> <span className="muted">({ownLive.length})</span>
            <p className="muted" style={{ margin: "2px 0 6px", fontSize: 13 }}>{d.csThisClassHint}</p>
            <Link className="btn btn-sm" href={`/standards?course=${course.id}`}>{d.csAddFromLibrary}</Link>
          </div>
        </section>

        <form method="get" className="card row std-filters no-print" role="search" aria-label={d.csFilter}>
          <label className="fieldset" style={{ flex: "1 1 150px" }}>
            <span className="label">{d.csShow}</span>
            <select name="status" className="field" defaultValue={status}>
              <option value="">{d.csAll}</option>
              <option value="none">{d.csNotYet}</option>
              <option value="planned">{d.csPlanned}</option>
              <option value="covered">{d.csCovered}</option>
            </select>
          </label>
          {setNames.length > 1 && (
            <label className="fieldset" style={{ flex: "1 1 200px" }}>
              <span className="label">{d.csSet}</span>
              <select name="set" className="field" defaultValue={sp.set ?? "*"}>
                <option value="*">{d.csAll}</option>
                {setNames.map((s) => <option key={s} value={s}>{s || d.csTypedIntoClass}</option>)}
              </select>
            </label>
          )}
          {strands.length > 1 && (
            <label className="fieldset" style={{ flex: "1 1 200px" }}>
              <span className="label">{d.csStrand}</span>
              <select name="strand" className="field" defaultValue={sp.strand ?? ""}>
                <option value="">{d.csAll}</option>
                {strands.map((s) => <option key={s} value={s}>{s.slice(0, 70)}</option>)}
              </select>
            </label>
          )}
          <label className="fieldset" style={{ flex: "1 1 160px" }}>
            <span className="label">{d.csWords}</span>
            <input name="q" className="field" defaultValue={sp.q ?? ""} maxLength={100} />
          </label>
          <button className="btn btn-primary" style={{ alignSelf: "flex-end" }}>{d.csApply}</button>
          {filtered && <Link href={`/courses/${course.id}/standards`} style={{ alignSelf: "center" }}>{d.csClear}</Link>}
        </form>

        {cov.counts.total > 0 && (
          <section aria-labelledby="cov-list">
            <h2 id="cov-list" className="sr-only">{d.csTitle}</h2>
            {filtered && <p className="muted" aria-live="polite">{d.csShowing.replace("{n}", String(rows.length)).replace("{total}", String(cov.counts.total))}</p>}
            <div className="card cov-wrap" style={{ padding: 0 }}>
              <table className="cov-table">
                <thead>
                  <tr>
                    <th scope="col">{d.csStandard}</th>
                    <th scope="col" className="cov-num">{d.csTaught}</th>
                    <th scope="col" className="cov-num">{d.csAssessed}</th>
                    <th scope="col">{d.csLast}</th>
                    <th scope="col">{d.csNext}</th>
                    <th scope="col">{d.csStatus}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const head = r.strand !== lastStrand && r.strand ? r.strand : null;
                    lastStrand = r.strand;
                    return [
                      head && <tr key={`h-${r.id}`} className="cov-strand"><th colSpan={6} scope="colgroup">{head}</th></tr>,
                      <tr key={r.id} className={`cov-row cov-${r.status}`}>
                        <td>
                          <b>{r.code}</b>{r.description && r.description !== r.code ? <span className="cov-desc"> {r.description}</span> : null}
                          {r.events.length > 0 && (
                            <details className="cov-events no-print">
                              <summary>{d.csWhen} ({r.events.length})</summary>
                              <ul>
                                {r.events.map((e, i) => (
                                  <li key={i}>{date(e.day)} · {e.kind === "taught" ? d.csTaught : d.csAssessed}{e.title ? <> · <Link href={e.href}>{e.title}</Link></> : <> · <Link href={e.href}>{d.planner}</Link></>}</li>
                                ))}
                              </ul>
                            </details>
                          )}
                        </td>
                        <td className="cov-num">{r.taught || "—"}</td>
                        <td className="cov-num">{r.assessed || "—"}</td>
                        <td>{date(r.last)}</td>
                        <td>{date(r.next)}</td>
                        <td><span className={`chip cov-chip-${r.status}`}>{r.status === "covered" ? "✓ " : r.status === "planned" ? "◷ " : "○ "}{statusWord[r.status]}</span></td>
                      </tr>,
                    ];
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <details className="card no-print">
          <summary className="label">{d.csManageOwn} ({ownLive.length})</summary>
          <p className="muted" style={{ fontSize: 13, margin: "6px 0 0" }}>{d.csManageOwnHint}</p>
          <ul className="list" style={{ marginTop: 8 }}>
            {ownLive.map((s, i) => (
              <li key={s.id}>
                <form action={act} className="row grow">
                  <input type="hidden" name="courseId" value={course.id} />
                  <input type="hidden" name="standardId" value={s.id} />
                  {s.editable ? (
                    <>
                      <input name="code" className="field" style={{ width: 120 }} defaultValue={s.code} maxLength={STANDARD_LIMITS.code} aria-label={d.standardCode} required />
                      <input name="description" className="field" style={{ flex: "1 1 240px", width: "auto" }} defaultValue={s.description} maxLength={STANDARD_LIMITS.description} aria-label={d.standardDescription} />
                      <button className="btn btn-sm" name="op" value="update">{d.save}</button>
                    </>
                  ) : (
                    <span className="grow" style={{ flex: "1 1 300px" }}>
                      <b>{s.code}</b>{s.description !== s.code ? <> · {s.description}</> : null}
                      {s.set && <span className="muted" style={{ display: "block", fontSize: 12 }}>{s.set}</span>}
                    </span>
                  )}
                  <button className="btn btn-sm" name="op" value="up" disabled={i === 0} aria-label={`${d.moveUp}: ${s.code}`}>↑</button>
                  <button className="btn btn-sm" name="op" value="down" disabled={i === ownLive.length - 1} aria-label={`${d.moveDown}: ${s.code}`}>↓</button>
                  <button className="btn btn-sm" name="op" value="archive">{d.archive}</button>
                </form>
              </li>
            ))}
            {mayType && (
              <li>
                <form action={act} className="row grow">
                  <input type="hidden" name="courseId" value={course.id} />
                  <input name="code" className="field" style={{ width: 120 }} placeholder={d.standardCode} maxLength={STANDARD_LIMITS.code} aria-label={d.standardCode} required />
                  <input name="description" className="field" style={{ flex: "1 1 240px", width: "auto" }} placeholder={d.standardDescription} maxLength={STANDARD_LIMITS.description} aria-label={d.standardDescription} />
                  <button className="btn btn-primary btn-sm" name="op" value="add">{d.csTypeOne}</button>
                </form>
              </li>
            )}
          </ul>
          {ownArchived.length > 0 && (
            <details style={{ marginTop: 10 }}>
              <summary>{d.archivedStandards} ({ownArchived.length})</summary>
              <ul className="list">
                {ownArchived.map((s) => (
                  <li key={s.id}>
                    <form action={act} className="row grow">
                      <input type="hidden" name="courseId" value={course.id} />
                      <input type="hidden" name="standardId" value={s.id} />
                      <span className="grow"><b>{s.code}</b> {s.description}</span>
                      <button className="btn btn-sm" name="op" value="restore">{d.restore}</button>
                    </form>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </details>
        <Notices notices={[...sources.values()].map((f) => f.notice)} d={d} />
      </main>
    </>
  );
}
