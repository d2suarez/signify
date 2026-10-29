/**
 * At server start: grades still waiting to go to Schoology (from before a
 * restart or deploy) are picked up again. Production only (DATABASE_URL);
 * locally the sender starts with the first grade save.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || !process.env.DATABASE_URL) return;
  const { kickScores } = await import("./lib/lti-ags");
  setTimeout(kickScores, 30_000).unref?.();
}
