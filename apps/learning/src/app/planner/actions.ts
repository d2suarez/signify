"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { courseAccess, ctx } from "@/lib/access";
import { createLesson, saveLesson, getLesson, setLessonStandards } from "@/lib/lessons";
import { getAssignment, saveAssignment } from "@/lib/assignments";
import { blocksFromResources } from "@/lib/resources";
import { presentDay, planMaterial, unplanMaterial, movePlanItem, addDayStandard, removeDayStandard, PlanError } from "@/lib/week-plan";
import { isSchoolDay, parseDay } from "@/lib/planner";

/*
 * The planner's server actions, shared by the Planner (/planner, every class
 * taught) and a class's own Planner tab (/courses/[id]/planner).
 */

/** Both planners show this class: refresh them both. */
function again(courseId: string) {
  revalidatePath("/planner");
  revalidatePath(`/courses/${courseId}/planner`);
}

/** Only our own planner pages to go back to. */
function safeBack(raw: unknown): string {
  const b = String(raw ?? "");
  return /^\/(planner|courses\/[0-9a-f-]{36}\/planner)(\?week=\d{4}-\d{2}-\d{2})?$/.test(b) ? b : "/planner";
}

/** Quick-add: a new lesson already planned for the day it was added on. */
export async function addLesson(formData: FormData) {
  const access = await courseAccess(String(formData.get("courseId") || ""));
  if (!access || access.course.role !== "teacher") return;
  const day = parseDay(formData.get("day"));
  if (!day || !isSchoolDay(day)) return;
  const c = ctx(access.me);
  // "Start from" a class resource: its block(s) copied in, as the editor's "Add from class resources" does.
  const resource = String(formData.get("resource") || "");
  const blocks = resource ? await blocksFromResources({ ...c, role: "teacher" }, access.course.id, [resource]) : [];
  const lesson = await createLesson(c, access.course.id, String(formData.get("title") || ""), blocks);
  await saveLesson(c, lesson.id, { baseVersion: lesson.version, plannedFor: day });
  again(access.course.id);
}

/**
 * Picking materials and standards onto a day (story 01, B1/B2). One action,
 * `op` says which: pick (kind:id), unpick / move (a plan item), std / unstd.
 * Only the course's teachers; the lib scopes every write to the course.
 */
export async function planAction(formData: FormData): Promise<{ error?: string }> {
  const access = await courseAccess(String(formData.get("courseId") || ""));
  if (!access || access.course.role !== "teacher") return { error: "forbidden" };
  const c = ctx(access.me);
  const course = access.course.id;
  const day = formData.get("day");
  try {
    switch (String(formData.get("op"))) {
      case "pick": {
        const [kind, id] = String(formData.get("pick") || "").split(":");
        await planMaterial(c, course, day, kind, id);
        break;
      }
      case "unpick": await unplanMaterial(c, course, formData.get("item")); break;
      case "move": await movePlanItem(c, course, formData.get("item"), day); break;
      case "std": {
        // To the day itself, or straight onto a lesson or assignment of this class.
        const [kind, ref] = String(formData.get("target") || "day").split(":");
        const sid = String(formData.get("standard") || "");
        if (kind === "lesson") {
          const l = await getLesson(c, ref);
          if (!l || l.courseId !== course) return { error: "missing" };
          if (!(await setLessonStandards(c, l.id, [...(l.standards ?? []), sid]))) return { error: "missing" };
        } else if (kind === "assignment") {
          const a = await getAssignment(c, ref);
          if (!a || a.courseId !== course) return { error: "missing" };
          const r = await saveAssignment(c, a.id, { baseVersion: a.version, standards: [...(a.standards ?? []), sid] });
          if (!r.ok) return { error: "missing" };
        } else await addDayStandard(c, course, day, sid);
        break;
      }
      case "unstd": await removeDayStandard(c, course, day, formData.get("standard")); break;
      default: return { error: "missing" };
    }
  } catch (e) {
    if (e instanceof PlanError) return { error: e.code };
    throw e;
  }
  again(access.course.id);
  return {};
}

/**
 * "Present this day" (story 01, B3): the day's lessons and picked materials
 * become one lesson (or the one there was), opened in the live presenter,
 * the same path as Resources' "Present ticked". `again` makes it anew.
 */
export async function presentAction(formData: FormData) {
  const access = await courseAccess(String(formData.get("courseId") || ""));
  if (!access || access.course.role !== "teacher") return;
  const title = String(formData.get("title") || "").trim().slice(0, 200) || "Presentation";
  let id: string | null = null;
  try {
    id = await presentDay(ctx(access.me), access.course.id, formData.get("day"), title, formData.get("again") === "1");
  } catch (e) {
    if (!(e instanceof PlanError)) throw e;
  }
  if (!id) redirect(safeBack(formData.get("back")));
  redirect(formData.get("op") === "edit" ? `/lessons/${id}/edit` : `/lessons/${id}/present`);
}
