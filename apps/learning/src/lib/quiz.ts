/**
 * Quizzes: questions, settings, scoring and item analysis. Pure (no
 * database, no network), so it is tested directly and runs in the editor,
 * the student's screen and the grading desk as well.
 *
 * The shape is QTI 3.0's, named in plain words, so QTI import and export
 * later need no migration. Each question is an assessment item with one
 * interaction and one response declaration:
 *
 *   kind        QTI interaction            response (cardinality / baseType)   scoring
 *   single      choiceInteraction max=1    single / identifier                 match_correct
 *   truefalse   choiceInteraction max=1    single / identifier                 match_correct
 *   multiple    choiceInteraction max=0    multiple / identifier               match_correct (or partial)
 *   short       textEntryInteraction       single / string, mapping            map_response (caseSensitive)
 *   numeric     textEntryInteraction       single / float                      equal, toleranceMode absolute
 *   match       matchInteraction           multiple / directedPair             match_correct (or partial)
 *   order       orderInteraction           ordered / identifier                match_correct (or partial)
 *   essay       extendedTextInteraction    single / string                     scored by the teacher
 *
 * `identifier`s are QTI identifiers; `choices` are simpleChoice (or the first
 * simpleMatchSet), `targets` the second simpleMatchSet; `correct` is the
 * correctResponse (a match pair is "source target", as QTI writes a
 * directedPair). Everything from a browser or an import goes through
 * normalizeQuiz before it is stored.
 */

export const ITEM_KINDS = ["single", "multiple", "truefalse", "short", "numeric", "match", "order", "essay"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export type Choice = { identifier: string; text: string };

export type QuizItem = {
  identifier: string;
  kind: ItemKind;
  prompt: string;
  points: number;
  choices: Choice[];
  targets: Choice[];
  correct: string[];
  /** short: accepted answers must match letter case too. */
  caseSensitive: boolean;
  /** numeric: the answer and how far off still counts. */
  value: number | null;
  tolerance: number;
  /** multiple, match, order: part credit for each part right. */
  partial: boolean;
  /** The standard this question measures (a standards course). */
  standardId: string | null;
};

export type QuizSettings = {
  /** How many attempts; 0 = no limit. Students' extra attempts are added. */
  attempts: number;
  /** With several attempts, which one counts. */
  keep: "highest" | "latest";
  /** Minutes, or null for no limit. Students' extra time multiplies it. */
  timeLimit: number | null;
  shuffleItems: boolean;
  shuffleChoices: boolean;
  /** When students see which answers were right: as soon as they hand in, or when the teacher releases grades. */
  results: "on-hand-in" | "on-release";
  /** With the results, also show the right answers. */
  showAnswers: boolean;
};

export type Quiz = { settings: QuizSettings; items: QuizItem[] };

export const QUIZ_LIMITS = {
  items: 200, choices: 20, prompt: 5_000, choice: 1_000, accepted: 20, answer: 200,
  shortResponse: 500, essayResponse: 20_000, maxPoints: 1_000, attempts: 20, timeLimit: 600,
};

export const DEFAULT_SETTINGS: QuizSettings = {
  attempts: 1, keep: "highest", timeLimit: null, shuffleItems: false, shuffleChoices: false, results: "on-release", showAnswers: false,
};

const ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const UUID = /^[0-9a-f-]{36}$/i;

export function newItemId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const raw = c?.randomUUID ? c.randomUUID().replace(/-/g, "") : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return `i${raw.slice(0, 12)}`;
}

function text(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\r\n/g, "\n").trim().slice(0, max) : "";
}
function line(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).trim().replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
function uniqueId(raw: unknown, used: Set<string>): string {
  let id = typeof raw === "string" && ID_RE.test(raw) ? raw : newItemId();
  while (used.has(id)) id = newItemId();
  used.add(id);
  return id;
}

function cleanChoices(v: unknown, used: Set<string>, max = QUIZ_LIMITS.choices): Choice[] {
  if (!Array.isArray(v)) return [];
  const out: Choice[] = [];
  for (const raw of v.slice(0, max)) {
    const o = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    out.push({ identifier: uniqueId(o.identifier, used), text: text(o.text, QUIZ_LIMITS.choice) });
  }
  return out;
}

export function blankItem(kind: ItemKind, words = { true: "True", false: "False" }): QuizItem {
  const base: QuizItem = {
    identifier: newItemId(), kind, prompt: "", points: 1, choices: [], targets: [], correct: [],
    caseSensitive: false, value: null, tolerance: 0, partial: false, standardId: null,
  };
  const c = () => ({ identifier: newItemId(), text: "" });
  if (kind === "single" || kind === "multiple") base.choices = [c(), c(), c(), c()];
  if (kind === "truefalse") base.choices = [{ identifier: "true", text: words.true }, { identifier: "false", text: words.false }];
  if (kind === "order") base.choices = [c(), c(), c()];
  if (kind === "match") { base.choices = [c(), c(), c()]; base.targets = [c(), c(), c()]; }
  if (kind === "essay") base.points = 5;
  return base;
}

/** The only way a question gets in: types fixed, sizes capped, ids unique, the key made consistent. */
export function normalizeItem(raw: unknown, used: Set<string>): QuizItem | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const kind = ITEM_KINDS.includes(o.kind as ItemKind) ? (o.kind as ItemKind) : null;
  if (!kind) return null;
  const pts = num(o.points);
  const item: QuizItem = {
    identifier: uniqueId(o.identifier, used),
    kind,
    prompt: text(o.prompt, QUIZ_LIMITS.prompt),
    points: pts === null ? 1 : Math.min(QUIZ_LIMITS.maxPoints, Math.max(0, Math.round(pts * 100) / 100)),
    choices: [], targets: [], correct: [],
    caseSensitive: o.caseSensitive === true,
    value: null, tolerance: 0,
    partial: o.partial === true,
    standardId: typeof o.standardId === "string" && UUID.test(o.standardId) ? o.standardId : null,
  };
  const correct = Array.isArray(o.correct) ? o.correct.filter((x): x is string => typeof x === "string") : [];
  const local = new Set<string>();
  if (kind === "single" || kind === "multiple" || kind === "order") {
    item.choices = cleanChoices(o.choices, local);
    const ids = new Set(item.choices.map((c) => c.identifier));
    if (kind === "order") {
      // The right order is every choice once; when the key doesn't say, the order written is the answer.
      const listed = [...new Set(correct.filter((x) => ids.has(x)))];
      item.correct = listed.length === item.choices.length ? listed : item.choices.map((c) => c.identifier);
    } else {
      const picked = [...new Set(correct.filter((x) => ids.has(x)))];
      item.correct = kind === "single" ? picked.slice(0, 1) : picked;
    }
  } else if (kind === "truefalse") {
    const choices = cleanChoices(o.choices, new Set(), 2);
    item.choices = [
      { identifier: "true", text: choices.find((c) => c.identifier === "true")?.text || "True" },
      { identifier: "false", text: choices.find((c) => c.identifier === "false")?.text || "False" },
    ];
    item.correct = correct[0] === "true" || correct[0] === "false" ? [correct[0]] : [];
  } else if (kind === "match") {
    item.choices = cleanChoices(o.choices, local);
    item.targets = cleanChoices(o.targets, local);
    const src = new Set(item.choices.map((c) => c.identifier)), tgt = new Set(item.targets.map((c) => c.identifier));
    const seen = new Set<string>();
    for (const p of correct) {
      const [s, t] = p.split(" ");
      if (src.has(s) && tgt.has(t) && !seen.has(s)) { seen.add(s); item.correct.push(`${s} ${t}`); }
    }
  } else if (kind === "short") {
    item.correct = [...new Set(correct.map((x) => line(x, QUIZ_LIMITS.answer)).filter(Boolean))].slice(0, QUIZ_LIMITS.accepted);
  } else if (kind === "numeric") {
    item.value = num(o.value);
    const tol = num(o.tolerance);
    item.tolerance = tol === null ? 0 : Math.abs(tol);
  }
  if (kind !== "short") item.caseSensitive = false;
  if (kind !== "multiple" && kind !== "match" && kind !== "order") item.partial = false;
  return item;
}

export function normalizeSettings(raw: unknown): QuizSettings {
  const o = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const attempts = Math.floor(Number(o.attempts));
  const limit = num(o.timeLimit);
  return {
    attempts: Number.isFinite(attempts) ? Math.min(QUIZ_LIMITS.attempts, Math.max(0, attempts)) : DEFAULT_SETTINGS.attempts,
    keep: o.keep === "latest" ? "latest" : "highest",
    timeLimit: limit === null || limit <= 0 ? null : Math.min(QUIZ_LIMITS.timeLimit, Math.max(1, Math.round(limit))),
    shuffleItems: o.shuffleItems === true,
    shuffleChoices: o.shuffleChoices === true,
    results: o.results === "on-hand-in" ? "on-hand-in" : "on-release",
    showAnswers: o.showAnswers === true,
  };
}

export function normalizeQuiz(raw: unknown): Quiz {
  const o = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const used = new Set<string>();
  const items = (Array.isArray(o.items) ? o.items : []).slice(0, QUIZ_LIMITS.items)
    .map((x) => normalizeItem(x, used)).filter((x): x is QuizItem => !!x);
  return { settings: normalizeSettings(o.settings), items };
}

export function quizPoints(q: Quiz | null): number {
  return Math.round((q?.items ?? []).reduce((n, i) => n + i.points, 0) * 100) / 100;
}

/** Scored by the teacher: essays, and short answers with no accepted answer written. */
export function handGraded(i: QuizItem): boolean {
  return i.kind === "essay" || (i.kind === "short" && i.correct.length === 0) || (i.kind === "numeric" && i.value === null);
}

/** The QTI response declaration a question stands for (export later; also a check on the shape). */
export function responseDeclaration(i: QuizItem): { interaction: string; cardinality: string; baseType: string; correctResponse: string[] } {
  const map: Record<ItemKind, [string, string, string]> = {
    single: ["choiceInteraction", "single", "identifier"],
    truefalse: ["choiceInteraction", "single", "identifier"],
    multiple: ["choiceInteraction", "multiple", "identifier"],
    short: ["textEntryInteraction", "single", "string"],
    numeric: ["textEntryInteraction", "single", "float"],
    match: ["matchInteraction", "multiple", "directedPair"],
    order: ["orderInteraction", "ordered", "identifier"],
    essay: ["extendedTextInteraction", "single", "string"],
  };
  const [interaction, cardinality, baseType] = map[i.kind];
  const correctResponse = i.kind === "numeric" ? (i.value === null ? [] : [String(i.value)]) : i.kind === "essay" ? [] : i.correct;
  return { interaction, cardinality, baseType, correctResponse };
}

// ---------- responses ----------

/** A student's answer: a choice id or text; several ids (multiple, order); or source → target (match). */
export type Response = string | string[] | Record<string, string>;
export type Responses = Record<string, Response>;

export function cleanResponse(i: QuizItem, v: unknown): Response | null {
  if (v === null || v === undefined) return null;
  const ids = new Set(i.choices.map((c) => c.identifier));
  switch (i.kind) {
    case "single": case "truefalse":
      return typeof v === "string" && ids.has(v) ? v : null;
    case "multiple": {
      if (!Array.isArray(v)) return null;
      const out = [...new Set(v.filter((x): x is string => typeof x === "string" && ids.has(x)))];
      return out.length ? out : null;
    }
    case "order": {
      if (!Array.isArray(v)) return null;
      const out = [...new Set(v.filter((x): x is string => typeof x === "string" && ids.has(x)))];
      return out.length === ids.size ? out : null;
    }
    case "match": {
      if (!v || typeof v !== "object" || Array.isArray(v)) return null;
      const tgt = new Set(i.targets.map((c) => c.identifier));
      const out: Record<string, string> = {};
      for (const [s, t] of Object.entries(v as Record<string, unknown>)) if (ids.has(s) && typeof t === "string" && tgt.has(t)) out[s] = t;
      return Object.keys(out).length ? out : null;
    }
    case "short": case "numeric":
      return typeof v === "string" && v.trim() ? v.slice(0, QUIZ_LIMITS.shortResponse) : null;
    case "essay":
      return typeof v === "string" && v.trim() ? v.slice(0, QUIZ_LIMITS.essayResponse) : null;
  }
}

/** Only answers to this quiz's questions, each cleaned. */
export function cleanResponses(q: Quiz, v: unknown): Responses {
  const out: Responses = {};
  if (!v || typeof v !== "object") return out;
  for (const i of q.items) {
    const r = cleanResponse(i, (v as Record<string, unknown>)[i.identifier]);
    if (r !== null) out[i.identifier] = r;
  }
  return out;
}

// ---------- scoring ----------

const r2 = (n: number) => Math.round(n * 100) / 100;

function sameText(a: string, b: string, caseSensitive: boolean): boolean {
  const n = (s: string) => s.replace(/\s+/g, " ").trim().normalize("NFC");
  return caseSensitive ? n(a) === n(b) : n(a).toLocaleLowerCase() === n(b).toLocaleLowerCase();
}

export function parseNumber(s: string): number | null {
  const t = s.trim().replace(/\s/g, "");
  // "3,5" is three and a half; "1,000" (thousands) is not accepted as anything else.
  const n = /^-?\d+,\d+$/.test(t) && !/^-?\d{1,3},\d{3}$/.test(t) ? Number(t.replace(",", ".")) : Number(t.replace(/,/g, ""));
  return t && Number.isFinite(n) ? n : null;
}

/** A question's automatic score, or null when a teacher must score it. */
export function scoreItem(i: QuizItem, r: Response | null | undefined): number | null {
  if (handGraded(i)) return null;
  if (r === null || r === undefined) return 0;
  const full = i.points;
  switch (i.kind) {
    case "single": case "truefalse":
      return r === i.correct[0] ? full : 0;
    case "multiple": {
      if (!Array.isArray(r) || !i.correct.length) return 0;
      const hits = r.filter((x) => i.correct.includes(x)).length, wrong = r.length - hits;
      if (hits === i.correct.length && wrong === 0) return full;
      return i.partial ? r2(full * Math.max(0, hits - wrong) / i.correct.length) : 0;
    }
    case "order": {
      if (!Array.isArray(r)) return 0;
      const right = i.correct.filter((x, k) => r[k] === x).length;
      if (right === i.correct.length) return full;
      return i.partial ? r2(full * right / i.correct.length) : 0;
    }
    case "match": {
      if (typeof r !== "object" || Array.isArray(r) || !i.correct.length) return 0;
      const right = i.correct.filter((p) => { const [s, t] = p.split(" "); return r[s] === t; }).length;
      if (right === i.correct.length) return full;
      return i.partial ? r2(full * right / i.correct.length) : 0;
    }
    case "short":
      return typeof r === "string" && i.correct.some((a) => sameText(r, a, i.caseSensitive)) ? full : 0;
    case "numeric": {
      const n = typeof r === "string" ? parseNumber(r) : null;
      return n !== null && i.value !== null && Math.abs(n - i.value) <= i.tolerance + 1e-9 ? full : 0;
    }
    default:
      return null;
  }
}

/** One question's score in an attempt: the teacher's if they gave one, else the automatic one. */
export type ItemScore = { score: number | null; by: string };
export type Scores = Record<string, ItemScore>;

/**
 * Scores every question of an attempt. A teacher's score stays (capped at the
 * question's points, which may have changed); everything else is worked out
 * from the current key, which is what a regrade is.
 */
export function scoreAttempt(q: Quiz, responses: Responses, prior: Scores = {}): { scores: Scores; total: number; pending: number } {
  const scores: Scores = {};
  let total = 0, pending = 0;
  for (const i of q.items) {
    const was = prior[i.identifier];
    let s: ItemScore;
    if (was && was.by !== "auto" && was.score !== null) s = { score: Math.min(was.score, i.points), by: was.by };
    else s = { score: scoreItem(i, responses[i.identifier]), by: "auto" };
    // An essay left empty needs no teacher: there is nothing to read.
    if (s.score === null && handGraded(i) && !responses[i.identifier]) s = { score: 0, by: "auto" };
    scores[i.identifier] = s;
    if (s.score === null) pending++; else total += s.score;
  }
  return { scores, total: r2(total), pending };
}

/** What changes a score: when any of this differs, saved attempts are regraded. */
export function scoringKey(q: Quiz | null): string {
  return JSON.stringify((q?.items ?? []).map((i) => [i.identifier, i.kind, i.points, i.correct, i.caseSensitive, i.value, i.tolerance, i.partial]));
}

// ---------- layout (shuffles) ----------

export type Layout = { items: string[]; choices: Record<string, string[]>; targets: Record<string, string[]> };

function shuffled<T>(list: T[], rnd: () => number): T[] {
  const a = [...list];
  for (let k = a.length - 1; k > 0; k--) {
    const j = Math.floor(rnd() * (k + 1));
    [a[k], a[j]] = [a[j], a[k]];
  }
  return a;
}

/**
 * The order one student sees, fixed when the attempt starts. An ordering
 * question always starts shuffled (never already in the right order), and a
 * matching question's answers always do; true/false never moves.
 */
export function makeLayout(q: Quiz, rnd: () => number = Math.random): Layout {
  const ids = q.items.map((i) => i.identifier);
  const out: Layout = { items: q.settings.shuffleItems ? shuffled(ids, rnd) : ids, choices: {}, targets: {} };
  for (const i of q.items) {
    const c = i.choices.map((x) => x.identifier);
    if (i.kind === "order") {
      let s = shuffled(c, rnd);
      for (let n = 0; n < 5 && c.length > 1 && s.join() === i.correct.join(); n++) s = shuffled(c, rnd);
      if (c.length > 1 && s.join() === i.correct.join()) s = [...s.slice(1), s[0]];
      out.choices[i.identifier] = s;
    } else if ((i.kind === "single" || i.kind === "multiple" || i.kind === "match") && q.settings.shuffleChoices) {
      out.choices[i.identifier] = shuffled(c, rnd);
    }
    if (i.kind === "match") out.targets[i.identifier] = shuffled(i.targets.map((x) => x.identifier), rnd);
  }
  return out;
}

/** A question as a student sees it: no key, choices in their order. */
export type StudentItem = Pick<QuizItem, "identifier" | "kind" | "prompt" | "points" | "choices" | "targets">;

function arrange(list: Choice[], order: string[] | undefined): Choice[] {
  if (!order) return list;
  const by = new Map(list.map((c) => [c.identifier, c]));
  const out = order.map((id) => by.get(id)).filter((c): c is Choice => !!c);
  for (const c of list) if (!order.includes(c.identifier)) out.push(c);
  return out;
}

export function studentItems(q: Quiz, layout: Layout | null): StudentItem[] {
  const by = new Map(q.items.map((i) => [i.identifier, i]));
  const order = layout ? [...layout.items.filter((id) => by.has(id)), ...q.items.map((i) => i.identifier).filter((id) => !layout.items.includes(id))] : q.items.map((i) => i.identifier);
  return order.map((id) => by.get(id)!).map((i) => ({
    identifier: i.identifier, kind: i.kind, prompt: i.prompt, points: i.points,
    choices: arrange(i.choices, layout?.choices[i.identifier]),
    targets: arrange(i.targets, layout?.targets[i.identifier]),
  }));
}

/** The right answer of a question in words, for results and the grading desk. */
export function answerText(i: QuizItem): string {
  const name = (id: string, list = i.choices) => list.find((c) => c.identifier === id)?.text ?? "";
  switch (i.kind) {
    case "single": case "truefalse": case "multiple": return i.correct.map((id) => name(id)).join("; ");
    case "order": return i.correct.map((id) => name(id)).join(" → ");
    case "match": return i.correct.map((p) => { const [s, t] = p.split(" "); return `${name(s)} → ${name(t, i.targets)}`; }).join("; ");
    case "short": return i.correct.join(" / ");
    case "numeric": return i.value === null ? "" : i.tolerance ? `${i.value} ± ${i.tolerance}` : String(i.value);
    default: return "";
  }
}

/** A student's answer in words. */
export function responseText(i: QuizItem, r: Response | null | undefined): string {
  if (r === null || r === undefined) return "";
  const name = (id: string, list = i.choices) => list.find((c) => c.identifier === id)?.text ?? "?";
  if (typeof r === "string") return i.kind === "single" || i.kind === "truefalse" ? name(r) : r;
  if (Array.isArray(r)) return r.map((id) => name(id)).join(i.kind === "order" ? " → " : "; ");
  return Object.entries(r).map(([s, t]) => `${name(s)} → ${name(t, i.targets)}`).join("; ");
}

// ---------- attempts ----------

export type AttemptSummary = { number: number; score: number | null; pending: number; submittedAt: string | null };

/** Which attempt counts: the highest or the latest handed in. Ties go to the earlier one. */
export function keptAttempt<T extends AttemptSummary>(list: T[], keep: QuizSettings["keep"]): T | null {
  const done = list.filter((a) => a.submittedAt).sort((a, b) => a.number - b.number);
  if (!done.length) return null;
  if (keep === "latest") return done[done.length - 1];
  return done.reduce((best, a) => ((a.score ?? 0) > (best.score ?? 0) ? a : best));
}

/** Attempts allowed: the quiz's plus the student's extra (0 = no limit). */
export function attemptsAllowed(s: QuizSettings, extra: number): number {
  return s.attempts === 0 ? 0 : s.attempts + Math.max(0, extra);
}

/** The minutes this student gets, or null for no limit. */
export function minutesFor(s: QuizSettings, timeFactor: number): number | null {
  return s.timeLimit === null ? null : Math.round(s.timeLimit * Math.max(1, timeFactor));
}

// ---------- standards ----------

/**
 * Levels from a quiz's scores, in proportion like a rubric row: per
 * standard, the share of points earned on its questions (a whole-quiz
 * standard counts every question). Never below 1; nothing without questions.
 */
export function levelsFromQuiz(q: Quiz, quizStandards: string[] | null, scores: Scores, top: number): Record<string, number> {
  const out: Record<string, number> = {};
  const share = (items: QuizItem[]): number | null => {
    const max = items.reduce((n, i) => n + i.points, 0);
    if (max <= 0) return null;
    return items.reduce((n, i) => n + (scores[i.identifier]?.score ?? 0), 0) / max;
  };
  const level = (f: number) => Math.min(top, Math.max(1, Math.floor(f * top + 0.5 + 1e-9)));
  for (const id of quizStandards ?? []) {
    const f = share(q.items);
    if (f !== null) out[id] = level(f);
  }
  const ids = [...new Set(q.items.map((i) => i.standardId).filter((x): x is string => !!x))];
  for (const id of ids) {
    const f = share(q.items.filter((i) => i.standardId === id));
    if (f !== null) out[id] = level(f);
  }
  return out;
}

// ---------- item analysis ----------

export type ItemStats = {
  identifier: string;
  answered: number;
  /** Share of full marks, 0-100, over the questions scored; null with none. */
  percentCorrect: number | null;
  averageScore: number | null;
  /** Choice questions: how many picked each choice. */
  picks: Record<string, number>;
  waiting: number;
};

/** Per question, over the attempt that counts for each student. */
export function itemAnalysis(q: Quiz, attempts: { responses: Responses; scores: Scores }[]): ItemStats[] {
  return q.items.map((i) => {
    let n = 0, full = 0, sum = 0, waiting = 0;
    const picks: Record<string, number> = {};
    for (const a of attempts) {
      const r = a.responses[i.identifier];
      const s = a.scores[i.identifier];
      if (!s) continue;
      n++;
      if (s.score === null) { waiting++; continue; }
      sum += s.score;
      if (s.score >= i.points) full++;
      if (typeof r === "string" && (i.kind === "single" || i.kind === "truefalse")) picks[r] = (picks[r] ?? 0) + 1;
      if (Array.isArray(r) && i.kind === "multiple") for (const id of r) picks[id] = (picks[id] ?? 0) + 1;
    }
    const scored = n - waiting;
    return {
      identifier: i.identifier,
      answered: n,
      percentCorrect: scored ? Math.round((full / scored) * 100) : null,
      averageScore: scored ? r2(sum / scored) : null,
      picks,
      waiting,
    };
  });
}
