import { NextResponse } from "next/server";
import { ctx, lang, lessonAccess, studentsOf } from "@/lib/access";
import { classDay } from "@/lib/attendance";
import { randomGroups, showGroups } from "@/lib/groups";
import { shuffleSet } from "@/lib/group-sets";
import { t } from "@/lib/i18n";
import { todayIn } from "@/lib/planner";
import { SCHOOL_TZ } from "@/lib/school-grading";
import { dealPool } from "@/lib/shuffle";

export const dynamic = "force-dynamic";

/**
 * Deals the class into random groups from a Random groups slide (story 01,
 * D4). Body: { blockId, here?: string[] } — `here` is who the presenter sees
 * connected, used only by a slide set to "students here now" and always cut
 * down to the class as Signify ID gives it now. Students marked absent today
 * are left out. Saved as the class's group set linked to the slide; answers
 * what the teacher's screen shows. Teachers only.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await lessonAccess(id);
  if (!access) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (access.course.role !== "teacher") return NextResponse.json({ error: "Only the class's teachers." }, { status: 403 });
  let body: Record<string, unknown>;
  try {
    const text = await req.text();
    if (text.length > 50_000) return NextResponse.json({ error: "That is too large." }, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "That wasn't a deal." }, { status: 400 });
  }
  const block = access.lesson.blocks.find((b) => b.id === body.blockId);
  if (!block || block.type !== "shuffle") return NextResponse.json({ error: "Not found." }, { status: 404 });
  const { ok, students } = await studentsOf(access);
  if (!ok) return NextResponse.json({ error: "roster" }, { status: 503 });
  const roster = new Map(students.map((s) => [s.id, s.name]));
  const c = ctx(access.me);
  const today = todayIn(SCHOOL_TZ);
  const marks = await classDay(c, access.course.id, today).catch(() => new Map());
  const absent = new Set([...marks.values()].filter((m) => m.status === "absent").map((m) => m.studentId));
  const pool = dealPool(students, { from: block.from, here: body.here, absent });
  if (!pool.length) return NextResponse.json({ error: "nobody" }, { status: 400 });
  const L = await lang();
  const word = t("grpWord", L);
  const rand = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
  const groups = randomGroups(pool, block.by === "count" ? { count: block.n } : { size: block.n }, word, rand);
  const name = `${block.title || t("blockShuffle", L)} · ${access.lesson.title}`.slice(0, 80);
  const set = await shuffleSet(c, access.course.id, access.lesson.id, block.id, name, groups, roster, word);
  return NextResponse.json({
    shown: showGroups(set.name, set.groups, { studentId: null, live: true }),
    setId: set.id, dealt: pool.length, leftOut: students.length - pool.length,
  });
}
