import { NextResponse } from "next/server";
import { lessonAccess, ctx } from "@/lib/access";
import { saveLesson } from "@/lib/lessons";
import { BlockError } from "@/lib/blocks";

export const dynamic = "force-dynamic";

/** Save a lesson. Body: { baseVersion, title?, blocks?, plannedFor?, durationMin? }. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await lessonAccess(id);
  if (!access) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (access.course.role !== "teacher") return NextResponse.json({ error: "Only the course's teachers can change it." }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    const text = await req.text();
    if (text.length > 2_000_000) return NextResponse.json({ error: "That lesson is too large to save." }, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "That wasn't a lesson." }, { status: 400 });
  }

  try {
    const r = await saveLesson(ctx(access.me), id, {
      baseVersion: Number(body.baseVersion),
      title: body.title, blocks: body.blocks, plannedFor: body.plannedFor, durationMin: body.durationMin,
    });
    if (r.ok) return NextResponse.json({ lesson: r.lesson, changed: r.changed });
    if (r.reason === "conflict") return NextResponse.json({ error: "conflict", lesson: r.lesson }, { status: 409 });
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  } catch (e) {
    if (e instanceof BlockError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
