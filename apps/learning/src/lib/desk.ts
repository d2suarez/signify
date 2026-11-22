/**
 * Teacher's Desk, whose real tools Learning's left rail shows (framed from
 * desk.signify.one/embed). Learning stores nothing of a tool: the cards,
 * timers and seating plans are the person's own on their desk.
 *
 * Locally, NEXT_PUBLIC_DESK_DEV_ORIGIN=http://localhost:8770 points at a
 * desk run with `npm run dev` in apps/desk (read at build time, like
 * NEXT_PUBLIC_BOARDS_DEV_ORIGIN). Never set it on Railway.
 */
import { WIDGET_KINDS, type WidgetKind } from "./widgets";

export const DESK_ORIGIN = process.env.NEXT_PUBLIC_DESK_DEV_ORIGIN || "https://desk.signify.one";

/** Learning's rail tools → Desk's widget types: the same names, but for the name picker. */
export const DESK_TYPE: Record<WidgetKind, string> = Object.fromEntries(
  WIDGET_KINDS.map((k) => [k, k === "picker" ? "randomiser" : k]),
) as Record<WidgetKind, string>;

/** The embed page for these tools, opened on a class when there is one. */
export function deskEmbedUrl(types: string[], idClassId: string | null, from: string): string {
  const q = new URLSearchParams({ tools: types.join(","), from });
  if (idClassId) q.set("class", idClassId);
  return `${DESK_ORIGIN}/embed?${q}`;
}
