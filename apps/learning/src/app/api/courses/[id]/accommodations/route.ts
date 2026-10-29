import { NextResponse } from "next/server";
import { courseAccess, ctx, studentsOf } from "@/lib/access";
import { setAccommodation } from "@/lib/quiz-store";

export const dynamic = "force-dynamic";

/**
 * A student's quiz accommodations in this course (extra time, extra
 * attempts). The course's teachers only, for a student Signify ID says is
 * in the class now. Body: { studentId, timeFactor, extraAttempts }.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await courseAccess(id);
  if (!access) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (access.course.role !== "teacher") return NextResponse.json({ error: "Only the course's teachers can set this." }, { status: 403 });
  let body: Record<string, unknown>;
  try {
    const text = await req.text();
    if (text.length > 2_000) return NextResponse.json({ error: "Too long." }, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "That wasn't an accommodation." }, { status: 400 });
  }
  const { ok, students } = await studentsOf(access);
  if (!ok) return NextResponse.json({ error: "roster" }, { status: 503 });
  const r = await setAccommodation(ctx(access.me), access.course.id, String(body.studentId || ""), new Set(students.map((s) => s.id)), body);
  if (!r) return NextResponse.json({ error: "not-a-student" }, { status: 403 });
  return NextResponse.json({ accommodation: r });
}
