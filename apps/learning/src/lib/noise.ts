/**
 * The noise meter's arithmetic, from Teacher's Desk's: a loudness-ish 0-100
 * level from the microphone's RMS (raw RMS barely moves between "working
 * quietly" and "far too loud"), the word for a level, and the colour of the
 * room against the teacher's line. Pure, so it is tested directly.
 */

/** Microphone RMS (0..1) to a 0-100 level on a decibel curve. */
export function rmsToLevel(rms: number, sensitivity = 1): number {
  const db = 20 * Math.log10(rms || 1e-7);
  return Math.max(0, Math.min(100, ((db + 60) / 55) * 100 * sensitivity));
}

/** Rises quickly so a shout registers, falls slowly so the bar isn't a strobe light. */
export function smooth(level: number, raw: number): number {
  return level + (raw - level) * (raw > level ? 0.45 : 0.08);
}

export const NOISE_WORDS = [
  { key: "noiseSilent", upto: 12 },
  { key: "noiseWhisper", upto: 30 },
  { key: "noiseWork", upto: 55 },
  { key: "noiseLoud", upto: 78 },
  { key: "noiseOver", upto: 101 },
] as const;

export type NoiseWord = (typeof NOISE_WORDS)[number]["key"];

export function noiseWord(level: number): NoiseWord {
  return (NOISE_WORDS.find((w) => level < w.upto) ?? NOISE_WORDS[NOISE_WORDS.length - 1]).key;
}

const QUIET = "#1b7f4b";
const RISING = "#f5c400";
const LOUD = "#ec3013";

/**
 * The stage's colour and the ink on it: green up to a third of the way to the
 * line, fading to yellow by three-quarters, red at the line. Blended in OKLCH
 * (by the browser) so green to yellow doesn't pass through olive. The ink is
 * chosen for whichever end the blend is nearer; the level word is always
 * large text (3:1 is enough) and always there, so colour is never the only signal.
 */
export function noiseColour(level: number, limit: number): { background: string; ink: string } {
  const t = Math.min(1.2, Math.max(0, level / Math.max(1, limit)));
  const mix = (a: string, b: string, k: number) => `color-mix(in oklch, ${a}, ${b} ${Math.round(k * 100)}%)`;
  if (t <= 0.35) return { background: QUIET, ink: "#ffffff" };
  if (t < 0.75) { const k = (t - 0.35) / 0.4; return { background: mix(QUIET, RISING, k), ink: k < 0.5 ? "#ffffff" : "#201e1d" }; }
  if (t < 1) { const k = (t - 0.75) / 0.25; return { background: mix(RISING, LOUD, k), ink: k < 0.5 ? "#201e1d" : "#ffffff" }; }
  return { background: LOUD, ink: "#ffffff" };
}
