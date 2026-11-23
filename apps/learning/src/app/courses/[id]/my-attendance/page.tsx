import Link from "next/link";
import { notFound } from "next/navigation";
import { courseAccess, lang } from "@/lib/access";
import { requireMe } from "@/lib/auth";
import { studentAttendance } from "@/lib/my-attendance";
import { dict } from "@/lib/i18n";
import { TopBar } from "@/components/TopBar";
import { AttendanceSummary } from "@/components/AttendanceSummary";

export const dynamic = "force-dynamic";

/** A student's own attendance in one class (story 01, D6, read side). Only ever their own. */
export default async function MyAttendancePage({ params }: { params: Promise<{ id: string }> }) {
  await requireMe();
  const { id } = await params;
  const L = await lang();
  const d = dict(L);
  const access = await courseAccess(id);
  if (!access || access.course.role !== "student" || access.course.kind === "club") notFound();
  const { me, course } = access;
  const a = (await studentAttendance(me.tenantId, [course.id], me.id)).get(course.id)!;
  return (
    <>
      <TopBar crumbs={<><Link href="/">{d.myCourses}</Link> · <Link href={`/courses/${course.id}`}>{course.name}</Link></>} />
      <main className="page stack" style={{ maxWidth: 720 }}>
        <h1 style={{ fontSize: 30 }}>{d.attMine}</h1>
        <section className="card"><AttendanceSummary a={a} d={d} L={L} /></section>
      </main>
    </>
  );
}
