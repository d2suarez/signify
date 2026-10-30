import { NextResponse } from "next/server";
import { readMe } from "@/lib/auth";
import { ctx, isSchoolAdmin } from "@/lib/access";
import { restoreSetting, saveLate, saveScales } from "@/lib/school-grading";

export const dynamic = "force-dynamic";

/**
 * The school's grade scales or late policies (school admins only).
 * Body: { key: "scales" | "late", baseVersion, value } or { key, baseVersion, restore: versionId }.
 * A save that didn't start from the current version is refused (409) with the current one.
 */
export async function PUT(req: Request) {
  const me = await readMe();
  if (!me) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  if (!isSchoolAdmin(me)) return NextResponse.json({ error: "Only school admins can change these." }, { status: 403 });
  let body: Record<string, unknown>;
  try {
    const text = await req.text();
    if (text.length > 60_000) return NextResponse.json({ error: "Too large." }, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "That wasn't a setting." }, { status: 400 });
  }
  const key = body.key === "late" ? "late" : body.key === "scales" ? "scales" : null;
  if (!key) return NextResponse.json({ error: "Unknown setting." }, { status: 400 });
  if (typeof body.restore === "string") {
    const ok = await restoreSetting(ctx(me), key, body.restore, body.baseVersion);
    return NextResponse.json({ ok }, { status: ok ? 200 : 409 });
  }
  const r = key === "scales" ? await saveScales(ctx(me), body.value, body.baseVersion) : await saveLate(ctx(me), body.value, body.baseVersion);
  if (r.ok) return NextResponse.json({ setting: r.setting });
  if (r.reason === "stale") return NextResponse.json({ error: "stale", current: r.current }, { status: 409 });
  return NextResponse.json({ error: "bad", problem: r.problem, band: r.band }, { status: 400 });
}
