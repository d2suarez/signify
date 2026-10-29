import crypto from "node:crypto";
import { getDb } from "./db";
import { readCartridge, summarize, type Plan, type PlanItem, type PlanSummary, type Skipped } from "./cartridge";

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
  outline: { title: string | null; items: { kind: PlanItem["kind"]; title: string; dueOn: string | null }[] }[];
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
    const out = list.slice(0, Math.max(0, left)).map((i) => ({ kind: i.kind, title: i.title, dueOn: i.kind === "assignment" ? i.dueOn : null }));
    left -= out.length;
    return out;
  };
  const sections = plan.units.map((u) => ({ title: u.title as string | null, items: items(u.items) }));
  if (plan.loose.length) sections.push({ title: null, items: items(plan.loose) });
  return sections;
}

export async function previewImport(ctx: Ctx, courseId: string, buf: Buffer, schoolTz?: string): Promise<Preview> {
  const plan = readCartridge(buf, { schoolTz });
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

export type ImportResult = { importId: string; summary: PlanSummary; unitIds: string[] };

export async function commitImport(
  ctx: Ctx, courseId: string, buf: Buffer, fileName: string, opts: { keepDates: boolean; schoolTz?: string },
): Promise<ImportResult> {
  const plan = readCartridge(buf, { schoolTz: opts.schoolTz });
  const summary = summarize(plan);
  const db = await getDb();
  return db.tx(async (t) => {
    const [rec] = await t.query(
      `INSERT INTO course_imports (tenant_id, course_id, file_name, file_sha256, summary, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING id`,
      [ctx.tenantId, courseId, fileName.slice(0, 200), sha256(buf),
        JSON.stringify({ ...summary, skipped: plan.skipped.slice(0, 200), missingFiles: plan.missingFiles }), ctx.userId],
    );
    const importId = String(rec.id);

    const [{ next }] = await t.query<{ next: number }>(
      "SELECT coalesce(max(position), -1) + 1 AS next FROM units WHERE tenant_id = $1 AND course_id = $2",
      [ctx.tenantId, courseId],
    );
    const unitIds: string[] = [];
    const add = async (item: PlanItem, unitId: string | null) => {
      if (item.kind === "lesson") {
        await t.query(
          `INSERT INTO lessons (tenant_id, course_id, title, blocks, unit_id, created_by, updated_by)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $6)`,
          [ctx.tenantId, courseId, item.title, JSON.stringify(item.blocks), unitId, ctx.userId],
        );
      } else {
        const dated = opts.keepDates && item.dueOn && item.dueAt;
        await t.query(
          `INSERT INTO assignments (tenant_id, course_id, unit_id, title, instructions, kind, points, due_on, due_at, published, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, 'online', $6, $7, $8, false, $9, $9)`,
          [ctx.tenantId, courseId, unitId, item.title, item.instructions, item.points ?? 10,
            dated ? item.dueOn : null, dated ? item.dueAt : null, ctx.userId],
        );
      }
    };

    for (const [i, unit] of plan.units.entries()) {
      const [u] = await t.query(
        "INSERT INTO units (tenant_id, course_id, title, position) VALUES ($1, $2, $3, $4) RETURNING id",
        [ctx.tenantId, courseId, unit.title, Number(next) + i],
      );
      unitIds.push(String(u.id));
      for (const item of unit.items) await add(item, String(u.id));
    }
    for (const item of plan.loose) await add(item, null);

    for (const k of plan.kept) {
      await t.query(
        `INSERT INTO import_sources (tenant_id, import_id, course_id, kind, title, unit_title, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [ctx.tenantId, importId, courseId, k.kind, k.title, k.unit, k.source],
      );
    }
    return { importId, summary, unitIds };
  });
}
