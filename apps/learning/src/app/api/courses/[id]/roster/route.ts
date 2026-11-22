import { NextResponse } from "next/server";
import { courseAccess, studentsOf } from "@/lib/access";

export const dynamic = "force-dynamic";

/**
 * The class's students from Signify ID now, for the rail's name picker,
 * groups and seating chart. The class's teachers only: students never get
 * other students' names. ok:false = ID couldn't be asked (never "no one").
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await courseAccess(id);
  if (!access) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (access.course.role !== "teacher") return NextResponse.json({ error: "Only the class's teachers." }, { status: 403 });
  const { ok, students } = await studentsOf(access);
  return NextResponse.json({ ok, students: students.map((s) => ({ id: s.id, name: s.name })) }, { headers: { "Cache-Control": "no-store" } });
}
