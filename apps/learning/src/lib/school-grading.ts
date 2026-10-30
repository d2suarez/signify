import { getDb, type Queryable } from "./db";
import { bandFor, normalizeScales, readScales, type GradeBand, type SchoolScales, type ScaleProblem } from "./grade-scale";
import {
  normalizeCoursePolicy, normalizePolicies, readPolicies, ruleFor,
  type Applied, type CoursePolicy, type LatePolicies, type WorkKind,
} from "./late-policy";

/**
 * A school's grade scales and late policies (school admins change them), and
 * what one course gets from them: its band's scale and the late policy for
 * each assignment.
 *
 * School settings are saved like lessons: each save names the version it
 * started from (a stale save is refused, never written over) and the
 * previous value is copied into school_setting_versions first. Restoring an
 * old version is a new save.
 */

type Ctx = { tenantId: string; userId: string };
const UUID = /^[0-9a-f-]{36}$/i;
export type SettingKey = "scales" | "late";
/** Where the school's grading periods, scales and late policies live. Teachers' and students' courses use "America/New_York" for now. */
export const SCHOOL_TZ = "America/New_York";

export type Setting<T> = { value: T; version: number; updatedBy: string | null; updatedAt: string | null };
export type SettingVersion<T> = { id: string; version: number; value: T; changedBy: string; changedAt: string };

const read = { scales: readScales, late: readPolicies } as const;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));

async function getSetting<K extends SettingKey>(tenantId: string, key: K, q?: Queryable): Promise<Setting<ReturnType<typeof read[K]>>> {
  const db = q ?? await getDb();
  const [r] = await db.query("SELECT * FROM school_settings WHERE tenant_id = $1 AND key = $2", [tenantId, key]);
  return {
    value: read[key](r?.value) as ReturnType<typeof read[K]>,
    version: r ? Number(r.version) : 0,
    updatedBy: r ? String(r.updated_by) : null,
    updatedAt: r ? iso(r.updated_at) : null,
  };
}

export const schoolScales = (tenantId: string, q?: Queryable) => getSetting(tenantId, "scales", q);
export const schoolLate = (tenantId: string, q?: Queryable) => getSetting(tenantId, "late", q);

export type SaveResult<T> = { ok: true; setting: Setting<T> } | { ok: false; reason: "stale"; current: Setting<T> } | { ok: false; reason: "bad"; problem: ScaleProblem; band?: number };

async function saveSetting<T>(ctx: Ctx, key: SettingKey, value: T, baseVersion: unknown): Promise<SaveResult<T>> {
  const db = await getDb();
  return db.tx(async (t) => {
    const [cur] = await t.query("SELECT * FROM school_settings WHERE tenant_id = $1 AND key = $2 FOR UPDATE", [ctx.tenantId, key]);
    const version = cur ? Number(cur.version) : 0;
    if (Number(baseVersion) !== version) {
      return { ok: false, reason: "stale", current: await getSetting(ctx.tenantId, key, t) as Setting<T> } as const;
    }
    if (cur) {
      await t.query(
        "INSERT INTO school_setting_versions (tenant_id, key, version, value, changed_by, changed_at) VALUES ($1, $2, $3, $4::jsonb, $5, $6)",
        [ctx.tenantId, key, version, typeof cur.value === "string" ? cur.value : JSON.stringify(cur.value), cur.updated_by, cur.updated_at]);
    }
    await t.query(
      `INSERT INTO school_settings (tenant_id, key, value, version, updated_by) VALUES ($1, $2, $3::jsonb, $4, $5)
       ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, version = EXCLUDED.version,
         updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [ctx.tenantId, key, JSON.stringify(value), version + 1, ctx.userId]);
    return { ok: true, setting: await getSetting(ctx.tenantId, key, t) as Setting<T> } as const;
  });
}

export async function saveScales(ctx: Ctx, input: unknown, baseVersion: unknown): Promise<SaveResult<SchoolScales>> {
  const r = normalizeScales(input);
  if (!r.ok) return { ok: false, reason: "bad", problem: r.problem, band: r.band };
  return saveSetting(ctx, "scales", r.scales, baseVersion);
}

export async function saveLate(ctx: Ctx, input: unknown, baseVersion: unknown): Promise<SaveResult<LatePolicies>> {
  return saveSetting(ctx, "late", normalizePolicies(input), baseVersion);
}

/** Earlier versions, newest first (the current one is not in this list). */
export async function settingHistory<K extends SettingKey>(tenantId: string, key: K, limit = 30): Promise<SettingVersion<ReturnType<typeof read[K]>>[]> {
  const db = await getDb();
  const rows = await db.query(
    "SELECT * FROM school_setting_versions WHERE tenant_id = $1 AND key = $2 ORDER BY id DESC LIMIT $3", [tenantId, key, limit]);
  return rows.map((r) => ({
    id: String(r.id), version: Number(r.version), value: read[key](r.value) as ReturnType<typeof read[K]>,
    changedBy: String(r.changed_by), changedAt: iso(r.changed_at) as string,
  }));
}

/** Puts an old version back, as a new save (so it can be undone too). */
export async function restoreSetting(ctx: Ctx, key: SettingKey, versionId: string, baseVersion: unknown): Promise<boolean> {
  if (!/^\d+$/.test(versionId)) return false;
  const db = await getDb();
  const [r] = await db.query("SELECT value FROM school_setting_versions WHERE tenant_id = $1 AND key = $2 AND id = $3", [ctx.tenantId, key, versionId]);
  if (!r) return false;
  const res = key === "scales" ? await saveScales(ctx, read.scales(r.value), baseVersion) : await saveLate(ctx, read.late(r.value), baseVersion);
  return res.ok;
}

// ---------- one course ----------

export type CourseSetup = {
  scales: SchoolScales;
  band: GradeBand;
  bandFrom: "teacher" | "grades" | "first";
  gradeLevels: string[];
  pickedBand: string | null;
  late: LatePolicies;
  coursePolicy: CoursePolicy | null;
  /** The late policy for an assignment of this course. */
  ruleFor(work: { category: string | null; kind: WorkKind }): Applied | null;
};

function json<T>(v: unknown): T | null {
  if (v === null || v === undefined) return null;
  return (typeof v === "string" ? JSON.parse(v) : v) as T;
}

export async function courseSetup(ctx: Ctx, courseId: string, q?: Queryable): Promise<CourseSetup> {
  const db = q ?? await getDb();
  const [[r], scales, late] = await Promise.all([
    UUID.test(courseId)
      ? db.query("SELECT grade_levels, grade_band, late_policy FROM courses WHERE tenant_id = $1 AND id = $2", [ctx.tenantId, courseId])
      : Promise.resolve([] as Record<string, unknown>[]),
    schoolScales(ctx.tenantId, q),
    schoolLate(ctx.tenantId, q),
  ]);
  const gradeLevels = (json<unknown[]>(r?.grade_levels) ?? []).map(String);
  const pickedBand = r?.grade_band ? String(r.grade_band) : null;
  const { band, from } = bandFor(scales.value, { gradeBand: pickedBand, gradeLevels });
  const own = json<Record<string, unknown>>(r?.late_policy);
  const checked = own ? normalizeCoursePolicy(own, { ...late.value, teachers: "yes" }) : null;
  const coursePolicy = checked && checked.ok ? checked.policy : null;
  return {
    scales: scales.value, band, bandFrom: from, gradeLevels, pickedBand, late: late.value, coursePolicy,
    ruleFor: (work) => ruleFor(late.value, coursePolicy, { band: band.id, ...work }),
  };
}

/** The teacher's band pick (null = from the class's grade levels). Only a band the school has. */
export async function setCourseBand(ctx: Ctx, courseId: string, bandId: unknown): Promise<boolean> {
  const scales = (await schoolScales(ctx.tenantId)).value;
  const id = typeof bandId === "string" && scales.bands.some((b) => b.id === bandId) ? bandId : null;
  if (bandId && !id) return false;
  const db = await getDb();
  await db.query("UPDATE courses SET grade_band = $3 WHERE tenant_id = $1 AND id = $2", [ctx.tenantId, courseId, id]);
  return true;
}

/** The teacher's own late policy, when the school allows it. */
export async function setCoursePolicy(ctx: Ctx, courseId: string, input: unknown): Promise<{ ok: true } | { ok: false; reason: "notAllowed" | "outsideLimits" }> {
  const late = (await schoolLate(ctx.tenantId)).value;
  const r = normalizeCoursePolicy(input, late);
  if (!r.ok) return r;
  const db = await getDb();
  await db.query("UPDATE courses SET late_policy = $3::jsonb WHERE tenant_id = $1 AND id = $2",
    [ctx.tenantId, courseId, r.policy ? JSON.stringify(r.policy) : null]);
  return { ok: true };
}
