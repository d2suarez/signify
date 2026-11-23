import { assignmentAccess, ctx, lang, studentsOf } from "@/lib/access";
import { isLate, listSubmissions } from "@/lib/assignments";
import { assignmentGroups, listGroupWork } from "@/lib/group-work";
import { dict } from "@/lib/i18n";
import { workZip, ZipTooBig, ZIP_FILES_MAX_BYTES } from "@/lib/work-zip";
import { fileBytes } from "@/lib/files";
import { filesForStudents, getWorkFile } from "@/lib/work-files";

export const dynamic = "force-dynamic";

/**
 * Story 01, F3: the class's online writing for one assignment as a zip,
 * one text file per student (or group). ?student=<id> for one student's
 * (their group's) work. The class's teachers only; 404 for anyone else.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await assignmentAccess(id);
  if (!access || access.course.role !== "teacher" || access.assignment.kind !== "online") return new Response("Not found.", { status: 404 });
  const a = access.assignment;
  const c = ctx(access.me);
  const [{ ok, students }, subs, groups, work] = await Promise.all([
    studentsOf(access), listSubmissions(c, a.id), assignmentGroups(c, a), listGroupWork(c, a.id),
  ]);
  if (!ok) return new Response("Signify ID didn't answer with the class list. Try again.", { status: 503 });
  const only = new URL(req.url).searchParams.get("student") || undefined;
  if (only && !students.some((s) => s.id === only)) return new Response("Not found.", { status: 404 });
  // Only students on the class list right now: nobody else's work leaves.
  const roster = new Set(students.map((s) => s.id));
  const d = dict(await lang());
  const subBy = new Map(subs.filter((s) => roster.has(s.studentId)).map((s) => [s.studentId, s]));
  // Story 01 A7: students' files, sizes checked before any bytes are read; one read per file.
  const lists = await filesForStudents(c, a, students.filter((s) => !only || s.id === only || (groups ?? []).some((g) => g.members.some((m) => m.id === only) && g.members.some((m) => m.id === s.id))).map((s) => s.id), subBy);
  const unique = new Map([...lists.values()].flat().map((f) => [f.id, f]));
  if ([...unique.values()].reduce((n, f) => n + f.size, 0) > ZIP_FILES_MAX_BYTES) {
    return new Response(d.wfZipTooBig, { status: 413, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const bytes = new Map<string, Buffer>();
  for (const f of unique.values()) {
    const stored = await getWorkFile(access.me.tenantId, f.id);
    const b = stored ? await fileBytes(stored) : null;
    if (b) bytes.set(f.id, b);
  }
  const files = new Map([...lists].map(([sid, list]) => [sid, list.filter((f) => bytes.has(f.id)).map((f) => ({ name: f.name, kind: f.kind, data: bytes.get(f.id)! }))]));
  let zip: ReturnType<typeof workZip>;
  try {
    zip = workZip({
      title: a.title, students, subs: subBy, files,
      groups, work, mode: a.groupHandIn, late: (s) => isLate(a, s), only, when: new Date(), d,
    });
  } catch (e) {
    if (e instanceof ZipTooBig) return new Response(d.zipTooBig, { status: 413, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    throw e;
  }
  return new Response(new Uint8Array(zip.bytes), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${zip.name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'")}"; filename*=UTF-8''${encodeURIComponent(zip.name)}`,
      "Cache-Control": "no-store",
    },
  });
}
