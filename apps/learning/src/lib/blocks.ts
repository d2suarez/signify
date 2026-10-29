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

export type Block = TextBlock | PollBlock | TimerBlock;
export type BlockType = Block["type"];

export const BLOCK_TYPES: BlockType[] = ["text", "poll", "timer"];

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
};

export class BlockError extends Error {}

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

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
  if (b.type !== "poll") return b;
  return { ...b, choices: b.choices.map((c) => ({ ...c, correct: false })) };
}

/** Short label for outlines and the lesson strip. */
export function blockSummary(b: Block): string {
  switch (b.type) {
    case "text": return b.title || b.body.split("\n")[0].slice(0, 60);
    case "poll": return b.question.split("\n")[0].slice(0, 60);
    case "timer": return b.label || formatSeconds(b.seconds);
  }
}

export function formatSeconds(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}
