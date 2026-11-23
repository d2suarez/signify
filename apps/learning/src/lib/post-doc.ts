/**
 * The formatted document inside an update (migration 022). Pure: no database.
 *
 * The browser's editor turns what the person wrote into this shape and the
 * server keeps only what `normalizeDoc` lets through, so a post never holds
 * HTML: pages render the nodes with React, links open only http(s)/mailto,
 * videos are only YouTube (no-cookie) or Vimeo by id (we build the player
 * address), and pictures/files are our own uploads by id. `normalizeDoc` is
 * the only way in.
 */

export type Inline = { text: string; b?: true; i?: true; u?: true; href?: string };
export type MaterialKind = "assignment" | "lesson" | "resource" | "folder";
export type DocNode =
  | { type: "p" | "h" | "quote"; content: Inline[] }
  | { type: "ul" | "ol"; items: Inline[][] }
  | { type: "file"; fileId: string; name: string; kind: "image" | "pdf" | "audio" | "video" | "doc"; alt: string }
  | { type: "video"; provider: "youtube" | "vimeo"; id: string }
  | { type: "material"; kind: MaterialKind; id: string; title: string };
export type PostDoc = { v: 1; nodes: DocNode[] };

export const DOC_LIMITS = { nodes: 120, items: 60, runs: 200, text: 20_000, embeds: 20, title: 200, alt: 300, href: 2_000 };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_KINDS = new Set(["image", "pdf", "audio", "video", "doc"]);
const MATERIAL_KINDS = new Set(["assignment", "lesson", "resource", "folder"]);

/** Only web and mail links survive; anything else (javascript:, data:, relative) is dropped. */
export function safeHref(raw: unknown): string | null {
  const s = String(raw ?? "").trim().slice(0, DOC_LIMITS.href);
  if (!s) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
    if (u.protocol === "http:" || u.protocol === "https:") return u.hostname.includes(".") || u.hostname === "localhost" ? u.toString() : null;
    if (u.protocol === "mailto:") return u.toString();
  } catch { /* not a link */ }
  return null;
}

/** A YouTube or Vimeo address → the video's id. Nothing else is a video here. */
export function videoFromUrl(raw: unknown): { provider: "youtube" | "vimeo"; id: string } | null {
  let u: URL;
  try { u = new URL(String(raw ?? "").trim()); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.replace(/^(www\.|m\.)/, "");
  const yt = /^[A-Za-z0-9_-]{11}$/;
  if (host === "youtu.be") {
    const id = u.pathname.slice(1).split("/")[0];
    return yt.test(id) ? { provider: "youtube", id } : null;
  }
  if (host === "youtube.com" || host === "youtube-nocookie.com" || host === "music.youtube.com") {
    const v = u.searchParams.get("v");
    if (v && yt.test(v)) return { provider: "youtube", id: v };
    const m = /^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/.exec(u.pathname);
    return m ? { provider: "youtube", id: m[1] } : null;
  }
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const m = /^\/(?:video\/)?(\d{5,12})(?:\/|$)/.exec(u.pathname);
    return m ? { provider: "vimeo", id: m[1] } : null;
  }
  return null;
}

/** The player address we frame for a video node. */
export function videoSrc(n: { provider: "youtube" | "vimeo"; id: string }): string {
  return n.provider === "youtube" ? `https://www.youtube-nocookie.com/embed/${n.id}` : `https://player.vimeo.com/video/${n.id}`;
}
export const VIDEO_ORIGINS = ["https://www.youtube-nocookie.com", "https://player.vimeo.com"];

function cleanRuns(input: unknown, budget: { text: number }): Inline[] {
  if (!Array.isArray(input)) return [];
  const out: Inline[] = [];
  for (const r of input.slice(0, DOC_LIMITS.runs)) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    let text = String(o.text ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
    if (!text || budget.text <= 0) continue;
    text = text.slice(0, budget.text);
    budget.text -= text.length;
    const run: Inline = { text };
    if (o.b) run.b = true;
    if (o.i) run.i = true;
    if (o.u) run.u = true;
    const href = o.href ? safeHref(o.href) : null;
    if (href) run.href = href;
    // Join runs that look the same, so the stored doc stays small.
    const last = out[out.length - 1];
    if (last && !!last.b === !!run.b && !!last.i === !!run.i && !!last.u === !!run.u && last.href === run.href) last.text += run.text;
    else out.push(run);
  }
  // Trim a block's outer blank space and newlines.
  if (out.length) {
    out[0].text = out[0].text.replace(/^[\s\n]+/, "");
    const l = out[out.length - 1];
    l.text = l.text.replace(/[\s\n]+$/, "");
  }
  return out.filter((r) => r.text);
}

/** Keeps only nodes of known shapes, within the limits. Never throws. */
export function normalizeDoc(input: unknown): PostDoc {
  const raw = input && typeof input === "object" && Array.isArray((input as { nodes?: unknown }).nodes) ? (input as { nodes: unknown[] }).nodes : [];
  const budget = { text: DOC_LIMITS.text };
  let embeds = 0;
  const nodes: DocNode[] = [];
  for (const n of raw.slice(0, DOC_LIMITS.nodes * 2)) {
    if (nodes.length >= DOC_LIMITS.nodes) break;
    if (!n || typeof n !== "object") continue;
    const o = n as Record<string, unknown>;
    if (o.type === "p" || o.type === "h" || o.type === "quote") {
      const content = cleanRuns(o.content, budget);
      if (content.length) nodes.push({ type: o.type, content });
    } else if (o.type === "ul" || o.type === "ol") {
      const items = (Array.isArray(o.items) ? o.items : []).slice(0, DOC_LIMITS.items).map((it) => cleanRuns(it, budget)).filter((it) => it.length);
      if (items.length) nodes.push({ type: o.type, items });
    } else if (embeds < DOC_LIMITS.embeds) {
      if (o.type === "file" && typeof o.fileId === "string" && UUID.test(o.fileId)) {
        const kind = FILE_KINDS.has(String(o.kind)) ? (o.kind as "image") : "doc";
        nodes.push({ type: "file", fileId: o.fileId.toLowerCase(), name: String(o.name ?? "").slice(0, DOC_LIMITS.title), kind, alt: String(o.alt ?? "").slice(0, DOC_LIMITS.alt) });
        embeds++;
      } else if (o.type === "video" && (o.provider === "youtube" || o.provider === "vimeo")) {
        const id = String(o.id ?? "");
        if (o.provider === "youtube" ? /^[A-Za-z0-9_-]{11}$/.test(id) : /^\d{5,12}$/.test(id)) {
          nodes.push({ type: "video", provider: o.provider, id });
          embeds++;
        }
      } else if (o.type === "material" && MATERIAL_KINDS.has(String(o.kind)) && typeof o.id === "string" && UUID.test(o.id)) {
        nodes.push({ type: "material", kind: o.kind as MaterialKind, id: o.id.toLowerCase(), title: String(o.title ?? "").replace(/\s+/g, " ").trim().slice(0, DOC_LIMITS.title) });
        embeds++;
      }
    }
  }
  return { v: 1, nodes };
}

const runsText = (rs: Inline[]) => rs.map((r) => r.text + (r.href && r.href !== r.text ? ` (${r.href})` : "")).join("");

/** The words of a document as plain text: what `posts.body` keeps. */
export function docText(doc: PostDoc): string {
  return doc.nodes.map((n) => {
    switch (n.type) {
      case "p": case "h": return runsText(n.content);
      case "quote": return `“${runsText(n.content)}”`;
      case "ul": return n.items.map((it) => `• ${runsText(it)}`).join("\n");
      case "ol": return n.items.map((it, i) => `${i + 1}. ${runsText(it)}`).join("\n");
      case "file": return `[${n.kind === "image" ? n.alt || n.name || "Picture" : n.name || "File"}]`;
      case "video": return `[Video] ${n.provider === "youtube" ? `https://youtu.be/${n.id}` : `https://vimeo.com/${n.id}`}`;
      case "material": return `[${n.title || n.kind}]`;
    }
  }).join("\n\n");
}

/** Whether there is anything in it at all. */
export const docIsEmpty = (doc: PostDoc) => doc.nodes.length === 0;

export const docFileIds = (doc: PostDoc) => [...new Set(doc.nodes.flatMap((n) => (n.type === "file" ? [n.fileId] : [])))];
export const docMaterials = (doc: PostDoc) => doc.nodes.flatMap((n) => (n.type === "material" ? [n] : []));

/** A plain-text post (older posts, comments' style) as a document: one paragraph per blank-line block. */
export function docFromText(body: string): PostDoc {
  return {
    v: 1,
    nodes: body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((text) => ({ type: "p" as const, content: [{ text }] })),
  };
}

/** Keep only the nodes `keep` allows (files and materials the poster may use). */
export function filterDoc(doc: PostDoc, keep: (n: DocNode) => boolean): PostDoc {
  return { v: 1, nodes: doc.nodes.filter(keep) };
}
