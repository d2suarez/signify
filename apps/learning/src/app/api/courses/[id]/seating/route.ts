import { NextResponse } from "next/server";
import { courseAccess, ctx, studentsOf, type CourseAccess } from "@/lib/access";
import { token } from "@/lib/auth";
import { classDay } from "@/lib/attendance";
import { deskSeating, moveDeskSeat, type SeatingAnswer } from "@/lib/desk-seating";
import { DESK_ORIGIN } from "@/lib/desk";
import { isSchoolDay, todayIn } from "@/lib/planner";
import { SCHOOL_TZ } from "@/lib/school-grading";

export const dynamic = "force-dynamic";

/**
 * The seating slide's data for the class's teacher (story 01, D5/D6): the
 * teacher's own chart from Teacher's Desk, the class, and today's attendance
 * marks (the same records as the Attendance tab). PUT moves one seat on the
 * desk. Students never call this: they get the room and the chairs' names
 * from the live lesson, never marks.
 */

async function teacher(id: string): Promise<CourseAccess | NextResponse> {
  const access = await courseAccess(id);
  if (!access) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (access.course.role !== "teacher") return NextResponse.json({ error: "Only the class's teachers." }, { status: 403 });
  return access;
}

async function reply(access: CourseAccess, desk: SeatingAnswer, status = 200) {
  const today = todayIn(SCHOOL_TZ);
  const [marks, { ok: rosterOk, students }] = await Promise.all([classDay(ctx(access.me), access.course.id, today), studentsOf(access)]);
  // Only this class's students (as Signify ID lists them to Learning) carry marks.
  const inClass = new Set(students.map((s) => s.id));
  return NextResponse.json({
    ok: desk.ok, reason: desk.ok ? null : desk.reason,
    chart: desk.chart ?? null, pupils: (desk.pupils ?? []).filter((p) => !rosterOk || inClass.has(p.id)),
    marks: Object.fromEntries([...marks.values()].map((m) => [m.studentId, m.status])),
    day: today, schoolDay: isSchoolDay(today), rosterOk, deskUrl: DESK_ORIGIN,
  }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await teacher(id);
  if (access instanceof NextResponse) return access;
  return reply(access, await deskSeating(access.me, await token(), access.course.idClassId));
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await teacher(id);
  if (access instanceof NextResponse) return access;
  let body: Record<string, unknown>;
  try {
    const text = await req.text();
    if (text.length > 2_000) return NextResponse.json({ error: "That is too large." }, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "That wasn't a seat." }, { status: 400 });
  }
  const move = {
    widgetId: String(body.widgetId ?? "").slice(0, 40),
    rev: Math.round(Number(body.rev)) || 0,
    pupil: String(body.pupil ?? "").slice(0, 80),
    seat: body.seat == null ? null : String(body.seat).slice(0, 80),
  };
  const r = await moveDeskSeat(access.me, await token(), access.course.idClassId, move);
  return reply(access, r, r.ok ? 200 : r.reason === "stale" ? 409 : r.reason === "bad" ? 400 : 502);
}
