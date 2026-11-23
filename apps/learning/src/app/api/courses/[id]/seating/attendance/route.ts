import { NextResponse } from "next/server";
import { courseAccess, ctx, studentsOf } from "@/lib/access";
import { AttendanceError, clearMark, classDay, takeAttendance } from "@/lib/attendance";
import { todayIn } from "@/lib/planner";
import { SCHOOL_TZ } from "@/lib/school-grading";

export const dynamic = "force-dynamic";

/**
 * Attendance from the seating slide (story 01, D6), today only, written to
 * the same records as the class's Attendance tab. Body:
 *   { studentId, status: "present" }  — tapped a seat
 *   { studentId, status: null }       — tapped again: not marked
 *   { rest: "absent" }                — everyone not yet marked is absent
 * Teachers only; only students Signify ID lists in the class now.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await courseAccess(id);
  if (!access) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (access.course.role !== "teacher") return NextResponse.json({ error: "Only the class's teachers." }, { status: 403 });
  let body: Record<string, unknown>;
  try {
    const text = await req.text();
    if (text.length > 1_000) return NextResponse.json({ error: "That is too large." }, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "That wasn't a mark." }, { status: 400 });
  }
  const { ok, students } = await studentsOf(access);
  if (!ok) return NextResponse.json({ error: "roster" }, { status: 503 });
  const roster = new Map(students.map((s) => [s.id, s.name]));
  const today = todayIn(SCHOOL_TZ);
  const c = ctx(access.me);
  try {
    if (body.rest === "absent") {
      const marked = await classDay(c, id, today);
      await takeAttendance(c, id, today, today, students.filter((s) => !marked.has(s.id)).map((s) => ({ studentId: s.id, status: "absent" })), roster);
    } else {
      const studentId = String(body.studentId ?? "");
      if (!roster.has(studentId)) return NextResponse.json({ error: "Not in this class." }, { status: 400 });
      if (body.status === null) await clearMark(c, id, today, today, studentId);
      else if (body.status === "present") await takeAttendance(c, id, today, today, [{ studentId, status: "present" }], roster);
      else return NextResponse.json({ error: "That wasn't a mark." }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof AttendanceError) return NextResponse.json({ error: e.code }, { status: 400 });
    throw e;
  }
  const marks = await classDay(c, id, today);
  return NextResponse.json({ marks: Object.fromEntries([...marks.values()].map((m) => [m.studentId, m.status])) }, { headers: { "Cache-Control": "no-store" } });
}
