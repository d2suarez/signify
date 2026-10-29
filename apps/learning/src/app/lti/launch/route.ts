import { checkLaunch } from "@/lib/lti";
import { cookieStates, ourOrigin } from "@/lib/lti-http";
import { framePage } from "@/lib/lti-html";
import { dict } from "@/lib/i18n";
import { langOf, ltiHeaders, refuse } from "../respond";

export const dynamic = "force-dynamic";

/**
 * The platform posts the signed id_token here. A good launch is kept, and the
 * page (inside the platform's frame) offers to open it in a new tab, where the
 * person's own Signify sign-in decides who they are. Outside a frame it goes
 * straight on.
 */
export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const idToken = String(form?.get("id_token") ?? "");
  const state = String(form?.get("state") ?? "");
  if (form?.get("error")) return refuse(req, "ltiPlatformError");
  const r = await checkLaunch(idToken, state, cookieStates(req.headers.get("cookie")), ourOrigin(req.headers));
  if (!r.ok) return refuse(req, r.error, r.platform);
  const lang = langOf(req);
  const d = dict(lang);
  const html = framePage({
    lang,
    title: r.launch.contextTitle || d.appName,
    body: d.ltiOpenBody,
    button: { href: `/launch/${r.launch.id}`, label: d.ltiOpen },
    note: d.ltiOpenNote,
    autoOpen: true,
  });
  return new Response(html, { headers: ltiHeaders(r.platform, { "content-type": "text/html; charset=utf-8" }) });
}
