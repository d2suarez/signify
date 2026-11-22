import { NextResponse } from "next/server";
import { courseAccess, ctx, studentsOf } from "@/lib/access";
import { getSeating, saveSeating } from "@/lib/widget-store";

export const dynamic = "force-dynamic";

/** The class's seating chart (Signify ids only). The class's teachers only. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await courseAccess(id);
  if (!access) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const chart = await getSeating(ctx(access.me), access.course.id, access.course.role);
  if (!chart) return NextResponse.json({ error: "Only the class's teachers." }, { status: 403 });
  return NextResponse.json({ chart }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * Body: { layout: {rows, cols, seats: {"r-c": signifyId}}, baseVersion }.
 * Only students Signify ID lists in the class now are kept; when ID can't be
 * asked nothing is saved (a failed lookup must never empty a chart). Stale = 409.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await courseAccess(id);
  if (!access) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (access.course.role !== "teacher") return NextResponse.json({ error: "Only the class's teachers." }, { status: 403 });
  let body: Record<string, unknown>;
  try {
    const text = await req.text();
    if (text.length > 20_000) return NextResponse.json({ error: "Too large." }, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "That wasn't a seating chart." }, { status: 400 });
  }
  const { ok, students } = await studentsOf(access);
  if (!ok) return NextResponse.json({ error: "roster" }, { status: 503 });
  const r = await saveSeating(ctx(access.me), access.course.id, access.course.role, body.layout, body.baseVersion, new Set(students.map((s) => s.id)));
  if (r.ok) return NextResponse.json({ chart: r.chart });
  if (r.reason === "stale") return NextResponse.json({ error: "stale", current: r.current }, { status: 409 });
  return NextResponse.json({ error: "Only the class's teachers." }, { status: 403 });
}
