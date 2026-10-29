import "server-only";
import { escapeHtml } from "./lti-html";

export { escapeHtml };

/** This app's own origin, as platforms see it (for redirect_uri and target_link_uri). */
export function ourOrigin(h: Headers): string {
  if (process.env.LEARNING_ORIGIN) return process.env.LEARNING_ORIGIN.replace(/\/$/, "");
  if (process.env.CANONICAL_HOST) return `https://${process.env.CANONICAL_HOST}`;
  const host = (h.get("x-forwarded-host") || h.get("host") || "localhost").split(",")[0].trim();
  const proto = (h.get("x-forwarded-proto") || "http").split(",")[0].trim();
  return `${proto}://${host}`;
}

export const STATE_COOKIE = "sl_lti_state";

/** The states this browser's cookie names (newest first). */
export function cookieStates(cookieHeader: string | null): string[] {
  const m = new RegExp(`(?:^|;\\s*)${STATE_COOKIE}=([A-Za-z0-9_.-]+)`).exec(cookieHeader || "");
  return m ? m[1].split(".").filter(Boolean) : [];
}

/**
 * The login step is a cross-site request inside the platform's frame, and the
 * launch a cross-site POST: only a SameSite=None; Secure cookie comes back.
 * (Browsers treat http://localhost as secure, so this works locally too.)
 */
export function stateCookie(state: string, previous: string[]): string {
  const keep = [state, ...previous.filter((s) => s !== state)].slice(0, 5).join(".");
  return `${STATE_COOKIE}=${keep}; Path=/lti; HttpOnly; Secure; SameSite=None; Max-Age=600`;
}
