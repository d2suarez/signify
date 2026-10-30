import { NextResponse } from "next/server";
import { lessonAccess, ctx } from "@/lib/access";
import { setLessonStandards } from "@/lib/lessons";

export const dynamic = "force-dynamic";

/** Which course standards a lesson addresses. Body: { standards: [ids] }. Answers what was kept. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await lessonAccess(id);
  if (!access) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (access.course.role !== "teacher") return NextResponse.json({ error: "Only the course's teachers can change it." }, { status: 403 });
  let body: { standards?: unknown };
  try {
    const text = await req.text();
    if (text.length > 50_000) return NextResponse.json({ error: "Too large." }, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "That wasn't a list of standards." }, { status: 400 });
  }
  const kept = await setLessonStandards(ctx(access.me), id, body.standards);
  if (!kept) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ standards: kept });
}
