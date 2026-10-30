import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getDb, type Queryable } from "./db";
import { STANDARD_LIMITS } from "./standards";
import { normalizeSettings, type StandardsSettings } from "./standards-math";
import { csvItems, gradeList, CSV_LIMITS, type CsvProblem } from "./standards-csv";

/**
 * The standards library, in the shape of 1EdTech CASE 1.1: a framework
 * (CFDocument) holds items (CFItem) in a tree, plus associations to other
 * items (exactMatchOf, ...). Three kinds of framework:
 *
 * - library: published sets loaded from the seed files in standards/
 *   (scripts/standards-seeds.mjs builds them; sources and licenses in
 *   PLAN.md). tenant_id '_library', read by every school; never edited.
 *   'open' sets are seen by all; 'school' sets only once a school admin
 *   turns them on, accepting the publisher's terms (school_standard_sets).
 * - school: made by a school admin (by hand, CSV, or a copy of a library
 *   set to edit). Every teacher of the school sees them.
 * - teacher: made by a teacher when the school allows it; seen by its owner.
 *   A course's own framework (course_id set) holds standards typed straight
 *   into the course and is edited by the course's teachers.
 *
 * A course's standards (table `standards`, standards.ts) point at items by
 * item_id and keep their own copy of code and statement, so the gradebook
 * and alignments never need the library. Editing a school or teacher item
 * updates those copies.
 */

type Ctx = { tenantId: string; userId: string };
export const LIBRARY = "_library";
const UUID = /^[0-9a-f-]{36}$/i;
const STANDARDS_DIR = path.join(process.cwd(), "standards");

export type OwnerKind = "library" | "school" | "teacher";
export type Distribution = "open" | "school";

export type Framework = {
  id: string;
  ownerKind: OwnerKind;
  ownerId: string | null;
  courseId: string | null;
  key: string | null;
  identifier: string;
  uri: string | null;
  title: string;
  creator: string;
  publisher: string;
  subjects: string[];
  language: string;
  version: string;
  officialSourceUrl: string | null;
  dataUrl: string | null;
  dataSource: string | null;
  licenseTitle: string | null;
  licenseUri: string | null;
  licenseText: string | null;
  notice: string | null;
  distribution: Distribution;
  copiedFrom: string | null;
  archived: boolean;
  itemCount: number;
  /** A library set with a newer version loaded. */
  superseded: boolean;
  updatedAt: string;
};

export type Item = {
  id: string;
  frameworkId: string;
  identifier: string;
  uri: string | null;
  code: string;
  statement: string;
  type: string | null;
  grades: string[];
  parentId: string | null;
  depth: number;
  position: number;
  notes: string | null;
  archived: boolean;
};

function arr(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  // node-postgres gives text[] as an array; a literal '{a,b}' just in case.
  if (typeof v === "string" && v.startsWith("{")) return v.slice(1, -1).split(",").filter(Boolean).map((s) => s.replace(/^"|"$/g, ""));
  return [];
}

function toFramework(r: Record<string, unknown>): Framework {
  return {
    id: String(r.id), ownerKind: r.owner_kind as OwnerKind, ownerId: (r.owner_id as string) ?? null, courseId: (r.course_id as string) ?? null,
    key: (r.key as string) ?? null, identifier: String(r.identifier), uri: (r.uri as string) ?? null, title: String(r.title),
    creator: String(r.creator ?? ""), publisher: String(r.publisher ?? ""), subjects: arr(r.subjects), language: String(r.language ?? "en"),
    version: String(r.version ?? ""), officialSourceUrl: (r.official_source_url as string) ?? null, dataUrl: (r.data_url as string) ?? null,
    dataSource: (r.data_source as string) ?? null, licenseTitle: (r.license_title as string) ?? null, licenseUri: (r.license_uri as string) ?? null,
    licenseText: (r.license_text as string) ?? null, notice: (r.notice as string) ?? null, distribution: r.distribution === "school" ? "school" : "open",
    copiedFrom: (r.copied_from as string) ?? null, archived: !!r.archived, itemCount: Number(r.item_count ?? 0), superseded: !!r.superseded,
    updatedAt: new Date(String(r.updated_at)).toISOString(),
  };
}

function toItem(r: Record<string, unknown>): Item {
  return {
    id: String(r.id), frameworkId: String(r.framework_id), identifier: String(r.identifier), uri: (r.uri as string) ?? null,
    code: String(r.code ?? ""), statement: String(r.statement ?? ""), type: (r.item_type as string) ?? null, grades: arr(r.grades),
    parentId: (r.parent_id as string) ?? null, depth: Number(r.depth ?? 0), position: Number(r.position ?? 0),
    notes: (r.notes as string) ?? null, archived: !!r.archived,
  };
}

function line(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

export const FRAMEWORK_LIMITS = { title: 200, subject: 60, items: 5000, perOwner: 100 };

// ---------- loading the published sets ----------

type Seed = {
  format: string;
  framework: Record<string, unknown> & { key: string; version: string; title: string; identifier: string };
  items: { identifier: string; uri: string | null; code: string; statement: string; abbreviated: string | null; type: string | null; grades: string[]; parent: string | null; list: string | null; notes: string | null }[];
  associations: { origin: string; type: string; dest: string; destUri: string | null }[];
};

/**
 * Loads every seed in the manifest that isn't loaded yet (by key and
 * version), each in one transaction. A new version is a new framework; the
 * old one stays, since courses may point at its items. Returns the files loaded.
 */
export async function loadLibrary(db: { tx: (fn: (q: Queryable) => Promise<unknown>) => Promise<unknown> } & Queryable, dir = STANDARDS_DIR): Promise<string[]> {
  const manifest = path.join(dir, "manifest.json");
  if (!fs.existsSync(manifest)) return [];
  const files: string[] = JSON.parse(fs.readFileSync(manifest, "utf8"));
  const have = new Set((await db.query<{ k: string }>("SELECT key || '@' || version AS k FROM standard_frameworks WHERE tenant_id = $1 AND key IS NOT NULL", [LIBRARY])).map((r) => r.k));
  const loaded: string[] = [];
  for (const file of files) {
    if (have.has(file.replace(/\.json$/, ""))) continue;
    const seed: Seed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    if (seed.format !== "signify-standards/1") throw new Error(`${file}: unknown format`);
    if (`${seed.framework.key}@${seed.framework.version}.json` !== file) throw new Error(`${file}: key/version don't match the file name`);
    await db.tx(async (t) => { await insertSeed(t, seed); });
    loaded.push(file);
  }
  return loaded;
}

async function insertSeed(t: Queryable, seed: Seed) {
  const f = seed.framework;
  const s = (k: string) => (typeof f[k] === "string" ? (f[k] as string) : null);
  const [fw] = await t.query<{ id: string }>(
    `INSERT INTO standard_frameworks (tenant_id, owner_kind, key, identifier, uri, title, creator, publisher, subjects, language, version,
       adoption_status, official_source_url, data_url, data_source, license_title, license_uri, license_text, notice, distribution, created_by)
     VALUES ($1, 'library', $2, $3, $4, $5, $6, $7, $8::text[], $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, 'seed') RETURNING id`,
    [LIBRARY, f.key, f.identifier, s("uri"), f.title, s("creator") ?? "", s("publisher") ?? "", Array.isArray(f.subject) ? f.subject : [],
      s("language") ?? "en", f.version, s("adoptionStatus"), s("officialSourceURL"), s("dataURL"), s("dataSource"), s("licenseTitle"),
      s("licenseURI"), s("licenseText"), s("notice"), f.distribution === "school" ? "school" : "open"],
  );
  await insertItems(t, LIBRARY, fw.id, seed.items.map((i) => ({ ...i, parentIdentifier: i.parent })));
  const ids = new Map((await t.query<{ id: string; identifier: string }>("SELECT id, identifier FROM standard_items WHERE framework_id = $1", [fw.id])).map((r) => [r.identifier, r.id]));
  const assoc = seed.associations.filter((a) => ids.has(a.origin));
  for (let k = 0; k < assoc.length; k += 500) {
    const part = assoc.slice(k, k + 500);
    await t.query(
      `INSERT INTO standard_associations (tenant_id, framework_id, origin_id, association_type, dest_identifier, dest_uri)
       SELECT $1, $2, o, ty, d, u FROM unnest($3::uuid[], $4::text[], $5::text[], $6::text[]) AS x(o, ty, d, u)`,
      [LIBRARY, fw.id, part.map((a) => ids.get(a.origin)), part.map((a) => a.type), part.map((a) => a.dest), part.map((a) => a.destUri)],
    );
  }
}

type NewItem = { identifier?: string; uri?: string | null; code: string; statement: string; abbreviated?: string | null; type: string | null; grades: string[]; parentIdentifier: string | null; list?: string | null; notes?: string | null };

/** Appends items (parents before children) after the framework's last one. Returns their new ids by identifier. */
async function insertItems(t: Queryable, tenantId: string, frameworkId: string, items: NewItem[]): Promise<Map<string, string>> {
  const existing = await t.query<{ id: string; identifier: string; depth: number }>("SELECT id, identifier, depth FROM standard_items WHERE framework_id = $1", [frameworkId]);
  const idOf = new Map(existing.map((r) => [r.identifier, r.id]));
  const depthOf = new Map(existing.map((r) => [r.id, Number(r.depth)]));
  const [{ p }] = await t.query<{ p: number }>("SELECT coalesce(max(position), -1)::int AS p FROM standard_items WHERE framework_id = $1", [frameworkId]);
  const made = new Map<string, string>();
  const rows = items.map((i, k) => {
    const identifier = i.identifier || crypto.randomUUID();
    const id = crypto.randomUUID();
    const parent = i.parentIdentifier ? idOf.get(i.parentIdentifier) ?? null : null;
    const depth = parent ? (depthOf.get(parent) ?? 0) + 1 : 0;
    idOf.set(identifier, id); depthOf.set(id, depth); made.set(identifier, id);
    return { id, identifier, uri: i.uri ?? null, code: i.code, statement: i.statement, abbreviated: i.abbreviated ?? null, type: i.type,
      grades: i.grades.join(","), parent, depth, position: p + 1 + k, list: i.list ?? null, notes: i.notes ?? null };
  });
  for (let k = 0; k < rows.length; k += 500) {
    const part = rows.slice(k, k + 500);
    const col = <K extends keyof (typeof rows)[number]>(key: K) => part.map((r) => r[key]);
    await t.query(
      `INSERT INTO standard_items (id, tenant_id, framework_id, identifier, uri, code, statement, abbreviated, item_type, grades, parent_id, depth, position, list_enum, notes)
       SELECT id, $1, $2, identifier, uri, code, statement, abbr, ty, coalesce(string_to_array(nullif(g, ''), ','), '{}'), parent, depth, pos, li, notes
         FROM unnest($3::uuid[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::uuid[], $12::int[], $13::int[], $14::text[], $15::text[])
           AS x(id, identifier, uri, code, statement, abbr, ty, g, parent, depth, pos, li, notes)`,
      [tenantId, frameworkId, col("id"), col("identifier"), col("uri"), col("code"), col("statement"), col("abbreviated"), col("type"), col("grades"),
        col("parent"), col("depth"), col("position"), col("list"), col("notes")],
    );
  }
  await t.query("UPDATE standard_frameworks SET updated_at = now() WHERE id = $1", [frameworkId]);
  return made;
}

/** Once per process: the library is loaded before anyone browses it. */
export function ensureLibrary(): Promise<void> {
  const g = globalThis as unknown as { __learningLibrary?: Promise<void> };
  g.__learningLibrary ??= (async () => {
    const db = await getDb();
    const loaded = await loadLibrary(db);
    if (loaded.length) console.log(`Standards library: loaded ${loaded.join(", ")}`);
  })().catch((e) => { delete g.__learningLibrary; throw e; });
  return g.__learningLibrary;
}

// ---------- the school's choices ----------

export type SchoolStandards = {
  /** The school's default scale/summary/conversion; null = the built-in default. */
  settings: StandardsSettings | null;
  teacherFrameworks: boolean;
  courseSettings: boolean;
  /** Keys of 'school' library sets this school turned on. */
  enabledSets: string[];
};

export async function schoolStandards(tenantId: string, q?: Queryable): Promise<SchoolStandards> {
  const db = q ?? await getDb();
  const [rows, sets] = await Promise.all([
    db.query("SELECT * FROM school_standards_settings WHERE tenant_id = $1", [tenantId]),
    db.query<{ framework_key: string }>("SELECT framework_key FROM school_standard_sets WHERE tenant_id = $1 ORDER BY framework_key", [tenantId]),
  ]);
  const r = rows[0];
  const raw = r?.settings;
  return {
    settings: raw ? normalizeSettings(typeof raw === "string" ? JSON.parse(raw) : raw) : null,
    teacherFrameworks: r ? !!r.teacher_frameworks : true,
    courseSettings: r ? !!r.course_settings : true,
    enabledSets: sets.map((s) => s.framework_key),
  };
}

/** School admins only (the caller checks). `settings: null` = back to the built-in default. */
export async function saveSchoolStandards(ctx: Ctx, input: { settings?: unknown; teacherFrameworks?: boolean; courseSettings?: boolean }): Promise<SchoolStandards> {
  const db = await getDb();
  const cur = await schoolStandards(ctx.tenantId, db);
  const settings = input.settings === undefined ? cur.settings : input.settings === null ? null : normalizeSettings(input.settings);
  await db.query(
    `INSERT INTO school_standards_settings (tenant_id, settings, teacher_frameworks, course_settings, updated_by, updated_at)
     VALUES ($1, $2::jsonb, $3, $4, $5, now())
     ON CONFLICT (tenant_id) DO UPDATE SET settings = $2::jsonb, teacher_frameworks = $3, course_settings = $4, updated_by = $5, updated_at = now()`,
    [ctx.tenantId, settings ? JSON.stringify(settings) : null, input.teacherFrameworks ?? cur.teacherFrameworks, input.courseSettings ?? cur.courseSettings, ctx.userId],
  );
  return schoolStandards(ctx.tenantId, db);
}

/** Turns a 'school' library set on (the admin accepted its terms) or off. Courses keep standards already added. */
export async function setSchoolSet(ctx: Ctx, key: string, on: boolean): Promise<boolean> {
  const db = await getDb();
  const known = await db.query("SELECT 1 FROM standard_frameworks WHERE tenant_id = $1 AND key = $2 AND distribution = 'school' LIMIT 1", [LIBRARY, key]);
  if (!known.length) return false;
  if (on) await db.query("INSERT INTO school_standard_sets (tenant_id, framework_key, enabled_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [ctx.tenantId, key, ctx.userId]);
  else await db.query("DELETE FROM school_standard_sets WHERE tenant_id = $1 AND framework_key = $2", [ctx.tenantId, key]);
  return true;
}

// ---------- who sees and edits what ----------

/** Who is asking: their school role, and the courses they teach (for course frameworks). */
export type Viewer = Ctx & { admin: boolean; teaches: string[] };

/**
 * SQL that keeps only frameworks this viewer may see (alias f). Parameters
 * $1 = tenant, $2 = user, $3 = taught course ids.
 */
const VISIBLE = `(
  (f.tenant_id = '${LIBRARY}' AND (f.distribution = 'open' OR f.key IN (SELECT framework_key FROM school_standard_sets WHERE tenant_id = $1)))
  OR (f.tenant_id = $1 AND f.owner_kind = 'school')
  OR (f.tenant_id = $1 AND f.owner_kind = 'teacher' AND (f.owner_id = $2 OR f.course_id = ANY($3::uuid[])))
)`;
const vparams = (v: Viewer) => [v.tenantId, v.userId, v.teaches.filter((id) => UUID.test(id))];

export function canEdit(v: Viewer, f: Framework): boolean {
  if (f.ownerKind === "library") return false;
  if (f.ownerKind === "school") return v.admin;
  return f.ownerId === v.userId || (!!f.courseId && v.teaches.includes(f.courseId));
}

const FRAMEWORK_COLS = `f.*,
  (SELECT count(*)::int FROM standard_items i WHERE i.framework_id = f.id AND NOT i.archived) AS item_count,
  (f.key IS NOT NULL AND EXISTS (SELECT 1 FROM standard_frameworks n WHERE n.tenant_id = f.tenant_id AND n.key = f.key AND n.created_at > f.created_at)) AS superseded`;

/** Every framework the viewer can see: library first, then the school's, then their own. */
export async function listFrameworks(v: Viewer, opts: { withArchived?: boolean } = {}): Promise<Framework[]> {
  const db = await getDb();
  const rows = await db.query(
    `SELECT ${FRAMEWORK_COLS} FROM standard_frameworks f WHERE ${VISIBLE} ${opts.withArchived ? "" : "AND NOT f.archived"}
      ORDER BY CASE f.owner_kind WHEN 'library' THEN 0 WHEN 'school' THEN 1 ELSE 2 END, f.title, f.version DESC`,
    vparams(v),
  );
  return rows.map(toFramework);
}

/** The 'school' library sets a school admin may turn on, newest version of each. */
export async function schoolSets(): Promise<Framework[]> {
  const db = await getDb();
  const rows = await db.query(
    `SELECT ${FRAMEWORK_COLS} FROM standard_frameworks f WHERE f.tenant_id = $1 AND f.distribution = 'school'
       AND NOT EXISTS (SELECT 1 FROM standard_frameworks n WHERE n.tenant_id = f.tenant_id AND n.key = f.key AND n.created_at > f.created_at)
     ORDER BY f.title`,
    [LIBRARY],
  );
  return rows.map(toFramework);
}

export async function getFramework(v: Viewer, id: string, q?: Queryable): Promise<Framework | null> {
  if (!UUID.test(id)) return null;
  const db = q ?? await getDb();
  const rows = await db.query(`SELECT ${FRAMEWORK_COLS} FROM standard_frameworks f WHERE ${VISIBLE} AND f.id = $4`, [...vparams(v), id]);
  return rows[0] ? toFramework(rows[0]) : null;
}

// ---------- browsing and search ----------

export type Hit = Item & { framework: Pick<Framework, "id" | "title" | "version" | "ownerKind" | "notice"> };
export type SearchInput = { frameworkId?: string; subject?: string; grade?: string; q?: string; limit?: number; withArchived?: boolean };

/**
 * Items the viewer can see, in framework then tree order. Words in `q` must
 * each be in the code or the statement. Headings (no code) are kept when
 * browsing one framework, so the tree reads; a search lists coded items only
 * unless the heading itself matches.
 */
export async function searchItems(v: Viewer, input: SearchInput): Promise<{ hits: Hit[]; more: boolean }> {
  const db = await getDb();
  const params: unknown[] = vparams(v);
  const where: string[] = [VISIBLE];
  if (!input.withArchived) where.push("NOT i.archived", "NOT f.archived");
  if (input.frameworkId && UUID.test(input.frameworkId)) { params.push(input.frameworkId); where.push(`f.id = $${params.length}`); }
  if (input.subject) { params.push(input.subject.slice(0, 60)); where.push(`$${params.length} = ANY(f.subjects)`); }
  const g = input.grade ? gradeList(input.grade)[0] : undefined;
  // Items with no grades of their own (headings, anchors) are kept: they apply to every grade.
  if (g) { params.push(g); where.push(`($${params.length} = ANY(i.grades) OR cardinality(i.grades) = 0)`); }
  const words = (input.q ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  for (const w of words) {
    params.push(`%${w.replace(/[\\%_]/g, (c) => "\\" + c)}%`);
    where.push(`(lower(i.code) LIKE $${params.length} OR lower(i.statement) LIKE $${params.length})`);
  }
  if (!input.frameworkId && !words.length) where.push("i.code <> ''");
  const limit = Math.min(Math.max(input.limit ?? 300, 1), 1000);
  params.push(limit + 1);
  const rows = await db.query(
    `SELECT i.*, f.title AS f_title, f.version AS f_version, f.owner_kind AS f_owner, f.notice AS f_notice
       FROM standard_items i JOIN standard_frameworks f ON f.id = i.framework_id
      WHERE ${where.join(" AND ")}
      ORDER BY CASE f.owner_kind WHEN 'library' THEN 0 WHEN 'school' THEN 1 ELSE 2 END, f.title, f.version DESC, i.position
      LIMIT $${params.length}`,
    params,
  );
  const hits = rows.slice(0, limit).map((r) => ({
    ...toItem(r),
    framework: { id: String(r.framework_id), title: String(r.f_title), version: String(r.f_version ?? ""), ownerKind: r.f_owner as OwnerKind, notice: (r.f_notice as string) ?? null },
  }));
  return { hits, more: rows.length > limit };
}

/** One item with its framework and its line of parents (top first), if the viewer may see it. */
export async function getItem(v: Viewer, id: string, q?: Queryable): Promise<{ item: Item; framework: Framework; path: Item[] } | null> {
  if (!UUID.test(id)) return null;
  const db = q ?? await getDb();
  const rows = await db.query("SELECT * FROM standard_items WHERE id = $1", [id]);
  if (!rows[0]) return null;
  const item = toItem(rows[0]);
  const framework = await getFramework(v, item.frameworkId, db);
  if (!framework) return null;
  const up = await db.query(
    `WITH RECURSIVE up AS (SELECT * FROM standard_items WHERE id = $1 UNION ALL SELECT p.* FROM standard_items p JOIN up ON p.id = up.parent_id)
     SELECT * FROM up WHERE id <> $1`,
    [id],
  );
  return { item, framework, path: up.map(toItem).sort((a, b) => a.depth - b.depth) };
}

// ---------- adding to a course ----------

/** A course standard's short name: the item's code, else its abbreviated or opening words. */
export function shortCode(i: Pick<Item, "code" | "statement"> & { abbreviated?: string | null }): string {
  const c = i.code || i.abbreviated || i.statement;
  return c.length <= STANDARD_LIMITS.code ? c : c.slice(0, STANDARD_LIMITS.code - 1).trimEnd() + "…";
}

/**
 * Adds items to a course's standards (the caller checked the person
 * teaches it). An item already there is brought back if archived, never
 * added twice. Returns how many were added and how many were refused
 * (not visible, or past the course's limit).
 */
export async function addItemsToCourse(v: Viewer, courseId: string, itemIds: string[]): Promise<{ added: number; refused: number }> {
  const want = [...new Set(itemIds.filter((id) => UUID.test(id)))].slice(0, STANDARD_LIMITS.perCourse);
  if (!want.length) return { added: 0, refused: 0 };
  const db = await getDb();
  return db.tx(async (t) => {
    const items = await t.query(
      `SELECT i.* FROM standard_items i JOIN standard_frameworks f ON f.id = i.framework_id
        WHERE ${VISIBLE} AND i.id = ANY($4::uuid[]) AND NOT i.archived`,
      [...vparams(v), want],
    );
    let added = 0;
    const [{ n }] = await t.query<{ n: number }>("SELECT count(*)::int AS n FROM standards WHERE tenant_id = $1 AND course_id = $2", [v.tenantId, courseId]);
    let count = n;
    // In the order asked for (a tree's order when added from a list).
    const order = new Map(want.map((id, k) => [id, k]));
    items.sort((a, b) => order.get(String(a.id))! - order.get(String(b.id))!);
    for (const r of items) {
      const i = toItem(r);
      const had = await t.query("UPDATE standards SET archived = false WHERE tenant_id = $1 AND course_id = $2 AND item_id = $3 RETURNING id", [v.tenantId, courseId, i.id]);
      if (had.length) continue;
      if (count >= STANDARD_LIMITS.perCourse) break;
      await t.query(
        `INSERT INTO standards (tenant_id, course_id, code, description, external_id, item_id, position)
         VALUES ($1, $2, $3, $4, $5, $6, (SELECT coalesce(max(position), -1) + 1 FROM standards WHERE tenant_id = $1 AND course_id = $2))`,
        [v.tenantId, courseId, shortCode({ ...i, abbreviated: (r.abbreviated as string) ?? null }), i.statement.slice(0, STANDARD_LIMITS.description), i.identifier.slice(0, STANDARD_LIMITS.externalId), i.id],
      );
      added++; count++;
    }
    return { added, refused: want.length - items.length };
  });
}

/**
 * A course's own framework (holding standards typed straight into the
 * course), made on first use.
 */
export async function courseFramework(ctx: Ctx, courseId: string, courseName: string, t: Queryable): Promise<string> {
  const rows = await t.query<{ id: string }>(
    "SELECT id FROM standard_frameworks WHERE tenant_id = $1 AND owner_kind = 'teacher' AND course_id = $2 ORDER BY created_at LIMIT 1",
    [ctx.tenantId, courseId],
  );
  if (rows[0]) return rows[0].id;
  const [f] = await t.query<{ id: string }>(
    `INSERT INTO standard_frameworks (tenant_id, owner_kind, course_id, identifier, title, created_by)
     VALUES ($1, 'teacher', $2, $3, $4, $5) RETURNING id`,
    [ctx.tenantId, courseId, crypto.randomUUID(), line(courseName, FRAMEWORK_LIMITS.title) || "Course standards", ctx.userId],
  );
  return f.id;
}

/** A new item at the end of a course framework, for a standard typed into the course. */
export async function addCourseItem(ctx: Ctx, frameworkId: string, code: string, statement: string, t: Queryable): Promise<string> {
  const made = await insertItems(t, ctx.tenantId, frameworkId, [{ code, statement, type: null, grades: [], parentIdentifier: null }]);
  return [...made.values()][0];
}

// ---------- school and teacher frameworks ----------

export type FrameworkInput = { title?: unknown; subject?: unknown; version?: unknown };

/** May this viewer make a framework of this kind? School: admins. Teacher: when the school allows. */
export async function mayCreate(v: Viewer, kind: "school" | "teacher"): Promise<boolean> {
  if (kind === "school") return v.admin;
  return v.admin || (await schoolStandards(v.tenantId)).teacherFrameworks;
}

export async function createFramework(v: Viewer, kind: "school" | "teacher", input: FrameworkInput): Promise<Framework | null> {
  const title = line(input.title, FRAMEWORK_LIMITS.title);
  if (!title || !(await mayCreate(v, kind))) return null;
  const db = await getDb();
  const [{ n }] = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM standard_frameworks WHERE tenant_id = $1 AND owner_kind = $2 AND ($2 = 'school' OR owner_id = $3)",
    [v.tenantId, kind, v.userId],
  );
  if (n >= FRAMEWORK_LIMITS.perOwner) return null;
  const subject = line(input.subject, FRAMEWORK_LIMITS.subject);
  const [r] = await db.query<{ id: string }>(
    `INSERT INTO standard_frameworks (tenant_id, owner_kind, owner_id, identifier, title, subjects, version, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8) RETURNING id`,
    [v.tenantId, kind, kind === "teacher" ? v.userId : null, crypto.randomUUID(), title, subject ? [subject] : [], line(input.version, 40), v.userId],
  );
  return getFramework(v, r.id);
}

export async function updateFramework(v: Viewer, id: string, input: FrameworkInput): Promise<boolean> {
  const f = await getFramework(v, id);
  const title = line(input.title, FRAMEWORK_LIMITS.title);
  if (!f || !canEdit(v, f) || !title) return false;
  const subject = line(input.subject, FRAMEWORK_LIMITS.subject);
  const db = await getDb();
  await db.query("UPDATE standard_frameworks SET title = $3, subjects = $4::text[], version = $5, updated_at = now() WHERE tenant_id = $1 AND id = $2",
    [v.tenantId, id, title, subject ? [subject] : [], line(input.version, 40)]);
  return true;
}

/** Archive (hidden from browsing; course standards already added stay) or bring back. */
export async function archiveFramework(v: Viewer, id: string, archived: boolean): Promise<boolean> {
  const db = await getDb();
  const rows = await db.query(`SELECT ${FRAMEWORK_COLS} FROM standard_frameworks f WHERE ${VISIBLE} AND f.id = $4`, [...vparams(v), id]);
  const f = rows[0] ? toFramework(rows[0]) : null;
  if (!f || !canEdit(v, f)) return false;
  await db.query("UPDATE standard_frameworks SET archived = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2", [v.tenantId, id, archived]);
  return true;
}

export type ItemInput = { code?: unknown; statement?: unknown; grades?: unknown; type?: unknown; parentId?: unknown };

async function editable(v: Viewer, frameworkId: string): Promise<Framework | null> {
  const f = await getFramework(v, frameworkId);
  return f && canEdit(v, f) && !f.archived ? f : null;
}

export async function addItem(v: Viewer, frameworkId: string, input: ItemInput): Promise<Item | null> {
  const f = await editable(v, frameworkId);
  const statement = line(input.statement, CSV_LIMITS.statement);
  if (!f || !statement || f.itemCount >= FRAMEWORK_LIMITS.items) return null;
  const db = await getDb();
  return db.tx(async (t) => {
    let parentIdentifier: string | null = null;
    if (typeof input.parentId === "string" && UUID.test(input.parentId)) {
      const p = await t.query<{ identifier: string }>("SELECT identifier FROM standard_items WHERE framework_id = $1 AND id = $2", [f.id, input.parentId]);
      parentIdentifier = p[0]?.identifier ?? null;
    }
    const made = await insertItems(t, v.tenantId, f.id, [{
      code: line(input.code, CSV_LIMITS.code), statement, type: line(input.type, CSV_LIMITS.type) || null, grades: gradeList(input.grades), parentIdentifier,
    }]);
    const rows = await t.query("SELECT * FROM standard_items WHERE id = $1", [[...made.values()][0]]);
    return toItem(rows[0]);
  });
}

/**
 * Changes a school or teacher item. Course standards made from it get the
 * new code and statement too (their levels and alignments stay).
 */
export async function updateItem(v: Viewer, itemId: string, input: ItemInput): Promise<boolean> {
  const found = await getItem(v, itemId);
  const statement = line(input.statement, CSV_LIMITS.statement);
  if (!found || !canEdit(v, found.framework) || !statement) return false;
  const code = line(input.code, CSV_LIMITS.code);
  const db = await getDb();
  await db.tx(async (t) => {
    await t.query("UPDATE standard_items SET code = $3, statement = $4, grades = $5::text[], item_type = $6 WHERE tenant_id = $1 AND id = $2",
      [v.tenantId, itemId, code, statement, gradeList(input.grades), line(input.type, CSV_LIMITS.type) || null]);
    await t.query("UPDATE standards SET code = $3, description = $4 WHERE tenant_id = $1 AND item_id = $2",
      [v.tenantId, itemId, shortCode({ code, statement }), statement.slice(0, STANDARD_LIMITS.description)]);
    await t.query("UPDATE standard_frameworks SET updated_at = now() WHERE id = $1", [found.framework.id]);
  });
  return true;
}

/** Archive an item (and nothing else: course standards made from it stay until archived there). */
export async function archiveItem(v: Viewer, itemId: string, archived: boolean): Promise<boolean> {
  const found = await getItem(v, itemId);
  if (!found || !canEdit(v, found.framework)) return false;
  const db = await getDb();
  await db.query("UPDATE standard_items SET archived = $3 WHERE tenant_id = $1 AND id = $2", [v.tenantId, itemId, archived]);
  return true;
}

/** Adds a CSV's rows to a framework, all or nothing. Nothing is written if any row has a problem. */
export async function importCsv(v: Viewer, frameworkId: string, text: string): Promise<{ added: number; problems: CsvProblem[] } | null> {
  const f = await editable(v, frameworkId);
  if (!f) return null;
  const db = await getDb();
  const codes = await db.query<{ code: string; identifier: string }>("SELECT code, identifier FROM standard_items WHERE framework_id = $1 AND code <> ''", [f.id]);
  const { items, problems } = csvItems(text, codes.map((c) => c.code));
  if (problems.length || !items.length) return { added: 0, problems };
  if (f.itemCount + items.length > FRAMEWORK_LIMITS.items) return { added: 0, problems: [{ line: 0, problem: "tooMany" }] };
  // Parents are named by code: give each new row an identifier and point children at it.
  const byCode = new Map(codes.map((c) => [c.code.toLowerCase(), c.identifier]));
  const rows: NewItem[] = items.map((i) => {
    const identifier = crypto.randomUUID();
    const parentIdentifier = i.parentCode ? byCode.get(i.parentCode.toLowerCase()) ?? null : null;
    if (i.code) byCode.set(i.code.toLowerCase(), identifier);
    return { identifier, code: i.code, statement: i.statement, type: i.type, grades: i.grades, parentIdentifier };
  });
  await db.tx((t) => insertItems(t, v.tenantId, f.id, rows));
  return { added: rows.length, problems: [] };
}

/**
 * Copies a framework the viewer can see into a new school or teacher
 * framework to edit. The source's license, notice and identifiers' origin
 * travel with it (copied_from); items get new identifiers, with an
 * exactMatchOf association back to the original item.
 */
export async function copyFramework(v: Viewer, sourceId: string, kind: "school" | "teacher"): Promise<Framework | null> {
  const src = await getFramework(v, sourceId);
  if (!src || !(await mayCreate(v, kind))) return null;
  const db = await getDb();
  const id = await db.tx(async (t) => {
    const [f] = await t.query<{ id: string }>(
      `INSERT INTO standard_frameworks (tenant_id, owner_kind, owner_id, identifier, title, creator, publisher, subjects, language, version,
         official_source_url, data_url, data_source, license_title, license_uri, license_text, notice, copied_from, created_by)
       SELECT $1, $2, $3, $4, title, creator, publisher, subjects, language, version,
         official_source_url, data_url, data_source, license_title, license_uri, license_text, notice, id, $5
         FROM standard_frameworks WHERE id = $6 RETURNING id`,
      [v.tenantId, kind, kind === "teacher" ? v.userId : null, crypto.randomUUID(), v.userId, src.id],
    );
    const items = await t.query("SELECT * FROM standard_items WHERE framework_id = $1 AND NOT archived ORDER BY position", [src.id]);
    const newIdent = new Map(items.map((r) => [String(r.id), crypto.randomUUID()]));
    const made = await insertItems(t, v.tenantId, f.id, items.map((r) => ({
      identifier: newIdent.get(String(r.id)), code: String(r.code ?? ""), statement: String(r.statement), abbreviated: (r.abbreviated as string) ?? null,
      type: (r.item_type as string) ?? null, grades: arr(r.grades), parentIdentifier: r.parent_id ? newIdent.get(String(r.parent_id)) ?? null : null,
      list: (r.list_enum as string) ?? null, notes: (r.notes as string) ?? null,
    })));
    const pairs = items.map((r) => [made.get(newIdent.get(String(r.id))!)!, String(r.identifier), (r.uri as string) ?? null] as const);
    for (let k = 0; k < pairs.length; k += 500) {
      const part = pairs.slice(k, k + 500);
      await t.query(
        `INSERT INTO standard_associations (tenant_id, framework_id, origin_id, association_type, dest_identifier, dest_uri)
         SELECT $1, $2, o, 'exactMatchOf', d, u FROM unnest($3::uuid[], $4::text[], $5::text[]) AS x(o, d, u)`,
        [v.tenantId, f.id, part.map((p) => p[0]), part.map((p) => p[1]), part.map((p) => p[2])],
      );
    }
    return f.id;
  });
  return getFramework(v, id);
}

/** All of a framework's items in tree order (for its page and the editor). */
export async function frameworkItems(v: Viewer, frameworkId: string, opts: { withArchived?: boolean } = {}): Promise<Item[]> {
  const f = await getFramework(v, frameworkId);
  if (!f) return [];
  const db = await getDb();
  const rows = await db.query(`SELECT * FROM standard_items WHERE framework_id = $1 ${opts.withArchived ? "" : "AND NOT archived"} ORDER BY position`, [f.id]);
  return rows.map(toItem);
}

/** Subjects across the visible frameworks, for the browse filter. */
export function subjectsOf(list: Framework[]): string[] {
  return [...new Set(list.flatMap((f) => f.subjects))].sort((a, b) => a.localeCompare(b));
}

/** Framework metadata of the items a course's standards point at (for badges and notices). */
export async function courseStandardSources(tenantId: string, courseId: string): Promise<Map<string, Pick<Framework, "id" | "title" | "version" | "ownerKind" | "notice">>> {
  const db = await getDb();
  const rows = await db.query(
    `SELECT s.id AS standard_id, f.id, f.title, f.version, f.owner_kind, f.notice
       FROM standards s JOIN standard_items i ON i.id = s.item_id JOIN standard_frameworks f ON f.id = i.framework_id
      WHERE s.tenant_id = $1 AND s.course_id = $2`,
    [tenantId, courseId],
  );
  return new Map(rows.map((r) => [String(r.standard_id), { id: String(r.id), title: String(r.title), version: String(r.version ?? ""), ownerKind: r.owner_kind as OwnerKind, notice: (r.notice as string) ?? null }]));
}

/** A course's live standards for the pickers: code, statement and the framework each came from. */
export async function standardOptions(ctx: Ctx, courseId: string): Promise<{ id: string; name: string; description: string; source?: string }[]> {
  const { listStandards } = await import("./standards");
  const [list, sources] = await Promise.all([listStandards(ctx, courseId), courseStandardSources(ctx.tenantId, courseId)]);
  return list.map((s) => {
    const f = sources.get(s.id);
    return { id: s.id, name: s.code, description: s.description, ...(f && f.ownerKind !== "teacher" ? { source: f.version ? `${f.title} (${f.version})` : f.title } : {}) };
  });
}
