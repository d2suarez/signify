/**
 * Blocks: the pieces a lesson is made of. The same list is the plan (what the
 * teacher intends), the presentation (what the class sees, one block at a
 * time) and the student view (what each student does). Pure: no database, no
 * network, so it is tested directly.
 *
 * Everything that comes back from a browser goes through normalizeBlocks
 * before it is stored: unknown block types and fields are dropped, text is
 * trimmed and capped, ids are made safe and unique.
 */

import { boardLink } from "./boards";
import type { GroupsShown } from "./groups";

export type TextBlock = { id: string; type: "text"; title: string; body: string };
export type PollChoice = { id: string; text: string; correct: boolean };
export type PollBlock = {
  id: string;
  type: "poll";
  question: string;
  choices: PollChoice[];
  /** Whether the class may see the tally: only when the teacher shows it, or never. */
  results: "on-reveal" | "never";
};
export type TimerBlock = { id: string; type: "timer"; label: string; seconds: number };

/*
 * Desk tools as blocks. Teacher's Desk's widgets, rebuilt here to run live:
 * the teacher's screen works the tool and every student's screen follows.
 * Self-contained in Learning until packages/tools exists (PLAN.md, phase 1).
 */

/** Picks a student. Names stay on the teacher's (projected) screen; students only learn whether it was them. */
export type PickerBlock = {
  id: string;
  type: "picker";
  label: string;
  /** Who can be picked: students connected to the live lesson, or the whole class from Signify ID. */
  from: "here" | "class";
  /** "turns" = everyone once before anyone twice. */
  repeat: "turns" | "any";
};
/** How loud the room is, from the teacher's microphone. Nothing is recorded; students see the level. */
export type NoiseBlock = { id: string; type: "noise"; label: string; limit: number };
/** A Signify Board: shown live inside the lesson when shared to the web, otherwise a link to open it. */
export type BoardBlock = { id: string; type: "board"; title: string; url: string };
/** A link to a web page, opened in its own tab (never framed). Imported weblinks land here. */
export type LinkBlock = { id: string; type: "link"; title: string; url: string };

/**
 * An outside tool (LTI 1.3), placed by a teacher through the tool's picker or
 * as the tool's own page. `linkId` names the placement (lti_tool_links); what
 * the tool learns about each person is the school's setting for that tool.
 * Opened in its own tab, or in a sandboxed frame inside the lesson.
 */
export type ToolBlock = { id: string; type: "tool"; title: string; linkId: string; display: "tab" | "frame" };

/**
 * A file a teacher uploaded to the course (src/lib/files.ts, migration 021):
 * a picture, PDF, sound, video or document, opened through /files/<fileId>,
 * which checks who may see it. `name` and `kind` are copied from the upload so
 * the slide can show it without asking; `alt` describes a picture.
 */
export type FileBlock = {
  id: string; type: "file"; title: string; fileId: string; name: string;
  kind: "image" | "pdf" | "audio" | "video" | "doc" | ""; alt: string;
};

/**
 * One of the course's assignments or quizzes, on a slide (story 01, D3/D10).
 * Points at the assignment by id; it lives in its folder, never here. `title`
 * is a copy for the teacher's outline; what a student sees comes from the
 * assignment itself, and only once it is published (lesson-assignments.ts).
 * A lesson saved with another course's assignment loses the block.
 */
export type AssignmentBlock = { id: string; type: "assignment"; title: string; assignmentId: string };

/**
 * One of the class's saved group sets, on a slide (story 01, D8). Points at
 * the set by id (group-sets.ts); `title` is a copy of its name for the
 * outline. `shown` is never stored: the server fills it for each viewer as it
 * serves the lesson (every group for the teacher and a live class, a
 * student's own group otherwise; lesson-assignments.ts).
 */
export type GroupsBlock = { id: string; type: "groups"; title: string; groupSetId: string; shown?: GroupsShown };

/**
 * The class's seating chart, on a slide (story 01, D4/D5/D6): Teacher's
 * Desk's own plan for the lesson's class, never a copy (seating.ts). Holds
 * nothing but a title: which chart is always "this class's".
 */
export type SeatingBlock = { id: string; type: "seating"; title: string };

/**
 * The group randomizer, on a slide (story 01, D4): while the lesson is live
 * the teacher deals the class into `n` groups (`by: "count"`) or groups of
 * `n` (`by: "size"`), from the whole class or only the students connected
 * now; students marked absent today are always left out. Each deal is saved
 * as one of the class's group sets, linked to this slide (migration 041,
 * group-sets.ts `shuffleSet`), so `shown` is filled by the server exactly as
 * for a groups slide and is never stored.
 */
export type ShuffleBlock = {
  id: string; type: "shuffle"; title: string; by: "count" | "size"; n: number; from: "class" | "here"; shown?: GroupsShown;
};

export type Block = TextBlock | PollBlock | TimerBlock | PickerBlock | NoiseBlock | BoardBlock | LinkBlock | ToolBlock | FileBlock | AssignmentBlock | GroupsBlock | SeatingBlock | ShuffleBlock;
export type BlockType = Block["type"];

export const BLOCK_TYPES: BlockType[] = ["text", "poll", "timer", "picker", "noise", "board", "link", "tool", "file", "assignment", "groups", "seating", "shuffle"];
const FILE_KINDS = ["image", "pdf", "audio", "video", "doc"] as const;

export const LIMITS = {
  blocks: 200,
  title: 200,
  body: 20_000,
  question: 1_000,
  choiceText: 300,
  minChoices: 2,
  maxChoices: 8,
  minSeconds: 10,
  maxSeconds: 3_600,
  label: 120,
  minNoise: 10,
  maxNoise: 95,
  url: 2_000,
  alt: 300,
  minGroupN: 2,
  maxGroupN: 20,
};

export class BlockError extends Error {}

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function text(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\r\n/g, "\n").trim().slice(0, max) : "";
}

/** One line: no newlines, runs of whitespace collapsed. */
function line(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function uniqueId(raw: unknown, used: Set<string>): string {
  let id = typeof raw === "string" && ID_RE.test(raw) ? raw : newId();
  while (used.has(id)) id = newId();
  used.add(id);
  return id;
}

/** An http(s) link, or "" for anything else (javascript:, data:, relative paths). */
export function webLink(v: unknown): string {
  if (typeof v !== "string") return "";
  const raw = v.trim();
  if (!raw || raw.length > LIMITS.url) return "";
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : "";
  } catch {
    return "";
  }
}

export function newBlock(type: BlockType): Block {
  switch (type) {
    case "text":
      return { id: newId(), type, title: "", body: "" };
    case "poll":
      return {
        id: newId(), type, question: "", results: "on-reveal",
        choices: [
          { id: newId(), text: "", correct: false },
          { id: newId(), text: "", correct: false },
        ],
      };
    case "timer":
      return { id: newId(), type, label: "", seconds: 180 };
    case "picker":
      return { id: newId(), type, label: "", from: "here", repeat: "turns" };
    case "noise":
      return { id: newId(), type, label: "", limit: 55 };
    case "board":
    case "link":
      return { id: newId(), type, title: "", url: "" };
    case "tool":
      return { id: newId(), type, title: "", linkId: "", display: "tab" };
    case "file":
      return { id: newId(), type, title: "", fileId: "", name: "", kind: "", alt: "" };
    case "assignment":
      return { id: newId(), type, title: "", assignmentId: "" };
    case "groups":
      return { id: newId(), type, title: "", groupSetId: "" };
    case "seating":
      return { id: newId(), type, title: "" };
    case "shuffle":
      return { id: newId(), type, title: "", by: "size", n: 4, from: "class" };
  }
}

export function normalizeBlocks(input: unknown): Block[] {
  if (!Array.isArray(input)) throw new BlockError("Blocks must be a list.");
  if (input.length > LIMITS.blocks) throw new BlockError(`A lesson can hold at most ${LIMITS.blocks} blocks.`);
  const used = new Set<string>();
  const out: Block[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const b = raw as Record<string, unknown>;
    switch (b.type) {
      case "text":
        out.push({ id: uniqueId(b.id, used), type: "text", title: line(b.title, LIMITS.title), body: text(b.body, LIMITS.body) });
        break;
      case "poll": {
        const seen = new Set<string>();
        const choices = (Array.isArray(b.choices) ? b.choices : [])
          .slice(0, LIMITS.maxChoices)
          .map((c) => {
            const o = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
            return { id: uniqueId(o.id, seen), text: line(o.text, LIMITS.choiceText), correct: o.correct === true };
          });
        // A poll always offers at least two choices, even while being written.
        while (choices.length < LIMITS.minChoices) choices.push({ id: uniqueId(null, seen), text: "", correct: false });
        out.push({
          id: uniqueId(b.id, used), type: "poll",
          question: text(b.question, LIMITS.question),
          choices,
          results: b.results === "never" ? "never" : "on-reveal",
        });
        break;
      }
      case "timer": {
        const n = Math.round(Number(b.seconds));
        const seconds = Number.isFinite(n) ? Math.min(LIMITS.maxSeconds, Math.max(LIMITS.minSeconds, n)) : 180;
        out.push({ id: uniqueId(b.id, used), type: "timer", label: line(b.label, LIMITS.label), seconds });
        break;
      }
      case "picker":
        out.push({
          id: uniqueId(b.id, used), type: "picker", label: line(b.label, LIMITS.label),
          from: b.from === "class" ? "class" : "here",
          repeat: b.repeat === "any" ? "any" : "turns",
        });
        break;
      case "noise": {
        const n = Math.round(Number(b.limit));
        const limit = Number.isFinite(n) ? Math.min(LIMITS.maxNoise, Math.max(LIMITS.minNoise, n)) : 55;
        out.push({ id: uniqueId(b.id, used), type: "noise", label: line(b.label, LIMITS.label), limit });
        break;
      }
      case "board":
        // A link that isn't Boards' own is dropped (kept as no link), never framed.
        out.push({ id: uniqueId(b.id, used), type: "board", title: line(b.title, LIMITS.title), url: boardLink(b.url)?.url ?? "" });
        break;
      case "link":
        // Kept as typed while being written; only a real http(s) link is ever opened (see webLink).
        out.push({ id: uniqueId(b.id, used), type: "link", title: line(b.title, LIMITS.title), url: line(b.url, LIMITS.url) });
        break;
      case "tool": {
        const linkId = typeof b.linkId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(b.linkId)
          ? b.linkId.toLowerCase() : "";
        out.push({ id: uniqueId(b.id, used), type: "tool", title: line(b.title, LIMITS.title), linkId, display: b.display === "frame" ? "frame" : "tab" });
        break;
      }
      case "file": {
        // Only an id's shape is checked here; /files/<id> decides who may open it.
        const fileId = typeof b.fileId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(b.fileId)
          ? b.fileId.toLowerCase() : "";
        const kind = FILE_KINDS.find((k) => k === b.kind) ?? "";
        out.push({
          id: uniqueId(b.id, used), type: "file", title: line(b.title, LIMITS.title), fileId,
          name: fileId ? line(b.name, LIMITS.title) : "", kind: fileId ? kind : "", alt: line(b.alt, LIMITS.alt),
        });
        break;
      }
      case "assignment": {
        // Only the id's shape here ("" while the teacher hasn't picked one); saving a lesson drops one that isn't this course's (lessons.ts).
        const assignmentId = typeof b.assignmentId === "string" && UUID_RE.test(b.assignmentId) ? b.assignmentId.toLowerCase() : "";
        out.push({ id: uniqueId(b.id, used), type: "assignment", title: line(b.title, LIMITS.title), assignmentId });
        break;
      }
      case "groups": {
        // `shown` is the server's, per viewer: never kept from a browser. Saving drops another class's set (lessons.ts).
        const groupSetId = typeof b.groupSetId === "string" && UUID_RE.test(b.groupSetId) ? b.groupSetId.toLowerCase() : "";
        out.push({ id: uniqueId(b.id, used), type: "groups", title: line(b.title, LIMITS.title), groupSetId });
        break;
      }
      case "seating":
        out.push({ id: uniqueId(b.id, used), type: "seating", title: line(b.title, LIMITS.title) });
        break;
      case "shuffle": {
        // `shown` is the server's, per viewer: never kept from a browser.
        const n = Math.round(Number(b.n));
        out.push({
          id: uniqueId(b.id, used), type: "shuffle", title: line(b.title, LIMITS.title),
          by: b.by === "count" ? "count" : "size",
          n: Number.isFinite(n) ? Math.min(LIMITS.maxGroupN, Math.max(LIMITS.minGroupN, n)) : 4,
          from: b.from === "here" ? "here" : "class",
        });
        break;
      }
      default:
        // An unknown type is dropped rather than refusing the whole save:
        // a newer browser tab must never make an older server lose a lesson.
        break;
    }
  }
  return out;
}

/**
 * What a student may see of a block. The teacher's answer key never leaves
 * the server for a student, live or otherwise.
 */
export function forStudent(b: Block): Block {
  if (b.type === "groups" || b.type === "shuffle") { const { shown: _s, ...rest } = b; return rest as Block; }
  if (b.type !== "poll") return b;
  return { ...b, choices: b.choices.map((c) => ({ ...c, correct: false })) };
}

/** Short label for outlines and the lesson strip. */
export function blockSummary(b: Block): string {
  switch (b.type) {
    case "text": return b.title || b.body.split("\n")[0].slice(0, 60);
    case "poll": return b.question.split("\n")[0].slice(0, 60);
    case "timer": return b.label || formatSeconds(b.seconds);
    case "picker": case "noise": return b.label;
    case "board": case "link": case "tool": return b.title;
    case "file": return b.title || b.name;
    case "assignment": case "groups": case "seating": case "shuffle": return b.title;
  }
}

/** What read-aloud says for a block: its words, choices lettered as on screen. */
export function blockSpeech(b: Block): string {
  switch (b.type) {
    case "text": return [b.title, b.body].filter(Boolean).join(".\n");
    case "poll": return [b.question, ...b.choices.map((c, i) => `${String.fromCharCode(65 + i)}. ${c.text}`)].join("\n");
    case "timer": case "picker": case "noise": return b.label;
    case "board": case "link": case "tool": return b.title;
    case "file": return [b.title || b.name, b.alt].filter(Boolean).join(".\n");
    case "assignment": return b.title;
    case "groups": case "shuffle": return [b.title, ...(b.shown?.groups ?? []).map((g) => `${g.name}: ${g.members.join(", ")}`)].filter(Boolean).join(".\n");
    case "seating": return b.title;
  }
}

/** The assignment ids a lesson's slides point at, once each. */
export function assignmentIdsIn(blocks: Block[]): string[] {
  return [...new Set(blocks.flatMap((b) => (b.type === "assignment" && b.assignmentId ? [b.assignmentId] : [])))];
}

/**
 * Assignment slides pointed at another assignment: `map` old id -> new id
 * (a copy into another course). A slide whose assignment has no new id is
 * dropped, never left pointing at the old course. Group slides are dropped
 * too: groups belong to one class's students.
 */
export function remapAssignments(blocks: Block[], map: Map<string, string>): Block[] {
  return blocks.flatMap((b) => {
    if (b.type === "groups") return [];
    if (b.type !== "assignment" || !b.assignmentId) return [b];
    const to = map.get(b.assignmentId);
    return to ? [{ ...b, assignmentId: to }] : [];
  });
}

/** The group sets a lesson's slides point at, once each. */
export function groupSetIdsIn(blocks: Block[]): string[] {
  return [...new Set(blocks.flatMap((b) => (b.type === "groups" && b.groupSetId ? [b.groupSetId] : [])))];
}

/** Where a file block's file opens (the route checks who may). */
export function fileUrl(fileId: string, download = false): string {
  return `/files/${fileId}${download ? "?download=1" : ""}`;
}

export function formatSeconds(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}
