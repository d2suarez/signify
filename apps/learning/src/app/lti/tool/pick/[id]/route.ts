import { readMe } from "@/lib/auth";
import { courseAccess } from "@/lib/access";
import { getPick, getTool, startToolLaunch } from "@/lib/lti-platform";
import { ourOrigin } from "@/lib/lti-http";
import { langOf } from "../../../respond";
import { postTo, toolRefuse } from "../../respond";

export const dynamic = "force-dynamic";

/** A teacher's Deep Linking launch into a tool's picker (their own tab). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await readMe();
  if (!me) return toolRefuse(req, "toolSignIn", 401);
  const pick = await getPick(me.tenantId, me.id, (await params).id);
  if (!pick || pick.state !== "waiting") return toolRefuse(req, "toolPickGone", 404);
  const access = await courseAccess(pick.courseId);
  if (!access || access.course.role !== "teacher") return toolRefuse(req, "toolNotInCourse", 403);
  const tool = await getTool(me.tenantId, pick.toolId);
  if (!tool) return toolRefuse(req, "toolRemoved", 404);
  const r = await startToolLaunch({
    me, role: "teacher", tool, course: { id: access.course.id, name: access.course.name },
    what: { kind: "pick", pick }, presentation: "window", lang: langOf(req), origin: ourOrigin(req.headers),
  });
  return postTo(req, r.loginUrl, r.params);
}
