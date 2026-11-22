/**
 * Teacher's Desk, whose real tools Learning's left rail shows (framed from
 * desk.signify.one/embed). Learning stores nothing of a tool: the cards,
 * timers and seating plans are the person's own on their desk.
 *
 * Locally, NEXT_PUBLIC_DESK_DEV_ORIGIN=http://localhost:8770 points at a
 * desk run with `npm run dev` in apps/desk (read at build time, like
 * NEXT_PUBLIC_BOARDS_DEV_ORIGIN). Never set it on Railway.
 */
export const DESK_ORIGIN = process.env.NEXT_PUBLIC_DESK_DEV_ORIGIN || "https://desk.signify.one";

/** Learning's rail tools → Desk's widget types. */
export const DESK_TYPE = {
  clock: "clock",
  timer: "timer",
  noise: "noise",
  picker: "randomiser",
  groups: "groups",
  seating: "seating",
} as const;

/** The embed page for these tools, opened on a class when there is one. */
export function deskEmbedUrl(types: string[], idClassId: string | null, from: string): string {
  const q = new URLSearchParams({ tools: types.join(","), from });
  if (idClassId) q.set("class", idClassId);
  return `${DESK_ORIGIN}/embed?${q}`;
}
