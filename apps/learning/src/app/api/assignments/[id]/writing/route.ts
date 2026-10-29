import { NextResponse } from "next/server";
import { assignmentAccess } from "@/lib/access";
import { getDb } from "@/lib/db";
import { summarize, writingEvents } from "@/lib/writing";

export const dynamic = "force-dynamic";

/**
 * How one student's work on this assignment was written: snapshots and
 * pastes, for the replay on the grading screen. The course's teachers only.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await assignmentAccess(id);
  if (!access) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (access.course.role !== "teacher") return NextResponse.json({ error: "Only the course's teachers can see this." }, { status: 403 });
  const student = new URL(req.url).searchParams.get("student") || "";
  if (!student || student.length > 80) return NextResponse.json({ error: "Which student?" }, { status: 400 });
  const events = await writingEvents(await getDb(), access.me.tenantId, access.assignment.id, student);
  return NextResponse.json({ events, summary: summarize(events) }, { headers: { "Cache-Control": "no-store" } });
}
