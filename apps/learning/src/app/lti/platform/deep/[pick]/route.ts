import { acceptDeepLink } from "@/lib/lti-platform";
import { framePage } from "@/lib/lti-html";
import { ourOrigin } from "@/lib/lti-http";
import { dict } from "@/lib/i18n";
import { langOf } from "../../../respond";
import { html, toolRefuse } from "../../../tool/respond";

export const dynamic = "force-dynamic";

/**
 * The tool's Deep Linking answer, form-posted by the teacher's browser. The
 * signed answer, not the browser, says what was chosen (the Signify cookie
 * doesn't come on a cross-site POST); the pick says for whom and where.
 */
export async function POST(req: Request, { params }: { params: Promise<{ pick: string }> }) {
  const form = await req.formData().catch(() => null);
  const r = await acceptDeepLink(String(form?.get("JWT") ?? ""), (await params).pick, ourOrigin(req.headers));
  if (!r.ok) return toolRefuse(req, r.error);
  const lang = langOf(req);
  const d = dict(lang);
  const n = r.pick.items.length;
  const back = r.pick.place === "lesson" ? `/lessons/${r.pick.lessonId}/edit`
    : n === 1 && r.pick.items[0].assignmentId ? `/assignments/${r.pick.items[0].assignmentId}` : `/courses/${r.pick.courseId}`;
  const body = n ? (r.pick.place === "lesson" ? d.toolPickedLesson : d.toolPickedAssignment).replace("{n}", String(n)) : d.toolPickedNothing;
  const page = framePage({ lang, title: n ? d.toolPickedTitle : d.toolPickedNone, body, note: r.msg || undefined })
    .replace("</main>", `<p><a class="btn" href="${back}">${d.toolBack}</a></p></main>`);
  return html(page, "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
}
