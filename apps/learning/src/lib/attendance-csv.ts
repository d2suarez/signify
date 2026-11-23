import { schoolExport } from "./attendance";
import { addDays, parseDay } from "./planner";
import { csvCell } from "./review";

/**
 * The attendance CSV for ?from to ?to (at most a year): the school's (its
 * admins, for the SIS) or one class's (its teachers). Same columns either way.
 */
export async function attendanceCsv(req: Request, tenantId: string, courseId?: string): Promise<Response> {
  const url = new URL(req.url);
  const from = parseDay(url.searchParams.get("from"));
  const to = parseDay(url.searchParams.get("to"));
  if (!from || !to || from > to || addDays(from, 366) < to) return new Response("Pick a range of at most a year.", { status: 400 });
  const rows = await schoolExport(tenantId, from, to, courseId);
  const lines = [["date", "class", "class_id", "student_id", "student_name", "status", "note", "marked_at"].join(",")];
  for (const r of rows) lines.push([r.day, r.className, r.courseId, r.studentId, r.studentName, r.status, r.note, r.markedAt].map(csvCell).join(","));
  return new Response(lines.join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="attendance-${courseId ? "class-" : ""}${from}-to-${to}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
