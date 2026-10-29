import { framePage } from "@/lib/lti-html";
import { autoPostPage, toolFlowCsp } from "@/lib/lti-platform";
import { dict, type Key } from "@/lib/i18n";
import { langOf } from "../respond";

const BASE = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" };

export function html(body: string, csp: string, status = 200): Response {
  return new Response(body, { status, headers: { ...BASE, "content-type": "text/html; charset=utf-8", "content-security-policy": csp } });
}

/** A refusal in our own pages of a tool's flow (in a tab, or in the lesson's tool frame). */
export function toolRefuse(req: Request, error: string, status = 400): Response {
  const lang = langOf(req);
  const d = dict(lang);
  return html(framePage({ lang, title: d.toolRefusedTitle, body: d[error as Key] ?? d.toolBadAuth }), toolFlowCsp([]), status);
}

/** Posts a form to a tool at once; forms may go only to that address's origin. */
export function postTo(req: Request, action: string, fields: Record<string, string>): Response {
  const lang = langOf(req);
  return html(autoPostPage({ lang, action, fields, label: dict(lang).toolContinue }), toolFlowCsp([new URL(action).origin]));
}
