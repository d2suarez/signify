import { getDb, type Queryable } from "./db";
import { cleanPastes, record } from "./writing";
import { cleanTitle, unitInCourse } from "./units";

/**
 * Assignments and the work students hand in for them.
 *
 * Assignments save like lessons: every save names the version it started
 * from, a stale one is refused, and the previous state is kept first.
 * Students see an assignment only once it is published, and their grade on
 * it only once its grades are released.
 *
 * A submission is one per student per assignment, saved as they type (also
 * version-checked, so two Chromebooks can't overwrite each other) and handed
 * in by setting submitted_at. Handing in late is allowed and marked late.
 */

export type AssignmentKind = "online" | "offline";

export type Assignment = {
  id: string;
  courseId: string;
  unitId: string | null;
  categoryId: string | null;
  title: string;
  instructions: string;
  kind: AssignmentKind;
  points: number;
  dueOn: string | null;
  dueAt: string | null;
  published: boolean;
  gradesReleased: boolean;
  version: number;
  updatedAt: string;
};

/** What a student may see of an assignment. */
export type StudentAssignment = Omit<Assignment, "version" | "updatedAt" | "published">;

export const LIMITS = { instructions: 20_000, body: 100_000, maxPoints: 10_000 };
export const KEEP_VERSIONS = 50;
const UUID = /^[0-9a-f-]{36}$/i;

type Ctx = { tenantId: string; userId: string };

function iso(v: unknown): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}

function day(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function toAssignment(r: Record<string, unknown>): Assignment {
  return {
    id: String(r.id),
    courseId: String(r.course_id),
    unitId: r.unit_id ? String(r.unit_id) : null,
    categoryId: r.category_id ? String(r.category_id) : null,
    title: String(r.title),
    instructions: String(r.instructions ?? ""),
    kind: r.kind === "offline" ? "offline" : "online",
    points: Number(r.points),
    dueOn: day(r.due_on),
    dueAt: iso(r.due_at),
    published: !!r.published,
    gradesReleased: !!r.grades_released,
    version: Number(r.version),
    updatedAt: iso(r.updated_at) as string,
  };
}

export function forStudent(a: Assignment): StudentAssignment {
  const { version: _v, updatedAt: _u, published: _p, ...rest } = a;
  return rest;
}

export async function listAssignments(ctx: Ctx, courseId: string, opts: { publishedOnly?: boolean } = {}): Promise<Assignment[]> {
  const db = await getDb();
  const rows = await db.query(
    `SELECT * FROM assignments
      WHERE tenant_id = $1 AND course_id = $2 AND archived = false ${opts.publishedOnly ? "AND published" : ""}
      ORDER BY due_on NULLS LAST, due_at NULLS LAST, created_at`,
    [ctx.tenantId, courseId],
  );
  return rows.map(toAssignment);
}

export async function getAssignment(ctx: Ctx, id: string): Promise<Assignment | null> {
  if (!UUID.test(id)) return null;
  const db = await getDb();
  const rows = await db.query(
    "SELECT * FROM assignments WHERE tenant_id = $1 AND id = $2 AND archived = false",
    [ctx.tenantId, id],
  );
  return rows[0] ? toAssignment(rows[0]) : null;
}

async function categoryInCourse(ctx: Ctx, courseId: string, v: unknown, q: Queryable): Promise<string | null> {
  const id = typeof v === "string" ? v : "";
  if (!UUID.test(id)) return null;
  const rows = await q.query(
    "SELECT id FROM grade_categories WHERE tenant_id = $1 AND course_id = $2 AND id = $3",
    [ctx.tenantId, courseId, id],
  );
  return rows[0] ? id : null;
}

function cleanPoints(v: unknown, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(LIMITS.maxPoints, Math.max(0, Math.round(n * 100) / 100));
}

/** due_on and due_at must agree: both a real value, or both empty. */
function cleanDue(dueOn: unknown, dueAt: unknown): { dueOn: string | null; dueAt: string | null } {
  const d = typeof dueOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dueOn) ? dueOn : null;
  const at = typeof dueAt === "string" && dueAt ? new Date(dueAt) : null;
  if (!d || !at || Number.isNaN(at.getTime())) return { dueOn: null, dueAt: null };
  return { dueOn: d, dueAt: at.toISOString() };
}

export async function createAssignment(
  ctx: Ctx, courseId: string, input: { title: unknown; unitId?: unknown; kind?: unknown },
): Promise<Assignment> {
  const db = await getDb();
  const unit = await unitInCourse(ctx, courseId, input.unitId);
  const rows = await db.query(
    `INSERT INTO assignments (tenant_id, course_id, unit_id, title, kind, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING *`,
    [ctx.tenantId, courseId, unit, cleanTitle(input.title, "Untitled assignment"),
      input.kind === "offline" ? "offline" : "online", ctx.userId],
  );
  return toAssignment(rows[0]);
}

export type AssignmentInput = {
  baseVersion: number;
  title?: unknown;
  instructions?: unknown;
  kind?: unknown;
  points?: unknown;
  dueOn?: unknown;
  dueAt?: unknown;
  unitId?: unknown;
  categoryId?: unknown;
  published?: unknown;
  gradesReleased?: unknown;
};

export type AssignmentSave =
  | { ok: true; assignment: Assignment; changed: boolean }
  | { ok: false; reason: "conflict"; assignment: Assignment }
  | { ok: false; reason: "missing" };

const SNAPSHOT_KEYS = ["title", "instructions", "kind", "points", "dueOn", "dueAt", "unitId", "categoryId", "published", "gradesReleased"] as const;

export async function saveAssignment(ctx: Ctx, id: string, input: AssignmentInput): Promise<AssignmentSave> {
  if (!UUID.test(id)) return { ok: false, reason: "missing" };
  const db = await getDb();
  return db.tx(async (t) => {
    const rows = await t.query(
      "SELECT * FROM assignments WHERE tenant_id = $1 AND id = $2 AND archived = false FOR UPDATE",
      [ctx.tenantId, id],
    );
    if (!rows[0]) return { ok: false, reason: "missing" } as const;
    const cur = toAssignment(rows[0]);
    if (Number(input.baseVersion) !== cur.version) return { ok: false, reason: "conflict", assignment: cur } as const;

    const due = input.dueOn === undefined && input.dueAt === undefined
      ? { dueOn: cur.dueOn, dueAt: cur.dueAt }
      : cleanDue(input.dueOn, input.dueAt);
    const next: Assignment = {
      ...cur,
      title: input.title === undefined ? cur.title : cleanTitle(input.title, "Untitled assignment"),
      instructions: input.instructions === undefined ? cur.instructions : String(input.instructions).slice(0, LIMITS.instructions),
      kind: input.kind === undefined ? cur.kind : input.kind === "offline" ? "offline" : "online",
      points: input.points === undefined ? cur.points : cleanPoints(input.points, cur.points),
      ...due,
      unitId: input.unitId === undefined ? cur.unitId : await unitInCourse(ctx, cur.courseId, input.unitId, t),
      categoryId: input.categoryId === undefined ? cur.categoryId : await categoryInCourse(ctx, cur.courseId, input.categoryId, t),
      published: input.published === undefined ? cur.published : input.published === true,
      gradesReleased: input.gradesReleased === undefined ? cur.gradesReleased : input.gradesReleased === true,
    };
    const changed = SNAPSHOT_KEYS.some((k) => next[k] !== cur[k]);
    if (!changed) return { ok: true, assignment: cur, changed: false } as const;

    const snapshot = Object.fromEntries(SNAPSHOT_KEYS.map((k) => [k, cur[k]]));
    await t.query(
      `INSERT INTO assignment_versions (tenant_id, assignment_id, version, snapshot, saved_by, saved_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6) ON CONFLICT (assignment_id, version) DO NOTHING`,
      [ctx.tenantId, id, cur.version, JSON.stringify(snapshot), String(rows[0].updated_by), rows[0].updated_at],
    );
    await t.query(
      `DELETE FROM assignment_versions WHERE assignment_id = $1 AND version <= (
         SELECT max(version) - $2 FROM assignment_versions WHERE assignment_id = $1)`,
      [id, KEEP_VERSIONS],
    );
    const saved = await t.query(
      `UPDATE assignments SET title = $3, instructions = $4, kind = $5, points = $6, due_on = $7, due_at = $8,
              unit_id = $9, category_id = $10, published = $11, grades_released = $12,
              version = version + 1, updated_by = $13, updated_at = now()
        WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      [ctx.tenantId, id, next.title, next.instructions, next.kind, next.points, next.dueOn, next.dueAt,
        next.unitId, next.categoryId, next.published, next.gradesReleased, ctx.userId],
    );
    return { ok: true, assignment: toAssignment(saved[0]), changed: true } as const;
  });
}

/**
 * Archiving hides an assignment everywhere, grades included, but deletes
 * nothing: the grades and work stay in the database.
 */
export async function archiveAssignment(ctx: Ctx, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const db = await getDb();
  const rows = await db.query(
    "UPDATE assignments SET archived = true, updated_by = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING id",
    [ctx.tenantId, id, ctx.userId],
  );
  return rows.length > 0;
}

export async function versionCount(ctx: Ctx, id: string): Promise<number> {
  const db = await getDb();
  const [{ n }] = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM assignment_versions WHERE tenant_id = $1 AND assignment_id = $2",
    [ctx.tenantId, id],
  );
  return n;
}

// ---------- submissions ----------

export type Submission = {
  assignmentId: string;
  studentId: string;
  body: string;
  version: number;
  submittedAt: string | null;
  updatedAt: string;
};

function toSubmission(r: Record<string, unknown>): Submission {
  return {
    assignmentId: String(r.assignment_id),
    studentId: String(r.student_id),
    body: String(r.body ?? ""),
    version: Number(r.version),
    submittedAt: iso(r.submitted_at),
    updatedAt: iso(r.updated_at) as string,
  };
}

/** Late = handed in after the moment it was due. */
export function isLate(a: Pick<Assignment, "dueAt">, s: Pick<Submission, "submittedAt"> | null): boolean {
  return !!a.dueAt && !!s?.submittedAt && new Date(s.submittedAt).getTime() > new Date(a.dueAt).getTime();
}

/** Past due and nothing handed in yet (for showing, never a grade by itself). */
export function isOverdue(a: Pick<Assignment, "dueAt">, s: Pick<Submission, "submittedAt"> | null, now = new Date()): boolean {
  return !!a.dueAt && !s?.submittedAt && now.getTime() > new Date(a.dueAt).getTime();
}

export async function getSubmission(ctx: Ctx, assignmentId: string, studentId: string): Promise<Submission | null> {
  if (!UUID.test(assignmentId)) return null;
  const db = await getDb();
  const rows = await db.query(
    "SELECT * FROM submissions WHERE tenant_id = $1 AND assignment_id = $2 AND student_id = $3",
    [ctx.tenantId, assignmentId, studentId],
  );
  return rows[0] ? toSubmission(rows[0]) : null;
}

export async function listSubmissions(ctx: Ctx, assignmentId: string): Promise<Submission[]> {
  if (!UUID.test(assignmentId)) return [];
  const db = await getDb();
  const rows = await db.query(
    "SELECT * FROM submissions WHERE tenant_id = $1 AND assignment_id = $2",
    [ctx.tenantId, assignmentId],
  );
  return rows.map(toSubmission);
}

/** Every submission in a course, for the gradebook's late marks. */
export async function courseSubmissions(ctx: Ctx, courseId: string, studentId?: string): Promise<Submission[]> {
  const db = await getDb();
  // The body is left out: the gradebook needs only when work was handed in.
  const rows = await db.query(
    `SELECT s.assignment_id, s.student_id, '' AS body, s.version, s.submitted_at, s.updated_at
       FROM submissions s JOIN assignments a ON a.id = s.assignment_id
      WHERE s.tenant_id = $1 AND a.tenant_id = $1 AND a.course_id = $2 AND a.archived = false
        AND ($3::text IS NULL OR s.student_id = $3)`,
    [ctx.tenantId, courseId, studentId ?? null],
  );
  return rows.map(toSubmission);
}

export type SubmissionSave =
  | { ok: true; submission: Submission }
  | { ok: false; reason: "conflict"; submission: Submission }
  | { ok: false; reason: "handed-in" | "missing" };

/**
 * Saves a student's own work. ctx.userId is the student; nobody can write
 * into someone else's submission. Work already handed in can't be changed
 * without taking it back first (unsubmit).
 */
export async function saveDraft(ctx: Ctx, a: Assignment, input: { baseVersion: number; body: unknown; pastes?: unknown }): Promise<SubmissionSave> {
  if (a.kind !== "online" || !a.published) return { ok: false, reason: "missing" };
  const body = String(input.body ?? "").slice(0, LIMITS.body);
  const pastes = cleanPastes(input.pastes);
  const db = await getDb();
  return db.tx(async (t) => {
    const rows = await t.query(
      "SELECT * FROM submissions WHERE tenant_id = $1 AND assignment_id = $2 AND student_id = $3 FOR UPDATE",
      [ctx.tenantId, a.id, ctx.userId],
    );
    if (!rows[0]) {
      // Version 0 means "I have never saved": the first save creates it.
      if (Number(input.baseVersion) !== 0) return { ok: false, reason: "missing" } as const;
      const made = await t.query(
        `INSERT INTO submissions (tenant_id, assignment_id, student_id, body) VALUES ($1, $2, $3, $4)
         ON CONFLICT (assignment_id, student_id) DO NOTHING RETURNING *`,
        [ctx.tenantId, a.id, ctx.userId, body],
      );
      if (!made[0]) {
        const now = await t.query("SELECT * FROM submissions WHERE assignment_id = $1 AND student_id = $2", [a.id, ctx.userId]);
        return { ok: false, reason: "conflict", submission: toSubmission(now[0]) } as const;
      }
      await record(t, ctx.tenantId, String(made[0].id), body, pastes);
      return { ok: true, submission: toSubmission(made[0]) } as const;
    }
    const cur = toSubmission(rows[0]);
    if (Number(input.baseVersion) !== cur.version) return { ok: false, reason: "conflict", submission: cur } as const;
    if (cur.submittedAt) return { ok: false, reason: "handed-in" } as const;
    if (body === cur.body) {
      if (pastes.length) await record(t, ctx.tenantId, String(rows[0].id), body, pastes);
      return { ok: true, submission: cur } as const;
    }
    const saved = await t.query(
      `UPDATE submissions SET body = $4, version = version + 1, updated_at = now()
        WHERE tenant_id = $1 AND assignment_id = $2 AND student_id = $3 RETURNING *`,
      [ctx.tenantId, a.id, ctx.userId, body],
    );
    await record(t, ctx.tenantId, String(saved[0].id), body, pastes);
    return { ok: true, submission: toSubmission(saved[0]) } as const;
  });
}

/**
 * Hands in (or takes back) the student's own work. Taking back is refused
 * once the teacher has graded it: the grade must stay attached to the work
 * it was given for.
 */
export async function setHandedIn(ctx: Ctx, a: Assignment, handIn: boolean, baseVersion: number): Promise<SubmissionSave | { ok: false; reason: "graded" }> {
  if (a.kind !== "online" || !a.published) return { ok: false, reason: "missing" };
  const db = await getDb();
  return db.tx(async (t) => {
    const rows = await t.query(
      "SELECT * FROM submissions WHERE tenant_id = $1 AND assignment_id = $2 AND student_id = $3 FOR UPDATE",
      [ctx.tenantId, a.id, ctx.userId],
    );
    if (!rows[0]) return { ok: false, reason: "missing" } as const;
    const cur = toSubmission(rows[0]);
    if (Number(baseVersion) !== cur.version) return { ok: false, reason: "conflict", submission: cur } as const;
    if (!handIn) {
      const g = await t.query(
        "SELECT 1 FROM grades WHERE tenant_id = $1 AND assignment_id = $2 AND student_id = $3 AND (score IS NOT NULL OR flag = 'exempt')",
        [ctx.tenantId, a.id, ctx.userId],
      );
      if (g[0]) return { ok: false, reason: "graded" } as const;
    }
    const saved = await t.query(
      `UPDATE submissions SET submitted_at = ${handIn ? "now()" : "NULL"}, version = version + 1, updated_at = now()
        WHERE tenant_id = $1 AND assignment_id = $2 AND student_id = $3 RETURNING *`,
      [ctx.tenantId, a.id, ctx.userId],
    );
    // What was handed in is always the last thing the replay shows.
    if (handIn) await record(t, ctx.tenantId, String(saved[0].id), String(saved[0].body ?? ""), [], true);
    return { ok: true, submission: toSubmission(saved[0]) } as const;
  });
}
