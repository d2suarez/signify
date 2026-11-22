import { NextResponse } from "next/server";
import { courseAccess, ctx } from "@/lib/access";
import { setClassStudentWidgets } from "@/lib/widget-store";

export const dynamic = "force-dynamic";

/**
 * The tools students get by default in this class. The class's teachers,
 * only when the school lets teachers choose, and only tools the school
 * allows students. Body: { widgets: kinds } or { widgets: null } (the school's).
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await courseAccess(id);
  if (!access) return NextResponse.json({ error: "Not found." }, { status: 404 });
  let body: Record<string, unknown>;
  try {
    const text = await req.text();
    if (text.length > 2_000) return NextResponse.json({ error: "Too large." }, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "That wasn't a list of tools." }, { status: 400 });
  }
  const r = await setClassStudentWidgets(ctx(access.me), access.course.id, access.course.role, body.widgets === null ? null : body.widgets);
  if (r.ok) return NextResponse.json({ chosen: r.chosen });
  return NextResponse.json({ error: r.reason }, { status: 403 });
}
