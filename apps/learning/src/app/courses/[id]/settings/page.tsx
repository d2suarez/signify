import Link from "next/link";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireMe } from "@/lib/auth";
import { courseAccess, ctx, lang } from "@/lib/access";
import { addCategory, deleteCategory, isWeighted, listCategories, setWeighted, updateCategory } from "@/lib/grades";
import { dict } from "@/lib/i18n";
import { TopBar } from "@/components/TopBar";
import { CourseNav } from "@/components/CourseNav";

export const dynamic = "force-dynamic";

async function act(formData: FormData) {
  "use server";
  const access = await courseAccess(String(formData.get("courseId") || ""));
  if (!access || access.course.role !== "teacher") return;
  const c = ctx(access.me), courseId = access.course.id;
  const op = String(formData.get("op") || "");
  if (op === "method") await setWeighted(c, courseId, formData.get("method") === "weighted");
  if (op === "add") await addCategory(c, courseId, formData.get("name"), formData.get("weight"));
  if (op === "update") await updateCategory(c, courseId, String(formData.get("categoryId")), formData.get("name"), formData.get("weight"));
  if (op === "delete") await deleteCategory(c, courseId, String(formData.get("categoryId")));
  revalidatePath(`/courses/${courseId}/settings`);
}

export default async function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
  await requireMe();
  const { id } = await params;
  const d = dict(await lang());
  const access = await courseAccess(id);
  if (!access || access.course.role !== "teacher") notFound();
  const { me, course } = access;
  const [weighted, categories] = await Promise.all([isWeighted(ctx(me), course.id), listCategories(ctx(me), course.id)]);
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
            <label className="check" style={{ fontSize: 15 }}><input type="radio" name="method" value="points" defaultChecked={!weighted} /> {d.byPoints}</label>
            <br />
            <label className="check" style={{ fontSize: 15, marginTop: 6 }}><input type="radio" name="method" value="weighted" defaultChecked={weighted} /> {d.byWeight}</label>
          </fieldset>
          <button className="btn btn-primary" style={{ alignSelf: "flex-start" }}>{d.save}</button>
        </form>

        <section className="card" aria-labelledby="cats">
          <p className="label" id="cats">{d.categories}</p>
          <ul className="list" style={{ marginTop: 8 }}>
            {categories.map((c) => (
              <li key={c.id}>
                <form action={act} className="row grow">
                  <input type="hidden" name="courseId" value={course.id} />
                  <input type="hidden" name="categoryId" value={c.id} />
                  <input name="name" className="field" style={{ flex: "1 1 200px", width: "auto" }} defaultValue={c.name} maxLength={60} aria-label={d.name} required />
                  <input name="weight" type="number" min={0} max={1000} step="any" className="field" style={{ width: 110 }} defaultValue={c.weight} aria-label={d.weight} />
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
                <button className="btn btn-primary btn-sm" name="op" value="add">{d.addCategory}</button>
              </form>
            </li>
          </ul>
          {weighted && categories.length > 0 && (
            <p className="muted" style={{ fontSize: 13 }}>{d.weightsTotal} {total}%. {total !== 100 ? d.weightsScaled : ""}</p>
          )}
          <p className="muted" style={{ fontSize: 13 }}>{d.scaleNote}</p>
        </section>

        <section className="card stack" style={{ gap: 6 }} aria-labelledby="import-title">
          <h2 className="label" id="import-title">{d.importCourse}</h2>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>{d.importCourseHint}</p>
          <Link className="btn" style={{ alignSelf: "flex-start" }} href={`/courses/${course.id}/import`}>{d.importChoose}</Link>
        </section>
      </main>
    </>
  );
}
