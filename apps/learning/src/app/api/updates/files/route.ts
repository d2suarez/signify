import { NextResponse } from "next/server";
import { updatesViewer } from "@/lib/access";
import { saveFile, FileError, MAX_FILE } from "@/lib/files";
import { readCapped } from "@/lib/read-capped";

export const dynamic = "force-dynamic";

/**
 * A picture or file for an update, from the update editor. `?course=<id>`:
 * a class the person teaches (the file belongs to it); without one, a
 * whole-school file, only for someone who may post to the whole school.
 * Students can't upload. The body is the file, `x-file-name` its name.
 * Answers { file } or { error: off | empty | too-large | type | teachers }.
 */
export async function POST(req: Request) {
  const v = await updatesViewer();
  if (!v) return NextResponse.json({ error: "teachers" }, { status: 401 });
  const course = new URL(req.url).searchParams.get("course") || "";
  const courseId = course && v.courses.get(course) === "teacher" ? course : null;
  if (!courseId && !(v.kind === "staff" && v.canPostSchool)) return NextResponse.json({ error: "teachers" }, { status: 403 });
  const body = await readCapped(req, MAX_FILE);
  if (body === "too-large") return NextResponse.json({ error: "too-large" }, { status: 413 });
  let name = "";
  try { name = decodeURIComponent(req.headers.get("x-file-name") || ""); } catch { name = ""; }
  try {
    const file = await saveFile({ tenantId: v.tenantId, userId: v.userId, role: "teacher" }, courseId, name, body);
    return NextResponse.json({ file }, { status: 201 });
  } catch (e) {
    if (e instanceof FileError) return NextResponse.json({ error: e.code }, { status: e.code === "off" ? 503 : 415 });
    throw e;
  }
}
