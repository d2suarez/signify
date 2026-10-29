import { readMe } from "@/lib/auth";
import { authorize } from "@/lib/lti-platform";
import { postTo, toolRefuse } from "../../tool/respond";

export const dynamic = "force-dynamic";

/**
 * OIDC authentication for tools (the second hop of a launch). The browser
 * may not bring the Signify cookie here (a cross-site hop inside a frame),
 * so the one-time login hint is what ties it to the person; when the cookie
 * does come it must be the same person.
 */
async function auth(req: Request, p: URLSearchParams) {
  const me = await readMe();
  const r = await authorize(p, me && !me.dev ? me.id : null);
  if (!r.ok) return toolRefuse(req, r.error);
  return postTo(req, r.redirectUri, { id_token: r.idToken, ...(r.state ? { state: r.state } : {}) });
}

export async function GET(req: Request) {
  return auth(req, new URL(req.url).searchParams);
}

export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const p = new URLSearchParams();
  form?.forEach((v, k) => { if (typeof v === "string") p.set(k, v); });
  return auth(req, p);
}
