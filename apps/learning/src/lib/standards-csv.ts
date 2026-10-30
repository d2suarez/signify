/**
 * Standards library helpers with no database: grade levels (CASE education
 * levels) and reading a school's or teacher's standards from a CSV file.
 * Runs on the server and in the browser.
 */

/** CASE education levels, in order. */
export const GRADE_LEVELS = ["PK", "KG", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"] as const;
export type GradeLevel = (typeof GRADE_LEVELS)[number];

/** One level from what people type: "K", "kg", "3", "03", "pk". */
export function gradeLevel(v: string): GradeLevel | null {
  const s = v.trim().toUpperCase().replace(/^K$/, "KG").replace(/^PRE-?K$/, "PK").replace(/^(\d)$/, "0$1");
  return (GRADE_LEVELS as readonly string[]).includes(s) ? (s as GradeLevel) : null;
}

/** "K, 1-3, 9–12" → ["KG","01","02","03","09","10","11","12"], in order, once each. */
export function gradeList(v: unknown): GradeLevel[] {
  const parts = Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(/[,;\s]+/) : [];
  const out = new Set<GradeLevel>();
  for (const p of parts) {
    const [a, b] = p.replace(/pre-?k/gi, "PK").split(/[-–]/);
    const from = gradeLevel(a ?? ""), to = b !== undefined ? gradeLevel(b) : from;
    if (!from || !to) continue;
    const i = GRADE_LEVELS.indexOf(from), j = GRADE_LEVELS.indexOf(to);
    for (let k = Math.min(i, j); k <= Math.max(i, j); k++) out.add(GRADE_LEVELS[k]);
  }
  return GRADE_LEVELS.filter((g) => out.has(g));
}

/** Short words for a list of levels: "K–5", "3", "9–12", "K, 3, 5". */
export function gradeSpan(list: string[], k = "K", pk = "PK"): string {
  const idx = list.map((g) => GRADE_LEVELS.indexOf(g as GradeLevel)).filter((i) => i >= 0).sort((a, b) => a - b);
  if (!idx.length) return "";
  const word = (i: number) => (i === 0 ? pk : i === 1 ? k : String(i - 1));
  const runs: string[] = [];
  for (let s = 0; s < idx.length;) {
    let e = s;
    while (e + 1 < idx.length && idx[e + 1] === idx[e] + 1) e++;
    runs.push(e === s ? word(idx[s]) : `${word(idx[s])}–${word(idx[e])}`);
    s = e + 1;
  }
  return runs.join(", ");
}

// ---------- CSV ----------

/** RFC 4180-ish: commas (or semicolons/tabs, guessed from the first line), quotes, "" inside quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const first = src.split(/\r?\n/, 1)[0] ?? "";
  const sep = [",", ";", "\t"].map((c) => [c, first.split(c).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export const CSV_LIMITS = { rows: 3000, code: 60, statement: 2000, type: 60 };

export type CsvItem = { line: number; code: string; statement: string; grades: GradeLevel[]; type: string | null; parentCode: string | null };
export type CsvProblem = { line: number; problem: "noStatement" | "unknownParent" | "duplicateCode" | "tooMany" };

const HEADERS: Record<string, keyof Omit<CsvItem, "line" | "grades"> | "grades"> = {
  code: "code", "human coding scheme": "code", humancodingscheme: "code", standard: "code", id: "code",
  statement: "statement", description: "statement", "full statement": "statement", fullstatement: "statement", text: "statement",
  grades: "grades", grade: "grades", "grade levels": "grades", "education level": "grades", educationlevel: "grades",
  type: "type", "item type": "type", cfitemtype: "type",
  parent: "parentCode", "parent code": "parentCode", parentcode: "parentCode",
};

/**
 * Rows of a standards CSV. The first row names the columns (code,
 * statement, grades, type, parent; a few other common names are accepted).
 * A parent is named by its code and must come earlier in the file or
 * already be in the framework (`existingCodes`).
 */
export function csvItems(text: string, existingCodes: Iterable<string> = []): { items: CsvItem[]; problems: CsvProblem[]; columns: string[] } {
  const rows = parseCsv(text);
  const head = (rows.shift() ?? []).map((h) => HEADERS[h.trim().toLowerCase()] ?? "");
  const col = (r: string[], k: string) => { const i = head.indexOf(k as never); return i >= 0 ? (r[i] ?? "").replace(/\s+/g, " ").trim() : ""; };
  const known = new Set([...existingCodes].map((c) => c.toLowerCase()));
  const items: CsvItem[] = [], problems: CsvProblem[] = [];
  rows.forEach((r, n) => {
    const line = n + 2;
    if (items.length >= CSV_LIMITS.rows) { if (!problems.some((p) => p.problem === "tooMany")) problems.push({ line, problem: "tooMany" }); return; }
    const statement = col(r, "statement").slice(0, CSV_LIMITS.statement);
    const code = col(r, "code").slice(0, CSV_LIMITS.code);
    const parentCode = col(r, "parentCode").slice(0, CSV_LIMITS.code) || null;
    if (!statement) { problems.push({ line, problem: "noStatement" }); return; }
    if (code && known.has(code.toLowerCase())) { problems.push({ line, problem: "duplicateCode" }); return; }
    if (parentCode && !known.has(parentCode.toLowerCase())) { problems.push({ line, problem: "unknownParent" }); return; }
    if (code) known.add(code.toLowerCase());
    items.push({ line, code, statement, grades: gradeList(col(r, "grades")), type: col(r, "type").slice(0, CSV_LIMITS.type) || null, parentCode });
  });
  return { items, problems, columns: head.filter(Boolean) };
}
