import { decodeEntities } from "./xml";
import { webLink, LIMITS } from "./blocks";

/**
 * Turns an imported web page into lesson blocks. Lesson text blocks hold
 * plain text, not HTML, so this is also the sanitizer: no tag, attribute,
 * script, style or event handler survives, and a link is only kept when it is
 * http(s) (written out after its words). Headings (h1–h3) start a new block,
 * so a long page becomes a set of slides. An embedded frame (a video, a
 * slideshow) becomes a link block. Images and files inside the export can't
 * be brought in yet; they are left as a note in the text and listed.
 */

export type PageBlock = { type: "text"; title: string; body: string } | { type: "link"; title: string; url: string };

export type PageResult = {
  blocks: PageBlock[];
  /** Paths or links the page uses that weren't brought in (images, files). */
  missing: string[];
  /** Links to other pages inside the export (their text is kept, the link isn't). */
  internal: string[];
};

const NAMED: Record<string, string> = {
  lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  mdash: "—", ndash: "–", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»",
  bull: "•", middot: "·", copy: "©", reg: "®", trade: "™", deg: "°", times: "×", divide: "÷", plusmn: "±",
  frac12: "½", frac14: "¼", frac34: "¾", sup2: "²", sup3: "³", para: "¶", sect: "§", iexcl: "¡", iquest: "¿",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", ntilde: "ñ", uuml: "ü",
  Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", Ntilde: "Ñ", Uuml: "Ü",
  larr: "←", rarr: "→", uarr: "↑", darr: "↓", le: "≤", ge: "≥", ne: "≠", pi: "π", alpha: "α", beta: "β",
};

const SKIP = new Set(["script", "style", "noscript", "template", "head", "title", "object", "embed", "svg", "math", "button", "select", "textarea"]);
const BLOCKISH = new Set(["p", "div", "section", "article", "header", "footer", "main", "aside", "blockquote", "pre", "ul", "ol", "table", "figure", "figcaption", "h4", "h5", "h6", "dl", "dt", "dd", "hr", "address", "details", "summary", "center"]);
const HEADING = new Set(["h1", "h2", "h3"]);
const VOID = new Set(["br", "img", "hr", "input", "meta", "link", "area", "base", "col", "source", "track", "wbr", "param"]);

const ATTR_RE = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function attrsOf(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(ATTR_RE)) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "", NAMED);
  return out;
}

/** What a page's own link or image path names, made plain (`$IMS-CC-FILEBASE$/a%20b.png` → `a b.png`). */
export function cleanRef(href: string): string {
  let s = href.trim().replace(/^\$IMS[-_]CC[-_]FILEBASE\$\/?/i, "").replace(/[?#].*$/, "");
  try { s = decodeURIComponent(s); } catch { /* keep as written */ }
  return s.replace(/^\.?\//, "");
}

const isPageRef = (ref: string) => /\.x?html?$/i.test(ref) || /^\$(WIKI_REFERENCE|CANVAS_OBJECT_REFERENCE|CANVAS_COURSE_REFERENCE)\$/i.test(ref);

export function htmlToBlocks(html: string, fallbackTitle = ""): PageResult {
  const missing = new Set<string>();
  const internal = new Set<string>();
  const blocks: PageBlock[] = [];

  let title = "";
  let out = "";
  let heading: string | null = null;
  let skipDepth = 0;
  let skipTag = "";
  let pre = 0;
  const lists: { ordered: boolean; n: number }[] = [];
  const links: { href: string; start: number }[] = [];
  let cellInRow = 0;

  const flush = () => {
    const body = tidy(out);
    if (title || body) blocks.push({ type: "text", title: title.slice(0, LIMITS.title), body });
    title = "";
    out = "";
  };
  const newline = (n: 1 | 2) => {
    let tail = 0;
    for (let k = out.length - 1; k >= 0 && out[k] === "\n"; k--) tail++;
    if (!/\S/.test(out)) return;
    out += "\n".repeat(Math.max(0, n - tail));
  };

  // The body only, when there is one (Schoology and Canvas pages are whole documents).
  const bodyMatch = /<body[^>]*>([\s\S]*?)(<\/body>|$)/i.exec(html);
  const src = bodyMatch ? bodyMatch[1] : html;

  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    const chunk = lt < 0 ? src.slice(i) : src.slice(i, lt);
    if (chunk && !skipDepth) {
      let t = decodeEntities(chunk, NAMED);
      if (!pre) t = t.replace(/\s+/g, " ");
      if (heading !== null) heading += t;
      else {
        if (!pre && (out === "" || /[\n ]$/.test(out))) t = t.replace(/^ /, "");
        out += t;
      }
    }
    if (lt < 0) break;

    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src[lt + 1] === "!" || src[lt + 1] === "?") {
      const end = src.indexOf(">", lt);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    const m = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)([^>]*)>/.exec(src.slice(lt, lt + 4000));
    if (!m) {
      // A lone "<" in text.
      if (!skipDepth) { if (heading !== null) heading += "<"; else out += "<"; }
      i = lt + 1;
      continue;
    }
    i = lt + m[0].length;
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();

    if (skipDepth) {
      if (tag === skipTag) skipDepth += closing ? -1 : m[3].trim().endsWith("/") ? 0 : 1;
      continue;
    }
    if (SKIP.has(tag) && !closing) {
      if (!m[3].trim().endsWith("/")) { skipDepth = 1; skipTag = tag; }
      continue;
    }

    if (HEADING.has(tag)) {
      if (!closing) {
        flush();
        heading = "";
      } else if (heading !== null) {
        title = heading.replace(/\s+/g, " ").trim();
        heading = null;
      }
      continue;
    }

    const a = closing ? {} : attrsOf(m[3]);
    switch (tag) {
      case "br":
        if (heading !== null) heading += " "; else out += "\n";
        continue;
      case "li":
        if (!closing) {
          newline(1);
          const list = lists[lists.length - 1];
          const indent = "  ".repeat(Math.max(0, lists.length - 1));
          out += list?.ordered ? `${indent}${++list.n}. ` : `${indent}• `;
        }
        continue;
      case "ul":
      case "ol":
        if (closing) lists.pop();
        else lists.push({ ordered: tag === "ol", n: 0 });
        newline(lists.length > 1 ? 1 : 2);
        continue;
      case "tr":
        newline(1);
        cellInRow = 0;
        continue;
      case "td":
      case "th":
        if (!closing && cellInRow++ > 0) out += " | ";
        continue;
      case "pre":
        pre += closing ? -1 : 1;
        if (pre < 0) pre = 0;
        newline(2);
        continue;
      case "a":
        if (!closing) links.push({ href: a.href ?? "", start: out.length });
        else {
          const l = links.pop();
          if (!l || !l.href || heading !== null) continue;
          const url = webLink(l.href);
          const words = out.slice(l.start).trim();
          if (url) {
            if (!words) out += url;
            else if (words !== url && words !== l.href.trim()) out += ` (${url})`;
          } else if (!/^(mailto:|tel:|#|javascript:|data:)/i.test(l.href.trim())) {
            const ref = cleanRef(l.href);
            if (ref) (isPageRef(l.href.trim()) || isPageRef(ref) ? internal : missing).add(ref);
          }
        }
        continue;
      case "img": {
        const alt = (a.alt ?? "").replace(/\s+/g, " ").trim();
        const srcRef = a.src ?? "";
        const url = webLink(srcRef);
        if (url) missing.add(url);
        else if (srcRef && !/^data:/i.test(srcRef)) missing.add(cleanRef(srcRef));
        out += alt ? `[Image: ${alt}]` : "[Image]";
        continue;
      }
      case "iframe": {
        if (closing) continue;
        const url = webLink(a.src ?? "");
        if (url) {
          // A heading with nothing under it but this frame names the frame: one slide, not two.
          let name = (a.title ?? "").replace(/\s+/g, " ").trim();
          if (title && !tidy(out)) { name = title; title = ""; out = ""; } else flush();
          blocks.push({ type: "link", title: name.slice(0, LIMITS.title), url });
        }
        // An iframe's fallback text is not content.
        skipDepth = 1;
        skipTag = "iframe";
        continue;
      }
      default:
        if (BLOCKISH.has(tag)) newline(tag === "dd" || tag === "dt" ? 1 : 2);
        if (tag === "hr" && !closing) { out += "———"; newline(2); }
        if (VOID.has(tag)) continue;
    }
  }
  if (heading !== null) title = heading.replace(/\s+/g, " ").trim();
  flush();

  // A page with no heading at all gets the page's own title on its first block, so the slide says what it is.
  if (blocks.length && blocks[0].type === "text" && !blocks[0].title && fallbackTitle) blocks[0].title = fallbackTitle.slice(0, LIMITS.title);

  return { blocks: fit(blocks), missing: [...missing].filter(Boolean), internal: [...internal] };
}

/** Lines trimmed, at most one blank line in a row. */
function tidy(s: string): string {
  return s.split("\n").map((l) => l.replace(/[ \t]+$/g, "").replace(/^ (?=\S)/, "")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Every block within the lesson limits: long text split at paragraphs, never more blocks than a lesson holds. */
function fit(blocks: PageBlock[]): PageBlock[] {
  const out: PageBlock[] = [];
  for (const b of blocks) {
    if (b.type !== "text" || b.body.length <= LIMITS.body) { out.push(b); continue; }
    let rest = b.body;
    let first = true;
    while (rest) {
      let cut = rest.length <= LIMITS.body ? rest.length : rest.lastIndexOf("\n\n", LIMITS.body);
      if (cut <= 0) cut = LIMITS.body;
      out.push({ type: "text", title: first ? b.title : `${b.title}${b.title ? " " : ""}(…)`.slice(0, LIMITS.title), body: rest.slice(0, cut).trim() });
      rest = rest.slice(cut).trim();
      first = false;
    }
  }
  if (out.length > LIMITS.blocks) {
    // Fold the overflow into the last block's text rather than lose it.
    const keep = out.slice(0, LIMITS.blocks - 1);
    const tail = out.slice(LIMITS.blocks - 1).map((b) => b.type === "text" ? [b.title, b.body].filter(Boolean).join("\n") : `${b.title} ${b.url}`.trim());
    keep.push({ type: "text", title: "", body: tail.join("\n\n").slice(0, LIMITS.body) });
    return keep;
  }
  return out;
}
