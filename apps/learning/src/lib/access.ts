import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { readMe, myClasses, myChildren, token, type Me } from "./auth";
import { studentCourses } from "./family";
import { hasFeature } from "./features";
import { isSchoolAdminRole } from "./roles";
import type { Viewer as UpdatesViewer } from "./updates";
import { membersOf } from "./roster";
import { getAssignment, type Assignment } from "./assignments";
import { toStudents, type Student } from "./gradebook";
import { courseFor, myCourses, type Course, type CourseRole } from "./courses";
import { audiencesOf, type Viewer } from "./standards-library";
import { getLesson, type Lesson } from "./lessons";
import { pickLang, type Lang } from "./i18n";
import { DEFAULT_PREFS, type Prefs } from "./prefs";
import { getPrefs } from "./prefs-store";

/**
 * The questions every page and route asks: who is this, may they open this
 * course or lesson, and as what. Answers come from the live Signify ID
 * classes each time (cached for a minute in roster.ts).
 */

export type CourseAccess = { me: Me; course: Course & { role: CourseRole } };
export type LessonAccess = CourseAccess & { lesson: Lesson };

export async function courseAccess(courseId: string): Promise<CourseAccess | null> {
  const me = await readMe();
  if (!me) return null;
  const { classes } = await myClasses();
  const course = await courseFor(me.tenantId, courseId, classes);
  return course ? { me, course } : null;
}

export async function lessonAccess(lessonId: string): Promise<LessonAccess | null> {
  const me = await readMe();
  if (!me) return null;
  const lesson = await getLesson({ tenantId: me.tenantId, userId: me.id }, lessonId);
  if (!lesson) return null;
  const access = await courseAccess(lesson.courseId);
  return access ? { ...access, lesson } : null;
}

export type AssignmentAccess = CourseAccess & { assignment: Assignment };

/**
 * A student may open an assignment only once it is published; a teacher
 * always may.
 */
export async function assignmentAccess(assignmentId: string): Promise<AssignmentAccess | null> {
  const me = await readMe();
  if (!me) return null;
  const assignment = await getAssignment(ctx(me), assignmentId);
  if (!assignment) return null;
  const access = await courseAccess(assignment.courseId);
  if (!access) return null;
  if (access.course.role === "student" && !assignment.published) return null;
  return { ...access, assignment };
}

/**
 * The course's students, live from Signify ID, in FACTS order. ok is false
 * when ID couldn't be asked: callers must say so, never show an empty class.
 */
export async function studentsOf(access: CourseAccess): Promise<{ ok: boolean; students: Student[] }> {
  const { me, course } = access;
  const { ok, members } = await membersOf({ id: me.id, role: me.role, dev: me.dev }, await token(), course.idClassId);
  return { ok, students: toStudents(members) };
}

/** Sets the school's grading periods: its admins. */
export function isSchoolAdmin(me: Me): boolean {
  return isSchoolAdminRole(me.role);
}

/**
 * Who is using the standards library: the courses they teach now (from
 * Signify ID) and whether they run the school. Null for anyone who neither
 * teaches nor administers: students and parents don't browse the library.
 */
export async function standardsViewer(me: Me): Promise<Viewer | null> {
  const { classes } = await myClasses();
  const teaches = (await myCourses(me.tenantId, classes, me.id)).filter((c) => c.role === "teacher").map((c) => c.id);
  const admin = isSchoolAdmin(me);
  return teaches.length || admin ? { ...ctx(me), admin, teaches } : null;
}

/** `audiences`: what the school belongs to ('NAD'), for the standards library's NAD-only sets. */
export function ctx(me: Me) {
  return { tenantId: me.tenantId, userId: me.id, audiences: audiencesOf(me.tenantAffiliations) };
}

export async function lang(): Promise<Lang> {
  const [h, c] = await Promise.all([headers(), cookies()]);
  return pickLang(h.get("accept-language"), c.get("sl_lang")?.value);
}

/**
 * The signed-in person's reading supports, once per request (the layout and
 * the top bar both ask). A database hiccup gives the defaults rather than
 * breaking every page.
 */
export const myPrefs = cache(async (): Promise<Prefs> => {
  const me = await readMe();
  if (!me) return DEFAULT_PREFS;
  try { return await getPrefs(ctx(me)); } catch { return DEFAULT_PREFS; }
});

/** Roles that never post to the whole school, whatever Tools by role says (ID gives guardians every feature by default). */
const NOT_STAFF = new Set(["student", "guardian", "substitute"]);

/**
 * Who is reading or writing Updates, from live Signify ID this request: the
 * classes and clubs they are in, a parent's children's classes, and whether
 * the school lets their role post to everyone. Built once per request.
 */
export const updatesViewer = cache(async (): Promise<UpdatesViewer | null> => {
  const me = await readMe();
  if (!me) return null;
  const [{ classes }, family] = await Promise.all([myClasses(), myChildren()]);
  const mine = await myCourses(me.tenantId, classes, me.id);
  const childCourses = new Set<string>();
  for (const child of family.children) for (const c of await studentCourses(me.tenantId, child.classes)) childCourses.add(c.id);
  const role = me.role || "";
  const teaches = mine.some((c) => c.role === "teacher");
  const staff = !!role && !NOT_STAFF.has(role);
  const kind: UpdatesViewer["kind"] = staff || teaches ? "staff" : mine.length > 0 ? "student" : childCourses.size > 0 || role === "guardian" ? "parent" : "student";
  return {
    tenantId: me.tenantId, userId: me.id, name: me.name, kind,
    schoolAdmin: isSchoolAdmin(me),
    canPostSchool: kind === "staff" && staff && (await hasFeature("post_school_updates", { tenantId: me.tenantId, role: me.role, dev: me.dev })),
    courses: new Map(mine.map((c) => [c.id, c.role])),
    childCourses,
  };
});

/**
 * courseAccess for the academic parts (gradebook, grading settings, FACTS,
 * import, accommodations): null for a club, which has none.
 */
export async function academicAccess(courseId: string): Promise<CourseAccess | null> {
  const access = await courseAccess(courseId);
  return access && access.course.kind !== "club" ? access : null;
}
