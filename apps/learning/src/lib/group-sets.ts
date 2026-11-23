import { getDb, type Queryable } from "./db";
import { GROUP_LIMITS, normalizeGroups, showGroups, groupIndexOf, type Group, type GroupsShown } from "./groups";

/**
 * A class's saved group sets (migration 033, story 01 A8/D8). Teachers make
 * and change them; a save names the version it started from and a stale one
 * is refused (two tabs never overwrite each other). Members are only the
 * class's students as Signify ID gives them to the teacher at save time
 * (`roster`), named as ID names them. Archive, never delete.
 */

export type GroupSet = {
  id: string;
  courseId: string;
  name: string;
  groups: Group[];
  studentsSee: boolean;
  archived: boolean;
  version: number;
  updatedAt: string;
};

type Ctx = { tenantId: string; userId: string };
const UUID = /^[0-9a-f-]{36}$/i;

export class GroupError extends Error {}

function toSet(r: Record<string, unknown>): GroupSet {
  const raw = typeof r.groups === "string" ? JSON.parse(r.groups) : r.groups;
  return {
    id: String(r.id),
    courseId: String(r.course_id),
    name: String(r.name),
    groups: normalizeGroups(raw),
    studentsSee: !!r.students_see,
    archived: !!r.archived,
    version: Number(r.version),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

function cleanName(v: unknown, fallback: string): string {
  return (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, GROUP_LIMITS.setName) : "") || fallback;
}

export async function listGroupSets(ctx: Ctx, courseId: string, opts: { archived?: boolean } = {}): Promise<GroupSet[]> {
  const db = await getDb();
  const rows = await db.query(
    `SELECT * FROM group_sets WHERE tenant_id = $1 AND course_id = $2 AND archived = $3 ORDER BY updated_at DESC`,
    [ctx.tenantId, courseId, !!opts.archived],
  );
  return rows.map(toSet);
}

export async function getGroupSet(ctx: Ctx, courseId: string, id: string, q?: Queryable): Promise<GroupSet | null> {
  if (!UUID.test(id)) return null;
  const db = q ?? await getDb();
  const rows = await db.query("SELECT * FROM group_sets WHERE tenant_id = $1 AND course_id = $2 AND id = $3", [ctx.tenantId, courseId, id]);
  return rows[0] ? toSet(rows[0]) : null;
}

export async function createGroupSet(
  ctx: Ctx, courseId: string, input: { name?: unknown; groups?: unknown; studentsSee?: unknown }, roster: Map<string, string>, word = "Group",
): Promise<GroupSet> {
  const db = await getDb();
  const [course] = await db.query("SELECT kind FROM courses WHERE tenant_id = $1 AND id = $2", [ctx.tenantId, courseId]);
  if (!course) throw new GroupError("No such class.");
  const groups = normalizeGroups(input.groups, roster, word);
  const rows = await db.query(
    `INSERT INTO group_sets (tenant_id, course_id, name, groups, students_see, created_by, updated_by)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $6) RETURNING *`,
    [ctx.tenantId, courseId, cleanName(input.name, "Groups"), JSON.stringify(groups), input.studentsSee !== false, ctx.userId],
  );
  return toSet(rows[0]);
}

export type GroupSave =
  | { ok: true; set: GroupSet }
  | { ok: false; reason: "conflict"; set: GroupSet }
  | { ok: false; reason: "missing" };

export async function saveGroupSet(
  ctx: Ctx, courseId: string, id: string,
  input: { baseVersion: unknown; name?: unknown; groups?: unknown; studentsSee?: unknown; archived?: unknown },
  roster: Map<string, string>, word = "Group",
): Promise<GroupSave> {
  if (!UUID.test(id)) return { ok: false, reason: "missing" };
  const db = await getDb();
  return db.tx(async (t) => {
    const rows = await t.query("SELECT * FROM group_sets WHERE tenant_id = $1 AND course_id = $2 AND id = $3 FOR UPDATE", [ctx.tenantId, courseId, id]);
    if (!rows[0]) return { ok: false, reason: "missing" } as const;
    const cur = toSet(rows[0]);
    if (Number(input.baseVersion) !== cur.version) return { ok: false, reason: "conflict", set: cur } as const;
    // Every save re-reads the class: a student who left drops out, names follow ID.
    const groups = normalizeGroups(input.groups === undefined ? cur.groups : input.groups, roster, word);
    const saved = await t.query(
      `UPDATE group_sets SET name = $4, groups = $5::jsonb, students_see = $6, archived = $7, version = version + 1, updated_by = $8, updated_at = now()
        WHERE tenant_id = $1 AND course_id = $2 AND id = $3 RETURNING *`,
      [ctx.tenantId, courseId, id, input.name === undefined ? cur.name : cleanName(input.name, cur.name), JSON.stringify(groups),
        input.studentsSee === undefined ? cur.studentsSee : input.studentsSee === true,
        input.archived === undefined ? cur.archived : input.archived === true, ctx.userId],
    );
    return { ok: true, set: toSet(saved[0]) } as const;
  });
}

/** A copy of a set under a new name, to change without losing the old one. */
export async function copyGroupSet(ctx: Ctx, courseId: string, id: string, name: string, roster: Map<string, string>): Promise<GroupSet | null> {
  const from = await getGroupSet(ctx, courseId, id);
  if (!from) return null;
  return createGroupSet(ctx, courseId, { name, groups: from.groups.map((g) => ({ ...g, id: undefined })), studentsSee: from.studentsSee }, roster);
}

/** A student's own group in each set they may see: the set's name, their group's name and who is in it. */
export async function myGroups(ctx: Ctx, courseId: string, studentId: string): Promise<{ setId: string; setName: string; group: string; members: string[] }[]> {
  const db = await getDb();
  const rows = await db.query(
    "SELECT * FROM group_sets WHERE tenant_id = $1 AND course_id = $2 AND archived = false AND students_see ORDER BY updated_at DESC",
    [ctx.tenantId, courseId],
  );
  return rows.map(toSet).flatMap((s) => {
    const i = groupIndexOf(s.groups, studentId);
    return i == null ? [] : [{ setId: s.id, setName: s.name, group: s.groups[i].name, members: s.groups[i].members.map((m) => m.name) }];
  });
}

/**
 * The sets a lesson's group slides point at, shown for one viewer: the
 * teacher (studentId null) and a live class see every group; a student
 * reading the lesson later sees only their own, and nothing of a set hidden
 * from students (students_see off). An archived set shows nobody anything.
 */
export async function shownSets(
  tenantId: string, courseId: string, ids: string[], viewer: { studentId: string | null; live: boolean },
): Promise<Map<string, GroupsShown>> {
  const out = new Map<string, GroupsShown>();
  const want = ids.filter((x) => UUID.test(x));
  if (!want.length) return out;
  const db = await getDb();
  const rows = await db.query(
    "SELECT * FROM group_sets WHERE tenant_id = $1 AND course_id = $2 AND archived = false AND id = ANY($3::uuid[])",
    [tenantId, courseId, want],
  );
  for (const s of rows.map(toSet)) {
    if (viewer.studentId && !viewer.live && !s.studentsSee) continue;
    out.set(s.id, showGroups(s.name, s.groups, viewer));
  }
  return out;
}

/**
 * A Random groups slide's deal (story 01, D4), saved as the class's group
 * set linked to the slide (migration 041): the first deal makes the set,
 * every later one saves the same set again (a new version). `groups` must
 * already be the class's students (randomGroups over the ID roster). A set
 * the teacher archived is left alone and a new one is made.
 */
export async function shuffleSet(
  ctx: Ctx, courseId: string, lessonId: string, blockId: string, name: string, groups: Group[], roster: Map<string, string>, word = "Group",
): Promise<GroupSet> {
  const db = await getDb();
  const clean = normalizeGroups(groups, roster, word);
  return db.tx(async (t) => {
    const rows = await t.query(
      `SELECT * FROM group_sets WHERE tenant_id = $1 AND course_id = $2 AND lesson_id = $3 AND block_id = $4 AND archived = false
        ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`,
      [ctx.tenantId, courseId, lessonId, blockId],
    );
    if (rows[0]) {
      const saved = await t.query(
        `UPDATE group_sets SET groups = $2::jsonb, version = version + 1, updated_by = $3, updated_at = now() WHERE id = $1 RETURNING *`,
        [rows[0].id, JSON.stringify(clean), ctx.userId],
      );
      return toSet(saved[0]);
    }
    const made = await t.query(
      `INSERT INTO group_sets (tenant_id, course_id, name, groups, students_see, created_by, updated_by, lesson_id, block_id)
       VALUES ($1, $2, $3, $4::jsonb, true, $5, $5, $6, $7) RETURNING *`,
      [ctx.tenantId, courseId, cleanName(name, "Groups"), JSON.stringify(clean), ctx.userId, lessonId, blockId],
    );
    return toSet(made[0]);
  });
}

/**
 * The latest deal of each Random groups slide of a lesson, shown for one
 * viewer as shownSets does (blockId -> what that viewer sees).
 */
export async function slideSets(
  tenantId: string, courseId: string, lessonId: string, viewer: { studentId: string | null; live: boolean },
): Promise<Map<string, GroupsShown>> {
  const out = new Map<string, GroupsShown>();
  if (!UUID.test(lessonId)) return out;
  const db = await getDb();
  const rows = await db.query(
    `SELECT * FROM group_sets WHERE tenant_id = $1 AND course_id = $2 AND lesson_id = $3 AND archived = false ORDER BY updated_at ASC`,
    [tenantId, courseId, lessonId],
  );
  for (const r of rows) {
    const s = toSet(r);
    if (viewer.studentId && !viewer.live && !s.studentsSee) continue;
    out.set(String(r.block_id), showGroups(s.name, s.groups, viewer));
  }
  return out;
}
