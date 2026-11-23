import type { Queryable } from "./db";
import type { FileKind } from "./files";

/**
 * The low-level half of student file hand-in (migration 040, story 01 A7):
 * a work file list and the snapshot taken at hand-in. Only the database
 * here, so assignments.ts and group-work.ts can call it inside their own
 * hand-in transactions. The rest (upload, who may open) is work-files.ts.
 */

export type WorkFile = { id: string; name: string; kind: FileKind; size: number; contentType: string };

/** Whose files: a student's own, or (a group's "one hands in" mode) the group's. */
export const studentOwner = (studentId: string) => `s:${studentId}`;
export const groupOwner = (groupId: string) => `g:${groupId}`;

export function toWorkFile(r: Record<string, unknown>): WorkFile {
  return { id: String(r.id), name: String(r.name), kind: r.kind as FileKind, size: Number(r.size), contentType: String(r.content_type) };
}

/** The owner's files now, in their order (removed ones left out). */
export async function currentFiles(q: Queryable, tenantId: string, assignmentId: string, owner: string): Promise<WorkFile[]> {
  const rows = await q.query(
    `SELECT * FROM work_files WHERE tenant_id = $1 AND assignment_id = $2 AND owner = $3 AND removed_at IS NULL
      ORDER BY position, created_at`,
    [tenantId, assignmentId, owner]);
  return rows.map(toWorkFile);
}

/** A handed-in list as stored on a submission (only well-formed entries). */
export function handedFiles(v: unknown): WorkFile[] | null {
  const list = typeof v === "string" ? (() => { try { return JSON.parse(v); } catch { return null; } })() : v;
  if (!Array.isArray(list)) return null;
  return list.filter((f) => f && typeof f.id === "string" && typeof f.name === "string")
    .map((f) => ({ id: f.id, name: f.name, kind: f.kind, size: Number(f.size) || 0, contentType: String(f.contentType ?? "") }));
}

/**
 * At hand-in: the owner's files now become what each of these submissions
 * handed in (null when there are none), and the list is kept in the
 * hand-in record, so a take-back and a new hand-in never lose the old one.
 */
export async function snapshotHandIn(t: Queryable, tenantId: string, assignmentId: string, owner: string, submissionIds: string[]): Promise<WorkFile[]> {
  const files = await currentFiles(t, tenantId, assignmentId, owner);
  for (const id of submissionIds) {
    await t.query("UPDATE submissions SET files = $3::jsonb WHERE tenant_id = $1 AND id = $2",
      [tenantId, id, files.length ? JSON.stringify(files) : null]);
    if (files.length) {
      await t.query("INSERT INTO work_file_hand_ins (tenant_id, submission_id, files) VALUES ($1, $2, $3::jsonb)",
        [tenantId, id, JSON.stringify(files)]);
    }
  }
  return files;
}
