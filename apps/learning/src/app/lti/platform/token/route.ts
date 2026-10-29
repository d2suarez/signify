import { issueToken, tokenRateOk } from "@/lib/lti-platform-ags";
import { ourOrigin } from "@/lib/lti-http";

export const dynamic = "force-dynamic";

const HEADERS = { "cache-control": "no-store", pragma: "no-cache", "x-content-type-options": "nosniff" };

/** OAuth 2 client credentials for tools (JWT assertion signed by the tool's key). Rate-limited per caller. */
export async function POST(req: Request) {
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "local";
  if (!tokenRateOk(`ip:${ip}`)) return Response.json({ error: "slow_down" }, { status: 429, headers: { ...HEADERS, "retry-after": "60" } });
  const text = (await req.text().catch(() => "")).slice(0, 30_000);
  const r = await issueToken(new URLSearchParams(text), `${ourOrigin(req.headers)}/lti/platform/token`);
  if (!r.ok) return Response.json({ error: r.error }, { status: r.status, headers: HEADERS });
  return Response.json(r.body, { headers: HEADERS });
}
