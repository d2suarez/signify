import { postScore, serviceAuth } from "@/lib/lti-platform-ags";
import { SCOPE } from "@/lib/lti-platform";

export const dynamic = "force-dynamic";

const H = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

/** A tool's score for one student. Kept, then written to the gradebook by the normal grade path. */
export async function POST(req: Request, { params }: { params: Promise<{ course: string; item: string }> }) {
  const { course, item } = await params;
  const a = await serviceAuth(req.headers.get("authorization"), SCOPE.score, course);
  if (!a.ok) return new Response(null, { status: a.status, headers: H });
  const text = (await req.text().catch(() => "")).slice(0, 20_000);
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { return Response.json({ error: "bad json" }, { status: 400, headers: H }); }
  const r = await postScore(a.tool, course, item, body);
  return r.status === 200 ? new Response(null, { status: 200, headers: H }) : Response.json({ error: r.error }, { status: r.status, headers: H });
}
