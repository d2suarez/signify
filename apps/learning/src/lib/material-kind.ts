import type { Block } from "./blocks";
import type { Dict } from "./i18n";
import { BLOCK_NAME } from "./block-kinds";
import { videoFromUrl } from "./post-doc";
import { googleEmbed } from "./embeds";

const GOOGLE = { slides: "googleSlides", doc: "googleDoc", sheet: "googleSheet", form: "googleForm", drive: "googleDrive" } as const;

/** What a material is, in the reader's words: a link that plays or shows in place is named for what it is ("Video", "Google Slides"). */
export function materialKind(b: Block, d: Dict): string {
  if (b.type === "link") {
    if (videoFromUrl(b.url)) return d.pcVideo;
    const g = googleEmbed(b.url);
    if (g) return d[GOOGLE[g.kind]];
  }
  return d[BLOCK_NAME[b.type]];
}
