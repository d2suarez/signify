/**
 * A minimal XML reader for course-export manifests. It has no DTD support at
 * all: a document with a DOCTYPE or an ENTITY declaration is refused, so
 * external entities (XXE) and entity expansion ("billion laughs") cannot
 * happen. Only the five built-in entities and numeric character references
 * are decoded. Names are kept without their namespace prefix (`lom:string`
 * is `string`), which is all a Common Cartridge reader needs.
 */

export type XmlNode = { name: string; attrs: Record<string, string>; children: XmlNode[]; text: string };

export class XmlError extends Error {}

const LIMITS = { depth: 200, nodes: 200_000 };

const BUILTIN: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export function decodeEntities(s: string, named: Record<string, string> = BUILTIN): string {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g, (whole, ref: string) => {
    if (ref[0] === "#") {
      const n = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
    }
    return named[ref] ?? whole;
  });
}

const local = (name: string) => name.slice(name.indexOf(":") + 1);

const ATTR_RE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export function parseXml(src: string): XmlNode {
  if (/<!DOCTYPE|<!ENTITY/i.test(src)) throw new XmlError("doctype");
  const root: XmlNode = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let nodes = 0;
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    const top = stack[stack.length - 1];
    if (lt < 0) {
      top.text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i) top.text += decodeEntities(src.slice(i, lt));
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      if (end < 0) throw new XmlError("unclosed-comment");
      i = end + 3;
    } else if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt + 9);
      if (end < 0) throw new XmlError("unclosed-cdata");
      top.text += src.slice(lt + 9, end);
      i = end + 3;
    } else if (src.startsWith("<?", lt)) {
      const end = src.indexOf("?>", lt + 2);
      if (end < 0) throw new XmlError("unclosed-pi");
      i = end + 2;
    } else if (src.startsWith("<!", lt)) {
      throw new XmlError("declaration");
    } else if (src[lt + 1] === "/") {
      const end = src.indexOf(">", lt);
      if (end < 0) throw new XmlError("unclosed-tag");
      const name = local(src.slice(lt + 2, end).trim());
      if (stack.length < 2 || top.name !== name) throw new XmlError("mismatched-tag");
      stack.pop();
      i = end + 1;
    } else {
      const end = tagEnd(src, lt);
      if (end < 0) throw new XmlError("unclosed-tag");
      let body = src.slice(lt + 1, end);
      const selfClosing = body.endsWith("/");
      if (selfClosing) body = body.slice(0, -1);
      const m = /^[^\s/>]+/.exec(body);
      if (!m) throw new XmlError("bad-tag");
      const node: XmlNode = { name: local(m[0]), attrs: {}, children: [], text: "" };
      for (const a of body.slice(m[0].length).matchAll(ATTR_RE)) {
        node.attrs[local(a[1])] = decodeEntities(a[2] ?? a[3] ?? "");
      }
      if (++nodes > LIMITS.nodes) throw new XmlError("too-large");
      top.children.push(node);
      if (!selfClosing) {
        stack.push(node);
        if (stack.length > LIMITS.depth) throw new XmlError("too-deep");
      }
      i = end + 1;
    }
  }
  if (stack.length !== 1) throw new XmlError("unclosed-element");
  if (root.children.length !== 1) throw new XmlError("no-root");
  return root.children[0];
}

/** The `>` that ends a start tag, skipping any inside quoted attribute values. */
function tagEnd(src: string, from: number): number {
  let quote = "";
  for (let i = from + 1; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === quote) quote = ""; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return i;
  }
  return -1;
}

/** Direct children named `name`. */
export function kids(n: XmlNode | undefined, name: string): XmlNode[] {
  return n ? n.children.filter((c) => c.name === name) : [];
}

export function kid(n: XmlNode | undefined, name: string): XmlNode | undefined {
  return n?.children.find((c) => c.name === name);
}

/** The first node named `name` anywhere below `n` (depth first). */
export function find(n: XmlNode | undefined, name: string): XmlNode | undefined {
  if (!n) return undefined;
  for (const c of n.children) {
    if (c.name === name) return c;
    const deep = find(c, name);
    if (deep) return deep;
  }
  return undefined;
}

/** All text inside `n`, children included. */
export function textOf(n: XmlNode | undefined): string {
  if (!n) return "";
  return n.text + n.children.map(textOf).join("");
}
