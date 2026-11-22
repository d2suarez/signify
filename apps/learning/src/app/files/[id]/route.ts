import { readMe } from "@/lib/auth";
import { courseAccess, updatesViewer } from "@/lib/access";
import { getFile, canOpen, fileBytes } from "@/lib/files";

export const dynamic = "force-dynamic";

/**
 * One uploaded file, for whoever may open it now (files.ts canOpen, from live
 * Signify ID classes). Pictures, PDFs, sound and video open in the page
 * (`?download=1` saves instead); documents always download. The content
 * type is the one checked at upload; nosniff stops a browser guessing
 * another. Ranges are answered so video can seek (Safari needs them).
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await readMe();
  const missing = () => new Response("Not found.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" } });
  if (!me) return missing();
  const file = await getFile(me.tenantId, id);
  if (!file) return missing();
  // Updates: a reader of a visible post showing it may open it too (a parent included).
  const v = await updatesViewer();
  const ok = await canOpen(me.tenantId, file, async (courseId) => (await courseAccess(courseId))?.course.role ?? null,
    v ? { userId: v.userId, reads: (c) => c === null || v.courses.has(c) || v.childCourses.has(c) } : undefined);
  if (!ok) return missing();
  const bytes = await fileBytes(file);
  if (!bytes) return new Response("That file can't be reached right now.", { status: 503 });

  const download = new URL(req.url).searchParams.has("download") || file.kind === "doc";
  const headers: Record<string, string> = {
    "content-type": file.contentType,
    "content-disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    // Framed only by our own pages. A PDF needs the browser's viewer, which a
    // stricter policy breaks; everything else is a sandboxed document that can
    // run nothing and load nothing but itself.
    "content-security-policy": file.kind === "pdf"
      ? "frame-ancestors 'self'"
      : "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox",
    "cache-control": "private, max-age=3600",
    "accept-ranges": "bytes",
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") || "");
  if (range && (range[1] || range[2])) {
    const size = bytes.length;
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start); end = Math.min(size - 1, end);
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    return new Response(new Uint8Array(bytes.subarray(start, end + 1)), {
      status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) },
    });
  }
  return new Response(new Uint8Array(bytes), { headers: { ...headers, "content-length": String(bytes.length) } });
}
