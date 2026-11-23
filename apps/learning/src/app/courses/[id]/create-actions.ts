"use server";

import { revalidatePath } from "next/cache";
import { courseAccess, ctx } from "@/lib/access";
import { moveItemsToUnit } from "@/lib/organize";

/**
 * Puts things just made from the Create menu into the folder they were made
 * from (an outside tool's new assignments arrive after the tool answers, so
 * the browser files them). Teachers of the class only; organize.ts checks
 * the folder and the items are this class's.
 */
export async function fileIntoFolder(courseId: string, unitId: string, keys: string[]): Promise<number> {
  const access = await courseAccess(String(courseId || ""));
  if (!access || access.course.role !== "teacher" || !Array.isArray(keys)) return 0;
  const n = await moveItemsToUnit(ctx(access.me), access.course.id, keys.slice(0, 50).map(String), String(unitId || "") || null);
  revalidatePath(`/courses/${access.course.id}`);
  return n;
}
