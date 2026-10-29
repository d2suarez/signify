import { courseAccess, ctx, studentsOf } from "@/lib/access";
import { buildGradebook, factsCsv } from "@/lib/gradebook";
import { listPeriods } from "@/lib/grades";

export const dynamic = "force-dynamic";

/** The quarter grades as a CSV, in FACTS roster order. ?period=<id>|year */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await courseAccess(id);
  if (!access || access.course.role !== "teacher") return new Response("Not found.", { status: 404 });
  const { ok, students } = await studentsOf(access);
  if (!ok) return new Response("The class list couldn't be loaded from Signify ID. Try again in a minute.", { status: 503 });

  const want = new URL(req.url).searchParams.get("period") || "year";
  const period = want === "year" ? null : (await listPeriods(access.me.tenantId)).find((p) => p.id === want) ?? null;
  const gb = await buildGradebook(ctx(access.me), access.course.id, students, period);
  const name = `${access.course.name} ${period ? period.name : "Year"}`.replace(/[^A-Za-z0-9 _-]+/g, "").trim().replace(/\s+/g, "-") || "grades";
  return new Response(factsCsv(gb), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name}.csv"`,
      "cache-control": "no-store",
    },
  });
}
