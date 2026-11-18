"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { courseAccess, ctx } from "@/lib/access";
import { setKind, addEvent, archiveEvent, EventError } from "@/lib/clubs";

/** Only a teacher (sponsor) of the class or club now, live from Signify ID. */
async function sponsor(courseId: unknown) {
  const access = await courseAccess(String(courseId || ""));
  return access && access.course.role === "teacher" ? access : null;
}

export async function switchKind(f: FormData) {
  const access = await sponsor(f.get("courseId"));
  if (!access) return;
  await setKind(ctx(access.me), access.course.id, f.get("kind") === "club" ? "club" : "class");
  revalidatePath(`/courses/${access.course.id}`);
}

export async function eventAction(f: FormData) {
  const access = await sponsor(f.get("courseId"));
  if (!access) return;
  const c = ctx(access.me), id = access.course.id;
  if (f.get("op") === "archive") await archiveEvent(c, id, String(f.get("eventId") || ""));
  else {
    try {
      await addEvent(c, id, { title: f.get("title"), onDay: f.get("onDay"), startTime: f.get("startTime"), place: f.get("place"), notes: f.get("notes") });
    } catch (e) {
      if (e instanceof EventError) redirect(`/courses/${id}?eventError=${e.message}`);
      throw e;
    }
  }
  revalidatePath(`/courses/${id}`);
}
