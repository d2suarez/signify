import { NextResponse } from "next/server";
import { courseAccess, ctx, lang, studentsOf } from "@/lib/access";
import { saveGroupSet } from "@/lib/group-sets";
import { t } from "@/lib/i18n";

export const dynamic = "force-dynamic";

/**
 * Saves a group set (story 01, A8). Body: { baseVersion, name?, groups?, studentsSee? }.
 * Teachers only; members are checked against the class as Signify ID gives
 * it now, so ID must answer (never saved against an empty class).
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string; gid: string }> }) {
  const { id, gid } = await params;
  const access = await courseAccess(id);
  if (!access) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (access.course.role !== "teacher") return NextResponse.json({ error: "Only the class's teachers can change its groups." }, { status: 403 });
  let body: Record<string, unknown>;
  try {
    const text = await req.text();
    if (text.length > 200_000) return NextResponse.json({ error: "That is too large." }, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "That wasn't a group set." }, { status: 400 });
  }
  const { ok, students } = await studentsOf(access);
  if (!ok) return NextResponse.json({ error: "Signify ID couldn't be asked for the class. Try again in a minute." }, { status: 503 });
  const roster = new Map(students.map((s) => [s.id, s.name]));
  const L = await lang();
  const r = await saveGroupSet(ctx(access.me), id, gid,
    { baseVersion: body.baseVersion, name: body.name, groups: body.groups, studentsSee: body.studentsSee }, roster, t("grpWord", L));
  if (!r.ok && r.reason === "missing") return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!r.ok) return NextResponse.json({ error: "conflict", set: r.set }, { status: 409 });
  return NextResponse.json({ set: r.set });
}
