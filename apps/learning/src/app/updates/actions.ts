"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { updatesViewer } from "@/lib/access";
import { createPost, createPosts, editPost, addComment, moderatePost, moderateComment, setCourseRules, markRead, UpdateError, type ModOp } from "@/lib/updates";

const back = (f: FormData, fallback: string) => {
  const b = String(f.get("back") || "");
  return b.startsWith("/") && !b.startsWith("//") ? b : fallback;
};
const op = (f: FormData): ModOp | null => {
  const o = String(f.get("op") || "");
  return o === "hide" || o === "unhide" || o === "delete" ? o : null;
};
const withError = (path: string, code: string) => `${path}${path.includes("?") ? "&" : "?"}updateError=${code}`;

export async function postUpdate(f: FormData) {
  const v = await updatesViewer();
  if (!v) return;
  const to = back(f, "/updates");
  try {
    await createPost(v, { courseId: f.get("courseId"), title: f.get("title"), body: f.get("body") });
  } catch (e) {
    if (e instanceof UpdateError) redirect(withError(to, e.code));
    throw e;
  }
  revalidatePath(to.split("?")[0]);
  redirect(to.split("?")[0]);
}

/**
 * The rich editor's post (PostComposer): several places at once, a
 * document instead of plain text. Answers instead of redirecting, so the
 * editor can clear itself or show what went wrong.
 */
export async function postRichUpdate(f: FormData): Promise<{ ok: true; count: number } | { error: string }> {
  const v = await updatesViewer();
  if (!v) return { error: "forbidden" };
  try {
    const made = await createPosts(v, { to: f.getAll("to"), title: f.get("title"), doc: f.get("doc") });
    revalidatePath(back(f, "/").split("?")[0]);
    return { ok: true, count: made.length };
  } catch (e) {
    if (e instanceof UpdateError) return { error: e.code };
    throw e;
  }
}

/** The author's change to an update (every place it went). */
export async function editRichUpdate(f: FormData): Promise<{ ok: true; count: number } | { error: string }> {
  const v = await updatesViewer();
  if (!v) return { error: "forbidden" };
  const postId = String(f.get("postId") || "");
  try {
    const p = await editPost(v, postId, { title: f.get("title"), doc: f.get("doc") });
    revalidatePath(`/updates/${postId}`);
    revalidatePath(back(f, "/").split("?")[0]);
    return { ok: true, count: p.places.length };
  } catch (e) {
    if (e instanceof UpdateError) return { error: e.code };
    throw e;
  }
}

export async function commentOn(f: FormData) {
  const v = await updatesViewer();
  if (!v) return;
  const postId = String(f.get("postId") || "");
  try {
    await addComment(v, postId, f.get("body"));
  } catch (e) {
    if (e instanceof UpdateError) redirect(withError(`/updates/${postId}`, e.code));
    throw e;
  }
  revalidatePath(`/updates/${postId}`);
}

export async function moderate(f: FormData) {
  const v = await updatesViewer();
  const o = op(f);
  if (!v || !o) return;
  const commentId = String(f.get("commentId") || "");
  if (commentId) await moderateComment(v, commentId, o);
  else await moderatePost(v, String(f.get("postId") || ""), o);
  const to = back(f, "/updates");
  revalidatePath(to);
  if (o === "delete" && !commentId && to.startsWith("/updates/")) redirect("/updates");
}

export async function courseRulesAction(f: FormData) {
  const v = await updatesViewer();
  if (!v) return;
  const courseId = String(f.get("courseId") || "");
  await setCourseRules(v, courseId, { studentPosts: f.get("studentPosts") === "on", studentComments: f.get("studentComments") === "on" });
  revalidatePath(`/courses/${courseId}`);
}

export async function markAllRead(f: FormData) {
  const v = await updatesViewer();
  if (!v) return;
  await markRead(v, f.getAll("postId").map(String));
  revalidatePath(back(f, "/updates"));
}
