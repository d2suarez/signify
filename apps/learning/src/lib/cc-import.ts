import crypto from "node:crypto";
import { getDb } from "./db";
import { readCartridge, summarize, type Plan, type PlanItem, type PlanSummary, type Skipped } from "./cartridge";
import { quizPoints } from "./quiz";
import { bringInMedia } from "./import-media";
import type { StudentView } from "./organize";

/**
 * Brings a Common Cartridge (a Schoology course export) into a course, in two
 * steps: preview (read the file, say what it will make, write nothing) and
 * import (read it again and write everything in ONE transaction, so a failure
 * leaves the course as it was). The browser sends the file both times, so
 * nothing uploaded is kept between the steps.
 *
 * Everything imported starts as a draft: assignments unpublished, lessons
 * unscheduled (a lesson is only the teacher's plan until presented). New
 * units go after the course's existing ones. Lessons and assignments start at
 * version 1 like any new one, so every later edit keeps history as usual.
 */

type Ctx = { tenantId: string; userId: string };

export const MAX_UPLOAD = 150 * 1024 * 1024;

/** What the preview shows: counts, the outline, and everything left behind. */
export type Preview = {
  courseTitle: string;
  summary: PlanSummary;
  outline: { title: string | null; items: { kind: PlanItem["kind"]; title: string; dueOn: string | null; discussion?: boolean; questions?: number }[] }[];
  skipped: Skipped[];
  missingFiles: string[];
  warnings: string[];
  /** Earlier imports of this same file into this course. */
  importedBefore: { at: string; fileName: string }[];
};

const OUTLINE_CAP = 400;

export function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function outlineOf(plan: Plan): Preview["outline"] {
  let left = OUTLINE_CAP;
  const items = (list: PlanItem[]) => {
    const out = list.slice(0, Math.max(0, left)).map((i) => ({
      kind: i.kind, title: i.title, dueOn: i.kind === "assignment" ? i.dueOn : null,
      ...(i.kind === "assignment" && i.fromDiscussion ? { discussion: true } : {}),
      ...(i.kind === "quiz" ? { questions: i.quiz.items.length } : {}),
    }));
    left -= out.length;
    return out;
  };
  const sections = plan.units.map((u) => ({ title: u.title as string | null, items: items(u.items) }));
  if (plan.loose.length) sections.push({ title: null, items: items(plan.loose) });
  return sections;
}

export async function previewImport(ctx: Ctx, courseId: string, buf: Buffer, schoolTz?: string, nestedUnits = false): Promise<Preview> {
  const plan = readCartridge(buf, { schoolTz, nestedUnits });
  const db = await getDb();
  const before = await db.query(
    `SELECT created_at, file_name FROM course_imports
      WHERE tenant_id = $1 AND course_id = $2 AND file_sha256 = $3 ORDER BY created_at DESC LIMIT 5`,
    [ctx.tenantId, courseId, sha256(buf)],
  );
  return {
    courseTitle: plan.courseTitle,
    summary: summarize(plan),
    outline: outlineOf(plan),
    skipped: plan.skipped.slice(0, 200),
    missingFiles: plan.missingFiles,
    warnings: plan.warnings,
    importedBefore: before.map((r) => ({
      at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      fileName: String(r.file_name),
    })),
  };
}

export type ImportResult = {
  importId: string; summary: PlanSummary; unitIds: string[];
  /** The lessons made, in order (to show them to students when asked). */
  lessonIds: string[];
  /** Pictures and files stored; ones in the export that couldn't be; whether file storage is off. */
  media: { saved: number; failed: string[]; off: boolean };
};

export async function commitImport(
  ctx: Ctx, courseId: string, buf: Buffer, fileName: string,
  opts: { keepDates: boolean; schoolTz?: string; nestedUnits?: boolean; studentView?: StudentView; fetcher?: (url: string) => Promise<Buffer | null> },
): Promise<ImportResult> {
  const plan = readCartridge(buf, { schoolTz: opts.schoolTz, nestedUnits: opts.nestedUnits });
  const summary = summarize(plan);
  // Pictures and files first, outside the transaction (they go to file storage, not the database).
  const media = await bringInMedia(ctx, courseId, buf, plan, opts.fetcher);
  // 'thread' is posted by the caller once the lessons exist; here they start in the list.
  const view = opts.studentView === "list" || opts.studentView === "thread" ? "list" : "hidden";
  const db = await getDb();
  return db.tx(async (t) => {
    const [rec] = await t.query(
      `INSERT INTO course_imports (tenant_id, course_id, file_name, file_sha256, summary, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING id`,
      [ctx.tenantId, courseId, fileName.slice(0, 200), sha256(buf),
        JSON.stringify({ ...summary, skipped: plan.skipped.slice(0, 200), missingFiles: [...plan.missingFiles, ...media.failed].slice(0, 400), mediaSaved: media.saved }), ctx.userId],
    );
    const importId = String(rec.id);

    const [{ next }] = await t.query<{ next: number }>(
      "SELECT coalesce(max(position), -1) + 1 AS next FROM units WHERE tenant_id = $1 AND course_id = $2",
      [ctx.tenantId, courseId],
    );
    const unitIds: string[] = [];
    const lessonIds: string[] = [];
    // Items keep the export's order inside each unit (loose items after the course's own loose ones).
    const add = async (item: PlanItem, unitId: string | null, position: number) => {
      if (item.kind === "lesson") {
        const [l] = await t.query(
          `INSERT INTO lessons (tenant_id, course_id, title, blocks, unit_id, created_by, updated_by, position, student_view, import_id)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $6, $7, $8, $9) RETURNING id`,
          [ctx.tenantId, courseId, item.title, JSON.stringify(item.blocks), unitId, ctx.userId, position, view, importId],
        );
        lessonIds.push(String(l.id));
      } else if (item.kind === "quiz") {
        // A quiz is an assignment of kind quiz, a draft like everything imported.
        await t.query(
          `INSERT INTO assignments (tenant_id, course_id, unit_id, title, instructions, kind, points, quiz, published, created_by, updated_by, position, import_id)
           VALUES ($1, $2, $3, $4, $5, 'quiz', $6, $7::jsonb, false, $8, $8, $9, $10)`,
          [ctx.tenantId, courseId, unitId, item.title, item.instructions, Math.min(10_000, quizPoints(item.quiz)), JSON.stringify(item.quiz), ctx.userId, position, importId],
        );
      } else {
        const dated = opts.keepDates && item.dueOn && item.dueAt;
        await t.query(
          `INSERT INTO assignments (tenant_id, course_id, unit_id, title, instructions, kind, points, due_on, due_at, published, created_by, updated_by, position, import_id)
           VALUES ($1, $2, $3, $4, $5, 'online', $6, $7, $8, false, $9, $9, $10, $11)`,
          [ctx.tenantId, courseId, unitId, item.title, item.instructions, item.points ?? 10,
            dated ? item.dueOn : null, dated ? item.dueAt : null, ctx.userId, position, importId],
        );
      }
    };

    // Top-level folders go after the course's own units; inner folders (nestedUnits) inside their folder, in order.
    let top = Number(next);
    const inner = new Map<number, number>();
    for (const unit of plan.units) {
      const parent = unit.parent !== undefined ? unitIds[unit.parent] ?? null : null;
      let position = top;
      if (parent) { position = (inner.get(unit.parent!) ?? -1) + 1; inner.set(unit.parent!, position); } else top++;
      const [u] = await t.query(
        "INSERT INTO units (tenant_id, course_id, title, position, import_id, parent_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
        [ctx.tenantId, courseId, parent ? (unit.name ?? unit.title) : unit.title, position, importId, parent],
      );
      unitIds.push(String(u.id));
      for (const [j, item] of unit.items.entries()) await add(item, String(u.id), j);
    }
    const [{ loose }] = await t.query<{ loose: number }>(
      `SELECT coalesce(max(p), -1) + 1 AS loose FROM (
         SELECT max(position) AS p FROM lessons WHERE tenant_id = $1 AND course_id = $2 AND unit_id IS NULL
         UNION ALL SELECT max(position) FROM assignments WHERE tenant_id = $1 AND course_id = $2 AND unit_id IS NULL) x`,
      [ctx.tenantId, courseId],
    );
    for (const [j, item] of plan.loose.entries()) await add(item, null, Number(loose) + j);

    for (const k of plan.kept) {
      await t.query(
        `INSERT INTO import_sources (tenant_id, import_id, course_id, kind, title, unit_title, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [ctx.tenantId, importId, courseId, k.kind, k.title, k.unit, k.source],
      );
    }
    return { importId, summary, unitIds, lessonIds, media };
  });
}
