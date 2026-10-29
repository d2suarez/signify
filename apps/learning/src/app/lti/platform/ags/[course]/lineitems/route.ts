import { lineItems, serviceAuth } from "@/lib/lti-platform-ags";
import { SCOPE } from "@/lib/lti-platform";
import { ourOrigin } from "@/lib/lti-http";

export const dynamic = "force-dynamic";

const H = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

/** This tool's line items (its placed assignments) in one course. */
export async function GET(req: Request, { params }: { params: Promise<{ course: string }> }) {
  const { course } = await params;
  const a = await serviceAuth(req.headers.get("authorization"), SCOPE.lineitemRead, course);
  if (!a.ok) return new Response(null, { status: a.status, headers: H });
  const q = new URL(req.url).searchParams;
  const items = await lineItems(a.tool, course, ourOrigin(req.headers), {
    resourceLinkId: q.get("resource_link_id"), resourceId: q.get("resource_id"), tag: q.get("tag"),
  });
  return new Response(JSON.stringify(items), { headers: { ...H, "content-type": "application/vnd.ims.lis.v2.lineitemcontainer+json" } });
}

/** Line items are made by placing the tool as an assignment in Learning, never by the tool. */
export async function POST() {
  return Response.json({ error: "Line items are made in Signify Learning." }, { status: 403, headers: H });
}
