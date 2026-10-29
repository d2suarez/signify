import { getDb } from "./db";
import { normalizePrefs, type Prefs } from "./prefs";

/** Reading supports, stored per Signify id within the school. Shape: prefs.ts. */

type Ctx = { tenantId: string; userId: string };

export async function getPrefs(ctx: Ctx): Promise<Prefs> {
  const db = await getDb();
  const rows = await db.query<{ prefs: unknown }>(
    "SELECT prefs FROM student_prefs WHERE tenant_id = $1 AND user_id = $2",
    [ctx.tenantId, ctx.userId],
  );
  return normalizePrefs(rows[0]?.prefs);
}

export async function savePrefs(ctx: Ctx, input: unknown): Promise<Prefs> {
  const prefs = normalizePrefs(input);
  const db = await getDb();
  await db.query(
    `INSERT INTO student_prefs (tenant_id, user_id, prefs, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (tenant_id, user_id) DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = now()`,
    [ctx.tenantId, ctx.userId, JSON.stringify(prefs)],
  );
  return prefs;
}
