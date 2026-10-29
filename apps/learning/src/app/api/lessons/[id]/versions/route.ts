import { NextResponse } from "next/server";
import { lessonAccess, ctx } from "@/lib/access";
import { listVersions, restoreVersion } from "@/lib/lessons";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await lessonAccess(id);
  if (!access || access.course.role !== "teacher") return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ versions: await listVersions(ctx(access.me), id) });
}

/** Restore. Body: { version, baseVersion }. Saved as a new version, so it can be undone. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await lessonAccess(id);
  if (!access || access.course.role !== "teacher") return NextResponse.json({ error: "Not found." }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  const r = await restoreVersion(ctx(access.me), id, Number(body.version), Number(body.baseVersion));
  if (r.ok) return NextResponse.json({ lesson: r.lesson });
  if (r.reason === "conflict") return NextResponse.json({ error: "conflict", lesson: r.lesson }, { status: 409 });
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}
