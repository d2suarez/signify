import Link from "next/link";
import { notFound } from "next/navigation";
import { requireMe } from "@/lib/auth";
import { assignmentAccess, ctx, lang, studentsOf } from "@/lib/access";
import { isLate, listSubmissions } from "@/lib/assignments";
import { gradesFor, partNotesFor } from "@/lib/grades";
import { assignmentPenalties } from "@/lib/gradebook";
import { dict } from "@/lib/i18n";
import { courseGrading, listStandards } from "@/lib/standards";
import { alignedStandards, levelLabel, levelWords, topLevel } from "@/lib/standards-math";
import { TopBar } from "@/components/TopBar";
import GradeDesk, { type DeskStandards, type DeskStudent } from "@/components/GradeDesk";
import { placements } from "@/lib/lti-dl";
import { closeQuizForTeacher } from "@/lib/quiz-sync";
import GradingMaterials from "@/components/GradingMaterials";
import { listMaterials } from "@/lib/grading-materials";
import { isParts } from "@/lib/rubric";
import { assignmentGroups, listGroupWork, workFor } from "@/lib/group-work";
import { reviewedFor } from "@/lib/grade-review";
import { listConcerns } from "@/lib/integrity";
import { openSuggestions } from "@/lib/suggestions";
import { filesForStudents } from "@/lib/work-files";

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
  await closeQuizForTeacher(access);
  const { me, course, assignment: a } = access;
  const c = ctx(me);
  const [{ ok, students }, subs, grades, placed, grading, allStandards, groups, work, materials] = await Promise.all([
    studentsOf(access), listSubmissions(c, a.id), gradesFor(c, a.id), placements(me.tenantId, "assignment", a.id),
    courseGrading(c, course.id), listStandards(c, course.id), assignmentGroups(c, a), listGroupWork(c, a.id), listMaterials(c, a.id),
  ]);
  const review = isParts(a.rubric);
  const [notesBy, reviewed, concerns, suggestions] = review
    ? await Promise.all([partNotesFor(c, a.id), reviewedFor(c, a.id), listConcerns(c, a.id), openSuggestions(c, a.id)])
    : [new Map(), new Map<string, string>(), [], []];
  // Group work (story 01, F4): each student's group, and the group's shared text where they haven't handed in.
  const groupOf = new Map((groups ?? []).flatMap((g) => g.members.map((m) => [m.id, g] as const)));
  let standards: DeskStandards | undefined;
  if (grading.mode === "standards") {
    const aligned = alignedStandards(a);
    const top = topLevel(grading.settings);
    standards = {
      list: allStandards.filter((s) => aligned.includes(s.id)).map((s) => ({ id: s.id, code: s.code, description: s.description })),
      labels: Array.from({ length: top }, (_, i) => levelLabel(grading.settings, top - i, levelWords(d))),
    };
  }
  const late = await assignmentPenalties(c, a, grades);
  const subBy = new Map(subs.map((s) => [s.studentId, s]));
  const gradeBy = new Map(grades.map((g) => [g.studentId, g]));
  // Story 01 A7: each student's files (what they handed in, else their list so far).
  const filesBy = await filesForStudents(c, a, students.map((s) => s.id), subBy);

  const order = groups ? [...students].sort((x, y) => {
    const gx = groups.findIndex((g) => g.id === groupOf.get(x.id)?.id), gy = groups.findIndex((g) => g.id === groupOf.get(y.id)?.id);
    return (gx < 0 ? 999 : gx) - (gy < 0 ? 999 : gy);
  }) : students;
  const desk: DeskStudent[] = order.map((s) => {
    const sub = subBy.get(s.id) || null;
    const g = gradeBy.get(s.id) || null;
    return {
      id: s.id, name: s.name,
      body: groupOf.has(s.id) ? workFor(sub, work.get(groupOf.get(s.id)!.id) ?? null) : sub?.body ?? null,
      group: groupOf.has(s.id) ? { name: groupOf.get(s.id)!.name, ids: groupOf.get(s.id)!.members.map((m) => m.id) } : null,
      submittedAt: sub?.submittedAt ?? null,
      late: isLate(a, sub),
      score: g?.score ?? null, flag: g?.flag ?? null, comment: g?.comment ?? "", rubric: g?.rubric ?? null, levels: g?.levels ?? null,
      autoDays: late.byStudent.get(s.id)?.autoDays ?? null, lateOverride: g?.lateOverride ?? null,
      parts: g?.parts ?? null, notes: notesBy.get(s.id) ?? null, reviewedAt: reviewed.get(s.id) ?? null,
      files: filesBy.get(s.id) ?? null,
    };
  });

  return (
    <>
      <TopBar crumbs={<><Link href="/">{d.myCourses}</Link> · <Link href={`/courses/${course.id}`}>{course.name}</Link> · <Link href={`/assignments/${a.id}`}>{a.title}</Link></>} />
      <main className="page stack">
        {/* Sorted by group on a group assignment, so a group's members sit together. */}
        <div className="row">
          <h1 style={{ fontSize: 30 }} className="grow">{a.title}</h1>
          <span className="muted">{a.points} {d.pts}</span>
          {a.kind === "quiz" && <Link className="btn" href={`/assignments/${a.id}/results`}>{d.quizResults}</Link>}
          <Link className="btn" href={`/courses/${course.id}/gradebook`}>{d.gradebook}</Link>
          {a.kind === "online" && <a className="btn" href={`/api/assignments/${a.id}/download`} download>⬇ {d.zipAll}</a>}
          <a className="btn" href={`/api/assignments/${a.id}/table`} download title={d.rvCsvHint}>⬇ {d.rvCsv}</a>
        </div>
        <GradingMaterials assignmentId={a.id} courseId={course.id} initial={materials} editable={false} canUpload={false} d={d} />
        {!ok && <div className="notice notice-bad" role="alert">{d.rosterFailed}</div>}
        {ok && desk.length === 0 && <p className="empty">{d.noStudents}</p>}
        {ok && desk.length > 0 && (
          <GradeDesk assignment={{ id: a.id, points: a.points, kind: a.kind, gradesReleased: a.gradesReleased, rubric: a.rubric }}
            students={desk} startWith={student} schoology={placed.length > 0} standards={standards} lateRule={late.rule}
            concerns={concerns} suggestions={suggestions} d={d} />
        )}
      </main>
    </>
  );
}
