import type { BlockType } from "./blocks";

/** Each block type's shape (globals.css) and its name's i18n key. Shared by server pages and client components. */
export const BLOCK_SHAPE: Record<BlockType, string> = {
  text: "s-arch", poll: "s-tri", timer: "s-circle", picker: "s-square", noise: "s-square", board: "s-arch", link: "s-arch", tool: "s-square",
};
export const BLOCK_NAME: Record<BlockType, "blockText" | "blockPoll" | "blockTimer" | "blockPicker" | "blockNoise" | "blockBoard" | "blockLink" | "blockTool"> = {
  text: "blockText", poll: "blockPoll", timer: "blockTimer", picker: "blockPicker", noise: "blockNoise", board: "blockBoard", link: "blockLink", tool: "blockTool",
};
