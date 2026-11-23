"use server";

import { revalidatePath } from "next/cache";
import { courseAccess } from "@/lib/access";
import { setCoursePicture } from "@/lib/courses";

/**
 * Sets (or with null, takes away) the class picture (migration 043). Only
 * the class's teachers; the file must be a picture uploaded to this class
 * (courses.ts checks). Answers whether it was kept.
 */
export async function setClassPicture(courseId: string, fileId: string | null): Promise<boolean> {
  const access = await courseAccess(String(courseId || ""));
  if (!access || access.course.role !== "teacher") return false;
  const ok = await setCoursePicture(access.me.tenantId, access.course.id, fileId === null ? null : String(fileId));
  if (ok) revalidatePath(`/courses/${access.course.id}`, "layout");
  return ok;
}
