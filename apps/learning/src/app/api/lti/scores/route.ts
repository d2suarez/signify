import { NextResponse } from "next/server";
import { assignmentAccess, studentsOf } from "@/lib/access";
import { kickScores, retryScores, scoreStatuses } from "@/lib/lti-ags";
import { placements } from "@/lib/lti-dl";

export const dynamic = "force-dynamic";

async function teacher(assignmentId: string) {
  const access = await assignmentAccess(assignmentId);
  return access && access.course.role === "teacher" ? access : null;
}

/** Where this assignment is placed in Schoology and how each grade's sending went. ?assignmentId= (&studentId=) */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const access = await teacher(url.searchParams.get("assignmentId") || "");
  if (!access) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const only = url.searchParams.get("studentId");
  const [placed, rows] = await Promise.all([
    placements(access.me.tenantId, "assignment", access.assignment.id),
    scoreStatuses(access.me.tenantId, access.assignment.id),
  ]);
  let names = new Map<string, string>();
  if (!only) {
    const { students } = await studentsOf(access);
    names = new Map(students.map((s) => [s.id, s.name]));
  }
  const list = rows.filter((r) => !only || r.studentId === only)
    .map((r) => ({ ...r, name: names.get(r.studentId) || "" }));
  return NextResponse.json({ placements: placed, scores: list });
}

/** Retry now. Body: { assignmentId, studentId? } */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({})) as { assignmentId?: string; studentId?: string };
  const access = await teacher(String(body.assignmentId || ""));
  if (!access) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const n = await retryScores(access.me.tenantId, access.assignment.id, body.studentId ? String(body.studentId) : undefined);
  if (n) kickScores();
  return NextResponse.json({ retried: n });
}
