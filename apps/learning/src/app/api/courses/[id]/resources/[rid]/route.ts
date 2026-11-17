import { NextResponse } from "next/server";
import { courseAccess, ctx } from "@/lib/access";
import { updateResource, ResourceError } from "@/lib/resources";
import { BlockError } from "@/lib/blocks";

export const dynamic = "force-dynamic";

/** Change a resource. Body: { block?, title?, note?, visible? }. Teachers only. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string; rid: string }> }) {
  const { id, rid } = await params;
  const access = await courseAccess(id);
  if (!access) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (access.course.role !== "teacher") return NextResponse.json({ error: "Only the course's teachers can change resources." }, { status: 403 });
  let body: Record<string, unknown>;
  try {
    const text = await req.text();
    if (text.length > 200_000) return NextResponse.json({ error: "That is too large." }, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "That wasn't a resource." }, { status: 400 });
  }
  try {
    const resource = await updateResource({ ...ctx(access.me), role: "teacher" }, id, rid,
      { block: body.block ?? undefined, title: body.title, note: body.note, visible: body.visible });
    return resource ? NextResponse.json({ resource }) : NextResponse.json({ error: "Not found." }, { status: 404 });
  } catch (e) {
    if (e instanceof ResourceError || e instanceof BlockError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
