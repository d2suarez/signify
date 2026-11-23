import { NextResponse } from "next/server";
import { courseAccess, ctx } from "@/lib/access";
import { getLesson } from "@/lib/lessons";
import { studentBlocks, teacherBlocks } from "@/lib/lesson-assignments";
import { liveLessonId } from "@/lib/live-ticket";

export const dynamic = "force-dynamic";

/**
 * The lesson that is live in this course right now, as a student may see it:
 * no answer keys, no draft assignment's title or id. Only the live lesson — a teacher's drafts stay theirs until
 * they present them.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await courseAccess(id);
  if (!access) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const lessonId = liveLessonId(id);
  if (!lessonId) return NextResponse.json({ live: false });
  const lesson = await getLesson(ctx(access.me), lessonId);
  if (!lesson || lesson.courseId !== id) return NextResponse.json({ live: false });
  const blocks = access.course.role === "teacher" ? await teacherBlocks(access.me.tenantId, id, lesson.blocks, lesson.id) : await studentBlocks(access.me.tenantId, id, lesson.blocks, { studentId: access.me.id, live: true }, lesson.id);
  return NextResponse.json(
    { live: true, lesson: { id: lesson.id, title: lesson.title, version: lesson.version, blocks } },
    { headers: { "Cache-Control": "no-store" } },
  );
}
