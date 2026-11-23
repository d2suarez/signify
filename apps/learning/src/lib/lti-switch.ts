/**
 * THE switch for LTI 1.3 **tool mode**: Learning launched from another LMS
 * (Schoology), with Deep Linking for that platform, grade passback (AGS) to
 * it, the "In Schoology" status and the course link setup.
 *
 * OFF. Desmond, 2026-11-23: "remove the ability for Learning to connect
 * with other LMSs using LTI. The LTI integration should just be for
 * integrating tools into Learning." The code stays (src/lib/lti.ts,
 * lti-dl.ts, lti-ags.ts, lti-passback.ts, their routes and tests) in case he
 * changes his mind. While off: /lti/login, /lti/launch, /lti/deep/*,
 * /launch/*, /school/lti and /api/lti/scores answer 404, no grade is queued
 * or sent, and no page shows Schoology status or links.
 *
 * To bring it back: LEARNING_LTI_TOOL_MODE=1 on the service (and read
 * CLAUDE.md's "Schoology admin setup").
 *
 * Platform mode (outside tools INSIDE Learning: /school/tools, tool blocks,
 * /lti/tool/*, /lti/platform/*, the shared JWKS) never reads this.
 */
export function ltiToolMode(): boolean {
  return process.env.LEARNING_LTI_TOOL_MODE === "1";
}
