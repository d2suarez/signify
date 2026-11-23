import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { courseAccess, ctx, lang, studentsOf } from "@/lib/access";
import { requireMe } from "@/lib/auth";
import { createGroupSet, listGroupSets, myGroups, saveGroupSet } from "@/lib/group-sets";
import { groupName, randomGroups, newGroupId } from "@/lib/groups";
import { dict, t } from "@/lib/i18n";
import { TopBar } from "@/components/TopBar";
import { CourseNav } from "@/components/CourseNav";

export const dynamic = "force-dynamic";

/**
 * A class's groups (story 01, A8). Teachers make group sets at random or by
 * hand, save them under a name and reuse them (on group slides, and for
 * group assignments). Students see only their own group in each set the
 * teacher lets them see.
 */

async function teacherAccess(formData: FormData) {
  const access = await courseAccess(String(formData.get("courseId") || ""));
  return access && access.course.role === "teacher" ? access : null;
}

async function makeSet(formData: FormData) {
  "use server";
  const access = await teacherAccess(formData);
  if (!access) return;
  const L = await lang();
  const word = t("grpWord", L);
  const { ok, students } = await studentsOf(access);
  if (!ok) redirect(`/courses/${access.course.id}/groups?id=failed`);
  const people = students.map((s) => ({ id: s.id, name: s.name }));
  const how = String(formData.get("how") || "count");
  const n = Math.max(1, Math.min(40, Math.floor(Number(formData.get("n")) || 1)));
  const groups = how === "hand"
    ? Array.from({ length: n }, (_, i) => ({ id: newGroupId(), name: groupName(word, i), members: [] }))
    : randomGroups(people, how === "size" ? { size: n } : { count: n }, word);
  const name = String(formData.get("name") || "").trim() || `${t("grpTitle", L)} · ${new Date().toLocaleDateString(L === "es" ? "es" : "en-US", { month: "short", day: "numeric" })}`;
  const set = await createGroupSet(ctx(access.me), access.course.id, { name, groups }, new Map(people.map((p) => [p.id, p.name])), word);
  redirect(`/courses/${access.course.id}/groups/${set.id}`);
}

async function restoreSet(formData: FormData) {
  "use server";
  const access = await teacherAccess(formData);
  if (!access) return;
  const { ok, students } = await studentsOf(access);
  if (!ok) return;
  await saveGroupSet(ctx(access.me), access.course.id, String(formData.get("id") || ""),
    { baseVersion: Number(formData.get("version")), archived: false }, new Map(students.map((s) => [s.id, s.name])));
  revalidatePath(`/courses/${access.course.id}/groups`);
}

export default async function GroupsPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ id?: string }>;
}) {
  await requireMe();
  const { id } = await params;
  const { id: problem } = await searchParams;
  const L = await lang();
  const d = dict(L);
  const access = await courseAccess(id);
  if (!access) notFound();
  const { me, course } = access;
  const crumbs = <><Link href="/">{d.myCourses}</Link> · <Link href={`/courses/${course.id}`}>{course.name}</Link></>;

  if (course.role !== "teacher") {
    const mine = await myGroups(ctx(me), course.id, me.id);
    return (
      <>
        <TopBar crumbs={crumbs} />
        <main className="page stack">
          <h1 style={{ fontSize: 34 }}>{d.grpYourGroups}</h1>
          {mine.length === 0 ? <p className="empty">{d.grpNoneStudent}</p> : (
            <ul className="group-grid">
              {mine.map((g) => (
                <li key={g.setId} className="group-card">
                  <p className="muted" style={{ margin: "0 0 2px", fontSize: 13 }}>{g.setName}</p>
                  <p className="group-name">{g.group}</p>
                  <ul className="group-members">{g.members.map((m, i) => <li key={i}>{m}</li>)}</ul>
                </li>
              ))}
            </ul>
          )}
        </main>
      </>
    );
  }

  const [sets, archived] = await Promise.all([listGroupSets(ctx(me), course.id), listGroupSets(ctx(me), course.id, { archived: true })]);
  return (
    <>
      <TopBar crumbs={crumbs} />
      <main className="page stack">
        <div>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>{course.subject}</p>
          <h1 style={{ fontSize: 34 }}>{course.name}</h1>
        </div>
        <CourseNav courseId={course.id} current="groups" d={d} club={course.kind === "club"} />

        <section className="card stack" aria-labelledby="grp-title" style={{ gap: 12 }}>
          <h2 id="grp-title" style={{ fontSize: 24 }}>{d.grpTitle}</h2>
          <p className="muted" style={{ margin: 0 }}>{d.grpIntro}</p>
          {problem === "failed" && <p className="notice" role="alert" style={{ margin: 0 }}>{d.grpRosterFailed}</p>}
          {sets.length === 0 ? <p className="empty">{d.grpEmpty2}</p> : (
            <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0, gap: 8 }}>
              {sets.map((s) => (
                <li key={s.id}>
                  <Link className="reader-link card" href={`/courses/${course.id}/groups/${s.id}`}>
                    <span className="shape s-square" aria-hidden="true" />
                    <span className="grow" style={{ minWidth: 0 }}>
                      <b>{s.name}</b>
                      <span className="muted" style={{ display: "block", fontSize: 13 }}>
                        {d.grpCount.replace("{n}", String(s.groups.length)).replace("{m}", String(s.groups.reduce((n, g) => n + g.members.length, 0)))}
                        {" · "}{s.studentsSee ? d.grpStudentsSeeOn : d.grpStudentsSeeOff}
                      </span>
                    </span>
                    <span aria-hidden="true">→</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card stack" aria-labelledby="grp-new" style={{ gap: 10 }}>
          <h2 id="grp-new" style={{ fontSize: 20 }}>{d.grpNew}</h2>
          <form action={makeSet} className="stack" style={{ gap: 10 }}>
            <input type="hidden" name="courseId" value={course.id} />
            <div className="fieldset">
              <label htmlFor="grp-name">{d.grpSetName}</label>
              <input id="grp-name" name="name" className="field" maxLength={80} placeholder={d.grpSetNameHint} />
            </div>
            <fieldset className="choice">
              <legend>{d.grpHow}</legend>
              <div className="choice-opts">
                <label><input type="radio" name="how" value="count" defaultChecked /> <span>{d.grpHowCount}</span></label>
                <label><input type="radio" name="how" value="size" /> <span>{d.grpHowSize}</span></label>
                <label><input type="radio" name="how" value="hand" /> <span>{d.grpHowHand}</span></label>
              </div>
            </fieldset>
            <div className="fieldset" style={{ maxWidth: 200 }}>
              <label htmlFor="grp-n">{d.grpHowN}</label>
              <input id="grp-n" name="n" type="number" min={1} max={40} defaultValue={4} className="field" required />
            </div>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.grpNoApart}</p>
            <div><button className="btn btn-primary">{d.grpMake}</button></div>
          </form>
        </section>

        {archived.length > 0 && (
          <details className="card">
            <summary className="label">{d.grpArchived} ({archived.length})</summary>
            <ul className="stack" style={{ listStyle: "none", padding: 0, margin: "10px 0 0", gap: 6 }}>
              {archived.map((s) => (
                <li key={s.id} className="row">
                  <span className="grow">{s.name}</span>
                  <form action={restoreSet}>
                    <input type="hidden" name="courseId" value={course.id} />
                    <input type="hidden" name="id" value={s.id} />
                    <input type="hidden" name="version" value={s.version} />
                    <button className="btn btn-sm">{d.grpRestore}</button>
                  </form>
                </li>
              ))}
            </ul>
          </details>
        )}
      </main>
    </>
  );
}
