import { takeResponse } from "@/lib/lti-dl";
import { ltiHeaders } from "../../respond";

export const dynamic = "force-dynamic";

/**
 * The platform's frame asks whether the teacher has chosen. The answer (a
 * signed LtiDeepLinkingResponse) is handed out once; the launch id is the
 * only key, and only the frame and the teacher's tab have it.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await takeResponse(id);
  const body = r.state === "ready" ? { state: r.state, returnUrl: r.returnUrl, jwt: r.jwt } : { state: r.state };
  return new Response(JSON.stringify(body), { headers: ltiHeaders(undefined, { "content-type": "application/json" }) });
}
