/**
 * Who is in which class comes from Signify ID, asked live with the person's
 * own token, so its rules decide what they may see. Cached for a minute;
 * a failed lookup is never cached and is reported as a failure, never as
 * "no classes" (that is how the desk once looked like it had lost a
 * teacher's data).
 */

export type IdClass = {
  id: string;
  name: string;
  subject?: string | null;
  role?: string | null;
  covering?: boolean;
  /** Signify ID year groups the class covers ("9", "10", …); decides its grade scale band. */
  grade_levels?: string[] | null;
};

/** `email` comes only to the class's staff (grade passback matches it to the platform's class list). */
export type IdMember = {
  id: string; display_name: string; role: string; picture_url?: string | null; email?: string | null;
  /** Staff only: the school's official name (FACTS), or null where it has none. Older ID versions leave it out. */
  official_name?: OfficialName | null;
};
export type OfficialName = { given: string; middle?: string; family: string; suffix?: string };

const ISSUER = (process.env.SIGNIFY_ISSUER || "").replace(/\/+$/, "");
const CACHE_MS = 60_000;

type Cache = Map<string, { at: number; value: unknown }>;
const cache: Cache = ((globalThis as unknown as { __learningRoster?: Cache }).__learningRoster ??= new Map());

/** Local development: made-up classes, chosen by the made-up person's role. */
export const DEV_CLASSES: Record<string, IdClass[]> = {
  teacher: [
    { id: "dev-class-apmicro", name: "AP Microeconomics", subject: "Economics", role: "teacher" },
    { id: "dev-class-rel09", name: "09 Religion", subject: "Bible", role: "teacher" },
    { id: "dev-class-practice", name: "Practice — Demo class", subject: "Practice", role: "teacher" },
  ],
  student: [
    { id: "dev-class-apmicro", name: "AP Microeconomics", subject: "Economics", role: "student" },
    { id: "dev-class-practice", name: "Practice — Demo class", subject: "Practice", role: "student" },
  ],
};

export const DEV_MEMBERS: IdMember[] = [
  { id: "dev-teacher-0000", display_name: "Dev Teacher", role: "teacher" },
  { id: "dev-student-0000", display_name: "Dev Student", role: "student" },
  { id: "dev-student-0001", display_name: "Sample Student A", role: "student", official_name: { given: "Samantha", middle: "Ann", family: "de la Cruz" } },
  { id: "dev-student-0002", display_name: "Sample Student B", role: "student" },
];

async function ask<T>(token: string, pathname: string): Promise<T | null> {
  if (!ISSUER || !token) return null;
  try {
    const res = await fetch(`${ISSUER}${pathname}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.warn(`learning: ${pathname} refused (${res.status}) ${detail.slice(0, 200)}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (e) {
    console.warn(`learning: ${pathname} failed: ${(e as Error).message}`);
    return null;
  }
}

async function cached<T>(key: string, produce: () => Promise<T | null>): Promise<T | null> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
  const value = await produce();
  if (value != null) cache.set(key, { at: Date.now(), value });
  return value;
}

export type Who = { id: string; role?: string | null; dev?: boolean };

export async function classesFor(who: Who, token: string): Promise<{ ok: boolean; classes: IdClass[] }> {
  if (who.dev) return { ok: true, classes: who.role === "guardian" ? [] : DEV_CLASSES[who.role === "student" ? "student" : "teacher"] };
  const body = await cached(`classes:${who.id}`, () => ask<{ classes: IdClass[] }>(token, "/api/v1/classes"));
  return body ? { ok: true, classes: body.classes || [] } : { ok: false, classes: [] };
}

export async function membersOf(who: Who, token: string, classId: string): Promise<{ ok: boolean; members: IdMember[] }> {
  if (who.dev) return { ok: true, members: DEV_MEMBERS };
  const body = await cached(`members:${who.id}:${classId}`,
    () => ask<{ members: IdMember[] }>(token, `/api/v1/classes/${encodeURIComponent(classId)}/members`));
  return body ? { ok: true, members: body.members || [] } : { ok: false, members: [] };
}

/** A parent's child, as Signify ID tells it: only links the school verified. */
export type IdChild = {
  id: string;
  display_name: string;
  relationship: string;
  picture_url?: string | null;
  classes: IdClass[];
};

/** Local development: the made-up parent's child is the made-up student. */
export const DEV_CHILDREN: IdChild[] = [
  { id: "dev-student-0000", display_name: "Dev Student", relationship: "parent", classes: DEV_CLASSES.student },
];

/**
 * The signed-in person's children at their school, from Signify ID with their
 * own token. ID counts only links the school has verified; this never asks
 * about anyone else, and nothing it returns is stored.
 */
export async function childrenFor(who: Who, token: string): Promise<{ ok: boolean; children: IdChild[] }> {
  if (who.dev) return { ok: true, children: who.role === "guardian" ? DEV_CHILDREN : [] };
  const body = await cached(`children:${who.id}`, () => ask<{ children: IdChild[] }>(token, "/api/v1/my-children"));
  if (!body) return { ok: false, children: [] };
  const children = (body.children || []).map((c) => ({
    ...c, classes: (c.classes || []).map((k) => ({ ...k, role: "student" })),
  }));
  return { ok: true, children };
}
