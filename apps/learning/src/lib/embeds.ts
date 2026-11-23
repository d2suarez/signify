/**
 * Google files shown inside Learning (teacher story 01, step A13): a link
 * block whose address is a Google Slides deck, Doc, Sheet, Form or Drive
 * file shows the file in place, through Google's own embed/preview page, on
 * slides, the lesson reader and a material's page. Anything else stays a
 * link. Only these two origins are framed (next.config.ts frame-src).
 *
 * Google decides who sees the file: the viewer must be signed in to a
 * Google account the file is shared with (or it's shared with anyone with
 * the link). Learning never asks Google for anything and sends nothing.
 */

export const GOOGLE_EMBED_ORIGINS = ["https://docs.google.com", "https://drive.google.com"];

export type GoogleKind = "slides" | "doc" | "sheet" | "form" | "drive";
export type GoogleEmbed = { kind: GoogleKind; id: string; src: string };

const ID = /^[A-Za-z0-9_-]{10,200}$/;

/** The embed for a Google file's address, or null when it isn't one we show in place. */
export function googleEmbed(raw: unknown): GoogleEmbed | null {
  let u: URL;
  try { u = new URL(String(raw ?? "").trim()); } catch { return null; }
  if (u.protocol !== "https:") return null;
  const parts = u.pathname.split("/").filter(Boolean);
  if (u.hostname === "docs.google.com") {
    // /presentation/d/<id>/edit, /a/<domain>/presentation/d/<id>/…, /forms/d/e/<id>/viewform
    const at = parts[0] === "a" ? 2 : 0;
    const app = parts[at], d = parts[at + 1];
    if (d !== "d") return null;
    if (app === "forms") {
      const id = parts[at + 2] === "e" ? parts[at + 3] : parts[at + 2];
      if (!id || !ID.test(id)) return null;
      return { kind: "form", id, src: `https://docs.google.com/forms/d/${parts[at + 2] === "e" ? "e/" : ""}${id}/viewform?embedded=true` };
    }
    const id = parts[at + 2];
    if (!id || !ID.test(id)) return null;
    if (app === "presentation") return { kind: "slides", id, src: `https://docs.google.com/presentation/d/${id}/embed?start=false&loop=false` };
    if (app === "document") return { kind: "doc", id, src: `https://docs.google.com/document/d/${id}/preview` };
    if (app === "spreadsheets") return { kind: "sheet", id, src: `https://docs.google.com/spreadsheets/d/${id}/preview` };
    return null;
  }
  if (u.hostname === "drive.google.com") {
    // /file/d/<id>/view, /open?id=<id>
    const id = parts[0] === "file" && parts[1] === "d" ? parts[2] : parts[0] === "open" ? u.searchParams.get("id") : null;
    if (!id || !ID.test(id)) return null;
    return { kind: "drive", id, src: `https://drive.google.com/file/d/${id}/preview` };
  }
  return null;
}
