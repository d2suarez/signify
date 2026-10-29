import { readMe } from "@/lib/auth";
import { getPick } from "@/lib/lti-platform";

export const dynamic = "force-dynamic";

/** Whether the tool has answered a pick yet (the teacher who started it only). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await readMe();
  if (!me) return Response.json({ error: "sign-in" }, { status: 401 });
  const pick = await getPick(me.tenantId, me.id, (await params).id);
  if (!pick) return Response.json({ state: "gone" }, { status: 404 });
  return Response.json({ state: pick.state, items: pick.items }, { headers: { "cache-control": "no-store" } });
}
