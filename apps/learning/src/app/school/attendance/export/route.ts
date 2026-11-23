import { readMe } from "@/lib/auth";
import { isSchoolAdmin } from "@/lib/access";
import { schoolExport } from "@/lib/attendance";
import { addDays, parseDay } from "@/lib/planner";
import { csvCell } from "@/lib/review";

export const dynamic = "force-dynamic";

/** The school's attendance from ?from to ?to (at most a year) as CSV, for its SIS. School admins only. */
export async function GET(req: Request) {
  const me = await readMe();
  if (!me || !isSchoolAdmin(me)) return new Response("Not found.", { status: 404 });
  const url = new URL(req.url);
  const from = parseDay(url.searchParams.get("from"));
  const to = parseDay(url.searchParams.get("to"));
  if (!from || !to || from > to || addDays(from, 366) < to) return new Response("Pick a range of at most a year.", { status: 400 });
  const rows = await schoolExport(me.tenantId, from, to);
  const lines = [["date", "class", "class_id", "student_id", "student_name", "status", "note", "marked_at"].join(",")];
  for (const r of rows) lines.push([r.day, r.className, r.courseId, r.studentId, r.studentName, r.status, r.note, r.markedAt].map(csvCell).join(","));
  return new Response(lines.join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="attendance-${from}-to-${to}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
