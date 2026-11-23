import { getDb } from "./db";
import { type Block, assignmentIdsIn, forStudent } from "./blocks";

/**
 * A lesson's blocks as a student may see them: no answer keys, and an
 * assignment slide carries its assignment's title only once that assignment
 * is published (a draft's slide stays, empty, so live slide numbers match
 * the teacher's; the student's screen says it isn't open yet).
 */
export async function studentBlocks(tenantId: string, courseId: string, blocks: Block[]): Promise<Block[]> {
  const want = assignmentIdsIn(blocks);
  const open = new Map<string, string>();
  if (want.length) {
    const db = await getDb();
    const rows = await db.query(
      "SELECT id, title FROM assignments WHERE tenant_id = $1 AND course_id = $2 AND archived = false AND published AND id = ANY($3::uuid[])",
      [tenantId, courseId, want]);
    for (const r of rows) open.set(String(r.id), String(r.title));
  }
  return blocks.map((b) => {
    if (b.type !== "assignment") return forStudent(b);
    const title = open.get(b.assignmentId);
    return title === undefined ? { ...b, title: "", assignmentId: "" } : { ...b, title };
  });
}
