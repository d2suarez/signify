import { courseAccess } from "@/lib/access";
import { attendanceCsv } from "@/lib/attendance-csv";

export const dynamic = "force-dynamic";

/** One class's attendance from ?from to ?to (at most a year) as CSV. The class's teachers only. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await courseAccess((await params).id);
  if (!access || access.course.role !== "teacher") return new Response("Not found.", { status: 404 });
  return attendanceCsv(req, access.me.tenantId, access.course.id);
}
