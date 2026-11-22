import "server-only";
import { myClasses, myChildren, type Me } from "./auth";
import { ctx, isSchoolAdmin } from "./access";
import { courseFor, myCourses, type MyCourse } from "./courses";
import { getAssignment } from "./assignments";
import { getLesson } from "./lessons";
import { teacherTasks, studentTasks, type StudentTask, type StudentTasks, type TeacherTasks } from "./tasks";
import { studentWork } from "./family";
import { todayIn } from "./planner";
import { SCHOOL_TZ } from "./school-grading";
import { classStudentWidgets, railWidgets, type RailPlace } from "./widget-store";
import type { Audience, WidgetKind } from "./widgets";

/**
 * What the left rail shows on a page: the To do panel (the same lists as the
 * home page always had) and the person's tools for where they are: home, or
 * the class the page belongs to (a class page, or one of its assignments or
 * lessons). Roles come from live Signify ID every time.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Roles that are never staff on their own (they are staff in a class they teach). */
const NOT_STAFF = new Set(["student", "guardian"]);

/** Staff (teachers, admins, office) get every tool; students and parents only what the school lets students have. */
export function audienceOf(me: Me, courses: MyCourse[]): Audience {
  if (courses.some((c) => c.role === "teacher")) return "staff";
  return me.role && !NOT_STAFF.has(me.role) ? "staff" : "student";
}

/** The class a page belongs to, from its path, if the person is in it. */
export async function placeOf(me: Me, path: string): Promise<{ place: RailPlace; courseName: string | null; idClassId: string | null }> {
  const home = { place: { courseId: null } as RailPlace, courseName: null, idClassId: null };
  const m = /^\/(courses|assignments|lessons)\/([0-9a-f-]{36})(?:\/|$)/i.exec(path || "");
  if (!m || !UUID.test(m[2])) return home;
  let courseId = m[2];
  if (m[1] === "assignments") courseId = (await getAssignment(ctx(me), m[2]))?.courseId ?? "";
  if (m[1] === "lessons") courseId = (await getLesson(ctx(me), m[2]))?.courseId ?? "";
  if (!courseId) return home;
  const { classes } = await myClasses();
  const course = await courseFor(me.tenantId, courseId, classes);
  if (!course) return home;
  return { place: { courseId: course.id, role: course.role }, courseName: course.name, idClassId: course.idClassId };
}

export type RailTodo = { teacher: TeacherTasks | null; student: StudentTasks };

/** The home page's To do, for anywhere. */
export async function todoFor(me: Me, courses: MyCourse[]): Promise<RailTodo> {
  const [{ classes }, family] = await Promise.all([myClasses(), myChildren()]);
  const now = new Date();
  const teaching = courses.filter((c) => c.role === "teacher" && c.kind !== "club");
  const ownClasses = classes.filter((k) => k.role === "student");
  const people = [
    ...(ownClasses.length ? [{ id: me.id, name: "", classes: ownClasses }] : []),
    ...family.children.map((k) => ({ id: k.id, name: k.display_name, classes: k.classes })),
  ];
  const [teacher, each] = await Promise.all([
    teaching.length > 0 ? teacherTasks(me, teaching.map((c) => c.id), todayIn(SCHOOL_TZ), now) : Promise.resolve(null),
    Promise.all(people.map(async (p) =>
      studentTasks(await studentWork(ctx(me), p.classes, p.id, now), now, 14, p.name ? { id: p.id, name: p.name } : undefined))),
  ]);
  return {
    teacher,
    student: { overdue: each.flatMap((t) => t.overdue) as StudentTask[], upcoming: each.flatMap((t) => t.upcoming) as StudentTask[] },
  };
}

export type RailData = {
  context: string;
  /** idClassId: the Signify ID class, so Desk opens its tools on this class. */
  course: { id: string; name: string; role: "teacher" | "student"; idClassId: string } | null;
  audience: Audience;
  widgets: WidgetKind[];
  defaults: WidgetKind[];
  addable: WidgetKind[];
  from: "own" | "class" | "school";
  /** A class's teacher, when the school lets them choose: what students here get, and what they may be given. */
  students: { chosen: WidgetKind[] | null; schoolDefault: WidgetKind[]; allowed: WidgetKind[] } | null;
  schoolAdmin: boolean;
  todo?: RailTodo;
};

export async function railFor(me: Me, path: string, withTodo: boolean): Promise<RailData> {
  const { classes } = await myClasses();
  const courses = await myCourses(me.tenantId, classes, me.id);
  const audience = audienceOf(me, courses);
  const { place, courseName, idClassId } = await placeOf(me, path);
  const [r, todo] = await Promise.all([
    railWidgets(ctx(me), audience, place),
    withTodo ? todoFor(me, courses) : Promise.resolve(undefined),
  ]);
  let students: RailData["students"] = null;
  if (place.courseId && place.role === "teacher" && r.school.teachersChoose) {
    const { chosen } = await classStudentWidgets(ctx(me), place.courseId);
    students = { chosen, schoolDefault: r.school.studentClass, allowed: r.school.studentAllowed };
  }
  return {
    context: r.context,
    course: place.courseId ? { id: place.courseId, name: courseName ?? "", role: place.role, idClassId: idClassId ?? "" } : null,
    audience, widgets: r.widgets, defaults: r.defaults, addable: r.addable, from: r.from,
    students, schoolAdmin: isSchoolAdmin(me), todo,
  };
}
