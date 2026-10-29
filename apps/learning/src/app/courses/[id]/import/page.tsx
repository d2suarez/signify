import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMe } from "@/lib/auth";
import { courseAccess, lang } from "@/lib/access";
import { dict } from "@/lib/i18n";
import { MAX_UPLOAD } from "@/lib/cc-import";
import { TopBar } from "@/components/TopBar";
import { CourseNav } from "@/components/CourseNav";
import ImportCourse from "@/components/ImportCourse";

export const dynamic = "force-dynamic";

/** Bring a Schoology (Common Cartridge) course export into this course. Teachers only. */
export default async function ImportPage({ params }: { params: Promise<{ id: string }> }) {
  await requireMe();
  const { id } = await params;
  const d = dict(await lang());
  const access = await courseAccess(id);
  if (!access || access.course.role !== "teacher") notFound();
  const { course } = access;
  return (
    <>
      <TopBar crumbs={<><Link href="/">{d.myCourses}</Link> · <Link href={`/courses/${course.id}`}>{course.name}</Link></>} />
      <main className="page stack" style={{ maxWidth: 860 }}>
        <h1 style={{ fontSize: 34 }}>{d.importCourse}</h1>
        <CourseNav courseId={course.id} current="settings" d={d} />
        <ImportCourse courseId={course.id} courseName={course.name} maxBytes={MAX_UPLOAD} d={d} />
      </main>
    </>
  );
}
