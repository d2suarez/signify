import { NextResponse } from "next/server";
import { assignmentAccess, ctx, studentsOf } from "@/lib/access";
import { openSuggestions, skipSuggestion, suggestFromStudent } from "@/lib/suggestions";

export const dynamic = "force-dynamic";

/**
 * Suggestions on the grading review screen (story 01): never grades.
 * GET ?student= lists open ones; POST { studentId, from } runs the non-AI
 * helper "same as <from>'s grade"; PUT { id, action: "skip" } sets one
 * aside. Using one is done on the desk and settled by the grade save.
 * The class's teachers only (404 for anyone else); no AI is called here.
 */
async function teacher(id: string) {
  const access = await assignmentAccess(id);
  return access && access.course.role === "teacher" ? access : null;
}
const none = () => NextResponse.json({ error: "Not found." }, { status: 404 });
const noStore = { "Cache-Control": "no-store" };

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await teacher((await params).id);
  if (!access) return none();
  const student = new URL(req.url).searchParams.get("student") || undefined;
  return NextResponse.json({ suggestions: await openSuggestions(ctx(access.me), access.assignment.id, student) }, { headers: noStore });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await teacher((await params).id);
  if (!access) return none();
  let body: { studentId?: unknown; from?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad" }, { status: 400 }); }
  const { ok, students } = await studentsOf(access);
  if (!ok) return NextResponse.json({ error: "roster" }, { status: 503 });
  const roster = new Set(students.map((s) => s.id));
  const studentId = String(body.studentId || ""), from = String(body.from || "");
  if (!roster.has(studentId) || !roster.has(from)) return none();
  const suggestions = await suggestFromStudent(ctx(access.me), access.assignment, studentId, from);
  return NextResponse.json({ suggestions }, { headers: noStore });
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await teacher((await params).id);
  if (!access) return none();
  let body: { id?: unknown; action?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad" }, { status: 400 }); }
  if (body.action !== "skip") return NextResponse.json({ error: "Say skip." }, { status: 400 });
  return (await skipSuggestion(ctx(access.me), access.assignment.id, String(body.id || ""))) ? NextResponse.json({ ok: true }) : none();
}
