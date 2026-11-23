/**
 * The grading review screen (story 01, grade assistant, no AI): finding a
 * rubric's sections and parts in a student's online writing, and the full
 * grade table as CSV. Pure: no database, no network, so it runs in the
 * grading desk and is tested directly.
 */

import { isParts, sectionPoints, type PartMarks, type Rubric } from "./rubric";

/** Where something sits in the student's text: [start, end) character offsets. */
export type Span = { start: number; end: number };
export type Located = { sections: Record<string, Span>; parts: Record<string, Span> };

const fold = (s: string) => s.toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A loose pattern for a phrase: any run of spaces matches any whitespace, case already folded. */
function phrase(words: string): RegExp | null {
  const w = fold(words).replace(/\s+/g, " ").trim();
  if (w.length < 3) return null;
  return new RegExp(w.split(" ").map(escapeRe).join("\\s+"));
}

/** The first match of a pattern at or after `from`. */
function findFrom(text: string, re: RegExp, from: number): number {
  const m = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  m.lastIndex = from;
  const r = m.exec(text);
  return r ? r.index : -1;
}

/** The question's opening words, enough to recognise it when a student copied it: up to the first sentence end or 8 words. */
function questionStart(q: string): string {
  const first = q.replace(/\s+/g, " ").trim().split(/(?<=[.?!:])\s/)[0] ?? "";
  return first.split(" ").slice(0, 8).join(" ").replace(/[.?!:;,]+$/, "");
}

/**
 * Where each section and part starts in the student's writing, found the
 * way a teacher's eye would: a section by its title; a part by its label at
 * the start of a line ("3a", "3a.", "(3a)") or by the opening words of its
 * question, searched after the section (or the previous part). Each runs to
 * where the next one found starts. Anything not found is simply left out:
 * the desk then shows the whole work.
 */
export function locate(rubric: Rubric | null, body: string | null): Located {
  const out: Located = { sections: {}, parts: {} };
  if (!isParts(rubric) || !body) return out;
  const text = fold(body);
  const marks: { kind: "s" | "p"; id: string; at: number }[] = [];
  let cursor = 0;
  for (const s of rubric.sections) {
    const t = s.title ? phrase(s.title) : null;
    const at = t ? findFrom(text, t, cursor) : -1;
    if (at >= 0) { marks.push({ kind: "s", id: s.id, at }); cursor = at; }
    let pc = cursor;
    for (const p of s.parts) {
      let pat = -1;
      if (p.label) {
        const lab = new RegExp(`(^|\\n)[ \\t]*\\(?${escapeRe(fold(p.label))}[).:\\-]?(\\s|$)`, "g");
        const i = findFrom(text, lab, pc);
        if (i >= 0) pat = text[i] === "\n" ? i + 1 : i;
      }
      if (pat < 0 && p.question) {
        const q = phrase(questionStart(p.question));
        if (q) pat = findFrom(text, q, pc);
      }
      if (pat >= 0) { marks.push({ kind: "p", id: p.id, at: pat }); pc = pat + 1; }
    }
    if (pc > cursor) cursor = pc;
  }
  // Each runs to the next start found (a part to the next part or section; a section to the next section).
  const sorted = [...marks].sort((a, b) => a.at - b.at);
  sorted.forEach((m, k) => {
    const next = sorted.slice(k + 1).find((x) => x.at > m.at && (m.kind === "p" || x.kind === "s"));
    const span = { start: m.at, end: next ? next.at : body.length };
    if (m.kind === "s") out.sections[m.id] = span; else out.parts[m.id] = span;
  });
  // A section not found by its title starts where its first part was found.
  for (const s of rubric.sections) {
    if (out.sections[s.id]) continue;
    const found = s.parts.map((p) => out.parts[p.id]).filter(Boolean);
    if (found.length) out.sections[s.id] = { start: Math.min(...found.map((x) => x.start)), end: Math.max(...found.map((x) => x.end)) };
  }
  return out;
}

/** The student's text cut into plain runs and located parts, in order, for drawing a box around each answer. */
export function segments(body: string, loc: Located): { text: string; partId: string | null }[] {
  const spans = Object.entries(loc.parts).map(([id, s]) => ({ id, ...s })).sort((a, b) => a.start - b.start);
  const out: { text: string; partId: string | null }[] = [];
  let at = 0;
  for (const s of spans) {
    if (s.start < at) continue;
    if (s.start > at) out.push({ text: body.slice(at, s.start), partId: null });
    out.push({ text: body.slice(s.start, s.end), partId: s.id });
    at = s.end;
  }
  if (at < body.length) out.push({ text: body.slice(at), partId: null });
  return out;
}

/** One CSV cell: quoted when needed; text that a spreadsheet would run as a formula starts with '. */
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return String(v);
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export type TableRow = {
  name: string; group: string | null; handedIn: string | null; late: boolean;
  score: number | null; countsAs: number | null; flag: string | null;
  parts: PartMarks | null; comment: string; reviewed: boolean; concerns: string[];
};
export type TableWords = {
  student: string; group: string; handedIn: string; late: string; total: string; percent: string; countsAs: string;
  flag: string; reviewed: string; concerns: string; feedback: string; yes: string; section: string;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The whole class's grades for one assignment as a CSV (the review
 * screen's Export): each section's points, each part's points, the total,
 * percent, what it counts as after the late policy, marks, reviewed,
 * integrity concerns (never a deduction) and the feedback.
 */
export function reviewCsv(rubric: Rubric | null, points: number, rows: TableRow[], w: TableWords): string {
  const sections = isParts(rubric) ? rubric.sections : [];
  const head = [
    w.student, w.group, w.handedIn, w.late,
    ...sections.map((s, i) => `${s.title || `${w.section} ${i + 1}`} (${sectionPoints(s)})`),
    ...sections.flatMap((s) => s.parts.map((p, k) => `${p.label || `${s.title || w.section} ${k + 1}`} (${p.points})`)),
    `${w.total} (${points})`, w.percent, w.countsAs, w.flag, w.reviewed, w.concerns, w.feedback,
  ];
  const lines = [head.map(csvCell).join(",")];
  for (const r of rows) {
    const sec = sections.map((s) => {
      const got = s.parts.map((p) => r.parts?.[p.id]?.score).filter((x): x is number => typeof x === "number");
      return got.length ? r2(got.reduce((a, b) => a + b, 0)) : null;
    });
    const parts = sections.flatMap((s) => s.parts.map((p) => r.parts?.[p.id]?.score ?? null));
    const cells: (string | number | null)[] = [
      r.name, r.group, r.handedIn, r.late ? w.yes : "",
      ...sec, ...parts,
      r.score, r.score !== null && points > 0 ? r2((r.score / points) * 100) : null,
      r.countsAs, r.flag, r.reviewed ? w.yes : "", r.concerns.join("; "), r.comment,
    ];
    lines.push(cells.map(csvCell).join(","));
  }
  // A byte-order mark so Excel opens the accents right.
  return "﻿" + lines.join("\r\n") + "\r\n";
}
