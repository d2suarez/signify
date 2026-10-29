import { NextResponse } from "next/server";
import { assignmentAccess, ctx } from "@/lib/access";
import { saveDraft, setHandedIn } from "@/lib/assignments";

export const dynamic = "force-dynamic";

/**
 * A student's own work on an assignment. The student is whoever is signed
 * in: there is no student id in the request to change.
 */
async function student(id: string) {
  const access = await assignmentAccess(id);
  if (!access) return { error: NextResponse.json({ error: "Not found." }, { status: 404 }) };
  if (access.course.role !== "student") return { error: NextResponse.json({ error: "Only students hand in work." }, { status: 403 }) };
  return { access };
}

async function json(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await req.text();
    if (text.length > 500_000) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Save the draft. Body: { baseVersion (0 for the first save), body, pastes? } (pastes: see src/lib/writing.ts). */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { access, error } = await student(id);
  if (error) return error;
  const body = await json(req);
  if (!body) return NextResponse.json({ error: "That work is too long to save." }, { status: 413 });
  const r = await saveDraft(ctx(access.me), access.assignment, { baseVersion: Number(body.baseVersion), body: body.body, pastes: body.pastes });
  if (r.ok) return NextResponse.json({ submission: r.submission });
  if (r.reason === "conflict") return NextResponse.json({ error: "conflict", submission: r.submission }, { status: 409 });
  if (r.reason === "handed-in") return NextResponse.json({ error: "handed-in" }, { status: 409 });
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}

/** Hand in or take back. Body: { action: "hand-in" | "take-back", baseVersion }. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { access, error } = await student(id);
  if (error) return error;
  const body = await json(req);
  if (!body || (body.action !== "hand-in" && body.action !== "take-back")) {
    return NextResponse.json({ error: "Say hand-in or take-back." }, { status: 400 });
  }
  const r = await setHandedIn(ctx(access.me), access.assignment, body.action === "hand-in", Number(body.baseVersion));
  if (r.ok) return NextResponse.json({ submission: r.submission });
  if (r.reason === "conflict") return NextResponse.json({ error: "conflict", submission: r.submission }, { status: 409 });
  if (r.reason === "graded") return NextResponse.json({ error: "graded" }, { status: 409 });
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}
