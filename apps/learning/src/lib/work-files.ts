import crypto from "node:crypto";
import { getDb } from "./db";
import { isClosed, type Assignment, type Submission } from "./assignments";
import type { CourseRole } from "./courses";
import { cleanName, fileStore, FileError, MAX_FILE, sealFile, sniffFile, uploadsOn } from "./files";
import { assignmentGroups, groupFor } from "./group-work";
import type { Group } from "./groups";
import { currentFiles, groupOwner, handedFiles, studentOwner, toWorkFile, type WorkFile } from "./hand-in-files";

/**
 * Student file hand-in (migration 040, story 01 A7): photos of paper work,
 * PDFs and Word/PowerPoint/Excel files handed in on an online assignment
 * whose `handIn` is "files" or "both".
 *
 * - Same checks and storage as teacher files (files.ts): 25 MB, what a file
 *   is from its bytes, sealed with AES-256-GCM, never plaintext. Pictures,
 *   PDFs and Office files only (no sound, video or text files here).
 * - The files are the student's own, or the group's in a group assignment's
 *   "one hands in for the group" mode ("each": every member's own).
 * - Changing them follows the writing box: refused once handed in, until
 *   taken back. Hand-in copies the list into the submission (hand-in-files).
 * - Who may open one (`canOpenWork`, live roles every time): its student
 *   (or a member of its group, now), the class's teachers, the school's
 *   admins. Never other students, never parents, never another school.
 *   These are NOT course_files: /files/[id] can never open them.
 */

export const MAX_WORK_FILES = 30;
/** For the picker: pictures, PDFs, Office files. */
export const WORK_ACCEPT = ".pdf,.png,.jpg,.jpeg,.gif,.webp,.docx,.pptx,.xlsx,image/*,application/pdf";

type Ctx = { tenantId: string; userId: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const takesFiles = (a: Pick<Assignment, "kind" | "handIn">) => a.kind === "online" && a.handIn !== "text";
export const takesText = (a: Pick<Assignment, "kind" | "handIn">) => a.kind === "online" && a.handIn !== "files";

/** Whose files a student works on, and whether they are handed in (so can't change). */
export async function ownerFor(ctx: Ctx, a: Assignment, studentId: string, group?: Group | null): Promise<{ owner: string; locked: boolean }> {
  const g = group === undefined ? await groupFor(ctx, a, studentId) : group;
  const db = await getDb();
  if (g && a.groupHandIn === "one") {
    const w = await db.query("SELECT submitted_at FROM group_work WHERE tenant_id = $1 AND assignment_id = $2 AND group_id = $3", [ctx.tenantId, a.id, g.id]);
    return { owner: groupOwner(g.id), locked: !!w[0]?.submitted_at };
  }
  const s = await db.query("SELECT submitted_at FROM submissions WHERE tenant_id = $1 AND assignment_id = $2 AND student_id = $3", [ctx.tenantId, a.id, studentId]);
  return { owner: studentOwner(studentId), locked: !!s[0]?.submitted_at };
}

export type MyFiles = { files: WorkFile[]; locked: boolean; on: boolean };

/** The signed-in student's files on this assignment. */
export async function myFiles(ctx: Ctx, a: Assignment): Promise<MyFiles> {
  const { owner, locked } = await ownerFor(ctx, a, ctx.userId);
  const db = await getDb();
  return { files: await currentFiles(db, ctx.tenantId, a.id, owner), locked, on: uploadsOn() };
}

export class WorkFileError extends Error {
  constructor(public code: "off" | "empty" | "too-large" | "type" | "handed-in" | "missing" | "too-many" | "closed") { super(code); }
}

function usable(a: Assignment) {
  if (!takesFiles(a) || !a.published) throw new WorkFileError("missing");
  // Stopped accepting work (migration 044): no adding, removing or reordering.
  if (isClosed(a)) throw new WorkFileError("closed");
}

/** A student adds a file (ctx.userId is the student; the course role was checked by the route). */
export async function addWorkFile(ctx: Ctx, a: Assignment, rawName: unknown, bytes: Buffer): Promise<WorkFile> {
  usable(a);
  const store = fileStore();
  if (!store || !uploadsOn()) throw new WorkFileError("off");
  if (!bytes.length) throw new WorkFileError("empty");
  if (bytes.length > MAX_FILE) throw new WorkFileError("too-large");
  const name = cleanName(rawName);
  const what = sniffFile(name, bytes);
  if (!what || (what.kind !== "image" && what.kind !== "pdf" && !(what.kind === "doc" && !what.contentType.startsWith("text/")))) throw new WorkFileError("type");
  const { owner, locked } = await ownerFor(ctx, a, ctx.userId);
  if (locked) throw new WorkFileError("handed-in");
  const db = await getDb();
  const have = await currentFiles(db, ctx.tenantId, a.id, owner);
  if (have.length >= MAX_WORK_FILES) throw new WorkFileError("too-many");
  const id = crypto.randomUUID();
  const k = `work/${ctx.tenantId.replace(/[^A-Za-z0-9_-]/g, "_")}/${id}`;
  try { await store.put(k, sealFile(bytes, k)); } catch (e) { if (e instanceof FileError) throw new WorkFileError("off"); throw e; }
  const rows = await db.query(
    `INSERT INTO work_files (id, tenant_id, assignment_id, owner, position, name, content_type, kind, size, sha256, storage_key, uploaded_by)
     VALUES ($1, $2, $3, $4, (SELECT coalesce(max(position), -1) + 1 FROM work_files WHERE tenant_id = $2 AND assignment_id = $3 AND owner = $4),
             $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [id, ctx.tenantId, a.id, owner, name, what.contentType, what.kind, bytes.length,
      crypto.createHash("sha256").update(bytes).digest("hex"), k, ctx.userId]);
  return toWorkFile(rows[0]);
}

/** Takes a file out of the student's (group's) list. The bytes stay: an earlier hand-in may hold it. */
export async function removeWorkFile(ctx: Ctx, a: Assignment, fileId: string): Promise<WorkFile[]> {
  usable(a);
  const { owner, locked } = await ownerFor(ctx, a, ctx.userId);
  if (locked) throw new WorkFileError("handed-in");
  if (!UUID.test(fileId)) throw new WorkFileError("missing");
  const db = await getDb();
  const r = await db.query(
    "UPDATE work_files SET removed_at = now() WHERE tenant_id = $1 AND assignment_id = $2 AND owner = $3 AND id = $4 AND removed_at IS NULL RETURNING id",
    [ctx.tenantId, a.id, owner, fileId]);
  if (!r[0]) throw new WorkFileError("missing");
  return currentFiles(db, ctx.tenantId, a.id, owner);
}

/** Puts the list in this order (ids not in the list are ignored; any left out keep their place after). */
export async function reorderWorkFiles(ctx: Ctx, a: Assignment, ids: unknown): Promise<WorkFile[]> {
  usable(a);
  const { owner, locked } = await ownerFor(ctx, a, ctx.userId);
  if (locked) throw new WorkFileError("handed-in");
  const db = await getDb();
  return db.tx(async (t) => {
    const have = await currentFiles(t, ctx.tenantId, a.id, owner);
    const want = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
    const order = [...want.filter((id, i) => have.some((f) => f.id === id) && want.indexOf(id) === i), ...have.map((f) => f.id).filter((id) => !want.includes(id))];
    for (let i = 0; i < order.length; i++) {
      await t.query("UPDATE work_files SET position = $5 WHERE tenant_id = $1 AND assignment_id = $2 AND owner = $3 AND id = $4", [ctx.tenantId, a.id, owner, order[i], i]);
    }
    return currentFiles(t, ctx.tenantId, a.id, owner);
  });
}

export type StoredWorkFile = WorkFile & { assignmentId: string; courseId: string; owner: string; storageKey: string };

/** A work file of this school (callers check `canOpenWork`). */
export async function getWorkFile(tenantId: string, id: string): Promise<StoredWorkFile | null> {
  if (!UUID.test(id)) return null;
  const db = await getDb();
  const rows = await db.query(
    `SELECT w.*, a.course_id FROM work_files w JOIN assignments a ON a.id = w.assignment_id AND a.tenant_id = w.tenant_id
      WHERE w.tenant_id = $1 AND w.id = $2`, [tenantId, id]);
  const r = rows[0];
  return r ? { ...toWorkFile(r), assignmentId: String(r.assignment_id), courseId: String(r.course_id), owner: String(r.owner), storageKey: String(r.storage_key) } : null;
}

/**
 * May this person open a student's file? `roleIn` is their live role in the
 * assignment's class; `admin` = an admin of this school (the file was
 * already looked up in their school only). Its student; a member of its
 * group, as the set is now; the class's teachers; the school's admins.
 */
export async function canOpenWork(
  ctx: Ctx, file: Pick<StoredWorkFile, "owner" | "courseId" | "assignmentId">,
  who: { admin: boolean; roleIn: (courseId: string) => Promise<CourseRole | null>; assignment: (id: string) => Promise<Assignment | null> },
): Promise<boolean> {
  if (who.admin) return true;
  const role = await who.roleIn(file.courseId);
  if (role === "teacher") return true;
  if (role !== "student") return false;
  if (file.owner === studentOwner(ctx.userId)) return true;
  if (!file.owner.startsWith("g:")) return false;
  const a = await who.assignment(file.assignmentId);
  if (!a || !a.published) return false;
  const g = await groupFor(ctx, a, ctx.userId);
  return !!g && groupOwner(g.id) === file.owner;
}

/**
 * For the grading desk and the zip: each student's files, what they handed
 * in when they have, else what is in their (group's) list now.
 */
export async function filesForStudents(ctx: Ctx, a: Assignment, studentIds: string[], subs: Map<string, Submission>): Promise<Map<string, WorkFile[]>> {
  const out = new Map<string, WorkFile[]>();
  if (a.kind !== "online") return out;
  const groups = await assignmentGroups(ctx, a);
  const db = await getDb();
  const rows = await db.query(
    "SELECT * FROM work_files WHERE tenant_id = $1 AND assignment_id = $2 AND removed_at IS NULL ORDER BY position, created_at", [ctx.tenantId, a.id]);
  const byOwner = new Map<string, WorkFile[]>();
  for (const r of rows) {
    const k = String(r.owner);
    byOwner.set(k, [...(byOwner.get(k) ?? []), toWorkFile(r)]);
  }
  for (const id of studentIds) {
    const sub = subs.get(id);
    if (sub?.submittedAt && sub.files) { out.set(id, sub.files); continue; }
    const g = groups?.find((x) => x.members.some((m) => m.id === id));
    const owner = g && a.groupHandIn === "one" ? groupOwner(g.id) : studentOwner(id);
    const list = byOwner.get(owner);
    if (list?.length) out.set(id, list);
  }
  return out;
}

export { handedFiles };
