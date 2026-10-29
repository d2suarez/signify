import crypto from "node:crypto";
import { getDb } from "./db";
import { CLAIM, DL_CLAIM, ITEM_PARAM, LTI_VERSION, launchFor, parseItem, platformFor, signAsTool, teacherCourses, type Launch, type Person } from "./lti";
import type { IdClass } from "./roster";

/**
 * LTI Deep Linking: Schoology asks for content, a teacher of the linked course
 * picks Learning lessons and assignments, and we answer with a signed
 * LtiDeepLinkingResponse of `ltiResourceLink` items. An assignment carries a
 * `lineItem` (its points), so Schoology makes a gradebook column for it and
 * later launches of its link bring that column's address (see lti-ags.ts).
 *
 * The picking happens in the teacher's own signed-in tab; the answer is kept
 * on the launch and taken once, by the platform's frame (which asks for it)
 * or by that same tab when the platform opened us in a window.
 */

export type Pickable = { ref: string; kind: "lesson" | "assignment"; title: string; points?: number; published?: boolean };

/** The course's lessons and assignments a teacher may place (not archived). */
export async function pickables(tenantId: string, courseId: string): Promise<Pickable[]> {
  const db = await getDb();
  const [lessons, assignments] = await Promise.all([
    db.query("SELECT id, title FROM lessons WHERE tenant_id = $1 AND course_id = $2 AND NOT archived ORDER BY planned_for NULLS LAST, title", [tenantId, courseId]),
    db.query("SELECT id, title, points, published FROM assignments WHERE tenant_id = $1 AND course_id = $2 AND NOT archived ORDER BY due_on NULLS LAST, title", [tenantId, courseId]),
  ]);
  return [
    ...assignments.map((r) => ({ ref: `assignment:${r.id}`, kind: "assignment" as const, title: String(r.title), points: Number(r.points), published: !!r.published })),
    ...lessons.map((r) => ({ ref: `lesson:${r.id}`, kind: "lesson" as const, title: String(r.title) })),
  ];
}

export type PlaceResult =
  | { ok: true; returnUrl: string; jwt: string; count: number }
  | { ok: false; error: string };

/**
 * Builds and keeps the answer for a deep-linking launch. `refs` are the
 * teacher's picks ("assignment:<uuid>"); only items of the linked course are
 * placed, and only one when the platform takes one. No picks is a valid
 * answer too (the teacher cancelled): Schoology is told nothing was chosen.
 */
export async function placeItems(
  launchId: string, me: Person, classes: IdClass[], courseId: string, refs: string[], origin: string, now = Date.now(),
): Promise<PlaceResult> {
  const launch = await launchFor(launchId, me, now);
  if ("error" in launch) return { ok: false, error: launch.error };
  if (launch.messageType !== "LtiDeepLinkingRequest" || !launch.deepLink) return { ok: false, error: "ltiBadMessage" };
  if (!(await teacherCourses(me.tenantId, classes)).some((c) => c.id === courseId)) return { ok: false, error: "ltiNotTeacher" };
  const db = await getDb();
  const [link] = await db.query("SELECT course_id FROM lti_contexts WHERE tenant_id = $1 AND platform_id = $2 AND context_id = $3",
    [launch.tenantId, launch.platformId, launch.contextId]);
  if (!link || String(link.course_id) !== courseId) return { ok: false, error: "ltiNotTeacher" };

  const all = new Map((await pickables(me.tenantId, courseId)).map((p) => [p.ref, p]));
  let chosen = [...new Set(refs.map((r) => parseItem(r)).filter(Boolean).map((i) => `${i!.kind}:${i!.id}`))]
    .map((r) => all.get(r)).filter((p): p is Pickable => !!p).slice(0, 50);
  if (!launch.deepLink.acceptMultiple) chosen = chosen.slice(0, 1);

  const items = chosen.map((p) => contentItem(p, origin));
  const platform = await platformById(launch);
  if (!platform) return { ok: false, error: "ltiUnknownPlatform" };
  const nowS = Math.floor(now / 1000);
  const jwt = await signAsTool(launch.tenantId, {
    iss: platform.clientId, aud: platform.issuer, iat: nowS, exp: nowS + 600,
    nonce: crypto.randomBytes(16).toString("base64url"),
    [`${CLAIM}message_type`]: "LtiDeepLinkingResponse",
    [`${CLAIM}version`]: LTI_VERSION,
    [`${CLAIM}deployment_id`]: launch.deploymentId,
    [`${DL_CLAIM}content_items`]: items,
    ...(launch.deepLink.data !== undefined ? { [`${DL_CLAIM}data`]: launch.deepLink.data } : {}),
  });

  await db.tx(async (t) => {
    for (const p of chosen) {
      const it = parseItem(p.ref)!;
      await t.query(
        `INSERT INTO lti_items (tenant_id, platform_id, context_id, kind, item_id, placed_by)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (platform_id, context_id, kind, item_id) DO NOTHING`,
        [launch.tenantId, launch.platformId, launch.contextId, it.kind, it.id, me.id]);
    }
    await t.query("UPDATE lti_launches SET dl_response = $2, dl_taken = false WHERE id = $1", [launch.id, jwt]);
  });
  return { ok: true, returnUrl: launch.deepLink.returnUrl, jwt, count: items.length };
}

function contentItem(p: Pickable, origin: string): Record<string, unknown> {
  const item: Record<string, unknown> = {
    type: "ltiResourceLink",
    title: p.title.slice(0, 200),
    url: `${origin}/lti/launch?item=${encodeURIComponent(p.ref)}`,
    custom: { [ITEM_PARAM]: p.ref },
  };
  if (p.kind === "assignment") {
    item.lineItem = {
      scoreMaximum: p.points && p.points > 0 ? p.points : 100,
      label: p.title.slice(0, 200),
      resourceId: p.ref,
      tag: "signify-learning",
    };
  }
  return item;
}

async function platformById(launch: Launch) {
  const db = await getDb();
  const [r] = await db.query("SELECT issuer, client_id FROM lti_platforms WHERE id = $1 AND tenant_id = $2", [launch.platformId, launch.tenantId]);
  return r ? platformFor(String(r.issuer), String(r.client_id)) : null;
}

/**
 * The kept answer, once. The launch id is the only key: it was given to the
 * platform's frame and to the teacher's tab, nobody else.
 */
export async function takeResponse(launchId: string, now = Date.now()):
  Promise<{ state: "ready"; returnUrl: string; jwt: string; platformId: string } | { state: "waiting" | "gone" }> {
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(launchId)) return { state: "gone" };
  const db = await getDb();
  const [r] = await db.query(
    `UPDATE lti_launches SET dl_taken = true WHERE id = $1 AND dl_response IS NOT NULL AND NOT dl_taken AND expires_at > $2
     RETURNING dl_response, dl_settings, platform_id`, [launchId, new Date(now)]);
  if (r) {
    const s = (typeof r.dl_settings === "string" ? JSON.parse(r.dl_settings) : r.dl_settings) as { returnUrl: string };
    return { state: "ready", returnUrl: s.returnUrl, jwt: String(r.dl_response), platformId: String(r.platform_id) };
  }
  const [l] = await db.query("SELECT dl_taken, expires_at FROM lti_launches WHERE id = $1 AND message_type = 'LtiDeepLinkingRequest'", [launchId]);
  if (!l || l.dl_taken || new Date(String(l.expires_at)).getTime() < now) return { state: "gone" };
  return { state: "waiting" };
}

/** Where a course's items are placed, for the teacher's assignment page. */
export async function placements(tenantId: string, kind: "lesson" | "assignment", itemId: string): Promise<{ contextId: string; title: string; lineitem: boolean }[]> {
  const db = await getDb();
  const rows = await db.query(
    `SELECT i.context_id, i.lineitem_url, COALESCE(c.title, '') AS title FROM lti_items i
       LEFT JOIN lti_contexts c ON c.platform_id = i.platform_id AND c.context_id = i.context_id
     WHERE i.tenant_id = $1 AND i.kind = $2 AND i.item_id = $3 ORDER BY i.placed_at`, [tenantId, kind, itemId]);
  return rows.map((r) => ({ contextId: String(r.context_id), title: String(r.title), lineitem: !!r.lineitem_url }));
}
