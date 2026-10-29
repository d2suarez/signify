/**
 * Read-aloud text, cut into pieces the browser's speech synthesis will say
 * reliably. Chrome (and so every Chromebook) stops a long utterance after
 * about fifteen seconds without saying why, so text goes out a sentence or
 * so at a time. Pure, so it is tested directly.
 */

export const MAX_CHUNK = 220;

export function speechChunks(text: string, max = MAX_CHUNK): string[] {
  const out: string[] = [];
  // Sentences end at . ! ? (and Spanish ¿¡ start fine), or at a line break.
  const sentences = text.replace(/\r\n/g, "\n").split(/(?<=[.!?…])\s+|\n+/);
  for (const raw of sentences) {
    let s = raw.replace(/\s+/g, " ").trim();
    while (s.length > max) {
      // Too long for one breath: break at the last space (or comma) before the limit.
      const cut = Math.max(s.lastIndexOf(", ", max), s.lastIndexOf(" ", max));
      const at = cut > max / 3 ? cut + 1 : max;
      out.push(s.slice(0, at).trim());
      s = s.slice(at).trim();
    }
    if (s) out.push(s);
  }
  return out;
}

export const RATES = { slow: 0.8, normal: 1 } as const;
