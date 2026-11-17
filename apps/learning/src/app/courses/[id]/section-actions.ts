"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { courseAccess, ctx, isSchoolAdmin } from "@/lib/access";
import { requireMe } from "@/lib/auth";
import {
  moveSection, copyContent, requestShare, answerShare, renameCatalog, CopyError, type CopyResult,
} from "@/lib/sections";

/** Only a teacher of the class now (live from Signify ID) changes it. */
async function teaching(courseId: unknown) {
  const access = await courseAccess(String(courseId || ""));
  return access && access.course.role === "teacher" ? access : null;
}

export async function moveToCourse(formData: FormData) {
  const access = await teaching(formData.get("courseId"));
  if (!access) return;
  const target = String(formData.get("catalogId") || "");
  await moveSection(ctx(access.me), access.course.id, target === "new" ? "new" : target);
  revalidatePath(`/courses/${access.course.id}`);
  const back = String(formData.get("back") || "");
  if (back.startsWith("/catalog/") || back.startsWith("/courses/")) redirect(back);
}

export type CopyState = { ok: true; result: CopyResult } | { ok: false; error: "nothing" | "forbidden" | "bad" } | null;

export async function copyInto(_prev: CopyState, formData: FormData): Promise<CopyState> {
  const access = await teaching(formData.get("courseId"));
  if (!access) return { ok: false, error: "forbidden" };
  try {
    const result = await copyContent(ctx(access.me), String(formData.get("from") || ""), access.course.id, {
      units: formData.getAll("unit"), lessons: formData.getAll("lesson"), assignments: formData.getAll("assignment"),
    });
    revalidatePath(`/courses/${access.course.id}`);
    return { ok: true, result };
  } catch (e) {
    if (e instanceof CopyError) return { ok: false, error: e.message === "nothing" ? "nothing" : e.message === "bad" ? "bad" : "forbidden" };
    throw e;
  }
}

export async function askToShare(formData: FormData) {
  const me = await requireMe();
  const courseId = String(formData.get("courseId") || "");
  const access = courseId ? await teaching(courseId) : null;
  await requestShare({ ...ctx(me), name: me.name }, String(formData.get("source") || ""), {
    forCourseId: access ? access.course.id : null, message: formData.get("message"),
  });
  if (access) redirect(`/courses/${access.course.id}/copy?asked=1`);
  revalidatePath("/catalog");
}

export async function answerRequest(formData: FormData) {
  const me = await requireMe();
  const op = String(formData.get("op") || "");
  if (op !== "approve" && op !== "decline" && op !== "revoke" && op !== "withdraw") return;
  await answerShare({ ...ctx(me), admin: isSchoolAdmin(me) }, String(formData.get("requestId") || ""), op);
  const back = String(formData.get("back") || "/catalog");
  revalidatePath(back.startsWith("/") ? back : "/catalog");
}

export async function renameCourse(formData: FormData) {
  const me = await requireMe();
  const id = String(formData.get("catalogId") || "");
  await renameCatalog({ ...ctx(me), admin: isSchoolAdmin(me) }, id, formData.get("name"));
  revalidatePath(`/catalog/${id}`);
}
