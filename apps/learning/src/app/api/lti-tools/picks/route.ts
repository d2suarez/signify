import { readMe } from "@/lib/auth";
import { courseAccess, lessonAccess } from "@/lib/access";
import { getTool, placeToolPage, startPick } from "@/lib/lti-platform";

export const dynamic = "force-dynamic";

/**
 * A teacher adds a tool: into a lesson (`lessonId`) or as new assignments.
 * `direct` places the tool's own page in the lesson; otherwise a pick starts
 * and the browser opens /lti/tool/pick/<id> in a new tab.
 */
export async function POST(req: Request) {
  const me = await readMe();
  if (!me) return Response.json({ error: "sign-in" }, { status: 401 });
  const b = await req.json().catch(() => ({})) as { toolId?: string; courseId?: string; lessonId?: string; direct?: boolean };
  const access = await courseAccess(String(b.courseId || ""));
  if (!access || access.course.role !== "teacher") return Response.json({ error: "not-teacher" }, { status: 403 });
  let lessonId: string | null = null;
  if (b.lessonId) {
    const l = await lessonAccess(String(b.lessonId));
    if (!l || l.course.id !== access.course.id) return Response.json({ error: "not-found" }, { status: 404 });
    lessonId = l.lesson.id;
  }
  const tool = await getTool(me.tenantId, String(b.toolId || ""));
  if (!tool) return Response.json({ error: "not-found" }, { status: 404 });
  if (b.direct) {
    if (!lessonId) return Response.json({ error: "lesson-only" }, { status: 400 });
    const link = await placeToolPage(tool, me.id, access.course.id, lessonId);
    return Response.json({ state: "done", items: [{ linkId: link.id, title: link.title, display: "tab" }] });
  }
  if (!tool.deepLinkUrl) return Response.json({ error: "no-picker" }, { status: 400 });
  const pick = await startPick(tool, me.id, access.course.id, lessonId);
  return Response.json({ pickId: pick.id, open: `/lti/tool/pick/${pick.id}` });
}
