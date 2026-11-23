import { assignmentAccess, ctx, lang, studentsOf } from "@/lib/access";
import { isLate, listSubmissions } from "@/lib/assignments";
import { gradesFor } from "@/lib/grades";
import { assignmentPenalties } from "@/lib/gradebook";
import { finalScore } from "@/lib/late-policy";
import { reviewedFor } from "@/lib/grade-review";
import { assignmentGroups } from "@/lib/group-work";
import { dict } from "@/lib/i18n";
import { reviewCsv, type TableRow } from "@/lib/review";
import { SCHOOL_TZ } from "@/lib/school-grading";

/** "2026-11-20 09:05" on the school's clock. */
const when = (iso: string) => new Intl.DateTimeFormat("sv-SE", { timeZone: SCHOOL_TZ, dateStyle: "short", timeStyle: "short" }).format(new Date(iso));

export const dynamic = "force-dynamic";

/**
 * The review screen's Export (story 01): the whole class's grades for one
 * assignment as a CSV: sections, parts, total, percent, what it counts as
 * after the late policy, marks, reviewed, integrity concerns, feedback.
 * The class's teachers only (404 for anyone else); only students on the
 * class list now.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await assignmentAccess(id);
  if (!access || access.course.role !== "teacher") return new Response("Not found.", { status: 404 });
  const a = access.assignment;
  const c = ctx(access.me);
  const d = dict(await lang());
  const [{ ok, students }, subs, grades, reviewed, groups] = await Promise.all([
    studentsOf(access), listSubmissions(c, a.id), gradesFor(c, a.id), reviewedFor(c, a.id), assignmentGroups(c, a),
  ]);
  if (!ok) return new Response("Signify ID didn't answer with the class list. Try again.", { status: 503 });
  const concerns = await concernsByStudent(c, a.id, d);
  const late = await assignmentPenalties(c, a, grades);
  const subBy = new Map(subs.map((s) => [s.studentId, s]));
  const gradeBy = new Map(grades.map((g) => [g.studentId, g]));
  const groupOf = new Map((groups ?? []).flatMap((g) => g.members.map((m) => [m.id, g.name] as const)));
  const flagWord = (f: string | null) => (f === "missing" ? d.missing : f === "late" ? d.late : f === "exempt" ? d.exempt : null);
  const rows: TableRow[] = students.map((s) => {
    const g = gradeBy.get(s.id);
    const sub = subBy.get(s.id);
    const pen = late.byStudent.get(s.id)?.penalty ?? null;
    return {
      name: s.name, group: groupOf.get(s.id) ?? null, handedIn: sub?.submittedAt ? when(sub.submittedAt) : null,
      late: isLate(a, sub ?? null), score: g?.score ?? null, countsAs: g?.score != null ? finalScore(g.score, pen) : null,
      flag: flagWord(g?.flag ?? null), parts: g?.parts ?? null, comment: g?.comment ?? "", reviewed: reviewed.has(s.id),
      concerns: concerns.get(s.id) ?? [],
    };
  });
  const csv = reviewCsv(a.rubric, a.points, rows, {
    student: d.rvStudent, group: d.rvGroup, handedIn: d.handedIn, late: d.late, total: d.rvTotal, percent: d.rvPercent,
    countsAs: d.countsAs, flag: d.flag, reviewed: d.rvReviewed, concerns: d.icTitle, feedback: d.prFeedback, yes: d.rvYes, section: d.prSection,
  });
  const name = `${a.title} - grades.csv`;
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "no-store",
    },
  });
}

/** Commit 1: no integrity concerns yet. */
async function concernsByStudent(_c: unknown, _id: string, _d: unknown): Promise<Map<string, string[]>> {
  return new Map();
}
