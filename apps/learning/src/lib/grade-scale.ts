/**
 * A school's letter scales, one per grade band (say "Grades 9–12" and
 * "Grades 3–8"), each with GPA points. Pure, so the gradebook grid can use it
 * in the browser. The letter follows the percent rounded to a whole number
 * (wholePercent), as it always has.
 *
 * A course uses its school's scale for its band: the band the teacher
 * picked, else the band that holds the class's grade levels in Signify ID,
 * else the school's first band.
 */

export type ScaleRow = { letter: string; min: number; gpa: number | null };
export type GradeBand = { id: string; name: string; grades: string[]; rows: ScaleRow[] };
export type SchoolScales = { bands: GradeBand[] };

/** Signify ID's year groups, in order. */
export const YEAR_GROUPS = ["Pre-K", "K", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];
export const SCALE_LIMITS = { bands: 10, rows: 20, name: 60, letter: 6 };

const rows = (list: [string, number, number][]): ScaleRow[] => list.map(([letter, min, gpa]) => ({ letter, min, gpa }));

/** Richmond Academy's scales (Desmond, 2026-10-30): every school starts with these. */
export const DEFAULT_SCALES: SchoolScales = {
  bands: [
    {
      id: "9-12", name: "Grades 9–12", grades: ["9", "10", "11", "12"],
      rows: rows([
        ["A", 94, 4], ["A−", 90, 3.67], ["B+", 87, 3.33], ["B", 84, 3], ["B−", 80, 2.67], ["C+", 77, 2.33],
        ["C", 74, 2], ["C−", 70, 1.67], ["D+", 67, 1.33], ["D", 64, 1], ["D−", 60, 0.67], ["F", 0, 0],
      ]),
    },
    {
      id: "3-8", name: "Grades 3–8", grades: ["3", "4", "5", "6", "7", "8"],
      rows: rows([
        ["A", 94, 4], ["A−", 90, 3.667], ["B+", 88, 3.333], ["B", 84, 3], ["B−", 80, 2.667], ["C+", 78, 2.333],
        ["C", 74, 2], ["C−", 70, 1.667], ["D+", 68, 1.333], ["D", 64, 1], ["D−", 60, 0.667], ["F", 0, 0],
      ]),
    },
  ],
};

/** The scale Learning used before schools had their own (A 93 …), for comparison and tests. */
export const LEGACY_SCALE: ScaleRow[] = rows([
  ["A", 93, 4], ["A−", 90, 3.7], ["B+", 87, 3.3], ["B", 83, 3], ["B−", 80, 2.7], ["C+", 77, 2.3],
  ["C", 73, 2], ["C−", 70, 1.7], ["D+", 67, 1.3], ["D", 63, 1], ["D−", 60, 0.7], ["F", 0, 0],
]);

/** GPA points as a school writes them: at least two decimals ("4.00", "3.67", "3.667"). */
export function gpaText(gpa: number | null | undefined): string {
  if (gpa === null || gpa === undefined) return "";
  return Number(gpa.toFixed(2)) === gpa ? gpa.toFixed(2) : String(Number(gpa.toFixed(3)));
}

function line(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

export type ScaleProblem =
  | "noBands" | "tooManyBands" | "bandName" | "rowCount" | "letter" | "sameLetter" | "min" | "sameMin" | "noZero" | "gpa" | "gradeTwice";

/**
 * The only way a school's scales come in. Refuses (with the band and the
 * problem) rather than guessing: a wrong cut-off is a wrong report card.
 * Rows come back top first. A trailing "-" on a letter is written "−", like
 * the rest of the app (the FACTS file writes it back as "-").
 */
export function normalizeScales(input: unknown): { ok: true; scales: SchoolScales } | { ok: false; problem: ScaleProblem; band?: number } {
  const list = (input as { bands?: unknown })?.bands;
  if (!Array.isArray(list) || list.length === 0) return { ok: false, problem: "noBands" };
  if (list.length > SCALE_LIMITS.bands) return { ok: false, problem: "tooManyBands" };
  const seenGrade = new Set<string>(), seenId = new Set<string>();
  const bands: GradeBand[] = [];
  for (const [i, raw] of list.entries()) {
    const b = raw as Record<string, unknown>;
    const name = line(b?.name, SCALE_LIMITS.name);
    if (!name) return { ok: false, problem: "bandName", band: i };
    let id = line(b?.id, 40).replace(/[^\w-]/g, "");
    if (!id || seenId.has(id)) id = `b${i}-${Math.random().toString(36).slice(2, 8)}`;
    seenId.add(id);
    const grades = YEAR_GROUPS.filter((g) => Array.isArray(b?.grades) && (b.grades as unknown[]).includes(g));
    for (const g of grades) {
      if (seenGrade.has(g)) return { ok: false, problem: "gradeTwice", band: i };
      seenGrade.add(g);
    }
    const rawRows = Array.isArray(b?.rows) ? b.rows as Record<string, unknown>[] : [];
    if (rawRows.length < 2 || rawRows.length > SCALE_LIMITS.rows) return { ok: false, problem: "rowCount", band: i };
    const out: ScaleRow[] = [];
    for (const r of rawRows) {
      const letter = line(r?.letter, SCALE_LIMITS.letter).replace(/-$/, "−");
      if (!letter) return { ok: false, problem: "letter", band: i };
      const min = Number(r?.min);
      if (!Number.isInteger(min) || min < 0 || min > 100) return { ok: false, problem: "min", band: i };
      let gpa: number | null = null;
      if (r?.gpa !== null && r?.gpa !== undefined && String(r.gpa).trim() !== "") {
        gpa = Number(String(r.gpa).replace(",", "."));
        if (!Number.isFinite(gpa) || gpa < 0 || gpa > 5) return { ok: false, problem: "gpa", band: i };
        gpa = Math.round(gpa * 1000) / 1000;
      }
      out.push({ letter, min, gpa });
    }
    out.sort((a, b) => b.min - a.min);
    if (new Set(out.map((r) => r.min)).size !== out.length) return { ok: false, problem: "sameMin", band: i };
    if (new Set(out.map((r) => r.letter)).size !== out.length) return { ok: false, problem: "sameLetter", band: i };
    if (out[out.length - 1].min !== 0) return { ok: false, problem: "noZero", band: i };
    bands.push({ id, name, grades, rows: out });
  }
  return { ok: true, scales: { bands } };
}

/** What a saved value reads as; anything broken falls back to the defaults. */
export function readScales(value: unknown): SchoolScales {
  if (!value) return DEFAULT_SCALES;
  const r = normalizeScales(typeof value === "string" ? JSON.parse(value) : value);
  return r.ok ? r.scales : DEFAULT_SCALES;
}

/**
 * The band a course uses: the teacher's pick if it still exists, else the
 * band holding the most of the class's grade levels (the higher band on a
 * tie), else the school's first band. `from` says which.
 */
export function bandFor(
  scales: SchoolScales, course: { gradeBand: string | null; gradeLevels: string[] },
): { band: GradeBand; from: "teacher" | "grades" | "first" } {
  const picked = course.gradeBand ? scales.bands.find((b) => b.id === course.gradeBand) : undefined;
  if (picked) return { band: picked, from: "teacher" };
  let best: GradeBand | null = null, bestN = 0, bestTop = -1;
  for (const b of scales.bands) {
    const hit = course.gradeLevels.filter((g) => b.grades.includes(g));
    const top = Math.max(-1, ...hit.map((g) => YEAR_GROUPS.indexOf(g)));
    if (hit.length > bestN || (hit.length === bestN && hit.length > 0 && top > bestTop)) { best = b; bestN = hit.length; bestTop = top; }
  }
  if (best) return { band: best, from: "grades" };
  return { band: scales.bands[0], from: "first" };
}
