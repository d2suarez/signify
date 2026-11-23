import { NextResponse } from "next/server";
import { assignmentAccess, ctx, studentsOf } from "@/lib/access";
import { addConcern, ConcernError, listConcerns, removeConcern, updateConcern } from "@/lib/integrity";

export const dynamic = "force-dynamic";

/**
 * Integrity concerns on an assignment (story 01, grade assistant): High /
 * Medium / Note with evidence, never a deduction. The class's teachers
 * only; anyone else gets "not found", as if there were none. Students
 * named must be on the class list in Signify ID now.
 */
async function teacher(id: string) {
  const access = await assignmentAccess(id);
  return access && access.course.role === "teacher" ? access : null;
}
const none = () => NextResponse.json({ error: "Not found." }, { status: 404 });
const noStore = { "Cache-Control": "no-store" };

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await teacher((await params).id);
  if (!access) return none();
  return NextResponse.json({ concerns: await listConcerns(ctx(access.me), access.assignment.id) }, { headers: noStore });
}

async function write(req: Request, id: string, run: (access: NonNullable<Awaited<ReturnType<typeof teacher>>>, body: Record<string, unknown>, roster: Set<string>) => Promise<unknown>) {
  const access = await teacher(id);
  if (!access) return none();
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad" }, { status: 400 }); }
  const { ok, students } = await studentsOf(access);
  if (!ok) return NextResponse.json({ error: "roster" }, { status: 503 });
  try {
    const concern = await run(access, body ?? {}, new Set(students.map((s) => s.id)));
    return concern ? NextResponse.json({ concern }, { headers: noStore }) : none();
  } catch (e) {
    if (e instanceof ConcernError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

/** Body: { level: high|medium|note, studentIds, sectionId?, evidence }. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return write(req, (await params).id, (access, body, roster) => addConcern(ctx(access.me), access.assignment, body, roster));
}

/** ?c=<concern id>, same body as POST. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = new URL(req.url).searchParams.get("c") || "";
  return write(req, (await params).id, (access, body, roster) => updateConcern(ctx(access.me), access.assignment, c, body, roster));
}

/** ?c=<concern id> */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await teacher((await params).id);
  if (!access) return none();
  const c = new URL(req.url).searchParams.get("c") || "";
  return (await removeConcern(ctx(access.me), access.assignment.id, c)) ? NextResponse.json({ ok: true }) : none();
}
