/**
 * Signify Boards links a lesson may hold. Only Boards' own origins are
 * accepted: the lesson's iframe and the Content-Security-Policy's frame-src
 * (next.config.ts) both read this list, so a pasted link can never frame
 * some other site inside a student's lesson.
 *
 * A board "shared to the web" in Boards has a public, read-only, live view at
 * /embed/<token> that Boards lets other sites frame. Every other Boards page
 * refuses framing (X-Frame-Options SAMEORIGIN) and needs sign-in, so those
 * links only ever open in their own tab. Pure: no imports.
 */

export const BOARD_ORIGINS: string[] = [
  "https://draw.signify.one",
  "https://boards.signify.one",
  // A local Boards for trying this out, set at build time (never on Railway).
  ...(process.env.NEXT_PUBLIC_BOARDS_DEV_ORIGIN ? [process.env.NEXT_PUBLIC_BOARDS_DEV_ORIGIN] : []),
];

const EMBED_PATH = /^\/embed\/[A-Za-z0-9_-]{8,64}$/;

export type BoardLink = { url: string; embed: boolean };

/** A cleaned Boards link, or null if it isn't one. */
export function boardLink(raw: unknown): BoardLink | null {
  if (typeof raw !== "string" || raw.length > 600) return null;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (!BOARD_ORIGINS.includes(u.origin) || u.username || u.password) return null;
  const embed = EMBED_PATH.test(u.pathname);
  // An embed link carries nothing but its token; other links keep their query (room codes).
  return { url: embed ? u.origin + u.pathname : u.origin + u.pathname + u.search, embed };
}
