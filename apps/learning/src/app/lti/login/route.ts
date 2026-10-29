import { startLogin } from "@/lib/lti";
import { cookieStates, ourOrigin, stateCookie } from "@/lib/lti-http";
import { ltiHeaders, refuse } from "../respond";

export const dynamic = "force-dynamic";

/** LTI 1.3 third-party login initiation. Platforms may use GET or a form POST. */
async function login(req: Request, params: URLSearchParams) {
  const get = (k: string) => params.get(k);
  const r = await startLogin({
    iss: get("iss"), login_hint: get("login_hint"), target_link_uri: get("target_link_uri"),
    lti_message_hint: get("lti_message_hint"), client_id: get("client_id"), lti_deployment_id: get("lti_deployment_id"),
  }, ourOrigin(req.headers));
  if (!r.ok) return refuse(req, r.error, r.platform);
  return new Response(null, {
    status: 302,
    headers: ltiHeaders(r.platform, {
      location: r.redirect,
      "set-cookie": stateCookie(r.state, cookieStates(req.headers.get("cookie"))),
    }),
  });
}

export async function GET(req: Request) {
  return login(req, new URL(req.url).searchParams);
}

export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const params = new URLSearchParams();
  form?.forEach((v, k) => { if (typeof v === "string") params.set(k, v); });
  return login(req, params);
}
