import { getDb } from "./db";
import { type Block, LIMITS as BLOCK_LIMITS, newId, normalizeBlocks } from "./blocks";
import { getLesson } from "./lessons";
import { blocksFromResources } from "./resources";
import { parseKey } from "./organize";
import { assignmentSlide } from "./week-plan";

type Ctx = { tenantId: string; userId: string };

/**
 * "Present ticked" on the class page (the Resources page's job, moved there
 * when the Resources tab went, 2026-11-23): the ticked pages, materials and
 * assignments, in the order they are ticked on the page, as one lesson's
 * blocks. Pages copy their blocks with fresh ids, materials go through
 * blocksFromResources, assignments and quizzes become their slide. Only this
 * class's own, never archived ones. One page ticked alone is presented as
 * itself (`onlyLesson`). The caller checks the teacher role.
 */
export async function pickedBlocks(ctx: Ctx, courseId: string, keys: unknown[]): Promise<{ blocks: Block[]; onlyLesson: string | null }> {
  const items = keys.map(parseKey).filter((k): k is NonNullable<typeof k> => !!k);
  const seen = new Set<string>();
  const db = await getDb();
  const blocks: Block[] = [];
  const lessons: string[] = [];
  let others = 0;
  for (const k of items) {
    const key = `${k.kind}:${k.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (k.kind === "lesson") {
      const lesson = await getLesson(ctx, k.id);
      if (!lesson || lesson.courseId !== courseId) continue;
      lessons.push(lesson.id);
      blocks.push(...lesson.blocks.map((b) => ({ ...b, id: newId() })));
    } else if (k.kind === "resource") {
      const got = await blocksFromResources({ ...ctx, role: "teacher" }, courseId, [k.id]);
      if (got.length) { others++; blocks.push(...got); }
    } else {
      const [a] = await db.query("SELECT title FROM assignments WHERE tenant_id = $1 AND course_id = $2 AND id = $3 AND archived = false", [ctx.tenantId, courseId, k.id]);
      if (a) { others++; blocks.push(assignmentSlide(k.id, String(a.title))); }
    }
    if (blocks.length >= BLOCK_LIMITS.blocks) break;
  }
  return {
    blocks: normalizeBlocks(blocks.slice(0, BLOCK_LIMITS.blocks)),
    onlyLesson: lessons.length === 1 && others === 0 ? lessons[0] : null,
  };
}
