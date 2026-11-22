import { NextResponse } from "next/server";
import { courseAccess, ctx } from "@/lib/access";
import { saveFile, FileError, MAX_FILE } from "@/lib/files";
import { readCapped } from "@/lib/read-capped";

export const dynamic = "force-dynamic";

/**
 * Upload one file to a course (its teachers only). The body is the file;
 * `x-file-name` its name (URI-encoded). Refused as soon as it passes 25 MB.
 * Answers { file } or { error: off | empty | too-large | type | teachers }.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await courseAccess(id);
  if (!access) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (access.course.role !== "teacher") return NextResponse.json({ error: "teachers" }, { status: 403 });
  const body = await readCapped(req, MAX_FILE);
  if (body === "too-large") return NextResponse.json({ error: "too-large" }, { status: 413 });
  let name = "";
  try { name = decodeURIComponent(req.headers.get("x-file-name") || ""); } catch { name = ""; }
  try {
    const file = await saveFile({ ...ctx(access.me), role: "teacher" }, access.course.id, name, body);
    return NextResponse.json({ file }, { status: 201 });
  } catch (e) {
    if (e instanceof FileError) return NextResponse.json({ error: e.code }, { status: e.code === "off" ? 503 : 415 });
    throw e;
  }
}
