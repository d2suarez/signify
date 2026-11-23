import { NextResponse } from "next/server";
import { ctx, lessonAccess, updatesViewer } from "@/lib/access";
import { afterClass } from "@/lib/organize";
import { recordPresentation } from "@/lib/course-standards";
import { todayIn } from "@/lib/planner";

export const dynamic = "force-dynamic";

/**
 * The teacher ended a live presentation (story 01, E1). Body: { keep } — the
 * presenter's "students keep these slides" switch. Returns what students see now.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await lessonAccess(id);
  if (!access) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (access.course.role !== "teacher") return NextResponse.json({ error: "Only the course's teachers can." }, { status: 403 });
  let keep = true;
  try { keep = (await req.json())?.keep !== false; } catch { /* no body: the default */ }
  const viewer = await updatesViewer();
  if (!viewer) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const view = await afterClass(viewer, access.course.id, access.lesson.id, keep);
  if (!view) return NextResponse.json({ error: "Not found." }, { status: 404 });
  // Counts as taught today for the class's standards coverage (one school, its own day).
  await recordPresentation(ctx(access.me), access.course.id, access.lesson.id, todayIn("America/New_York")).catch(() => {});
  return NextResponse.json({ view });
}
