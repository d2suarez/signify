import { takeResponse } from "@/lib/lti-dl";
import { deepLinkPostPage, framePage } from "@/lib/lti-html";
import { dict } from "@/lib/i18n";
import { langOf, ltiHeaders } from "../../../respond";

export const dynamic = "force-dynamic";

/** The platform opened us in a window: the teacher's tab posts the answer back itself. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const lang = langOf(req);
  const d = dict(lang);
  const r = await takeResponse(id);
  if (r.state !== "ready") {
    return new Response(framePage({ lang, title: d.ltiDlTitle, body: d.ltiDlGone }), {
      status: 410, headers: ltiHeaders(undefined, { "content-type": "text/html; charset=utf-8" }),
    });
  }
  return new Response(deepLinkPostPage({ lang, returnUrl: r.returnUrl, jwt: r.jwt, label: d.ltiDlFrameSending }), {
    headers: ltiHeaders(undefined, { "content-type": "text/html; charset=utf-8" }, { postTo: r.returnUrl }),
  });
}
