import { NextResponse } from "next/server";
import { assignmentAccess, ctx, studentsOf } from "@/lib/access";
import { gradeHistory, setGrade } from "@/lib/grades";
import { passBack } from "@/lib/lti-passback";

export const dynamic = "force-dynamic";

/**
 * Set one grade. Body: { assignmentId, studentId, score?, flag?, comment?, rubric?, levels? }.
 * The student must be in the class in Signify ID right now; if ID can't be
 * asked, nothing is written.
 */
export async function PUT(req: Request) {
  let body: Record<string, unknown>;
  try {
    const text = await req.text();
    if (text.length > 20_000) return NextResponse.json({ error: "Too long." }, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "That wasn't a grade." }, { status: 400 });
  }
  const access = await assignmentAccess(String(body.assignmentId || ""));
  if (!access) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (access.course.role !== "teacher") return NextResponse.json({ error: "Only the course's teachers can grade." }, { status: 403 });

  const { ok, students } = await studentsOf(access);
  if (!ok) return NextResponse.json({ error: "roster" }, { status: 503 });
  const r = await setGrade(ctx(access.me), access.assignment, String(body.studentId || ""), new Set(students.map((s) => s.id)), {
    score: body.score, flag: body.flag, comment: body.comment, rubric: body.rubric, levels: body.levels,
  });
  if (r.ok) {
    // Schoology gets it in the background; this save never waits for it.
    if (r.changed) await passBack(access, String(body.studentId));
    return NextResponse.json({ grade: r.grade, changed: r.changed });
  }
  return NextResponse.json({ error: r.reason }, { status: r.reason === "bad-score" ? 400 : 403 });
}

/** A grade's history. ?assignmentId=&studentId= */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const access = await assignmentAccess(url.searchParams.get("assignmentId") || "");
  if (!access || access.course.role !== "teacher") return NextResponse.json({ error: "Not found." }, { status: 404 });
  const history = await gradeHistory(ctx(access.me), access.assignment.id, url.searchParams.get("studentId") || "");
  return NextResponse.json({ history });
}
