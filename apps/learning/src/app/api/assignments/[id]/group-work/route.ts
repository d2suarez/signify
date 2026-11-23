import { NextResponse } from "next/server";
import { assignmentAccess, ctx } from "@/lib/access";
import { claimSubmitter, groupHandIn, groupState, saveGroupDraft, setSubmitter, type GroupSave } from "@/lib/group-work";

export const dynamic = "force-dynamic";

/**
 * A group's shared work on a group assignment (story 01, A10). Students act
 * as themselves on their own group only; the teacher sets who hands in.
 */

async function json(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await req.text();
    if (text.length > 500_000) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function answer(r: GroupSave) {
  if (r.ok) return NextResponse.json({ work: r.work });
  if (r.reason === "conflict") return NextResponse.json({ error: "conflict", work: r.work }, { status: 409 });
  if (r.reason === "missing") return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ error: r.reason }, { status: 409 });
}

/** The student's group, its shared text and who hands in. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await assignmentAccess(id);
  if (!access || access.course.role !== "student") return NextResponse.json({ error: "Not found." }, { status: 404 });
  const state = await groupState(ctx(access.me), access.assignment, access.me.id);
  if (!state) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json(state, { headers: { "Cache-Control": "no-store" } });
}

/** Save the group's text. Body: { baseVersion (0 for the first save), body, pastes? }. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await assignmentAccess(id);
  if (!access || access.course.role !== "student") return NextResponse.json({ error: "Not found." }, { status: 404 });
  const body = await json(req);
  if (!body) return NextResponse.json({ error: "That work is too long to save." }, { status: 413 });
  return answer(await saveGroupDraft(ctx(access.me), access.assignment, { baseVersion: body.baseVersion, body: body.body, pastes: body.pastes }));
}

/**
 * Students: { action: "hand-in" | "take-back" | "claim" }.
 * Teachers: { action: "set-submitter", groupId, studentId (null to clear) }.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await assignmentAccess(id);
  if (!access) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const body = await json(req);
  if (!body) return NextResponse.json({ error: "That wasn't a request." }, { status: 400 });
  const c = ctx(access.me);
  if (access.course.role === "teacher") {
    if (body.action !== "set-submitter") return NextResponse.json({ error: "Say set-submitter." }, { status: 400 });
    return answer(await setSubmitter(c, access.assignment, String(body.groupId || ""), typeof body.studentId === "string" && body.studentId ? body.studentId : null));
  }
  if (body.action === "claim") return answer(await claimSubmitter(c, access.assignment));
  if (body.action === "hand-in" || body.action === "take-back") return answer(await groupHandIn(c, access.assignment, body.action === "hand-in"));
  return NextResponse.json({ error: "Say hand-in, take-back or claim." }, { status: 400 });
}
