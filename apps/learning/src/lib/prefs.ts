/**
 * Reading supports (UDL): what each student chooses for themselves, applied
 * wherever they read or write here — the live lesson, assignments and the
 * writing box. Anyone signed in may set their own; nobody sets someone
 * else's. Stored per Signify id within the school (migrations/003,
 * prefs-store.ts). Pure, so client components import it too.
 *
 * The page applies them as data attributes on <html> (see layout.tsx and
 * globals.css), so they are in place on the first paint, with no flash.
 */

export type Prefs = {
  /** Show "Read aloud" buttons (browser speech synthesis). */
  readAloud: boolean;
  rate: "slow" | "normal";
  font: "standard" | "dyslexia";
  size: "normal" | "large" | "larger";
  spacing: "normal" | "wide";
  contrast: "standard" | "high";
};

export const DEFAULT_PREFS: Prefs = {
  readAloud: false, rate: "normal", font: "standard", size: "normal", spacing: "normal", contrast: "standard",
};

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

/** The only way in: unknown keys dropped, unknown values back to the default. */
export function normalizePrefs(input: unknown): Prefs {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    readAloud: o.readAloud === true,
    rate: pick(o.rate, ["slow", "normal"] as const, DEFAULT_PREFS.rate),
    font: pick(o.font, ["standard", "dyslexia"] as const, DEFAULT_PREFS.font),
    size: pick(o.size, ["normal", "large", "larger"] as const, DEFAULT_PREFS.size),
    spacing: pick(o.spacing, ["normal", "wide"] as const, DEFAULT_PREFS.spacing),
    contrast: pick(o.contrast, ["standard", "high"] as const, DEFAULT_PREFS.contrast),
  };
}

/** The attributes put on <html>. Only non-default choices, so a plain page stays plain. */
export function prefsAttrs(p: Prefs): Record<string, string> {
  const out: Record<string, string> = {};
  if (p.readAloud) { out["data-read-aloud"] = "on"; out["data-rate"] = p.rate; }
  if (p.font !== "standard") out["data-font"] = p.font;
  if (p.size !== "normal") out["data-size"] = p.size;
  if (p.spacing !== "normal") out["data-spacing"] = p.spacing;
  if (p.contrast !== "standard") out["data-contrast"] = p.contrast;
  return out;
}
