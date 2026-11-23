import { assignmentAccess, ctx, studentsOf } from "@/lib/access";
import { listSubmissions } from "@/lib/assignments";
import { fileBytes } from "@/lib/files";
import { photosPdf } from "@/lib/photo-pdf";
import { safeFileName } from "@/lib/zip-write";
import { filesForStudents, getWorkFile } from "@/lib/work-files";

export const dynamic = "force-dynamic";

/**
 * Story 01 A7: one student's photos as one PDF, a page per photo in their
 * order (/work-files/photos/<assignment>?student=<id>). The class's teachers only; 404 for anyone else.
 */
export async function GET(req: Request, { params }: { params: Promise<{ assignmentId: string }> }) {
  const { assignmentId: id } = await params;
  const access = await assignmentAccess(id);
  const missing = () => new Response("Not found.", { status: 404 });
  if (!access || access.course.role !== "teacher" || access.assignment.kind !== "online") return missing();
  const student = new URL(req.url).searchParams.get("student") || "";
  const { ok, students } = await studentsOf(access);
  if (!ok) return new Response("Signify ID didn't answer with the class list. Try again.", { status: 503 });
  const who = students.find((s) => s.id === student);
  if (!who) return missing();
  const c = ctx(access.me);
  const subs = await listSubmissions(c, access.assignment.id);
  const list = (await filesForStudents(c, access.assignment, [who.id], new Map(subs.map((s) => [s.studentId, s])))).get(who.id) ?? [];
  const photos: Buffer[] = [];
  for (const f of list.filter((x) => x.kind === "image")) {
    const stored = await getWorkFile(access.me.tenantId, f.id);
    const b = stored ? await fileBytes(stored) : null;
    if (b) photos.push(b);
  }
  const pdf = photosPdf(photos, `${access.assignment.title} - ${who.name}`);
  if (!pdf.pages) return missing();
  const name = `${safeFileName(`${access.assignment.title} - ${who.name}`, "photos")}.pdf`;
  return new Response(new Uint8Array(pdf.bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      // Out of next.config's page CSP (its object-src 'none' stops the PDF viewer), like /files/.
      "Content-Security-Policy": "frame-ancestors 'self'",
      "Referrer-Policy": "no-referrer",
    },
  });
}
