import { readMe } from "@/lib/auth";
import { isSchoolAdmin } from "@/lib/access";
import { attendanceCsv } from "@/lib/attendance-csv";

export const dynamic = "force-dynamic";

/** The school's attendance from ?from to ?to (at most a year) as CSV, for its SIS. School admins only. */
export async function GET(req: Request) {
  const me = await readMe();
  if (!me || !isSchoolAdmin(me)) return new Response("Not found.", { status: 404 });
  return attendanceCsv(req, me.tenantId);
}
