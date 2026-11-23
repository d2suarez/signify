import { getDb, type Queryable } from "./db";
import { getGroupSet } from "./group-sets";
import type { Group } from "./groups";
import { LIMITS, isClosed, type Assignment, type Submission } from "./assignments";
import { cleanPastes, record } from "./writing";
import { groupOwner, snapshotHandIn, studentOwner } from "./hand-in-files";

/**
 * Group assignments (migration 034, story 01 A10/F4). An assignment with a
 * group set: a student in one of its groups works with that group; a
 * student in no group works alone, as on any assignment.
 *
 * Online writing has ONE shared text per group (`group_work`), version-
 * checked like a student's own draft. Hand-in stays per student in
 * `submissions` (the group's text copied in at that moment):
 *  - "each": every member hands in their own; once they have, they can't
 *    change the shared text until they take it back.
 *  - "one": only the group's submitter hands in, for every member at once;
 *    then the text is locked for all, until the submitter takes it back.
 * The submitter is taken on by a member ("group") or set by the teacher.
 */

type Ctx = { tenantId: string; userId: string };

export type GroupWork = {
  groupId: string;
  body: string;
  version: number;
  submitter: string | null;
  submitterBy: "group" | "teacher" | null;
  submittedAt: string | null;
  updatedAt: string;
};

function iso(v: unknown): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}

function toWork(r: Record<string, unknown>): GroupWork {
  return {
    groupId: String(r.group_id),
    body: String(r.body ?? ""),
    version: Number(r.version),
    submitter: r.submitter ? String(r.submitter) : null,
    submitterBy: r.submitter_by === "teacher" ? "teacher" : r.submitter_by === "group" ? "group" : null,
    submittedAt: iso(r.submitted_at),
    updatedAt: iso(r.updated_at) as string,
  };
}

const empty = (groupId: string): GroupWork => ({ groupId, body: "", version: 0, submitter: null, submitterBy: null, submittedAt: null, updatedAt: new Date(0).toISOString() });

/** The assignment's groups (its set, as saved now), or null when it isn't group work. Archived sets still count. */
export async function assignmentGroups(ctx: Ctx, a: Assignment, q?: Queryable): Promise<Group[] | null> {
  if (!a.groupSetId || a.kind === "quiz") return null;
  const set = await getGroupSet(ctx, a.courseId, a.groupSetId, q);
  return set ? set.groups : null;
}

/** The student's group on this assignment, or null (not group work, or in no group: they work alone). */
export async function groupFor(ctx: Ctx, a: Assignment, studentId: string, q?: Queryable): Promise<Group | null> {
  const groups = await assignmentGroups(ctx, a, q);
  return groups?.find((g) => g.members.some((m) => m.id === studentId)) ?? null;
}

export async function listGroupWork(ctx: Ctx, assignmentId: string): Promise<Map<string, GroupWork>> {
  const db = await getDb();
  const rows = await db.query("SELECT * FROM group_work WHERE tenant_id = $1 AND assignment_id = $2", [ctx.tenantId, assignmentId]);
  return new Map(rows.map((r) => [String(r.group_id), toWork(r)]));
}

export async function getGroupWork(ctx: Ctx, assignmentId: string, groupId: string, q?: Queryable): Promise<GroupWork> {
  const db = q ?? await getDb();
  const rows = await db.query("SELECT * FROM group_work WHERE tenant_id = $1 AND assignment_id = $2 AND group_id = $3", [ctx.tenantId, assignmentId, groupId]);
  return rows[0] ? toWork(rows[0]) : empty(groupId);
}

/** The row, made if missing, locked for this transaction. */
async function lockWork(t: Queryable, ctx: Ctx, assignmentId: string, groupId: string): Promise<GroupWork> {
  await t.query(
    `INSERT INTO group_work (tenant_id, assignment_id, group_id) VALUES ($1, $2, $3) ON CONFLICT (assignment_id, group_id) DO NOTHING`,
    [ctx.tenantId, assignmentId, groupId]);
  const rows = await t.query("SELECT * FROM group_work WHERE tenant_id = $1 AND assignment_id = $2 AND group_id = $3 FOR UPDATE", [ctx.tenantId, assignmentId, groupId]);
  return toWork(rows[0]);
}

/** The student's own submission row (made, empty, if missing): where their hand-in and writing record live. */
async function ownRow(t: Queryable, ctx: Ctx, assignmentId: string, studentId: string): Promise<Record<string, unknown>> {
  await t.query(
    `INSERT INTO submissions (tenant_id, assignment_id, student_id, body) VALUES ($1, $2, $3, '') ON CONFLICT (assignment_id, student_id) DO NOTHING`,
    [ctx.tenantId, assignmentId, studentId]);
  const rows = await t.query("SELECT * FROM submissions WHERE tenant_id = $1 AND assignment_id = $2 AND student_id = $3 FOR UPDATE", [ctx.tenantId, assignmentId, studentId]);
  return rows[0];
}

export type GroupState = {
  group: { id: string; name: string; members: { id: string; name: string }[] };
  work: GroupWork;
  /** This student's own hand-in. */
  mine: { submittedAt: string | null };
  mode: Assignment["groupHandIn"];
  submitterBy: Assignment["groupSubmitter"];
};

/** What a student sees of their group's work. Null when they work alone. */
export async function groupState(ctx: Ctx, a: Assignment, studentId: string): Promise<GroupState | null> {
  const group = await groupFor(ctx, a, studentId);
  if (!group) return null;
  const db = await getDb();
  const [work, mine] = await Promise.all([
    getGroupWork(ctx, a.id, group.id),
    db.query("SELECT submitted_at FROM submissions WHERE tenant_id = $1 AND assignment_id = $2 AND student_id = $3", [ctx.tenantId, a.id, studentId]),
  ]);
  return { group, work, mine: { submittedAt: iso(mine[0]?.submitted_at) }, mode: a.groupHandIn, submitterBy: a.groupSubmitter };
}

export type GroupSave =
  | { ok: true; work: GroupWork }
  | { ok: false; reason: "conflict"; work: GroupWork }
  | { ok: false; reason: "handed-in" | "missing" | "not-submitter" | "graded" | "no-submitter" | "closed" };

/** One member saves the group's shared text (online only). ctx.userId is the student. */
export async function saveGroupDraft(ctx: Ctx, a: Assignment, input: { baseVersion: unknown; body: unknown; pastes?: unknown }): Promise<GroupSave> {
  if (a.kind !== "online" || !a.published) return { ok: false, reason: "missing" };
  if (isClosed(a)) return { ok: false, reason: "closed" };
  const group = await groupFor(ctx, a, ctx.userId);
  if (!group) return { ok: false, reason: "missing" };
  const body = String(input.body ?? "").slice(0, LIMITS.body);
  const pastes = cleanPastes(input.pastes);
  const db = await getDb();
  return db.tx(async (t) => {
    const cur = await lockWork(t, ctx, a.id, group.id);
    if (Number(input.baseVersion) !== cur.version) return { ok: false, reason: "conflict", work: cur } as const;
    if (cur.submittedAt) return { ok: false, reason: "handed-in" } as const;
    const own = await ownRow(t, ctx, a.id, ctx.userId);
    if (own.submitted_at) return { ok: false, reason: "handed-in" } as const;
    if (body === cur.body && !pastes.length) return { ok: true, work: cur } as const;
    let work = cur;
    if (body !== cur.body) {
      const saved = await t.query(
        `UPDATE group_work SET body = $4, version = version + 1, updated_by = $5, updated_at = now()
          WHERE tenant_id = $1 AND assignment_id = $2 AND group_id = $3 RETURNING *`,
        [ctx.tenantId, a.id, group.id, body, ctx.userId]);
      work = toWork(saved[0]);
    }
    // The writing record is per student: what this member pasted, and the shared text as they left it.
    await record(t, ctx.tenantId, String(own.id), body, pastes);
    return { ok: true, work } as const;
  });
}

/**
 * Hand in or take back. "each": the student's own. "one": only the
 * submitter, for every member of the group at once. Taking back is refused once any member it
 * covers has a grade.
 */
export async function groupHandIn(ctx: Ctx, a: Assignment, handIn: boolean): Promise<GroupSave> {
  if (a.kind !== "online" || !a.published) return { ok: false, reason: "missing" };
  if (isClosed(a)) return { ok: false, reason: "closed" };
  const db = await getDb();
  return db.tx(async (t) => {
    const group = await groupFor(ctx, a, ctx.userId, t);
    if (!group) return { ok: false, reason: "missing" } as const;
    const cur = await lockWork(t, ctx, a.id, group.id);
    const who = a.groupHandIn === "one" ? group.members.map((m) => m.id) : [ctx.userId];
    if (a.groupHandIn === "one") {
      if (!cur.submitter) return { ok: false, reason: "no-submitter" } as const;
      if (cur.submitter !== ctx.userId) return { ok: false, reason: "not-submitter" } as const;
    }
    if (!handIn) {
      const g = await t.query(
        "SELECT 1 FROM grades WHERE tenant_id = $1 AND assignment_id = $2 AND student_id = ANY($3::text[]) AND (score IS NOT NULL OR flag = 'exempt') LIMIT 1",
        [ctx.tenantId, a.id, who]);
      if (g[0]) return { ok: false, reason: "graded" } as const;
    }
    for (const id of who) {
      const row = await ownRow(t, ctx, a.id, id);
      if (handIn && row.submitted_at && a.groupHandIn === "each") continue;
      const saved = await t.query(
        `UPDATE submissions SET submitted_at = ${handIn ? "now()" : "NULL"}, body = $4, version = version + 1, updated_at = now()
          WHERE tenant_id = $1 AND assignment_id = $2 AND student_id = $3 RETURNING id, body`,
        [ctx.tenantId, a.id, id, handIn ? cur.body : String(row.body ?? "")]);
      // What was handed in is the last thing the hand-in's own replay shows.
      if (handIn && id === ctx.userId) await record(t, ctx.tenantId, String(saved[0].id), cur.body, [], true);
      // Files (story 01 A7): the group's in "one" mode, the member's own in "each".
      if (handIn) await snapshotHandIn(t, ctx.tenantId, a.id, a.groupHandIn === "one" ? groupOwner(group.id) : studentOwner(id), [String(saved[0].id)]);
    }
    const work = a.groupHandIn === "one"
      ? toWork((await t.query(
        `UPDATE group_work SET submitted_at = ${handIn ? "now()" : "NULL"}, updated_at = now() WHERE tenant_id = $1 AND assignment_id = $2 AND group_id = $3 RETURNING *`,
        [ctx.tenantId, a.id, group.id]))[0])
      : cur;
    return { ok: true, work } as const;
  });
}

/** "I'll hand it in": a member takes on handing in for the group (when the group chooses, and before it is handed in). */
export async function claimSubmitter(ctx: Ctx, a: Assignment): Promise<GroupSave> {
  if (a.groupHandIn !== "one" || a.groupSubmitter !== "group" || !a.published) return { ok: false, reason: "missing" };
  if (isClosed(a)) return { ok: false, reason: "closed" };
  const db = await getDb();
  return db.tx(async (t) => {
    const group = await groupFor(ctx, a, ctx.userId, t);
    if (!group) return { ok: false, reason: "missing" } as const;
    const cur = await lockWork(t, ctx, a.id, group.id);
    if (cur.submittedAt) return { ok: false, reason: "handed-in" } as const;
    if (cur.submitterBy === "teacher" && cur.submitter) return { ok: false, reason: "not-submitter" } as const;
    const saved = await t.query(
      `UPDATE group_work SET submitter = $4, submitter_by = 'group', updated_at = now() WHERE tenant_id = $1 AND assignment_id = $2 AND group_id = $3 RETURNING *`,
      [ctx.tenantId, a.id, group.id, ctx.userId]);
    return { ok: true, work: toWork(saved[0]) } as const;
  });
}

/** The teacher sets (or clears, null) who hands in for a group. Only a member of that group. */
export async function setSubmitter(ctx: Ctx, a: Assignment, groupId: string, studentId: string | null): Promise<GroupSave> {
  const groups = await assignmentGroups(ctx, a);
  const group = groups?.find((g) => g.id === groupId);
  if (!group || (studentId && !group.members.some((m) => m.id === studentId))) return { ok: false, reason: "missing" };
  const db = await getDb();
  return db.tx(async (t) => {
    const cur = await lockWork(t, ctx, a.id, group.id);
    if (cur.submittedAt) return { ok: false, reason: "handed-in" } as const;
    const saved = await t.query(
      `UPDATE group_work SET submitter = $4, submitter_by = $5, updated_at = now() WHERE tenant_id = $1 AND assignment_id = $2 AND group_id = $3 RETURNING *`,
      [ctx.tenantId, a.id, group.id, studentId, studentId ? "teacher" : null]);
    return { ok: true, work: toWork(saved[0]) } as const;
  });
}

/** The members a group grade goes to: the student's group, cut to the class as it is now. Just the student when they have none. */
export async function gradeTargets(ctx: Ctx, a: Assignment, studentId: string, roster: Set<string>): Promise<string[]> {
  const group = await groupFor(ctx, a, studentId);
  if (!group) return [studentId];
  const ids = group.members.map((m) => m.id).filter((id) => roster.has(id));
  return ids.includes(studentId) ? ids : [studentId, ...ids];
}

/** For the grading desk: the work a member's grade is for (their hand-in, else the group's text so far). */
export function workFor(sub: Submission | null, work: GroupWork | null): string | null {
  if (sub?.submittedAt) return sub.body;
  return work && work.version > 0 ? work.body : sub?.body ?? null;
}
