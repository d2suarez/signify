import type { BlockType } from "./blocks";

/**
 * What the class page's Create menu makes (Desmond, 2026-11-23: "a Create
 * button that opens a menu where you can create folders, assignments,
 * Pages, uploads, assessments, LTI and more"). Pure, shared by the menu and
 * the /courses/[id]/new page.
 *
 * "page" is a lesson (blocks you can read or present live); "material"
 * kinds are class materials (class_resources) of one block type.
 */
export const CREATE_KINDS = ["folder", "page", "assignment", "assessment", "upload", "link", "board", "text", "classtool", "poll", "lti"] as const;
export type CreateKind = (typeof CREATE_KINDS)[number];

/** Not offered in a club (no assignments, gradebook or quizzes there). */
export const ACADEMIC_ONLY: ReadonlySet<CreateKind> = new Set(["assignment", "assessment", "lti"]);

/** Material kinds and the block types each offers (the first is the start). */
export const MATERIAL_BLOCKS: Partial<Record<CreateKind, BlockType[]>> = {
  link: ["link"], board: ["board"], text: ["text"], classtool: ["timer", "picker", "noise", "seating"], poll: ["poll"],
};

/** Each kind's shape (globals.css block colours) and its words' i18n keys. */
export const CREATE_SHAPE: Record<CreateKind, string> = {
  folder: "s-square", page: "s-arch", assignment: "s-tri", assessment: "s-tri", upload: "s-arch", link: "s-arch",
  board: "s-arch", text: "s-arch", classtool: "s-square", poll: "s-tri", lti: "s-square",
};

export function asCreateKind(v: unknown): CreateKind | null {
  return (CREATE_KINDS as readonly string[]).includes(String(v)) ? (v as CreateKind) : null;
}

/** The kinds this class may make: a club makes no academic work; outside tools only when the school has some. */
export function createKindsFor(opts: { club: boolean; tools: boolean }): CreateKind[] {
  return CREATE_KINDS.filter((k) => !(opts.club && ACADEMIC_ONLY.has(k)) && (k !== "lti" || opts.tools));
}
