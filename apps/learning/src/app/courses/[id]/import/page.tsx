import Link from "next/link";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireMe } from "@/lib/auth";
import { academicAccess as courseAccess, lang, updatesViewer, ctx } from "@/lib/access";
import { listImports, undoImport } from "@/lib/organize";
import { dict } from "@/lib/i18n";
import { MAX_UPLOAD } from "@/lib/cc-import";
import { TopBar } from "@/components/TopBar";
import { ClassHeader } from "@/components/ClassHeader";
import ImportCourse from "@/components/ImportCourse";

export const dynamic = "force-dynamic";

async function undo(formData: FormData) {
  "use server";
  const access = await courseAccess(String(formData.get("courseId") || ""));
  if (!access || access.course.role !== "teacher") return;
  const viewer = await updatesViewer();
  if (!viewer) return;
  await undoImport(viewer, access.course.id, String(formData.get("importId") || ""));
  revalidatePath(`/courses/${access.course.id}/import`);
  revalidatePath(`/courses/${access.course.id}`);
}

/** Bring a Schoology (Common Cartridge) course export into this course. Teachers only. */
export default async function ImportPage({ params }: { params: Promise<{ id: string }> }) {
  await requireMe();
  const { id } = await params;
  const L = await lang();
  const d = dict(L);
  const access = await courseAccess(id);
  if (!access || access.course.role !== "teacher") notFound();
  const { course } = access;
  const past = await listImports(ctx(access.me), course.id);
  return (
    <>
      <TopBar crumbs={<Link href="/">{d.myCourses}</Link>} below={<ClassHeader course={course} d={d} tab="settings" />} />
      <main className="page stack" style={{ maxWidth: 860 }}>
        <h1 style={{ fontSize: 34 }}>{d.importCourse}</h1>
        <ImportCourse courseId={course.id} courseName={course.name} maxBytes={MAX_UPLOAD} d={d} />
        {past.length > 0 && (
          <section className="card stack" aria-labelledby="past-imports" style={{ gap: 8 }}>
            <h2 id="past-imports" className="label">{d.importPast}</h2>
            <ul className="list">
              {past.map((p) => (
                <li key={p.id}>
                  <div className="grow">
                    <h3 style={{ overflowWrap: "anywhere" }}>{p.fileName || d.importPastNoName}</h3>
                    <span className="muted" style={{ fontSize: 13 }}>
                      {new Date(p.createdAt).toLocaleString(L === "es" ? "es" : "en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" })}
                      {" · "}{d.importPastCounts.replace("{l}", String(p.lessons)).replace("{a}", String(p.assignments)).replace("{u}", String(p.units))}
                      {p.undoneAt ? ` · ${d.importUndone}` : ""}
                    </span>
                  </div>
                  {(p.lessons > 0 || p.assignments > 0 || (!p.undoneAt && p.units > 0)) && (
                    <form action={undo}>
                      <input type="hidden" name="courseId" value={course.id} />
                      <input type="hidden" name="importId" value={p.id} />
                      <button className="btn btn-sm" type="submit">{d.importUndo}</button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>{d.importUndoHint}</p>
          </section>
        )}
      </main>
    </>
  );
}
