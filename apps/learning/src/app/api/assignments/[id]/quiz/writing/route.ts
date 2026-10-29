import { NextResponse } from "next/server";
import { assignmentAccess, ctx } from "@/lib/access";
import { essayWriting } from "@/lib/quiz-store";
import { summarize } from "@/lib/writing";

export const dynamic = "force-dynamic";

/** How one essay answer was written: snapshots and pastes, for the replay. Teachers only. ?attempt=&item= */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await assignmentAccess(id);
  if (!access || access.assignment.kind !== "quiz") return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (access.course.role !== "teacher") return NextResponse.json({ error: "Only the course's teachers can see this." }, { status: 403 });
  const url = new URL(req.url);
  const events = await essayWriting(ctx(access.me), access.assignment.id, url.searchParams.get("attempt") || "", (url.searchParams.get("item") || "").slice(0, 64));
  return NextResponse.json({ events, summary: summarize(events) }, { headers: { "Cache-Control": "no-store" } });
}
