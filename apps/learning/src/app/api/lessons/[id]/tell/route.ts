import { NextResponse } from "next/server";
import { lang, lessonAccess, updatesViewer } from "@/lib/access";
import { tellClass } from "@/lib/organize";
import { UpdateError } from "@/lib/updates";
import { dict } from "@/lib/i18n";

export const dynamic = "force-dynamic";

/**
 * "Tell the class what changed" (story 01, E2). Body: { note }. Posts the
 * note to the class's Updates as this teacher, linking the lesson. Only for
 * a lesson students can already open.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await lessonAccess(id);
  if (!access) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (access.course.role !== "teacher") return NextResponse.json({ error: "Only the course's teachers can." }, { status: 403 });
  let note: unknown = "";
  try { note = (await req.json())?.note; } catch { /* an empty note: just the link */ }
  const viewer = await updatesViewer();
  if (!viewer) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const d = dict(await lang());
  try {
    const post = await tellClass(viewer, access.course.id, access.lesson.id, note, `${d.tellTitle}: ${access.lesson.title}`);
    if (!post) return NextResponse.json({ error: "hidden" }, { status: 409 });
    return NextResponse.json({ post });
  } catch (e) {
    if (e instanceof UpdateError) return NextResponse.json({ error: e.message }, { status: 403 });
    throw e;
  }
}
