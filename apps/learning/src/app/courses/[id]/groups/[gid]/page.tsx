import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { courseAccess, ctx, lang, studentsOf } from "@/lib/access";
import { requireMe } from "@/lib/auth";
import { copyGroupSet, getGroupSet, saveGroupSet } from "@/lib/group-sets";
import { dict, t } from "@/lib/i18n";
import { TopBar } from "@/components/TopBar";
import GroupsEditor from "@/components/GroupsEditor";

export const dynamic = "force-dynamic";

async function teacherAccess(formData: FormData) {
  const access = await courseAccess(String(formData.get("courseId") || ""));
  return access && access.course.role === "teacher" ? access : null;
}

async function archiveSet(formData: FormData) {
  "use server";
  const access = await teacherAccess(formData);
  if (!access) return;
  const { ok, students } = await studentsOf(access);
  if (!ok) return;
  // The newest version: the editor above may have saved since this page loaded.
  const cur = await getGroupSet(ctx(access.me), access.course.id, String(formData.get("id") || ""));
  if (!cur) return;
  await saveGroupSet(ctx(access.me), access.course.id, cur.id, { baseVersion: cur.version, archived: true }, new Map(students.map((s) => [s.id, s.name])));
  redirect(`/courses/${access.course.id}/groups`);
}

async function copySet(formData: FormData) {
  "use server";
  const access = await teacherAccess(formData);
  if (!access) return;
  const { ok, students } = await studentsOf(access);
  if (!ok) return;
  const L = await lang();
  const from = await getGroupSet(ctx(access.me), access.course.id, String(formData.get("id") || ""));
  if (!from) return;
  const set = await copyGroupSet(ctx(access.me), access.course.id, from.id, `${from.name} (${t("grpCopyWord", L)})`, new Map(students.map((s) => [s.id, s.name])));
  if (set) redirect(`/courses/${access.course.id}/groups/${set.id}`);
}

export default async function GroupSetPage({ params }: { params: Promise<{ id: string; gid: string }> }) {
  await requireMe();
  const { id, gid } = await params;
  const L = await lang();
  const d = dict(L);
  const access = await courseAccess(id);
  if (!access || access.course.role !== "teacher") notFound();
  const { me, course } = access;
  const set = await getGroupSet(ctx(me), course.id, gid);
  if (!set) notFound();
  const { ok, students } = await studentsOf(access);
  return (
    <>
      <TopBar crumbs={<><Link href="/">{d.myCourses}</Link> · <Link href={`/courses/${course.id}`}>{course.name}</Link> · <Link href={`/courses/${course.id}/groups`}>{d.grpTitle}</Link></>} />
      <main className="page stack">
        {!ok && <p className="notice" role="alert">{d.grpRosterFailed}</p>}
        <GroupsEditor courseId={course.id} initial={set} people={ok ? students.map((s) => ({ id: s.id, name: s.name })) : null} d={d} />
        <div className="row">
          <form action={copySet}>
            <input type="hidden" name="courseId" value={course.id} />
            <input type="hidden" name="id" value={set.id} />
            <button className="btn">{d.grpCopy}</button>
          </form>
          <form action={archiveSet}>
            <input type="hidden" name="courseId" value={course.id} />
            <input type="hidden" name="id" value={set.id} />
            <button className="btn">{d.grpArchive}</button>
          </form>
        </div>
      </main>
    </>
  );
}
