import { NextResponse } from "next/server";
import { courseAccess, ctx } from "@/lib/access";
import { createResource, listResources, ResourceError } from "@/lib/resources";
import { BlockError } from "@/lib/blocks";

export const dynamic = "force-dynamic";

async function who(id: string) {
  const access = await courseAccess(id);
  return access ? { ...ctx(access.me), role: access.course.role } : null;
}

/** The course's resources: everything for its teachers, visible ones only for students. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const w = await who(id);
  if (!w) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ resources: await listResources(w, id) });
}

/** Add a resource. Body: { block } or { lessonId }, plus title?, note?, visible?. Teachers only. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const w = await who(id);
  if (!w) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (w.role !== "teacher") return NextResponse.json({ error: "Only the course's teachers can add resources." }, { status: 403 });
  let body: Record<string, unknown>;
  try {
    const text = await req.text();
    if (text.length > 200_000) return NextResponse.json({ error: "That is too large." }, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "That wasn't a resource." }, { status: 400 });
  }
  try {
    const resource = await createResource(w, id, { block: body.block, lessonId: body.lessonId, title: body.title, note: body.note, visible: body.visible });
    return NextResponse.json({ resource }, { status: 201 });
  } catch (e) {
    if (e instanceof ResourceError || e instanceof BlockError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
