import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { courseAccess, ctx, lang } from "@/lib/access";
import { requireMe } from "@/lib/auth";
import { dict } from "@/lib/i18n";
import { createLesson } from "@/lib/lessons";
import { createAssignment } from "@/lib/assignments";
import { listUnits, createUnit, unitChoices, MAX_DEPTH, FolderError } from "@/lib/units";
import { toolChoices } from "@/lib/lti-platform";
import { asCreateKind, createKindsFor, MATERIAL_BLOCKS, CREATE_SHAPE } from "@/lib/create-kinds";
import { TopBar } from "@/components/TopBar";
import { ClassHeader } from "@/components/ClassHeader";
import { CREATE_WORDS } from "@/components/CreateMenu";
import ResourceForm from "@/components/ResourceForm";
import UploadFiles from "@/components/UploadFiles";
import ToolPicker from "@/components/ToolPicker";

export const dynamic = "force-dynamic";

async function teacherAccess(formData: FormData) {
  const access = await courseAccess(String(formData.get("courseId") || ""));
  return access && access.course.role === "teacher" ? access : null;
}

/** Folder, Page and the two kinds of assignment: a title and where it goes. */
async function make(formData: FormData) {
  "use server";
  const access = await teacherAccess(formData);
  if (!access) return;
  const c = ctx(access.me), courseId = access.course.id;
  const what = asCreateKind(formData.get("what"));
  const where = String(formData.get("unitId") || "") || null;
  const title = String(formData.get("title") || "");
  const club = access.course.kind === "club";
  if (what === "folder") {
    const made = await createUnit(c, courseId, title, where).catch((e) => { if (e instanceof FolderError) return null; throw e; });
    redirect(`/courses/${courseId}${made ? `#unit-${made.id}` : ""}`);
  }
  if (what === "page") {
    const lesson = await createLesson(c, courseId, title, [], where);
    redirect(`/lessons/${lesson.id}/edit`);
  }
  if ((what === "assignment" || what === "assessment") && !club) {
    const kind = what === "assessment" ? "quiz" : formData.get("kind") === "offline" ? "offline" : "online";
    const a = await createAssignment(c, courseId, { title, unitId: where, kind });
    redirect(`/assignments/${a.id}`);
  }
  redirect(`/courses/${courseId}`);
}

/**
 * What the Create menu opens (class page, and "Create here" on a folder):
 * one thing to make, going into the folder it was asked from (`in`), which
 * the teacher can change here. Teachers of the class only.
 */
export default async function CreatePage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ what?: string; in?: string }>;
}) {
  await requireMe();
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const L = await lang();
  const d = dict(L);
  const access = await courseAccess(id);
  if (!access || access.course.role !== "teacher") notFound();
  const { me, course } = access;
  const c = ctx(me);
  const [units, tools] = await Promise.all([listUnits(c, course.id), toolChoices(me.tenantId)]);
  const what = asCreateKind(sp.what);
  const allowed = createKindsFor({ club: course.kind === "club", tools: tools.length > 0 });
  if (!what || !allowed.includes(what)) redirect(`/courses/${course.id}`);
  const folder = units.find((u) => u.id === sp.in) ?? null;
  const back = `/courses/${course.id}${folder ? `#unit-${folder.id}` : ""}`;
  // A folder goes inside another only while that one is not already as deep as folders go.
  const choices = unitChoices(units).filter((u) => what !== "folder" || (units.find((x) => x.id === u.id)!.depth + 1 < MAX_DEPTH));
  const words = CREATE_WORDS[what];
  const titleWord = what === "folder" ? d.folderTitle : what === "page" ? d.crPageTitle : d.assignmentTitle;

  const whereSelect = (name: string, idFor: string) => (
    <div className="fieldset">
      <label htmlFor={idFor}>{what === "folder" ? d.crWhereFolder : d.crWhere}</label>
      <select id={idFor} name={name} className="field" defaultValue={folder && choices.some((u) => u.id === folder.id) ? folder.id : ""}>
        <option value="">{what === "folder" ? d.folderTopLevel : d.noUnit}</option>
        {choices.map((u) => <option key={u.id} value={u.id} title={u.title}>{u.label}</option>)}
      </select>
    </div>
  );
  // For the kinds made in the browser, the folder is chosen first (a plain GET form), then the form.
  const wherePicker = (
    <form method="get" className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
      <input type="hidden" name="what" value={what} />
      <div className="fieldset" style={{ flex: "1 1 240px", marginTop: 0 }}>
        <label htmlFor="cr-in">{d.crWhere}</label>
        <select id="cr-in" name="in" className="field" defaultValue={folder?.id || ""}>
          <option value="">{d.noUnit}</option>
          {unitChoices(units).map((u) => <option key={u.id} value={u.id} title={u.title}>{u.label}</option>)}
        </select>
      </div>
      <button className="btn">{d.crWhereChange}</button>
    </form>
  );

  return (
    <>
      <TopBar crumbs={<Link href="/">{d.myCourses}</Link>} below={<ClassHeader course={course} d={d} />} />
      <main className="page stack" style={{ maxWidth: 860 }}>
        <div className="row" style={{ gap: 10, alignItems: "center" }}>
          <span className={`shape ${CREATE_SHAPE[what]}`} aria-hidden="true" />
          <h1 style={{ fontSize: "clamp(24px, 6vw, 30px)" }} className="grow">{d.crTitle.replace("{what}", d[words.name])}</h1>
        </div>
        <p className="muted" style={{ margin: 0 }}>{d[words.hint]}</p>

        {(what === "folder" || what === "page" || what === "assignment" || what === "assessment") && (
          <form action={make} className="card stack" style={{ gap: 12 }}>
            <input type="hidden" name="courseId" value={course.id} />
            <input type="hidden" name="what" value={what} />
            <div className="fieldset">
              <label htmlFor="cr-title">{titleWord}</label>
              <input id="cr-title" name="title" className="field" maxLength={200} required autoFocus />
            </div>
            {whereSelect("unitId", "cr-where")}
            {what === "assignment" && (
              <fieldset className="choice">
                <legend>{d.kind}</legend>
                <div className="choice-opts">
                  <label><input type="radio" name="kind" value="online" defaultChecked /> <span>{d.kindOnline}</span></label>
                  <label><input type="radio" name="kind" value="offline" /> <span>{d.kindOffline}</span></label>
                </div>
              </fieldset>
            )}
            {what === "page" && <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.crPageNext}</p>}
            <div className="row">
              <button className="btn btn-primary" type="submit">{d.create}</button>
              <Link className="btn" href={back}>{d.cancel}</Link>
            </div>
          </form>
        )}

        {what === "upload" && (
          <section className="card stack" style={{ gap: 12 }}>
            {wherePicker}
            <UploadFiles courseId={course.id} d={d} unitId={folder?.id} />
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.crHiddenFirst}</p>
            <div><Link className="btn" href={back}>{d.crBackToClass}</Link></div>
          </section>
        )}

        {MATERIAL_BLOCKS[what] && (
          <section className="card stack" style={{ gap: 12 }}>
            {wherePicker}
            <ResourceForm courseId={course.id} d={d} unitId={folder?.id} kinds={MATERIAL_BLOCKS[what]!} start={MATERIAL_BLOCKS[what]![0]} doneHref={back} />
            <div><Link className="btn" href={back}>{d.cancel}</Link></div>
          </section>
        )}

        {what === "lti" && (
          <section className="card stack" style={{ gap: 12 }}>
            {wherePicker}
            <ToolPicker tools={tools} courseId={course.id} d={d} unitId={folder?.id} doneHref={back} />
            <div><Link className="btn" href={back}>{d.cancel}</Link></div>
          </section>
        )}
      </main>
    </>
  );
}
