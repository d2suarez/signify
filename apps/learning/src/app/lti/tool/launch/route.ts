import { readMe, myClasses } from "@/lib/auth";
import { courseFor } from "@/lib/courses";
import { getLesson } from "@/lib/lessons";
import { getAssignment } from "@/lib/assignments";
import { getLink, getTool, startToolLaunch } from "@/lib/lti-platform";
import { ourOrigin } from "@/lib/lti-http";
import { langOf } from "../../respond";
import { postTo, toolRefuse } from "../respond";

export const dynamic = "force-dynamic";

/**
 * A person presses a placed tool (in a tab, or as the lesson's tool frame).
 * They must be in the course per Signify ID now; a student only where the
 * tool is in a lesson's blocks or a published assignment. The tool learns
 * the course role and only the personal data the school allows it.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const me = await readMe();
  if (!me) return Response.redirect(new URL(`/auth/login?return=${encodeURIComponent(url.pathname + url.search)}`, ourOrigin(req.headers)), 302);
  const link = await getLink(me.tenantId, url.searchParams.get("link") || "");
  if (!link) return toolRefuse(req, "toolNotFound", 404);
  const { classes } = await myClasses();
  const course = await courseFor(me.tenantId, link.courseId, classes);
  if (!course) return toolRefuse(req, "toolNotInCourse", 403);
  const ctx = { tenantId: me.tenantId, userId: me.id };
  if (link.lessonId) {
    const lesson = await getLesson(ctx, link.lessonId);
    if (!lesson || lesson.courseId !== course.id) return toolRefuse(req, "toolNotFound", 404);
    if (course.role === "student" && !lesson.blocks.some((b) => b.type === "tool" && b.linkId === link.id)) return toolRefuse(req, "toolNotFound", 404);
  } else if (link.assignmentId) {
    const a = await getAssignment(ctx, link.assignmentId);
    if (!a || a.courseId !== course.id || (course.role === "student" && !a.published)) return toolRefuse(req, "toolNotFound", 404);
  }
  const tool = await getTool(me.tenantId, link.toolId);
  if (!tool) return toolRefuse(req, "toolRemoved", 404);
  const r = await startToolLaunch({
    me, role: course.role, tool, course: { id: course.id, name: course.name }, what: { kind: "link", link },
    presentation: url.searchParams.get("target") === "frame" ? "iframe" : "window", lang: langOf(req), origin: ourOrigin(req.headers),
  });
  return postTo(req, r.loginUrl, r.params);
}
