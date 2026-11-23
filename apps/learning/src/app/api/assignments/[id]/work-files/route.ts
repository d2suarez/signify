import { NextResponse } from "next/server";
import { assignmentAccess, ctx } from "@/lib/access";
import { MAX_FILE } from "@/lib/files";
import { readCapped } from "@/lib/read-capped";
import { addWorkFile, myFiles, removeWorkFile, reorderWorkFiles, takesFiles, WorkFileError } from "@/lib/work-files";

export const dynamic = "force-dynamic";

/**
 * A student's files on an assignment that takes files (story 01 A7). The
 * student is whoever is signed in: there is no student id to change. In a
 * group's "one hands in" mode the list is the group's.
 *   GET    → { files, locked, on }
 *   POST   body = the file, `x-file-name` its name (URI-encoded) → { file }
 *   PUT    { order: [ids] } → { files }
 *   DELETE ?file=<id> → { files }
 * Errors: { error: off | empty | too-large | type | handed-in | too-many }.
 */
async function student(id: string) {
  const access = await assignmentAccess(id);
  if (!access || access.course.role !== "student" || !takesFiles(access.assignment)) return null;
  return access;
}

const missing = () => NextResponse.json({ error: "Not found." }, { status: 404 });

function refused(e: unknown) {
  if (!(e instanceof WorkFileError)) throw e;
  if (e.code === "missing") return missing();
  const status = e.code === "off" ? 503 : e.code === "too-large" ? 413 : e.code === "type" ? 415 : 409;
  return NextResponse.json({ error: e.code }, { status });
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await student((await params).id);
  if (!access) return missing();
  return NextResponse.json(await myFiles(ctx(access.me), access.assignment), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await student((await params).id);
  if (!access) return missing();
  const body = await readCapped(req, MAX_FILE);
  if (body === "too-large") return NextResponse.json({ error: "too-large" }, { status: 413 });
  let name = "";
  try { name = decodeURIComponent(req.headers.get("x-file-name") || ""); } catch { name = ""; }
  try {
    return NextResponse.json({ file: await addWorkFile(ctx(access.me), access.assignment, name, body) }, { status: 201 });
  } catch (e) { return refused(e); }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await student((await params).id);
  if (!access) return missing();
  let body: { order?: unknown } = {};
  try { const t = await req.text(); body = t.length < 20_000 ? JSON.parse(t) : {}; } catch { body = {}; }
  try {
    return NextResponse.json({ files: await reorderWorkFiles(ctx(access.me), access.assignment, body.order) });
  } catch (e) { return refused(e); }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await student((await params).id);
  if (!access) return missing();
  try {
    return NextResponse.json({ files: await removeWorkFile(ctx(access.me), access.assignment, new URL(req.url).searchParams.get("file") || "") });
  } catch (e) { return refused(e); }
}
