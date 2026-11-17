/**
 * What each role may do at a school, as the school sets it in Signify ID
 * ("Tools by role", ID migration 013), for Learning's own features. Learning
 * declares them to ID once per process (`/api/v1/declare-features`) and reads
 * the school's answer with client credentials, cached a minute (15 s after
 * a failure). With no answer the defaults ID itself applies are used:
 * students get only features marked `students`, every other role everything.
 * Callers add their own limits on top (a school post also needs a staff
 * role, because ID's default gives guardians everything too).
 */

export const FEATURES = [
  {
    key: "post_school_updates",
    label: "Post updates to the whole school",
    description: "Signify Learning: post an update every student, parent and staff member at the school sees. Staff roles only.",
    group: "Updates",
    students: false,
  },
] as const;
export type FeatureKey = (typeof FEATURES)[number]["key"];

const ISSUER = (process.env.SIGNIFY_ISSUER || "").replace(/\/+$/, "");
const CLIENT_ID = process.env.SIGNIFY_CLIENT_ID || "";
const CLIENT_SECRET = process.env.SIGNIFY_CLIENT_SECRET || "";
const ENABLED = !!(ISSUER && CLIENT_ID && CLIENT_SECRET);
const CACHE_MS = 60_000, FAILED_MS = 15_000;

type Roles = Record<string, Record<string, boolean>> | null;
type State = { declared?: Promise<void>; cache: Map<string, { at: number; ttl: number; roles: Roles }> };
const state: State = ((globalThis as unknown as { __learningFeatures?: State }).__learningFeatures ??= { cache: new Map() });

const basic = () => "Basic " + Buffer.from(`${encodeURIComponent(CLIENT_ID)}:${encodeURIComponent(CLIENT_SECRET)}`).toString("base64");

function declareOnce(): Promise<void> {
  state.declared ??= (async () => {
    try {
      const res = await fetch(`${ISSUER}/api/v1/declare-features`, {
        method: "POST", headers: { "content-type": "application/json", authorization: basic() },
        body: JSON.stringify({ features: FEATURES }), signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) { console.warn(`learning: feature declaration refused (${res.status})`); state.declared = undefined; }
      else console.info(`learning: declared ${FEATURES.length} feature(s) to Signify ID`);
    } catch (e) {
      console.warn(`learning: could not declare features: ${(e as Error).message}`);
      state.declared = undefined;
    }
  })();
  return state.declared;
}

async function rolesAt(tenantId: string): Promise<Roles> {
  const hit = state.cache.get(tenantId);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.roles;
  let roles: Roles = null;
  try {
    const res = await fetch(`${ISSUER}/api/v1/tenants/${encodeURIComponent(tenantId)}/features`, {
      headers: { authorization: basic() }, signal: AbortSignal.timeout(5000),
    });
    if (res.ok) roles = ((await res.json()) as { roles?: Roles }).roles ?? null;
    else console.warn(`learning: features for ${tenantId} refused (${res.status}); using defaults`);
  } catch (e) {
    console.warn(`learning: features for ${tenantId} unavailable (${(e as Error).message}); using defaults`);
  }
  state.cache.set(tenantId, { at: Date.now(), ttl: roles ? CACHE_MS : FAILED_MS, roles });
  return roles;
}

/** The rule ID applies when a school has not decided. */
export function byDefault(key: FeatureKey, role: string): boolean {
  const f = FEATURES.find((x) => x.key === key);
  return role === "student" ? !!f?.students : true;
}

/** Does this role get this feature at this school. A super admin (no school) always does. */
export async function hasFeature(key: FeatureKey, who: { tenantId: string; role: string | null; dev?: boolean }): Promise<boolean> {
  const role = who.role || "";
  if (role === "super_admin") return true;
  if (who.dev || !ENABLED || who.tenantId.startsWith("user:")) return byDefault(key, role);
  void declareOnce();
  const said = (await rolesAt(who.tenantId))?.[role]?.[key];
  return typeof said === "boolean" ? said : byDefault(key, role);
}
