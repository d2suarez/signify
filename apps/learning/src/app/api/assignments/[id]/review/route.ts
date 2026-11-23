import { NextResponse } from "next/server";
import { assignmentAccess, ctx, studentsOf } from "@/lib/access";
import { setReviewed } from "@/lib/grade-review";

export const dynamic = "force-dynamic";

/**
 * "Mark reviewed" on the grading review screen (story 01). Body:
 * { studentIds: string[], reviewed: boolean }. The class's teachers only
 * (404 for anyone else); only students on the class list in Signify ID now.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await assignmentAccess(id);
  if (!access || access.course.role !== "teacher") return NextResponse.json({ error: "Not found." }, { status: 404 });
  let body: { studentIds?: unknown; reviewed?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad" }, { status: 400 }); }
  const ids = Array.isArray(body.studentIds) ? body.studentIds.filter((x): x is string => typeof x === "string") : [];
  if (!ids.length) return NextResponse.json({ error: "bad" }, { status: 400 });
  const { ok, students } = await studentsOf(access);
  if (!ok) return NextResponse.json({ error: "roster" }, { status: 503 });
  const reviewed = await setReviewed(ctx(access.me), access.assignment.id, ids, body.reviewed !== false, new Set(students.map((s) => s.id)));
  return NextResponse.json({ reviewed });
}
