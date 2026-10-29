import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMe } from "@/lib/auth";
import { assignmentAccess, ctx, lang, studentsOf } from "@/lib/access";
import { isLate, listSubmissions } from "@/lib/assignments";
import { gradesFor } from "@/lib/grades";
import { dict } from "@/lib/i18n";
import { courseGrading, listStandards } from "@/lib/standards";
import { alignedStandards, levelLabel, levelWords, topLevel } from "@/lib/standards-math";
import { TopBar } from "@/components/TopBar";
import GradeDesk, { type DeskStandards, type DeskStudent } from "@/components/GradeDesk";
import { placements } from "@/lib/lti-dl";

export const dynamic = "force-dynamic";

export default async function GradePage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ student?: string }>;
}) {
  await requireMe();
  const { id } = await params;
  const { student } = await searchParams;
  const L = await lang();
  const d = dict(L);
  const access = await assignmentAccess(id);
  if (!access || access.course.role !== "teacher") notFound();
  const { me, course, assignment: a } = access;
  const c = ctx(me);
  const [{ ok, students }, subs, grades, placed, grading, allStandards] = await Promise.all([
    studentsOf(access), listSubmissions(c, a.id), gradesFor(c, a.id), placements(me.tenantId, "assignment", a.id),
    courseGrading(c, course.id), listStandards(c, course.id),
  ]);
  let standards: DeskStandards | undefined;
  if (grading.mode === "standards") {
    const aligned = alignedStandards(a);
    const top = topLevel(grading.settings);
    standards = {
      list: allStandards.filter((s) => aligned.includes(s.id)).map((s) => ({ id: s.id, code: s.code, description: s.description })),
      labels: Array.from({ length: top }, (_, i) => levelLabel(grading.settings, top - i, levelWords(d))),
    };
  }
  const subBy = new Map(subs.map((s) => [s.studentId, s]));
  const gradeBy = new Map(grades.map((g) => [g.studentId, g]));

  const desk: DeskStudent[] = students.map((s) => {
    const sub = subBy.get(s.id) || null;
    const g = gradeBy.get(s.id) || null;
    return {
      id: s.id, name: s.name,
      body: sub?.body ?? null,
      submittedAt: sub?.submittedAt ?? null,
      late: isLate(a, sub),
      score: g?.score ?? null, flag: g?.flag ?? null, comment: g?.comment ?? "", rubric: g?.rubric ?? null, levels: g?.levels ?? null,
    };
  });

  return (
    <>
      <TopBar crumbs={<><Link href="/">{d.myCourses}</Link> · <Link href={`/courses/${course.id}`}>{course.name}</Link> · <Link href={`/assignments/${a.id}`}>{a.title}</Link></>} />
      <main className="page stack">
        <div className="row">
          <h1 style={{ fontSize: 30 }} className="grow">{a.title}</h1>
          <span className="muted">{a.points} {d.pts}</span>
          <Link className="btn" href={`/courses/${course.id}/gradebook`}>{d.gradebook}</Link>
        </div>
        {!ok && <div className="notice notice-bad" role="alert">{d.rosterFailed}</div>}
        {ok && desk.length === 0 && <p className="empty">{d.noStudents}</p>}
        {ok && desk.length > 0 && (
          <GradeDesk assignment={{ id: a.id, points: a.points, kind: a.kind, gradesReleased: a.gradesReleased, rubric: a.rubric }}
            students={desk} startWith={student} schoology={placed.length > 0} standards={standards} d={d} />
        )}
      </main>
    </>
  );
}
