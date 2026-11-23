import { NextResponse } from "next/server";
import { assignmentAccess, ctx } from "@/lib/access";
import { addMaterial, listMaterials, MaterialError, removeMaterial } from "@/lib/grading-materials";

export const dynamic = "force-dynamic";

/**
 * Answer keys and grading materials on an assignment (story 01, A11).
 * The class's teachers only: anyone else gets "not found", as if there
 * were none. A file is uploaded first through /api/courses/<id>/files and
 * then attached here by its id.
 */
async function teacher(id: string) {
  const access = await assignmentAccess(id);
  return access && access.course.role === "teacher" ? access : null;
}
const none = () => NextResponse.json({ error: "Not found." }, { status: 404 });
const noStore = { "Cache-Control": "no-store" };

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await teacher(id);
  if (!access) return none();
  return NextResponse.json({ materials: await listMaterials(ctx(access.me), access.assignment.id) }, { headers: noStore });
}

/** Body: { role, title, fileId } or { role, title, url }. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await teacher(id);
  if (!access) return none();
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad" }, { status: 400 }); }
  try {
    const m = await addMaterial(ctx(access.me), { id: access.assignment.id, courseId: access.course.id }, body ?? {});
    return NextResponse.json({ material: m }, { status: 201, headers: noStore });
  } catch (e) {
    if (e instanceof MaterialError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

/** ?m=<material id> */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await teacher(id);
  if (!access) return none();
  const m = new URL(req.url).searchParams.get("m") || "";
  return (await removeMaterial(ctx(access.me), access.assignment.id, m)) ? NextResponse.json({ ok: true }) : none();
}
