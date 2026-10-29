import { readMe } from "@/lib/auth";
import { getLink, getTool, toolFlowCsp, toolOrigins } from "@/lib/lti-platform";
import { escapeHtml } from "@/lib/lti-html";
import { dict } from "@/lib/i18n";
import { langOf } from "../../../respond";
import { html, toolRefuse } from "../../respond";

export const dynamic = "force-dynamic";

/**
 * The tool frame inside a lesson. The lesson page frames only our own
 * origin, so this page holds the sandboxed frame and names the tool's
 * origins (frame-src) for the launch's hops: our launch, the tool's login,
 * our auth, the tool's redirect URI. The tool never gets top navigation.
 */
export async function GET(req: Request, { params }: { params: Promise<{ link: string }> }) {
  const me = await readMe();
  if (!me) return toolRefuse(req, "toolSignIn", 401);
  const link = await getLink(me.tenantId, (await params).link);
  const tool = link ? await getTool(me.tenantId, link.toolId) : null;
  if (!link || !tool) return toolRefuse(req, "toolNotFound", 404);
  const lang = langOf(req);
  const title = escapeHtml(link.title || tool.name);
  const src = `/lti/tool/launch?link=${link.id}&target=frame`;
  const body = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${title}</title>
<style>html,body{margin:0;height:100%;background:#fff}iframe{border:0;width:100%;height:100%;display:block}</style></head>
<body><iframe src="${src}" title="${title}" allow="fullscreen" referrerpolicy="no-referrer"
sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads"></iframe>
<noscript>${escapeHtml(dict(lang).toolContinue)}</noscript></body></html>`;
  return html(body, toolFlowCsp([], toolOrigins(tool)));
}
