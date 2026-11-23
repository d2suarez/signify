import { NextResponse } from "next/server";
import { courseAccess, ctx, lang, studentsOf } from "@/lib/access";
import { createGroupSet } from "@/lib/group-sets";
import { startingGroups } from "@/lib/groups";
import { t } from "@/lib/i18n";

export const dynamic = "force-dynamic";

/**
 * Makes a new saved group set from an assignment's group settings (no
 * Groups tab since 2026-11-23). Body: { name?, how: count|size|hand, n }.
 * Teachers only; the class comes from Signify ID now, so ID must answer.
 * Answers { set: { id, name, version } }.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await courseAccess(id);
  if (!access) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (access.course.role !== "teacher") return NextResponse.json({ error: "Only the class's teachers can make its groups." }, { status: 403 });
  let body: Record<string, unknown>;
  try {
    const text = await req.text();
    if (text.length > 10_000) return NextResponse.json({ error: "That is too large." }, { status: 413 });
    body = JSON.parse(text || "{}");
  } catch {
    return NextResponse.json({ error: "That wasn't a group set." }, { status: 400 });
  }
  const { ok, students } = await studentsOf(access);
  if (!ok) return NextResponse.json({ error: "roster" }, { status: 503 });
  const L = await lang();
  const word = t("grpWord", L);
  const people = students.map((s) => ({ id: s.id, name: s.name }));
  const groups = startingGroups(people, String(body.how || "count"), body.n, word);
  const name = String(body.name || "").trim()
    || `${t("grpTitle", L)} · ${new Date().toLocaleDateString(L === "es" ? "es" : "en-US", { month: "short", day: "numeric" })}`;
  const set = await createGroupSet(ctx(access.me), access.course.id, { name, groups }, new Map(people.map((p) => [p.id, p.name])), word);
  return NextResponse.json({ set: { id: set.id, name: set.name, version: set.version } }, { status: 201 });
}
