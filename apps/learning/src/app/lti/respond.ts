import { launchCsp, type Platform } from "@/lib/lti";
import { framePage } from "@/lib/lti-html";
import { dict, pickLang, type Key } from "@/lib/i18n";

/** Every LTI response sets its own security headers (next.config leaves /lti/ alone). */
export function ltiHeaders(platform: Platform | undefined, extra: Record<string, string> = {}, csp: Parameters<typeof launchCsp>[1] = {}): Headers {
  const h = new Headers({
    "content-security-policy": launchCsp(platform, csp),
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "cache-control": "no-store",
    ...extra,
  });
  return h;
}

export function langOf(req: Request) {
  const c = /(?:^|;\s*)sl_lang=(\w+)/.exec(req.headers.get("cookie") || "");
  return pickLang(req.headers.get("accept-language"), c?.[1]);
}

/** A refusal, shown in the platform's frame when the platform is known. */
export function refuse(req: Request, error: string, platform?: Platform, status = 400): Response {
  const lang = langOf(req);
  const d = dict(lang);
  const body = d[error as Key] ?? d.ltiBadToken;
  return new Response(framePage({ lang, title: d.ltiRefusedTitle, body }), {
    status, headers: ltiHeaders(platform, { "content-type": "text/html; charset=utf-8" }),
  });
}
