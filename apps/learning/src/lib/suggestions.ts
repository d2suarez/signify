import { getDb } from "./db";
import { isParts, quarter, RUBRIC_LIMITS, type PartMarks, type PartNotes, type Rubric } from "./rubric";

/**
 * Suggestions on the grading review screen (migration 038, story 01
 * "Planning for AI now"): a suggested score, message to the student and
 * teacher note for one part of a sections-and-parts rubric, stored APART
 * from grades with what made it (source, version, detail). Suggestions
 * are never grades: the desk only copies one into the form when the
 * teacher clicks "Use it", and only the teacher's save (the normal grade
 * path: history, late policy, passback) makes it a grade. That save then
 * settles it as accepted (saved as suggested) or changed.
 *
 * Today the only helper is a non-AI one, "same as another student's"
 * (source "copy"). An AI assistant fills the same table later (its own
 * source and version), and nothing here or on the desk changes.
 * Teacher routes and pages only.
 */

export type Suggestion = {
  id: string; studentId: string; partId: string | null;
  score: number | null; message: string; note: string;
  source: string; sourceVersion: string; detail: Record<string, unknown> | null; createdAt: string;
};
export type SuggestionInput = { partId: string | null; score?: unknown; message?: unknown; note?: unknown };

type Ctx = { tenantId: string; userId: string };
type A = { id: string; rubric: Rubric | null; points: number };
const UUID = /^[0-9a-f-]{36}$/i;
const SOURCE = /^[a-z][a-z0-9-]{0,39}$/;

const json = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);
const toSuggestion = (r: Record<string, unknown>): Suggestion => ({
  id: String(r.id), studentId: String(r.student_id), partId: r.part_id ? String(r.part_id) : null,
  score: r.score === null || r.score === undefined ? null : Number(r.score), message: String(r.message ?? ""), note: String(r.note ?? ""),
  source: String(r.source), sourceVersion: String(r.source_version), detail: r.source_detail ? json(r.source_detail) as Record<string, unknown> : null,
  createdAt: new Date(r.created_at as string).toISOString(),
});
const text = (v: unknown) => (typeof v === "string" ? v.replace(/\r\n/g, "\n").trim().slice(0, RUBRIC_LIMITS.message) : "");

/** Every open suggestion on an assignment (or one student's). */
export async function openSuggestions(ctx: Ctx, assignmentId: string, studentId?: string): Promise<Suggestion[]> {
  if (!UUID.test(assignmentId)) return [];
  const db = await getDb();
  const rows = await db.query(
    `SELECT * FROM grade_suggestions WHERE tenant_id = $1 AND assignment_id = $2 AND status = 'open' ${studentId ? "AND student_id = $3" : ""}
      ORDER BY created_at`, studentId ? [ctx.tenantId, assignmentId, studentId] : [ctx.tenantId, assignmentId]);
  return rows.map(toSuggestion);
}

/**
 * Store suggestions for one student (replacing an open one on the same
 * part). Only this rubric's parts (or null = the whole grade); scores on
 * quarter points within the part (or the assignment's points). A row with
 * nothing in it is dropped. The caller checks the teacher and the roster.
 */
export async function addSuggestions(
  ctx: Ctx, a: A, studentId: string, rows: SuggestionInput[],
  source: { source: string; version?: string; detail?: Record<string, unknown> | null },
): Promise<Suggestion[]> {
  if (!SOURCE.test(source.source)) throw new Error("bad source");
  const parts = new Map(isParts(a.rubric) ? a.rubric.sections.flatMap((s) => s.parts.map((p) => [p.id, p.points] as const)) : []);
  const db = await getDb();
  const out: Suggestion[] = [];
  for (const r of rows.slice(0, 200)) {
    if (r.partId !== null && !parts.has(r.partId)) continue;
    const max = r.partId === null ? a.points : parts.get(r.partId)!;
    const score = r.score === null || r.score === undefined || r.score === "" ? null : quarter(r.score, max);
    const message = text(r.message), note = text(r.note);
    if (score === null && !message && !note) continue;
    await db.query(
      `DELETE FROM grade_suggestions WHERE tenant_id = $1 AND assignment_id = $2 AND student_id = $3 AND coalesce(part_id, '') = $4 AND status = 'open'`,
      [ctx.tenantId, a.id, studentId, r.partId ?? ""]);
    const [row] = await db.query(
      `INSERT INTO grade_suggestions (tenant_id, assignment_id, student_id, part_id, score, message, note, source, source_version, source_detail, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [ctx.tenantId, a.id, studentId, r.partId, score, message, note, source.source, (source.version ?? "1").slice(0, 40),
        source.detail ? JSON.stringify(source.detail) : null, ctx.userId]);
    out.push(toSuggestion(row));
  }
  return out;
}

/**
 * The non-AI helper: suggest, for `studentId`, what the teacher gave
 * `fromId` on each part (score, message and note). Useful for a group
 * section, a resubmission or a near-identical answer. Nothing changes in
 * either grade.
 */
export async function suggestFromStudent(ctx: Ctx, a: A, studentId: string, fromId: string): Promise<Suggestion[]> {
  if (!isParts(a.rubric) || studentId === fromId) return [];
  const db = await getDb();
  const [g] = await db.query("SELECT parts, part_notes FROM grades WHERE tenant_id = $1 AND assignment_id = $2 AND student_id = $3", [ctx.tenantId, a.id, fromId]);
  if (!g) return [];
  const marks = (g.parts ? json(g.parts) : {}) as PartMarks;
  const notes = (g.part_notes ? json(g.part_notes) : {}) as PartNotes;
  const rows: SuggestionInput[] = a.rubric.sections.flatMap((s) => s.parts.map((p) => ({
    partId: p.id, score: marks[p.id]?.score ?? null, message: marks[p.id]?.message ?? "", note: notes[p.id] ?? "",
  })));
  return addSuggestions(ctx, a, studentId, rows, { source: "copy", detail: { from: fromId } });
}

/** "Skip": the suggestion is set aside; the grade is untouched. */
export async function skipSuggestion(ctx: Ctx, assignmentId: string, id: string): Promise<boolean> {
  if (!UUID.test(id) || !UUID.test(assignmentId)) return false;
  const db = await getDb();
  const rows = await db.query(
    `UPDATE grade_suggestions SET status = 'skipped', decided_by = $4, decided_at = now()
      WHERE tenant_id = $1 AND assignment_id = $2 AND id = $3 AND status = 'open' RETURNING id`,
    [ctx.tenantId, assignmentId, id, ctx.userId]);
  return rows.length > 0;
}

/**
 * After the teacher's grade save: the suggestions they used on this
 * student are settled against what was actually saved, "accepted" when
 * saved as suggested, "changed" when the teacher changed it first.
 */
export async function settleSuggestions(
  ctx: Ctx, assignmentId: string, studentId: string, ids: unknown,
  saved: { score: number | null; comment: string; parts: PartMarks | null; notes: PartNotes | null },
): Promise<number> {
  const want = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string" && UUID.test(x)).slice(0, 200) : [];
  if (!want.length) return 0;
  const open = (await openSuggestions(ctx, assignmentId, studentId)).filter((s) => want.includes(s.id));
  const db = await getDb();
  for (const s of open) {
    const same = s.partId === null
      ? (s.score === null || s.score === saved.score) && (!s.message || s.message === saved.comment.trim())
      : (s.score === null || s.score === (saved.parts?.[s.partId]?.score ?? null))
        && (!s.message || s.message === (saved.parts?.[s.partId]?.message ?? ""))
        && (!s.note || s.note === (saved.notes?.[s.partId] ?? ""));
    await db.query(
      `UPDATE grade_suggestions SET status = $5, decided_by = $4, decided_at = now()
        WHERE tenant_id = $1 AND assignment_id = $2 AND id = $3 AND status = 'open'`,
      [ctx.tenantId, assignmentId, s.id, ctx.userId, same ? "accepted" : "changed"]);
  }
  return open.length;
}
