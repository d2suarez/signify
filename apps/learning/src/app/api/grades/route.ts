import { NextResponse } from "next/server";
import { assignmentAccess, ctx, studentsOf } from "@/lib/access";
import { gradeHistory, setGrade } from "@/lib/grades";
import { passBack } from "@/lib/lti-passback";
import { gradeTargets } from "@/lib/group-work";
import { settleSuggestions } from "@/lib/suggestions";
import { cleanNotes } from "@/lib/rubric";
import type { Grade } from "@/lib/grades";

export const dynamic = "force-dynamic";

/**
 * Set one grade. Body: { assignmentId, studentId, score?, flag?, comment?, rubric?, levels?, late?, parts?, notes?, group?, suggestions? }
 * (suggestions: ids of the review screen's suggestions the teacher used on this student; this save settles them).
 * (group: true = the same grade for every member of the student's group on a group assignment).
 * (late = the teacher's change to the late penalty: {waive}, {percent}, {days} or null).
 * The student must be in the class in Signify ID right now; if ID can't be
 * asked, nothing is written.
 */
export async function PUT(req: Request) {
  let body: Record<string, unknown>;
  try {
    const text = await req.text();
    if (text.length > 400_000) return NextResponse.json({ error: "Too long." }, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "That wasn't a grade." }, { status: 400 });
  }
  const access = await assignmentAccess(String(body.assignmentId || ""));
  if (!access) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (access.course.role !== "teacher") return NextResponse.json({ error: "Only the course's teachers can grade." }, { status: 403 });

  const { ok, students } = await studentsOf(access);
  if (!ok) return NextResponse.json({ error: "roster" }, { status: 503 });
  const roster = new Set(students.map((s) => s.id));
  const studentId = String(body.studentId || "");
  const input = { score: body.score, flag: body.flag, comment: body.comment, rubric: body.rubric, levels: body.levels, late: body.late, parts: body.parts, notes: body.notes };
  // A group grade (story 01, F4): the same grade for every member of the student's group, each through setGrade
  // (history, late policy per member, passback), the named student first so a bad score stops before anyone changes.
  const targets = body.group === true ? await gradeTargets(ctx(access.me), access.assignment, studentId, roster) : [studentId];
  const order = [studentId, ...targets.filter((id) => id !== studentId)];
  const grades: Record<string, unknown> = {};
  let first: { grade: unknown; changed: boolean } | null = null;
  for (const id of order) {
    const r = await setGrade(ctx(access.me), access.assignment, id, roster, input);
    if (!r.ok) {
      if (!first) return NextResponse.json({ error: r.reason }, { status: r.reason === "bad-score" ? 400 : 403 });
      continue;
    }
    // Schoology gets it in the background; this save never waits for it.
    if (r.changed) await passBack(access, id);
    grades[id] = r.grade;
    if (!first) first = { grade: r.grade, changed: r.changed };
  }
  // Suggestions the teacher used become "accepted" or "changed" by what was actually saved (never before a save).
  if (body.suggestions !== undefined) {
    const g = first!.grade as Grade | null;
    await settleSuggestions(ctx(access.me), access.assignment.id, studentId, body.suggestions, {
      score: g?.score ?? null, comment: g?.comment ?? "", parts: g?.parts ?? null, notes: cleanNotes(access.assignment.rubric, body.notes),
    });
  }
  return NextResponse.json({ grade: first!.grade, changed: first!.changed, grades });
}

/** A grade's history. ?assignmentId=&studentId= */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const access = await assignmentAccess(url.searchParams.get("assignmentId") || "");
  if (!access || access.course.role !== "teacher") return NextResponse.json({ error: "Not found." }, { status: 404 });
  const history = await gradeHistory(ctx(access.me), access.assignment.id, url.searchParams.get("studentId") || "");
  return NextResponse.json({ history });
}
