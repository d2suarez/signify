import { readMe } from "@/lib/auth";
import { assignmentAccess, courseAccess, ctx, isSchoolAdmin } from "@/lib/access";
import { fileBytes } from "@/lib/files";
import { canOpenWork, getWorkFile } from "@/lib/work-files";

export const dynamic = "force-dynamic";

/**
 * A file a student handed in (story 01 A7), for its student (or group),
 * the class's teachers and the school's admins only (work-files.ts
 * canOpenWork, live roles). Anyone else gets the same 404 as a file that
 * doesn't exist. Pictures and PDFs open in the page (`?download=1` saves);
 * Office files always download. Never cached by anything shared.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await readMe();
  const missing = () => new Response("Not found.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" } });
  if (!me) return missing();
  const file = await getWorkFile(me.tenantId, id);
  if (!file) return missing();
  const ok = await canOpenWork(ctx(me), file, {
    admin: isSchoolAdmin(me),
    roleIn: async (courseId) => (await courseAccess(courseId))?.course.role ?? null,
    assignment: async (aid) => (await assignmentAccess(aid))?.assignment ?? null,
  });
  if (!ok) return missing();
  const bytes = await fileBytes(file);
  if (!bytes) return new Response("That file can't be reached right now.", { status: 503 });
  const download = new URL(req.url).searchParams.has("download") || file.kind === "doc";
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": file.contentType,
      "content-disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "content-length": String(bytes.length),
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": file.kind === "pdf"
        ? "frame-ancestors 'self'"
        : "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox",
      "cache-control": "private, no-store",
    },
  });
}
