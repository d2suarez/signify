import { NextResponse } from "next/server";
import { assignmentAccess, ctx } from "@/lib/access";
import { setClosesAt } from "@/lib/assignments";
import { dueFrom } from "@/lib/cartridge";
import { SCHOOL_TZ } from "@/lib/school-grading";

export const dynamic = "force-dynamic";

/**
 * Stop accepting work (migration 044), teachers only. Body:
 *   { at: "now" }                      stop now
 *   { on: "YYYY-MM-DD", time: "HH:MM" } stop then, on the school's clock
 *   { at: null }                       accept work again
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await assignmentAccess(id);
  if (!access || access.course.role !== "teacher") return NextResponse.json({ error: "Not found." }, { status: 404 });
  let body: Record<string, unknown> | null = null;
  try { body = JSON.parse((await req.text()).slice(0, 2000)); } catch { /* refused below */ }
  if (!body || typeof body !== "object") return NextResponse.json({ error: "That wasn't a request." }, { status: 400 });
  let at: unknown;
  if (body.at === "now" || body.at === null) at = body.at;
  else if (typeof body.on === "string" && typeof body.time === "string" && /^\d{2}:\d{2}$/.test(body.time)) {
    const when = dueFrom(`${body.on}T${body.time}`, SCHOOL_TZ);
    if (!when) return NextResponse.json({ error: "date" }, { status: 400 });
    at = when.dueAt;
  } else return NextResponse.json({ error: "date" }, { status: 400 });
  const r = await setClosesAt(ctx(access.me), access.assignment.id, at);
  if (!r.ok) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ closesAt: r.closesAt });
}
