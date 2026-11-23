import type { Dict, Lang } from "@/lib/i18n";
import type { PostDoc } from "@/lib/post-doc";
import { PostBody } from "./DocBody";

/**
 * An assignment's instructions: the rich document when it has one (migration
 * 028), else the plain text exactly as it was always shown. Reads only (the
 * preview pages use it too).
 */
export default function Instructions({ text, doc, d, L }: { text: string; doc: PostDoc | null; d: Dict; L: Lang }) {
  if (doc && doc.nodes.length) {
    return <div className="body-text instructions-doc"><PostBody post={{ doc, materials: {} }} d={d} L={L} /></div>;
  }
  return <div className="body-text" style={{ whiteSpace: "pre-wrap", fontSize: 17, lineHeight: 1.6 }}>{text}</div>;
}
