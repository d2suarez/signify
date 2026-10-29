import { publicJwks } from "@/lib/lti";

export const dynamic = "force-dynamic";

/** Our public keys (served at /.well-known/jwks.json by a rewrite). */
export async function GET() {
  return Response.json(await publicJwks(), {
    headers: { "cache-control": "public, max-age=300", "access-control-allow-origin": "*", "x-content-type-options": "nosniff" },
  });
}
