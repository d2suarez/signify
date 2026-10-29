import "server-only";
import { cookies, headers } from "next/headers";
import { readMe, myClasses, type Me } from "./auth";
import { courseFor, type Course, type CourseRole } from "./courses";
import { getLesson, type Lesson } from "./lessons";
import { pickLang, type Lang } from "./i18n";

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

export function ctx(me: Me) {
  return { tenantId: me.tenantId, userId: me.id };
}

export async function lang(): Promise<Lang> {
  const [h, c] = await Promise.all([headers(), cookies()]);
  return pickLang(h.get("accept-language"), c.get("sl_lang")?.value);
}
