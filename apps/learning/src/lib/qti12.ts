import { parseXml, XmlError, kid, kids, find, textOf, type XmlNode } from "./xml";
import { htmlToBlocks } from "./html-text";
import { DEFAULT_SETTINGS, normalizeQuiz, type ItemKind, type Quiz } from "./quiz";

/**
 * Reads a QTI 1.2 assessment (what Common Cartridge, Schoology and Canvas
 * course exports hold for quizzes: `imsqti_xmlv1p2`) into a Learning quiz.
 * Pure. The XML goes through xml.ts, which refuses any DOCTYPE or ENTITY,
 * so there is no XXE or entity expansion; all HTML is turned into plain
 * text by html-text.ts (the sanitizer); everything ends in normalizeQuiz,
 * which caps sizes and counts.
 *
 * Question types are read from the item's metadata (CC `cc_profile`,
 * Canvas `question_type`) or, without it, from the shape of the response:
 *
 *   cc.multiple_choice / multiple_choice_question      → single (true/false when the two choices say so)
 *   cc.true_false / true_false_question                → truefalse
 *   cc.multiple_response / multiple_answers_question   → multiple
 *   cc.fib / short_answer_question                     → short (accepted answers, case from `case`)
 *   numerical_question                                 → numeric (exact or a range)
 *   matching_question                                  → match
 *   cc.essay / essay_question                          → essay
 *
 * Anything else (pattern match, formulas, file upload, several blanks, …)
 * is listed as skipped with its type, never guessed at.
 */

export type QtiSkipped = { title: string; type: string };
export type QtiQuiz = { title: string; instructions: string; quiz: Quiz; skipped: QtiSkipped[] };

const TRUE_WORDS = /^(true|verdadero|cierto|t|v|yes|s[ií])$/i;
const FALSE_WORDS = /^(false|falso|f|no)$/i;

/** HTML (or plain text) to plain text: the page sanitizer, flattened. */
export function plainText(raw: string, isHtml?: boolean): string {
  const html = isHtml ?? /<[a-z][\s\S]*>/i.test(raw);
  if (!html) return raw.replace(/\r\n/g, "\n").trim();
  return htmlToBlocks(raw).blocks
    .map((b) => (b.type === "text" ? [b.title, b.body].filter(Boolean).join("\n\n") : [b.title, b.url].filter(Boolean).join(": ")))
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

/** A node's own materials: direct ones and those in its flow / flow_mat wrappers (never a response's). */
function materials(n: XmlNode): XmlNode[] {
  const out: XmlNode[] = [];
  for (const c of n.children) {
    if (c.name === "material") out.push(c);
    else if (c.name === "flow" || c.name === "flow_mat") out.push(...materials(c));
  }
  return out;
}

function matText(n: XmlNode | undefined): string {
  if (!n) return "";
  const parts: string[] = [];
  const mats = materials(n);
  for (const m of mats.length ? mats : n.name === "material" ? [n] : []) {
    for (const t of [...kids(m, "mattext"), ...kids(m, "mat_extension").flatMap((x) => kids(x, "mattext"))]) {
      parts.push(plainText(textOf(t), (t.attrs.texttype ?? "").includes("html") ? true : undefined));
    }
    for (const img of kids(m, "matimage")) parts.push(`[Image${img.attrs.label ? `: ${img.attrs.label}` : ""}]`);
  }
  return parts.filter(Boolean).join("\n").trim();
}

function metadata(n: XmlNode | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of kids(kid(n, "qtimetadata"), "qtimetadatafield")) {
    out.set(textOf(kid(f, "fieldlabel")).trim().toLowerCase(), textOf(kid(f, "fieldentry")).trim());
  }
  return out;
}

/** Identifiers made safe for the quiz model, each raw one always to the same safe one. */
class Ids {
  private map = new Map<string, string>();
  private used = new Set<string>();
  get(raw: string): string {
    const had = this.map.get(raw);
    if (had) return had;
    let id = raw.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 56) || "x";
    if (this.used.has(id)) { let n = 2; while (this.used.has(`${id}_${n}`)) n++; id = `${id}_${n}`; }
    this.used.add(id);
    this.map.set(raw, id);
    return id;
  }
}

type Cond = { equal: { respident: string; value: string; caseSensitive: boolean }[]; ranges: { respident: string; gte: number | null; lte: number | null }[]; score: number };

/** Conditions that give points, with what they test (never what sits under <not>). */
function positiveConditions(item: XmlNode): Cond[] {
  const out: Cond[] = [];
  for (const rp of kids(item, "resprocessing")) {
    for (const rc of kids(rp, "respcondition")) {
      let score = 0;
      for (const sv of kids(rc, "setvar")) {
        const v = Number(textOf(sv).trim());
        if (Number.isFinite(v) && v > score && (sv.attrs.action ?? "Set").toLowerCase() !== "subtract") score = v;
      }
      if (score <= 0) continue;
      const c: Cond = { equal: [], ranges: [], score };
      const walk = (n: XmlNode) => {
        for (const ch of n.children) {
          if (ch.name === "not") continue;
          if (ch.name === "varequal") c.equal.push({ respident: ch.attrs.respident ?? "", value: textOf(ch).trim(), caseSensitive: /^yes$/i.test(ch.attrs.case ?? "") });
          else if (ch.name === "and" && (kids(ch, "vargte").length || kids(ch, "vargt").length)) {
            const lo = kid(ch, "vargte") ?? kid(ch, "vargt"), hi = kid(ch, "varlte") ?? kid(ch, "varlt");
            c.ranges.push({ respident: lo?.attrs.respident ?? hi?.attrs.respident ?? "", gte: num(textOf(lo)), lte: num(textOf(hi)) });
          } else walk(ch);
        }
      };
      const cv = kid(rc, "conditionvar");
      if (cv) walk(cv);
      out.push(c);
    }
  }
  return out;
}

function num(s: string): number | null {
  const t = s.trim();
  const n = Number(t);
  return t && Number.isFinite(n) ? n : null;
}

function kindFrom(meta: Map<string, string>, item: XmlNode): { kind: ItemKind | null; type: string } {
  const profile = (meta.get("cc_profile") ?? "").toLowerCase();
  const qtype = (meta.get("question_type") ?? meta.get("interactiontype") ?? "").toLowerCase();
  const type = qtype || profile || "";
  const has = (s: string) => profile.includes(s) || qtype.includes(s);
  if (has("true_false")) return { kind: "truefalse", type };
  if (has("multiple_response") || has("multiple_answers")) return { kind: "multiple", type };
  if (has("multiple_dropdowns") || has("fill_in_multiple_blanks") || has("pattern_match") || has("calculated") || has("file_upload") || has("text_only")) return { kind: null, type };
  if (has("multiple_choice")) return { kind: "single", type };
  if (has("cc.fib") || has("short_answer")) return { kind: "short", type };
  if (has("numerical")) return { kind: "numeric", type };
  if (has("matching")) return { kind: "match", type };
  if (has("essay")) return { kind: "essay", type };
  if (type) return { kind: null, type };
  // No metadata: read the response's shape.
  const pres = kid(item, "presentation");
  const lids = pres ? collect(pres, "response_lid") : [];
  const strs = pres ? collect(pres, "response_str").concat(collect(pres, "response_num")) : [];
  if (lids.length > 1) return { kind: "match", type: "matching" };
  if (lids.length === 1) return { kind: (lids[0].attrs.rcardinality ?? "").toLowerCase() === "multiple" ? "multiple" : "single", type: "choice" };
  if (strs.length === 1) {
    const conds = positiveConditions(item);
    if (conds.some((c) => c.ranges.length)) return { kind: "numeric", type: "numeric" };
    return { kind: conds.some((c) => c.equal.length) ? "short" : "essay", type: "text" };
  }
  return { kind: null, type: "unknown" };
}

/** Every node named `name` below `n`, in order. */
function collect(n: XmlNode, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  for (const c of n.children) {
    if (c.name === name) out.push(c);
    out.push(...collect(c, name));
  }
  return out;
}

function choicesOf(lid: XmlNode, ids: Ids): { identifier: string; raw: string; text: string }[] {
  return collect(lid, "response_label").map((l) => ({ identifier: ids.get(l.attrs.ident ?? ""), raw: l.attrs.ident ?? "", text: matText(l) }));
}

function readItem(item: XmlNode, n: number): { item: Record<string, unknown> | null; skipped: QtiSkipped | null } {
  const meta = metadata(kid(item, "itemmetadata"));
  const title = (item.attrs.title || `Question ${n}`).replace(/\s+/g, " ").trim().slice(0, 200);
  const { kind, type } = kindFrom(meta, item);
  if (!kind) return { item: null, skipped: { title, type: type || "unknown" } };
  const pres = kid(item, "presentation");
  const prompt = matText(pres);
  const pts = num(meta.get("points_possible") ?? "");
  const ids = new Ids();
  const conds = positiveConditions(item);
  const base = { identifier: ids.get(item.attrs.ident || `item${n}`), prompt, points: pts !== null && pts >= 0 ? pts : 1 };

  if (kind === "single" || kind === "multiple" || kind === "truefalse") {
    const lid = pres ? find(pres, "response_lid") : undefined;
    if (!lid) return { item: null, skipped: { title, type } };
    const choices = choicesOf(lid, ids);
    const best = Math.max(0, ...conds.map((c) => c.score));
    const right = new Set<string>();
    for (const c of conds) {
      // Single answer: the condition worth most. Several: every one that gives points.
      if (kind !== "multiple" && c.score < best) continue;
      for (const e of c.equal) if (!e.respident || e.respident === lid.attrs.ident) right.add(e.value);
    }
    const correct = choices.filter((c) => right.has(c.raw)).map((c) => c.identifier);
    const tf = choices.length === 2 && TRUE_WORDS.test(choices[0].text) !== TRUE_WORDS.test(choices[1].text)
      && choices.every((c) => TRUE_WORDS.test(c.text) || FALSE_WORDS.test(c.text));
    if ((kind === "truefalse" || (kind === "single" && tf)) && tf) {
      const pick = choices.find((c) => correct.includes(c.identifier));
      return { item: { ...base, kind: "truefalse", correct: pick ? [TRUE_WORDS.test(pick.text) ? "true" : "false"] : [] }, skipped: null };
    }
    return {
      item: { ...base, kind: kind === "truefalse" ? "single" : kind, choices: choices.map(({ identifier, text }) => ({ identifier, text })), correct: kind === "single" || kind === "truefalse" ? correct.slice(0, 1) : correct },
      skipped: null,
    };
  }

  if (kind === "short") {
    const answers = conds.flatMap((c) => c.equal.map((e) => e.value)).filter(Boolean);
    return { item: { ...base, kind: "short", correct: answers, caseSensitive: conds.some((c) => c.equal.some((e) => e.caseSensitive)) }, skipped: null };
  }

  if (kind === "numeric") {
    const r = conds.flatMap((c) => c.ranges)[0];
    const exact = conds.flatMap((c) => c.equal).map((e) => num(e.value)).find((x) => x !== null) ?? null;
    if (r && r.gte !== null && r.lte !== null) return { item: { ...base, kind: "numeric", value: (r.gte + r.lte) / 2, tolerance: Math.abs(r.lte - r.gte) / 2 }, skipped: null };
    if (exact !== null) return { item: { ...base, kind: "numeric", value: exact, tolerance: 0 }, skipped: null };
    return { item: null, skipped: { title, type } };
  }

  if (kind === "match") {
    // One response_lid per left-hand item, each listing the same right-hand answers.
    const lids = pres ? collect(pres, "response_lid") : [];
    if (lids.length < 2) return { item: null, skipped: { title, type } };
    const targets = new Map<string, { identifier: string; text: string }>();
    for (const l of lids) for (const c of choicesOf(l, ids)) if (!targets.has(c.raw)) targets.set(c.raw, { identifier: c.identifier, text: c.text });
    const sources = lids.map((l) => ({ raw: l.attrs.ident ?? "", identifier: ids.get(`src:${l.attrs.ident ?? ""}`), text: matText(l) }));
    const correct: string[] = [];
    for (const c of conds) for (const e of c.equal) {
      const s = sources.find((x) => x.raw === e.respident), t = targets.get(e.value);
      if (s && t) correct.push(`${s.identifier} ${t.identifier}`);
    }
    return {
      item: { ...base, kind: "match", partial: true, choices: sources.map(({ identifier, text }) => ({ identifier, text })), targets: [...targets.values()], correct },
      skipped: null,
    };
  }

  return { item: { ...base, kind: "essay" }, skipped: null };
}

/**
 * The quiz in one QTI 1.2 document, or null when it isn't one (a question
 * bank, or not QTI). A document that can't be read safely (DOCTYPE, bad
 * XML) is null too: the import lists it as not imported.
 */
export function readQti12(xml: string, fallbackTitle = ""): QtiQuiz | null {
  let root: XmlNode;
  try {
    root = parseXml(xml);
  } catch (e) {
    if (e instanceof XmlError) return null;
    throw e;
  }
  const assessment = root.name === "assessment" ? root : kid(root, "assessment");
  if (!assessment) return null;
  const title = (assessment.attrs.title || fallbackTitle || "Quiz").replace(/\s+/g, " ").trim().slice(0, 200);
  const meta = metadata(assessment);
  const attemptsRaw = (meta.get("cc_maxattempts") ?? "").toLowerCase();
  const limit = num(meta.get("qmd_timelimit") ?? "");
  const items: Record<string, unknown>[] = [];
  const skipped: QtiSkipped[] = [];
  let n = 0;
  for (const it of collect(assessment, "item")) {
    const got = readItem(it, ++n);
    if (got.item) items.push(got.item);
    if (got.skipped) skipped.push(got.skipped);
  }
  const instructions = matText(kid(assessment, "presentation_material") ?? find(assessment, "rubric")).slice(0, 20_000);
  const quiz = normalizeQuiz({
    settings: {
      ...DEFAULT_SETTINGS,
      attempts: attemptsRaw === "unlimited" ? 0 : num(attemptsRaw) ?? DEFAULT_SETTINGS.attempts,
      timeLimit: limit,
    },
    items,
  });
  return { title, instructions, quiz, skipped };
}
