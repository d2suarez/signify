import type { GroupMember } from "./groups";

/**
 * Who a Random groups slide deals out (story 01, D4). Pure: the class from
 * Signify ID, cut to the students connected now when the slide says so
 * (`here` comes from the teacher's browser, so it can only narrow the class,
 * never add to it), less anyone marked absent today.
 */
export function dealPool<T extends GroupMember>(
  students: T[], opts: { from: "class" | "here"; here?: unknown; absent: Set<string> },
): T[] {
  const here = opts.from === "here"
    ? new Set((Array.isArray(opts.here) ? opts.here : []).filter((x): x is string => typeof x === "string").slice(0, 500))
    : null;
  return students.filter((s) => !opts.absent.has(s.id) && (!here || here.has(s.id)));
}
