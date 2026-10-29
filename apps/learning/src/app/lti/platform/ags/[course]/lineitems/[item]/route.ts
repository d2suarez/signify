import { lineItem, serviceAuth } from "@/lib/lti-platform-ags";
import { SCOPE } from "@/lib/lti-platform";
import { ourOrigin } from "@/lib/lti-http";

export const dynamic = "force-dynamic";

const H = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

export async function GET(req: Request, { params }: { params: Promise<{ course: string; item: string }> }) {
  const { course, item } = await params;
  const a = await serviceAuth(req.headers.get("authorization"), SCOPE.lineitemRead, course);
  if (!a.ok) return new Response(null, { status: a.status, headers: H });
  const li = await lineItem(a.tool, course, item, ourOrigin(req.headers));
  if (!li) return new Response(null, { status: 404, headers: H });
  return new Response(JSON.stringify(li), { headers: { ...H, "content-type": "application/vnd.ims.lis.v2.lineitem+json" } });
}
