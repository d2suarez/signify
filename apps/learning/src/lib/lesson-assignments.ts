import { getDb } from "./db";
import { type Block, assignmentIdsIn, forStudent, groupSetIdsIn } from "./blocks";
import { shownSets, slideSets } from "./group-sets";

/**
 * A lesson's blocks as a student may see them: no answer keys, and an
 * assignment slide carries its assignment's title only once that assignment
 * is published (a draft's slide stays, empty, so live slide numbers match
 * the teacher's; the student's screen says it isn't open yet). A group slide
 * shows every group while the lesson is live, and only the student's own
 * group when they read the lesson later (`viewer`).
 */
export async function studentBlocks(
  tenantId: string, courseId: string, blocks: Block[], viewer: { studentId: string; live: boolean }, lessonId?: string,
): Promise<Block[]> {
  const want = assignmentIdsIn(blocks);
  const open = new Map<string, string>();
  if (want.length) {
    const db = await getDb();
    const rows = await db.query(
      "SELECT id, title FROM assignments WHERE tenant_id = $1 AND course_id = $2 AND archived = false AND published AND id = ANY($3::uuid[])",
      [tenantId, courseId, want]);
    for (const r of rows) open.set(String(r.id), String(r.title));
  }
  const sets = await shownSets(tenantId, courseId, groupSetIdsIn(blocks), viewer);
  const deals = lessonId && blocks.some((b) => b.type === "shuffle") ? await slideSets(tenantId, courseId, lessonId, viewer) : new Map();
  return blocks.map((b) => {
    if (b.type === "shuffle") {
      const shown = deals.get(b.id);
      return shown ? { ...forStudent(b), shown } as Block : forStudent(b);
    }
    if (b.type === "groups") {
      const shown = sets.get(b.groupSetId);
      return shown ? { ...forStudent(b), shown } as Block : forStudent(b);
    }
    if (b.type !== "assignment") return forStudent(b);
    const title = open.get(b.assignmentId);
    return title === undefined ? { ...b, title: "", assignmentId: "" } : { ...b, title };
  });
}

/** A lesson's blocks for its teacher: group slides (and Random groups slides' latest deal, given the lesson) filled with every group. */
export async function teacherBlocks(tenantId: string, courseId: string, blocks: Block[], lessonId?: string): Promise<Block[]> {
  const ids = groupSetIdsIn(blocks);
  const deals = lessonId && blocks.some((b) => b.type === "shuffle") ? await slideSets(tenantId, courseId, lessonId, { studentId: null, live: true }) : new Map();
  if (!ids.length && !deals.size) return blocks;
  const sets = ids.length ? await shownSets(tenantId, courseId, ids, { studentId: null, live: true }) : new Map();
  return blocks.map((b) => {
    if (b.type === "shuffle") {
      const shown = deals.get(b.id);
      return shown ? { ...b, shown } : b;
    }
    if (b.type !== "groups") return b;
    const shown = sets.get(b.groupSetId);
    return shown ? { ...b, shown } : b;
  });
}
